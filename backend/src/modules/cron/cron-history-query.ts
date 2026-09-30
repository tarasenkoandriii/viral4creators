/**
 * Разбор и валидация query-параметров истории/сводки кронов
 * (`GET /api/admin/cron/history`, `GET /api/admin/cron/summary`).
 *
 * До этой правки история отдавала только последние 50 строк: у
 * двухминутных джобов это ≈1,5 часа, и проверить сутки целиком было
 * нельзя. Теперь — период (`since`/`until`), `limit` с потолком и
 * курсор `before` для подгрузки следующей страницы.
 */

import { BadRequestException } from '@nestjs/common';
import { CRON_LOG_RETENTION_DAYS } from './cron-retention';

export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 500;
/** Потолок периода сводки = срок хранения журнала
 * (`CRON_LOG_RETENTION_DAYS`): старше строк всё равно нет, запрос шире —
 * только лишняя нагрузка и заведомо «пропущенные» запуски. */
export const SUMMARY_MAX_SPAN_DAYS = CRON_LOG_RETENTION_DAYS;
export const SUMMARY_DEFAULT_SPAN_MS = 24 * 3_600_000;

/**
 * Дата `YYYY-MM-DD` (полночь UTC) или дата-время с ОБЯЗАТЕЛЬНОЙ зоной
 * (`Z` или `±HH:MM`): без зоны `Date.parse` трактует время как
 * локальное время сервера — у Vercel это UTC, локально — что угодно.
 */
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2})))?$/;

export function parseIsoParam(
  name: string,
  value: string | undefined,
): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const m = ISO_RE.exec(value);
  if (!m) {
    throw new BadRequestException(
      `${name}: ожидается ISO-дата (YYYY-MM-DD или YYYY-MM-DDTHH:MM[:SS]Z/±HH:MM)`,
    );
  }
  const [, y, mo, d, hh, mm, ss, offH, offM] = m;
  // `Date.parse('2026-02-31')` молча даёт 3 марта — сверяем компоненты.
  const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const componentsOk =
    probe.getUTCFullYear() === Number(y) &&
    probe.getUTCMonth() === Number(mo) - 1 &&
    probe.getUTCDate() === Number(d) &&
    (hh === undefined || Number(hh) <= 23) &&
    (mm === undefined || Number(mm) <= 59) &&
    (ss === undefined || Number(ss) <= 59) &&
    (offH === undefined || Number(offH) <= 14) &&
    (offM === undefined || Number(offM) <= 59);
  const ms = Date.parse(value);
  if (!componentsOk || Number.isNaN(ms)) {
    throw new BadRequestException(`${name}: некорректная дата "${value}"`);
  }
  return new Date(ms);
}

export function parseLimitParam(value: string | undefined): number {
  if (value === undefined || value === '') return HISTORY_DEFAULT_LIMIT;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new BadRequestException('limit: ожидается целое число ≥ 1');
  }
  return Math.min(Number(value), HISTORY_MAX_LIMIT);
}

/** Курсор — id строки CronRunLog (cuid): буквы/цифры, без спецсимволов. */
export function parseCursorParam(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new BadRequestException('before: некорректный курсор');
  }
  return value;
}

export interface CronHistoryQuery {
  jobKey?: string;
  since?: Date;
  until?: Date;
  limit: number;
  before?: string;
}

export function parseHistoryQuery(raw: {
  jobKey?: string;
  since?: string;
  until?: string;
  limit?: string;
  before?: string;
}): CronHistoryQuery {
  const since = parseIsoParam('since', raw.since);
  const until = parseIsoParam('until', raw.until);
  if (since && until && since.getTime() >= until.getTime()) {
    throw new BadRequestException('since должен быть раньше until');
  }
  return {
    jobKey: raw.jobKey ? raw.jobKey : undefined,
    since,
    until,
    limit: parseLimitParam(raw.limit),
    before: parseCursorParam(raw.before),
  };
}

export interface CronSummaryQuery {
  since: Date;
  until: Date;
}

/** Без параметров — последние 24 часа; с одним — сутки от/до него. */
export function parseSummaryQuery(
  raw: { since?: string; until?: string },
  now: Date = new Date(),
): CronSummaryQuery {
  const parsedSince = parseIsoParam('since', raw.since);
  const parsedUntil = parseIsoParam('until', raw.until);
  const until =
    parsedUntil ??
    (parsedSince
      ? new Date(parsedSince.getTime() + SUMMARY_DEFAULT_SPAN_MS)
      : now);
  const since =
    parsedSince ?? new Date(until.getTime() - SUMMARY_DEFAULT_SPAN_MS);
  if (since.getTime() >= until.getTime()) {
    throw new BadRequestException('since должен быть раньше until');
  }
  if (until.getTime() - since.getTime() > SUMMARY_MAX_SPAN_DAYS * 86_400_000) {
    throw new BadRequestException(
      `период сводки не длиннее ${SUMMARY_MAX_SPAN_DAYS} дней`,
    );
  }
  return { since, until };
}
