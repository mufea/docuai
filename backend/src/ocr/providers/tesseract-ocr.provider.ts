import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AppConfig, OcrConfig } from '../../config/configuration';
import { OcrErrorCodes, OcrProcessingError } from '../ocr.errors';
import {
  CommandNotFoundError,
  RunCommandResult,
  runCommand,
} from '../tools/run-command';
import {
  OcrEngineInfo,
  OcrProvider,
  OcrRecognizeInput,
  OcrRecognizeResult,
} from './ocr-provider.interface';

/** Tesseract TSV columns (level 5 rows are words). */
const TSV_LEVEL = 0;
const TSV_CONF = 10;
const TSV_TEXT = 11;
const WORD_LEVEL = '5';

/**
 * `OcrProvider` backed by the locally installed Tesseract binary.
 *
 * One `tesseract` invocation produces both the plain-text result and the TSV
 * word table, from which the mean word confidence (0–100) is computed. The
 * engine runs in its own process group with a hard timeout and a single
 * OpenMP thread, so a page can never block the event loop or saturate the
 * host.
 */
@Injectable()
export class TesseractOcrProvider extends OcrProvider {
  private readonly logger = new Logger(TesseractOcrProvider.name);
  private readonly config: OcrConfig;

  constructor(configService: ConfigService<AppConfig, true>) {
    super();
    this.config = configService.get('ocr', { infer: true });
  }

  async recognize(input: OcrRecognizeInput): Promise<OcrRecognizeResult> {
    const outBase = path.join(
      input.workDir,
      `ocr-${path.basename(input.imagePath).replace(/[^A-Za-z0-9_-]/g, '_')}`,
    );
    const args = [
      input.imagePath,
      outBase,
      '-l',
      input.language,
      '--psm',
      '3',
      'txt',
      'tsv',
    ];

    let result: RunCommandResult;
    try {
      result = await runCommand(this.config.tools.tesseractPath, args, {
        timeoutMs: input.timeoutMs,
        maxOutputBytes: 64 * 1024,
        env: this.environment(),
      });
    } catch (error) {
      if (error instanceof CommandNotFoundError) {
        throw OcrProcessingError.transient(
          OcrErrorCodes.OCR_PROCESSING_FAILED,
          'The OCR engine is unavailable',
          error.message,
        );
      }
      throw error;
    }

    if (result.timedOut) {
      throw OcrProcessingError.transient(
        OcrErrorCodes.OCR_PROCESSING_TIMEOUT,
        'Text recognition exceeded the time limit',
        `tesseract killed after ${result.durationMs} ms`,
      );
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr;
      // Unreadable/corrupt image: Leptonica cannot decode it.
      const permanent = /pixRead|Image file .* cannot be read|not read/i.test(
        stderr,
      );
      throw new OcrProcessingError(
        permanent
          ? OcrErrorCodes.OCR_INVALID_FILE
          : OcrErrorCodes.OCR_PROCESSING_FAILED,
        permanent
          ? 'The image could not be decoded'
          : 'Text recognition failed',
        permanent,
        `tesseract exit ${result.exitCode}: ${stderr.split('\n', 1)[0]?.slice(0, 200)}`,
      );
    }

    const [text, tsv] = await Promise.all([
      fs.readFile(`${outBase}.txt`, 'utf8').catch(() => ''),
      fs.readFile(`${outBase}.tsv`, 'utf8').catch(() => ''),
    ]);
    await Promise.all([
      fs.rm(`${outBase}.txt`, { force: true }),
      fs.rm(`${outBase}.tsv`, { force: true }),
    ]);

    const { confidence, wordCount } = parseTsvConfidence(tsv);
    return { text, confidence, wordCount };
  }

  async describe(): Promise<OcrEngineInfo | null> {
    try {
      const [version, langs] = await Promise.all([
        runCommand(this.config.tools.tesseractPath, ['--version'], {
          timeoutMs: 5000,
          env: this.environment(),
        }),
        runCommand(this.config.tools.tesseractPath, ['--list-langs'], {
          timeoutMs: 5000,
          env: this.environment(),
        }),
      ]);
      if (version.exitCode !== 0) return null;
      const versionMatch = /tesseract\s+v?([^\s]+)/i.exec(
        version.stdout.toString('utf8') + version.stderr,
      );
      return {
        name: 'tesseract',
        version: versionMatch ? versionMatch[1] : null,
        installedLanguages: parseLanguageList(
          langs.stdout.toString('utf8') + langs.stderr,
        ),
      };
    } catch (error) {
      this.logger.warn(`OCR engine probe failed: ${(error as Error).message}`);
      return null;
    }
  }

  private environment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      // One recognition thread per process; concurrency is controlled by the
      // worker, not by OpenMP inside each subprocess.
      OMP_THREAD_LIMIT: '1',
      ...(this.config.tools.tessdataPrefix
        ? { TESSDATA_PREFIX: this.config.tools.tessdataPrefix }
        : {}),
    };
  }
}

/**
 * Mean confidence over recognised words (TSV level 5 rows with a
 * non-negative `conf` and non-blank text), rounded to two decimals.
 */
export function parseTsvConfidence(tsv: string): {
  confidence: number | null;
  wordCount: number;
} {
  let sum = 0;
  let count = 0;
  const lines = tsv.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split('\t');
    if (cols.length <= TSV_TEXT || cols[TSV_LEVEL] !== WORD_LEVEL) continue;
    const conf = Number.parseFloat(cols[TSV_CONF]);
    const word = cols[TSV_TEXT].trim();
    if (!Number.isFinite(conf) || conf < 0 || word === '') continue;
    sum += Math.min(100, Math.max(0, conf));
    count += 1;
  }
  if (count === 0) return { confidence: null, wordCount: 0 };
  return {
    confidence: Math.round((sum / count) * 100) / 100,
    wordCount: count,
  };
}

/** Parses `tesseract --list-langs` output into sorted language codes. */
export function parseLanguageList(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z]{3}(_[a-z]+)?$/.test(line) && line !== 'osd')
    .sort();
}
