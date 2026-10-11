import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AppConfig, OcrConfig } from '../../config/configuration';
import { OcrErrorCodes, OcrProcessingError } from '../ocr.errors';
import {
  CommandNotFoundError,
  RunCommandResult,
  runCommand,
} from './run-command';

export interface PdfPageInfo {
  /** Page size in PostScript points (1/72 in). */
  widthPt: number;
  heightPt: number;
}

export interface PdfInfo {
  pageCount: number;
  pages: PdfPageInfo[];
}

export interface RenderOptions {
  dpi: number;
  timeoutMs: number;
}

/**
 * Thin wrapper around Poppler's command-line tools (`pdfinfo`, `pdftotext`,
 * `pdftoppm`). Every call runs in a subprocess with a hard timeout, never on
 * the event loop, and only ever receives server-generated paths.
 */
@Injectable()
export class PopplerService {
  private readonly config: OcrConfig;

  constructor(configService: ConfigService<AppConfig, true>) {
    this.config = configService.get('ocr', { infer: true });
  }

  tool(name: 'pdfinfo' | 'pdftotext' | 'pdftoppm'): string {
    return this.config.tools.popplerPath
      ? path.join(this.config.tools.popplerPath, name)
      : name;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await runCommand(this.tool('pdftoppm'), ['-v'], {
        timeoutMs: 5000,
      });
      return result.exitCode === 0 || result.exitCode === 99;
    } catch {
      return false;
    }
  }

  async version(): Promise<string | null> {
    try {
      const result = await runCommand(this.tool('pdftoppm'), ['-v'], {
        timeoutMs: 5000,
      });
      const match = /pdftoppm version ([^\s]+)/.exec(result.stderr);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /** Page count and per-page sizes. Throws OCR_INVALID_FILE for unparsable PDFs. */
  async info(pdfPath: string, timeoutMs: number): Promise<PdfInfo> {
    const result = await this.run(
      this.tool('pdfinfo'),
      ['-f', '1', '-l', String(this.config.limits.maxPdfPages + 1), pdfPath],
      timeoutMs,
    );
    const output = result.stdout.toString('utf8');
    const pagesMatch = /^Pages:\s+(\d+)\s*$/m.exec(output);
    if (result.exitCode !== 0 || !pagesMatch) {
      throw OcrProcessingError.permanent(
        OcrErrorCodes.OCR_INVALID_FILE,
        'The PDF could not be parsed',
        `pdfinfo exit ${result.exitCode}: ${firstLine(result.stderr)}`,
      );
    }
    const pageCount = Number.parseInt(pagesMatch[1], 10);
    const pages: PdfPageInfo[] = [];
    const sizePattern = /^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts/gm;
    let match: RegExpExecArray | null;
    while ((match = sizePattern.exec(output)) !== null) {
      pages[Number.parseInt(match[1], 10) - 1] = {
        widthPt: Number.parseFloat(match[2]),
        heightPt: Number.parseFloat(match[3]),
      };
    }
    return { pageCount, pages };
  }

  /**
   * Native text of every page, split on the form feed pdftotext emits
   * between pages. Index 0 = page 1. Output is bounded by `maxBytes`.
   */
  async extractText(
    pdfPath: string,
    pageCount: number,
    timeoutMs: number,
    maxBytes: number,
  ): Promise<string[]> {
    const result = await this.run(
      this.tool('pdftotext'),
      ['-layout', '-enc', 'UTF-8', '-eol', 'unix', pdfPath, '-'],
      timeoutMs,
      maxBytes,
    );
    if (result.exitCode !== 0) {
      throw OcrProcessingError.permanent(
        OcrErrorCodes.OCR_INVALID_FILE,
        'The PDF text layer could not be read',
        `pdftotext exit ${result.exitCode}: ${firstLine(result.stderr)}`,
      );
    }
    const pages = result.stdout.toString('utf8').split('\f');
    // pdftotext ends the last page with a form feed, producing a trailing
    // empty element; pad/trim so the array always has `pageCount` entries.
    while (pages.length > pageCount) pages.pop();
    while (pages.length < pageCount) pages.push('');
    return pages;
  }

  /**
   * Renders one page to a PNG file inside `workDir` and returns its path.
   * The caller has already chosen a DPI that respects the pixel budget.
   */
  async renderPage(
    pdfPath: string,
    pageNumber: number,
    workDir: string,
    options: RenderOptions,
  ): Promise<string> {
    const outBase = path.join(workDir, `page-${pageNumber}`);
    const result = await this.run(
      this.tool('pdftoppm'),
      [
        '-r',
        String(options.dpi),
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-singlefile',
        '-png',
        '-gray',
        pdfPath,
        outBase,
      ],
      options.timeoutMs,
      1024,
    );
    const outputPath = `${outBase}.png`;
    if (result.exitCode !== 0 || !(await exists(outputPath))) {
      throw OcrProcessingError.permanent(
        OcrErrorCodes.OCR_INVALID_FILE,
        'The PDF page could not be rendered',
        `pdftoppm exit ${result.exitCode}: ${firstLine(result.stderr)}`,
      );
    }
    return outputPath;
  }

  private async run(
    command: string,
    args: string[],
    timeoutMs: number,
    maxOutputBytes?: number,
  ): Promise<RunCommandResult> {
    let result: RunCommandResult;
    try {
      result = await runCommand(command, args, { timeoutMs, maxOutputBytes });
    } catch (error) {
      if (error instanceof CommandNotFoundError) {
        throw OcrProcessingError.transient(
          OcrErrorCodes.OCR_PROCESSING_FAILED,
          'PDF tooling is unavailable',
          error.message,
        );
      }
      throw error;
    }
    if (result.timedOut) {
      throw OcrProcessingError.transient(
        OcrErrorCodes.OCR_PROCESSING_TIMEOUT,
        'PDF processing exceeded the time limit',
        `${path.basename(command)} killed after ${result.durationMs} ms`,
      );
    }
    return result;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.slice(0, 200) ?? '';
}
