/**
 * П-Г5 (Р-З10-5) на НАСТОЯЩЕМ Postgres: атомарный резерв дневного бюджета
 * консультанта — advisory-lock на сутки + строки «в полёте» в
 * `rate_limits` (без миграции backend).
 *
 * Строка базы — как у `greeting-snapshot-write.pg.spec.ts`:
 * `ASSISTANT_BUDGET_PG_URL`, иначе `GREETING_SNAPSHOT_PG_URL` (его ci.yml
 * передаёт шагу jest джобы backend), а в CI — `DATABASE_URL`. Без строки
 * набор пропускается (`describe.skip` — число тестов в отчёте jest то же),
 * при `CI=true` без строки — провал.
 *
 * Каждый тест работает в своих сутках далеко в будущем — с чужими
 * строками `ai_usage`/`rate_limits` не пересекается; свои строки удаляет.
 */
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ASSISTANT_BUDGET_KEY_PREFIX,
  ASSISTANT_RESERVE_TTL_MS,
  commitAssistantReserve,
  releaseAssistantBudget,
  reserveAssistantBudget,
} from './assistant-budget';

const IN_CI = process.env.CI === 'true';
const URL =
  process.env.ASSISTANT_BUDGET_PG_URL ??
  process.env.GREETING_SNAPSHOT_PG_URL ??
  (IN_CI ? process.env.DATABASE_URL : undefined);

function maybe(name: string, body: () => void): void {
  if (!URL && IN_CI) {
    describe(name, () => {
      it('строка базы задана', () => {
        throw new Error(
          `CI=true, но строка базы не задана — «${name}» не выполнился`,
        );
      });
    });
    return;
  }
  (URL ? describe : describe.skip)(name, body);
}

