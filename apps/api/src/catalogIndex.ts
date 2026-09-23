/**
 * An optional, bounded index of catalog *list* rows. It is not a source of
 * stock, prices, certificates, or compatibility facts: callers must read the
 * current detail for every candidate before using it in a reply or cart.
 * The confirmed list API does not guarantee a category field. Category
 * filtering works only for rows that explicitly supply one (or are enriched
 * from a verified source); a missing category is never inferred from a name.
 *
 * The page reader is injected so this module never contacts the partner API
 * on its own. Only run a broad sync after permission and rate limits are
 * confirmed with the catalog owner.
 */
export type CatalogIndexRecord = Readonly<{
  id: string;
  sku: string;
  name: string;
  category: string | null;
}>;

export type CatalogIndexCoverage = Readonly<{
  nextPage: number;
  pagesRead: number;
  rowsSeen: number;
  invalidRows: number;
  duplicateIds: number;
  /** An empty page was observed; this is not proof of full coverage. */
  endObserved: boolean;
}>;

export type CatalogPageReader = (page: number) => Promise<unknown>;

export type IndexSearchOptions = {
  limit?: number;
  match?: 'all' | 'any';
  categories?: string[];
};

export type CatalogIndexSyncOptions = {
  /** At most this many pages in one run. Hard cap: 25. */
  maxPages?: number;
  /** At most this many simultaneous read-only page requests. Hard cap: 3. */
  concurrency?: number;
  /** Total retained unique records. Hard cap: 200,000. */
  maxEntries?: number;
};

export type CatalogIndexSyncResult = Readonly<{
  index: CatalogIndex;
  pagesFetched: number;
  entryCapReached: boolean;
}>;

const MAX_PAGES = 25;
const MAX_CONCURRENCY = 3;
const MAX_ENTRIES = 200_000;
const MAX_ITEMS_PER_PAGE = 500;
const MAX_QUERY_LENGTH = 200;
const MAX_QUERY_TOKENS = 12;
const MAX_RESULTS = 20;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return clean ? clean : null;
}

function skuKey(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleUpperCase('ru');
}

function categoryKey(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru');
}

function tokens(value: string): string[] {
  return [...new Set(value.normalize('NFKC').toLocaleLowerCase('ru').match(/[\p{L}\p{N}]+/gu) ?? [])];
}

function normalizeRow(value: unknown): CatalogIndexRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id >= 0
    ? String(row.id) : text(row.id);
  const sku = text(row.article);
  const name = text(row.name);
  if (!id || !sku || !name) return null;
  return Object.freeze({
    id,
    sku,
    name,
    category: text(row.category) ?? text(row.category_name),
  });
}

function parsePage(value: unknown, expectedPage: number): { rows: unknown[]; empty: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CATALOG_INDEX_INVALID_PAGE');
  const page = value as Record<string, unknown>;
  if (page.page !== expectedPage || !Number.isSafeInteger(page.per_page)
    || (page.per_page as number) < 1 || (page.per_page as number) > MAX_ITEMS_PER_PAGE
    || !Number.isSafeInteger(page.count) || (page.count as number) < 0
    || !Array.isArray(page.items) || page.items.length > (page.per_page as number)) {
    throw new Error('CATALOG_INDEX_INVALID_PAGE');
  }
  return { rows: page.items, empty: page.items.length === 0 };
}

