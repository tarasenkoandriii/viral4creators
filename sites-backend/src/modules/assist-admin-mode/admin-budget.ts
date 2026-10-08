/**
 * Суточный денежный потолок «Админки» сайта (аудит Э7; ТЗ §7.3): сумма
 * `costMicroUsd` ответов сотрудников за UTC-сутки и расходов голосового
 * управления «Админкой» и lite-выбора мемо АМ-N (`site_ai_usage`, операции
 * ниже). Один расчёт на всех: ход чата (AdminChatService) и выбор мемо
 * моделью (AdminMemoService) не должны разойтись в том, что считать.
 * Заход 9 (Р-З9-15): ход чата — РЕЗЕРВ до вызова модели (строка `admin`
 * сайта и общая строка платформы в assist_budget_days, одна транзакция).
 */
import type { SitesDb } from '../../prisma/sites-db.service';
import { estimateCost } from '../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../shared/gemini-model';
import { geminiOutputCeiling } from '../site-ai/gemini-output';

type Db = ReturnType<SitesDb['forAccount']>;

/**
 * Операции `site_ai_usage`, которые платит суточный потолок «Админки».
 * Заход 10 (№57): разметка диалогов и выводы недели «Админки» — тот же
 * потолок (резерв `reserveAdminTurn` с долей потолка, admin-analytics-env).
 */
export const ADMIN_DAILY_USAGE_OPERATIONS = [
  'assist-admin-stt',
  'assist-admin-ui-plan',
  'assist-admin-memo',
  'assist-admin-label',
  'assist-admin-insight',
] as const;

/** Начало UTC-суток. */
export function utcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Потрачено «Админкой» сайта с начала UTC-суток, микродоллары. */
export async function adminSpentToday(
  db: Db,
  siteId: string,
  now: Date,
): Promise<number> {
  const day = utcDay(now);
  const [chat, usage] = await Promise.all([
    db.assistAdminMessage.aggregate({
      where: { siteId, createdAt: { gte: day } },
      _sum: { costMicroUsd: true },
    }),
    db.siteAiUsage.aggregate({
      where: {
        siteId,
        operation: { in: [...ADMIN_DAILY_USAGE_OPERATIONS] },
        createdAt: { gte: day },
      },
      _sum: { costMicroUsd: true },
    }),
  ]);
  return (chat._sum.costMicroUsd ?? 0) + (usage._sum.costMicroUsd ?? 0);
}

// ── Резерв хода (аудит Э7 (7), Р-З9-15) ──────────────────────────────────

/** Строка суточного резерва «Админки» сайта в assist_budget_days. */
export const ADMIN_BUDGET_SCOPE = 'admin';
/** Строка платформы — та же, что у ответов «Сайта» (общий суточный потолок). */
const PLATFORM_SCOPE = 'platform';
const PLATFORM_KEY = 'all';
const DAYS = '"sites"."assist_budget_days"';

/** Клиент с сырым SQL и транзакцией (PrismaService). */
export interface AdminBudgetDb {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $transaction<T>(fn: (tx: AdminBudgetDb) => Promise<T>): Promise<T>;
}

export interface AdminTurnReservation {
  siteId: string;
  day: string;
  est: number;
}

class Denied extends Error {
  constructor(readonly kind: 'site' | 'platform') {
    super(kind);
  }
}

/**
 * Оценка хода СВЕРХУ: до двух планов (повтор при ошибке параметров) и
 * ответ; вход — потолок промпта (каталог, история, 6 фрагментов знаний,
 * до 3 блоков данных API), выход — `geminiOutputCeiling` видимого ответа
 * (размышления модели платятся по ставке выхода). Нет ставки — не ноль.
 */
export function adminTurnEstimateMicroUsd(
  model: string = GEMINI_MODEL,
): number {
  const plan = estimateCost(model, {
    inputTokens: 12_000,
    outputTokens: geminiOutputCeiling(400),
  }).costMicroUsd;
  const answer = estimateCost(model, {
    inputTokens: 24_000,
    outputTokens: geminiOutputCeiling(900),
  }).costMicroUsd;
  return Math.max(1_000, Math.ceil(2 * plan + answer));
}

/**
 * Факт дня «Админки» сайта тем же счётом, что `adminSpentToday` (ответы
 * сотрудников + операции `ADMIN_DAILY_USAGE_OPERATIONS`), но сырым SQL в
 * переданной транзакции — его читает резерв ПОД блокировкой строки дня.
 */
export async function adminSpentTodayRaw(
  db: Pick<AdminBudgetDb, '$queryRawUnsafe'>,
  siteId: string,
  now: Date,
): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ spent: bigint | number }>>(
    `SELECT
       COALESCE((SELECT SUM("costMicroUsd") FROM "sites"."assist_admin_messages"
                  WHERE "siteId" = $1 AND "createdAt" >= $2), 0)
     + COALESCE((SELECT SUM("costMicroUsd") FROM "sites"."site_ai_usage"
                  WHERE "siteId" = $1 AND "createdAt" >= $2
                    AND "operation" = ANY($3::text[])), 0) AS spent`,
    siteId,
    utcDay(now),
    [...ADMIN_DAILY_USAGE_OPERATIONS],
  );
  return Number(rows[0]?.spent ?? 0);
}

/** Строка дня `admin/<siteId>`: резервы в полёте + оценки сорвавшихся ходов. */
export async function adminBudgetRowMicroUsd(
  db: Pick<AdminBudgetDb, '$queryRawUnsafe'>,
  siteId: string,
  now: Date,
): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ v: bigint | number }>>(
    `SELECT "spentMicroUsd" + "reservedMicroUsd" AS v FROM ${DAYS}
      WHERE "scope" = '${ADMIN_BUDGET_SCOPE}' AND "key" = $1 AND "day" = $2`,
    siteId,
    now.toISOString().slice(0, 10),
  );
  return Number(rows[0]?.v ?? 0);
}

