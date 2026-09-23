import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CatalogIndex, ingestCatalogPages } from '../src/catalogIndex.js';
import { createEktListPageReader, runCatalogSync } from '../src/catalogSync.js';
import { loadCatalogSnapshot, saveCatalogSnapshot } from '../src/catalogSnapshot.js';

test('snapshot round trip is private, atomic, and retains a stalled resume cursor', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hackalem-index-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'catalog-index.json');
  const first = await ingestCatalogPages(new CatalogIndex(), async (page) => ({
    page, per_page: 1, count: 5, items: [{ id: 1, article: 'SYN-1', name: 'Синтетический товар' }],
  }), { maxPages: 2 });
  assert.equal(first.index.coverage.stalledAtPage, 2);
  await saveCatalogSnapshot(first.index, path);
  const loaded = await loadCatalogSnapshot(path);
  assert.equal(loaded.coverage.nextPage, 2);
  assert.equal(loaded.coverage.stalledAtPage, 2);
  assert.equal(loaded.findExactSku('SYN-1')[0]?.id, '1');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['catalog-index.json']);
  const body = await readFile(path, 'utf8');
  assert.doesNotMatch(body, /password|Authorization|Basic /);
  await writeFile(path, '{corrupt', 'utf8');
  await assert.rejects(loadCatalogSnapshot(path), /CATALOG_SNAPSHOT_INVALID/);
});

test('page reader permits only approved HTTPS list GET with bounded per_page', async () => {
  const calls: Array<{ url: string; method: string | undefined; redirect: RequestRedirect | undefined; auth: string | null }> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), method: init?.method, redirect: init?.redirect,
      auth: headers.get('Authorization') });
    return new Response(JSON.stringify({ page: 17, per_page: 200, count: 1, items: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const reader = createEktListPageReader({
    baseUrl: 'https://ekt.kz/api', username: 'synthetic-user', password: 'synthetic-password',
    fetcher: fakeFetch,
  });
  assert.deepEqual(await reader(17), { page: 17, per_page: 200, count: 1, items: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ekt.kz/api/products?page=17&per_page=200');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].redirect, 'error');
  assert.match(calls[0].auth ?? '', /^Basic /);
  await assert.rejects(reader(0), /CATALOG_SYNC_INVALID_PAGE/);
  for (const baseUrl of ['http://ekt.kz/api', 'https://example.com/api', 'https://ekt.kz/other']) {
    assert.throws(() => createEktListPageReader({ baseUrl, username: 'u', password: 'p', fetcher: fakeFetch }),
      /CATALOG_SYNC_INVALID_CONFIG/);
  }
});

test('CLI refuses to run without explicit authorized flag before reading environment or network', async () => {
  await assert.rejects(runCatalogSync([]), /CATALOG_SYNC_AUTHORIZATION_REQUIRED/);
  await assert.rejects(runCatalogSync(['--authorized', '--max-pages=101']), /CATALOG_SYNC_INVALID_ARGUMENTS/);
});
