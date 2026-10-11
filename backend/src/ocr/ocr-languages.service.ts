import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, OcrConfig } from '../config/configuration';
import { ocrUnavailable, ocrUnsupportedLanguage } from './ocr.errors';
import { OcrProvider } from './providers/ocr-provider.interface';

export interface LanguageAvailability {
  /** Configured languages whose trained data is installed (advertised). */
  available: string[];
  /** Configured languages without installed trained data. */
  missing: string[];
  /** Whether every code of the default language is available. */
  defaultAvailable: boolean;
  defaultLanguage: string;
  checkedAt: Date;
}

const LANGUAGE_CODE = /^[a-z]{3}(_[a-z]+)?$/;
const REFRESH_MS = 60_000;

/**
 * Single source of truth for OCR languages. A language is offered only when
 * it is both configured (`OCR_SUPPORTED_LANGUAGES`) and actually installed
 * for the engine; nothing is ever downloaded on demand.
 */
@Injectable()
export class OcrLanguagesService implements OnModuleInit {
  private readonly logger = new Logger(OcrLanguagesService.name);
  private readonly config: OcrConfig;
  private cache: LanguageAvailability | null = null;
  private refreshing: Promise<LanguageAvailability> | null = null;

  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly provider: OcrProvider,
  ) {
    this.config = configService.get('ocr', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) return;
    const availability = await this.availability(true);
    if (availability.missing.length > 0) {
      this.logger.warn(
        `OCR language data missing for: ${availability.missing.join(', ')}; these languages are not offered`,
      );
    }
    if (!availability.defaultAvailable) {
      this.logger.error(
        `OCR default language "${availability.defaultLanguage}" is not fully installed; OCR requests without an explicit language will be refused`,
      );
    }
  }

  async availability(force = false): Promise<LanguageAvailability> {
    if (
      !force &&
      this.cache &&
      Date.now() - this.cache.checkedAt.getTime() < REFRESH_MS
    ) {
      return this.cache;
    }
    if (!this.refreshing) {
      this.refreshing = this.probe().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /**
   * Validates a client-supplied language list and returns the canonical form
   * (`code+code`, order preserved = engine priority, duplicates removed).
   * `undefined`/empty selects the configured default.
   */
  async resolve(requested: string | undefined): Promise<string> {
    const { available } = await this.availability();
    // No usable language at all means the engine (or its data) is missing —
    // an operational problem, not a client error.
    if (available.length === 0) throw ocrUnavailable();
    const raw = (requested ?? '').trim() || this.config.defaultLanguage;
    const codes = [...new Set(raw.split('+').map((c) => c.trim()))];
    if (
      codes.length === 0 ||
      codes.length > this.config.maxLanguagesPerJob ||
      codes.some(
        (code) => !LANGUAGE_CODE.test(code) || !available.includes(code),
      )
    ) {
      throw ocrUnsupportedLanguage(available);
    }
    return codes.join('+');
  }

  private async probe(): Promise<LanguageAvailability> {
    const info = await this.provider.describe();
    const installed = new Set(info?.installedLanguages ?? []);
    const configured = this.config.supportedLanguages;
    const available = configured.filter((code) => installed.has(code));
    const missing = configured.filter((code) => !installed.has(code));
    const defaultCodes = this.config.defaultLanguage.split('+');
    const availability: LanguageAvailability = {
      available,
      missing,
      defaultAvailable: defaultCodes.every((code) => available.includes(code)),
      defaultLanguage: this.config.defaultLanguage,
      checkedAt: new Date(),
    };
    this.cache = availability;
    return availability;
  }
}
