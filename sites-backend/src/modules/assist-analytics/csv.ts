/**
 * CSV экспорта — A (ТЗ §5-тер.7). ЧИСТЫЙ модуль: UTF-8 с BOM (кириллица в
 * Excel), разделитель `,`, CRLF; ЗАЩИТА от CSV-инъекции — ячейка,
 * начинающаяся с `=`, `+`, `-`, `@`, табуляции или перевода строки,
 * получает ведущий апостроф (§5-тер.16 п.8: `=HYPERLINK(...)` из текста
 * посетителя — экранирована). Кавычки — удвоением, ячейка с `,`/`;`/`"`/
 * переводом строки — в кавычках.
 */
export const CSV_BOM = '﻿';

/** Начало ячейки, которое Excel/Sheets исполнит как формулу (§5-тер.7). */
const FORMULA_START = /^[=+\-@\t\r\n]/;

export function csvCell(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (typeof value === 'number') {
    // Число — данные кода, не формула; отрицательное «-5» не экранируем.
    if (!Number.isFinite(value)) return '';
    s = String(value);
  } else if (typeof value === 'boolean') {
    s = value ? 'true' : 'false';
  } else {
    s = value;
    // Строка (текст посетителя, failureNote, orderId) — враждебные данные:
    // ведущий апостроф, даже если после него «безобидное» продолжение.
    if (FORMULA_START.test(s)) s = `'${s}`;
  }
  // `;` — тоже в кавычки: Excel с украинской/русской локалью читает CSV с
  // разделителем `;`, и незакавыченная «a;=HYPERLINK(…)» распалась бы на
  // ячейку, начинающуюся с `=` (апостроф стоит только в начале строки).
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRows(
  header: string[],
  rows: Array<Array<string | number | boolean | null>>,
): string {
  const lines = [header.map((h) => csvCell(h)).join(',')];
  for (const r of rows) lines.push(r.map((c) => csvCell(c)).join(','));
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}
