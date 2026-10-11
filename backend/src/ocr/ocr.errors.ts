import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception';

/**
 * Safe, documented OCR error codes. They appear in API error envelopes and
 * in `ocr_jobs.error_code` / `ocr_pages.error_code`; never raw tool output.
 */
export const OcrErrorCodes = {
  /** No OCR job exists for the document (status/results/retry). */
  OCR_NOT_FOUND: 'OCR_NOT_FOUND',
  /** Results requested while the latest job is still QUEUED/PROCESSING. */
  OCR_NOT_READY: 'OCR_NOT_READY',
  /** Another job with a different language is active for the document. */
  OCR_ALREADY_PROCESSING: 'OCR_ALREADY_PROCESSING',
  OCR_UNSUPPORTED_LANGUAGE: 'OCR_UNSUPPORTED_LANGUAGE',
  /** Document type (or actual file bytes) is not PDF/JPEG/PNG/WebP. */
  OCR_UNSUPPORTED_FILE_TYPE: 'OCR_UNSUPPORTED_FILE_TYPE',
  OCR_FILE_TOO_LARGE: 'OCR_FILE_TOO_LARGE',
  OCR_PAGE_LIMIT_EXCEEDED: 'OCR_PAGE_LIMIT_EXCEEDED',
  /** A page/image is too large to render or recognise within the pixel limit. */
  OCR_PAGE_TOO_LARGE: 'OCR_PAGE_TOO_LARGE',
  /** The file could not be parsed by the PDF/image tooling. */
  OCR_INVALID_FILE: 'OCR_INVALID_FILE',
  OCR_PROCESSING_TIMEOUT: 'OCR_PROCESSING_TIMEOUT',
  OCR_PROCESSING_FAILED: 'OCR_PROCESSING_FAILED',
  OCR_STORAGE_ERROR: 'OCR_STORAGE_ERROR',
  /** Extracted text hit the per-document limit; remaining pages were not stored. */
  OCR_TEXT_LIMIT_EXCEEDED: 'OCR_TEXT_LIMIT_EXCEEDED',
  /** The worker was interrupted and the job exhausted its attempts. */
  OCR_WORKER_INTERRUPTED: 'OCR_WORKER_INTERRUPTED',
  /** The document was deleted or left READY while the job was pending. */
  OCR_DOCUMENT_UNAVAILABLE: 'OCR_DOCUMENT_UNAVAILABLE',
  /** Document is not READY / has no verified upload. */
  OCR_DOCUMENT_NOT_READY: 'OCR_DOCUMENT_NOT_READY',
  /** Retry refused: job not failed, permanent error, or attempt budget used. */
  OCR_RETRY_NOT_ALLOWED: 'OCR_RETRY_NOT_ALLOWED',
  /** Too many active jobs for the user or too many jobs for the document. */
  OCR_TOO_MANY_JOBS: 'OCR_TOO_MANY_JOBS',
  /** OCR is disabled or its runtime dependencies are unavailable. */
  OCR_UNAVAILABLE: 'OCR_UNAVAILABLE',
} as const;

export type OcrErrorCode = (typeof OcrErrorCodes)[keyof typeof OcrErrorCodes];

/**
 * Error codes that describe the input itself. A job failing with one of these
 * will fail again on the same file, so it is never retried automatically and
 * the retry endpoint refuses it.
 */
export const PERMANENT_OCR_ERROR_CODES: ReadonlySet<string> = new Set([
  OcrErrorCodes.OCR_UNSUPPORTED_FILE_TYPE,
  OcrErrorCodes.OCR_FILE_TOO_LARGE,
  OcrErrorCodes.OCR_PAGE_LIMIT_EXCEEDED,
  OcrErrorCodes.OCR_PAGE_TOO_LARGE,
  OcrErrorCodes.OCR_INVALID_FILE,
  OcrErrorCodes.OCR_DOCUMENT_UNAVAILABLE,
  OcrErrorCodes.OCR_UNSUPPORTED_LANGUAGE,
]);

