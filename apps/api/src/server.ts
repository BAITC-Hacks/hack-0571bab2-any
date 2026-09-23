import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AttachmentError, extractAttachmentCandidates, MAX_ATTACHMENT_BYTES } from './attachments.js';
import { answerPurchaseTerms, detectsPurchaseTerms } from './policy.js';
import {
  createDemoCatalog,
  createLiveCatalog,
  CatalogError,
  type Analog,
  type CatalogProvider,
  type Product,
} from './catalog.js';

type CartItem = {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  availableAtConfirmation: number | null;
};
type Proposal = { id: string; productId: string; sku: string; name: string; quantity: number; expiresAt: number; used: boolean };
type Confirmation = { proposalId: string; result: { cart: ReturnType<typeof cartSnapshot>; cartUrl: '/cart'; status: 'added'; requestId: string } };
type Session = {
  csrfToken: string;
  expiresAt: number;
  items: CartItem[];
  proposal: Proposal | null;
  lastProductId: string | null;
  confirmations: Map<string, Confirmation>;
  lock: Promise<void>;
};

const SESSION_MS = 4 * 60 * 60 * 1000;
const PROPOSAL_MS = 10 * 60 * 1000;
const CART_URL = '/cart' as const;
const MAX_SESSIONS = 5000;
const SESSION_CREATION_WINDOW_MS = 60_000;
const MAX_SESSIONS_PER_IP_PER_WINDOW = 120;
const MAX_SESSION_CREATIONS_PER_WINDOW = 300;
const MAX_SESSION_CREATION_IPS = 4096;
const MAX_CONCURRENT_LIVE_CATALOG_OPS = 8;
const MAX_LIVE_CATALOG_OPS_PER_WINDOW = 60;

