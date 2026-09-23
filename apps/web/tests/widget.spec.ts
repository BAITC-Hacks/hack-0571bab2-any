import { expect, test, type Page } from '@playwright/test';

const product = {
  id: 'test-1', sku: 'TEST-101', name: 'Тестовый автомат 16 А',
  characteristics: { 'Ток': '16 А', 'Полюса': '1P' },
  certificateUrl: 'https://example.org/test-certificate.pdf',
  price: null, stock: { available: 4, status: 'in_stock' }, source: 'catalog_demo',
};

async function server(page: Page) {
  const calls = { chat: [] as { message: string; locale: string }[], confirm: [] as { proposalId: string; idempotencyKey: string }[], uploads: [] as Record<string, string>[] };
  let quantity = 0;
  let proposed = 1;
  let proposalId = 0;
  const cart = () => ({ items: quantity ? [{ productId: product.id, sku: product.sku, name: product.name, quantity, availableAtConfirmation: 4 }] : [], itemCount: quantity, cartUrl: '/cart', mode: 'demo', csrfToken: 'synthetic-test-csrf' });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown;
    if (path === '/api/health') body = { ok: true, catalog: 'demo', model: 'fallback' };
    else if (path === '/api/cart') body = cart();
    else if (path === '/api/chat') {
      const data = request.postDataJSON(); calls.chat.push(data);
      proposed = Number(data.message.match(/(?:Добавь |себетке )(\d+)/)?.[1] || 1);
      const adding = /Добавь|себетке/.test(data.message);
      const analog = /аналог/i.test(data.message);
      const terms = /условия/i.test(data.message);
      body = {
        reply: terms ? 'Оплата картой или по счёту. Доставку уточните по региону. Минимальная партия не подтверждена.' : data.locale === 'kk' ? 'Тауар табылды.' : 'Товар найден в тестовом каталоге.',
        products: terms ? [] : [{ ...product, ...(analog ? { stock: { available: 0, status: 'out_of_stock' } } : {}) }],
        analogs: analog ? [{ product: { ...product, id: 'test-2', sku: 'TEST-102', name: 'Совместимый тестовый автомат' }, reason: 'Совпадают ток 16 А и число полюсов 1P.', matchedCharacteristics: ['Ток', 'Полюса'] }] : [],
        proposal: adding ? { id: `proposal-${++proposalId}`, items: [{ productId: product.id, quantity: proposed }], expiresAt: new Date(Date.now() + 60_000).toISOString() } : null,
        factsSource: terms ? 'partner_policy' : 'catalog_demo', cartChanged: false,
        ...(terms ? { sourceUrl: 'https://ekt.kz/checkout-delivery/', checkedAt: '2026-09-23' } : {}),
      };
    } else if (path === '/api/cart/confirm') {
      const data = request.postDataJSON(); calls.confirm.push(data);
      await new Promise(resolve => setTimeout(resolve, 100));
      quantity = proposed;
      body = { cart: cart(), cartUrl: '/cart', status: 'added' };
    } else if (path === '/api/attachments') {
      calls.uploads.push(request.headers());
      body = { candidates: [{ sku: 'TEST-101', quantity: 2, confidence: 'medium' }], products: [], warning: 'Проверьте распознанный артикул.', requiresManualReview: true, cartChanged: false, factsSource: 'catalog_demo' };
    } else throw new Error(`Unexpected API call: ${path}`);
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  await page.locator('#ekt-ai-widget').getByRole('button', { name: 'ИИ-помощник', exact: true }).click();
  return calls;
}
const widget = (page: Page) => page.locator('#ekt-ai-widget');
async function send(page: Page, message: string) {
  await widget(page).getByRole('textbox').fill(message);
  await widget(page).getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(widget(page).getByRole('textbox')).toBeEnabled();
}

