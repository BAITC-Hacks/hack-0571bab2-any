import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Local, bounded extraction. The results are suggestions, never catalog facts. */
export type DocumentKind = 'pdf' | 'docx' | 'xlsx';
export type DocumentCandidate = {
  sku: string;
  quantity: number;
  confidence: 'low' | 'medium' | 'high';
};
export type DocumentExtraction = { candidates: DocumentCandidate[]; warning: string };

export class DocumentExtractionError extends Error {
  constructor(
    readonly statusCode: 413 | 415,
    readonly code: 'DOCUMENT_TOO_COMPLEX' | 'INVALID_DOCUMENT',
    message: string,
  ) {
    super(message);
    this.name = 'DocumentExtractionError';
  }
}

const MAX_INPUT = 2 * 1024 * 1024;
const MAX_PDF_PAGES = 5;
const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_UNCOMPRESSED = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 128;
const MAX_TEXT_CHARS = 64 * 1024;
const MAX_ROWS = 1000;
const MAX_CELLS = 10_000;
const MAX_CANDIDATES = 20;

function invalid(): never {
  throw new DocumentExtractionError(415, 'INVALID_DOCUMENT', 'Содержимое документа повреждено или не поддерживается.');
}

function tooComplex(): never {
  throw new DocumentExtractionError(413, 'DOCUMENT_TOO_COMPLEX', 'Документ превышает допустимый предел страниц, строк или распаковки.');
}

function checkedInput(buffer: Buffer): void {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) invalid();
  if (buffer.length > MAX_INPUT) tooComplex();
}

type ZipEntry = { name: string; method: number; crc: number; compressed: number; uncompressed: number; offset: number };

function u16(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > buffer.length) invalid();
  return buffer.readUInt16LE(offset);
}

function u32(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) invalid();
  return buffer.readUInt32LE(offset);
}

function readZipDirectory(buffer: Buffer): Map<string, ZipEntry> {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (u32(buffer, offset) === 0x06054b50 && offset + 22 + u16(buffer, offset + 20) === buffer.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || u16(buffer, eocd + 4) !== 0 || u16(buffer, eocd + 6) !== 0) invalid();
  const count = u16(buffer, eocd + 10);
  if (count !== u16(buffer, eocd + 8) || count === 0 || count === 0xffff) invalid();
  if (count > MAX_ZIP_ENTRIES) tooComplex();
  const centralSize = u32(buffer, eocd + 12);
  const centralOffset = u32(buffer, eocd + 16);
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff || centralOffset + centralSize > eocd) invalid();

  const entries = new Map<string, ZipEntry>();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > centralOffset + centralSize || u32(buffer, cursor) !== 0x02014b50) invalid();
    const flags = u16(buffer, cursor + 8);
    const method = u16(buffer, cursor + 10);
    const crc = u32(buffer, cursor + 16);
    const compressed = u32(buffer, cursor + 20);
    const uncompressed = u32(buffer, cursor + 24);
    const nameLength = u16(buffer, cursor + 28);
    const extraLength = u16(buffer, cursor + 30);
    const commentLength = u16(buffer, cursor + 32);
    const disk = u16(buffer, cursor + 34);
    const offset = u32(buffer, cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize || nameLength === 0 || disk !== 0 || offset === 0xffffffff ||
        compressed === 0xffffffff || uncompressed === 0xffffffff || (flags & 0x1) ||
        (method !== 0 && method !== 8)) invalid();
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      invalid();
    }
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => part === '..' || part === '.') ||
        name.includes('\0') || entries.has(name)) invalid();
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED) tooComplex();
    entries.set(name, { name, method, crc, compressed, uncompressed, offset });
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) invalid();
  return entries;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.offset;
  if (offset + 30 > buffer.length || u32(buffer, offset) !== 0x04034b50 ||
      u16(buffer, offset + 8) !== entry.method || (u16(buffer, offset + 6) & 0x1)) invalid();
  const nameLength = u16(buffer, offset + 26);
  const extraLength = u16(buffer, offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  if (start + entry.compressed > buffer.length ||
      !buffer.subarray(offset + 30, offset + 30 + nameLength).equals(Buffer.from(entry.name))) invalid();
  const compressed = buffer.subarray(start, start + entry.compressed);
  let plain: Buffer;
  try {
    plain = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: entry.uncompressed + 1 });
  } catch {
    invalid();
  }
  if (plain.length !== entry.uncompressed || crc32(plain) !== entry.crc) invalid();
  return plain;
}

