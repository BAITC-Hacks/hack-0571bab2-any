import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { CatalogError, createLiveCatalog } from '../src/catalog.js';
import { CatalogIndex } from '../src/catalogIndex.js';

type RequestRecord = { method: string | undefined; url: string | undefined; authorization: string | undefined };

async function localCatalog(
  t: TestContext,
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function liveCatalog(baseUrl: string) {
  return createLiveCatalog({ baseUrl, username: 'synthetic-user', password: 'synthetic-password' });
}

const detail = {
  id: 17,
  article: 'ABC-123',
  name: 'Синтетический автомат',
  quantity: 4,
  price: 12345,
  url: 'https://ekt.kz/unverified-product-path',
  properties: {
    NOMINALNOE_NAPRYAZHENIE: '230 В',
    NOMINALNYY_TOK: 16,
    KOLICHESTVO_POLYUSOV: 2,
    TIP_USTANOVKI: 'DIN-рейка',
  },
};

test('live lookup uses only allowed read-only paths and keeps Basic Auth on the server', async (t) => {
  const requests: RequestRecord[] = [];
  const baseUrl = await localCatalog(t, (request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (request.url === '/api/products?page=1') {
      json(response, { page: 1, per_page: 20, count: 1, items: [{ id: 17, article: 'ABC-123', name: detail.name, price: 12345 }] });
    } else if (request.url === '/api/products/detail?id=17') {
      json(response, detail);
    } else {
      json(response, { error: 'unexpected path' }, 404);
    }
  });

  const product = await liveCatalog(baseUrl).findBySku(' abc-123 ');
  assert.ok(product);
  assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
    ['GET', '/api/products?page=1'],
    ['GET', '/api/products/detail?id=17'],
  ]);
  const expectedAuthorization = `Basic ${Buffer.from('synthetic-user:synthetic-password').toString('base64')}`;
  assert.ok(requests.every(({ authorization }) => authorization === expectedAuthorization));
  assert.equal(product.source, 'catalog_live');
  assert.equal(product.id, '17');
  assert.equal(product.sku, 'ABC-123');
  assert.equal(product.stock.available, 4);
  assert.equal(product.stock.status, 'in_stock');
  assert.equal(product.characteristics.NOMINALNYY_TOK, '16');
  assert.equal(product.characteristics.KOLICHESTVO_POLYUSOV, '2');
  assert.equal(product.category, null);
  assert.equal(product.price, null, 'price scale/currency are unverified');
  assert.equal(product.certificateUrl, null, 'detail has no verified certificate URL');
  assert.doesNotMatch(JSON.stringify(product), /synthetic-user|synthetic-password|Basic /);
});

test('bounded five-page search reports incomplete rather than inventing an absent product', async (t) => {
  const requests: string[] = [];
  const baseUrl = await localCatalog(t, (request, response) => {
    requests.push(request.url ?? '');
    const page = Number(new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('page'));
    json(response, { page, per_page: 1, count: 100, items: [{ id: page, article: `OTHER-${page}`, name: 'Не тот товар' }] });
  });

  await assert.rejects(liveCatalog(baseUrl).findBySku('ABC-123'), (error: unknown) => {
    assert.ok(error instanceof CatalogError);
    assert.equal(error.code, 'CATALOG_SEARCH_INCOMPLETE');
    return true;
  });
  assert.deepEqual(requests, [1, 2, 3, 4, 5].map((page) => `/api/products?page=${page}`));
});

test('short non-final list page cannot hide a product on the next page', async (t) => {
  const requests: string[] = [];
  const baseUrl = await localCatalog(t, (request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/api/products?page=1') {
      json(response, { page: 1, per_page: 20, count: 2,
        items: [{ id: 18, article: 'OTHER-18', name: 'Другой товар' }] });
    } else if (request.url === '/api/products?page=2') {
      json(response, { page: 2, per_page: 20, count: 2,
        items: [{ id: 17, article: 'ABC-123', name: detail.name }] });
    } else if (request.url === '/api/products/detail?id=17') {
      json(response, detail);
    } else json(response, { error: 'unexpected path' }, 404);
  });

  const product = await liveCatalog(baseUrl).findBySku('ABC-123');
  assert.equal(product?.id, '17');
  assert.deepEqual(requests, ['/api/products?page=1', '/api/products?page=2', '/api/products/detail?id=17']);
});

test('short non-final list pages cannot prove an unindexed SKU is absent', async (t) => {
  const requests: string[] = [];
  const baseUrl = await localCatalog(t, (request, response) => {
    requests.push(request.url ?? '');
    const page = Number(new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('page'));
    json(response, { page, per_page: 20, count: 100,
      items: [{ id: page, article: `OTHER-${page}`, name: 'Другой товар' }] });
  });

  await assert.rejects(liveCatalog(baseUrl).findBySku('ABC-123'), (error: unknown) => {
    assert.ok(error instanceof CatalogError);
    assert.equal(error.code, 'CATALOG_SEARCH_INCOMPLETE');
    return true;
  });
  assert.deepEqual(requests, [1, 2, 3, 4, 5].map((page) => `/api/products?page=${page}`));
});

test('missing category prevents live analog suggestions and avoids further catalog requests', async (t) => {
  const requests: string[] = [];
  const baseUrl = await localCatalog(t, (request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/api/products/detail?id=17') json(response, detail);
    else json(response, { error: 'unexpected path' }, 404);
  });

  const catalog = liveCatalog(baseUrl);
  const product = await catalog.getById('17');
  assert.ok(product);
  assert.equal(product.category, null);
  assert.deepEqual(await catalog.findAnalogs(product), []);
  assert.deepEqual(requests, ['/api/products/detail?id=17']);
});

