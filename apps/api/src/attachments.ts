/** Attachment intake only. No document parsing, OCR, catalog lookup, or cart writes. */

export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

export type AttachmentCandidate = {
  sku: string;
  quantity: number;
  confidence: 'low' | 'medium' | 'high';
};

export type AttachmentKind = 'pdf' | 'docx' | 'xlsx' | 'jpeg';

export type AttachmentInput = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
};

export type AttachmentResult = {
  candidates: AttachmentCandidate[];
  warning: string;
  requiresManualReview: true;
  declaredType: AttachmentKind;
};

export class AttachmentError extends Error {
  constructor(
    readonly statusCode: 400 | 413 | 415,
    readonly code: 'EMPTY_FILE' | 'FILE_TOO_LARGE' | 'INVALID_FILENAME' | 'UNSUPPORTED_FILE',
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

const allowed: Record<AttachmentKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpeg: 'image/jpeg',
};

function hasExpectedSignature(kind: AttachmentKind, buffer: Buffer): boolean {
  if (kind === 'pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (kind === 'docx' || kind === 'xlsx') {
    // These formats are ZIP containers. This is only a signature check; no
    // compressed content is read, decompressed, or treated as a valid document.
    return buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  }
  return buffer.length >= 5
    && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
}

export async function extractAttachmentCandidates(input: AttachmentInput): Promise<AttachmentResult> {
  if (!Buffer.isBuffer(input.buffer) || input.buffer.length === 0) {
    throw new AttachmentError(400, 'EMPTY_FILE', 'Файл пуст или не передан.');
  }
  if (input.buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(413, 'FILE_TOO_LARGE', 'Размер файла превышает 2 МБ.');
  }
  if (typeof input.filename !== 'string' || input.filename.length === 0 || input.filename.length > 255 ||
      /[\\/\x00-\x1f\x7f]/u.test(input.filename)) {
    throw new AttachmentError(400, 'INVALID_FILENAME', 'Некорректное имя файла.');
  }

  const extension = input.filename.match(/\.([^.]+)$/u)?.[1]?.toLowerCase();
  const kind = extension === 'jpg' ? 'jpeg' : extension;
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.split(';', 1)[0].trim().toLowerCase() : '';
  if (!(kind === 'pdf' || kind === 'docx' || kind === 'xlsx' || kind === 'jpeg') ||
      mimeType !== allowed[kind] || !hasExpectedSignature(kind, input.buffer)) {
    throw new AttachmentError(415, 'UNSUPPORTED_FILE', 'Формат файла не поддерживается или не соответствует содержимому.');
  }

  const warning = kind === 'jpeg'
    ? 'JPEG имеет ожидаемую сигнатуру, но OCR отключён: фото не анализировалось. Введите артикул и количество вручную.'
    : 'Расширение, MIME и сигнатура совпадают, но содержимое документа не проверено и извлечение текста/таблиц не включено. Артикулы и количества не определены; введите их вручную.';
  return { candidates: [], warning, requiresManualReview: true, declaredType: kind };
}