function readXml(buffer: Buffer, entries: Map<string, ZipEntry>, name: string, optional = false): string | null {
  const entry = entries.get(name);
  if (!entry) return optional ? null : invalid();
  if (entry.uncompressed > MAX_XML_BYTES) tooComplex();
  const bytes = readZipEntry(buffer, entry);
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { invalid(); }
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) invalid();
  return xml;
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, (entity) => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (named[entity]) return named[entity];
    const hex = entity.startsWith('&#x');
    const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function xmlText(xml: string, tag: 'w:t' | 't'): string {
  const pattern = tag === 'w:t' ? /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu : /<t\b[^>]*>([\s\S]*?)<\/t>/gu;
  let result = '';
  for (const match of xml.matchAll(pattern)) {
    result += decodeXml(match[1]!);
    if (result.length > MAX_TEXT_CHARS) tooComplex();
  }
  return result.trim();
}

function normalizeSku(raw: string, labelled = false): string | null {
  const sku = raw.trim().toUpperCase();
  if (sku.length < 3 || sku.length > 64 || !/^[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ0-9][A-ZА-ЯЁӘҒҚҢӨҰҮҺІ0-9._/-]*$/u.test(sku)) return null;
  if (!/\d/u.test(sku) || (!labelled && /^\d+$/u.test(sku))) return null;
  return sku;
}

function quantity(raw: string): number | null {
  const match = raw.trim().match(/^(\d{1,4})(?:\s*(?:шт\.?|штук|дана|pcs))?$/iu);
  const value = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(value) && value >= 1 && value <= 1000 ? value : null;
}

