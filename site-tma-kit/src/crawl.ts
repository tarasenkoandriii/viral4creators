/**
 * Обход сайта глазами кабинета: статус прогона и причины пропуска страниц.
 *
 * Общий с QA-TMA: модуль `site-crawl` на сервере один на оба продукта
 * (контракт Э1 §1 п.1), и причины пропуска («robots», «noindex», «SPA»…)
 * человек должен видеть одинаково в обоих кабинетах — поэтому разбор и
 * тексты живут в ките, а не в приложении.
 *
 * Список `SKIP_REASONS` — зеркало `SkipReason` из
 * `sites-backend/src/modules/site-crawl/types.ts`; `assist/scripts/crawl.test.ts`
 * читает тот файл и падает при расхождении.
 */

import type { Dictionary } from './dictionaries/ru';

export const SKIP_REASONS = [
  'robots',
  'noindex',
  'not_html',
  'too_large',
  'redirect_offsite',
  'ssrf',
  'excluded',
  'limit',
  'http_4xx',
  'http_5xx',
  'timeout',
  'empty',
  'duplicate',
  'opted_out',
  'unverified_host',
  'not_https',
  'spa',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
/** `other` — причина, которой фронт ещё не знает (сервер новее). */
export type SkipReasonKey = SkipReason | 'other';

export const CRAWL_RUN_STATUSES = [
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
] as const;
export type CrawlRunStatus = (typeof CRAWL_RUN_STATUSES)[number];

/** Прогон обхода — форма `CrawlRunView` сервера. */
export interface CrawlRunView {
  id: string;
  status: CrawlRunStatus;
  trigger: string;
  mode: string;
  pagesSeen: number;
  pagesChanged: number;
  pagesUnchanged: number;
  pagesSkipped: number;
  pagesFailed: number;
  pagesGone: number;
  skippedByReason: Partial<Record<SkipReasonKey, number>>;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;

/** Счётчик: целое ≥ 0, всё прочее — 0 (а не NaN в интерфейсе). */
export function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : 0;
}

export function isSkipReason(v: unknown): v is SkipReason {
  return (
    typeof v === 'string' && (SKIP_REASONS as readonly string[]).includes(v)
  );
}

/**
 * `{ robots: 3, нечто: 2 }` → `{ robots: 3, other: 2 }`. Неизвестная
 * причина не теряется: «пропущено 12, почему — списком» (ТЗ §3.4) должно
 * сходиться по сумме, даже если сервер добавил причину раньше фронта.
 */
export function parseSkippedByReason(
  v: unknown
): Partial<Record<SkipReasonKey, number>> {
  const out: Partial<Record<SkipReasonKey, number>> = {};
  for (const [k, raw] of Object.entries(obj(v))) {
    const n = toCount(raw);
    if (!n) continue;
    const key: SkipReasonKey = isSkipReason(k) ? k : 'other';
    out[key] = (out[key] ?? 0) + n;
  }
  return out;
}

/** Причины по убыванию — для списка «почему пропущено». */
export function sortedSkips(
  m: Partial<Record<SkipReasonKey, number>>
): Array<{ reason: SkipReasonKey; n: number }> {
  return (Object.entries(m) as Array<[SkipReasonKey, number]>)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => ({ reason, n }))
    .sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason));
}

/** Прогон без id — не прогон (null), а не «пустой зелёный». */
export function parseCrawlRun(v: unknown): CrawlRunView | null {
  const o = obj(v);
  const id = strOrNull(o.id);
  if (!id) return null;
  const status = (CRAWL_RUN_STATUSES as readonly string[]).includes(
    o.status as string
  )
    ? (o.status as CrawlRunStatus)
    : // Неизвестный статус — «в очереди»: не «готово» и не «ошибка».
      'queued';
  return {
    id,
    status,
    trigger: typeof o.trigger === 'string' ? o.trigger : '',
    mode: typeof o.mode === 'string' ? o.mode : '',
    pagesSeen: toCount(o.pagesSeen),
    pagesChanged: toCount(o.pagesChanged),
    pagesUnchanged: toCount(o.pagesUnchanged),
    pagesSkipped: toCount(o.pagesSkipped),
    pagesFailed: toCount(o.pagesFailed),
    pagesGone: toCount(o.pagesGone),
    skippedByReason: parseSkippedByReason(o.skippedByReason),
    startedAt: strOrNull(o.startedAt),
    finishedAt: strOrNull(o.finishedAt),
    error: strOrNull(o.error),
  };
}

/** Прогон ещё идёт — экран опрашивает сервер. */
export function crawlActive(run: CrawlRunView | null): boolean {
  return !!run && (run.status === 'queued' || run.status === 'running');
}

/**
 * Причина пропуска страницы (из прогона или документа) → текст. Строка
 * не из списка — «другая причина», а не сырой код сервера.
 */
export function skipReasonText(reason: unknown, dict: Dictionary): string {
  return isSkipReason(reason) ? dict.crawl.skip[reason] : dict.crawl.skip.other;
}
