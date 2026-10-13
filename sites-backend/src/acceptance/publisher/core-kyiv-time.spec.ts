/**
 * [AT-CORE-19] Часть P-A1 (проектный документ §9.1, TD-09 — векторы
 * календаря): границы t42 и окна 30 дней через переход часов. Снимки,
 * поздние решения и когорты — P-E (`reports-cohorts.spec`,
 * `reports-snapshots.spec`).
 */
import {
  inHalfOpen,
  leadWindowEnd,
  pilotMilestones,
} from '../../modules/publisher/core/kyiv-time';

/** startedAt ≤ receivedAt ≤ leadWindowEnd(startedAt) (§9.3; функция когорт — P-E). */
const leadInWindow = (sessionAt: Date, leadAt: Date): boolean =>
  sessionAt.getTime() <= leadAt.getTime() &&
  leadAt.getTime() <= leadWindowEnd(sessionAt).getTime();

describe('[AT-CORE-19] календарь пилота Europe/Kyiv (часть ядра)', () => {
  const t0 = new Date('2026-10-20T10:00:00+03:00');
  const { t42 } = pilotMilestones(t0);

  it('t42 — то же местное время через 42 календарных дня (через осенний переход)', () => {
    expect(t42.toISOString()).toBe('2026-12-01T08:00:00.000Z');
  });

  it('сессия ровно в t42 — следующий период; t42 − 1 мс — когорта [t0, t42)', () => {
    expect(inHalfOpen(t42, t0, t42)).toBe(false);
    expect(inHalfOpen(new Date(t42.getTime() - 1), t0, t42)).toBe(true);
  });

  it('обращение ровно через 30 календарных дней после сессии — в окне; на 1 мс позже — нет', () => {
    const session = new Date(t42.getTime() - 1);
    const end = leadWindowEnd(session);
    expect(leadInWindow(session, end)).toBe(true);
    expect(leadInWindow(session, new Date(end.getTime() + 1))).toBe(false);
    expect(leadInWindow(session, new Date(session.getTime() - 1))).toBe(false);
  });
});
