/**
 * Разбор расписаний vercel.json и подсчёт ожидаемых запусков за период
 * (сводка «ожидалось vs было» во вкладке «Кроны»).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ceilToMinute,
  floorToMinute,
  countExpectedRuns,
  loadVercelSchedules,
  parseCronExpression,
  schedulesByJobKey,
  runFitsSchedule,
  scheduleEffectiveSince,
} from './cron-schedule';

const DAY = new Date('2026-09-29T00:00:00Z');
const NEXT_DAY = new Date('2026-09-30T00:00:00Z');

function vercelCrons(): Array<{ path: string; schedule: string }> {
  const json = JSON.parse(
    readFileSync(join(__dirname, '..', '..', '..', 'vercel.json'), 'utf8'),
  ) as { crons: Array<{ path: string; schedule: string }> };
  return json.crons;
}

describe('parseCronExpression', () => {
  it('разбирает шаг, список, диапазон и диапазон с шагом', () => {
    const c = parseCronExpression('*/15 9,10 1-3 */6 1-5/2');
    expect(c.minutes).toEqual([0, 15, 30, 45]);
    expect([...c.hours]).toEqual([9, 10]);
    expect([...c.daysOfMonth]).toEqual([1, 2, 3]);
    expect([...c.months]).toEqual([1, 7]);
    expect([...c.daysOfWeek]).toEqual([1, 3, 5]);
    expect(c.domAny).toBe(false);
    expect(c.dowAny).toBe(false);
  });

  it('день недели 7 = воскресенье (0)', () => {
    expect([...parseCronExpression('0 0 * * 7').daysOfWeek]).toEqual([0]);
  });

  it.each([
    ['0 0 * *', '4 поля'],
    ['0 0 0 * * *', '6 полей'],
    ['60 * * * *', 'минута вне диапазона'],
    ['0 24 * * *', 'час вне диапазона'],
    ['0 0 L * *', 'L не поддерживается'],
    ['0 0 * JAN *', 'имена месяцев не поддерживаются'],
    ['*/0 * * * *', 'нулевой шаг'],
    ['5-3 * * * *', 'обратный диапазон'],
  ])('ошибка на "%s" (%s)', (expr) => {
    expect(() => parseCronExpression(expr)).toThrow(/cron:/);
  });

  it('каждое выражение из vercel.json разбирается', () => {
    for (const c of vercelCrons()) {
      expect(() => parseCronExpression(c.schedule)).not.toThrow();
    }
  });
});

describe('countExpectedRuns', () => {
  it('*/2 — 720 запусков за сутки', () => {
    expect(countExpectedRuns('*/2 * * * *', DAY, NEXT_DAY)).toBe(720);
  });

  it('*/15 — 96 за сутки, раз в сутки — 1', () => {
    expect(countExpectedRuns('*/15 * * * *', DAY, NEXT_DAY)).toBe(96);
    expect(countExpectedRuns('30 3 * * *', DAY, NEXT_DAY)).toBe(1);
  });

  it('список часов (tutorial-scenario-run) — 15 за сутки', () => {
    expect(
      countExpectedRuns(
        '0 9,10,11,12,13,14,15,16,17,18,19,20,21,22,23 * * *',
        DAY,
        NEXT_DAY,
      ),
    ).toBe(15);
  });

  it('полуинтервал [since, until): старт ровно в until не считается', () => {
    const since = new Date('2026-09-29T03:00:00Z');
    expect(
      countExpectedRuns('0 3 * * *', since, new Date('2026-09-29T03:00:01Z')),
    ).toBe(1);
    expect(
      countExpectedRuns('0 3 * * *', new Date('2026-09-29T02:00:00Z'), since),
    ).toBe(0);
  });

  it('until посреди часа на минуте расписания — сам until не считается', () => {
    expect(
      countExpectedRuns(
        '*/2 * * * *',
        new Date('2026-09-29T10:00:00Z'),
        new Date('2026-09-29T10:06:00Z'),
      ),
    ).toBe(3);
  });

  it('неровные границы: 10:01–10:07 для */2 → 10:02, 10:04, 10:06', () => {
    expect(
      countExpectedRuns(
        '*/2 * * * *',
        new Date('2026-09-29T10:01:00Z'),
        new Date('2026-09-29T10:07:00Z'),
      ),
    ).toBe(3);
  });

  it('день недели: понедельничный крон — 1 раз за неделю', () => {
    // 2026-09-28 — понедельник.
    const mon = new Date('2026-09-28T00:00:00Z');
    const nextMon = new Date('2026-10-05T00:00:00Z');
    expect(countExpectedRuns('0 4 * * 1', mon, nextMon)).toBe(1);
    expect(countExpectedRuns('0 4 * * 1', DAY, NEXT_DAY)).toBe(0);
  });

  it('оба поля дня ограничены — OR (классический cron)', () => {
    // Сентябрь 2026: 1-е число (вторник) + все понедельники (7, 14, 21, 28).
    expect(
      countExpectedRuns(
        '0 0 1 * 1',
        new Date('2026-09-01T00:00:00Z'),
        new Date('2026-10-01T00:00:00Z'),
      ),
    ).toBe(5);
  });

  it('пустой/обратный период — 0', () => {
    expect(countExpectedRuns('*/2 * * * *', NEXT_DAY, DAY)).toBe(0);
    expect(countExpectedRuns('*/2 * * * *', DAY, DAY)).toBe(0);
  });
});

