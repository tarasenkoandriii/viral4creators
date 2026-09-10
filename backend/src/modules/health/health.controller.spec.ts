jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { HealthController } from './health.controller';

describe('GET /api/health (этап 28)', () => {
  it('ok, когда база отвечает', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await new HealthController(prisma as any).health();
    expect(r.status).toBe('ok');
    expect(r.database).toBe('up');
    expect(typeof r.uptimeSeconds).toBe('number');
  });

  it('degraded вместо падения, когда база молчит, и без подробностей наружу', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockRejectedValue(
          new Error('password authentication failed for user "postgres"'),
        ),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await new HealthController(prisma as any).health();
    expect(r).toMatchObject({ status: 'degraded', database: 'down' });
    expect(JSON.stringify(r)).not.toContain('password');
  });
});
