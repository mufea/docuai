import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OcrPageStatus } from '@prisma/client';
import * as fs from 'node:fs/promises';
import { AppConfig, OcrConfig } from '../config/configuration';
import { OcrErrorCodes, OcrProcessingError } from './ocr.errors';
import { OcrProvider } from './providers/ocr-provider.interface';
import {
  DetectedFormat,
  SIGNATURE_PROBE_BYTES,
  detectFormat,
  readImageDimensions,
} from './tools/file-signature';
import { PdfInfo, PopplerService } from './tools/poppler.service';
import {
  isNativeTextUsable,
  normalizeExtractedText,
  truncateText,
} from './tools/text';

export type PageMethod = 'NATIVE_TEXT' | 'OCR';

/** Result for one page, ready to be persisted. */
export interface ExtractedPage {
  pageNumber: number;
  status: OcrPageStatus;
  method: PageMethod | null;
  text: string | null;
  confidence: number | null;
  charCount: number;
  truncated: boolean;
  errorCode: string | null;
}

export interface InspectedFile {
  format: DetectedFormat;
  totalPages: number;
  pdf: PdfInfo | null;
}

export interface ExtractionInput {
  filePath: string;
  inspected: InspectedFile;
  language: string;
  /** Scratch directory owned by the job (rendered pages, engine output). */
  workDir: string;
  /** Epoch ms after which remaining pages fail with OCR_PROCESSING_TIMEOUT. */
  deadline: number;
  /** First page to process (1-based); earlier pages were persisted before. */
  startPage: number;
  /** Remaining characters allowed for this document. */
  charBudget: number;
}

const MIN_RENDER_DPI = 50;
const POINTS_PER_INCH = 72;

/**
 * Format-aware extraction pipeline:
 *
 *   PDF   page has usable native text ──► NATIVE_TEXT (no rendering)
 *         otherwise ──► render page (bounded DPI) ──► OCR
 *   image ──► OCR of the stored file (single page)
 *
 * Pages are produced one at a time (async generator) so the worker can
 * persist each result and report progress incrementally; rendered page images
 * are deleted as soon as they have been recognised. A page is never both
 * native-extracted and OCR'd, so text cannot be duplicated.
 */
