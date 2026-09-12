import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { prepareTestEnv } from './test-env';

/**
 * Runs once before the whole test suite: brings the isolated test database
 * up to date with the committed migrations. Uses `migrate deploy` (additive)
 * rather than `migrate reset` so no database is ever dropped by the tests.
 */
export default function globalSetup(): void {
  prepareTestEnv();

  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'pipe',
    env: process.env,
  });
}
