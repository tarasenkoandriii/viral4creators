/**
 * AI Publisher, P-B1 — общие куски контроллеров кабинета контента:
 * списки с курсором и выгрузкой `?format=csv` (§11.1: без контактов и
 * приватного текста, значения-формулы экранированы, аудит `export`).
 *
 * Список, который умеет CSV, отвечает сам (`@Res()`): общий
 * `ResponseInterceptor` обернул бы файл в конверт. JSON такого списка —
 * тот же конверт `{success, data, meta}`, что ставит перехватчик.
 */
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  type ListPage,
} from '../contracts/common';
import { validationError } from '../core/errors';
import { jsonSafe } from '../core/money';
import { PUB_NO_STORE } from '../core/errors';
import { toCsv } from './rules';

export function sendEnvelope(res: Response, data: unknown, status = 200): void {
  res
    .status(status)
    .setHeader('Cache-Control', PUB_NO_STORE)
    .json({
      success: true,
      data: jsonSafe(data),
      meta: { timestamp: new Date().toISOString(), requestId: randomUUID() },
    });
}

export function sendCsv(res: Response, name: string, csv: string): void {
  res
    .status(200)
    .set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': PUB_NO_STORE,
      'Content-Disposition': `attachment; filename="publisher-${name}.csv"`,
    })
    .send(csv);
}

export function formatOf(v: unknown): 'json' | 'csv' {
  if (v === undefined || v === '' || v === 'json') return 'json';
  if (v === 'csv') return 'csv';
  throw validationError([{ field: 'format', code: 'enum' }]);
}

export function clampLimit(limit: number | undefined, csv: boolean): number {
  if (csv) return 5000;
  return Math.min(Math.max(limit ?? LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);
}

/** Страница по убыванию id (`before` — id последнего элемента прошлой страницы). */
export function pageOf<T extends { id: string }>(
  rows: T[],
  limit: number,
): ListPage<T> {
  const page = rows.slice(0, limit);
  return {
    items: page,
    nextBefore: rows.length > limit ? page[page.length - 1].id : null,
  };
}

export function csvOf<T>(
  items: readonly T[],
  columns: ReadonlyArray<[string, (x: T) => unknown]>,
): string {
  return toCsv(
    columns.map((c) => c[0]),
    items.map((x) => columns.map((c) => c[1](x))),
  );
}