test('live analog requires the same category, all four critical properties, and positive stock', async (t) => {
  const requests: string[] = [];
  const categorizedDetail = { ...detail, category: 'Автоматический выключатель' };
  const baseUrl = await localCatalog(t, (request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/api/products/detail?id=17') json(response, categorizedDetail);
    else if (request.url === '/api/products?page=1') {
      json(response, { page: 1, per_page: 20, count: 4, items: [
        { id: 17, article: 'ABC-123' },
        { id: 18, article: 'ABC-124' },
        { id: 19, article: 'ABC-125' },
        { id: 20, article: 'ABC-126' },
      ] });
    } else if (request.url === '/api/products?page=2') {
      json(response, { page: 2, per_page: 20, count: 4, items: [] });
    } else if (request.url === '/api/products/detail?id=18') {
      json(response, { ...categorizedDetail, id: 18, article: 'ABC-124', quantity: 3 });
    } else if (request.url === '/api/products/detail?id=19') {
      json(response, { ...categorizedDetail, id: 19, article: 'ABC-125', quantity: 0 });
    } else if (request.url === '/api/products/detail?id=20') {
      json(response, { ...categorizedDetail, id: 20, article: 'ABC-126', quantity: 3,
        properties: { ...detail.properties, NOMINALNYY_TOK: 25 } });
    } else json(response, { error: 'unexpected path' }, 404);
  });

  const catalog = liveCatalog(baseUrl);
  const product = await catalog.getById('17');
  assert.ok(product);
  const analogs = await catalog.findAnalogs(product);
  assert.equal(analogs.length, 1);
  assert.equal(analogs[0].product.sku, 'ABC-124');
  assert.equal(analogs[0].product.stock.available, 3);
  assert.equal(analogs[0].matchedCharacteristics.length, 4);
  assert.match(analogs[0].reason, /остальные параметры проверьте/);
  assert.deepEqual(requests, [
    '/api/products/detail?id=17', '/api/products?page=1',
    '/api/products/detail?id=18', '/api/products/detail?id=19', '/api/products/detail?id=20',
    '/api/products?page=2',
  ]);
});

test('live adapter rejects unrelated hosts, HTTP for ekt.kz, and URL credentials', () => {
  for (const baseUrl of [
    'https://not-ekt.example',
    'http://ekt.kz',
    'https://synthetic-user:synthetic-password@ekt.kz',
  ]) {
    assert.throws(() => liveCatalog(baseUrl), (error: unknown) => {
      assert.ok(error instanceof CatalogError);
      assert.equal(error.code, 'CATALOG_UNAVAILABLE');
      assert.doesNotMatch(error.message, /synthetic-user|synthetic-password/);
      return true;
    });
  }
});

test('indexed article on a distant page uses one fresh detail read, not a five-page guess', async (t) => {
  const requests: string[] = [];
  const baseUrl = await localCatalog(t, (request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/api/products/detail?id=9999') {
      json(response, { ...detail, id: 9999, article: 'FAR-9999', name: 'Текущее название', quantity: 2 });
    } else json(response, { error: 'unexpected path' }, 404);
  });
  const index = new CatalogIndex([{ id: '9999', sku: 'FAR-9999', name: 'Старое название', category: null }]);
  const catalog = createLiveCatalog({ baseUrl, username: 'synthetic-user', password: 'synthetic-password', index });
  const product = await catalog.findBySku('FAR-9999');
  assert.equal(product?.name, 'Текущее название');
  assert.equal(product?.stock.available, 2);
  assert.deepEqual(requests, ['/api/products/detail?id=9999']);
});

test('partial index with no compatible analog falls back to bounded live pages', async (t) => {
  const requests: string[] = [];
  const source = { ...detail, category: 'Автоматический выключатель' };
  const baseUrl = await localCatalog(t, (request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/api/products/detail?id=88') {
      json(response, { ...source, id: 88, article: 'WRONG-88', category: 'Розетка', quantity: 5 });
    } else if (request.url === '/api/products?page=1') {
      json(response, { page: 1, per_page: 20, count: 2, items: [
        { id: 17, article: 'ABC-123' }, { id: 18, article: 'ABC-124' },
      ] });
    } else if (request.url === '/api/products?page=2') {
      json(response, { page: 2, per_page: 20, count: 2, items: [] });
    } else if (request.url === '/api/products/detail?id=18') {
      json(response, { ...source, id: 18, article: 'ABC-124', quantity: 3 });
    } else json(response, { error: 'unexpected path' }, 404);
  });
  const index = new CatalogIndex([{ id: '88', sku: 'WRONG-88', name: 'Автоматический выключатель', category: null }]);
  const catalog = createLiveCatalog({ baseUrl, username: 'synthetic-user', password: 'synthetic-password', index });
  const analogs = await catalog.findAnalogs({ ...source,
    id: '17', sku: 'ABC-123', stock: { available: 0, status: 'out_of_stock' },
    characteristics: Object.fromEntries(Object.entries(source.properties).map(([key, value]) => [key, String(value)])),
    source: 'catalog_live', certificateUrl: null, price: null });
  assert.equal(analogs.length, 1);
  assert.equal(analogs[0]?.product.sku, 'ABC-124');
  assert.deepEqual(requests, [
    '/api/products/detail?id=88', '/api/products?page=1', '/api/products/detail?id=18', '/api/products?page=2',
  ]);
});
