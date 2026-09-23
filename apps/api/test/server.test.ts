import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/server.js';
import { CatalogError, createDemoCatalog, type CatalogProvider } from '../src/catalog.js';

const host = 'api.test';
const origin = `http://${host}`;
type App = ReturnType<typeof buildApp>;
type BrowserSession = { cookie: string; csrfToken: string };

async function openSession(app: App): Promise<BrowserSession> {
  const response = await app.inject({ method: 'GET', url: '/api/cart', headers: { host } });
  assert.equal(response.statusCode, 200);
  const rawCookie = response.headers['set-cookie'];
  assert.ok(rawCookie, 'a new session must set a cookie');
  const cookies = Array.isArray(rawCookie) ? rawCookie : [String(rawCookie)];
  const setCookie = cookies.find((value) => value.startsWith('ha_sid=')) || '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = setCookie.split(';')[0];
  const csrfToken = response.json().csrfToken;
  assert.equal(typeof csrfToken, 'string');
  assert.ok(csrfToken.length > 10);
  const csrfCookie = cookies.find((value) => value.startsWith('csrf_token='));
  assert.ok(csrfCookie, 'a readable CSRF cookie supports the current browser client');
  assert.equal(csrfCookie.split(';')[0], 'csrf_token=' + csrfToken);
  assert.doesNotMatch(csrfCookie, /HttpOnly/);
  assert.match(csrfCookie, /SameSite=Lax/);
  return { cookie, csrfToken };
}

function sessionHeaders(session: BrowserSession) {
  return { host, origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken };
}

async function chat(app: App, session: BrowserSession, message: string, locale: 'ru' | 'kk' = 'ru') {
  return app.inject({
    method: 'POST', url: '/api/chat', headers: sessionHeaders(session),
    payload: { message, locale },
  });
}

async function cart(app: App, session: BrowserSession) {
  return app.inject({ method: 'GET', url: '/api/cart', headers: { host, cookie: session.cookie } });
}

async function confirm(app: App, session: BrowserSession, proposalId: string, idempotencyKey: string) {
  return app.inject({
    method: 'POST', url: '/api/cart/confirm', headers: sessionHeaders(session),
    payload: { proposalId, idempotencyKey },
  });
}

test('T1: product facts come from the demo catalog and missing certificate/price stay unknown', async (t) => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
  t.after(() => app.close());
  const session = await openSession(app);

  const response = await chat(app, session, 'Есть ли артикул ABC-123?');
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.factsSource, 'catalog_demo');
  assert.equal(body.cartChanged, false);
  assert.equal(body.products.length, 1);
  assert.equal(body.products[0].sku, 'ABC-123');
  assert.equal(body.products[0].stock.available, 4);
  assert.equal(body.products[0].stock.status, 'in_stock');
  assert.equal(body.products[0].characteristics.NOMINALNYY_TOK, '10 А');
  assert.equal(body.products[0].certificateUrl, null);
  assert.equal(body.products[0].price, null);
  assert.match(body.reply, /Демо-каталог/);
  assert.match(body.reply, /ссылка на сертификат отсутствует/);
});

test('T2: unavailable product has an available, explained compatible analog', async (t) => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
  t.after(() => app.close());
  const session = await openSession(app);

  const response = await chat(app, session, 'Нужен ABC-000');
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.products[0].stock.available, 0);
  assert.equal(body.products[0].stock.status, 'out_of_stock');
  assert.equal(body.analogs.length, 1);
  assert.equal(body.analogs[0].product.sku, 'ABC-124');
  assert.equal(body.analogs[0].product.stock.status, 'in_stock');
  assert.ok(body.analogs[0].matchedCharacteristics.length >= 2);
  assert.match(body.analogs[0].reason, /совпадают/);
  assert.doesNotMatch(body.reply, /\.\./);
});

test('Kazakh chat explains product facts, missing certificate, and analog evidence', async (t) => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
  t.after(() => app.close());
  const session = await openSession(app);

  const facts = (await chat(app, session, 'ABC-123 бар ма?', 'kk')).json();
  assert.equal(facts.factsSource, 'catalog_demo');
  assert.match(facts.reply, /Демо каталог деректері/);
  assert.match(facts.reply, /Қоймада: 4 дана/);
  assert.match(facts.reply, /Номиналды ток: 10 А/);
  assert.match(facts.reply, /Сертификатқа расталған сілтеме жоқ/);
  assert.doesNotMatch(facts.reply, /В наличии|Характеристики|Подтверждённая ссылка/);
  assert.equal(facts.products[0].certificateUrl, null);

  const unavailable = (await chat(app, session, 'ABC-000 бар ма?', 'kk')).json();
  assert.match(unavailable.reply, /Қоймада жоқ/);
  assert.match(unavailable.reply, /ықтимал балама: ABC-124/);
  assert.match(unavailable.analogs[0].reason, /Номиналды кернеу: 230 В/);
  assert.match(unavailable.analogs[0].reason, /қалған параметрлерін.*тексеріңіз/);
  assert.equal(unavailable.analogs[0].product.stock.status, 'in_stock');
  assert.doesNotMatch(unavailable.reply, /\.\./);
});

