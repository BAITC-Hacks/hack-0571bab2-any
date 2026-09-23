/** Catalog facts are read on the server; this module never writes to ekt.kz. */
import { CatalogIndex } from './catalogIndex.js';
export type CatalogSource = 'catalog_live' | 'catalog_demo';

export type Product = {
  id: string;
  sku: string;
  name: string;
  category?: string | null;
  characteristics: Record<string, string>;
  certificateUrl?: string | null;
  price?: { amount: string; currency: string } | null;
  stock: {
    available: number | null;
    status: 'in_stock' | 'out_of_stock' | 'unknown';
  };
  source: CatalogSource;
};

export type Analog = {
  product: Product;
  reason: string;
  matchedCharacteristics: string[];
};

export interface CatalogProvider {
  readonly source: CatalogSource;
  findBySku(sku: string): Promise<Product | null>;
  getById(id: string): Promise<Product | null>;
  findAnalogs(product: Product): Promise<Analog[]>;
}

export type CatalogErrorCode =
  | 'CATALOG_UNAUTHORIZED'
  | 'CATALOG_RATE_LIMITED'
  | 'CATALOG_TIMEOUT'
  | 'CATALOG_UNAVAILABLE'
  | 'CATALOG_INVALID_RESPONSE'
  | 'CATALOG_SEARCH_INCOMPLETE';

/** Fixed public messages prevent URLs, credentials, or response bodies leaking into errors. */
export class CatalogError extends Error {
  readonly code: CatalogErrorCode;

  constructor(code: CatalogErrorCode) {
    super({
      CATALOG_UNAUTHORIZED: 'Нет доступа к каталогу.',
      CATALOG_RATE_LIMITED: 'Каталог временно ограничил запросы.',
      CATALOG_TIMEOUT: 'Каталог не ответил вовремя.',
      CATALOG_UNAVAILABLE: 'Каталог временно недоступен.',
      CATALOG_INVALID_RESPONSE: 'Каталог вернул неожиданные данные.',
      CATALOG_SEARCH_INCOMPLETE: 'Поиск по каталогу не завершён; наличие товара не подтверждено.',
    }[code]);
    this.name = 'CatalogError';
    this.code = code;
  }
}

const CRITICAL_CHARACTERISTICS = [
  ['NOMINALNOE_NAPRYAZHENIE', 'Номинальное напряжение'],
  ['NOMINALNYY_TOK', 'Номинальный ток'],
  ['KOLICHESTVO_POLYUSOV', 'Количество полюсов'],
  ['TIP_USTANOVKI', 'Тип установки'],
] as const;

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
}

function stock(available: number | null): Product['stock'] {
  return {
    available,
    status: available === null ? 'unknown' : available > 0 ? 'in_stock' : 'out_of_stock',
  };
}

function copy(product: Product): Product {
  return {
    ...product,
    characteristics: { ...product.characteristics },
    stock: { ...product.stock },
    price: product.price ? { ...product.price } : null,
  };
}

/** The four known safety-critical fields must be present and identical. */
function compatibleAnalog(original: Product, candidate: Product): Analog | null {
  if (candidate.id === original.id || candidate.stock.status !== 'in_stock') return null;
  if (!original.category || !candidate.category || normalized(original.category) !== normalized(candidate.category)) {
    return null;
  }

  const matched: string[] = [];
  for (const [key, label] of CRITICAL_CHARACTERISTICS) {
    const expected = original.characteristics[key];
    const actual = candidate.characteristics[key];
    if (!expected) return null;
    if (!actual) return null;
    if (normalized(expected) !== normalized(actual)) return null;
    matched.push(`${label}: ${actual}`);
  }
  return {
    product: copy(candidate),
    reason: `Та же категория; совпадают ${matched.join(', ')}. Товар в наличии; остальные параметры проверьте перед покупкой.`,
    matchedCharacteristics: matched,
  };
}

const DEMO_CHARACTERISTICS = {
  NOMINALNOE_NAPRYAZHENIE: '230 В',
  NOMINALNYY_TOK: '16 А',
  KOLICHESTVO_POLYUSOV: '2',
  TIP_USTANOVKI: 'DIN-рейка',
};

