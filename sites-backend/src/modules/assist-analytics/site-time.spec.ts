/** Сутки сайта (A): пояс, переход на летнее время (23/25 ч), понедельник. */
import {
  addDays,
  dayInTz,
  dayRangeUtc,
  daysBetween,
  isoWeekdayInTz,
  validDay,
} from './site-time';

describe('site-time (A)', () => {
  it('сутки Europe/Kyiv: обычные — 24 ч, переход осенью — 25 ч, весной — 23 ч', () => {
    const r = dayRangeUtc('2026-10-02', 'Europe/Kyiv');
    expect(r.start.toISOString()).toBe('2026-10-01T21:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-10-02T21:00:00.000Z');
    const fall = dayRangeUtc('2026-10-25', 'Europe/Kyiv');
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 3600_000);
    const spring = dayRangeUtc('2026-03-29', 'Europe/Kyiv');
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3600_000);
    expect(dayRangeUtc('2026-10-02', 'UTC').start.toISOString()).toBe(
      '2026-10-02T00:00:00.000Z',
    );
  });

  it('день и день недели в поясе; календарная арифметика', () => {
    const t = new Date('2026-10-04T22:30:00Z'); // в Киеве уже понедельник 05.10
    expect(dayInTz(t, 'Europe/Kyiv')).toBe('2026-10-05');
    expect(isoWeekdayInTz(t, 'Europe/Kyiv')).toBe(1);
    expect(isoWeekdayInTz(t, 'UTC')).toBe(7);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-02-27', '2026-03-01')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ]);
    expect(validDay('2026-02-30')).toBe(false);
    expect(validDay('2026-02-28')).toBe(true);
  });
});