class ApiFailure extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly available?: number,
  ) { super(message); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(request: { headers: { cookie?: string } }, name: string): string | null {
  const raw = request.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

function cartSnapshot(session: Session) {
  const items = session.items.map((item) => ({ ...item }));
  return { items, itemCount: items.reduce((sum, item) => sum + item.quantity, 0) };
}

function extractSku(message: string): string | null {
  const labelled = message.match(/артикул(?:ом|а|у)?\s*[:№#]?\s*([A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9./_-]{2,})/iu);
  if (labelled) return labelled[1].toUpperCase();
  const candidates = message.match(/[A-ZА-ЯЁ0-9]+(?:[-/][A-ZА-ЯЁ0-9]+)+/giu) || [];
  const compound = candidates.find((candidate) => /\d/.test(candidate));
  if (compound) return compound.toUpperCase();
  return message.match(/[A-Z]{2,}\d{2,}/iu)?.[0].toUpperCase() || null;
}

function isAddIntent(message: string): boolean {
  return /(?:добав(?:ь|ить|ьте)|полож(?:и|ить)|в\s+корзин|add\s+to\s+cart|себетке(?:\s+\d+(?:\s*дана)?)?\s+қос)/iu.test(message);
}

function isExplicitConfirmation(message: string): boolean {
  return /^\s*(?:да[,\s]+добавь|да[,\s]+подтверждаю|подтверждаю|согласен[,\s]+добавь|иә[,\s]+қос)\s*[.!]?\s*$/iu.test(message);
}

function requestedQuantity(message: string): number {
  const match = message.match(/(?:добав(?:ь|ить|ьте)|полож(?:и|ить)|қос)\s+(\d+)(?:\s|$)|(?:^|\s)(\d+)\s*(?:шт\.?|штук|дана|pcs)(?:\s|$)|себетке\s+(\d+)\s*(?:дана\s+)?қос/iu);
  if (!match) return 1;
  return Number(match[1] || match[2] || match[3]);
}

const KK_CHARACTERISTIC_LABELS: Record<string, string> = {
  NOMINALNOE_NAPRYAZHENIE: 'Номиналды кернеу',
  NOMINALNYY_TOK: 'Номиналды ток',
  KOLICHESTVO_POLYUSOV: 'Полюстер саны',
  TIP_USTANOVKI: 'Орнату түрі',
};

const KK_MATCHED_LABELS: Record<string, string> = {
  'Номинальное напряжение': 'Номиналды кернеу',
  'Номинальный ток': 'Номиналды ток',
  'Количество полюсов': 'Полюстер саны',
  'Тип установки': 'Орнату түрі',
};

function localizeAnalog(analog: Analog, locale: 'ru' | 'kk'): Analog {
  if (locale === 'ru') return analog;
  const generatedReason = `Та же категория; совпадают ${analog.matchedCharacteristics.join(', ')}. Товар в наличии; остальные параметры проверьте перед покупкой.`;
  if (analog.reason !== generatedReason) return analog;
  const matchedCharacteristics = analog.matchedCharacteristics.map((text) => {
    const separator = text.indexOf(':');
    if (separator < 0) return text;
    const label = text.slice(0, separator);
    return (KK_MATCHED_LABELS[label] || label) + text.slice(separator);
  });
  const matched = matchedCharacteristics.length
    ? 'тексерілген маңызды сипаттамалары сәйкес: ' + matchedCharacteristics.join(', ') + '. '
    : '';
  return {
    ...analog,
    matchedCharacteristics,
    reason: 'Санаты бірдей; ' + matched + 'Тауар қоймада бар; қалған параметрлерін сатып алудан бұрын тексеріңіз.',
  };
}

function productReply(product: Product, analogs: Analog[], locale: 'ru' | 'kk'): string {
  const kk = locale === 'kk';
  const demo = product.source === 'catalog_demo' ? (kk ? 'Демо каталог деректері. ' : 'Демо-каталог. ') : '';
  const availability = product.stock.available === null
    ? (kk ? 'Қоймадағы қалдық расталмаған.' : 'Остаток не подтверждён.')
    : product.stock.available === 0
      ? (kk ? 'Қоймада жоқ.' : 'Нет в наличии.')
      : (kk ? 'Қоймада: ' + product.stock.available + ' дана.' : 'В наличии: ' + product.stock.available + ' шт.');
  const properties = Object.entries(product.characteristics).slice(0, 5)
    .map(([key, value]) => (kk ? KK_CHARACTERISTIC_LABELS[key] || key : key) + ': ' + value).join('; ');
  const certificate = product.certificateUrl
    ? 'Сертификат: ' + product.certificateUrl
    : (kk ? 'Сертификатқа расталған сілтеме жоқ.' : 'Подтверждённая ссылка на сертификат отсутствует.');
  const alternative = analogs.length
    ? (kk ? ' Тексерілген сипаттамалары бойынша ықтимал балама: ' : ' Возможный аналог по проверенным характеристикам: ') +
      analogs.map((entry) => entry.product.sku + ' — ' + entry.reason.replace(/[.!?]+$/u, '')).join('; ') + '.'
    : product.stock.status === 'out_of_stock'
      ? product.source === 'catalog_live'
        ? (kk ? ' Каталогтың тексерілген бөлігінде балама табылмады; менеджерден нақтылаңыз.' : ' В проверенной части каталога аналог не найден; уточните у менеджера.')
        : (kk ? ' Демо каталогта балама табылмады.' : ' В демонстрационном каталоге аналог не найден.')
      : '';
  return demo + product.name + ' (' + product.sku + '). ' + availability +
    (properties ? (kk ? ' Сипаттамалары: ' : ' Характеристики: ') + properties + '.' : '') + ' ' + certificate + alternative;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] || character);
}

async function locked<T>(session: Session, action: () => Promise<T>): Promise<T> {
  const previous = session.lock;
  let unlock = () => {};
  session.lock = new Promise<void>((resolve) => { unlock = resolve; });
  await previous;
  try { return await action(); } finally { unlock(); }
}

export function buildApp(options: {
  catalog?: CatalogProvider;
  now?: () => number;
  webOrigin?: string;
  apiOrigin?: string;
} = {}) {
  const mode = process.env.CATALOG_MODE || 'demo';
  if (mode !== 'demo' && mode !== 'live') throw new Error('CATALOG_MODE must be demo or live');
  const upstreamCatalog = options.catalog || (mode === 'live'
    ? createLiveCatalog({
      baseUrl: process.env.EKT_API_BASE_URL || '',
      username: process.env.EKT_API_USERNAME || '',
      password: process.env.EKT_API_PASSWORD || '',
    })
    : createDemoCatalog());
  const now = options.now || Date.now;
  const sessions = new Map<string, Session>();
  const sessionCreationByIp = new Map<string, { startedAt: number; count: number }>();
  let sessionCreationWindow = { startedAt: now(), count: 0 };
  let activeLiveCatalogOps = 0;
  let liveCatalogWindow = { startedAt: now(), count: 0 };
  async function withCatalogBudget<T>(action: () => Promise<T>): Promise<T> {
    if (upstreamCatalog.source !== 'catalog_live') return action();
    const time = now();
    if (time - liveCatalogWindow.startedAt >= SESSION_CREATION_WINDOW_MS) {
      liveCatalogWindow = { startedAt: time, count: 0 };
    }
    if (activeLiveCatalogOps >= MAX_CONCURRENT_LIVE_CATALOG_OPS ||
      liveCatalogWindow.count >= MAX_LIVE_CATALOG_OPS_PER_WINDOW) {
      throw new ApiFailure(429, 'CATALOG_BUSY', 'Каталог занят. Повторите запрос позже.');
    }
    liveCatalogWindow.count++;
    activeLiveCatalogOps++;
    try { return await action(); } finally { activeLiveCatalogOps--; }
  }
  const catalog: CatalogProvider = {
    source: upstreamCatalog.source,
    findBySku: (sku) => withCatalogBudget(() => upstreamCatalog.findBySku(sku)),
    getById: (id) => withCatalogBudget(() => upstreamCatalog.getById(id)),
    findAnalogs: (product) => withCatalogBudget(() => upstreamCatalog.findAnalogs(product)),
  };
  const sessionFor = new WeakMap<object, Session>();
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, requestTimeout: 10_000, genReqId: () => randomUUID() });
  app.register(multipart, { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 0, parts: 1 } });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const sid = cookieValue(request, 'ha_sid');
    let session = sid ? sessions.get(sid) : undefined;
    if (session && session.expiresAt <= now()) {
      if (sid) sessions.delete(sid);
      session = undefined;
    }
    const needsSession = request.method === 'GET' && (request.url === '/api/cart' || request.url === '/cart');
    if (!session && needsSession) {
      // Fastify's default request.ip is the transport peer, not a spoofable X-Forwarded-For value.
      const clientIp = request.ip;
      const time = now();
      if (time - sessionCreationWindow.startedAt >= SESSION_CREATION_WINDOW_MS) {
        sessionCreationWindow = { startedAt: time, count: 0 };
      }
      if (sessionCreationByIp.size >= MAX_SESSION_CREATION_IPS) {
        for (const [ip, budget] of sessionCreationByIp) {
          if (time - budget.startedAt >= SESSION_CREATION_WINDOW_MS) sessionCreationByIp.delete(ip);
        }
      }
      const previousBudget = sessionCreationByIp.get(clientIp);
      const budget = previousBudget && time - previousBudget.startedAt < SESSION_CREATION_WINDOW_MS
        ? previousBudget : { startedAt: time, count: 0 };
      if (sessionCreationWindow.count >= MAX_SESSION_CREATIONS_PER_WINDOW ||
        budget.count >= MAX_SESSIONS_PER_IP_PER_WINDOW ||
        (!previousBudget && sessionCreationByIp.size >= MAX_SESSION_CREATION_IPS)) {
        reply.header('Retry-After', '60');
        reply.code(429).send({ error: { code: 'SESSION_RATE_LIMITED', message: 'Слишком много новых сессий. Повторите позже.', requestId: String(request.id) } });
        return;
      }
      if (sessions.size >= 1000) {
        for (const [id, value] of sessions) if (value.expiresAt <= time) sessions.delete(id);
      }
      if (sessions.size >= MAX_SESSIONS) {
        // Keep carts intact. Evict an empty session rather than deny every newcomer.
        for (const [id, value] of sessions) {
          if (value.items.length === 0 && value.confirmations.size === 0 &&
            (!value.proposal || value.proposal.used || value.proposal.expiresAt <= time)) {
            sessions.delete(id);
            break;
          }
        }
      }
      if (sessions.size >= MAX_SESSIONS) {
        reply.code(429).send({ error: { code: 'SESSION_LIMIT', message: 'Сервис временно занят.', requestId: String(request.id) } });
        return;
      }
      budget.count++;
      sessionCreationByIp.set(clientIp, budget);
      sessionCreationWindow.count++;
      const id = randomBytes(32).toString('hex');
      session = {
        csrfToken: randomBytes(32).toString('hex'),
        expiresAt: time + SESSION_MS,
        items: [], proposal: null, lastProductId: null,
        confirmations: new Map(), lock: Promise.resolve(),
      };
      sessions.set(id, session);
      const publicApiOrigin = options.apiOrigin || process.env.API_ORIGIN || '';
      const secure = request.protocol === 'https' || publicApiOrigin.startsWith('https://') ||
        process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
      const cookieScope = '; Path=/; SameSite=Lax; Max-Age=14400' + (secure ? '; Secure' : '');
      reply.header('Set-Cookie', [
        'ha_sid=' + id + '; HttpOnly' + cookieScope,
        'csrf_token=' + session.csrfToken + cookieScope,
      ]);
    }
    if (session) sessionFor.set(request, session);
  });

  function sessionOf(request: object): Session {
    const session = sessionFor.get(request);
    if (!session) throw new ApiFailure(403, 'SESSION_REQUIRED', 'Откройте корзину и повторите действие.');
    return session;
  }

  function verifyMutation(request: { headers: { origin?: string; host?: string; 'x-csrf-token'?: string | string[] }; protocol: string }) {
    const origin = request.headers.origin;
    const apiOrigin = options.apiOrigin || process.env.API_ORIGIN || 'http://127.0.0.1:3001';
    const webOrigin = options.webOrigin || process.env.WEB_ORIGIN;
    if (!origin || (origin !== apiOrigin && origin !== webOrigin)) {
      throw new ApiFailure(403, 'ORIGIN_INVALID', 'Источник запроса не разрешён.');
    }
    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string' || !safeEqual(token, sessionOf(request).csrfToken)) {
      throw new ApiFailure(403, 'CSRF_INVALID', 'Обновите страницу и повторите действие.');
    }
  }

  async function confirm(session: Session, proposalId: string, key: string, requestId: string) {
    return locked(session, async () => {
      const prior = session.confirmations.get(key);
      if (prior) {
        if (prior.proposalId !== proposalId) throw new ApiFailure(409, 'IDEMPOTENCY_CONFLICT', 'Ключ уже использован.');
        return prior.result;
      }
      const proposal = session.proposal;
      if (!proposal || proposal.id !== proposalId) throw new ApiFailure(409, 'PROPOSAL_NOT_FOUND', 'Предложение не найдено в этой сессии.');
      if (proposal.used) throw new ApiFailure(409, 'PROPOSAL_ALREADY_USED', 'Предложение уже подтверждено.');
      if (proposal.expiresAt <= now()) throw new ApiFailure(409, 'PROPOSAL_EXPIRED', 'Срок предложения истёк.');
      const fresh = await catalog.getById(proposal.productId);
      if (session.proposal !== proposal) {
        throw new ApiFailure(409, 'PROPOSAL_NOT_FOUND', 'Предложение больше не ожидает подтверждения.');
      }
      if (proposal.expiresAt <= now()) {
        throw new ApiFailure(409, 'PROPOSAL_EXPIRED', 'Срок предложения истёк.');
      }
      if (!fresh || fresh.stock.available === null || fresh.stock.status !== 'in_stock') {
        throw new ApiFailure(409, 'STOCK_UNAVAILABLE', 'Наличие товара сейчас не подтверждено.');
      }
      if (fresh.sku !== proposal.sku || fresh.name !== proposal.name) {
        throw new ApiFailure(409, 'PRODUCT_CHANGED', 'Данные товара изменились. Запросите новое предложение.');
      }
      const existing = session.items.find((item) => item.productId === fresh.id);
      if ((existing?.quantity || 0) + proposal.quantity > fresh.stock.available) {
        throw new ApiFailure(409, 'INSUFFICIENT_STOCK', 'Недостаточный остаток. Требуется новое подтверждение.', fresh.stock.available);
      }
      if (existing) {
        existing.quantity += proposal.quantity;
        existing.availableAtConfirmation = fresh.stock.available;
      } else {
        session.items.push({
          productId: fresh.id, sku: fresh.sku, name: fresh.name,
          quantity: proposal.quantity, availableAtConfirmation: fresh.stock.available,
        });
      }
      proposal.used = true;
      const result = { cart: cartSnapshot(session), cartUrl: CART_URL, status: 'added' as const, requestId };
      session.confirmations.set(key, { proposalId, result });
      return result;
    });
  }

  app.get('/api/health', async () => ({ ok: true, catalog: catalog.source === 'catalog_live' ? 'live' : 'demo', model: 'fallback' }));

  app.get('/api/cart', async (request) => ({
    ...cartSnapshot(sessionOf(request)), cartUrl: CART_URL, mode: 'demo', csrfToken: sessionOf(request).csrfToken,
  }));

  app.post('/api/cart/confirm', async (request) => {
    verifyMutation(request);
    const body = request.body;
    if (!isRecord(body) || typeof body.proposalId !== 'string' || typeof body.idempotencyKey !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(body.proposalId) || !/^[a-zA-Z0-9_-]{8,128}$/.test(body.idempotencyKey)) {
      throw new ApiFailure(400, 'INVALID_INPUT', 'Укажите proposalId и idempotencyKey.');
    }
    return confirm(sessionOf(request), body.proposalId, body.idempotencyKey, String(request.id));
  });

  app.post('/api/attachments', async (request) => {
    verifyMutation(request);
    if (!request.isMultipart()) throw new ApiFailure(415, 'UNSUPPORTED_FILE', 'Ожидается один файл в multipart/form-data.');
    const file = await request.file();
    if (!file || file.fieldname !== 'file') throw new ApiFailure(400, 'INVALID_INPUT', 'Передайте один файл в поле file.');
    const result = await extractAttachmentCandidates({
      buffer: await file.toBuffer(), filename: file.filename, mimeType: file.mimetype,
    });
    return { ...result, requestId: String(request.id) };
  });

  app.post('/api/chat', async (request) => {
    verifyMutation(request);
    const body = request.body;
    if (!isRecord(body) || typeof body.message !== 'string' || body.message.trim().length < 1 || body.message.length > 2000 ||
      (body.locale !== undefined && body.locale !== 'ru' && body.locale !== 'kk')) {
      throw new ApiFailure(400, 'INVALID_INPUT', 'Введите сообщение до 2000 символов.');
    }
    const message = body.message.trim();
    const locale = body.locale === 'kk' ? 'kk' : 'ru';
    const session = sessionOf(request);
    const basic = { products: [] as Product[], analogs: [] as Awaited<ReturnType<CatalogProvider['findAnalogs']>>,
      proposal: null as null | { id: string; items: { productId: string; quantity: number }[]; expiresAt: string },
      factsSource: catalog.source as string, cartChanged: false, requestId: String(request.id) };

    if (isExplicitConfirmation(message)) {
      const proposal = session.proposal;
      if (!proposal || proposal.used) return { ...basic, reply: locale === 'kk'
        ? 'Растауды күтіп тұрған ұсыныс жоқ.' : 'Нет предложения, ожидающего подтверждения.' };
      const result = await confirm(session, proposal.id, 'chat_' + proposal.id, String(request.id));
      return { ...basic, reply: locale === 'kk' ? 'Демо себетке қосылды.' : 'Добавлено в демонстрационную корзину.', cartChanged: true,
        cart: result.cart, cartUrl: CART_URL };
    }

    // Any intervening message invalidates an old consent request.
    session.proposal = null;

    const sku = extractSku(message);
    if (detectsPurchaseTerms(message) && !sku) {
      const terms = answerPurchaseTerms(locale);
      return { ...basic, reply: terms.reply, factsSource: 'partner_policy',
        sourceUrl: terms.sourceUrl, checkedAt: terms.checkedAt };
    }
    let product = sku ? await catalog.findBySku(sku) : null;
    if (!product && !sku && isAddIntent(message) && session.lastProductId) {
      product = await catalog.getById(session.lastProductId);
    }
    if (!product) return { ...basic, reply: sku
      ? (locale === 'kk' ? 'Артикул ' + sku + ' қолжетімді каталогтан табылмады.' : 'Артикул ' + sku + ' не найден в доступном каталоге.')
      : (locale === 'kk' ? 'Сипаттамалары мен қоймадағы санын тексеру үшін тауар артикулын көрсетіңіз.' : 'Укажите артикул товара, чтобы проверить характеристики и остаток.') };

    session.lastProductId = product.id;
    const analogs = product.stock.status === 'out_of_stock'
      ? (await catalog.findAnalogs(product)).map((analog) => localizeAnalog(analog, locale)) : [];
    const response = { ...basic, products: [product], analogs, reply: productReply(product, analogs, locale) };
    if (!isAddIntent(message)) return response;
    const quantity = requestedQuantity(message);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) {
      throw new ApiFailure(400, 'INVALID_QUANTITY', locale === 'kk'
        ? '1-ден 1000-ға дейінгі санды көрсетіңіз.' : 'Укажите количество от 1 до 1000.');
    }
    const already = session.items.find((item) => item.productId === product.id)?.quantity || 0;
    if (product.stock.available === null || product.stock.status !== 'in_stock') {
      return { ...response, reply: response.reply + (locale === 'kk'
        ? ' Қоймадағы қалдық расталмайынша себетке қосу мүмкін емес.'
        : ' Добавление невозможно без подтверждённого остатка.') };
    }
    if (already + quantity > product.stock.available) {
      return { ...response, reply: response.reply + (locale === 'kk'
        ? ' Сұралған сан себеттегі тауармен бірге қолжетімді қалдықтан асады.'
        : ' Запрошенное количество превышает доступный остаток с учётом корзины.') };
    }
    const proposal: Proposal = { id: randomUUID(), productId: product.id, sku: product.sku, name: product.name,
      quantity, expiresAt: now() + PROPOSAL_MS, used: false };
    session.proposal = proposal;
    return { ...response, reply: response.reply + (locale === 'kk'
      ? ' Демо себетке ' + quantity + ' дана қосу үшін бөлек растаңыз.'
      : ' Подтвердите отдельным действием добавление ' + quantity + ' шт. в демонстрационную корзину.'),
      proposal: { id: proposal.id, items: [{ productId: product.id, quantity }], expiresAt: new Date(proposal.expiresAt).toISOString() } };
  });

  app.get('/cart', async (request, reply) => {
    const cart = cartSnapshot(sessionOf(request));
    const rows = cart.items.map((item) => '<li>' + escapeHtml(item.name) + ' (' + escapeHtml(item.sku) + ') — ' + item.quantity + ' шт.</li>').join('');
    reply.type('text/html; charset=utf-8');
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    return '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Демо-корзина</title><main style="max-width:42rem;margin:3rem auto;padding:1rem;font:1rem system-ui"><h1>Демонстрационная корзина</h1><p>Это корзина прототипа, не ekt.kz. Заказ и оплата здесь недоступны.</p><ul>' + (rows || '<li>Корзина пуста.</li>') + '</ul><p>Всего: ' + cart.itemCount + ' шт.</p></main></html>';
  });

  app.setErrorHandler((error, request, reply) => {
    const failure = error instanceof ApiFailure ? error : null;
    const attachmentFailure = error instanceof AttachmentError ? error : null;
    const errorStatus = isRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : 503;
    const catalogStatus = error instanceof CatalogError
      ? error.code === 'CATALOG_UNAUTHORIZED' ? 403 : error.code === 'CATALOG_RATE_LIMITED' ? 429 : 503
      : null;
    const status = failure?.statusCode || attachmentFailure?.statusCode || catalogStatus || (errorStatus < 500 ? errorStatus : 503);
    const code = failure?.code || attachmentFailure?.code || (error instanceof CatalogError ? error.code :
      status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 400 ? 'INVALID_INPUT' : 'SERVICE_UNAVAILABLE');
    const message = failure?.message || attachmentFailure?.message || (error instanceof CatalogError ? error.message :
      status === 503 ? 'Сервис временно недоступен. Повторите позже.' : 'Некорректный запрос.');
    const detail = failure?.available === undefined ? {} : { available: failure.available };
    reply.code(status).send({ error: { code, message, requestId: String(request.id), ...detail }, ...detail });
  });

  return app;
}
