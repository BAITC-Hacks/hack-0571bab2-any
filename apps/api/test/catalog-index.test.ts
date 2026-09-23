import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogIndex, ingestCatalogPages } from '../src/catalogIndex.js';

function syntheticPage(page: number, perPage: number, total: number) {
  const first = (page - 1) * perPage;
  const items = Array.from({ length: Math.max(0, Math.min(perPage, total - first)) }, (_, offset) => {
    const id = first + offset + 1;
    const category = ['Кабель', 'Автомат', 'Светильник'][id % 3];
    return { id, article: `SYN-${id}`, name: `${category} ${id}`, category };
  });
  return { page, per_page: perPage, count: total, items };
}

test('incrementally indexes 12,000 synthetic products with bounded batches and fast candidate lookup', async () => {
  const requested: number[] = [];
  let active = 0;
  let peak = 0;
  const readPage = async (page: number) => {
    requested.push(page);
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return syntheticPage(page, 200, 12_000);
  };
  let index = new CatalogIndex();
  for (let run = 0; run < 4; run++) {
    const result = await ingestCatalogPages(index, readPage, { maxPages: 20, concurrency: 2, maxEntries: 20_000 });
    assert.ok(result.pagesFetched <= 20);
    index = result.index;
    if (index.coverage.endObserved) break;
  }
  assert.equal(index.size, 12_000);
  assert.equal(index.coverage.endObserved, true);
  assert.ok(peak <= 2);
  assert.equal(requested.length, 62, 'an exact full last page requires an empty page to observe the end');
  assert.deepEqual(index.findExactSku(' syn-11999 ').map((item) => item.id), ['11999']);
  assert.equal(index.search('светильник 11999')[0]?.sku, 'SYN-11999');
  assert.equal(index.search('кабель', { categories: ['Автомат'] }).length, 0);
  assert.equal(index.search('кабель автомат', { match: 'any', limit: 5 }).length, 5);
  assert.ok(!('stock' in index.findExactSku('SYN-1')[0]), 'list candidates cannot supply stock');
});

test('incomplete pages, duplicate articles and bad rows are reported without inventing full coverage', async () => {
  const readPage = async (page: number) => ({ page, per_page: 4, count: 1000, items: [
    { id: page * 10, article: 'SHARED', name: 'Один', category: 'Кабель' },
    { id: page * 10 + 1, article: 'SHARED', name: 'Два', category_name: 'Кабель' },
    { id: page * 10, article: 'DIFFERENT', name: 'Дубликат ID' },
    { id: page * 10 + 3, article: '', name: 'Без артикула' },
  ] });
  const first = await ingestCatalogPages(new CatalogIndex(), readPage, { maxPages: 2 });
  assert.equal(first.index.size, 4);
  assert.equal(first.index.coverage.endObserved, false);
  assert.equal(first.index.coverage.nextPage, 3);
  assert.equal(first.index.coverage.invalidRows, 2);
  assert.equal(first.index.coverage.duplicateIds, 2);
  assert.equal(first.index.findExactSku('shared').length, 4, 'ambiguous SKU must not be silently resolved');
});

test('short intermediate page does not hide products on later pages', async () => {
  const pages = [
    [{ id: 1, article: 'SYN-1', name: 'Кабель 1' }, { id: 2, article: 'SYN-2', name: 'Кабель 2' }],
    [{ id: 3, article: 'SYN-3', name: 'Кабель 3' }],
    [{ id: 4, article: 'SYN-4', name: 'Автомат 4' }, { id: 5, article: 'SYN-5', name: 'Автомат 5' }],
    [],
  ];
  const requested: number[] = [];
  const result = await ingestCatalogPages(new CatalogIndex(), async (page) => {
    requested.push(page);
    return { page, per_page: 2, count: 5, items: pages[page - 1] ?? [] };
  }, { maxPages: 4, concurrency: 2 });
  assert.deepEqual(requested, [1, 2, 3, 4]);
  assert.equal(result.index.size, 5);
  assert.equal(result.index.findExactSku('SYN-5')[0]?.id, '5');
  assert.equal(result.index.coverage.endObserved, true);
});

test('confirmed list shape without category supports name/SKU lookup but no category facet', async () => {
  const result = await ingestCatalogPages(new CatalogIndex(), async (page) => ({
    page, per_page: 20, count: 1,
    items: page === 1 ? [{ id: 17, article: 'ABC-123', name: 'Синтетический автомат', price: 12345 }] : [],
  }), { maxPages: 2 });
  assert.equal(result.index.findExactSku('abc-123')[0]?.category, null);
  assert.equal(result.index.search('автомат')[0]?.id, '17');
  assert.deepEqual(result.index.search('автомат', { categories: ['Автомат'] }), []);
});

test('entry limit preserves page cursor and a failed batch leaves previous index untouched', async () => {
  const readPage = async (page: number) => syntheticPage(page, 2, 10);
  const first = await ingestCatalogPages(new CatalogIndex(), readPage, { maxPages: 2, maxEntries: 3 });
  assert.equal(first.index.size, 2);
  assert.equal(first.index.coverage.nextPage, 2);
  assert.equal(first.entryCapReached, true);
  await assert.rejects(ingestCatalogPages(first.index, async (page) => {
    if (page === 3) throw new Error('synthetic failure');
    return readPage(page);
  }, { maxPages: 2, concurrency: 2, maxEntries: 10 }), /synthetic failure/);
  assert.equal(first.index.size, 2);
  assert.equal(first.index.coverage.nextPage, 2);
  const resumed = await ingestCatalogPages(first.index, readPage, { maxPages: 2, maxEntries: 10 });
  assert.equal(resumed.index.size, 6);
  assert.equal(resumed.index.coverage.nextPage, 4);
});

test('rejects pagination shape drift and overlarge unbounded requests', async () => {
  await assert.rejects(ingestCatalogPages(new CatalogIndex(), async () => ({
    page: 9, per_page: 1, count: 1, items: [],
  })), /CATALOG_INDEX_INVALID_PAGE/);
  await assert.rejects(ingestCatalogPages(new CatalogIndex(), async () => syntheticPage(1, 1, 1), {
    maxPages: 26,
  }), /CATALOG_INDEX_INVALID_OPTION/);
  assert.throws(() => new CatalogIndex().search('a'.repeat(201)), /CATALOG_INDEX_QUERY_TOO_LONG/);
});