test('Kazakh chat gives prompts and requires separate consent before changing the cart', async (t) => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
  t.after(() => app.close());
  const session = await openSession(app);

  const guidance = (await chat(app, session, 'Сәлем', 'kk')).json();
  assert.match(guidance.reply, /тауар артикулын көрсетіңіз/);
  const missing = (await chat(app, session, 'XYZ-999 бар ма?', 'kk')).json();
  assert.match(missing.reply, /қолжетімді каталогтан табылмады/);

  const proposed = (await chat(app, session, 'ABC-123 себетке 2 дана қос', 'kk')).json();
  assert.equal(proposed.cartChanged, false);
  assert.equal(proposed.proposal.items[0].quantity, 2);
  assert.match(proposed.reply, /бөлек растаңыз/);
  assert.equal((await cart(app, session)).json().itemCount, 0);

  const confirmed = (await chat(app, session, 'Иә, қос', 'kk')).json();
  assert.equal(confirmed.cartChanged, true);
  assert.equal(confirmed.cart.itemCount, 2);
  assert.equal(confirmed.cartUrl, '/cart');
  assert.match(confirmed.reply, /Демо себетке қосылды/);
  const replay = (await chat(app, session, 'Иә, қос', 'kk')).json();
  assert.equal(replay.cartChanged, false);
  assert.match(replay.reply, /Растауды күтіп тұрған ұсыныс жоқ/);
  assert.equal((await cart(app, session)).json().itemCount, 2);
});

test('Kazakh reply preserves a nonstandard analog warning instead of replacing its meaning', async (t) => {
  const base = createDemoCatalog();
  const catalog: CatalogProvider = {
    source: 'catalog_demo',
    findBySku: (sku) => base.findBySku(sku),
    getById: (id) => base.getById(id),
    async findAnalogs(product) {
      const analogs = await base.findAnalogs(product);
      return analogs.map((analog) => ({ ...analog, reason: 'Требуется отдельная проверка производителя.' }));
    },
  };
  const app = buildApp({ catalog, apiOrigin: origin });
  t.after(() => app.close());
  const session = await openSession(app);

  const response = await chat(app, session, 'ABC-000 бар ма?', 'kk');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().analogs[0].reason, 'Требуется отдельная проверка производителя.');
  assert.match(response.json().reply, /Требуется отдельная проверка производителя/);
});

test('T3: purchase terms cite the public source and state both unknowns', async (t) => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
  t.after(() => app.close());
  const session = await openSession(app);

  for (const [locale, message] of [
    ['ru', 'Какая оплата, доставка и минимальная партия?'],
    ['kk', 'Жеткізу және төлем шарттары қандай?'],
  ] as const) {
    const response = await chat(app, session, message, locale);
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.factsSource, 'partner_policy');
    assert.equal(body.sourceUrl, 'https://ekt.kz/checkout-delivery/');
    assert.equal(body.checkedAt, '2026-09-23');
    assert.equal(body.cartChanged, false);
    assert.match(body.reply, /https:\/\/ekt\.kz\/checkout-delivery\//);
    assert.doesNotMatch(body.reply, /30\s?000|15\s?000/);
    assert.match(body.reply, locale === 'ru' ? /Минимальная партия.*не указана/ : /Ең аз партия.*көрсетілмеген/);
  }
});

