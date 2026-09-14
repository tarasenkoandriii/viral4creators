/**
 * cron-job-lock.spec.ts — джоб-уровневый замок (пятый аудит, Д-3.3).
 * `PrismaService` замокан лёгким объектом с `cronJobLock` (тот же приём,
 * что во всех спеках без сгенерированного Prisma-клиента).
 */

import {
  tryAcquireJobLock,
  releaseJobLock,
  JOB_LOCK_MS,
} from './cron-job-lock';

function prismaMock(opts: {
  createRejects?: unknown;
  updateManyCount?: number;
}) {
  return {
    cronJobLock: {
      create: jest.fn(() =>
        opts.createRejects
          ? Promise.reject(opts.createRejects)
          : Promise.resolve(undefined),
      ),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: opts.updateManyCount ?? 0 }),
    },
  };
}

describe('tryAcquireJobLock', () => {
  it('первый захват (строки для jobKey ещё нет) — create() успешен, возвращает true, updateMany не вызывается', async () => {
    const prisma = prismaMock({});
    const result = await tryAcquireJobLock(
      prisma as never,
      'catalog-batch-run',
    );
    // М-3.7: результат — токен владельца (truthy), не голый true.
    expect(typeof result).toBe('string');
    expect(prisma.cronJobLock.create).toHaveBeenCalledWith({
      data: {
        jobKey: 'catalog-batch-run',
        lockedUntil: expect.any(Date),
        ownerToken: result,
      },
    });
    expect(prisma.cronJobLock.updateMany).not.toHaveBeenCalled();
  });

  it('строка уже существует и просрочена/свободна — create() падает P2002, но updateMany находит и захватывает её (count > 0)', async () => {
    const prisma = prismaMock({
      createRejects: Object.assign(new Error('unique'), { code: 'P2002' }),
      updateManyCount: 1,
    });
    const result = await tryAcquireJobLock(
      prisma as never,
      'ab-test-run',
      1000,
    );
    expect(typeof result).toBe('string');
    expect(prisma.cronJobLock.updateMany).toHaveBeenCalledWith({
      where: {
        jobKey: 'ab-test-run',
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: expect.any(Date) } }],
      },
      data: { lockedUntil: expect.any(Date), ownerToken: result },
    });
  });

  it('строка существует и удерживается другим прогоном (TTL не истёк) — updateMany не находит строк (count: 0), возвращает false', async () => {
    const prisma = prismaMock({
      createRejects: Object.assign(new Error('unique'), { code: 'P2002' }),
      updateManyCount: 0,
    });
    const result = await tryAcquireJobLock(prisma as never, 'feed-import-run');
    expect(result).toBe(false);
  });

  it('create() падает НЕ из-за уникальности (другая ошибка БД) — пробрасывается, не глотается как «замок занят»', async () => {
    const prisma = prismaMock({ createRejects: new Error('connection lost') });
    await expect(
      tryAcquireJobLock(prisma as never, 'catalog-batch-run'),
    ).rejects.toThrow('connection lost');
    expect(prisma.cronJobLock.updateMany).not.toHaveBeenCalled();
  });

  it('без явного ttlMs — использует JOB_LOCK_MS по умолчанию (lockedUntil ~= now + JOB_LOCK_MS)', async () => {
    const prisma = prismaMock({});
    const before = Date.now();
    await tryAcquireJobLock(prisma as never, 'catalog-batch-run');
    const arg = (prisma.cronJobLock.create as jest.Mock).mock.calls[0][0];
    const lockedUntilMs = (arg.data.lockedUntil as Date).getTime();
    // Допускаем небольшой разброс на время выполнения теста самого.
    expect(lockedUntilMs).toBeGreaterThanOrEqual(before + JOB_LOCK_MS - 1000);
    expect(lockedUntilMs).toBeLessThanOrEqual(before + JOB_LOCK_MS + 1000);
  });
});

describe('releaseJobLock', () => {
  it('снимает замок — updateMany с lockedUntil: null для этого jobKey', async () => {
    const prisma = prismaMock({});
    await releaseJobLock(prisma as never, 'catalog-batch-run');
    expect(prisma.cronJobLock.updateMany).toHaveBeenCalledWith({
      where: { jobKey: 'catalog-batch-run' },
      data: { lockedUntil: null, ownerToken: null },
    });
  });

  it('М-3.7: с токеном — снимает только СВОЙ замок (where.ownerToken)', async () => {
    const prisma = prismaMock({});
    await releaseJobLock(prisma as never, 'catalog-batch-run', 'tok-1');
    expect(prisma.cronJobLock.updateMany).toHaveBeenCalledWith({
      where: { jobKey: 'catalog-batch-run', ownerToken: 'tok-1' },
      data: { lockedUntil: null, ownerToken: null },
    });
  });

  it('updateMany падает — ошибка глотается (best-effort, не должна маскировать реальный результат джоба)', async () => {
    const prisma = {
      cronJobLock: {
        updateMany: jest.fn().mockRejectedValue(new Error('DB недоступна')),
      },
    };
    await expect(
      releaseJobLock(prisma as never, 'catalog-batch-run'),
    ).resolves.toBeUndefined();
  });
});