function lineCandidate(line: string): DocumentCandidate | null {
  const trimmed = line.trim();
  // A valid SKU, label and quantity fit well below this bound. Avoid running
  // nested optional whitespace patterns over a long untrusted paragraph.
  if (trimmed.length > 256) return null;
  const labelled = trimmed.match(/^(?:артикул|sku|article|тауар(?:дың)?\s+(?:коды|артикулы)|өнім(?:нің)?\s+(?:коды|артикулы))\s*[:№#]?\s*([A-ZА-ЯЁӘҒҚҢӨҰҮҺІ0-9._/-]+)\s+(?:(?:количество|кол-во|qty|quantity|саны|дана\s+саны|тауар\s+саны|өнім\s+саны)\s*[:=]?\s*)?(\d{1,4}(?:\s*(?:шт\.?|штук|дана|pcs))?)$/iu);
  const plain = labelled ? null : trimmed.match(/^([A-ZА-ЯЁӘҒҚҢӨҰҮҺІ0-9._/-]+)\s+(\d{1,4}(?:\s*(?:шт\.?|штук|дана|pcs))?)$/iu);
  const match = labelled || plain;
  if (!match) return null;
  const sku = normalizeSku(match[1]!, Boolean(labelled));
  const count = quantity(match[2]!);
  return sku && count ? { sku, quantity: count, confidence: labelled ? 'medium' : 'low' } : null;
}

function candidateRows(rows: string[][]): DocumentCandidate[] {
  const found: DocumentCandidate[] = [];
  let skuColumn = -1;
  let quantityColumn = -1;
  let allowPositionalRows = true;
  for (const row of rows) {
    const cells = row.map((cell) => cell.length > 512 ? '' : cell.trim());
    const skuHeader = cells.findIndex((cell) => /^(?:артикул|sku|article|тауар(?:дың)?\s+(?:коды|артикулы)|өнім(?:нің)?\s+(?:коды|артикулы))$/iu.test(cell));
    const qtyHeader = cells.findIndex((cell) => /^(?:количество|кол-во|qty|quantity|саны|дана\s+саны|тауар\s+саны|өнім\s+саны)$/iu.test(cell));
    const priceHeader = cells.some((cell) => /^(?:цена|стоимость|price|баға(?:сы)?|құны)$/iu.test(cell));
    if (skuHeader >= 0 && qtyHeader >= 0 && skuHeader !== qtyHeader) {
      skuColumn = skuHeader;
      quantityColumn = qtyHeader;
      continue;
    }
    if (skuHeader >= 0 || qtyHeader >= 0 || priceHeader) {
      // A partial header must not turn an adjacent price into a guessed quantity.
      skuColumn = -1;
      quantityColumn = -1;
      allowPositionalRows = false;
      continue;
    }
    let candidate: DocumentCandidate | null = null;
    if (skuColumn >= 0 && quantityColumn >= 0) {
      const sku = normalizeSku(cells[skuColumn] || '', true);
      const count = quantity(cells[quantityColumn] || '');
      if (sku && count) candidate = { sku, quantity: count, confidence: 'high' };
    } else if (allowPositionalRows && cells.filter(Boolean).length === 2) {
      const nonempty = cells.filter(Boolean);
      const sku = normalizeSku(nonempty[0]!);
      const count = quantity(nonempty[1]!);
      // Without a quantity header, a bare integer could be a price.
      if (sku && count && /(?:шт\.?|штук|дана|pcs)\s*$/iu.test(nonempty[1]!)) {
        candidate = { sku, quantity: count, confidence: 'low' };
      }
    } else if (cells.length === 1) {
      candidate = lineCandidate(cells[0]!);
    }
    if (candidate) found.push(candidate);
    if (found.length > MAX_CANDIDATES) tooComplex();
  }
  return found;
}

function deduplicate(candidates: DocumentCandidate[]): DocumentCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.sku}\u0000${candidate.quantity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractDocx(buffer: Buffer): DocumentCandidate[] {
  const entries = readZipDirectory(buffer);
  readXml(buffer, entries, '[Content_Types].xml');
  const xml = readXml(buffer, entries, 'word/document.xml')!;
  if (!/<w:document\b/u.test(xml) || !/<w:body\b/u.test(xml) ||
      !/<\/w:body>/u.test(xml) || !/<\/w:document>/u.test(xml)) invalid();
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gu)) {
    const cells = [...row[1]!.matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gu)].map((cell) => xmlText(cell[1]!, 'w:t'));
    rows.push(cells);
    if (rows.length > MAX_ROWS || cells.length > MAX_CELLS) tooComplex();
  }
  const tableCandidates = candidateRows(rows);
  const paragraphs: string[][] = [];
  for (const paragraph of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gu)) {
    paragraphs.push([xmlText(paragraph[1]!, 'w:t')]);
    if (paragraphs.length > MAX_ROWS) tooComplex();
  }
  return deduplicate([...tableCandidates, ...candidateRows(paragraphs)]);
}

function attribute(openingTag: string, name: string): string | null {
  const match = openingTag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'u'));
  return match?.[1] || null;
}

