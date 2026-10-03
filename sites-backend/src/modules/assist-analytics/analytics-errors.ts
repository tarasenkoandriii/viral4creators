/**
 * Машинные коды кабинета целей/статистики и вебхука s2s (контракт Э3 §6
 * «Коды ошибок», A). Форма исключения — как у Э1/Э2 (`setupError`):
 * `{ error: CODE, code: CODE, message }` — фильтр приложения кладёт код в
 * `error.code`. Сверх списка контракта: `BAD_REQUEST` (тело не той формы),
 * `RATE_LIMITED` (вебхук, 429 — §6), `FORBIDDEN`/`NOT_FOUND` — права и
 * чужой сайт (как у всего кабинета).
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { AnalyticsErrorCode } from './api-types';

export type AnalyticsCode =
  | AnalyticsErrorCode
  | 'GOAL_ORDER_ID_INVALID'
  | 'BAD_REQUEST'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'NOT_FOUND';

export function analyticsError(
  status: HttpStatus,
  code: AnalyticsCode,
  message: string,
  extra: {
    errors?: Array<{ path: string; code: string }>;
    [k: string]: unknown;
  } = {},
): HttpException {
  return new HttpException({ error: code, code, message, ...extra }, status);
}

/** Код из исключения (тесты). */
export function analyticsCodeOf(e: unknown): string | undefined {
  if (!(e instanceof HttpException)) return undefined;
  const body = e.getResponse();
  return body && typeof body === 'object'
    ? ((body as { code?: unknown }).code as string | undefined)
    : undefined;
}

export const notFoundSite = (): HttpException =>
  analyticsError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Сайт не найден');

export const forbidden = (message: string): HttpException =>
  analyticsError(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);