test('T4/T5/T7: proposal leaves cart untouched; explicit confirm adds once and /cart reflects it', async (t) => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
  t.after(() => app.close());
  const session = await openSession(app);

  const proposed = await chat(app, session, 'Добавь 2 ABC-123');
  assert.equal(proposed.statusCode, 200);
  const proposalBody = proposed.json();
  assert.equal(proposalBody.cartChanged, false);
  assert.equal(proposalBody.proposal.items[0].quantity, 2);
  const proposalId = proposalBody.proposal.id as string;
  assert.equal((await cart(app, session)).json().itemCount, 0);

  const first = await confirm(app, session, proposalId, 'fixed-key-001');
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().status, 'added');
  assert.equal(first.json().cartUrl, '/cart');
  assert.equal(first.json().cart.itemCount, 2);
  assert.equal(first.json().cart.items[0].quantity, 2);

  const replay = await confirm(app, session, proposalId, 'fixed-key-001');
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), first.json());
  assert.equal((await cart(app, session)).json().itemCount, 2);

  const page = await app.inject({ method: 'GET', url: '/cart', headers: { host, cookie: session.cookie } });
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers['content-type']), /text\/html/);
  assert.match(page.body, /Демонстрационная корзина/);
  assert.match(page.body, /ABC-123/);
  assert.match(page.body, /Всего: 2 шт/);
});

test('T6: confirm rereads mutable stock and rejects an outdated proposal', async (t) => {
  const base = createDemoCatalog();
  let available = 4;
  const catalog: CatalogProvider = {
    source: 'catalog_demo',
    findBySku: (sku) => base.findBySku(sku),
    async getById(id) {
      const product = await base.getById(id);
      return product && id === 'demo-1'
        ? { ...product, stock: { available, status: available > 0 ? 'in_stock' : 'out_of_stock' } }
        : product;
    },
    findAnalogs: (product) => base.findAnalogs(product),
  };
  const app = buildApp({ catalog, apiOrigin: origin });
  t.after(() => app.close());
  const session = await openSession(app);

  const proposed = await chat(app, session, 'Добавь 3 ABC-123');
  assert.equal(proposed.statusCode, 200);
  const proposalId = proposed.json().proposal.id as string;
  available = 2;

  const response = await confirm(app, session, proposalId, 'fixed-key-002');
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'INSUFFICIENT_STOCK');
  assert.equal(response.json().error.available, 2);
  assert.equal(response.json().available, 2);
  assert.equal((await cart(app, session)).json().itemCount, 0);
});

test('cart proposals are session-bound; missing/invalid CSRF or origin is rejected', async (t) => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
  t.after(() => app.close());
  const first = await openSession(app);
  const second = await openSession(app);
  const proposed = await chat(app, first, 'Добавь 2 ABC-123');
  const proposalId = proposed.json().proposal.id as string;

  const stolen = await confirm(app, second, proposalId, 'fixed-key-003');
  assert.equal(stolen.statusCode, 409);
  assert.equal(stolen.json().error.code, 'PROPOSAL_NOT_FOUND');
  assert.equal((await cart(app, second)).json().itemCount, 0);

  const badToken = await app.inject({
    method: 'POST', url: '/api/cart/confirm',
    headers: { ...sessionHeaders(first), 'x-csrf-token': 'invalid-token' },
    payload: { proposalId, idempotencyKey: 'fixed-key-004' },
  });
  assert.equal(badToken.statusCode, 403);
  assert.equal(badToken.json().error.code, 'CSRF_INVALID');

  const badOrigin = await app.inject({
    method: 'POST', url: '/api/cart/confirm',
    headers: { ...sessionHeaders(first), origin: 'https://another.example' },
    payload: { proposalId, idempotencyKey: 'fixed-key-005' },
  });
  assert.equal(badOrigin.statusCode, 403);
  assert.equal(badOrigin.json().error.code, 'ORIGIN_INVALID');
  assert.equal((await cart(app, first)).json().itemCount, 0);
});

test('T8: unavailable catalog gives a safe 503 without fabricated product facts', async (t) => {
  const catalog: CatalogProvider = {
    source: 'catalog_live',
    async findBySku() { throw new CatalogError('CATALOG_UNAVAILABLE'); },
    async getById() { throw new CatalogError('CATALOG_UNAVAILABLE'); },
    async findAnalogs() { throw new CatalogError('CATALOG_UNAVAILABLE'); },
  };
  const app = buildApp({ catalog, apiOrigin: origin });
  t.after(() => app.close());
  const session = await openSession(app);

  const response = await chat(app, session, 'Есть ли артикул ABC-123?');
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'CATALOG_UNAVAILABLE');
  assert.equal(typeof response.json().error.requestId, 'string');
  assert.doesNotMatch(response.body, /ABC-123|В наличии|Сертификат:/);
});

test('health checks do not allocate a browser session', async (t) => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['set-cookie'], undefined);
});