describe('vercel.json → расписания по jobKey', () => {
  it('schedulesByJobKey снимает префикс /api/cron/', () => {
    expect(
      schedulesByJobKey([{ path: '/api/cron/report', schedule: '0 6 * * *' }]),
    ).toEqual({ report: '0 6 * * *' });
  });

  it('loadVercelSchedules: вшитый конфиг = файл vercel.json', () => {
    const s = loadVercelSchedules();
    expect(s).toEqual(schedulesByJobKey(vercelCrons()));
    expect(s?.['api-video']).toBe('*/2 * * * *');
  });

  it('loadVercelSchedules: неожиданная форма — null, битые записи пропускаются', () => {
    expect(loadVercelSchedules({})).toBeNull();
    expect(loadVercelSchedules(null)).toBeNull();
    expect(
      loadVercelSchedules({
        crons: [
          { path: '/api/cron/report', schedule: '0 6 * * *' },
          { path: '/api/cron/x' },
          'мусор',
        ],
      }),
    ).toStrictEqual({ report: '0 6 * * *' });
  });

  it('ceilToMinute', () => {
    expect(ceilToMinute(new Date('2026-09-29T10:00:00Z')).toISOString()).toBe(
      '2026-09-29T10:00:00.000Z',
    );
    expect(
      ceilToMinute(new Date('2026-09-29T10:00:00.001Z')).toISOString(),
    ).toBe('2026-09-29T10:01:00.000Z');
  });

  it('floorToMinute', () => {
    expect(
      floorToMinute(new Date('2026-09-29T10:00:59.999Z')).toISOString(),
    ).toBe('2026-09-29T10:00:00.000Z');
    expect(floorToMinute(new Date('2026-09-29T10:01:00Z')).toISOString()).toBe(
      '2026-09-29T10:01:00.000Z',
    );
  });
});

describe('смена расписания по журналу (заход 7)', () => {
  const cron = parseCronExpression('5 9-23 * * *');
  const t = (hhmmss: string) => new Date(`2026-09-30T${hhmmss}Z`);

  it('прогон — свой тик с допуском опоздания старта', () => {
    expect(runFitsSchedule(cron, t('09:05:02'))).toBe(true);
    expect(runFitsSchedule(cron, t('09:08:59'))).toBe(true);
    expect(runFitsSchedule(cron, t('09:09:00'))).toBe(false);
    expect(runFitsSchedule(cron, t('09:00:03'))).toBe(false);
    expect(runFitsSchedule(cron, t('08:05:00'))).toBe(false);
  });

  it('с первого своего прогона после последнего чужого; чужих нет — null', () => {
    expect(
      scheduleEffectiveSince(cron, [
        t('09:00:04'),
        t('10:00:03'),
        t('16:05:04'),
        t('17:05:01'),
      ]),
    ).toEqual(t('16:05:00'));
    expect(
      scheduleEffectiveSince(cron, [t('09:05:04'), t('10:05:03')]),
    ).toBeNull();
    expect(scheduleEffectiveSince(cron, [])).toBeNull();
    // Серия чужих — последней: со следующей минуты после неё.
    expect(
      scheduleEffectiveSince(cron, [
        t('09:05:04'),
        t('09:30:30'),
        t('10:00:30'),
      ]),
    ).toEqual(t('10:01:00'));
    // Одиночный чужой (опоздавший старт) — не смена.
    expect(
      scheduleEffectiveSince(cron, [t('09:05:04'), t('10:00:30')]),
    ).toBeNull();
    expect(
      scheduleEffectiveSince(cron, [
        t('09:00:04'),
        t('09:05:04'),
        t('10:00:04'),
        t('11:05:04'),
      ]),
    ).toBeNull();
    // Важна ПОСЛЕДНЯЯ серия, а не первая.
    expect(
      scheduleEffectiveSince(cron, [
        t('08:00:04'),
        t('08:30:04'),
        t('09:05:04'),
        t('10:00:04'),
        t('10:30:04'),
        t('11:05:04'),
      ]),
    ).toEqual(t('11:05:00'));
  });
});