/**
 * Internal processing failure carried through the worker. `permanent` decides
 * whether the queue may retry; `message` is already client-safe.
 */
export class OcrProcessingError extends Error {
  /**
   * `job`: abort the whole job (tooling unavailable, invalid file, limits).
   * `page`: record the failure on the current page and continue.
   */
  scope: 'job' | 'page' = 'job';

  constructor(
    readonly code: OcrErrorCode,
    message: string,
    readonly permanent: boolean,
    /** Internal diagnostics for the protected log only. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'OcrProcessingError';
  }

  forPage(): this {
    this.scope = 'page';
    return this;
  }

  static permanent(
    code: OcrErrorCode,
    message: string,
    detail?: string,
  ): OcrProcessingError {
    return new OcrProcessingError(code, message, true, detail);
  }

  static transient(
    code: OcrErrorCode,
    message: string,
    detail?: string,
  ): OcrProcessingError {
    return new OcrProcessingError(code, message, false, detail);
  }
}

export function ocrNotFound(): AppException {
  return new AppException(
    HttpStatus.NOT_FOUND,
    OcrErrorCodes.OCR_NOT_FOUND,
    'No OCR job exists for this document',
  );
}

export function ocrNotReady(status: string): AppException {
  return new AppException(
    HttpStatus.CONFLICT,
    OcrErrorCodes.OCR_NOT_READY,
    `OCR results are not available yet (job is ${status})`,
  );
}

export function ocrAlreadyProcessing(): AppException {
  return new AppException(
    HttpStatus.CONFLICT,
    OcrErrorCodes.OCR_ALREADY_PROCESSING,
    'An OCR job with a different language configuration is already active for this document',
  );
}

export function ocrUnsupportedLanguage(available: string[]): AppException {
  return new AppException(
    HttpStatus.BAD_REQUEST,
    OcrErrorCodes.OCR_UNSUPPORTED_LANGUAGE,
    `Unsupported OCR language; available: ${available.join(', ')}`,
  );
}

export function ocrUnsupportedFileType(): AppException {
  return new AppException(
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    OcrErrorCodes.OCR_UNSUPPORTED_FILE_TYPE,
    'OCR supports PDF, JPEG, PNG and WebP documents only',
  );
}

export function ocrFileTooLarge(maxBytes: number): AppException {
  return new AppException(
    HttpStatus.PAYLOAD_TOO_LARGE,
    OcrErrorCodes.OCR_FILE_TOO_LARGE,
    `Documents larger than ${maxBytes} bytes cannot be processed`,
  );
}

export function ocrPageLimitExceeded(maxPages: number): AppException {
  return new AppException(
    HttpStatus.PAYLOAD_TOO_LARGE,
    OcrErrorCodes.OCR_PAGE_LIMIT_EXCEEDED,
    `Documents with more than ${maxPages} pages cannot be processed`,
  );
}

export function ocrDocumentNotReady(): AppException {
  return new AppException(
    HttpStatus.CONFLICT,
    OcrErrorCodes.OCR_DOCUMENT_NOT_READY,
    'The document has no completed upload; finish the upload before requesting OCR',
  );
}

export function ocrRetryNotAllowed(message: string): AppException {
  return new AppException(
    HttpStatus.CONFLICT,
    OcrErrorCodes.OCR_RETRY_NOT_ALLOWED,
    message,
  );
}

export function ocrTooManyJobs(message: string): AppException {
  return new AppException(
    HttpStatus.TOO_MANY_REQUESTS,
    OcrErrorCodes.OCR_TOO_MANY_JOBS,
    message,
  );
}

export function ocrUnavailable(): AppException {
  return new AppException(
    HttpStatus.SERVICE_UNAVAILABLE,
    OcrErrorCodes.OCR_UNAVAILABLE,
    'OCR is currently unavailable',
  );
}
