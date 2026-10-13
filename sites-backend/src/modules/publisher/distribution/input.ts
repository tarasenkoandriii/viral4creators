/**
 * AI Publisher, P-C — разбор тел запросов (поля → `PUB_VALIDATION {fields}`)
 * и общие мелочи зоны: суммы `MinorJson`, даты ISO, https-адреса, текст без
 * контактов (`pii-guard`, §6.1), CSV-выгрузка списков (§11.1).
 */
import type { FieldIssue } from '../contracts/errors';
import type { Minor } from '../contracts/common';
import { validationError } from '../core/errors';
import { CURRENCY_RE, FX_RATE_RE, parseMinor } from '../core/money';
import { looksLikeContact } from '../core/pii-guard';

export type Body = Record<string, unknown>;

export function bodyOf(v: unknown): Body {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw validationError([{ field: '$', code: 'type' }]);
  }
  return v as Body;
}

/** Сборщик ошибок полей: все сразу, а не по одной. */
export class Fields {
  readonly issues: FieldIssue[] = [];

  add(field: string, code: string): void {
    this.issues.push({ field, code });
  }

  done(): void {
    if (this.issues.length) throw validationError(this.issues);
  }

  /** Строка 1..max; `optional` — undefined/null допустимы (→ null). */
  str(
    b: Body,
    field: string,
    max: number,
    opts: { optional?: boolean; pii?: boolean } = {},
  ): string | null {
    const v = b[field];
    if (v === undefined || v === null) {
      if (!opts.optional) this.add(field, 'required');
      return null;
    }
    if (typeof v !== 'string') {
      this.add(field, 'type');
      return null;
    }
    const t = v.trim();
    if (!t) {
      if (!opts.optional) this.add(field, 'required');
      return null;
    }
    if ([...t].length > max) {
      this.add(field, 'length');
      return null;
    }
    if (opts.pii !== false && looksLikeContact(t)) {
      this.add(field, 'pii');
      return null;
    }
    return t;
  }

  minor(
    b: Body,
    field: string,
    opts: { optional?: boolean; positive?: boolean; signed?: boolean } = {},
  ): Minor | null {
    const v = b[field];
    if (v === undefined || v === null) {
      if (!opts.optional) this.add(field, 'required');
      return null;
    }
    const m = parseMinor(v);
    if (m === null) {
      this.add(field, 'type');
      return null;
    }
    if (!opts.signed && m < 0n) {
      this.add(field, 'range');
      return null;
    }
    if (opts.positive && m <= 0n) {
      this.add(field, 'range');
      return null;
    }
    if (opts.signed && m === 0n) {
      this.add(field, 'range');
      return null;
    }
    return m;
  }

  date(b: Body, field: string, opts: { optional?: boolean } = {}): Date | null {
    const v = b[field];
    if (v === undefined || v === null) {
      if (!opts.optional) this.add(field, 'required');
      return null;
    }
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v)) {
      this.add(field, 'format');
      return null;
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      this.add(field, 'format');
      return null;
    }
    return d;
  }

  bool(b: Body, field: string): boolean | null | undefined {
    const v = b[field];
    if (v === undefined) return undefined;
    if (v === null || typeof v === 'boolean') return v;
    this.add(field, 'type');
    return undefined;
  }

  oneOf<T extends string>(
    b: Body,
    field: string,
    list: readonly T[],
    opts: { optional?: boolean } = {},
  ): T | null {
    const v = b[field];
    if (v === undefined || v === null) {
      if (!opts.optional) this.add(field, 'required');
      return null;
    }
    if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) {
      this.add(field, 'enum');
      return null;
    }
    return v as T;
  }

  https(
    b: Body,
    field: string,
    opts: { optional?: boolean } = {},
  ): string | null {
    const v = this.str(b, field, 2048, { ...opts, pii: false });
    if (v === null) return null;
    if (!isHttpsUrl(v)) {
      this.add(field, 'format');
      return null;
    }
    return v;
  }

  id(b: Body, field: string, opts: { optional?: boolean } = {}): string | null {
    return this.str(b, field, 100, { ...opts, pii: false });
  }

  currency(b: Body, field: string): string | null {
    const v = b[field];
    if (typeof v !== 'string' || !CURRENCY_RE.test(v)) {
      this.add(field, v === undefined ? 'required' : 'format');
      return null;
    }
    return v;
  }

  /** Поля вне списка — ошибка (например, прогноз переходов у площадки, AT-F10-02). */
  only(b: Body, allowed: readonly string[], prefix = ''): void {
    for (const k of Object.keys(b)) {
      if (!allowed.includes(k)) this.add(`${prefix}${k}`, 'unknown_field');
    }
  }
}

export function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (
      u.protocol === 'https:' && !u.username && !u.password && !!u.hostname
    );
  } catch {
    return false;
  }
}

/**
 * Канонический вид URL публикации (триггер `pub_publication_guard`, аудит
 * P-A0 P3-10): хост строчными, без `:443`, `#` и завершающего `/`.
 */
export function canonicalUrl(v: string): string {
  const u = new URL(v);
  u.hash = '';
  if (u.port === '443') u.port = '';
  let s = u.toString();
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

export interface FxParsed {
  rate: string;
  source: string;
  at: Date;
}

/** Курс `{rate, source, at}` (AT-CORE-13); null — курса нет. */
export function parseFx(f: Fields, v: unknown, field = 'fx'): FxParsed | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    f.add(field, 'type');
    return null;
  }
  const b = v as Body;
  const rate = typeof b.rate === 'string' ? b.rate : null;
  if (!rate || !FX_RATE_RE.test(rate) || /^0(\.0+)?$/.test(rate)) {
    f.add(`${field}.rate`, rate ? 'format' : 'required');
  }
  const source = f.str(b, 'source', 300);
  const at = f.date(b, 'at');
  if (!rate || !source || !at) return null;
  return { rate, source, at };
}

/** Поле формулы в CSV (аудит P3-27): `=`, `+`, `-`, `@`, таб, CR → префикс `'`. */
export function csvCell(v: unknown): string {
  let s =
    v === null || v === undefined
      ? ''
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
): string {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return lines.join('\n') + '\n';
}
