/**
 * AI Publisher — время пилота в `Europe/Kyiv` (P-A1, проектный документ
 * §9.1; ТЗ §15). ОДНА чистая функция на каждое правило окна и даты —
 * отчёты, обогащение заявок, сроки контакта и ретенции считают только ею.
 *
 * Правила:
 *  - «через N календарных дней» — то же МЕСТНОЕ время через N дат Kyiv
 *    (переход 25.10.2026 сохраняет местные 10:00, сдвигая UTC на час);
 *  - несуществующее местное время (весенний переход, 03:00→04:00) —
 *    ближайшее следующее существующее (+1 ч): 2027-03-28 03:30 → 04:30+03:00;
 *  - неоднозначное (осенью 03:00–04:00 дважды) — первое из двух (летнее);
 *  - вехи t42/t72/t90 и недели — всегда ОТ t0, а не цепочкой: при
 *    несуществующем времени addKyiv(addKyiv(t, a), b) ≠ addKyiv(t, a + b);
 *  - полуоткрытые интервалы [start, end).
 *
 * В базе хранятся UTC-эквиваленты: смена tzdata (отмена летнего времени)
 * уже вычисленных моментов не меняет. Арифметика «+86 400 000 мс» в
 * модуле publisher запрещена (тест-поиск в kyiv-time.spec.ts).
 */
import type { BusinessCalendar } from '../contracts/parameters';

export const PILOT_TZ = 'Europe/Kyiv';

const MINUTE_MS = 60_000;

const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PILOT_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

const WEEKDAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Местное (Kyiv) представление момента. `weekday`: 1 = пн … 7 = вс. */
export interface KyivParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  weekday: number;
}

export function kyivParts(t: Date): KyivParts {
  assertDate(t);
  const p: Record<string, string> = {};
  for (const part of FMT.formatToParts(t)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    ms: t.getUTCMilliseconds(),
    weekday: WEEKDAYS[p.weekday],
  };
}

/** Смещение Kyiv от UTC в минутах в момент `t` (+120 зимой, +180 летом). */
export function kyivOffsetMinutes(t: Date): number {
  const p = kyivParts(t);
  const wall = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
    p.ms,
  );
  return Math.round((wall - t.getTime()) / MINUTE_MS);
}

/**
 * Момент по местному времени Kyiv. Несуществующее (весенний разрыв) —
 * сдвиг вперёд на длину разрыва; неоднозначное — более раннее (первое).
 */
export function fromKyivLocal(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  // Смещения по обе стороны возможного перехода (Kyiv: ±1 ч, раз в полгода).
  const offsets = [
    kyivOffsetMinutes(new Date(wall - 14 * 60 * MINUTE_MS)),
    kyivOffsetMinutes(new Date(wall + 14 * 60 * MINUTE_MS)),
  ];
  const valid = [...new Set(offsets)]
    .map((o) => new Date(wall - o * MINUTE_MS))
    .filter((t) => wallOf(t) === wall)
    .sort((a, b) => a.getTime() - b.getTime());
  if (valid.length > 0) return valid[0];
  // Разрыв: берём смещение ДО перехода (меньшее) — местное время уходит
  // вперёд ровно на длину разрыва (03:30 → 04:30).
  return new Date(wall - Math.min(...offsets) * MINUTE_MS);
}

function wallOf(t: Date): number {
  const p = kyivParts(t);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.ms);
}

/**
 * Та же местная Kyiv-«стрелка» через `days` календарных дней. `days = 0` —
 * сам момент (аудит P3-1: во «втором» осеннем часе 03:00–04:00 местная
 * стрелка неоднозначна, и пересборка давала первое вхождение — на час
 * раньше `t`).
 */
export function addKyivCalendarDays(t: Date, days: number): Date {
  if (!Number.isInteger(days)) {
    throw new RangeError('addKyivCalendarDays: целое число дней');
  }
  if (days === 0) return new Date(t.getTime());
  const p = kyivParts(t);
  // Date.UTC сам переносит переполнение дней через месяцы и годы.
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return fromKyivLocal(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    p.hour,
    p.minute,
    p.second,
    p.ms,
  );
}

export interface PilotMilestones {
  t0: Date;
  t42: Date;
  t72: Date;
  t90: Date;
  /** Шесть недель активности: [t0+7(n−1), t0+7n). */
  weeks: Array<{ n: number; start: Date; end: Date }>;
}

