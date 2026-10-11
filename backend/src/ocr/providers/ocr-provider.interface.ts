/**
 * OCR engine abstraction. The extraction pipeline only knows this contract,
 * so a different engine (another local binary, a cloud API, ...) can replace
 * Tesseract without touching job lifecycle or persistence logic.
 */

export interface OcrRecognizeInput {
  /** Server-generated path to a PNG/JPEG/WebP file in the job's work dir. */
  imagePath: string;
  /** Validated, canonical language list, e.g. `ind+eng`. */
  language: string;
  /** Hard limit for the recognition of this single image. */
  timeoutMs: number;
  /** Scratch directory owned by the job; removed when the job ends. */
  workDir: string;
}

export interface OcrRecognizeResult {
  /** Raw recognised text (the pipeline normalises it). */
  text: string;
  /**
   * Mean word confidence on a 0–100 scale, or `null` when the engine did not
   * recognise any word (or does not report confidence).
   */
  confidence: number | null;
  wordCount: number;
}

export interface OcrEngineInfo {
  name: string;
  version: string | null;
  /** Language codes whose trained data is installed. */
  installedLanguages: string[];
}

export abstract class OcrProvider {
  abstract recognize(input: OcrRecognizeInput): Promise<OcrRecognizeResult>;

  /** Engine availability and installed language data (used by health checks). */
  abstract describe(): Promise<OcrEngineInfo | null>;
}
