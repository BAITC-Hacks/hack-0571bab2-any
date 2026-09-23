import { expect, test, type Page } from '@playwright/test';

const widget = (page: Page) => page.locator('#ekt-ai-widget');
async function start(page: Page) {
  await page.goto('/');
  const health = await page.request.get('/api/health');
  expect(health.ok()).toBe(true);
  expect((await health.json()).catalog).toBe('demo');
  await widget(page).getByRole('button', { name: 'ИИ-помощник', exact: true }).click();
}
async function cart(page: Page) {
  const response = await page.request.get('/api/cart');
  expect(response.ok()).toBe(true);
  return response.json();
}
async function chat(page: Page, message: string, locale: 'ru' | 'kk' = 'ru') {
  await widget(page).locator('.composer textarea').fill(message);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/chat') && response.request().method() === 'POST');
  await widget(page).getByRole('button', { name: locale === 'ru' ? 'Отправить' : 'Жіберу', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON().locale).toBe(locale);
  await expect(widget(page).locator('.composer textarea')).toBeEnabled();
  return response.json();
}

test('real API: catalog, analog, terms, separate confirmation and actual session cart', async ({ page }) => {
  await start(page);
  const facts = await chat(page, 'Есть ли ABC-123?');
  expect(facts.products[0].stock.available).toBe(4);
  await expect(widget(page).getByText('Остаток: 4 шт.')).toBeVisible();
  await expect(widget(page).getByText('10 А', { exact: true })).toBeVisible();
  await expect(widget(page).getByText('Сертификат не предоставлен')).toBeVisible();
  await expect(widget(page).getByText('Цена не указана в каталоге')).toBeVisible();
  const analog = await chat(page, 'ABC-000');
  expect(analog.products[0].stock.available).toBe(0);
  expect(analog.analogs[0].product.sku).toBe('ABC-124');
  await expect(widget(page).locator('.analog-card').getByText(/совпадают/)).toBeVisible();
  const terms = await chat(page, 'Какие условия оплаты, доставки и минимальная партия?');
  expect(terms.factsSource).toBe('partner_policy');
  await expect(widget(page).getByRole('link', { name: 'Источник' })).toHaveAttribute('href', 'https://ekt.kz/checkout-delivery/');
  expect(terms.reply).toMatch(/минимальн/iu);
  const offer = await chat(page, 'Добавь 2 шт. артикул ABC-123');
  expect(offer.proposal.items).toEqual([{ productId: 'demo-1', quantity: 2 }]);
  expect((await cart(page)).itemCount).toBe(0);
  await expect(widget(page).getByRole('region', { name: 'Подтвердить и добавить' }).getByText('Корзина пока не изменена')).toBeVisible();
  const confirmed = page.waitForResponse(response => response.url().endsWith('/api/cart/confirm'));
  await widget(page).getByRole('button', { name: 'Подтвердить и добавить', exact: true }).click();
  expect((await confirmed).status()).toBe(200);
  expect((await cart(page)).items[0].quantity).toBe(2);
  await widget(page).getByRole('link', { name: /Открыть актуальную корзину/ }).click();
  await expect(page.locator('.cart-item')).toContainText('ABC-123');
  await expect(page.locator('.cart-item b')).toHaveText('2 шт.');
});

test('real API: mobile Kazakh quantity and stock bound', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await start(page);
  await widget(page).getByRole('button', { name: 'ҚАЗ', exact: true }).click();
  const overstock = await chat(page, 'Артикул ABC-123, себетке 5 дана қос', 'kk');
  expect(overstock.proposal).toBeNull();
  expect((await cart(page)).itemCount).toBe(0);
  const offer = await chat(page, 'Артикул ABC-123, себетке 2 дана қос', 'kk');
  expect(offer.proposal.items[0].quantity).toBe(2);
  const dialog = widget(page).getByRole('dialog');
  expect(await dialog.evaluate(el => el.scrollWidth > el.clientWidth + 1)).toBe(false);
  await expect(widget(page).locator('.composer textarea')).toBeVisible();
  expect((await cart(page)).itemCount).toBe(0);
  await widget(page).getByRole('button', { name: 'Растау және қосу', exact: true }).click();
  await widget(page).getByRole('link', { name: /Ағымдағы себетті ашу/ }).click();
  await expect(page.locator('.cart-item b')).toHaveText('2 дана');
  await expect(page.locator('main')).toHaveAttribute('lang', 'kk');
});

