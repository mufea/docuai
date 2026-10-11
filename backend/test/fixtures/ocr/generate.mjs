#!/usr/bin/env node
/**
 * Deterministic OCR test-fixture generator.
 *
 * Produces every file in this directory from code so the fixtures are small,
 * reproducible and free of third-party content. Re-run with:
 *
 *   node test/fixtures/ocr/generate.mjs
 *
 * Requirements (same as the OCR runtime): Poppler `pdftoppm` for rasterising
 * pages, `cwebp` (package `webp`) for the WebP sample. Text PDFs are written
 * by hand (standard Helvetica, no external fonts); scanned PDFs embed the
 * rasterised JPEG via /DCTDecode so no PDF library is needed.
 *
 * Fixture inventory (expected text lives in `expected.json`):
 *   text.pdf          1 page, native text
 *   text-3pages.pdf   3 pages, native text with distinct words per page
 *   text-6pages.pdf   6 pages, native text (exceeds the test page limit of 4)
 *   long-text.pdf     2 pages, ~1 500 native characters each (exceeds the
 *                     test per-page limit of 1 000 and the 2 500 document limit)
 *   scanned.pdf       2 pages, image-only (no text layer)
 *   mixed.pdf         page 1 native text, page 2 image-only
 *   printed.png/jpg/webp  one image with clearly printed text
 *   blank.png         white image, no text
 *   corrupt.pdf       `%PDF-` header followed by garbage
 *   corrupt.png       PNG signature followed by garbage
 *   not-a-document.txt    plain text (unsupported format)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_W = 500;
const PAGE_H = 300;
const DPI = 150;

// ---------------------------------------------------------------------------
// Minimal PDF writer
// ---------------------------------------------------------------------------

function pdfString(value) {
  return `(${value.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/**
 * @param {Array<{kind:'text',lines:string[]}|{kind:'image',jpeg:Buffer,width:number,height:number}>} pages
 */
function buildPdf(pages) {
  const objects = []; // Buffer per object, index+1 = object number
  const add = (buf) => {
    objects.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'latin1'));
    return objects.length;
  };

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  const pagesId = objects.length + 1 + pages.length * 3; // reserved below

  for (const page of pages) {
    let contentId;
    let resources;
    if (page.kind === 'text') {
      const fontSize = page.fontSize ?? 28;
      const leading = page.leading ?? 36;
      const ops = ['BT', `/F1 ${fontSize} Tf`, `${leading} TL`, `40 ${PAGE_H - 20 - fontSize} Td`];
      page.lines.forEach((line, i) => {
        if (i > 0) ops.push('T*');
        ops.push(`${pdfString(line)} Tj`);
      });
      ops.push('ET');
      const stream = ops.join('\n');
      contentId = add(
        `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
      );
      resources = `<< /Font << /F1 ${fontId} 0 R >> >>`;
    } else {
      const imageId = add(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
            'latin1',
          ),
          page.jpeg,
          Buffer.from('\nendstream', 'latin1'),
        ]),
      );
      const stream = `q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im1 Do Q`;
      contentId = add(
        `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
      );
      resources = `<< /XObject << /Im1 ${imageId} 0 R >> >>`;
    }
    // Page object references the Pages object, whose id is assigned last.
    pageIds.push(
      add(
        `<< /Type /Page /Parent PAGES_ID 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources ${resources} /Contents ${contentId} 0 R >>`,
      ),
    );
  }

  const realPagesId = add(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  );
  const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);
  void pagesId;

  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let position = parts[0].length;
  objects.forEach((obj, index) => {
    const body = Buffer.from(
      obj.toString('latin1').replace('PAGES_ID', String(realPagesId)),
      'latin1',
    );
    offsets.push(position);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(chunk);
    position += chunk.length;
  });
  const xrefOffset = position;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join('');
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Rasterisation helpers
// ---------------------------------------------------------------------------