maybe('П-Г5: резерв бюджета консультанта на настоящем Postgres', () => {
  let prisma: PrismaService;
  const usageIds: string[] = [];
  const days: string[] = [];

  /** Свои сутки на тест: 2031-01-01 + n дней, полдень UTC. */
  function dayNoon(n: number): Date {
    const d = new Date(Date.UTC(2031, 0, 1 + n, 12));
    days.push(d.toISOString().slice(0, 10));
    return d;
  }

  async function spend(at: Date, micro: number): Promise<void> {
    const id = `pg5-${randomUUID()}`;
    usageIds.push(id);
    await prisma.aiUsage.create({
      data: {
        id,
        provider: 'gemini',
        operation: 'assistant',
        model: 'gemini-test',
        costMicroUsd: micro,
        pricingVersion: 'test',
        anonymous: true,
        createdAt: at,
      },
    });
  }

  async function inFlightRows(day: Date): Promise<number> {
    const prefix = `${ASSISTANT_BUDGET_KEY_PREFIX}${day.toISOString().slice(0, 10)}:%`;
    const r = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM "rate_limits" WHERE "key" LIKE ${prefix}
    `;
    return Number(r[0]?.n ?? 0);
  }

  /**
   * Предикат штатной чистки `pruneRateLimits` (окно закрылось час назад),
   * но только по своим строкам: сама `pruneRateLimits` с датой из 2031
   * стёрла бы весь `rate_limits` общей базы CI.
   */
  async function pruneOwn(day: Date, now: Date): Promise<void> {
    const prefix = `${ASSISTANT_BUDGET_KEY_PREFIX}${day.toISOString().slice(0, 10)}:%`;
    const cutoff = new Date(now.getTime() - 3_600_000);
    await prisma.$executeRaw`
      DELETE FROM "rate_limits" WHERE "key" LIKE ${prefix} AND "windowStart" < ${cutoff}
    `;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    if (usageIds.length) {
      await prisma.$executeRaw`DELETE FROM "ai_usage" WHERE "id" = ANY(${usageIds}::text[])`;
    }
    for (const d of days) {
      const prefix = `${ASSISTANT_BUDGET_KEY_PREFIX}${d}:%`;
      await prisma.$executeRaw`DELETE FROM "rate_limits" WHERE "key" LIKE ${prefix}`;
    }
    await prisma.$disconnect();
  });

  it('10 параллельных резервов при остатке на 2 → ровно 2 проходят', async () => {
    const now = dayNoon(0);
    await spend(new Date(now.getTime() - 3_600_000), 1_000_000);
    // Остаток 2 500 µ$, оценка 1 000 — влезают ровно два.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        reserveAssistantBudget(prisma, {
          budgetMicroUsd: 1_002_500,
          estimateMicroUsd: 1_000,
          now,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(await inFlightRows(now)).toBe(2);
    const denied = results.find((r) => !r.ok);
    expect(denied).toMatchObject({
      ok: false,
      spentMicroUsd: 1_000_000,
      inFlightMicroUsd: 2_000,
    });
  });

  it('снятие резерва освобождает место; повторное снятие — без ошибки', async () => {
    const now = dayNoon(1);
    const a = await reserveAssistantBudget(prisma, {
      budgetMicroUsd: 1_500,
      estimateMicroUsd: 1_000,
      now,
    });
    expect(a.ok).toBe(true);
    const b = await reserveAssistantBudget(prisma, {
      budgetMicroUsd: 1_500,
      estimateMicroUsd: 1_000,
      now,
    });
    expect(b.ok).toBe(false);
    if (!a.ok) throw new Error('unreachable');
    await expect(releaseAssistantBudget(prisma, a.key)).resolves.toBe(true);
    await expect(releaseAssistantBudget(prisma, a.key)).resolves.toBe(true);
    const c = await reserveAssistantBudget(prisma, {
      budgetMicroUsd: 1_500,
      estimateMicroUsd: 1_000,
      now,
    });
    expect(c.ok).toBe(true);
  });

  it('резерв старше TTL (процесс не дожил до снятия) больше не учитывается', async () => {
    const now = dayNoon(2);
    const stale = new Date(now.getTime() - ASSISTANT_RESERVE_TTL_MS - 1_000);
    const old = await reserveAssistantBudget(prisma, {
      budgetMicroUsd: 1_500,
      estimateMicroUsd: 1_000,
      now: stale,
    });
    expect(old.ok).toBe(true);
    const fresh = await reserveAssistantBudget(prisma, {
      budgetMicroUsd: 1_500,
      estimateMicroUsd: 1_000,
      now,
    });
    expect(fresh).toMatchObject({ ok: true });
  });

  it('P2-1: резерв оборванного после токена вопроса — расход до конца суток: через 6 мин учитывается, чистка не трогает', async () => {
    const now = dayNoon(4);
    const a = await reserveAssistantBudget(prisma, {
      budgetMicroUsd: 1_500,
      estimateMicroUsd: 1_000,
      now,
    });
    if (!a.ok) throw new Error('резерв не прошёл');
    await expect(commitAssistantReserve(prisma, a.key, now)).resolves.toBe(
      true,
    );
    const later = new Date(now.getTime() + 6 * 60_000);
    expect(later.getTime() - now.getTime()).toBeGreaterThan(
      ASSISTANT_RESERVE_TTL_MS,
    );
    await pruneOwn(now, later);
    expect(await inFlightRows(now)).toBe(1);
    expect(
      await reserveAssistantBudget(prisma, {
        budgetMicroUsd: 1_500,
        estimateMicroUsd: 1_000,
        now: later,
      }),
    ).toMatchObject({ ok: false, inFlightMicroUsd: 1_000 });
    // Конец суток: строка уходит в чистку через час после полуночи.
    const nextDay = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        2,
      ),
    );
    expect(
      await reserveAssistantBudget(prisma, {
        budgetMicroUsd: 1_500,
        estimateMicroUsd: 1_000,
        now: nextDay,
      }),
    ).toMatchObject({ ok: true });
    days.push(nextDay.toISOString().slice(0, 10));
    await pruneOwn(now, nextDay);
    expect(await inFlightRows(now)).toBe(0);
  });

  it('расход и резервы других суток не учитываются; расход этих — учитывается', async () => {
    const now = dayNoon(3);
    const yesterday = new Date(now.getTime() - 24 * 3_600_000);
    await spend(yesterday, 5_000_000);
    expect(
      await reserveAssistantBudget(prisma, {
        budgetMicroUsd: 1_000_000,
        estimateMicroUsd: 1_000,
        now: yesterday,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await reserveAssistantBudget(prisma, {
        budgetMicroUsd: 1_000_000,
        estimateMicroUsd: 1_000,
        now,
      }),
    ).toMatchObject({ ok: true });
    await spend(now, 999_500);
    expect(
      await reserveAssistantBudget(prisma, {
        budgetMicroUsd: 1_000_000,
        estimateMicroUsd: 1_000,
        now,
      }),
    ).toMatchObject({ ok: false, spentMicroUsd: 999_500 });
  });
});
