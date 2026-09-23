import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import {
  DocumentExtractionError,
  extractDocumentCandidates,
} from '../src/documentExtraction.js';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: Record<string, string>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const raw = Buffer.from(content);
    const compressed = deflateRawSync(raw);
    const checksum = crc32(raw);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(filename.length, 26);
    local.push(localHeader, filename, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(filename.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, filename);
    offset += localHeader.length + filename.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, eocd]);
}

function pdf(text: string): Buffer {
  const escaped = text.replace(/[\\()]/gu, (character) => `\\${character}`);
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

const types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

test('extracts candidate SKU and explicit quantity from text PDF', async () => {
  const result = await extractDocumentCandidates('pdf', pdf('ABC-123 2'));
  assert.deepEqual(result.candidates, [{ sku: 'ABC-123', quantity: 2, confidence: 'low' }]);
  assert.match(result.warning, /корзина не изменена/u);

  const kazakh = await extractDocumentCandidates('pdf', pdf('ABC-123 2'), 'kk');
  assert.deepEqual(kazakh.candidates, result.candidates);
  assert.match(kazakh.warning, /Әр позицияны каталогпен тексеріп/u);
  assert.match(kazakh.warning, /себет өзгерген жоқ/u);
});

test('extracts header-mapped DOCX table and labelled paragraph without guessing quantity', async () => {
  const document = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Артикул</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>Количество</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>ABC-123</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:p><w:r><w:t>SKU DEF-456 qty 3</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>NOQTY-789</w:t></w:r></w:p></w:body></w:document>';
  const result = await extractDocumentCandidates('docx', zip({
    '[Content_Types].xml': types,
    'word/document.xml': document,
  }));
  assert.deepEqual(result.candidates, [
    { sku: 'ABC-123', quantity: 2, confidence: 'high' },
    { sku: 'DEF-456', quantity: 3, confidence: 'medium' },
  ]);
});

test('extracts XLSX shared-string table and ignores formulas', async () => {
  const result = await extractDocumentCandidates('xlsx', zip({
    '[Content_Types].xml': types,
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="List" sheetId="1"/></sheets></workbook>',
    'xl/sharedStrings.xml': '<sst><si><t>Артикул</t></si><si><t>Количество</t></si><si><t>ABC-123</t></si><si><t>DEF-456</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>2</v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><f>1+2</f><v>3</v></c></row>' +
      '</sheetData></worksheet>',
  }));
  assert.deepEqual(result.candidates, [{ sku: 'ABC-123', quantity: 2, confidence: 'high' }]);
});

test('XLSX uses cell coordinates so sparse columns cannot shift the quantity', async () => {
  const result = await extractDocumentCandidates('xlsx', zip({
    '[Content_Types].xml': types,
    'xl/workbook.xml': '<workbook><sheets><sheet name="List" sheetId="1"/></sheets></workbook>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Артикул</t></is></c>' +
      '<c r="C1" t="inlineStr"><is><t>Количество</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>ABC-123</t></is></c><c r="B2"><v>199</v></c><c r="C2"><v>2</v></c></row>' +
      '</sheetData></worksheet>',
  }));
  assert.deepEqual(result.candidates, [{ sku: 'ABC-123', quantity: 2, confidence: 'high' }]);
});

test('rejects malformed ZIP and limits compressed expansion before parsing', async () => {
  await assert.rejects(
    extractDocumentCandidates('docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])),
    (error: unknown) => error instanceof DocumentExtractionError && error.statusCode === 415,
  );
  const bomb = zip({
    '[Content_Types].xml': types,
    'word/document.xml': '<w:document><w:body>' + ' '.repeat(9 * 1024 * 1024) + '</w:body></w:document>',
  });
  assert.ok(bomb.length < 2 * 1024 * 1024);
  await assert.rejects(
    extractDocumentCandidates('docx', bomb),
    (error: unknown) => error instanceof DocumentExtractionError && error.statusCode === 413,
  );
});

test('does not infer quantity from price or standalone SKU', async () => {
  const document = '<w:document><w:body><w:tbl>' +
    '<w:tr><w:tc><w:p><w:t>ABC-123</w:t></w:p></w:tc><w:tc><w:p><w:t>19.95</w:t></w:p></w:tc><w:tc><w:p><w:t>2</w:t></w:p></w:tc></w:tr>' +
    '</w:tbl><w:p><w:t>DEF-456</w:t></w:p></w:body></w:document>';
  const result = await extractDocumentCandidates('docx', zip({ '[Content_Types].xml': types, 'word/document.xml': document }));
  assert.deepEqual(result.candidates, []);
  assert.match(result.warning, /введите позиции вручную/u);

  const kazakh = await extractDocumentCandidates('docx', zip({ '[Content_Types].xml': types,
    'word/document.xml': document }), 'kk');
  assert.deepEqual(kazakh.candidates, []);
  assert.match(kazakh.warning, /қолмен енгізіңіз/u);
  assert.match(kazakh.warning, /себет өзгерген жоқ/u);
});
