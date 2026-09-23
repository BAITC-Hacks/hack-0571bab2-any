import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AttachmentError,
  extractAttachmentCandidates,
  MAX_ATTACHMENT_BYTES,
  type AttachmentInput,
} from '../src/attachments.js';
import { buildApp } from '../src/server.js';
import { createDemoCatalog } from '../src/catalog.js';

const sampleFiles: AttachmentInput[] = [
  { filename: 'list.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nABC-123 2') },
  {
    filename: 'list.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x41, 0x42, 0x43]),
  },
  {
    filename: 'list.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x41, 0x42, 0x43]),
  },
  { filename: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]) },
];

function syntheticPdf(line: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

test('supported formats return no invented candidates and an explicit manual-review warning', async () => {
  for (const file of sampleFiles) {
    const result = await extractAttachmentCandidates(file);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.requiresManualReview, true);
    assert.match(result.warning, /вручную/);
    if (file.filename.endsWith('.jpg')) {
      assert.equal(result.declaredType, 'jpeg');
      assert.match(result.warning, /OCR отключён/);
    } else {
      assert.match(result.warning, /не проверено/);
    }
  }
});

test('oversize and empty input fail before any parsing', async () => {
  await assert.rejects(
    extractAttachmentCandidates({ ...sampleFiles[0], buffer: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) }),
    (error: unknown) => error instanceof AttachmentError && error.statusCode === 413 && error.code === 'FILE_TOO_LARGE',
  );
  await assert.rejects(
    extractAttachmentCandidates({ ...sampleFiles[0], buffer: Buffer.alloc(0) }),
    (error: unknown) => error instanceof AttachmentError && error.statusCode === 400 && error.code === 'EMPTY_FILE',
  );
});

test('extension, MIME, and signature must agree', async () => {
  const invalid: AttachmentInput[] = [
    { ...sampleFiles[0], filename: 'list.exe' },
    { ...sampleFiles[0], mimeType: 'image/jpeg' },
    { ...sampleFiles[0], buffer: Buffer.from('not a PDF') },
    { ...sampleFiles[1], buffer: Buffer.from('not a ZIP') },
    { ...sampleFiles[3], buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
  ];
  for (const file of invalid) {
    await assert.rejects(
      extractAttachmentCandidates(file),
      (error: unknown) => error instanceof AttachmentError && error.statusCode === 415 && error.code === 'UNSUPPORTED_FILE',
    );
  }
});

test('unsafe or missing filenames are rejected', async () => {
  for (const filename of ['', '../list.pdf', 'folder\\list.pdf', 'list\u0000.pdf']) {
    await assert.rejects(
      extractAttachmentCandidates({ ...sampleFiles[0], filename }),
      (error: unknown) => error instanceof AttachmentError && error.statusCode === 400 && error.code === 'INVALID_FILENAME',
    );
  }
});

test('multipart PDF extracts a candidate and fresh product without changing the cart', async (t) => {
  const app = buildApp({ catalog: createDemoCatalog(), apiOrigin: 'http://api.test' });
  t.after(() => app.close());
  const first = await app.inject({ method: 'GET', url: '/api/cart', headers: { host: 'api.test' } });
  const cookie = String(first.headers['set-cookie']).split(';')[0];
  const csrf = first.json().csrfToken as string;
  const boundary = 'hackalem-test-boundary';
  const upload = async (content: Buffer, locale: 'ru' | 'kk' = 'ru') => app.inject({
    method: 'POST', url: '/api/attachments',
    headers: { host: 'api.test', origin: 'http://api.test', cookie, 'x-csrf-token': csrf,
      'x-attachment-locale': locale,
      'content-type': 'multipart/form-data; boundary=' + boundary },
    payload: Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="list.pdf"\r\nContent-Type: application/pdf\r\n\r\n'),
      content,
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]),
  });
  const accepted = await upload(syntheticPdf('ABC-123 2'));
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json().candidates, [{ sku: 'ABC-123', quantity: 2, confidence: 'low' }]);
  assert.equal(accepted.json().products[0].sku, 'ABC-123');
  assert.equal(accepted.json().cartChanged, false);
  assert.equal(accepted.json().requiresManualReview, true);
  assert.match(accepted.json().warning, /корзина не изменена/);
  assert.equal((await app.inject({ method: 'GET', url: '/api/cart', headers: { host: 'api.test', cookie } })).json().itemCount, 0);

  const acceptedKk = await upload(syntheticPdf('ABC-123 2'), 'kk');
  assert.equal(acceptedKk.statusCode, 200);
  assert.deepEqual(acceptedKk.json().candidates, accepted.json().candidates);
  assert.match(acceptedKk.json().warning, /себет өзгерген жоқ/u);
  assert.equal(acceptedKk.json().cartChanged, false);

  const rejected = await upload(Buffer.from('not a PDF'));
  assert.equal(rejected.statusCode, 415);
  assert.equal(rejected.json().error.code, 'UNSUPPORTED_FILE');

  const damaged = await upload(Buffer.from('%PDF-1.7\nABC-123 2'));
  assert.equal(damaged.statusCode, 415);
  assert.equal(damaged.json().error.code, 'INVALID_DOCUMENT');

  const damagedKk = await upload(Buffer.from('%PDF-1.7\nABC-123 2'), 'kk');
  assert.equal(damagedKk.statusCode, 415);
  assert.equal(damagedKk.json().error.code, 'INVALID_DOCUMENT');
  assert.match(damagedKk.json().error.message, /Құжат бүлінген/u);

  const tooLarge = await upload(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0));
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.json().error.code, 'PAYLOAD_TOO_LARGE');
});