function render(pdf, format, page = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'docuai-fixture-'));
  try {
    const input = join(dir, 'in.pdf');
    writeFileSync(input, pdf);
    const args = ['-r', String(DPI), '-f', String(page), '-l', String(page), '-singlefile'];
    if (format === 'png') args.push('-png');
    else args.push('-jpeg', '-jpegopt', 'quality=90');
    execFileSync('pdftoppm', [...args, input, join(dir, 'out')]);
    return readFileSync(join(dir, format === 'png' ? 'out.png' : 'out.jpg'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function toWebp(png) {
  const dir = mkdtempSync(join(tmpdir(), 'docuai-fixture-'));
  try {
    writeFileSync(join(dir, 'in.png'), png);
    execFileSync('cwebp', ['-quiet', '-q', '90', join(dir, 'in.png'), '-o', join(dir, 'out.webp')]);
    return readFileSync(join(dir, 'out.webp'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function jpegSize(jpeg) {
  let offset = 2;
  while (offset < jpeg.length) {
    if (jpeg[offset] !== 0xff) throw new Error('bad JPEG');
    const marker = jpeg[offset + 1];
    const length = jpeg.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: jpeg.readUInt16BE(offset + 5), width: jpeg.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG without SOF');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const out = (name, data) => writeFileSync(join(here, name), data);

const TEXT_PAGE = ['DocuAI native text fixture', 'The quick brown fox', 'jumps over the lazy dog', 'Invoice number 12345'];
const PAGE_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
const pageLines = (n) => [`Page ${n} ${PAGE_WORDS[n - 1]}`, 'Native text content line', `Sequence marker ${n}${n}${n}`];

out('text.pdf', buildPdf([{ kind: 'text', lines: TEXT_PAGE }]));
out('text-3pages.pdf', buildPdf([1, 2, 3].map((n) => ({ kind: 'text', lines: pageLines(n) }))));
out('text-6pages.pdf', buildPdf([1, 2, 3, 4, 5, 6].map((n) => ({ kind: 'text', lines: pageLines(n) }))));

// Small font so ~1 500 characters fit on one 500x300 pt page.
const longLines = (page) =>
  Array.from({ length: 30 }, (_, i) => `Long text page ${page} line ${String(i + 1).padStart(2, '0')} lorem ipsum dolor sit amet`);
out('long-text.pdf', buildPdf([{ kind: 'text', lines: longLines(1), fontSize: 9, leading: 9 }, { kind: 'text', lines: longLines(2), fontSize: 9, leading: 9 }]));

const printedSource = buildPdf([{ kind: 'text', lines: ['DOCUAI OCR TEST IMAGE', 'HELLO WORLD 2026', 'Printed text sample'] }]);
const printedPng = render(printedSource, 'png');
const printedJpg = render(printedSource, 'jpeg');
out('printed.png', printedPng);
out('printed.jpg', printedJpg);
out('printed.webp', toWebp(printedPng));

const blankPng = render(buildPdf([{ kind: 'text', lines: [] }]), 'png');
out('blank.png', blankPng);

const scanPage = (lines) => {
  const jpeg = render(buildPdf([{ kind: 'text', lines }]), 'jpeg');
  return { kind: 'image', jpeg, ...jpegSize(jpeg) };
};
out('scanned.pdf', buildPdf([scanPage(['Scanned page one', 'DOCUAI OCR']), scanPage(['Scanned page two', 'SECOND SHEET'])]));
out('mixed.pdf', buildPdf([{ kind: 'text', lines: ['Native text page', 'Mixed fixture first'] }, scanPage(['Scanned image page', 'Mixed fixture second'])]));

out('corrupt.pdf', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x41)]));
out('corrupt.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(512, 0x00)]));
out('not-a-document.txt', 'This is plain text, not a supported document format.\n');

out(
  'expected.json',
  JSON.stringify(
    {
      'text.pdf': { pages: 1, keywords: [['native', 'text', 'fixture', 'quick', 'brown', 'fox', '12345']] },
      'text-3pages.pdf': { pages: 3, keywords: [['page', '1', 'alpha', '111'], ['page', '2', 'bravo', '222'], ['page', '3', 'charlie', '333']] },
      'text-6pages.pdf': { pages: 6 },
      'long-text.pdf': { pages: 2, keywords: [['long', 'text', 'page', '1', 'line', '01'], ['long', 'text', 'page', '2', 'line', '01']] },
      'scanned.pdf': { pages: 2, keywords: [['scanned', 'page', 'one', 'docuai'], ['scanned', 'page', 'two', 'second', 'sheet']] },
      'mixed.pdf': { pages: 2, keywords: [['native', 'text', 'page', 'mixed', 'first'], ['scanned', 'image', 'page', 'mixed', 'second']] },
      'printed.png': { pages: 1, keywords: [['docuai', 'ocr', 'test', 'image', 'hello', 'world', '2026']] },
      'printed.jpg': { pages: 1, keywords: [['docuai', 'ocr', 'test', 'image', 'hello', 'world', '2026']] },
      'printed.webp': { pages: 1, keywords: [['docuai', 'ocr', 'test', 'image', 'hello', 'world', '2026']] },
      'blank.png': { pages: 1, keywords: [[]] },
    },
    null,
    2,
  ) + '\n',
);

console.log('fixtures written to', here);
