/**
 * Client-supplied file names are untrusted. They are kept for display and for
 * the download `Content-Disposition` header only — never as a storage key or
 * filesystem path (see `storage-key.ts`).
 */

export const FILE_NAME_MAX_LENGTH = 255;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;
/** Characters that are invalid in file names on at least one major OS. */
const RESERVED_CHARACTERS = /[<>:"|?*]/g;

/**
 * Normalises an untrusted file name:
 * - Unicode NFC normalisation;
 * - path separators (`/`, `\`) → only the last segment is kept, so
 *   `../../etc/passwd` becomes `passwd`;
 * - control characters, null bytes and OS-reserved characters are removed;
 * - surrounding whitespace and trailing dots are stripped;
 * - the result is truncated to 255 characters, preserving the extension.
 *
 * Returns `null` when nothing usable remains (`""`, `"."`, `".."`, `"///"`).
 */
export function sanitizeFileName(input: string): string | null {
  let name = input.normalize('NFC').replace(/\\/g, '/');
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash !== -1) name = name.slice(lastSlash + 1);

  name = name
    .replace(CONTROL_CHARACTERS, '')
    .replace(RESERVED_CHARACTERS, '')
    .trim()
    .replace(/[. ]+$/g, '');

  if (name === '' || name === '.' || name === '..') return null;

  if (name.length > FILE_NAME_MAX_LENGTH) {
    const ext = extensionOf(name);
    const suffix = ext && ext.length <= 16 ? `.${ext}` : '';
    name = name.slice(0, FILE_NAME_MAX_LENGTH - suffix.length) + suffix;
  }
  return name;
}

/** Lower-cased extension without the dot, or `null`. */
export function extensionOf(fileName: string): string | null {
  const index = fileName.lastIndexOf('.');
  if (index <= 0 || index === fileName.length - 1) return null;
  return fileName.slice(index + 1).toLowerCase();
}

/**
 * MIME type implied by well-known extensions of the Phase 2 allowlist. Used
 * only as a consistency check: a declared type that contradicts a known
 * extension is rejected. Unknown extensions are not a reason to reject.
 */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export function mimeTypeForExtension(extension: string | null): string | null {
  if (!extension) return null;
  return EXTENSION_MIME_TYPES[extension] ?? null;
}

/** `type/subtype` in lower case, without parameters such as `; charset=`. */
export function normalizeMimeType(value: string): string {
  return value.split(';')[0].trim().toLowerCase();
}

/**
 * `attachment` Content-Disposition with an ASCII fallback and an RFC 5987
 * `filename*` for the full Unicode name.
 */
export function attachmentContentDisposition(fileName: string): string {
  const ascii = fileName
    .replace(/[^\u0020-\u007E]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
