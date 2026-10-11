/**
 * Format detection from file bytes. The declared MIME type of a document was
 * verified against the storage object's `Content-Type` in Phase 2, but that
 * header is still client-declared: the OCR pipeline only trusts the bytes.
 */

export type DetectedFormat = 'pdf' | 'jpeg' | 'png' | 'webp';

export interface ImageDimensions {
  width: number;
  height: number;
}

export const FORMAT_MIME_TYPES: Record<DetectedFormat, string> = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Bytes needed to detect the format and read image dimensions. */
export const SIGNATURE_PROBE_BYTES = 64 * 1024;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function detectFormat(head: Buffer): DetectedFormat | null {
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'pdf';
  }
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'png';
  }
  if (
    head.length >= 3 &&
    head[0] === 0xff &&
    head[1] === 0xd8 &&
    head[2] === 0xff
  ) {
    return 'jpeg';
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/**
 * Reads the pixel dimensions from the image header, or `null` when the header
 * is malformed. Used to refuse oversized images before any decoder runs.
 */
export function readImageDimensions(
  format: Exclude<DetectedFormat, 'pdf'>,
  head: Buffer,
): ImageDimensions | null {
  switch (format) {
    case 'png':
      return pngDimensions(head);
    case 'jpeg':
      return jpegDimensions(head);
    case 'webp':
      return webpDimensions(head);
  }
}

function pngDimensions(head: Buffer): ImageDimensions | null {
  // IHDR is always the first chunk: length(4) type(4) width(4) height(4).
  if (head.length < 24) return null;
  if (head.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  return valid(width, height);
}

function jpegDimensions(head: Buffer): ImageDimensions | null {
  let offset = 2;
  while (offset + 9 <= head.length) {
    if (head[offset] !== 0xff) return null;
    const marker = head[offset + 1];
    // Padding bytes between segments are allowed.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers without a length field.
    if (
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before SOF
    const length = head.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      const height = head.readUInt16BE(offset + 5);
      const width = head.readUInt16BE(offset + 7);
      return valid(width, height);
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(head: Buffer): ImageDimensions | null {
  if (head.length < 30) return null;
  const chunk = head.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8 ') {
    // Lossy: frame tag (3) + start code (3) + 14-bit width/height at 26.
    if (head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a)
      return null;
    const width = head.readUInt16LE(26) & 0x3fff;
    const height = head.readUInt16LE(28) & 0x3fff;
    return valid(width, height);
  }
  if (chunk === 'VP8L') {
    if (head[20] !== 0x2f) return null;
    const bits = head.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return valid(width, height);
  }
  if (chunk === 'VP8X') {
    const width = (head.readUIntLE(24, 3) & 0xffffff) + 1;
    const height = (head.readUIntLE(27, 3) & 0xffffff) + 1;
    return valid(width, height);
  }
  return null;
}

function valid(width: number, height: number): ImageDimensions | null {
  return width > 0 && height > 0 ? { width, height } : null;
}
