import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception';

export const DocumentsErrorCodes = {
  /**
   * Returned for unknown ids, soft-deleted documents *and* documents owned
   * by another user, so the API never confirms that a foreign id exists.
   */
  DOCUMENT_NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  /** Declared size above MAX_DOCUMENT_FILE_SIZE_BYTES. */
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  /** MIME type outside ALLOWED_DOCUMENT_MIME_TYPES or inconsistent extension. */
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  /** The document's state does not allow the requested upload operation. */
  INVALID_UPLOAD: 'INVALID_UPLOAD',
  /** upload-complete was called but no object exists under the storage key. */
  UPLOAD_NOT_FOUND: 'UPLOAD_NOT_FOUND',
  /** download-url requested for a document that is not READY. */
  UPLOAD_NOT_READY: 'UPLOAD_NOT_READY',
} as const;

export function documentNotFound(): AppException {
  return new AppException(
    HttpStatus.NOT_FOUND,
    DocumentsErrorCodes.DOCUMENT_NOT_FOUND,
    'Document not found',
  );
}

export function fileTooLarge(maxBytes: number): AppException {
  return new AppException(
    HttpStatus.PAYLOAD_TOO_LARGE,
    DocumentsErrorCodes.FILE_TOO_LARGE,
    `File exceeds the maximum allowed size of ${maxBytes} bytes`,
  );
}

export function unsupportedFileType(message = 'Unsupported file type') {
  return new AppException(
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    DocumentsErrorCodes.UNSUPPORTED_FILE_TYPE,
    message,
  );
}

export function invalidUpload(message: string): AppException {
  return new AppException(
    HttpStatus.CONFLICT,
    DocumentsErrorCodes.INVALID_UPLOAD,
    message,
  );
}

export function uploadNotFound(): AppException {
  return new AppException(
    HttpStatus.CONFLICT,
    DocumentsErrorCodes.UPLOAD_NOT_FOUND,
    'No uploaded file was found for this document; upload the file to the upload URL first',
  );
}

export function uploadNotReady(): AppException {
  return new AppException(
    HttpStatus.CONFLICT,
    DocumentsErrorCodes.UPLOAD_NOT_READY,
    'The document has no completed upload yet',
  );
}