function addToMap(map: Map<string, Set<string>>, key: string, id: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

/** Immutable search view. Search returns list candidates, never product facts. */
export class CatalogIndex {
  readonly coverage: CatalogIndexCoverage;
  readonly size: number;
  private readonly byId: ReadonlyMap<string, CatalogIndexRecord>;
  private readonly bySku: ReadonlyMap<string, Set<string>>;
  private readonly byToken: ReadonlyMap<string, Set<string>>;
  private readonly byCategory: ReadonlyMap<string, Set<string>>;

  constructor(records: Iterable<CatalogIndexRecord> = [], coverage: CatalogIndexCoverage = {
    nextPage: 1, pagesRead: 0, rowsSeen: 0, invalidRows: 0, duplicateIds: 0, endObserved: false,
  }) {
    const byId = new Map<string, CatalogIndexRecord>();
    const bySku = new Map<string, Set<string>>();
    const byToken = new Map<string, Set<string>>();
    const byCategory = new Map<string, Set<string>>();
    for (const record of records) {
      if (byId.has(record.id)) throw new Error('CATALOG_INDEX_DUPLICATE_ID');
      const safe = normalizeRow({ id: record.id, article: record.sku, name: record.name, category: record.category });
      if (!safe) throw new Error('CATALOG_INDEX_INVALID_RECORD');
      byId.set(safe.id, safe);
      addToMap(bySku, skuKey(safe.sku), safe.id);
      if (safe.category) addToMap(byCategory, categoryKey(safe.category), safe.id);
      for (const token of tokens(`${safe.sku} ${safe.name} ${safe.category ?? ''}`)) {
        addToMap(byToken, token, safe.id);
      }
    }
    this.byId = byId;
    this.bySku = bySku;
    this.byToken = byToken;
    this.byCategory = byCategory;
    this.size = byId.size;
    this.coverage = Object.freeze({ ...coverage });
  }

  records(): CatalogIndexRecord[] {
    return [...this.byId.values()];
  }

  /** All matching IDs are returned, because one article can map to multiple products. */
  findExactSku(sku: string): CatalogIndexRecord[] {
    const ids = this.bySku.get(skuKey(sku));
    if (!ids) return [];
    return [...ids].map((id) => this.byId.get(id)!).sort((a, b) => a.id.localeCompare(b.id));
  }

  search(query: string, options: IndexSearchOptions = {}): CatalogIndexRecord[] {
    if (query.length > MAX_QUERY_LENGTH) throw new Error('CATALOG_INDEX_QUERY_TOO_LONG');
    const words = tokens(query);
    if (!words.length) return [];
    if (words.length > MAX_QUERY_TOKENS) throw new Error('CATALOG_INDEX_QUERY_TOO_LONG');
    const limit = options.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new Error('CATALOG_INDEX_INVALID_LIMIT');
    if (options.match && options.match !== 'all' && options.match !== 'any') throw new Error('CATALOG_INDEX_INVALID_MATCH');
    if (options.categories && options.categories.length > 8) throw new Error('CATALOG_INDEX_TOO_MANY_CATEGORIES');

    let categoryIds: Set<string> | null = null;
    if (options.categories?.length) {
      categoryIds = new Set();
      for (const category of options.categories) {
        for (const id of this.byCategory.get(categoryKey(category)) ?? []) categoryIds.add(id);
      }
    }
    const postings = words.map((word) => this.byToken.get(word) ?? new Set<string>());
    if (options.match !== 'any' && postings.some((set) => set.size === 0)) return [];
    const candidateIds = options.match === 'any'
      ? new Set(postings.flatMap((set) => [...set]))
      : new Set([...postings.reduce((smallest, set) => set.size < smallest.size ? set : smallest)].filter(
        (id) => postings.every((set) => set.has(id)),
      ));
    const scored: Array<{ record: CatalogIndexRecord; score: number }> = [];
    for (const id of candidateIds) {
      if (categoryIds && !categoryIds.has(id)) continue;
      const record = this.byId.get(id)!;
      const score = postings.reduce((sum, set) => sum + (set.has(id) ? 1 : 0), 0)
        + (skuKey(query) === skuKey(record.sku) ? 10 : 0);
      scored.push({ record, score });
    }
    scored.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
    return scored.slice(0, limit).map(({ record }) => record);
  }
}

function boundedOption(value: number | undefined, fallback: number, max: number): number {
  const option = value ?? fallback;
  if (!Number.isSafeInteger(option) || option < 1 || option > max) throw new Error('CATALOG_INDEX_INVALID_OPTION');
  return option;
}

/**
 * Incrementally ingest a small, explicit page budget. A failed read or invalid
 * page leaves the previous index untouched. `endObserved` only reports the
 * pagination signal; it never certifies that every product was indexed.
 */
export async function ingestCatalogPages(
  previous: CatalogIndex,
  readPage: CatalogPageReader,
  options: CatalogIndexSyncOptions = {},
): Promise<CatalogIndexSyncResult> {
  const maxPages = boundedOption(options.maxPages, 10, MAX_PAGES);
  const concurrency = boundedOption(options.concurrency, 2, MAX_CONCURRENCY);
  const maxEntries = boundedOption(options.maxEntries, 50_000, MAX_ENTRIES);
  if (previous.size > maxEntries) throw new Error('CATALOG_INDEX_ENTRY_CAP');
  if (previous.coverage.endObserved) return { index: previous, pagesFetched: 0, entryCapReached: false };

  const byId = new Map(previous.records().map((record) => [record.id, record]));
  let nextPage = previous.coverage.nextPage;
  let pagesRead = previous.coverage.pagesRead;
  let rowsSeen = previous.coverage.rowsSeen;
  let invalidRows = previous.coverage.invalidRows;
  let duplicateIds = previous.coverage.duplicateIds;
  let endObserved = false;
  let pagesFetched = 0;
  let entryCapReached = false;

  while (pagesFetched < maxPages && !endObserved && !entryCapReached) {
    const batchSize = Math.min(concurrency, maxPages - pagesFetched);
    const pageNumbers = Array.from({ length: batchSize }, (_, index) => nextPage + index);
    const rawPages = await Promise.all(pageNumbers.map(readPage));
    pagesFetched += batchSize;
    for (let index = 0; index < rawPages.length; index++) {
      const pageNumber = pageNumbers[index];
      const { rows, empty } = parsePage(rawPages[index], pageNumber);
      const additions = new Map<string, CatalogIndexRecord>();
      let pageInvalid = 0;
      let pageDuplicate = 0;
      for (const raw of rows) {
        const record = normalizeRow(raw);
        if (!record) { pageInvalid++; continue; }
        if (byId.has(record.id) || additions.has(record.id)) { pageDuplicate++; continue; }
        additions.set(record.id, record);
      }
      if (byId.size + additions.size > maxEntries) {
        entryCapReached = true;
        break; // Retry this whole page with a higher cap; never skip its rows.
      }
      for (const [id, record] of additions) byId.set(id, record);
      pagesRead++;
      rowsSeen += rows.length;
      invalidRows += pageInvalid;
      duplicateIds += pageDuplicate;
      nextPage = pageNumber + 1;
      if (empty) { endObserved = true; break; }
    }
  }

  const coverage: CatalogIndexCoverage = {
    nextPage, pagesRead, rowsSeen, invalidRows, duplicateIds, endObserved,
  };
  return { index: new CatalogIndex(byId.values(), coverage), pagesFetched, entryCapReached };
}