/**
 * Резерв хода ДО вызова модели — одной транзакцией (порядок блокировок:
 * строка «Админки» сайта, затем платформы — как у «Сайта»):
 *  1. сайт: строка `admin/<siteId>` берётся `FOR UPDATE`, и ТОЛЬКО ПОД ЭТОЙ
 *     блокировкой читается факт дня (`adminSpentTodayRaw`): параллельный
 *     ход ждёт блокировку и видит и резерв предыдущего, и его факт (ответ
 *     пишется до снятия резерва) — окна «прочитал до транзакции» нет;
 *     условие — `факт + spent строки (оценки сорвавшихся ходов) + reserved
 *     + est ≤ потолок`;
 *  2. платформа: та же строка `platform/all`, что у ответов «Сайта»:
 *     `spent + reserved + est ≤ потолок платформы` — потолок платформы
 *     покрывает и «Админку».
 * 0 строк у любого — откат, отказ. Снятие — `settleAdminTurn`.
 */
export async function reserveAdminTurn(
  db: AdminBudgetDb,
  p: {
    siteId: string;
    siteCapMicroUsd: number;
    platformCapMicroUsd: number;
    estMicroUsd: number;
    now: Date;
  },
): Promise<
  | { ok: true; reservation: AdminTurnReservation }
  | { ok: false; denied: 'site' | 'platform' }
> {
  const day = p.now.toISOString().slice(0, 10);
  const est = Math.max(1, Math.ceil(p.estMicroUsd));
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO ${DAYS} ("scope", "key", "day", "updatedAt")
         VALUES ($1, $2, $3, now()), ($4, $5, $3, now())
         ON CONFLICT DO NOTHING`,
        ADMIN_BUDGET_SCOPE,
        p.siteId,
        day,
        PLATFORM_SCOPE,
        PLATFORM_KEY,
      );
      await tx.$queryRawUnsafe(
        `SELECT 1 FROM ${DAYS}
          WHERE "scope" = '${ADMIN_BUDGET_SCOPE}' AND "key" = $1 AND "day" = $2
          FOR UPDATE`,
        p.siteId,
        day,
      );
      const fact = await adminSpentTodayRaw(tx, p.siteId, p.now);
      const site = await tx.$executeRawUnsafe(
        `UPDATE ${DAYS} SET "reservedMicroUsd" = "reservedMicroUsd" + $3, "updatedAt" = now()
          WHERE "scope" = '${ADMIN_BUDGET_SCOPE}' AND "key" = $1 AND "day" = $2
            AND $4 + "spentMicroUsd" + "reservedMicroUsd" + $3 <= $5`,
        p.siteId,
        day,
        est,
        Math.max(0, Math.floor(fact)),
        Math.max(0, Math.floor(p.siteCapMicroUsd)),
      );
      if (site !== 1) throw new Denied('site');
      const platform = await tx.$executeRawUnsafe(
        `UPDATE ${DAYS} SET "reservedMicroUsd" = "reservedMicroUsd" + $3, "updatedAt" = now()
          WHERE "scope" = '${PLATFORM_SCOPE}' AND "key" = $1 AND "day" = $2
            AND "spentMicroUsd" + "reservedMicroUsd" + $3 <= $4`,
        PLATFORM_KEY,
        day,
        est,
        Math.max(0, Math.floor(p.platformCapMicroUsd)),
      );
      if (platform !== 1) throw new Denied('platform');
    });
  } catch (e) {
    if (e instanceof Denied) return { ok: false, denied: e.kind };
    throw e;
  }
  return { ok: true, reservation: { siteId: p.siteId, day, est } };
}

/**
 * Снятие резерва после хода — резерв не «висит» ни в каком исходе:
 *  - ход записан (`actualMicroUsd` — факт): у сайта `reserved -= est` (факт
 *    уже в `costMicroUsd` ответа — его считает `adminSpentTodayRaw`), у
 *    платформы `reserved -= est, spent += факт`;
 *  - ход сорвался после вызова модели (`actualMicroUsd = null`): деньги,
 *    вероятно, потрачены, а в ответ не записаны — оценка переносится в
 *    `spent` обеих строк (строже, а не мягче).
 * Вызывается ПОСЛЕ записи ответа — окна, где ход не виден ни резервом, ни
 * фактом, нет.
 */
export async function settleAdminTurn(
  db: AdminBudgetDb,
  r: AdminTurnReservation,
  actualMicroUsd: number | null,
): Promise<void> {
  const failed = actualMicroUsd === null || !Number.isFinite(actualMicroUsd);
  const actual = failed ? r.est : Math.max(0, Math.round(actualMicroUsd));
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE ${DAYS}
          SET "reservedMicroUsd" = GREATEST(0, "reservedMicroUsd" - $3),
              "spentMicroUsd" = "spentMicroUsd" + $4, "updatedAt" = now()
        WHERE "scope" = '${ADMIN_BUDGET_SCOPE}' AND "key" = $1 AND "day" = $2`,
      r.siteId,
      r.day,
      r.est,
      failed ? r.est : 0,
    );
    await tx.$executeRawUnsafe(
      `UPDATE ${DAYS}
          SET "reservedMicroUsd" = GREATEST(0, "reservedMicroUsd" - $3),
              "spentMicroUsd" = "spentMicroUsd" + $4, "updatedAt" = now()
        WHERE "scope" = '${PLATFORM_SCOPE}' AND "key" = $1 AND "day" = $2`,
      PLATFORM_KEY,
      r.day,
      r.est,
      actual,
    );
  });
}
