import { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/redis/redis.service';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  redis: RedisService;
  logs: CapturingLogger;
  close(): Promise<void>;
}

/**
 * Captures every log line so tests can assert that secrets never reach the
 * application logs.
 */
export class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];

  private record(level: string, message: unknown, params: unknown[]): void {
    const rendered = [message, ...params]
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join(' ');
    this.lines.push(`[${level}] ${rendered}`);
  }

  log(message: unknown, ...params: unknown[]): void {
    this.record('log', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.record('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.record('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.record('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.record('verbose', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.record('fatal', message, params);
  }

  get text(): string {
    return this.lines.join('\n');
  }

  clear(): void {
    this.lines.length = 0;
  }
}

export async function createTestApp(): Promise<TestContext> {
  const logs = new CapturingLogger();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .setLogger(logs)
    .compile();

  const app = moduleRef.createNestApplication({ logger: logs });
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);

  await redis.getClient().flushdb();

  return {
    app,
    prisma,
    redis,
    logs,
    close: () => app.close(),
  };
}

/**
 * Truncates every application table in the (test) database. The guard in
 * `prepareTestEnv` guarantees this only ever runs against TEST_DATABASE_URL.
 */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;

  const list = tables
    .map(({ tablename }) => `"public"."${tablename}"`)
    .join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
  );
}