/** All products here are fictional and visibly marked catalog_demo. */
const DEMO_PRODUCTS: Product[] = [
  {
    id: 'demo-1',
    sku: 'ABC-123',
    name: 'Демо автоматический выключатель ABC-123',
    category: 'Автоматический выключатель',
    characteristics: { ...DEMO_CHARACTERISTICS, NOMINALNYY_TOK: '10 А' },
    certificateUrl: null,
    price: null,
    stock: stock(4),
    source: 'catalog_demo',
  },
  {
    id: 'demo-0',
    sku: 'ABC-000',
    name: 'Демо автоматический выключатель ABC-000',
    category: 'Автоматический выключатель',
    characteristics: { ...DEMO_CHARACTERISTICS },
    certificateUrl: null,
    price: null,
    stock: stock(0),
    source: 'catalog_demo',
  },
  {
    id: 'demo-2',
    sku: 'ABC-124',
    name: 'Демо автоматический выключатель ABC-124',
    category: 'Автоматический выключатель',
    characteristics: { ...DEMO_CHARACTERISTICS },
    certificateUrl: null,
    price: null,
    stock: stock(3),
    source: 'catalog_demo',
  },
  {
    id: 'demo-cable', sku: 'DEMO-CABLE-10', name: 'Демо кабель медный DEMO-CABLE-10',
    category: 'Кабель', characteristics: { СЕЧЕНИЕ: '3 × 2,5 мм²', МАТЕРИАЛ: 'медь' },
    certificateUrl: null, price: null, stock: stock(12), source: 'catalog_demo',
  },
  {
    id: 'demo-socket', sku: 'DEMO-SOCKET-16', name: 'Демо розетка DEMO-SOCKET-16',
    category: 'Розетка', characteristics: { NOMINALNYY_TOK: '16 А', TIP_USTANOVKI: 'встраиваемая' },
    certificateUrl: null, price: null, stock: stock(6), source: 'catalog_demo',
  },
  {
    id: 'demo-light', sku: 'DEMO-LIGHT-12', name: 'Демо светильник DEMO-LIGHT-12',
    category: 'Светильник', characteristics: { МОЩНОСТЬ: '12 Вт', NOMINALNOE_NAPRYAZHENIE: '230 В' },
    certificateUrl: null, price: null, stock: stock(9), source: 'catalog_demo',
  },
  {
    id: 'demo-switch', sku: 'DEMO-SWITCH-1', name: 'Демо выключатель DEMO-SWITCH-1',
    category: 'Выключатель', characteristics: { КЛАВИШИ: '1', TIP_USTANOVKI: 'встраиваемый' },
    certificateUrl: null, price: null, stock: stock(7), source: 'catalog_demo',
  },
];

/** Search hints only; all customer-facing facts are reread from the demo provider. */
export function createDemoCatalogIndex(): CatalogIndex {
  return new CatalogIndex(DEMO_PRODUCTS.map(({ id, sku, name, category }) => ({
    id, sku, name, category: category ?? null,
  })));
}