test('a different product question invalidates an older cart proposal before text confirmation', async (t) => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
  t.after(() => app.close());
  const session = await openSession(app);

  const proposed = await chat(app, session, 'Добавь 2 ABC-123');
  assert.equal(proposed.statusCode, 200);
  assert.ok(proposed.json().proposal?.id);

  const intervening = await chat(app, session, 'Есть ли ABC-124?');
  assert.equal(intervening.statusCode, 200);
  assert.equal(intervening.json().products[0].sku, 'ABC-124');

  const confirmation = await chat(app, session, 'Да, добавь');
  assert.equal(confirmation.statusCode, 200);
  assert.equal(confirmation.json().cartChanged, false);
  assert.equal((await cart(app, session)).json().itemCount, 0);
});

test('confirm rejects a product whose SKU or name changed after the proposal', async () => {
  for (const changedField of ['sku', 'name'] as const) {
    const base = createDemoCatalog();
    let changed = false;
    const catalog: CatalogProvider = {
      source: 'catalog_demo',
      findBySku: (sku) => base.findBySku(sku),
      async getById(id) {
        const product = await base.getById(id);
        if (!product || !changed || id !== 'demo-1') return product;
        return changedField === 'sku'
          ? { ...product, sku: 'DIFFERENT-999' }
          : { ...product, name: 'Different product' };
      },
      findAnalogs: (product) => base.findAnalogs(product),
    };
    const app = buildApp({ catalog, apiOrigin: origin });
    try {
      const session = await openSession(app);
      const proposed = await chat(app, session, 'Добавь 2 ABC-123');
      assert.equal(proposed.statusCode, 200);
      changed = true;

      const response = await confirm(app, session, proposed.json().proposal.id, `changed-${changedField}-001`);
      assert.equal(response.statusCode, 409, `${changedField} mismatch must invalidate consent`);
      assert.equal((await cart(app, session)).json().itemCount, 0);
    } finally {
      await app.close();
    }
  }
});

test('concurrent confirmation of one proposal with one idempotency key adds only once', async (t) => {
  const base = createDemoCatalog();
  let releaseRead!: () => void;
  let signalRead!: () => void;
  const reading = new Promise<void>((resolve) => { signalRead = resolve; });
  const waitForRelease = new Promise<void>((resolve) => { releaseRead = resolve; });
  let detailReads = 0;
  const catalog: CatalogProvider = {
    source: 'catalog_demo',
    findBySku: (sku) => base.findBySku(sku),
    async getById(id) {
      detailReads++;
      signalRead();
      await waitForRelease;
      return base.getById(id);
    },
    findAnalogs: (product) => base.findAnalogs(product),
  };
  const app = buildApp({ catalog, apiOrigin: origin });
  let confirmArrivals = 0;
  let signalSecondArrival!: () => void;
  const secondArrived = new Promise<void>((resolve) => { signalSecondArrival = resolve; });
  app.addHook('onRequest', async (request) => {
    if (request.url === '/api/cart/confirm' && ++confirmArrivals === 2) signalSecondArrival();
  });
  t.after(() => app.close());
  const session = await openSession(app);
  const proposed = await chat(app, session, 'Добавь 2 ABC-123');
  assert.equal(proposed.statusCode, 200);
  const proposalId = proposed.json().proposal.id as string;

  const first = confirm(app, session, proposalId, 'concurrent-key-001');
  await reading;
  const second = confirm(app, session, proposalId, 'concurrent-key-001');
  await secondArrived;
  releaseRead();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 200);
  assert.deepEqual(secondResponse.json(), firstResponse.json());
  assert.equal(detailReads, 1);
  assert.equal((await cart(app, session)).json().itemCount, 2);
});

test('new session creation is rate-limited per transport peer but existing carts stay available', async (t) => {
  let currentTime = 0;
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin, now: () => currentTime });
  t.after(() => app.close());
  const established = await openSession(app);

  for (let index = 1; index < 120; index++) {
    const response = await app.inject({ method: 'GET', url: '/api/cart', headers: { host } });
    assert.equal(response.statusCode, 200);
  }
  const rejected = await app.inject({ method: 'GET', url: '/api/cart', headers: { host } });
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.json().error.code, 'SESSION_RATE_LIMITED');
  assert.equal(rejected.headers['retry-after'], '60');
  assert.equal(rejected.headers['set-cookie'], undefined);
  assert.equal((await cart(app, established)).statusCode, 200);

  currentTime += 60_000;
  assert.equal((await app.inject({ method: 'GET', url: '/api/cart', headers: { host } })).statusCode, 200);
});

