import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfiguration } from '../../config/configuration';
import { OcrErrorCodes, OcrProcessingError } from '../ocr.errors';
import {
  TesseractOcrProvider,
  parseLanguageList,
  parseTsvConfidence,
} from './tesseract-ocr.provider';

const FIXTURES = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'ocr',
);

function provider(): TesseractOcrProvider {
  const config = loadConfiguration(process.env);
  return new TesseractOcrProvider({
    get: () => config.ocr,
  } as unknown as ConfigService);
}

describe('parseTsvConfidence', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t',
    '4\t1\t1\t1\t1\t0\t0\t0\t100\t10\t-1\t',
    '5\t1\t1\t1\t1\t1\t0\t0\t50\t10\t96.5\tHello',
    '5\t1\t1\t1\t1\t2\t50\t0\t50\t10\t80\tworld',
    '5\t1\t1\t1\t1\t3\t90\t0\t5\t10\t95\t ',
    '5\t1\t1\t1\t1\t4\t95\t0\t5\t10\t-1\tghost',
  ].join('\n');

  it('averages word-level confidences, ignoring blanks and non-words', () => {
    expect(parseTsvConfidence(tsv)).toEqual({
      confidence: 88.25,
      wordCount: 2,
    });
  });

  it('returns null when nothing was recognised', () => {
    expect(parseTsvConfidence('')).toEqual({ confidence: null, wordCount: 0 });
    expect(parseTsvConfidence(tsv.split('\n').slice(0, 3).join('\n'))).toEqual({
      confidence: null,
      wordCount: 0,
    });
  });
});

describe('parseLanguageList', () => {
  it('extracts sorted language codes and drops osd/noise', () => {
    const output =
      'List of available languages in "/usr/share/tessdata/" (4):\nosd\nind\neng\nchi_sim\n';
    expect(parseLanguageList(output)).toEqual(['chi_sim', 'eng', 'ind']);
  });
});

describe('TesseractOcrProvider (real engine)', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docuai-tess-spec-'));
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('describes the installed engine and language data', async () => {
    const info = await provider().describe();
    expect(info).not.toBeNull();
    expect(info!.name).toBe('tesseract');
    expect(info!.version).toMatch(/^\d+\.\d+/);
    expect(info!.installedLanguages).toEqual(
      expect.arrayContaining(['eng', 'ind']),
    );
  });

  it('recognises printed text with a confidence on the 0–100 scale', async () => {
    const result = await provider().recognize({
      imagePath: path.join(FIXTURES, 'printed.png'),
      language: 'eng',
      timeoutMs: 30_000,
      workDir,
    });
    expect(result.text.toLowerCase()).toContain('hello world');
    expect(result.wordCount).toBeGreaterThan(3);
    expect(result.confidence).toBeGreaterThan(50);
    expect(result.confidence).toBeLessThanOrEqual(100);
    // Engine output files are cleaned up.
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  it('kills the engine and reports a timeout when the budget is exceeded', async () => {
    await expect(
      provider().recognize({
        imagePath: path.join(FIXTURES, 'printed.png'),
        language: 'eng',
        timeoutMs: 1,
        workDir,
      }),
    ).rejects.toMatchObject({
      code: OcrErrorCodes.OCR_PROCESSING_TIMEOUT,
      permanent: false,
    });
  });

  it('fails permanently on an undecodable image', async () => {
    const error = await provider()
      .recognize({
        imagePath: path.join(FIXTURES, 'corrupt.png'),
        language: 'eng',
        timeoutMs: 30_000,
        workDir,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OcrProcessingError);
    expect((error as OcrProcessingError).code).toBe(
      OcrErrorCodes.OCR_INVALID_FILE,
    );
    expect((error as OcrProcessingError).permanent).toBe(true);
  });
});