export function createDemoCatalog(): CatalogProvider {
  return {
    source: 'catalog_demo',
    async findBySku(sku) {
      const product = DEMO_PRODUCTS.find((item) => normalized(item.sku) === normalized(sku));
      return product ? copy(product) : null;
    },
    async getById(id) {
      const product = DEMO_PRODUCTS.find((item) => item.id === id);
      return product ? copy(product) : null;
    },
    async findAnalogs(product) {
      return DEMO_PRODUCTS.flatMap((candidate) => {
        const analog = compatibleAnalog(product, candidate);
        return analog ? [analog] : [];
      });
    },
  };
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function propertyText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

function normalizeDetail(raw: unknown): Product | null {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === 'number' && Number.isSafeInteger(raw.id)
    ? String(raw.id)
    : nonemptyString(raw.id);
  const sku = nonemptyString(raw.article);
  const name = nonemptyString(raw.name);
  if (!id || !sku || !name) return null;

  const characteristics: Record<string, string> = {};
  if (isObject(raw.properties)) {
    for (const [key, value] of Object.entries(raw.properties)) {
      const text = propertyText(value);
      if (text) characteristics[key] = text;
    }
  }

  const quantity = raw.quantity;
  const available = typeof quantity === 'number' && Number.isSafeInteger(quantity) && quantity >= 0
    ? quantity
    : null;
  const category = nonemptyString(raw.category)
    ?? nonemptyString(raw.category_name)
    ?? nonemptyString(characteristics.KATEGORIYA)
    ?? nonemptyString(characteristics.CATEGORY);

  return {
    id,
    sku,
    name,
    category,
    characteristics,
    // The verified API shape gives no certificate field and no price currency/scale.
    certificateUrl: null,
    price: null,
    stock: stock(available),
    source: 'catalog_live',
  };
}

const REQUEST_TIMEOUT_MS = 5_000;
const SEARCH_BUDGET_MS = 6_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_SEARCH_PAGES = 5;
const MAX_ANALOG_PAGES = 2;
const MAX_ANALOG_DETAILS = 8;
const MAX_ANALOG_RESULTS = 3;

export function createLiveCatalog(config: {
  baseUrl: string;
  username: string;
  password: string;
  index?: CatalogIndex;
}): CatalogProvider {
  let baseUrl: URL;
  try {
    baseUrl = new URL(config.baseUrl);
    const localTestHost = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname);
    if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && localTestHost)) throw new Error();
    if (!localTestHost && baseUrl.hostname !== 'ekt.kz' && baseUrl.hostname !== 'www.ekt.kz') throw new Error();
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error();
    if (!config.username || !config.password) throw new Error();
  } catch {
    throw new CatalogError('CATALOG_UNAVAILABLE');
  }
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;

  async function readJson(path: '/api/products' | '/api/products/detail', params: Record<string, string>, deadline = Infinity): Promise<unknown | null> {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const timeout = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
    if (timeout <= 0) throw new CatalogError('CATALOG_TIMEOUT');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: authorization, Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status === 404) return null;
      if (response.status === 401 || response.status === 403) throw new CatalogError('CATALOG_UNAUTHORIZED');
      if (response.status === 429) throw new CatalogError('CATALOG_RATE_LIMITED');
      if (!response.ok) throw new CatalogError('CATALOG_UNAVAILABLE');

      const chunks: Uint8Array[] = [];
      let length = 0;
      if (!response.body) throw new CatalogError('CATALOG_INVALID_RESPONSE');
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new CatalogError('CATALOG_INVALID_RESPONSE');
        }
        chunks.push(value);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new CatalogError('CATALOG_INVALID_RESPONSE');
      }
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      if (controller.signal.aborted) throw new CatalogError('CATALOG_TIMEOUT');
      throw new CatalogError('CATALOG_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }

  async function listPage(page: number, deadline = Infinity): Promise<{ items: JsonObject[]; complete: boolean }> {
    const raw = await readJson('/api/products', { page: String(page) }, deadline);
    if (!isObject(raw) || !Array.isArray(raw.items) || !raw.items.every(isObject)) {
      throw new CatalogError('CATALOG_INVALID_RESPONSE');
    }
    // The partner API can return a short non-final page. Only an empty page
    // signals an end; otherwise a bounded lookup must report incomplete.
    const complete = raw.items.length === 0;
    return { items: raw.items, complete };
  }

  async function getById(id: string, deadline = Infinity): Promise<Product | null> {
    if (!/^\d+$/.test(id)) return null;
    const raw = await readJson('/api/products/detail', { id }, deadline);
    if (raw === null) return null;
    const product = normalizeDetail(raw);
    if (!product) throw new CatalogError('CATALOG_INVALID_RESPONSE');
    if (product.id !== String(Number(id))) throw new CatalogError('CATALOG_INVALID_RESPONSE');
    return product;
  }

  return {
    source: 'catalog_live',
    async findBySku(sku) {
      const sought = normalized(sku);
      if (!sought) return null;
      const deadline = Date.now() + SEARCH_BUDGET_MS;
      // The snapshot is only a locator. Product facts always come from fresh
      // detail, and a stale/missing index entry falls through to bounded search.
      for (const candidate of config.index?.findExactSku(sku).slice(0, 4) ?? []) {
        const product = await getById(candidate.id, deadline);
        if (product && normalized(product.sku) === sought) return product;
      }
      for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
        const result = await listPage(page, deadline);
        const item = result.items.find((candidate) => {
          const article = nonemptyString(candidate.article);
          return article !== null && normalized(article) === sought;
        });
        if (item) {
          const id = typeof item.id === 'number' && Number.isSafeInteger(item.id)
            ? String(item.id) : nonemptyString(item.id);
          if (!id) throw new CatalogError('CATALOG_INVALID_RESPONSE');
          const product = await getById(id, deadline);
          if (!product || normalized(product.sku) !== sought) throw new CatalogError('CATALOG_INVALID_RESPONSE');
          return product;
        }
        if (result.complete) return null;
      }
      throw new CatalogError('CATALOG_SEARCH_INCOMPLETE');
    },
    getById,
    async findAnalogs(product) {
      // Without a category from the product data, compatibility cannot be verified.
      if (!product.category) return [];
      const deadline = Date.now() + SEARCH_BUDGET_MS;
      const analogs: Analog[] = [];
      let detailsRead = 0;
      const inspected = new Set<string>();
      const categoryQuery = (product.category.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12).join(' ').slice(0, 200);
      if (config.index?.size && categoryQuery) {
        // Category words are candidate hints, not proof of compatibility.
        // compatibleAnalog requires the current detail's category and four
        // safety-critical properties to match before presenting any analog.
        const indexed = config.index.search(categoryQuery, { match: 'any', limit: 20 });
        for (const item of indexed) {
          // Reserve half the detail budget for the legacy first-page fallback:
          // the optional snapshot can be partial or have no category facet.
          if (detailsRead >= Math.floor(MAX_ANALOG_DETAILS / 2) || analogs.length >= MAX_ANALOG_RESULTS) break;
          if (item.id === product.id || !/^\d+$/.test(item.id)) continue;
          inspected.add(item.id);
          detailsRead++;
          const candidate = await getById(item.id, deadline);
          if (!candidate) continue;
          const analog = compatibleAnalog(product, candidate);
          if (analog) analogs.push(analog);
        }
        if (analogs.length) return analogs;
      }
      for (let page = 1; page <= MAX_ANALOG_PAGES; page++) {
        const result = await listPage(page, deadline);
        for (const item of result.items) {
          if (detailsRead >= MAX_ANALOG_DETAILS || analogs.length >= MAX_ANALOG_RESULTS) return analogs;
          const id = typeof item.id === 'number' && Number.isSafeInteger(item.id)
            ? String(item.id) : nonemptyString(item.id);
          if (!id || id === product.id || inspected.has(id) || !/^\d+$/.test(id)) continue;
          inspected.add(id);
          detailsRead++;
          const candidate = await getById(id, deadline);
          if (!candidate) continue;
          const analog = compatibleAnalog(product, candidate);
          if (analog) analogs.push(analog);
        }
        if (result.complete) break;
      }
      return analogs;
    },
  };
}