@Injectable()
export class OcrExtractionService {
  private readonly logger = new Logger(OcrExtractionService.name);
  private readonly config: OcrConfig;

  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly poppler: PopplerService,
    private readonly provider: OcrProvider,
  ) {
    this.config = configService.get('ocr', { infer: true });
  }

  /**
   * Validates the file bytes (format signature, image dimensions, PDF page
   * count) against the document's verified MIME type and the limits.
   */
  async inspect(
    filePath: string,
    expectedMimeType: string | null,
  ): Promise<InspectedFile> {
    const head = await readHead(filePath, SIGNATURE_PROBE_BYTES);
    const format = detectFormat(head);
    if (!format) {
      throw OcrProcessingError.permanent(
        OcrErrorCodes.OCR_UNSUPPORTED_FILE_TYPE,
        'The stored file is not a PDF, JPEG, PNG or WebP document',
      );
    }
    if (expectedMimeType && mimeOf(format) !== expectedMimeType) {
      throw OcrProcessingError.permanent(
        OcrErrorCodes.OCR_UNSUPPORTED_FILE_TYPE,
        'The stored file does not match its declared type',
        `declared ${expectedMimeType}, detected ${format}`,
      );
    }

    if (format === 'pdf') {
      const pdf = await this.poppler.info(filePath, this.config.pageTimeoutMs);
      if (pdf.pageCount < 1) {
        throw OcrProcessingError.permanent(
          OcrErrorCodes.OCR_INVALID_FILE,
          'The PDF contains no pages',
        );
      }
      if (pdf.pageCount > this.config.limits.maxPdfPages) {
        throw OcrProcessingError.permanent(
          OcrErrorCodes.OCR_PAGE_LIMIT_EXCEEDED,
          `Documents with more than ${this.config.limits.maxPdfPages} pages cannot be processed`,
          `${pdf.pageCount} pages`,
        );
      }
      return { format, totalPages: pdf.pageCount, pdf };
    }

    const dimensions = readImageDimensions(format, head);
    if (!dimensions) {
      throw OcrProcessingError.permanent(
        OcrErrorCodes.OCR_INVALID_FILE,
        'The image header is malformed',
      );
    }
    const pixels = dimensions.width * dimensions.height;
    if (pixels > this.config.limits.maxImagePixels) {
      throw OcrProcessingError.permanent(
        OcrErrorCodes.OCR_PAGE_TOO_LARGE,
        `Images larger than ${this.config.limits.maxImagePixels} pixels cannot be processed`,
        `${dimensions.width}x${dimensions.height}`,
      );
    }
    return { format, totalPages: 1, pdf: null };
  }

  async *extract(input: ExtractionInput): AsyncGenerator<ExtractedPage> {
    if (input.inspected.format === 'pdf') {
      yield* this.extractPdf(input);
    } else {
      yield* this.extractImage(input);
    }
  }

  private async *extractImage(
    input: ExtractionInput,
  ): AsyncGenerator<ExtractedPage> {
    if (input.startPage > 1) return;
    let budget = input.charBudget;
    const page = await this.ocrPage(1, input.filePath, input, budget);
    budget -= page.charCount;
    yield page;
  }

  private async *extractPdf(
    input: ExtractionInput,
  ): AsyncGenerator<ExtractedPage> {
    const pdf = input.inspected.pdf!;
    const total = pdf.pageCount;
    let budget = input.charBudget;

    let nativePages: string[];
    try {
      nativePages = await this.poppler.extractText(
        input.filePath,
        total,
        Math.max(
          1000,
          Math.min(this.config.pageTimeoutMs, input.deadline - Date.now()),
        ),
        // UTF-8 can use up to 4 bytes per character; keep a bounded buffer.
        this.config.limits.maxTextPerDocument * 4 + 1024 * 1024,
      );
    } catch (error) {
      if (!(error instanceof OcrProcessingError)) throw error;
      // The text layer is unreadable but the PDF itself parsed: OCR every page.
      this.logger.warn(
        `Native text extraction unavailable, falling back to OCR: ${error.detail ?? error.message}`,
      );
      nativePages = new Array<string>(total).fill('');
    }

    for (
      let pageNumber = input.startPage;
      pageNumber <= total;
      pageNumber += 1
    ) {
      if (Date.now() >= input.deadline) {
        yield failedPage(pageNumber, OcrErrorCodes.OCR_PROCESSING_TIMEOUT);
        continue;
      }

      const native = normalizeExtractedText(nativePages[pageNumber - 1] ?? '');
      if (isNativeTextUsable(native, this.config.nativeText)) {
        const page = storeText(
          pageNumber,
          'NATIVE_TEXT',
          native,
          null,
          budget,
          this.config.limits.maxTextPerPage,
        );
        budget -= page.charCount;
        yield page;
        continue;
      }

      let rendered: string | null = null;
      try {
        const dpi = this.renderDpiFor(pdf, pageNumber);
        rendered = await this.poppler.renderPage(
          input.filePath,
          pageNumber,
          input.workDir,
          {
            dpi,
            timeoutMs: this.pageBudget(input.deadline),
          },
        );
        const page = await this.ocrPage(pageNumber, rendered, input, budget);
        budget -= page.charCount;
        yield page;
      } catch (error) {
        const failure = this.pageFailure(error, pageNumber);
        if (!failure) throw error;
        yield failure;
      } finally {
        if (rendered)
          await fs.rm(rendered, { force: true }).catch(() => undefined);
      }
    }
  }

  private async ocrPage(
    pageNumber: number,
    imagePath: string,
    input: ExtractionInput,
    budget: number,
  ): Promise<ExtractedPage> {
    try {
      const result = await this.provider.recognize({
        imagePath,
        language: input.language,
        timeoutMs: this.pageBudget(input.deadline),
        workDir: input.workDir,
      });
      const text = normalizeExtractedText(result.text);
      return storeText(
        pageNumber,
        'OCR',
        text,
        result.confidence,
        budget,
        this.config.limits.maxTextPerPage,
      );
    } catch (error) {
      const failure = this.pageFailure(error, pageNumber);
      if (!failure) throw error;
      return failure;
    }
  }

  /**
   * Turns a page-level processing error into a FAILED page. Errors that mean
   * the tooling itself is unavailable are returned as `null` so the caller
   * aborts the job (transient, retried by the queue).
   */
  private pageFailure(
    error: unknown,
    pageNumber: number,
  ): ExtractedPage | null {
    if (!(error instanceof OcrProcessingError)) return null;
    if (error.detail?.startsWith('Command not found')) return null;
    this.logger.warn(
      `Page ${pageNumber} failed: ${error.code} (${error.detail ?? error.message})`,
    );
    return failedPage(pageNumber, error.code);
  }

  /** Remaining time for one page: the page budget, capped by the job deadline. */
  private pageBudget(deadline: number): number {
    return Math.max(
      1000,
      Math.min(this.config.pageTimeoutMs, deadline - Date.now()),
    );
  }

  /**
   * Chooses the render DPI so the rasterised page stays within
   * `maxRenderPixels`; pages that would need less than MIN_RENDER_DPI are
   * refused rather than producing an unreadable, memory-hungry render.
   */
  private renderDpiFor(pdf: PdfInfo, pageNumber: number): number {
    const size = pdf.pages[pageNumber - 1];
    const configured = this.config.limits.renderDpi;
    if (!size) return configured;
    const inches =
      (size.widthPt / POINTS_PER_INCH) * (size.heightPt / POINTS_PER_INCH);
    if (inches <= 0) return configured;
    const fitting = Math.floor(
      Math.sqrt(this.config.limits.maxRenderPixels / inches),
    );
    const dpi = Math.min(configured, fitting);
    if (dpi < MIN_RENDER_DPI) {
      throw OcrProcessingError.permanent(
        OcrErrorCodes.OCR_PAGE_TOO_LARGE,
        'The page is too large to render within the configured limits',
        `${size.widthPt}x${size.heightPt} pt`,
      ).forPage();
    }
    return dpi;
  }
}

