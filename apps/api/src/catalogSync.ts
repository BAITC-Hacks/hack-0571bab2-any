import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { ingestCatalogPages, type CatalogPageReader } from './catalogIndex.js';
import {
  DEFAULT_CATALOG_SNAPSHOT_PATH, loadCatalogSnapshot, saveCatalogSnapshot,
} from './catalogSnapshot.js';

const PAGE_SIZE = 200;
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_CLI_PAGES = 100;

export function createEktListPageReader(config: {
  baseUrl: string;
  username: string;
  password: string;
  fetcher?: typeof fetch;
}): CatalogPageReader {
  let origin: URL;
  try {
    origin = new URL(config.baseUrl);
    if (origin.protocol !== 'https:' || !['ekt.kz', 'www.ekt.kz'].includes(origin.hostname)
      || !['/api', '/api/'].includes(origin.pathname) || origin.port
      || origin.username || origin.password || origin.search || origin.hash
      || !config.username || !config.password || config.username.length > 512 || config.password.length > 512) {
      throw new Error();
    }
  } catch {
    throw new Error('CATALOG_SYNC_INVALID_CONFIG');
  }
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;
  const fetcher = config.fetcher ?? fetch;

  return async (page: number): Promise<unknown> => {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('CATALOG_SYNC_INVALID_PAGE');
    const url = new URL('/api/products', origin);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(PAGE_SIZE));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers: { Authorization: authorization, Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) throw new Error('CATALOG_SYNC_ACCESS_DENIED');
      if (response.status === 429) throw new Error('CATALOG_SYNC_RATE_LIMITED');
      if (!response.ok || !response.body) throw new Error('CATALOG_SYNC_FETCH_FAILED');
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new Error('CATALOG_SYNC_RESPONSE_TOO_LARGE');
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('CATALOG_SYNC_RESPONSE_TOO_LARGE');
        }
        chunks.push(value);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      } catch {
        throw new Error('CATALOG_SYNC_INVALID_JSON');
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error('CATALOG_SYNC_TIMEOUT');
      if (error instanceof Error && /^CATALOG_SYNC_[A-Z_]+$/.test(error.message)) throw error;
      throw new Error('CATALOG_SYNC_FETCH_FAILED');
    } finally {
      clearTimeout(timer);
    }
  };
}

function parseArgs(argv: string[]): number {
  if (!argv.includes('--authorized')) throw new Error('CATALOG_SYNC_AUTHORIZATION_REQUIRED');
  const other = argv.filter((arg) => arg !== '--authorized');
  if (other.length > 1 || (other.length === 1 && !/^--max-pages=\d+$/.test(other[0]))) {
    throw new Error('CATALOG_SYNC_INVALID_ARGUMENTS');
  }
  const pages = other.length ? Number(other[0].slice('--max-pages='.length)) : 20;
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > MAX_CLI_PAGES) {
    throw new Error('CATALOG_SYNC_INVALID_ARGUMENTS');
  }
  return pages;
}

function assertSnapshotIgnored(): void {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', DEFAULT_CATALOG_SNAPSHOT_PATH], {
      cwd: dirname(dirname(DEFAULT_CATALOG_SNAPSHOT_PATH)), stdio: 'ignore',
    });
  } catch {
    throw new Error('CATALOG_SYNC_SNAPSHOT_NOT_IGNORED');
  }
}

export async function runCatalogSync(argv: string[]): Promise<void> {
  const maxPages = parseArgs(argv);
  assertSnapshotIgnored();
  loadEnv({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
  const readPage = createEktListPageReader({
    baseUrl: process.env.EKT_API_BASE_URL ?? '',
    username: process.env.EKT_API_USERNAME ?? '',
    password: process.env.EKT_API_PASSWORD ?? '',
  });
  let index = await loadCatalogSnapshot();
  let fetched = 0;
  let entryCapReached = false;
  while (fetched < maxPages && !index.coverage.endObserved && !entryCapReached) {
    const result = await ingestCatalogPages(index, readPage, {
      maxPages: Math.min(2, maxPages - fetched), concurrency: 2, maxEntries: 200_000,
    });
    index = result.index;
    fetched += result.pagesFetched;
    entryCapReached = result.entryCapReached;
    await saveCatalogSnapshot(index);
    if (index.coverage.stalledAtPage !== null || result.pagesFetched === 0) break;
    if (fetched < maxPages && !index.coverage.endObserved) {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  // Counts only. Never log credentials, product rows, URLs, or customer data.
  process.stdout.write(JSON.stringify({
    pagesFetched: fetched, indexed: index.size, nextPage: index.coverage.nextPage,
    endObserved: index.coverage.endObserved, stalledAtPage: index.coverage.stalledAtPage,
    entryCapReached,
  }) + '\n');
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entrypoint) {
  runCatalogSync(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof Error && /^(CATALOG_SYNC|CATALOG_INDEX|CATALOG_SNAPSHOT)_[A-Z_]+$/.test(error.message)
      ? error.message : 'CATALOG_SYNC_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
