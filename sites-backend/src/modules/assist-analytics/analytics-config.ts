/**
 * Настройки аналитики сайта — A (ТЗ §5-тер.14 `AssistSite.analytics`,
 * §5-тер.2 «разгрузка людей», §5-тер.1 «IP офиса»). ЧИСТЫЙ модуль.
 * Колонка открыта роли виджета: CIDR офиса сверяется с СЫРЫМ IP при приёме
 * цели (до хеширования) и в события не пишется; в /widget/v1/config не
 * отдаётся (W).
 */
import { isIP } from 'net';
import { ANALYTICS_DEFAULTS } from '../../config/assist-defaults';

export interface AnalyticsConfig {
  schema: 1;
  /** Минуты оператора на вопрос (умолчание 3) — «≈ N часов работы оператора». */
  minutesPerQuestion: number;
  /** IPv4/IPv6 CIDR офиса заказчика (≤ 20) — события из них не считаются. */
  officeCidrs: string[];
  /** Маски путей, где цели загрузчика не принимаются. */
  excludedPaths: string[];
}

export function defaultAnalyticsConfig(): AnalyticsConfig {
  return {
    schema: 1,
    minutesPerQuestion: ANALYTICS_DEFAULTS.minutesPerQuestion,
    officeCidrs: [],
    excludedPaths: [],
  };
}

const MAX_CIDRS = 20;
const MAX_EXCLUDED = 20;
const PATH_MASK = /^\/[A-Za-z0-9/_.*~%:@!$&'()+,;=-]{0,199}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** CIDR → нормальная форма или null (IPv4 `a.b.c.d/n`, IPv6 `x::/n`; без маски — /32 и /128). */
export function normalizeCidr(raw: string): string | null {
  const t = raw.trim();
  const [addr, bits, ...rest] = t.split('/');
  if (rest.length) return null;
  const fam = isIP(addr);
  if (!fam) return null;
  const max = fam === 4 ? 32 : 128;
  const n = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(n) || n < 0 || n > max || (bits ?? '0') === '') {
    return null;
  }
  if (bits !== undefined && !/^\d{1,3}$/.test(bits)) return null;
  return `${addr.toLowerCase()}/${n}`;
}

export function parseAnalyticsConfig(
  input: unknown,
):
  | { ok: true; config: AnalyticsConfig }
  | { ok: false; errors: Array<{ path: string; code: string }> } {
  const errors: Array<{ path: string; code: string }> = [];
  if (!isObj(input)) return { ok: false, errors: [{ path: '', code: 'type' }] };
  for (const k of Object.keys(input)) {
    if (
      ![
        'schema',
        'minutesPerQuestion',
        'officeCidrs',
        'excludedPaths',
      ].includes(k)
    ) {
      errors.push({ path: k, code: 'unknown' });
    }
  }
  if (input.schema !== undefined && input.schema !== 1) {
    errors.push({ path: 'schema', code: 'enum' });
  }
  const d = defaultAnalyticsConfig();
  let minutesPerQuestion = d.minutesPerQuestion;
  if (input.minutesPerQuestion !== undefined) {
    const m = input.minutesPerQuestion;
    if (
      typeof m !== 'number' ||
      !Number.isFinite(m) ||
      m < 0.5 ||
      m > 120 ||
      Math.round(m * 10) !== m * 10
    ) {
      errors.push({ path: 'minutesPerQuestion', code: 'range' });
    } else minutesPerQuestion = m;
  }
  const officeCidrs: string[] = [];
  if (input.officeCidrs !== undefined) {
    if (!Array.isArray(input.officeCidrs)) {
      errors.push({ path: 'officeCidrs', code: 'type' });
    } else if (input.officeCidrs.length > MAX_CIDRS) {
      errors.push({ path: 'officeCidrs', code: 'count' });
    } else {
      input.officeCidrs.forEach((c, i) => {
        const n = typeof c === 'string' ? normalizeCidr(c) : null;
        if (!n) errors.push({ path: `officeCidrs.${i}`, code: 'format' });
        else if (!officeCidrs.includes(n)) officeCidrs.push(n);
      });
    }
  }
  const excludedPaths: string[] = [];
  if (input.excludedPaths !== undefined) {
    if (!Array.isArray(input.excludedPaths)) {
      errors.push({ path: 'excludedPaths', code: 'type' });
    } else if (input.excludedPaths.length > MAX_EXCLUDED) {
      errors.push({ path: 'excludedPaths', code: 'count' });
    } else {
      input.excludedPaths.forEach((p, i) => {
        if (typeof p !== 'string' || !PATH_MASK.test(p)) {
          errors.push({ path: `excludedPaths.${i}`, code: 'path_mask' });
        } else if (!excludedPaths.includes(p)) excludedPaths.push(p);
      });
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: { schema: 1, minutesPerQuestion, officeCidrs, excludedPaths },
  };
}

/** Настройка из базы: строгий разбор или умолчание (битое — не роняет приём). */
export function effectiveAnalyticsConfig(raw: unknown): AnalyticsConfig {
  if (raw !== null && raw !== undefined) {
    const r = parseAnalyticsConfig(raw);
    if (r.ok) return r.config;
  }
  return defaultAnalyticsConfig();
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = BigInt(0);
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << BigInt(8)) | BigInt(Number(p));
  }
  return n;
}

function ipv6ToBigInt(ip: string): bigint | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  // Хвост в форме IPv4 (::ffff:1.2.3.4) — в два хекстета.
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const n = ipv4ToBigInt(v4[1]);
    if (n === null) return null;
    const hi = Number(n >> BigInt(16));
    const lo = Number(n & BigInt(0xffff));
    s = `${s.slice(0, -v4[1].length)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [
    ...head,
    ...Array<string>(halves.length === 2 ? missing : 0).fill('0'),
    ...tail,
  ];
  let n = BigInt(0);
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << BigInt(16)) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** IP → (семейство, число); IPv4-mapped IPv6 сводится к IPv4. */
function ipValue(ip: string): { v: 4 | 6; n: bigint } | null {
  const t = ip.trim();
  const fam = isIP(t);
  if (fam === 4) {
    const n = ipv4ToBigInt(t);
    return n === null ? null : { v: 4, n };
  }
  if (fam === 6) {
    const n = ipv6ToBigInt(t);
    if (n === null) return null;
    if (n >> BigInt(32) === BigInt(0xffff)) {
      return { v: 4, n: n & BigInt(0xffffffff) };
    }
    return { v: 6, n };
  }
  return null;
}

/** Сырой IP внутри одного из CIDR (IPv4 и IPv6, в т.ч. ::ffff:a.b.c.d). */
export function ipInCidrs(ip: string | null, cidrs: string[]): boolean {
  if (!ip || !cidrs.length) return false;
  const a = ipValue(ip);
  if (!a) return false;
  for (const c of cidrs) {
    const norm = normalizeCidr(c);
    if (!norm) continue;
    const [addr, bitsS] = norm.split('/');
    const b = ipValue(addr);
    if (!b || b.v !== a.v) continue;
    const width = a.v === 4 ? 32 : 128;
    const bits = Number(bitsS);
    const shift = BigInt(width - bits);
    if (a.n >> shift === b.n >> shift) return true;
  }
  return false;
}

/** Минуты оператора на вопрос по умолчанию — из ANALYTICS_DEFAULTS. */
export const DEFAULT_MINUTES_PER_QUESTION =
  ANALYTICS_DEFAULTS.minutesPerQuestion;