function storeText(
  pageNumber: number,
  method: PageMethod,
  text: string,
  confidence: number | null,
  budget: number,
  maxPerPage: number,
): ExtractedPage {
  if (text === '') {
    return {
      pageNumber,
      status: OcrPageStatus.EMPTY,
      method,
      text: '',
      confidence,
      charCount: 0,
      truncated: false,
      errorCode: null,
    };
  }
  if (budget <= 0) {
    return failedPage(
      pageNumber,
      OcrErrorCodes.OCR_TEXT_LIMIT_EXCEEDED,
      method,
    );
  }
  const cut = truncateText(text, Math.min(maxPerPage, budget));
  return {
    pageNumber,
    status: OcrPageStatus.COMPLETED,
    method,
    text: cut.text,
    confidence,
    charCount: cut.charCount,
    truncated: cut.truncated,
    errorCode: null,
  };
}

function failedPage(
  pageNumber: number,
  errorCode: string,
  method: PageMethod | null = null,
): ExtractedPage {
  return {
    pageNumber,
    status: OcrPageStatus.FAILED,
    method,
    text: null,
    confidence: null,
    charCount: 0,
    truncated: false,
    errorCode,
  };
}

function mimeOf(format: DetectedFormat): string {
  return format === 'pdf' ? 'application/pdf' : `image/${format}`;
}

async function readHead(filePath: string, bytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
