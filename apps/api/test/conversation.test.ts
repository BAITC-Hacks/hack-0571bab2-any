import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/server.js';
import { createDemoCatalog } from '../src/catalog.js';

const host = 'api.test';
const origin = `http://${host}`;
type App = ReturnType<typeof buildApp>;
async function open(app: App) {
  const response = await app.inject({ method: 'GET', url: '/api/cart', headers: { host } });
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : [String(raw)];
  const cookie = cookies.find(value => value.startsWith('ha_sid='))!.split(';')[0]!;
  return { cookie, csrfToken: response.json().csrfToken as string };
}
async function ask(app: App, session: Awaited<ReturnType<typeof open>>, message: string, locale: 'ru' | 'kk' = 'ru') {
  const response = await app.inject({ method: 'POST', url: '/api/chat',
    headers: { host, origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken }, payload: { message, locale } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.cartChanged, false);
  assert.equal(body.proposal, null);
  assert.deepEqual(body.products, []);
  assert.deepEqual(body.analogs, []);
  const cart = await app.inject({ method: 'GET', url: '/api/cart', headers: { host, cookie: session.cookie } });
  assert.equal(cart.json().itemCount, 0);
  return body.reply as string;
}

test('ordinary Russian site identity is answered without demanding an SKU', async t => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
  t.after(() => app.close());
  const session = await open(app);
  const reply = await ask(app, session, 'На какой я сайт попал?');
  assert.match(reply, /ekt\.kz|Электрокомплект/iu);
  assert.doesNotMatch(reply, /^Укажите артикул/iu);
});

test('Russian greetings receive a useful assistant response and never change the cart', async t => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
  t.after(() => app.close());
  const session = await open(app);
  for (const message of ['Алло ии', 'Алло', 'Привет']) {
    const reply = await ask(app, session, message);
    assert.match(reply, /помо|подоб|товар|Электрокомплект/iu);
    assert.doesNotMatch(reply, /^Укажите артикул/iu);
  }
});

test('Kazakh greeting is localized and does not invent catalog facts', async t => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
  t.after(() => app.close());
  const session = await open(app);
  const reply = await ask(app, session, 'Сәлем', 'kk');
  assert.match(reply, /Сәлем|көмек|тауар|таңда/iu);
  assert.doesNotMatch(reply, /Укажите артикул|В наличии|Қоймада: \d/iu);
});

test('unclear electrical request asks a useful question without fabricated facts', async t => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: origin });
  t.after(() => app.close());
  const session = await open(app);
  const reply = await ask(app, session, 'Помогите понять, что мне нужно для подключения оборудования');
  assert.ok(reply.length > 30);
  assert.doesNotMatch(reply, /^Укажите артикул товара, чтобы проверить характеристики и остаток\.$/u);
  assert.doesNotMatch(reply, /В наличии: \d|Цена: \d|https?:\/\/.*сертификат/iu);
});
