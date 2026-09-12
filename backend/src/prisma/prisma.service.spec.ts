import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('initializes and can query PostgreSQL', async () => {
    const rows = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
    expect(rows[0]?.ok).toBe(1);
  });

  it('can read the SystemConfig model', async () => {
    const records = await prisma.systemConfig.findMany();
    expect(Array.isArray(records)).toBe(true);
  });

  it('reports healthy when the database is reachable', async () => {
    await expect(prisma.isHealthy()).resolves.toBe(true);
  });
});
