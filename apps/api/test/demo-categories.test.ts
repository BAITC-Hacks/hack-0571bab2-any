import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/server.js';
import { createDemoCatalog, createDemoCatalogIndex } from '../src/catalog.js';

test('default demo index supports distinct categories and a whole-home clarification', async (t) => {
  const app = buildApp({ catalog: createDemoCatalog(), catalogIndex: createDemoCatalogIndex(),
    apiOrigin: 'http://demo.test' });
  t.after(() => app.close());
  const open = await app.inject({ method: 'GET', url: '/api/cart', headers: { host: 'demo.test' } });
  const cookie = String(open.headers['set-cookie']).split(';')[0];
  const headers = { host: 'demo.test', origin: 'http://demo.test', cookie,
    'x-csrf-token': open.json().csrfToken };

  const multi = await app.inject({ method: 'POST', url: '/api/chat', headers,
    payload: { message: 'Нужны кабель и розетка', locale: 'ru' } });
  assert.equal(multi.statusCode, 200);
  assert.deepEqual(multi.json().products.map((product: { category: string }) => product.category).sort(),
    ['Кабель', 'Розетка']);
  assert.equal(multi.json().cartChanged, false);

  const home = await app.inject({ method: 'POST', url: '/api/chat', headers,
    payload: { message: 'Полностью подбери электрику для дома', locale: 'ru' } });
  assert.equal(home.statusCode, 200);
  assert.equal(new Set(home.json().products.map((product: { category: string }) => product.category)).size, 4);
  assert.match(home.json().reply, /уточните число помещений, нагрузку и схему/i);
  assert.equal(home.json().cartChanged, false);
});
