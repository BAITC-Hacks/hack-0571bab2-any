import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogIndex, type CatalogIndexCoverage, type CatalogIndexRecord } from './catalogIndex.js';

/** Kept out of Git by apps/api/.local/ in the repository .gitignore. */
export const DEFAULT_CATALOG_SNAPSHOT_PATH = fileURLToPath(new URL('../.local/catalog-index.json', import.meta.url));

const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 80_000_000;
const MAX_SNAPSHOT_RECORDS = 200_000;

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validCoverage(value: unknown): value is CatalogIndexCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return validCount(data.nextPage) && (data.nextPage as number) >= 1
    && validCount(data.pagesRead) && validCount(data.rowsSeen)
    && validCount(data.invalidRows) && validCount(data.duplicateIds)
    && typeof data.endObserved === 'boolean'
    && (data.stalledAtPage === null
      || (validCount(data.stalledAtPage) && (data.stalledAtPage as number) >= 1));
}

/** Loads only a local, size-bounded snapshot. Missing files yield an empty index. */
export async function loadCatalogSnapshot(filePath = DEFAULT_CATALOG_SNAPSHOT_PATH): Promise<CatalogIndex> {
  if (!isAbsolute(filePath)) throw new Error('CATALOG_SNAPSHOT_INVALID_PATH');
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new CatalogIndex();
    throw new Error('CATALOG_SNAPSHOT_READ_FAILED');
  }
  if (size > MAX_SNAPSHOT_BYTES) throw new Error('CATALOG_SNAPSHOT_TOO_LARGE');
  try {
    const bytes = await readFile(filePath);
    if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('CATALOG_SNAPSHOT_TOO_LARGE');
    const data: unknown = JSON.parse(bytes.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    const snapshot = data as Record<string, unknown>;
    if (snapshot.version !== SNAPSHOT_VERSION || !validCoverage(snapshot.coverage)
      || !Array.isArray(snapshot.records) || snapshot.records.length > MAX_SNAPSHOT_RECORDS) throw new Error();
    return new CatalogIndex(snapshot.records as CatalogIndexRecord[], snapshot.coverage);
  } catch (error) {
    if (error instanceof Error && error.message === 'CATALOG_SNAPSHOT_TOO_LARGE') throw error;
    throw new Error('CATALOG_SNAPSHOT_INVALID');
  }
}

/** Writes a private replacement in the same directory, then atomically renames it. */
export async function saveCatalogSnapshot(index: CatalogIndex, filePath = DEFAULT_CATALOG_SNAPSHOT_PATH): Promise<void> {
  if (!isAbsolute(filePath)) throw new Error('CATALOG_SNAPSHOT_INVALID_PATH');
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  const body = JSON.stringify({ version: SNAPSHOT_VERSION, coverage: index.coverage, records: index.records() });
  if (Buffer.byteLength(body, 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error('CATALOG_SNAPSHOT_TOO_LARGE');
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  } catch {
    throw new Error('CATALOG_SNAPSHOT_WRITE_FAILED');
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
