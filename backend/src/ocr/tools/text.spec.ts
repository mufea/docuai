import {
  isNativeTextUsable,
  normalizeExtractedText,
  truncateText,
} from './text';

const RULE = { minChars: 20, minAlphanumericRatio: 0.5 };

describe('isNativeTextUsable (native text vs OCR decision)', () => {
  it('accepts a real text layer', () => {
    expect(
      isNativeTextUsable('The quick brown fox jumps over the lazy dog', RULE),
    ).toBe(true);
    expect(
      isNativeTextUsable('Faktur No. 12345 — Total Rp 1.250.000', RULE),
    ).toBe(true);
    expect(
      isNativeTextUsable('日本語のテキストが二十文字以上あります。', RULE),
    ).toBe(true);
  });

  it('rejects blank and near-blank pages so they are OCRed', () => {
    expect(isNativeTextUsable('', RULE)).toBe(false);
    expect(isNativeTextUsable('   \n\n \t ', RULE)).toBe(false);
    expect(isNativeTextUsable('Page 1', RULE)).toBe(false);
  });

  it('rejects garbage text layers (mostly symbols) typical of bad scanner OCR', () => {
    expect(
      isNativeTextUsable('¦¦ ·· ~~ ^^ || ## ** -- == ++ ¦¦ ·· ~~ ^^', RULE),
    ).toBe(false);
    expect(isNativeTextUsable('a!@#$%^&*()_+{}|:"<>?b!@#$%^&*()_+', RULE)).toBe(
      false,
    );
  });

  it('is deterministic at the thresholds', () => {
    const exactlyMin = 'abcdefghijklmnopqrst'; // 20 chars, all letters
    expect(isNativeTextUsable(exactlyMin, RULE)).toBe(true);
    expect(isNativeTextUsable(exactlyMin.slice(0, 19), RULE)).toBe(false);
    // 10 letters + 10 symbols = ratio 0.5 → usable; 9 letters + 11 → not.
    expect(isNativeTextUsable('abcdefghij!!!!!!!!!!', RULE)).toBe(true);
    expect(isNativeTextUsable('abcdefghi!!!!!!!!!!!', RULE)).toBe(false);
  });

  it('counts whitespace runs as a single character', () => {
    expect(
      isNativeTextUsable('a   b   c   d   e   f   g   h   i   j', RULE),
    ).toBe(false);
  });
});

describe('normalizeExtractedText', () => {
  it('normalises line endings, strips control characters and collapses blank lines', () => {
    const raw = 'Line one  \r\nLine two\f\r\n\r\n\r\n\r\nLine three\u0000\n\n';
    expect(normalizeExtractedText(raw)).toBe(
      'Line one\nLine two\n\nLine three',
    );
  });

  it('applies Unicode NFC', () => {
    expect(normalizeExtractedText('e\u0301')).toBe('\u00e9');
  });
});

describe('truncateText', () => {
  it('leaves short text untouched', () => {
    expect(truncateText('hello', 10)).toEqual({
      text: 'hello',
      truncated: false,
      charCount: 5,
    });
  });

  it('cuts at code points, not bytes, and flags the cut', () => {
    expect(truncateText('héllo wörld', 5)).toEqual({
      text: 'héllo',
      truncated: true,
      charCount: 5,
    });
    expect(truncateText('😀😀😀', 2)).toEqual({
      text: '😀😀',
      truncated: true,
      charCount: 2,
    });
  });
});
