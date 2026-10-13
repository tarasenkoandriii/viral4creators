/**
 * AI Publisher — деньги (P-A1, проектный документ §1 п.9, §6.1, §9):
 * суммы — `bigint` в минимальных единицах (копейки), валюта — ISO 4217,
 * курс — десятичная строка `Decimal(18,8)` с источником и временем.
 *
 * В JSON API сумма — строка из цифр (`MinorJson`): `bigint` не
 * сериализуется, а `number` за 2^53 теряет точность. Арифметики с плавающей
 * точкой нет: пересчёт по курсу — целочисленный, округление явное.
 *
 * Чистый модуль (его берёт и публичный код).
 */
import type { Minor, MinorJson } from '../contracts/common';

export const CURRENCY_RE = /^[A-Z]{3}$/;
const MINOR_JSON_RE = /^-?(0|[1-9]\d{0,30})$/;
/** Курс `Decimal(18,8)`: до 10 цифр целой части и до 8 дробной. */
export const FX_RATE_RE = /^(0|[1-9]\d{0,9})(\.\d{1,8})?$/;
const FX_SCALE = 100_000_000n;

export function isCurrency(v: unknown): v is string {
  return typeof v === 'string' && CURRENCY_RE.test(v);
}

/** Сумма из JSON (строка цифр или безопасное целое число); null — не сумма. */
export function parseMinor(v: unknown): Minor | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    return Number.isSafeInteger(v) ? BigInt(v) : null;
  }
  if (typeof v === 'string' && MINOR_JSON_RE.test(v)) return BigInt(v);
  return null;
}

export function minorToJson(v: Minor): MinorJson {
  return v.toString();
}

/**
 * Глубокая замена `bigint` строками — для ответов API и `responseBody`
 * ключа идемпотентности (jsonb не принимает bigint).
 */
export function jsonSafe<T>(v: T): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => jsonSafe(x));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== undefined) out[k] = jsonSafe(x);
    }
    return out;
  }
  return v;
}

export function sumMinor(values: readonly Minor[]): Minor {
  return values.reduce((a, b) => a + b, 0n);
}

export function maxMinor(a: Minor, b: Minor): Minor {
  return a > b ? a : b;
}

export function minMinor(a: Minor, b: Minor): Minor {
  return a < b ? a : b;
}

/** Неотрицательная сумма (иначе — ошибка в коде, а не в данных). */
export function assertNonNegative(v: Minor, what: string): Minor {
  if (v < 0n) throw new RangeError(`${what}: отрицательная сумма ${v}`);
  return v;
}

export type Rounding = 'floor' | 'ceil' | 'half_up';

function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
  if (d <= 0n) throw new RangeError('divRound: делитель ≤ 0');
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const neg = n < 0n;
  switch (mode) {
    case 'floor':
      return neg ? q - 1n : q;
    case 'ceil':
      return neg ? q : q + 1n;
    case 'half_up': {
      const twice = (neg ? -r : r) * 2n;
      if (twice >= d) return neg ? q - 1n : q + 1n;
      return q;
    }
  }
}

/** Курс строкой `Decimal(18,8)` → целое в 1e-8 (без плавающей точки). */
export function parseFxRate(rate: string): bigint {
  if (!FX_RATE_RE.test(rate)) {
    throw new RangeError(
      `parseFxRate: курс «${rate}» вне формата Decimal(18,8)`,
    );
  }
  const [int, frac = ''] = rate.split('.');
  return BigInt(int) * FX_SCALE + BigInt((frac + '00000000').slice(0, 8));
}

/**
 * Пересчёт суммы в валюту лимита по курсу «единиц валюты лимита за одну
 * единицу исходной» (AT-CORE-13). Обе валюты с двумя знаками минимальных
 * единиц (UAH, USD, EUR). Округление — явное (по умолчанию вверх: лимит
 * не должен оказаться меньше фактической цены из-за копейки).
 */
export function convertMinor(
  amount: Minor,
  rate: string,
  rounding: Rounding = 'ceil',
): Minor {
  return divRound(amount * parseFxRate(rate), FX_SCALE, rounding);
}

/** Доля в базисных пунктах: floor(value × bp / 10 000). */
export function applyBp(value: Minor, bp: number): Minor {
  if (!Number.isInteger(bp) || bp < 0 || bp > 10_000) {
    throw new RangeError('applyBp: bp вне 0..10000');
  }
  return divRound(value * BigInt(bp), 10_000n, 'floor');
}

/** «1234.50» для отображения (две минимальные единицы). */
export function formatMinor(v: Minor, currency?: string): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return currency ? `${s} ${currency}` : s;
}

export { divRound };
