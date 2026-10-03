/**
 * Мемо для публичного кода «Сайта» (Э6-бис (е), ТЗ §5-бис.17 п.12) — под
 * ролью `assist_public` и ТОЛЬКО через представления миграции
 * `_assist_chains_memo`: опубликованные версии (`assist_site_memo_published`)
 * и версии на сухом прогоне (`assist_site_memo_checks`). Черновики,
 * история, индекс фраз и таблицы мемо роли не видны. Ровно этот SQL
 * сверяет `prisma/assist-public-role.spec.ts`.
 *
 * В загрузчик мемо не уходит: он получает шаги готового плана (как всегда).
 */
import {
  parseMemoContent,
  type MemoContent,
  type MemoView,
  type PublishedMemo,
} from '../../assist-ui-core/memo';
import type { PlanDb } from './plan-store';

const PUBLISHED = '"sites"."assist_site_memo_published"';
const CHECKS = '"sites"."assist_site_memo_checks"';
const PLANS = '"sites"."assist_site_ui_plans"';
const TESTS = '"sites"."assist_site_voice_tests"';

interface PublishedRow {
  memoId: string;
  number: number;
  key: string;
  listed: boolean;
  view: string;
  staleViews: string[] | null;
  version: number;
  content: unknown;
}

function viewOf(v: string): MemoView {
  return v === 'desktop' || v === 'mobile' ? v : 'any';
}

/** Содержимое версии строго заново (версия — данные, не доверяем форме). */
function contentOf(raw: unknown): MemoContent {
  return parseMemoContent(raw).content;
}

/** Опубликованные мемо сайта (только `published`; черновиков нет). */
export async function readPublishedMemos(
  db: PlanDb,
  siteId: string,
): Promise<PublishedMemo[]> {
  const rows = await db.$queryRawUnsafe<PublishedRow[]>(
    `SELECT "memoId", "number", "key", "listed", "view", "staleViews", "version", "content" FROM ${PUBLISHED} WHERE "siteId" = $1 ORDER BY "number" ASC LIMIT 200`,
    siteId,
  );
  return rows.map((r) => ({
    memoId: r.memoId,
    number: r.number,
    key: r.key,
    version: r.version,
    view: viewOf(r.view),
    listed: r.listed,
    staleViews: r.staleViews ?? [],
    content: contentOf(r.content),
  }));
}

/**
 * Мемо всё ещё опубликовано (проверка при каждом шаге, §5-бис.17 п.5 п.8):
 * выключено, «требует проверки», удалено — следующий шаг не исполняется.
 * Версию закреплённого плана новая публикация не меняет — смотрим только
 * «живо ли мемо».
 */
export async function memoAlive(
  db: PlanDb,
  p: { siteId: string; memoId: string },
): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ memoId: string }>>(
    `SELECT "memoId" FROM ${PUBLISHED} WHERE "siteId" = $1 AND "memoId" = $2`,
    p.siteId,
    p.memoId,
  );
  return rows.length > 0;
}

/**
 * «Я умею» (В-74, Р-72): доля `goalStatus = reached` за окно по мемо сайта
 * — из планов (табличный SELECT роли на планы, миграция _assist_voice_control).
 */
export async function memoGoalRates(
  db: PlanDb,
  p: { siteId: string; since: Date },
): Promise<Map<string, { runs: number; reached: number }>> {
  const rows = await db.$queryRawUnsafe<
    Array<{ memoId: string; runs: number; reached: number }>
  >(
    `SELECT "memoId", count(*)::int AS "runs", count(*) FILTER (WHERE "goalStatus" = 'reached')::int AS "reached"
       FROM ${PLANS}
      WHERE "siteId" = $1 AND "memoId" IS NOT NULL AND "goalStatus" IS NOT NULL
        AND "createdAt" > $2 AND "voiceTestId" IS NULL
      GROUP BY "memoId"`,
    p.siteId,
    p.since,
  );
  return new Map(rows.map((r) => [r.memoId, r]));
}

/** Версия мемо на сухом прогоне — по тестовой сессии мастера. */
export interface MemoCheckRow {
  id: string;
  memoId: string;
  version: number;
  number: number;
  key: string;
  content: MemoContent;
  contentHash: string;
}

export async function readMemoCheck(
  db: PlanDb,
  p: { siteId: string; testId: string },
): Promise<MemoCheckRow | null> {
  const t = await db.$queryRawUnsafe<Array<{ memoVersionId: string | null }>>(
    `SELECT "memoVersionId" FROM ${TESTS} WHERE "id" = $1 AND "siteId" = $2`,
    p.testId,
    p.siteId,
  );
  const vid = t[0]?.memoVersionId;
  if (!vid) return null;
  const rows = await db.$queryRawUnsafe<
    Array<Omit<MemoCheckRow, 'content'> & { content: unknown }>
  >(
    `SELECT "id", "memoId", "version", "number", "key", "content", "contentHash" FROM ${CHECKS} WHERE "id" = $1 AND "siteId" = $2`,
    vid,
    p.siteId,
  );
  const r = rows[0];
  return r ? { ...r, content: contentOf(r.content) } : null;
}