test('catalog facts, certificate, analog reason and sourced purchase terms', async ({ page }) => {
  const calls = await server(page);
  await send(page, 'TEST-101');
  await expect(widget(page).getByRole('link', { name: 'Сертификат' })).toHaveAttribute('href', product.certificateUrl);
  await expect(widget(page).getByText('Остаток: 4 шт.')).toBeVisible();
  await expect(widget(page).getByText('Цена не указана в каталоге')).toBeVisible();
  await expect(widget(page).getByText('16 А', { exact: true })).toBeVisible();
  await send(page, 'Подбери аналог');
  await expect(widget(page).getByText('Совпадают ток 16 А и число полюсов 1P.')).toBeVisible();
  await send(page, 'Какие условия покупки?');
  await expect(widget(page).getByRole('link', { name: 'Источник' })).toHaveAttribute('href', 'https://ekt.kz/checkout-delivery/');
  await expect(widget(page).getByText(/Минимальная партия не подтверждена/)).toBeVisible();
  expect(calls.confirm).toHaveLength(0);
});

test('quantity revision requires a new proposal; one confirm request on rapid clicks', async ({ page }) => {
  const calls = await server(page);
  await send(page, 'Добавь 1 шт. артикул TEST-101');
  const proposal = widget(page).getByRole('region', { name: 'Подтвердить и добавить' });
  await expect(proposal.getByText('Корзина пока не изменена')).toBeVisible();
  expect(calls.confirm).toHaveLength(0);
  await proposal.getByRole('spinbutton').fill('2');
  await expect(proposal.getByRole('button', { name: 'Подтвердить и добавить' })).toHaveCount(0);
  await proposal.getByRole('button', { name: 'Проверить новое количество' }).click();
  await expect(proposal.getByRole('button', { name: 'Подтвердить и добавить' })).toBeEnabled();
  expect(calls.chat).toHaveLength(2);
  expect(calls.confirm).toHaveLength(0);
  await proposal.getByRole('button', { name: 'Подтвердить и добавить' }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(widget(page).getByRole('link', { name: /Открыть актуальную корзину/ })).toHaveAttribute('href', /\/cart\?lang=ru$/);
  expect(calls.confirm).toHaveLength(1);
  expect(calls.confirm[0].proposalId).toBe('proposal-2');
  expect(calls.confirm[0].idempotencyKey.length).toBeGreaterThan(8);
  await widget(page).getByRole('link', { name: /Открыть актуальную корзину/ }).click();
  await expect(page.getByRole('heading', { name: 'Корзина', exact: true })).toBeVisible();
  await expect(page.locator('main').getByText('TEST-101', { exact: false })).toBeVisible();
  await expect(page.locator('.cart-item b')).toHaveText('2 шт.');
});

test('quick, half and full modes retain the draft and conversation', async ({ page }) => {
  await server(page);
  await send(page, 'TEST-101');
  await widget(page).getByRole('textbox').fill('Нужен ещё один');
  await widget(page).getByRole('button', { name: 'Половина экрана' }).click();
  await expect(widget(page).getByRole('textbox')).toHaveValue('Нужен ещё один');
  await widget(page).getByRole('button', { name: 'Полный экран' }).click();
  await expect(widget(page).getByText('Товар найден в тестовом каталоге.')).toBeVisible();
  await expect(widget(page).getByRole('textbox')).toHaveValue('Нужен ещё один');
  await widget(page).getByRole('button', { name: 'Свернуть помощника' }).click();
  await widget(page).getByRole('button', { name: 'ИИ-помощник', exact: true }).click();
  await expect(widget(page).getByRole('textbox')).toHaveValue('Нужен ещё один');
});

test('Kazakh interface sends the locale and keeps Russian available', async ({ page }) => {
  const calls = await server(page);
  await widget(page).getByRole('button', { name: 'ҚАЗ', exact: true }).click();
  await widget(page).getByRole('textbox').fill('TEST-101 бар ма?');
  await widget(page).getByRole('button', { name: 'Жіберу', exact: true }).click();
  await expect(widget(page).getByText('Тауар табылды.')).toBeVisible();
  expect(calls.chat[0].locale).toBe('kk');
  await widget(page).getByRole('button', { name: 'РУС', exact: true }).click();
  await expect(widget(page).getByRole('button', { name: 'Отправить', exact: true })).toBeVisible();
});

test('attachment candidates require manual review and still only prepare the cart', async ({ page }) => {
  const calls = await server(page);
  await widget(page).locator('input[type=file]').setInputFiles({ name: 'synthetic-spec.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic test only') });
  await widget(page).getByRole('button', { name: 'Проверить файл', exact: true }).click();
  const review = widget(page).locator('.file-review');
  await expect(review.getByRole('button', { name: 'Проверить позицию' })).toBeDisabled();
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Проверить позицию' }).click();
  await expect(widget(page).getByRole('button', { name: 'Подтвердить и добавить' })).toBeEnabled();
  expect(calls.confirm).toHaveLength(0);
  expect(calls.chat[0].message).toContain('2 шт.');
  expect(calls.uploads[0]['content-type']).toContain('multipart/form-data; boundary=');
  expect(calls.uploads[0]['x-attachment-locale']).toBe('ru');
});

