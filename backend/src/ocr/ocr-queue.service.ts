import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionOptions, Job, Queue } from 'bullmq';
import { AppConfig, OcrConfig } from '../config/configuration';

export interface OcrQueuePayload {
  ocrJobId: string;
}

export const OCR_QUEUE_JOB_NAME = 'ocr';

/** BullMQ states in which a queue entry will still be (re)delivered. */
const PENDING_STATES = new Set([
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
]);

/**
 * Translates REDIS_URL into BullMQ connection options. BullMQ manages its
 * own ioredis clients (it needs `maxRetriesPerRequest: null` for blocking
 * commands), so the application's RedisService client is not shared.
 */
export function queueConnectionOptions(url: string): ConnectionOptions {
  const parsed = new URL(url);
  const db = Number.parseInt(parsed.pathname.replace(/^\//, ''), 10);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
    db: Number.isNaN(db) ? 0 : db,
    ...(parsed.username
      ? { username: decodeURIComponent(parsed.username) }
      : {}),
    ...(parsed.password
      ? { password: decodeURIComponent(parsed.password) }
      : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5000),
  };
}

/**
 * Producer side of the OCR queue. The database row is the source of truth;
 * the queue entry (keyed by the OCR job id, so duplicates collapse) merely
 * schedules work. Completed/failed entries are removed immediately because
 * their outcome already lives in `ocr_jobs`.
 */
@Injectable()
export class OcrQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OcrQueueService.name);
  private readonly config: OcrConfig;
  private readonly queue: Queue;

  constructor(configService: ConfigService<AppConfig, true>) {
    this.config = configService.get('ocr', { infer: true });
    const { url } = configService.get('redis', { infer: true });
    this.queue = new Queue(this.config.queueName, {
      connection: queueConnectionOptions(url),
      defaultJobOptions: {
        attempts: this.config.maxAttempts,
        backoff: { type: 'exponential', delay: this.config.retryBackoffMs },
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    this.queue.on('error', (error: Error) => {
      this.logger.warn(`OCR queue error: ${error.message}`);
    });
  }

  get name(): string {
    return this.config.queueName;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await this.queue.waitUntilReady();
    } catch (error) {
      this.logger.error(
        `OCR queue not ready at startup: ${(error as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch(() => undefined);
  }

  /**
   * Schedules a persisted OCR job. Idempotent: adding an id that is already
   * pending returns the existing entry. Throws when Redis is unreachable;
   * callers leave the row QUEUED so the reconciler can enqueue it later.
   */
  async enqueue(ocrJobId: string): Promise<void> {
    const payload: OcrQueuePayload = { ocrJobId };
    await this.queue.add(OCR_QUEUE_JOB_NAME, payload, { jobId: ocrJobId });
  }

  /** True when a queue entry for the job exists and will still be delivered. */
  async isPending(ocrJobId: string): Promise<boolean> {
    const entry = await this.getEntry(ocrJobId);
    if (!entry) return false;
    const state = await entry.getState();
    return PENDING_STATES.has(state);
  }

  /** Removes a finished or orphaned entry so the id can be re-added. */
  async removeStaleEntry(ocrJobId: string): Promise<void> {
    const entry = await this.getEntry(ocrJobId);
    if (!entry) return;
    const state = await entry.getState();
    if (!PENDING_STATES.has(state)) {
      await entry.remove().catch(() => undefined);
    }
  }

  /** Removes the entry whatever its state (lost-worker simulation, tests). */
  async removeEntry(ocrJobId: string): Promise<void> {
    const entry = await this.getEntry(ocrJobId);
    if (!entry) return;
    await entry.remove().catch(() => undefined);
  }

  async counts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'prioritized',
      'failed',
    );
  }

  async isHealthy(): Promise<boolean> {
    try {
      // getJobCounts round-trips to Redis; it throws when the server is down.
      await this.queue.getJobCounts('active');
      return true;
    } catch {
      return false;
    }
  }

  private async getEntry(ocrJobId: string): Promise<Job | undefined> {
    return this.queue.getJob(ocrJobId);
  }
}
