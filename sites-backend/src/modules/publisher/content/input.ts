/**
 * AI Publisher, P-B1 — разбор тел запросов кабинета контента (чистый
 * модуль). Ошибки копятся в список `FieldIssue` и бросаются одним
 * `PUB_VALIDATION {fields}` (§11.2): экран показывает все поля сразу.
 * Свободный текст, который увидят другие (причины, заметки, CTA-пояснения),
 * проверяет `pii-guard` (§6.1): похожее на контакт — `code:'pii'`.
 */
import type { FieldIssue } from '../contracts/errors';
import { validationError } from '../core/errors';
import { looksLikeContact } from '../core/pii-guard';

export type Body = Record<string, unknown>;

export function bodyOf(v: unknown): Body {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw validationError([{ field: '$', code: 'type' }]);
  }
  return v as Body;
}

export const has = (b: Body, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;

/** Собиратель ошибок полей. */
export class Issues {
  readonly list: FieldIssue[] = [];

  add(field: string, code: string): void {
    this.list.push({ field, code });
  }

  throwIfAny(): void {
    if (this.list.length) throw validationError(this.list);
  }

  /** Строка: обязательная/необязательная, длина, без контактов (pii). */
  str(
    b: Body,
    field: string,
    opts: {
      required?: boolean;
      min?: number;
      max: number;
      pii?: boolean;
      trim?: boolean;
      re?: RegExp;
    },
  ): string | null | undefined {
    const v = b[field];
    if (v === undefined || v === null) {
      if (opts.required) this.add(field, 'required');
      return v === null ? null : undefined;
    }
    if (typeof v !== 'string') {
      this.add(field, 'type');
      return undefined;
    }
    const t = opts.trim === false ? v : v.trim();
    if (opts.required && t.length === 0) {
      this.add(field, 'required');
      return undefined;
    }
    if (t.length === 0) return null;
    const len = [...t].length;
    if (len < (opts.min ?? 1) || len > opts.max) {
      this.add(field, 'length');
      return undefined;
    }
    if (opts.re && !opts.re.test(t)) {
      this.add(field, 'format');
      return undefined;
    }
    if (opts.pii && looksLikeContact(t)) {
      this.add(field, 'pii');
      return undefined;
    }
    return t;
  }

  oneOf<T extends string>(
    b: Body,
    field: string,
    list: readonly T[],
    required = false,
  ): T | undefined {
    const v = b[field];
    if (v === undefined || v === null) {
      if (required) this.add(field, 'required');
      return undefined;
    }
    if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) {
      this.add(field, 'enum');
      return undefined;
    }
    return v as T;
  }

  int(
    b: Body,
    field: string,
    opts: { min: number; max: number; required?: boolean },
  ): number | null | undefined {
    const v = b[field];
    if (v === undefined || v === null) {
      if (opts.required) this.add(field, 'required');
      return v === null ? null : undefined;
    }
    if (
      typeof v !== 'number' ||
      !Number.isSafeInteger(v) ||
      v < opts.min ||
      v > opts.max
    ) {
      this.add(field, 'range');
      return undefined;
    }
    return v;
  }

  bool(b: Body, field: string): boolean | undefined {
    const v = b[field];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'boolean') {
      this.add(field, 'type');
      return undefined;
    }
    return v;
  }

  /** ISO-дата/время → Date. */
  date(b: Body, field: string): Date | null | undefined {
    const v = b[field];
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (
      typeof v !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)
    ) {
      this.add(field, 'format');
      return undefined;
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      this.add(field, 'format');
      return undefined;
    }
    return d;
  }

  /** Массив строк-id (без повторов), ≤ max. */
  ids(b: Body, field: string, max = 200): string[] | undefined {
    const v = b[field];
    if (v === undefined || v === null) return undefined;
    if (
      !Array.isArray(v) ||
      v.length > max ||
      !v.every((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(x))
    ) {
      this.add(field, 'type');
      return undefined;
    }
    return [...new Set(v as string[])];
  }

  /** Массив коротких строк (структура брифа, каналы, критерии). */
  strings(
    b: Body,
    field: string,
    opts: { maxItems: number; maxLen: number; pii?: boolean },
  ): string[] | undefined {
    const v = b[field];
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.length > opts.maxItems) {
      this.add(field, 'type');
      return undefined;
    }
    const out: string[] = [];
    for (const [i, x] of v.entries()) {
      if (
        typeof x !== 'string' ||
        x.trim() === '' ||
        [...x].length > opts.maxLen
      ) {
        this.add(`${field}[${i}]`, 'type');
        return undefined;
      }
      if (opts.pii && looksLikeContact(x)) {
        this.add(`${field}[${i}]`, 'pii');
        return undefined;
      }
      out.push(x.trim());
    }
    return out;
  }
}

/** `?limit=` списков (1..100). */
export function limitOf(v: unknown): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw validationError([{ field: 'limit', code: 'range' }]);
  }
  return n;
}

export function strQ(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Нормализованный https-URL источника (≤ 2048) или null. */
export function httpsUrl(v: string): string | null {
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    u.hash = '';
    const s = u.toString();
    return s.length <= 2048 ? s : null;
  } catch {
    return null;
  }
}
