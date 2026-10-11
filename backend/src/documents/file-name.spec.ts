import {
  attachmentContentDisposition,
  extensionOf,
  mimeTypeForExtension,
  normalizeMimeType,
  sanitizeFileName,
} from './file-name';

describe('sanitizeFileName', () => {
  it('keeps ordinary names', () => {
    expect(sanitizeFileName('invoice.pdf')).toBe('invoice.pdf');
    expect(sanitizeFileName('Rechnung März 2026.PDF')).toBe(
      'Rechnung März 2026.PDF',
    );
  });

  it('strips path traversal and directories', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..\\..\\windows\\system32\\cmd.exe')).toBe(
      'cmd.exe',
    );
    expect(sanitizeFileName('/absolute/path/report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('C:\\Users\\me\\scan.png')).toBe('scan.png');
  });

  it('removes null bytes, control and reserved characters', () => {
    expect(sanitizeFileName('bad\u0000name.pdf')).toBe('badname.pdf');
    expect(sanitizeFileName('line\nbreak\t.pdf')).toBe('linebreak.pdf');
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.pdf')).toBe('abcdefgh.pdf');
    expect(sanitizeFileName('  spaced.pdf  ')).toBe('spaced.pdf');
    expect(sanitizeFileName('trailing.pdf...')).toBe('trailing.pdf');
  });

  it('returns null when nothing usable remains', () => {
    expect(sanitizeFileName('')).toBeNull();
    expect(sanitizeFileName('.')).toBeNull();
    expect(sanitizeFileName('..')).toBeNull();
    expect(sanitizeFileName('../')).toBeNull();
    expect(sanitizeFileName('///')).toBeNull();
    expect(sanitizeFileName('\u0000\u0001')).toBeNull();
    expect(sanitizeFileName('   ')).toBeNull();
  });

  it('truncates very long names while keeping the extension', () => {
    const long = `${'a'.repeat(400)}.pdf`;
    const result = sanitizeFileName(long)!;
    expect(result.length).toBe(255);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('applies NFC normalisation', () => {
    const decomposed = 'Caf\u0065\u0301.pdf';
    expect(sanitizeFileName(decomposed)).toBe('Café.pdf');
  });
});

describe('extensionOf / mimeTypeForExtension', () => {
  it('extracts lower-cased extensions', () => {
    expect(extensionOf('Scan.PDF')).toBe('pdf');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('noext')).toBeNull();
    expect(extensionOf('.bashrc')).toBeNull();
    expect(extensionOf('trailing.')).toBeNull();
  });

  it('maps only the known allowlist extensions', () => {
    expect(mimeTypeForExtension('pdf')).toBe('application/pdf');
    expect(mimeTypeForExtension('jpeg')).toBe('image/jpeg');
    expect(mimeTypeForExtension('exe')).toBeNull();
    expect(mimeTypeForExtension(null)).toBeNull();
  });
});

describe('normalizeMimeType', () => {
  it('lower-cases and drops parameters', () => {
    expect(normalizeMimeType('Application/PDF')).toBe('application/pdf');
    expect(normalizeMimeType('image/png; charset=binary')).toBe('image/png');
  });
});

describe('attachmentContentDisposition', () => {
  it('provides an ASCII fallback and an RFC 5987 encoded name', () => {
    expect(attachmentContentDisposition('invoice.pdf')).toBe(
      `attachment; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`,
    );
    expect(attachmentContentDisposition('Rechnung März "1".pdf')).toBe(
      `attachment; filename="Rechnung M_rz _1_.pdf"; filename*=UTF-8''Rechnung%20M%C3%A4rz%20%221%22.pdf`,
    );
  });
});
