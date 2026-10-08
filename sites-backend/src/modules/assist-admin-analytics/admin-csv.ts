/**
 * CSV выгрузок «Админки» (заход 10, №57; ТЗ §5-тер.7) — ЧИСТЫЙ модуль, своя
 * копия правил CSV «Сайта» (правило графа «Админка» ↛ assist-analytics):
 * UTF-8 с BOM (кириллица в Excel), разделитель `,`, CRLF; ЗАЩИТА от
 * CSV-инъекции — строковая ячейка, начинающаяся с `=`, `+`, `-`, `@`,
 * табуляции или перевода строки, получает ведущий апостроф (имя операции
 * API, роль из JWT заказчика — чужие данные); ячейка с `,`/`;`/`"`/переводом
 * строки — в кавычках, кавычки удваиваются.
 */
export const ADMIN_CSV_BOM = '﻿';

const FORMULA_START = /^[=+\-@\t\r\n]/;

export type AdminCsvCell = string | number | boolean | null;

export function adminCsvCell(value: AdminCsvCell): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    s = String(value);
  } else if (typeof value === 'boolean') {
    s = value ? 'true' : 'false';
  } else {
    s = value;
    if (FORMULA_START.test(s)) s = `'${s}`;
  }
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function adminCsv(header: string[], rows: AdminCsvCell[][]): string {
  const lines = [header.map((h) => adminCsvCell(h)).join(',')];
  for (const r of rows) lines.push(r.map((c) => adminCsvCell(c)).join(','));
  return `${ADMIN_CSV_BOM}${lines.join('\r\n')}\r\n`;
}
