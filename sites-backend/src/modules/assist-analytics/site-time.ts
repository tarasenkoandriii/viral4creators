/**
 * Сутки сайта (§5-тер.10: «сутки — в поясе сайта») — A. ЧИСТЫЙ модуль на
 * Intl (без библиотек): день `YYYY-MM-DD` в поясе ↔ полуинтервал UTC
 * [start, end). Переход на летнее время: сутки бывают 23 и 25 часов —
 * границы считаются от полуночи по местным часам, а не «+24 ч».
 */

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Пояс IANA, который понимает Intl; иначе null. */
export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    fmt(tz).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** Пояс сайта или Europe/Kyiv (умолчание схемы), если в базе мусор. */
export function siteTz(tz: string | null | undefined): string {
  return validTimezone(tz) ? tz : 'Europe/Kyiv';
}

function parts(d: Date, tz: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(d)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** Смещение пояса в момент `d`, мс (местное − UTC). */
export function tzOffsetMs(d: Date, tz: string): number {
  const p = parts(d, tz);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** День в поясе сайта, `YYYY-MM-DD`. */
export function dayInTz(d: Date, tz: string): string {
  const p = parts(d, tz);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** День недели в поясе сайта: 1 — понедельник … 7 — воскресенье. */
export function isoWeekdayInTz(d: Date, tz: string): number {
  const [y, m, dd] = dayInTz(d, tz).split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Местная полночь дня → момент UTC. */
function localMidnightUtc(day: string, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // Две итерации: смещение в «наивной» полуночи и в найденной (DST).
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz);
  return new Date(t);
}

/** Полуинтервал UTC [start, end) суток `day` в поясе `tz`. */
export function dayRangeUtc(
  day: string,
  tz: string,
): { start: Date; end: Date } {
  return {
    start: localMidnightUtc(day, tz),
    end: localMidnightUtc(addDays(day, 1), tz),
  };
}

/** Календарная арифметика дней (`YYYY-MM-DD` ± n). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Дни от `from` до `to` включительно. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 1000; d = addDays(d, 1)) {
    out.push(d);
  }
  return out;
}

/** Корректный календарный день (2026-02-30 — нет). */
export function validDay(day: unknown): day is string {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === m - 1 &&
    t.getUTCDate() === d
  );
}
