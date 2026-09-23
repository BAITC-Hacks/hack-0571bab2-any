import sharp from 'sharp';

/**
 * Customer photo intake only. This module neither recognizes products nor
 * mutates a cart. externalProcessingAllowed must come from trusted server
 * configuration, never from a client-provided form field.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;
export const MAX_IMAGE_PIXELS = 8_000_000;
export const MAX_VISION_DIMENSION = 2048;

export type ImageInput = { buffer: Buffer; filename: string; mimeType: string };
export type ImageGate = { customerConsented: boolean; externalProcessingAllowed: boolean };
export type ImageFormat = 'jpeg' | 'png';
export type PreparedImage = {
  status: 'ready_for_vision';
  format: ImageFormat;
  width: number;
  height: number;
  /** Re-encoding strips source metadata; this does not imply it was present. */
  metadataRemoved: true;
  sanitizedBytes: number;
  /** Pixel-decoded, re-encoded bytes exist only after both gates pass. */
  image: { buffer: Buffer; mimeType: 'image/jpeg' | 'image/png' };
  candidates: [];
  requiresCatalogVerification: true;
  warning: string;
} | {
  status: 'manual_review';
  reason: 'CUSTOMER_CONSENT_REQUIRED' | 'EXTERNAL_PROCESSING_NOT_ALLOWED';
  format: ImageFormat;
  width: number;
  height: number;
  metadataRemoved: true;
  sanitizedBytes: number;
  candidates: [];
  requiresCatalogVerification: true;
  warning: string;
};

export class ImageInputError extends Error {
  constructor(
    readonly statusCode: 400 | 413 | 415,
    readonly code: 'EMPTY_IMAGE' | 'IMAGE_TOO_LARGE' | 'INVALID_IMAGE_NAME' | 'UNSUPPORTED_IMAGE' | 'INVALID_IMAGE',
    message: string,
  ) {
    super(message);
    this.name = 'ImageInputError';
  }
}

const INVALID_IMAGE = 'Изображение повреждено или не соответствует поддерживаемому JPEG/PNG.';

function checkDimensions(width: number | undefined, height: number | undefined): void {
  if (!width || !height || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new ImageInputError(415, 'INVALID_IMAGE', INVALID_IMAGE);
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw new ImageInputError(413, 'IMAGE_TOO_LARGE', 'Разрешение изображения превышает допустимый предел.');
  }
}

function formatOf(input: ImageInput): ImageFormat {
  if (!Buffer.isBuffer(input.buffer) || input.buffer.length === 0) {
    throw new ImageInputError(400, 'EMPTY_IMAGE', 'Фотография не передана или файл пуст.');
  }
  if (input.buffer.length > MAX_IMAGE_BYTES) {
    throw new ImageInputError(413, 'IMAGE_TOO_LARGE', 'Размер фотографии превышает 2 МБ.');
  }
  if (typeof input.filename !== 'string' || input.filename.length < 1 || input.filename.length > 255 ||
      /[\\/\x00-\x1f\x7f]/u.test(input.filename)) {
    throw new ImageInputError(400, 'INVALID_IMAGE_NAME', 'Некорректное имя фотографии.');
  }
  const extension = input.filename.match(/\.([^.]+)$/u)?.[1]?.toLowerCase();
  const mime = typeof input.mimeType === 'string' ? input.mimeType.split(';', 1)[0]!.trim().toLowerCase() : '';
  if ((extension === 'jpg' || extension === 'jpeg') && mime === 'image/jpeg') return 'jpeg';
  if (extension === 'png' && mime === 'image/png') return 'png';
  throw new ImageInputError(415, 'UNSUPPORTED_IMAGE', 'Поддерживаются только фотографии JPEG и PNG.');
}

/**
 * Full decode and re-encode is required: matching headers or JPEG markers are
 * insufficient to establish that a photo contains decodable pixels. Sharp's
 * default output drops EXIF/GPS/XMP/ICC metadata and converts to sRGB.
 */
export async function prepareCustomerImage(input: ImageInput, gate: ImageGate): Promise<PreparedImage> {
  const format = formatOf(input);
  let sourceWidth: number;
  let sourceHeight: number;
  try {
    // Metadata inspection reads headers only. The pixel cap is enforced before
    // the separate full decode below, allowing a clear 413 for huge dimensions.
    const metadata = await sharp(input.buffer, { failOn: 'warning', limitInputPixels: false, animated: false }).metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1) {
      throw new ImageInputError(415, 'INVALID_IMAGE', INVALID_IMAGE);
    }
    checkDimensions(metadata.width, metadata.height);
    sourceWidth = metadata.width!;
    sourceHeight = metadata.height!;
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    throw new ImageInputError(415, 'INVALID_IMAGE', INVALID_IMAGE);
  }

  let normalized: Buffer;
  let width: number;
  let height: number;
  try {
    const pipeline = sharp(input.buffer, {
      failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS, animated: false,
    }).autoOrient().resize({
      width: MAX_VISION_DIMENSION, height: MAX_VISION_DIMENSION,
      fit: 'inside', withoutEnlargement: true,
    });
    const encoded = format === 'jpeg'
      ? await pipeline.jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true })
      : await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    normalized = encoded.data;
    width = encoded.info.width;
    height = encoded.info.height;
  } catch {
    throw new ImageInputError(415, 'INVALID_IMAGE', INVALID_IMAGE);
  }
  if (normalized.length > MAX_IMAGE_BYTES) {
    throw new ImageInputError(413, 'IMAGE_TOO_LARGE', 'Обработанная фотография превышает 2 МБ.');
  }
  if (width < 1 || height < 1 || width > MAX_VISION_DIMENSION || height > MAX_VISION_DIMENSION ||
      !sourceWidth || !sourceHeight) {
    throw new ImageInputError(415, 'INVALID_IMAGE', INVALID_IMAGE);
  }
  const common = {
    format, width, height, metadataRemoved: true as const,
    sanitizedBytes: normalized.length, candidates: [] as [],
    requiresCatalogVerification: true as const,
  };
  if (gate.customerConsented !== true) {
    return { ...common, status: 'manual_review', reason: 'CUSTOMER_CONSENT_REQUIRED',
      warning: 'Для анализа фотографии нужно отдельное согласие клиента. Укажите артикул или параметры товара текстом.' };
  }
  if (gate.externalProcessingAllowed !== true) {
    return { ...common, status: 'manual_review', reason: 'EXTERNAL_PROCESSING_NOT_ALLOWED',
      warning: 'Внешний анализ фотографии пока не разрешён. Укажите артикул или параметры товара текстом.' };
  }
  return {
    ...common, status: 'ready_for_vision',
    image: { buffer: normalized, mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' },
    warning: 'Фото подготовлено, но ещё не распознано. Любые предложенные по фото товары нужно сверить с каталогом.',
  };
}
