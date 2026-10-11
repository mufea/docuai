import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { detectFormat, readImageDimensions } from './file-signature';

const FIXTURES = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'ocr',
);
const load = (name: string) => readFileSync(path.join(FIXTURES, name));

describe('detectFormat', () => {
  it('detects the four supported formats from their signatures', () => {
    expect(detectFormat(load('text.pdf'))).toBe('pdf');
    expect(detectFormat(load('printed.png'))).toBe('png');
    expect(detectFormat(load('printed.jpg'))).toBe('jpeg');
    expect(detectFormat(load('printed.webp'))).toBe('webp');
  });

  it('does not trust names or declared types: unknown bytes are null', () => {
    expect(detectFormat(load('not-a-document.txt'))).toBeNull();
    expect(detectFormat(Buffer.alloc(0))).toBeNull();
    expect(detectFormat(Buffer.from('GIF89a'))).toBeNull();
    expect(detectFormat(Buffer.from('RIFF....WAVE'))).toBeNull();
    expect(detectFormat(Buffer.from('<html><body>%PDF-</body>'))).toBeNull();
  });

  it('still detects a corrupt file by its header (validation happens later)', () => {
    expect(detectFormat(load('corrupt.pdf'))).toBe('pdf');
    expect(detectFormat(load('corrupt.png'))).toBe('png');
  });
});

describe('readImageDimensions', () => {
  it('reads PNG, JPEG and WebP dimensions from the header', () => {
    // All three were rendered from the same 500x300 pt page at 150 DPI.
    expect(readImageDimensions('png', load('printed.png'))).toEqual({
      width: 1042,
      height: 625,
    });
    expect(readImageDimensions('jpeg', load('printed.jpg'))).toEqual({
      width: 1042,
      height: 625,
    });
    expect(readImageDimensions('webp', load('printed.webp'))).toEqual({
      width: 1042,
      height: 625,
    });
  });

  it('returns null for truncated or malformed headers', () => {
    expect(readImageDimensions('png', load('corrupt.png'))).toBeNull();
    expect(
      readImageDimensions('png', load('printed.png').subarray(0, 20)),
    ).toBeNull();
    expect(
      readImageDimensions('jpeg', Buffer.from([0xff, 0xd8, 0xff, 0x00])),
    ).toBeNull();
    expect(
      readImageDimensions('webp', Buffer.from('RIFF\0\0\0\0WEBPXXXX')),
    ).toBeNull();
  });

  it('parses a lossless (VP8L) WebP header', () => {
    const header = Buffer.alloc(30);
    header.write('RIFF', 0, 'latin1');
    header.write('WEBP', 8, 'latin1');
    header.write('VP8L', 12, 'latin1');
    header[20] = 0x2f;
    // 14-bit width-1 = 99, 14-bit height-1 = 49.
    header.writeUInt32LE(99 | (49 << 14), 21);
    expect(readImageDimensions('webp', header)).toEqual({
      width: 100,
      height: 50,
    });
  });

  it('parses an extended (VP8X) WebP header', () => {
    const header = Buffer.alloc(30);
    header.write('RIFF', 0, 'latin1');
    header.write('WEBP', 8, 'latin1');
    header.write('VP8X', 12, 'latin1');
    header.writeUIntLE(7999, 24, 3);
    header.writeUIntLE(5999, 27, 3);
    expect(readImageDimensions('webp', header)).toEqual({
      width: 8000,
      height: 6000,
    });
  });
});
