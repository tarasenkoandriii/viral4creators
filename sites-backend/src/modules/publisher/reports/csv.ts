/**
 * AI Publisher — выгрузка списков P-E в CSV (проектный документ §11.1, ТЗ
 * §8.4): без контактов и шифрованных заметок (в этих списках их нет);
 * значения, начинающиеся с `=`, `+`, `-`, `@`, табуляции или CR,
 * экранируются префиксом `'` (защита от формул, аудит P3-27); выгрузка
 * пишет аудит `export` (вызывающий). Список, который умеет CSV, отвечает
 * сам (`@Res()`): перехватчик обернул бы файл в конверт.
 */
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { PUB_NO_STORE, validationError } from '../core/errors';
import { jsonSafe } from '../core/money';

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvOf(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly string[],
): string {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

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

/** `?format=` списка: json (умолчание) | csv; иное — 400. */
export function formatOf(v: unknown): 'json' | 'csv' {
  if (v === undefined || v === '' || v === 'json') return 'json';
  if (v === 'csv') return 'csv';
  throw validationError([{ field: 'format', code: 'enum' }]);
}