test('full session storage evicts empty carts while preserving a confirmed cart', async (t) => {
  let currentTime = 0;
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin, now: () => currentTime });
  t.after(() => app.close());
  const established = await openSession(app);
  const proposed = await chat(app, established, 'Добавь 2 ABC-123');
  assert.equal(proposed.statusCode, 200);
  assert.equal((await confirm(app, established, proposed.json().proposal.id, 'keep-cart-001')).statusCode, 200);

  for (let index = 0; index < 4999; index++) {
    if (index > 0 && index % 100 === 0) currentTime += 60_000;
    const response = await app.inject({ method: 'GET', url: '/api/cart', headers: { host } });
    assert.equal(response.statusCode, 200, `session ${index + 2}`);
  }
  const newcomer = await app.inject({ method: 'GET', url: '/api/cart', headers: { host } });
  assert.equal(newcomer.statusCode, 200);
  assert.equal((await cart(app, established)).json().itemCount, 2);
});

test('live catalog concurrency bound rejects excess reads and preserves pending cart consent', async (t) => {
  const base = createDemoCatalog();
  let startedReads = 0;
  let signalFull!: () => void;
  const full = new Promise<void>((resolve) => { signalFull = resolve; });
  let releaseReads!: () => void;
  const held = new Promise<void>((resolve) => { releaseReads = resolve; });
  let hold = false;
  const catalog: CatalogProvider = {
    source: 'catalog_live',
    async findBySku(sku) {
      if (hold) {
        startedReads++;
        if (startedReads === 8) signalFull();
        await held;
      }
      return base.findBySku(sku);
    },
    getById: (id) => base.getById(id),
    findAnalogs: (product) => base.findAnalogs(product),
  };
  const app = buildApp({ catalog, apiOrigin: origin });
  t.after(() => app.close());
  const sessions = await Promise.all(Array.from({ length: 9 }, () => openSession(app)));
  const proposed = await chat(app, sessions[8], 'Добавь 2 ABC-123');
  assert.equal(proposed.statusCode, 200);
  const proposalId = proposed.json().proposal.id as string;

  hold = true;
  const inFlight = sessions.slice(0, 8).map((session) => chat(app, session, 'Есть ли ABC-123?'));
  await full;
  const rejected = await confirm(app, sessions[8], proposalId, 'busy-confirm-001');
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.json().error.code, 'CATALOG_BUSY');
  assert.equal((await cart(app, sessions[8])).json().itemCount, 0);
  releaseReads();
  const results = await Promise.all(inFlight);
  assert.ok(results.every((result) => result.statusCode === 200));

  const accepted = await confirm(app, sessions[8], proposalId, 'busy-confirm-001');
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().cart.itemCount, 2);
});

test('live catalog rate budget rejects excess lookups before reaching the partner', async (t) => {
  const base = createDemoCatalog();
  let currentTime = 0;
  let lookups = 0;
  const catalog: CatalogProvider = {
    source: 'catalog_live',
    async findBySku(sku) { lookups++; return base.findBySku(sku); },
    getById: (id) => base.getById(id),
    findAnalogs: (product) => base.findAnalogs(product),
  };
  const app = buildApp({ catalog, apiOrigin: origin, now: () => currentTime });
  t.after(() => app.close());
  const session = await openSession(app);

  for (let index = 0; index < 60; index++) {
    assert.equal((await chat(app, session, 'Есть ли ABC-123?')).statusCode, 200);
  }
  const rejected = await chat(app, session, 'Есть ли ABC-123?');
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.json().error.code, 'CATALOG_BUSY');
  assert.equal(lookups, 60);

  currentTime += 60_000;
  assert.equal((await chat(app, session, 'Есть ли ABC-123?')).statusCode, 200);
  assert.equal(lookups, 61);
});

test('session cookie is Secure for an HTTPS public origin or production environment', async (t) => {
  const httpsApp = buildApp({ catalog: createDemoCatalog(), apiOrigin: 'https://api.test' });
  t.after(() => httpsApp.close());
  const httpsResponse = await httpsApp.inject({ method: 'GET', url: '/api/cart', headers: { host } });
  const httpsCookies = httpsResponse.headers['set-cookie'];
  assert.ok(Array.isArray(httpsCookies));
  assert.equal(httpsCookies.length, 2);
  assert.ok(httpsCookies.every((cookie) => /; Secure(?:;|$)/.test(cookie)));

  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const productionApp = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
    t.after(() => productionApp.close());
    const productionResponse = await productionApp.inject({ method: 'GET', url: '/api/cart', headers: { host } });
    const productionCookies = productionResponse.headers['set-cookie'];
    assert.ok(Array.isArray(productionCookies));
    assert.ok(productionCookies.every((cookie) => /; Secure(?:;|$)/.test(cookie)));
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
