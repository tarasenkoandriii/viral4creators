// СГЕНЕРИРОВАНО scripts/sync-admin-reddit-shared.mjs — не править.
// Источник: assist/src/lib/publisher/decode.ts. Правка — в источнике, затем
// `node scripts/sync-admin-reddit-shared.mjs`; CI сверяет копию флагом --check.

/**
 * AI Publisher (P-G1) — строгие декодеры ответов `/publisher/*` по образцу
 * `qa-findings-api.ts`: форма, которую экран не ожидает, — ошибка
 * `PUB_RESPONSE_INVALID`, а не «пустой список» или «0» (ТЗ §8.4: неполнота
 * видна, неизвестное ≠ ноль). Формы — `sites-backend/src/modules/publisher/
 * contracts/*-api.ts`; `scripts/publisher-api.test.ts` сверяет ключи.
 *
 * Чистый модуль (общий с P-G2).
 */

import { ApiError } from '../../kit/envelope';

export class PubDecodeError extends ApiError {
  constructor(where: string) {
    super('PUB_RESPONSE_INVALID', `Unexpected server response (${where})`, 502);
  }
}

const bad = (where: string): never => {
  throw new PubDecodeError(where);
};

export type Rec = Record<string, unknown>;

export function obj(v: unknown, where = 'object'): Rec {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad(where);
  return v as Rec;
}

export function str(v: unknown, where = 'string'): string {
  return typeof v === 'string' ? v : bad(where);
}

export function strOrNull(v: unknown, where = 'string?'): string | null {
  return v === null || v === undefined ? null : str(v, where);
}

export function int(v: unknown, where = 'int'): number {
  return Number.isSafeInteger(v) ? (v as number) : bad(where);
}

export function intOrNull(v: unknown, where = 'int?'): number | null {
  return v === null || v === undefined ? null : int(v, where);
}

/** Конечное число (доли, баллы, курсы как number). */
export function num(v: unknown, where = 'number'): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : bad(where);
}

export function numOrNull(v: unknown, where = 'number?'): number | null {
  return v === null || v === undefined ? null : num(v, where);
}

export function bool(v: unknown, where = 'bool'): boolean {
  return typeof v === 'boolean' ? v : bad(where);
}

export function arr<T>(
  v: unknown,
  item: (x: unknown) => T,
  where = 'array'
): T[] {
  return Array.isArray(v) ? v.map(item) : bad(where);
}

export function oneOf<T extends string>(
  v: unknown,
  list: readonly T[],
  where = 'enum'
): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v)
    ? (v as T)
    : bad(`${where}:${String(v)}`);
}

export function oneOfOrNull<T extends string>(
  v: unknown,
  list: readonly T[],
  where = 'enum?'
): T | null {
  return v === null || v === undefined ? null : oneOf(v, list, where);
}

/** Сумма в минимальных единицах — строка цифр со знаком (`MinorJson`). */
export const MINOR_RE = /^-?\d{1,19}$/;
export function minor(v: unknown, where = 'minor'): string {
  return typeof v === 'string' && MINOR_RE.test(v) ? v : bad(where);
}
export function minorOrNull(v: unknown, where = 'minor?'): string | null {
  return v === null || v === undefined ? null : minor(v, where);
}

/** ISO-время: строка, которую понимает `Date.parse`. */
export function iso(v: unknown, where = 'iso'): string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v))
    ? v
    : bad(where);
}
export function isoOrNull(v: unknown, where = 'iso?'): string | null {
  return v === null || v === undefined ? null : iso(v, where);
}

/** Строки-значения (`Record<string, string>`), прочее — ошибка. */
export function strRecord(
  v: unknown,
  where = 'record'
): Record<string, string> {
  const o = obj(v, where);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(o)) out[k] = str(x, `${where}.${k}`);
  return out;
}

// ── Списки и неполнота (§11.1) ───────────────────────────────────────────

export interface ListPage<T> {
  items: T[];
  nextBefore: string | null;
}

export function listPage<T>(
  v: unknown,
  item: (x: unknown) => T,
  where = 'list'
): ListPage<T> {
  const o = obj(v, where);
  return {
    items: arr(o.items, item, `${where}.items`),
    nextBefore: strOrNull(o.nextBefore, `${where}.nextBefore`),
  };
}

/** `{ items }` без курсора (параметры, роли). */
export function itemsOf<T>(
  v: unknown,
  item: (x: unknown) => T,
  where = 'items'
): T[] {
  return arr(obj(v, where).items, item, `${where}.items`);
}

export interface Completeness {
  state: 'complete' | 'partial' | 'unknown';
  missing: string[];
}

export function completeness(v: unknown, where = 'completeness'): Completeness {
  const o = obj(v, where);
  return {
    state: oneOf(o.state, ['complete', 'partial', 'unknown'] as const, where),
    missing: arr(o.missing, (x) => str(x, `${where}.missing`)),
  };
}

export function completenessOrNull(v: unknown): Completeness | null {
  return v === null || v === undefined ? null : completeness(v);
}

// ── Computable (§1 п.2, §9; contracts/common.ts) ─────────────────────────

export const NOT_COMPUTABLE_REASONS = [
  'zero_denominator',
  'unknown_input',
  'non_positive_contribution',
  'probability_out_of_range',
  'share_out_of_range',
  'new_customer_unknown',
  'no_session_link',
] as const;
export type NotComputableReason = (typeof NOT_COMPUTABLE_REASONS)[number];

export type Computable<T> =
  | {
      kind: 'value';
      value: T;
      preliminary?: boolean;
      lowerBound?: boolean;
      unknownParts?: string[];
    }
  | {
      kind: 'not_computable';
      reason: NotComputableReason;
      inputs: Record<string, string | number | null>;
    };

export function computable<T>(
  v: unknown,
  value: (x: unknown) => T,
  where = 'computable'
): Computable<T> {
  const o = obj(v, where);
  if (o.kind === 'value') {
    const out: Computable<T> = { kind: 'value', value: value(o.value) };
    if (o.preliminary !== undefined) out.preliminary = bool(o.preliminary);
    if (o.lowerBound !== undefined) out.lowerBound = bool(o.lowerBound);
    if (o.unknownParts !== undefined)
      out.unknownParts = arr(o.unknownParts, (x) => str(x));
    return out;
  }
  if (o.kind === 'not_computable') {
    const inputs: Record<string, string | number | null> = {};
    for (const [k, x] of Object.entries(obj(o.inputs, `${where}.inputs`))) {
      inputs[k] =
        x === null || typeof x === 'string' || typeof x === 'number'
          ? x
          : bad(`${where}.inputs.${k}`);
    }
    return {
      kind: 'not_computable',
      reason: oneOf(o.reason, NOT_COMPUTABLE_REASONS, `${where}.reason`),
      inputs,
    };
  }
  return bad(`${where}.kind`);
}
