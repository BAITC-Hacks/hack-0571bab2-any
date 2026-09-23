import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { prepareCustomerImage, ImageInputError, MAX_IMAGE_BYTES } from '../src/imageInput.js';

// Two synthetic 2x2 blue images. No partner or customer data is in these fixtures.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlKKKK+vPlT//Z', 'base64');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGMUSdnyn4GBgYEJRIAwACBIAi9YoxP3AAAAAElFTkSuQmCC', 'base64');
const allowed = { customerConsented: true, externalProcessingAllowed: true };

async function expectError(code: string, fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (error: unknown) => error instanceof ImageInputError && error.code === code);
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), payload]);
  const result = Buffer.alloc(12 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), result.length - 4);
  return result;
}

test('JPEG strips EXIF/GPS and comments before vision, and never asserts a product match', async () => {
  const exif = Buffer.from('Exif\0\0GPS-location-private');
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif]);
  const comment = Buffer.from('private customer comment');
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0, comment.length + 2]), comment]);
  const withMetadata = Buffer.concat([jpeg.subarray(0, 2), app1, com, jpeg.subarray(2)]);
  const result = await prepareCustomerImage({ buffer: withMetadata, filename: 'panel.JPG', mimeType: 'image/jpeg' }, allowed);
  assert.equal(result.status, 'ready_for_vision');
  assert.deepEqual([result.width, result.height, result.format], [2, 2, 'jpeg']);
  assert.equal(result.metadataRemoved, true);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.requiresCatalogVerification, true);
  if (result.status !== 'ready_for_vision') return;
  assert.equal(result.image.mimeType, 'image/jpeg');
  assert.equal(result.image.buffer.includes(exif), false);
  assert.equal(result.image.buffer.includes(comment), false);
  assert.ok(result.image.buffer.length < withMetadata.length);
  assert.deepEqual(result.image.buffer.subarray(-2), Buffer.from([0xff, 0xd9]));
  assert.deepEqual(await sharp(result.image.buffer).raw().toBuffer(), await sharp(jpeg).raw().toBuffer());
});

test('JPEG bytes are never returned when customer consent or partner permission is absent', async () => {
  const input = { buffer: jpeg, filename: 'part.jpeg', mimeType: 'image/jpeg' };
  const noConsent = await prepareCustomerImage(input, { customerConsented: false, externalProcessingAllowed: true });
  assert.equal(noConsent.status, 'manual_review');
  if (noConsent.status !== 'manual_review') return;
  assert.equal(noConsent.reason, 'CUSTOMER_CONSENT_REQUIRED');
  assert.equal('image' in noConsent, false);
  const noPermission = await prepareCustomerImage(input, { customerConsented: true, externalProcessingAllowed: false });
  assert.equal(noPermission.status, 'manual_review');
  if (noPermission.status !== 'manual_review') return;
  assert.equal(noPermission.reason, 'EXTERNAL_PROCESSING_NOT_ALLOWED');
  assert.equal('image' in noPermission, false);
  const malformed = { buffer: Buffer.from('not decoded'), filename: 'broken.jpg', mimeType: 'image/jpeg' };
  assert.equal((await prepareCustomerImage(malformed, { customerConsented: false,
    externalProcessingAllowed: true })).status, 'manual_review');
  await expectError('INVALID_IMAGE', () => prepareCustomerImage(malformed, allowed));
});

test('PNG re-encodes pixels and strips text/location chunks', async () => {
  const text = pngChunk('tEXt', Buffer.from('GPS\0private coordinates'));
  const withMetadata = Buffer.concat([png.subarray(0, 33), text, png.subarray(33)]);
  const result = await prepareCustomerImage({ buffer: withMetadata, filename: 'room.png', mimeType: 'image/png' }, allowed);
  assert.equal(result.status, 'ready_for_vision');
  assert.deepEqual([result.width, result.height, result.format], [2, 2, 'png']);
  assert.equal(result.metadataRemoved, true);
  if (result.status !== 'ready_for_vision') return;
  assert.equal(result.image.buffer.includes(Buffer.from('private coordinates')), false);
  assert.deepEqual(await sharp(result.image.buffer).raw().toBuffer(), await sharp(png).raw().toBuffer());
});

test('type, size and filename checks reject misleading or excessive uploads', async () => {
  await expectError('INVALID_IMAGE', () => prepareCustomerImage({ buffer: jpeg, filename: 'photo.png', mimeType: 'image/png' }, allowed));
  await expectError('UNSUPPORTED_IMAGE', () => prepareCustomerImage({ buffer: jpeg, filename: 'photo.gif', mimeType: 'image/gif' }, allowed));
  await expectError('INVALID_IMAGE', () => prepareCustomerImage({ buffer: png, filename: 'photo.jpg', mimeType: 'image/jpeg' }, allowed));
  await expectError('INVALID_IMAGE_NAME', () => prepareCustomerImage({ buffer: jpeg, filename: '../photo.jpg', mimeType: 'image/jpeg' }, allowed));
  await expectError('IMAGE_TOO_LARGE', () => prepareCustomerImage({ buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1), filename: 'huge.jpg', mimeType: 'image/jpeg' }, allowed));
  await expectError('EMPTY_IMAGE', () => prepareCustomerImage({ buffer: Buffer.alloc(0), filename: 'empty.jpg', mimeType: 'image/jpeg' }, allowed));
});

test('fake JPEG headers and malformed payloads do not produce bytes for a model', async () => {
  const fakeJpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xdb, 0, 3, 0,
    0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
    0xff, 0xc4, 0, 3, 0,
    0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0,
    0xff, 0xd9,
  ]);
  await expectError('INVALID_IMAGE', () => prepareCustomerImage({ buffer: fakeJpeg, filename: 'fake.jpg', mimeType: 'image/jpeg' }, allowed));
  await expectError('INVALID_IMAGE', () => prepareCustomerImage({ buffer: jpeg.subarray(0, -2), filename: 'cut.jpg', mimeType: 'image/jpeg' }, allowed));
  const brokenPng = Buffer.from(png);
  brokenPng[32] ^= 1; // corrupt IHDR CRC
  await expectError('INVALID_IMAGE', () => prepareCustomerImage({ buffer: brokenPng, filename: 'crc.png', mimeType: 'image/png' }, allowed));
});

test('dimensions are bounded and extra compressed payload is not forwarded', async () => {
  const largeHeader = Buffer.from(png.subarray(16, 29));
  largeHeader.writeUInt32BE(5000, 0);
  const tooWide = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', largeHeader), png.subarray(33)]);
  await expectError('IMAGE_TOO_LARGE', () => prepareCustomerImage({ buffer: tooWide, filename: 'wide.png', mimeType: 'image/png' }, allowed));
  const smallHeader = Buffer.from(png.subarray(16, 29));
  smallHeader.writeUInt32BE(1, 0);
  smallHeader.writeUInt32BE(1, 4);
  const fakeDimensions = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', smallHeader), png.subarray(33)]);
  const normalized = await prepareCustomerImage({ buffer: fakeDimensions, filename: 'extra.png', mimeType: 'image/png' }, allowed);
  assert.equal(normalized.status, 'ready_for_vision');
  if (normalized.status !== 'ready_for_vision') return;
  assert.deepEqual([normalized.width, normalized.height], [1, 1]);
  assert.deepEqual(await sharp(normalized.image.buffer).metadata().then(({ width, height }) => [width, height]), [1, 1]);
  assert.equal(normalized.image.buffer.equals(fakeDimensions), false);
});
