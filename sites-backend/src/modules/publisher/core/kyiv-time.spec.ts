/**
 * Время пилота Europe/Kyiv (P-A1, проектный документ §9.1; AT-CORE-19 —
 * векторы DST осени и весны, вехи от t0, окно 30 дней, ретенция после t72).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  addKyivCalendarDays,
  fromKyivLocal,
  inHalfOpen,
  isBusinessDay,
  kyivDateOf,
  kyivDayStart,
  kyivMonthOf,
  kyivOffsetMinutes,
  kyivParts,
  leadWindowEnd,
  nextBusinessDayEnd,
  pilotMilestones,
  reviewDueForClosed,
  reviewDueForOpen,
  weekOf,
} from './kyiv-time';

const iso = (s: string) => new Date(s);
const CAL = {
  workdays: [1, 2, 3, 4, 5],
  holidays: [] as string[],
  dayEnd: '18:00',
};

describe('kyiv-time: векторы §9.1', () => {
  it('t0 = 2026-10-20T10:00+03:00 → t42 = 2026-12-01T10:00+02:00 (переход 25.10 сохраняет местные 10:00)', () => {
    const m = pilotMilestones(iso('2026-10-20T10:00:00+03:00'));
    expect(m.t42.toISOString()).toBe(
      iso('2026-12-01T10:00:00+02:00').toISOString(),
    );
    expect(kyivParts(m.t42)).toMatchObject({ hour: 10, minute: 0 });
    expect(m.t72.toISOString()).toBe(
      iso('2026-12-31T10:00:00+02:00').toISOString(),
    );
    expect(m.t90.toISOString()).toBe(
      iso('2027-01-18T10:00:00+02:00').toISOString(),
    );
    expect(m.weeks).toHaveLength(6);
    expect(m.weeks[0].start).toEqual(m.t0);
    expect(m.weeks[5].end).toEqual(m.t42);
    expect(m.weeks[1].start).toEqual(m.weeks[0].end);
  });

  it('сессия ровно в t42 — вне когорты; t42 − 1 мс — внутри (полуоткрытый интервал)', () => {
    const t0 = iso('2026-10-20T10:00:00+03:00');
    const { t42 } = pilotMilestones(t0);
    expect(inHalfOpen(t42, t0, t42)).toBe(false);
    expect(inHalfOpen(new Date(t42.getTime() - 1), t0, t42)).toBe(true);
    expect(inHalfOpen(t0, t0, t42)).toBe(true);
    expect(weekOf(t0, new Date(t42.getTime() - 1))).toBe(6);
    expect(weekOf(t0, t42)).toBeNull();
    expect(weekOf(t0, new Date(t0.getTime() - 1))).toBeNull();
    expect(weekOf(t0, t0)).toBe(1);
  });

  it('окно обращения: ровно leadWindowEnd — включено (≤), через 1 мс — нет; 30 дней через переход', () => {
    const session = iso('2026-10-10T12:00:00+03:00');
    const end = leadWindowEnd(session);
    expect(end.toISOString()).toBe(
      iso('2026-11-09T12:00:00+02:00').toISOString(),
    );
    const inWindow = (lead: Date) =>
      session <= lead && lead.getTime() <= end.getTime();
    expect(inWindow(end)).toBe(true);
    expect(inWindow(new Date(end.getTime() + 1))).toBe(false);
  });

  it('весна: 2027-03-28 03:30 по Kyiv не существует → 04:30+03:00', () => {
    expect(fromKyivLocal(2027, 3, 28, 3, 30).toISOString()).toBe(
      iso('2027-03-28T04:30:00+03:00').toISOString(),
    );
    // +1 день от 2027-03-27 03:30 (+02:00) — та же «стрелка» не существует → 04:30
    expect(
      addKyivCalendarDays(iso('2027-03-27T03:30:00+02:00'), 1).toISOString(),
    ).toBe(iso('2027-03-28T04:30:00+03:00').toISOString());
  });

  it('осень: неоднозначное 2026-10-25 03:30 — первое из двух (+03:00)', () => {
    expect(fromKyivLocal(2026, 10, 25, 3, 30).toISOString()).toBe(
      iso('2026-10-25T03:30:00+03:00').toISOString(),
    );
    expect(kyivOffsetMinutes(iso('2026-10-25T00:30:00Z'))).toBe(180);
    expect(kyivOffsetMinutes(iso('2026-10-25T01:30:00Z'))).toBe(120);
  });

  it('аудит P3-1: t0 во «втором» осеннем часе (2026-10-25T01:30Z) — addKyiv(t0, 0) = t0, неделя 1 начинается с t0, момент до t0 — вне недель', () => {
    const t0 = iso('2026-10-25T01:30:00Z'); // 03:30 +02:00, второе вхождение
    expect(addKyivCalendarDays(t0, 0).toISOString()).toBe(t0.toISOString());
    expect(pilotMilestones(t0).weeks[0].start.toISOString()).toBe(
      t0.toISOString(),
    );
    expect(weekOf(t0, new Date(t0.getTime() - 30 * 60_000))).toBeNull();
    expect(weekOf(t0, t0)).toBe(1);
    // через 7 дней неоднозначности нет: та же стрелка 03:30 (+02:00)
    expect(addKyivCalendarDays(t0, 7).toISOString()).toBe(
      iso('2026-11-01T03:30:00+02:00').toISOString(),
    );
  });

  it('вехи — от t0, а не цепочкой: при несуществующем времени addKyiv(addKyiv(t,a),b) ≠ addKyiv(t,a+b)', () => {
    const t = iso('2027-03-27T03:30:00+02:00');
    const chained = addKyivCalendarDays(addKyivCalendarDays(t, 1), 1);
    const direct = addKyivCalendarDays(t, 2);
    expect(kyivParts(direct)).toMatchObject({ day: 29, hour: 3, minute: 30 });
    expect(kyivParts(chained)).toMatchObject({ day: 29, hour: 4, minute: 30 });
    const t0 = iso('2027-02-20T03:30:00+02:00');
    const m = pilotMilestones(t0);
    expect(kyivParts(m.t42)).toMatchObject({
      month: 4,
      day: 3,
      hour: 3,
      minute: 30,
    });
  });

  it('даты и месяцы Kyiv: полночь по UTC — уже следующие сутки в Kyiv', () => {
    expect(kyivDateOf(iso('2026-10-31T22:30:00Z'))).toBe('2026-11-01');
    expect(kyivMonthOf(iso('2026-10-31T22:30:00Z'))).toBe('2026-11');
    expect(kyivDayStart('2026-10-25').toISOString()).toBe(
      iso('2026-10-25T00:00:00+03:00').toISOString(),
    );
    expect(kyivDayStart('2026-10-26').toISOString()).toBe(
      iso('2026-10-26T00:00:00+02:00').toISOString(),
    );
    expect(() => kyivDayStart('2026-1-1')).toThrow(RangeError);
  });

  it('срок первого контакта: конец следующего рабочего дня (пятница → понедельник, праздник пропускается)', () => {
    expect(
      nextBusinessDayEnd(iso('2026-10-14T15:00:00+03:00'), CAL).toISOString(),
    ).toBe(iso('2026-10-15T18:00:00+03:00').toISOString());
    expect(
      nextBusinessDayEnd(iso('2026-10-16T15:00:00+03:00'), CAL).toISOString(),
    ).toBe(iso('2026-10-19T18:00:00+03:00').toISOString());
    expect(
      nextBusinessDayEnd(iso('2026-10-17T11:00:00+03:00'), CAL).toISOString(),
    ).toBe(iso('2026-10-19T18:00:00+03:00').toISOString());
    const withHoliday = { ...CAL, holidays: ['2026-10-19'] };
    expect(isBusinessDay('2026-10-19', withHoliday)).toBe(false);
    expect(
      nextBusinessDayEnd(
        iso('2026-10-16T15:00:00+03:00'),
        withHoliday,
      ).toISOString(),
    ).toBe(iso('2026-10-20T18:00:00+03:00').toISOString());
    // через переход на зимнее время: пятница 23.10 → понедельник 26.10 18:00+02:00
    expect(
      nextBusinessDayEnd(iso('2026-10-23T23:30:00+03:00'), CAL).toISOString(),
    ).toBe(iso('2026-10-26T18:00:00+02:00').toISOString());
    expect(() =>
      nextBusinessDayEnd(new Date(), { ...CAL, dayEnd: '25:00' }),
    ).toThrow(RangeError);
    expect(() =>
      nextBusinessDayEnd(new Date(), { ...CAL, workdays: [] }),
    ).toThrow(RangeError);
  });

  it('ретенция: закрытая +90; открытая — не позже t72, если он впереди; после t72 — +90; далее lastReview + 90', () => {
    const received = iso('2026-11-01T12:00:00+02:00');
    expect(reviewDueForClosed(received).toISOString()).toBe(
      iso('2027-01-30T12:00:00+02:00').toISOString(),
    );
    const t72Ahead = iso('2026-12-31T10:00:00+02:00');
    expect(reviewDueForOpen(received, t72Ahead, null)).toEqual(t72Ahead);
    const t72Far = iso('2027-06-01T10:00:00+03:00');
    expect(reviewDueForOpen(received, t72Far, null).toISOString()).toBe(
      iso('2027-01-30T12:00:00+02:00').toISOString(),
    );
    const t72Past = iso('2026-10-01T10:00:00+03:00');
    expect(reviewDueForOpen(received, t72Past, null).toISOString()).toBe(
      iso('2027-01-30T12:00:00+02:00').toISOString(),
    );
    expect(reviewDueForOpen(received, null, null).toISOString()).toBe(
      iso('2027-01-30T12:00:00+02:00').toISOString(),
    );
    const last = iso('2027-01-30T12:00:00+02:00');
    expect(reviewDueForOpen(received, t72Ahead, last).toISOString()).toBe(
      iso('2027-04-30T12:00:00+03:00').toISOString(),
    );
  });

  it('некорректные входы — RangeError', () => {
    expect(() => kyivParts(new Date('x'))).toThrow(RangeError);
    expect(() => addKyivCalendarDays(new Date(), 1.5)).toThrow(RangeError);
  });
});

describe('publisher: без арифметики «+86 400 000 мс» (§20, риск DST)', () => {
  it('в исходниках publisher (кроме тестов) нет суточной арифметики в миллисекундах', () => {
    const root = path.join(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.ts$/.test(e.name) && !/\.(spec|testing)\.ts$/.test(e.name))
          files.push(f);
      }
    };
    walk(root);
    const DAY_MS =
      /86_?400_?000|24\s*\*\s*60\s*\*\s*60\s*\*\s*1000|24\s*\*\s*3_?600_?000|24\s*\*\s*60\s*\*\s*60_?000|DAY_MS/;
    const offenders = files
      .filter((f) => DAY_MS.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });
});
