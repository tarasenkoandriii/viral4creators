/**
 * workflow-funnel-cohort.spec.ts — горизонт зрелости когорты (этап 78,
 * doc/WORKFLOW-FUNNEL-COHORT-CONVERSION-SPEC.md §3.2). Чистая логика,
 * без Prisma — не нуждается в моке клиента.
 */

import {
  isCohortMatured,
  SESSION_COHORT_HORIZON_MS,
  BATCH_COHORT_HORIZON_MS,
} from './workflow-funnel-cohort';

describe('isCohortMatured', () => {
  const to = new Date('2026-01-01T00:00:00.000Z');

  it('не считает когорту завершённой до истечения горизонта', () => {
    const now = new Date(to.getTime() + SESSION_COHORT_HORIZON_MS - 1);
    expect(isCohortMatured(to, SESSION_COHORT_HORIZON_MS, now)).toBe(false);
  });

  it('считает когорту завершённой ровно на границе горизонта (включительно)', () => {
    const now = new Date(to.getTime() + SESSION_COHORT_HORIZON_MS);
    expect(isCohortMatured(to, SESSION_COHORT_HORIZON_MS, now)).toBe(true);
  });

  it('считает когорту завершённой после истечения горизонта', () => {
    const now = new Date(to.getTime() + SESSION_COHORT_HORIZON_MS + 1);
    expect(isCohortMatured(to, SESSION_COHORT_HORIZON_MS, now)).toBe(true);
  });

  it('работает с горизонтом партии/A-B (4 часа), не только сессии', () => {
    const justBefore = new Date(to.getTime() + BATCH_COHORT_HORIZON_MS - 1);
    const justAfter = new Date(to.getTime() + BATCH_COHORT_HORIZON_MS);
    expect(isCohortMatured(to, BATCH_COHORT_HORIZON_MS, justBefore)).toBe(
      false,
    );
    expect(isCohortMatured(to, BATCH_COHORT_HORIZON_MS, justAfter)).toBe(true);
  });

  it('по умолчанию использует текущее время, когда `now` не передан', () => {
    // Горизонт «в прошлом» относительно to — сейчас уже точно позже.
    const longAgo = new Date('2000-01-01T00:00:00.000Z');
    expect(isCohortMatured(longAgo, SESSION_COHORT_HORIZON_MS)).toBe(true);
  });
});