/** Вехи пилота — все от t0 (а не цепочкой). */
export function pilotMilestones(t0: Date): PilotMilestones {
  return {
    t0,
    t42: addKyivCalendarDays(t0, 42),
    t72: addKyivCalendarDays(t0, 72),
    t90: addKyivCalendarDays(t0, 90),
    weeks: [1, 2, 3, 4, 5, 6].map((n) => ({
      n,
      start: addKyivCalendarDays(t0, 7 * (n - 1)),
      end: addKyivCalendarDays(t0, 7 * n),
    })),
  };
}

/** start ≤ at < end. */
export function inHalfOpen(at: Date, start: Date, end: Date): boolean {
  return start.getTime() <= at.getTime() && at.getTime() < end.getTime();
}

/** Номер недели активности (1..6) или null вне [t0, t42). */
export function weekOf(t0: Date, at: Date): number | null {
  if (at.getTime() < t0.getTime()) return null;
  for (let n = 1; n <= 6; n++) {
    if (
      inHalfOpen(
        at,
        addKyivCalendarDays(t0, 7 * (n - 1)),
        addKyivCalendarDays(t0, 7 * n),
      )
    ) {
      return n;
    }
  }
  return null;
}

/**
 * Конец окна обращения после сессии: +30 календарных дней от САМОЙ сессии
 * (ТЗ §15). Граница включается: обращение ровно в этот момент — в окне.
 */
export function leadWindowEnd(sessionAt: Date): Date {
  return addKyivCalendarDays(sessionAt, 30);
}

/** Дата Kyiv `YYYY-MM-DD` (workDate, отображение). */
export function kyivDateOf(t: Date): string {
  const p = kyivParts(t);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Месяц Kyiv `YYYY-MM` (потолок AI месяца, §6.7). */
export function kyivMonthOf(t: Date): string {
  const p = kyivParts(t);
  return `${p.year}-${pad(p.month)}`;
}

/** Начало суток Kyiv даты `YYYY-MM-DD` (00:00 местного). */
export function kyivDayStart(date: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m)
    throw new RangeError(
      `kyivDayStart: ожидается YYYY-MM-DD, получено «${date}»`,
    );
  return fromKyivLocal(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Рабочий ли день календаря дата Kyiv. */
export function isBusinessDay(
  date: string,
  calendar: BusinessCalendar,
): boolean {
  const start = kyivDayStart(date);
  return (
    calendar.workdays.includes(kyivParts(start).weekday) &&
    !calendar.holidays.includes(date)
  );
}

/**
 * Срок первого контакта (`contact_sla`, Р-PUB-35): конец СЛЕДУЮЩЕГО
 * рабочего дня после даты Kyiv обращения (`dayEnd` по Kyiv). Обращение в
 * пятницу — до конца понедельника; в субботу — тоже до конца понедельника.
 */
export function nextBusinessDayEnd(t: Date, calendar: BusinessCalendar): Date {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(calendar.dayEnd);
  if (!m) throw new RangeError('nextBusinessDayEnd: dayEnd ожидается HH:MM');
  if (calendar.workdays.length === 0) {
    throw new RangeError('nextBusinessDayEnd: в календаре нет рабочих дней');
  }
  let day = addKyivCalendarDays(kyivDayStart(kyivDateOf(t)), 1);
  // Год праздников подряд — уже ошибка параметра, а не календарь.
  for (let i = 0; i < 370; i++) {
    const date = kyivDateOf(day);
    if (isBusinessDay(date, calendar)) {
      const p = kyivParts(day);
      return fromKyivLocal(p.year, p.month, p.day, Number(m[1]), Number(m[2]));
    }
    day = addKyivCalendarDays(day, 1);
  }
  throw new RangeError('nextBusinessDayEnd: нет рабочего дня в пределах года');
}

/** Ретенция закрытой/отклонённой заявки: +90 календарных дней (§15.3). */
export function reviewDueForClosed(closedAt: Date): Date {
  return addKyivCalendarDays(closedAt, 90);
}

/**
 * Ретенция открытой заявки (§9.1, §15.3, аудит P3-18): первая дата —
 * не раньше приёма и не позже t72, если t72 ещё впереди; поступившая
 * после t72 (или без t72) — receivedAt + 90; далее — lastReview + 90.
 */
export function reviewDueForOpen(
  receivedAt: Date,
  t72: Date | null,
  lastReview: Date | null,
): Date {
  if (lastReview) return addKyivCalendarDays(lastReview, 90);
  const r90 = addKyivCalendarDays(receivedAt, 90);
  if (t72 && t72.getTime() > receivedAt.getTime()) {
    return t72.getTime() < r90.getTime() ? t72 : r90;
  }
  return r90;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function assertDate(t: Date): void {
  if (!(t instanceof Date) || Number.isNaN(t.getTime())) {
    throw new RangeError('kyiv-time: ожидается корректная Date');
  }
}
