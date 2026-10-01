/**
 * Замок крона sites-backend — K1 (своя копия идеи backend/src/common/
 * cron-job-lock.ts: нечистый модуль, контракт Э0 п.3). Таблица
 * `site_cron_locks`; взятие — ОДИН запрос `INSERT … ON CONFLICT DO UPDATE
 * … WHERE lockedUntil IS NULL OR lockedUntil < now()`: строка ещё не
 * существовала — вставка, свободна или просрочена — перехват, занята —
 * ноль строк (ни P2002, ни второго запроса, как у генератора). Время —
 * часы базы (`now()`), а не инстанса: у двух функций Vercel часы могут
 * разъехаться, у Postgres они одни.
 *
 * Снятие — в finally и только своим `holder` (токен взятия): тик, чей
 * замок истёк и был перехвачен, не снимет чужой.
 *
 * Не advisory-lock: пулер Supabase в transaction-режиме не держит сессию
 * между запросами (довод генератора, там же).
 *
 * Пользуются кроны Э1: assist-crawl-run (K1), assist-embed-run (K2),
 * assist-retention (K3).
 */
import { randomUUID } from 'crypto';
import type { PrismaService } from '../prisma/prisma.service';
import { SITES_DB_SCHEMA } from '../prisma/prisma.service';

export interface CronLockResult<T> {
  /** false — замок занят другим тиком, `fn` не вызывалась. */
  ran: boolean;
  result?: T;
}

const T = `"${SITES_DB_SCHEMA}"."site_cron_locks"`;

/** Взять замок; токен владельца или null, если занят. */
export async function tryAcquireCronLock(
  db: Pick<PrismaService, '$queryRawUnsafe'>,
  jobKey: string,
  ttlMs: number,
): Promise<string | null> {
  const holder = randomUUID();
  const ttl = Math.max(1, Math.ceil(ttlMs));
  const rows = await db.$queryRawUnsafe<Array<{ holder: string }>>(
    `INSERT INTO ${T} ("jobKey", "lockedUntil", "holder", "lastStartedAt")
     VALUES ($1, now() + ($3::int * interval '1 millisecond'), $2, now())
     ON CONFLICT ("jobKey") DO UPDATE
       SET "lockedUntil" = EXCLUDED."lockedUntil",
           "holder" = EXCLUDED."holder",
           "lastStartedAt" = EXCLUDED."lastStartedAt"
     WHERE ${T}."lockedUntil" IS NULL OR ${T}."lockedUntil" < now()
     RETURNING "holder"`,
    jobKey,
    holder,
    ttl,
  );
  return rows.length > 0 && rows[0].holder === holder ? holder : null;
}

/** Снять свой замок (чужой — не трогаем). */
export async function releaseCronLock(
  db: Pick<PrismaService, '$executeRawUnsafe'>,
  jobKey: string,
  holder: string,
  error: string | null,
): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE ${T}
        SET "lockedUntil" = NULL, "holder" = NULL,
            "lastFinishedAt" = now(), "lastError" = $3
      WHERE "jobKey" = $1 AND "holder" = $2`,
    jobKey,
    holder,
    error === null ? null : error.slice(0, 2000),
  );
}

export async function withCronLock<T>(
  db: PrismaService,
  jobKey: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<CronLockResult<T>> {
  const holder = await tryAcquireCronLock(db, jobKey, ttlMs);
  if (!holder) return { ran: false };
  let error: string | null = null;
  try {
    const result = await fn();
    return { ran: true, result };
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    throw e;
  } finally {
    // Снятие не должно подменять ошибку джоба ошибкой базы.
    await releaseCronLock(db, jobKey, holder, error).catch(() => undefined);
  }
}
