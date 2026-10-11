/**
 * Text post-processing shared by native extraction and OCR output.
 */

export interface NativeTextRule {
  /** Minimum characters (after whitespace collapsing) for a usable text layer. */
  minChars: number;
  /** Minimum share of letters/digits among non-space characters. */
  minAlphanumericRatio: number;
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
  charCount: number;
}

/**
 * Normalises raw tool output for storage: Unicode NFC, `\n` line endings,
 * form feeds and NUL/control characters removed, trailing whitespace per
 * line stripped, runs of blank lines collapsed to one, trimmed.
 */
export function normalizeExtractedText(raw: string): string {
  return (
    raw
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .split('\n')
      .map((line) => line.replace(/[ \t\u00A0]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Deterministic rule deciding whether a PDF page's native text layer is
 * usable or the page must be rendered and OCR'd:
 *
 *   usable := collapsedLength >= minChars
 *          && alphanumeric / nonSpace >= minAlphanumericRatio
 *
 * where `collapsedLength` is the length after collapsing all whitespace runs
 * to one space, `alphanumeric` counts Unicode letters and digits and
 * `nonSpace` counts every non-whitespace character. Blank pages and pages
 * whose "text layer" is mostly symbols/garbage (a typical artefact of poor
 * scanner OCR layers) therefore go to OCR; real text never does. Native text
 * and OCR output are never combined for one page.
 */
export function isNativeTextUsable(
  text: string,
  rule: NativeTextRule,
): boolean {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length < rule.minChars) return false;
  let alphanumeric = 0;
  let nonSpace = 0;
  for (const char of collapsed) {
    if (char === ' ') continue;
    nonSpace += 1;
    if (/[\p{L}\p{N}]/u.test(char)) alphanumeric += 1;
  }
  if (nonSpace === 0) return false;
  return alphanumeric / nonSpace >= rule.minAlphanumericRatio;
}

/** Cuts text at `maxChars` code points, flagging the cut. */
export function truncateText(text: string, maxChars: number): TruncatedText {
  const chars = Array.from(text);
  if (chars.length <= maxChars) {
    return { text, truncated: false, charCount: chars.length };
  }
  return {
    text: chars.slice(0, maxChars).join(''),
    truncated: true,
    charCount: maxChars,
  };
}

/** Lower-cased, whitespace-collapsed text for keyword comparison in tests. */
export function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
