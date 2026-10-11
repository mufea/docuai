import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, OcrConfig } from '../config/configuration';
import { OcrLanguagesService } from './ocr-languages.service';
import { OcrQueueService } from './ocr-queue.service';
import { OcrWorkerService, WorkerState } from './ocr-worker.service';
import { OcrProvider } from './providers/ocr-provider.interface';
import { PopplerService } from './tools/poppler.service';

export type OcrHealthStatus = 'ready' | 'degraded' | 'disabled';

export interface OcrHealthReport {
  /** ready = engine, renderer, default language and queue available. */
  status: OcrHealthStatus;
  enabled: boolean;
  engine: { available: boolean; name: string | null; version: string | null };
  renderer: { available: boolean; name: 'poppler'; version: string | null };
  languages: {
    default: string;
    defaultAvailable: boolean;
    available: string[];
    missing: string[];
  };
  queue: {
    status: 'up' | 'down';
    name: string;
    counts: Record<string, number> | null;
  };
  worker: { state: WorkerState; concurrency: number };
  timestamp: string;
}

/**
 * OCR-specific readiness. Deliberately separate from the main `/health`
 * aggregate so a missing language pack never makes unrelated API requests
 * fail; `/health` only carries the summary status.
 */
@Injectable()
export class OcrHealthService {
  private readonly config: OcrConfig;

  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly provider: OcrProvider,
    private readonly poppler: PopplerService,
    private readonly languages: OcrLanguagesService,
    private readonly queue: OcrQueueService,
    private readonly worker: OcrWorkerService,
  ) {
    this.config = configService.get('ocr', { infer: true });
  }

  async check(): Promise<OcrHealthReport> {
    const timestamp = new Date().toISOString();
    if (!this.config.enabled) {
      return {
        status: 'disabled',
        enabled: false,
        engine: { available: false, name: null, version: null },
        renderer: { available: false, name: 'poppler', version: null },
        languages: {
          default: this.config.defaultLanguage,
          defaultAvailable: false,
          available: [],
          missing: this.config.supportedLanguages,
        },
        queue: { status: 'down', name: this.config.queueName, counts: null },
        worker: { state: 'disabled', concurrency: this.config.concurrency },
        timestamp,
      };
    }

    const [engine, rendererVersion, availability, queueUp] = await Promise.all([
      this.provider.describe(),
      this.poppler.version(),
      this.languages.availability(),
      this.queue.isHealthy(),
    ]);
    const counts = queueUp ? await this.queue.counts().catch(() => null) : null;
    const rendererAvailable = rendererVersion !== null;
    const ready =
      engine !== null &&
      rendererAvailable &&
      availability.defaultAvailable &&
      queueUp &&
      (!this.config.workerEnabled || this.worker.workerState === 'running');

    return {
      status: ready ? 'ready' : 'degraded',
      enabled: true,
      engine: {
        available: engine !== null,
        name: engine?.name ?? null,
        version: engine?.version ?? null,
      },
      renderer: {
        available: rendererAvailable,
        name: 'poppler',
        version: rendererVersion,
      },
      languages: {
        default: availability.defaultLanguage,
        defaultAvailable: availability.defaultAvailable,
        available: availability.available,
        missing: availability.missing,
      },
      queue: {
        status: queueUp ? 'up' : 'down',
        name: this.config.queueName,
        counts,
      },
      worker: {
        state: this.worker.workerState,
        concurrency: this.config.concurrency,
      },
      timestamp,
    };
  }
}
