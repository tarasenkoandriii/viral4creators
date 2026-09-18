import {
  exhaustedQuota,
  imageQuotaFor,
  startOfMonthUtc,
} from './image-generation-quota';

describe('image-generation-quota (doc/AI-SKETCH-SPEC.md §8.2)', () => {
  it('квоты по умолчанию растут со старшинством тарифа', () => {
    expect(imageQuotaFor('LITE', {})).toEqual({ day: 3, month: 20 });
    expect(imageQuotaFor('STANDARD', {})).toEqual({ day: 15, month: 150 });
    expect(imageQuotaFor('PREMIUM', {})).toEqual({ day: 50, month: 600 });
  });

  it('env переопределяет; ноль — законно; мусор — по умолчанию', () => {
    expect(
      imageQuotaFor('STANDARD', {
        AI_SKETCH_DAY_STANDARD: '0',
        AI_SKETCH_MONTH_STANDARD: 'abc',
      }),
    ).toEqual({ day: 0, month: 150 });
    expect(imageQuotaFor('LITE', { AI_SKETCH_DAY_LITE: '-1' }).day).toBe(3);
  });

  it('первым сообщается суточный лимит, затем месячный', () => {
    const q = { day: 2, month: 5 };
    expect(exhaustedQuota({ dayUsed: 1, monthUsed: 4 }, q)).toBeNull();
    expect(exhaustedQuota({ dayUsed: 2, monthUsed: 5 }, q)).toBe('day');
    expect(exhaustedQuota({ dayUsed: 0, monthUsed: 5 }, q)).toBe('month');
  });

  it('месяц начинается 1-го числа в 00:00 UTC', () => {
    expect(
      startOfMonthUtc(new Date('2026-09-17T01:30:00+03:00')).toISOString(),
    ).toBe('2026-09-01T00:00:00.000Z');
  });
});
