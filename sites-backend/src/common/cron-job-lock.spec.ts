/**
 * Замок крона на реальном Postgres: одна строка на jobKey, перехват
 * просроченного, снятие только своим holder, гонка параллельных взятий.
 */

import { randomUUID } from 'crypto';
import type { PrismaService } from '../prisma/prisma.service';
import {
  describeDb,
  testPrisma,
} from '../modules/site-crawl/testing/crawl-db.testing';
import {
  releaseCronLock,
  tryAcquireCronLock,
  withCronLock,
} from './cron-job-lock';

describeDb('withCronLock (реальный Postgres)', () => {
  let prisma: PrismaService;
  const keys: string[] = [];
  const key = () => {
    const k = `k1-test-${randomUUID()}`;
    keys.push(k);
    return k;
  };

  beforeAll(() => {
    prisma = testPrisma();
  });
  afterAll(async () => {
    await prisma.siteCronLock.deleteMany({ where: { jobKey: { in: keys } } });
    await prisma.$disconnect();
  });

  it('первый вызов создаёт строку и выполняет fn; после — замок свободен', async () => {
    const k = key();
    const r = await withCronLock(prisma, k, 60_000, async () => 42);
    expect(r).toEqual({ ran: true, result: 42 });
    const row = await prisma.siteCronLock.findUnique({ where: { jobKey: k } });
    expect(row).toMatchObject({
      lockedUntil: null,
      holder: null,
      lastError: null,
    });
    expect(row!.lastStartedAt).not.toBeNull();
    expect(row!.lastFinishedAt).not.toBeNull();
  });

  it('занят — fn не вызывается', async () => {
    const k = key();
    const fn = jest.fn(async () => 1);
    const inner = await withCronLock(prisma, k, 60_000, async () =>
      withCronLock(prisma, k, 60_000, fn),
    );
    expect(inner).toEqual({ ran: true, result: { ran: false } });
    expect(fn).not.toHaveBeenCalled();
  });

  it('гонка: из 8 параллельных взятий выигрывает ровно одно', async () => {
    const k = key();
    const holders = await Promise.all(
      Array.from({ length: 8 }, () => tryAcquireCronLock(prisma, k, 60_000)),
    );
    expect(holders.filter((h) => h !== null)).toHaveLength(1);
  });

  it('просроченный замок перехватывается; старый владелец уже не снимет новый', async () => {
    const k = key();
    const old = await tryAcquireCronLock(prisma, k, 1);
    expect(old).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    const fresh = await tryAcquireCronLock(prisma, k, 60_000);
    expect(fresh).not.toBeNull();
    await releaseCronLock(prisma, k, old!, null);
    expect(await tryAcquireCronLock(prisma, k, 60_000)).toBeNull();
    await releaseCronLock(prisma, k, fresh!, null);
    expect(await tryAcquireCronLock(prisma, k, 60_000)).not.toBeNull();
  });

  it('ошибка fn — пробрасывается, замок снят, lastError записан', async () => {
    const k = key();
    await expect(
      withCronLock(prisma, k, 60_000, async () => {
        throw new Error('сбой тика');
      }),
    ).rejects.toThrow('сбой тика');
    const row = await prisma.siteCronLock.findUnique({ where: { jobKey: k } });
    expect(row!.lockedUntil).toBeNull();
    expect(row!.lastError).toBe('Error: сбой тика');
  });
});