function extractXlsx(buffer: Buffer): DocumentCandidate[] {
  const entries = readZipDirectory(buffer);
  readXml(buffer, entries, '[Content_Types].xml');
  const workbook = readXml(buffer, entries, 'xl/workbook.xml')!;
  if (!/<workbook\b/u.test(workbook) || !/<\/workbook>/u.test(workbook)) invalid();
  const worksheetNames = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)).sort();
  if (worksheetNames.length === 0) invalid();
  if (worksheetNames.length > 3) tooComplex();
  const sharedXml = readXml(buffer, entries, 'xl/sharedStrings.xml', true);
  const shared: string[] = [];
  if (sharedXml) {
    for (const item of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)) {
      shared.push(xmlText(item[1]!, 't'));
      if (shared.length > MAX_CELLS) tooComplex();
    }
  }
  let rowCount = 0;
  let cellCount = 0;
  const candidates: DocumentCandidate[] = [];
  for (const name of worksheetNames) {
    const xml = readXml(buffer, entries, name)!;
    if (!/<worksheet\b/u.test(xml) || !/<\/worksheet>/u.test(xml)) invalid();
    const rows: string[][] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)) {
      rowCount++;
      if (rowCount > MAX_ROWS) tooComplex();
      const cells: string[] = [];
      for (const cell of row[1]!.matchAll(/(<c\b[^>]*>)([\s\S]*?)<\/c>/gu)) {
        cellCount++;
        if (cellCount > MAX_CELLS) tooComplex();
        const coordinate = attribute(cell[1]!, 'r');
        let column = cells.length;
        if (coordinate) {
          const letters = coordinate.match(/^[A-Z]{1,3}/u)?.[0];
          if (!letters) invalid();
          column = [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
        }
        if (column > 127) tooComplex();
        const type = attribute(cell[1]!, 't');
        if (/<f\b/u.test(cell[2]!)) { cells[column] = ''; continue; }
        if (type === 'inlineStr') { cells[column] = xmlText(cell[2]!, 't'); continue; }
        const value = cell[2]!.match(/<v\b[^>]*>([\s\S]*?)<\/v>/u)?.[1] || '';
        if (type === 's') {
          const index = Number(value);
          if (!Number.isSafeInteger(index) || index < 0 || index >= shared.length) invalid();
          cells[column] = shared[index]!;
        } else {
          cells[column] = decodeXml(value);
        }
      }
      rows.push(cells);
    }
    candidates.push(...candidateRows(rows));
    if (candidates.length > MAX_CANDIDATES) tooComplex();
  }
  return deduplicate(candidates);
}

async function extractPdf(buffer: Buffer): Promise<DocumentCandidate[]> {
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') invalid();
  const task = getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
    standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)),
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void task.destroy().catch(() => {});
  }, 4000);
  timeout.unref();
  try {
    const document = await task.promise;
    if (document.numPages < 1) invalid();
    if (document.numPages > MAX_PDF_PAGES) tooComplex();
    const rows: string[][] = [];
    let totalText = 0;
    let totalItems = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let line = '';
      let lineY: number | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        totalItems++;
        if (totalItems > 20_000) tooComplex();
        totalText += item.str.length;
        if (totalText > MAX_TEXT_CHARS) tooComplex();
        const itemY = item.transform[5];
        if (line && lineY !== null && Math.abs(itemY - lineY) > 2) {
          rows.push([line.trim()]);
          line = '';
        }
        line += item.str + ' ';
        lineY = itemY;
        if (item.hasEOL) { rows.push([line.trim()]); line = ''; lineY = null; }
        if (rows.length > MAX_ROWS) tooComplex();
      }
      if (line.trim()) rows.push([line.trim()]);
      page.cleanup();
    }
    return deduplicate(candidateRows(rows));
  } catch (error) {
    if (timedOut) return tooComplex();
    if (error instanceof DocumentExtractionError) throw error;
    return invalid();
  } finally {
    clearTimeout(timeout);
    try { await task.destroy(); } catch { /* Parsing errors are mapped above. */ }
  }
}

export async function extractDocumentCandidates(
  kind: DocumentKind, buffer: Buffer, locale: 'ru' | 'kk' = 'ru',
): Promise<DocumentExtraction> {
  checkedInput(buffer);
  const candidates = kind === 'pdf' ? await extractPdf(buffer) : kind === 'docx' ? extractDocx(buffer) : extractXlsx(buffer);
  return {
    candidates,
    warning: locale === 'kk'
      ? candidates.length
        ? 'Артикулдар мен сандар ықтимал дерек ретінде алынды. Әр позицияны каталогпен тексеріп, бөлек растаңыз; себет өзгерген жоқ.'
        : 'Нақты саны көрсетілген артикулдар табылмады. Құжатты тексеріп, позицияларды қолмен енгізіңіз; себет өзгерген жоқ.'
      : candidates.length
        ? 'Артикулы и количества извлечены как кандидаты. Проверьте их по каталогу и подтвердите каждую позицию отдельно; корзина не изменена.'
        : 'Подходящие артикулы с явным количеством не найдены. Проверьте документ и введите позиции вручную; корзина не изменена.',
  };
}
