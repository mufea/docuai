import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception';

export const FoldersErrorCodes = {
  /**
   * Returned for folders that do not exist *and* for folders owned by another
   * user, so the API never confirms that a foreign folder id exists.
   */
  FOLDER_NOT_FOUND: 'FOLDER_NOT_FOUND',
  /** Self-parenting or otherwise invalid hierarchy change. */
  INVALID_FOLDER: 'INVALID_FOLDER',
  FOLDER_CYCLE_DETECTED: 'FOLDER_CYCLE_DETECTED',
  FOLDER_DEPTH_EXCEEDED: 'FOLDER_DEPTH_EXCEEDED',
} as const;

/** Root folders have depth 1; a folder may have at most this many ancestors + 1. */
export const MAX_FOLDER_DEPTH = 10;

export function folderNotFound(): AppException {
  return new AppException(
    HttpStatus.NOT_FOUND,
    FoldersErrorCodes.FOLDER_NOT_FOUND,
    'Folder not found',
  );
}

export function folderSelfParent(): AppException {
  return new AppException(
    HttpStatus.BAD_REQUEST,
    FoldersErrorCodes.INVALID_FOLDER,
    'A folder cannot be its own parent',
  );
}

export function folderCycle(): AppException {
  return new AppException(
    HttpStatus.BAD_REQUEST,
    FoldersErrorCodes.FOLDER_CYCLE_DETECTED,
    'A folder cannot be moved inside one of its own descendants',
  );
}

export function folderDepthExceeded(): AppException {
  return new AppException(
    HttpStatus.BAD_REQUEST,
    FoldersErrorCodes.FOLDER_DEPTH_EXCEEDED,
    `Folders cannot be nested deeper than ${MAX_FOLDER_DEPTH} levels`,
  );
}
