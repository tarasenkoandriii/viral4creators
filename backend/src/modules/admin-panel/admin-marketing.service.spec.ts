/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { AdminMarketingService } from './admin-marketing.service';

function broadcast(over: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    createdAt: new Date('2026-09-01'),
    sharedVideoPageIds: ['p1', 'p2', 'p3'],
    ...over,
  };
}

function build(
  opts: {
    rows?: unknown[];
    total?: number;
    activeSubscribers?: number;
    groups?: Array<{ status: string; _count: { _all: number } }>;
  } = {},
) {
  const prisma = {
    marketingBroadcast: {
      findMany: jest.fn().mockResolvedValue(opts.rows ?? [broadcast()]),
      count: jest.fn().mockResolvedValue(opts.total ?? 1),
    },
    user: {
      count: jest.fn().mockResolvedValue(opts.activeSubscribers ?? 0),
    },
    marketingDelivery: {
      groupBy: jest.fn().mockResolvedValue(
        opts.groups ?? [
          { status: 'SENT', _count: { _all: 3 } },
          { status: 'FAILED', _count: { _all: 1 } },
        ],
      ),
    },
  };
  const svc = new AdminMarketingService(prisma as any);
  return { svc, prisma };
}

describe('AdminMarketingService.listBroadcasts (ТЗ §42, этап 63)', () => {
  it('собирает сводку доставки по каждому выпуску из groupBy', async () => {
    const { svc } = build();
    const result = await svc.listBroadcasts({ page: 1, pageSize: 20 });
    expect(result.items).toEqual([
      {
        id: 'b1',
        createdAt: new Date('2026-09-01'),
        featuredCount: 3,
        sent: 3,
        failed: 1,
        skipped: 0,
        pending: 0,
        total: 4,
      },
    ]);
  });

  it('отдаёт текущее число активных подписчиков — не свойство выпуска', async () => {
    const { svc, prisma } = build({ activeSubscribers: 42 });
    const result = await svc.listBroadcasts({ page: 1, pageSize: 20 });
    expect(result.activeSubscribers).toBe(42);
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        marketingConsentAt: { not: null },
        marketingConsentRevokedAt: null,
      },
    });
  });

  it('пагинация — skip/take по page/pageSize', async () => {
    const { svc, prisma } = build();
    await svc.listBroadcasts({ page: 3, pageSize: 10 });
    expect(prisma.marketingBroadcast.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });

  it('выпуска без доставок ещё нет (пустой groupBy) — все счётчики нулевые', async () => {
    const { svc } = build({ groups: [] });
    const result = await svc.listBroadcasts({ page: 1, pageSize: 20 });
    expect(result.items[0]).toMatchObject({
      sent: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
      total: 0,
    });
  });

  it('пустая история выпусков — просто пустой список, без обращений к groupBy', async () => {
    const { svc, prisma } = build({ rows: [], total: 0 });
    const result = await svc.listBroadcasts({ page: 1, pageSize: 20 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(prisma.marketingDelivery.groupBy).not.toHaveBeenCalled();
  });
});