test('uncertain confirmation replays the same key even after local proposal expiry', async ({ page }) => {
  await page.clock.install();
  await server(page);
  const attempts: { proposalId: string; idempotencyKey: string }[] = [];
  await page.route('**/api/cart/confirm', async route => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) { await route.abort('failed'); return; }
    await route.fulfill({ json: { status: 'added', cartUrl: '/cart', cart: { items: [{ productId: product.id, sku: product.sku, name: product.name, quantity: 1, availableAtConfirmation: 4 }], itemCount: 1, mode: 'demo' } } });
  });
  await send(page, 'Добавь 1 шт. артикул TEST-101');
  await widget(page).getByRole('button', { name: 'Подтвердить и добавить' }).click();
  await expect(widget(page).getByText(/Подтверждение не получено/)).toBeVisible();
  await page.clock.fastForward(65_000);
  await expect(widget(page).getByRole('textbox')).toBeDisabled();
  await widget(page).getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(widget(page).getByText(/Товар добавлен/)).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
});

test('HTTP 500 after confirmation blocks new actions and retries the same key', async ({ page }) => {
  await page.clock.install();
  const calls = await server(page);
  const attempts: { proposalId: string; idempotencyKey: string }[] = [];
  await page.route('**/api/cart/confirm', async route => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      await route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR' } } });
      return;
    }
    await route.fulfill({ json: { status: 'added', cartUrl: '/cart', cart: { items: [{ productId: product.id, sku: product.sku, name: product.name, quantity: 1, availableAtConfirmation: 4 }], itemCount: 1, mode: 'demo' } } });
  });
  await send(page, 'Добавь 1 шт. артикул TEST-101');
  await widget(page).getByRole('button', { name: 'Подтвердить и добавить' }).click();
  await expect(widget(page).getByText(/Подтверждение не получено/)).toBeVisible();
  await expect(widget(page).getByRole('textbox')).toBeDisabled();
  await expect(widget(page).getByRole('button', { name: 'Прикрепить файл' })).toBeDisabled();
  await expect(widget(page).getByRole('button', { name: 'Подготовить добавление' })).toBeDisabled();
  const proposal = widget(page).getByRole('region', { name: 'Подтвердить и добавить' });
  await expect(proposal.getByRole('spinbutton')).toBeDisabled();
  await expect(proposal.getByRole('button', { name: 'Отменить' })).toBeDisabled();
  await page.clock.fastForward(65_000);
  await widget(page).getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(widget(page).getByText(/Товар добавлен/)).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(calls.chat).toHaveLength(1);
});

for (const width of [320, 390]) test(`mobile ${width}px keeps chat, cards and confirmation within viewport`, async ({ page }) => {
  await page.setViewportSize({ width, height: 740 });
  await server(page);
  await send(page, 'Добавь 1 шт. артикул TEST-101');
  await widget(page).getByRole('button', { name: 'Подтвердить и добавить' }).scrollIntoViewIfNeeded();
  const bounds = await widget(page).getByRole('dialog').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  const overflow = await widget(page).getByRole('dialog').evaluate(el => el.scrollWidth > el.clientWidth + 1);
  expect(overflow).toBe(false);
  await expect(widget(page).getByRole('textbox')).toBeVisible();
});
