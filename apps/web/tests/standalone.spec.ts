import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('standalone production widget mounts without Vite and isolates host styles', async ({ page }) => {
  const bundle = await readFile(new URL('../dist-widget/ekt-assistant.js', import.meta.url), 'utf8');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/standalone-widget.js', route => route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: bundle }));
  await page.route('**/api/health', route => route.fulfill({ json: { ok: true, catalog: 'demo', model: 'fallback' } }));
  await page.route('**/api/cart', route => route.fulfill({ json: { items: [], itemCount: 0, cartUrl: '/cart', mode: 'demo', csrfToken: 'synthetic-csrf' } }));
  await page.route('**/standalone-host', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>button{display:none!important}section{position:static!important;color:red!important}textarea{width:3000px!important}</style></head><body><h1>Host page</h1><script src="/standalone-widget.js"></script><script>EktAssistant.mount({apiBase:'/api',locale:'ru'});</script></body></html>` }));
  await page.goto('/standalone-host');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => typeof process)).toBe('undefined');
  const widget = page.locator('#ekt-ai-widget');
  await widget.getByRole('button', { name: 'ИИ-помощник', exact: true }).click();
  await expect(widget.getByRole('dialog')).toBeVisible();
  await expect(widget.getByRole('dialog')).toHaveCSS('position', 'fixed');
  await expect(widget.getByRole('textbox')).toBeVisible();
  expect(errors).toEqual([]);
});