test('real API: editing one quantity preserves and confirms both proposed items', async ({ page }) => {
  await start(page);
  const offered = await chat(page, 'Добавь 2 шт. артикул ABC-123; 1 шт. артикул ABC-124');
  expect(offered.proposal.items).toEqual([{ productId: 'demo-1', quantity: 2 }, { productId: 'demo-2', quantity: 1 }]);
  const proposal = widget(page).getByRole('region', { name: 'Подтвердить и добавить' });
  await expect(proposal.getByRole('spinbutton', { name: 'Количество: ABC-123', exact: true })).toHaveValue('2');
  await proposal.getByRole('spinbutton', { name: 'Количество: ABC-124', exact: true }).fill('2');
  await expect(proposal.getByRole('button', { name: 'Подтвердить и добавить', exact: true })).toHaveCount(0);
  const updated = page.waitForResponse(response => response.url().endsWith('/api/chat') && response.request().method() === 'POST');
  await proposal.getByRole('button', { name: 'Проверить новое количество', exact: true }).click();
  const response = await updated;
  expect(response.status()).toBe(200);
  expect((await response.json()).proposal.items).toEqual([{ productId: 'demo-1', quantity: 2 }, { productId: 'demo-2', quantity: 2 }]);
  await expect(proposal.getByRole('spinbutton', { name: 'Количество: ABC-123', exact: true })).toHaveValue('2');
  await expect(proposal.getByRole('spinbutton', { name: 'Количество: ABC-124', exact: true })).toHaveValue('2');
  expect((await cart(page)).itemCount).toBe(0);
  await proposal.getByRole('button', { name: 'Подтвердить и добавить', exact: true }).click();
  await expect(widget(page).getByRole('link', { name: /Открыть актуальную корзину/ })).toBeVisible();
  const snapshot = await cart(page);
  expect(snapshot.itemCount).toBe(4);
  expect(snapshot.items.map((item: { sku: string; quantity: number }) => ({ sku: item.sku, quantity: item.quantity }))).toEqual([
    { sku: 'ABC-123', quantity: 2 }, { sku: 'ABC-124', quantity: 2 },
  ]);
});

function syntheticPdf() {
  const stream = 'BT /F1 12 Tf 72 720 Td (ABC-123 2) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach(offset => { body += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  return Buffer.from(body + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('real API: PNG consent gate, PDF review, then explicit cart confirmation', async ({ page }) => {
  await start(page);
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9X0AAAAASUVORK5CYII=', 'base64');
  await widget(page).locator('input[type=file]').setInputFiles({ name: 'synthetic-pixel.png', mimeType: 'image/png', buffer: tinyPng });
  await expect(widget(page).getByRole('checkbox')).not.toBeChecked();
  const photoUploaded = page.waitForResponse(response => response.url().endsWith('/api/attachments'));
  await widget(page).getByRole('button', { name: 'Проверить файл', exact: true }).click();
  const photoResponse = await photoUploaded;
  expect(photoResponse.status()).toBe(200);
  expect((await photoResponse.json()).photoAnalysis).toMatchObject({ status: 'manual_review', reason: 'CUSTOMER_CONSENT_REQUIRED' });
  expect((await cart(page)).itemCount).toBe(0);
  await widget(page).locator('input[type=file]').setInputFiles({ name: 'synthetic-order.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  const uploaded = page.waitForResponse(response => response.url().endsWith('/api/attachments'));
  await widget(page).getByRole('button', { name: 'Проверить файл', exact: true }).click();
  const response = await uploaded;
  expect(response.status()).toBe(200);
  expect((await response.json()).candidates[0]).toMatchObject({ sku: 'ABC-123', quantity: 2 });
  const review = widget(page).locator('.file-review').last();
  await expect(review.getByRole('button', { name: 'Проверить позицию' })).toBeDisabled();
  expect((await cart(page)).itemCount).toBe(0);
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Проверить позицию' }).click();
  await expect(widget(page).getByRole('button', { name: 'Подтвердить и добавить', exact: true })).toBeEnabled();
  expect((await cart(page)).itemCount).toBe(0);
  await widget(page).getByRole('button', { name: 'Подтвердить и добавить', exact: true }).click();
  await expect(widget(page).getByRole('link', { name: /Открыть актуальную корзину/ })).toBeVisible();
  expect((await cart(page)).items[0].quantity).toBe(2);
});
