import {
  allDailyLimits,
  ANONYMOUS_LIMIT_ENV,
  budgetDeniedMessage,
  checkBudget,
  dailyLimitForAnonymous,
  dailyLimitForPlan,
  PLAN_LIMIT_ENV,
  startOfDayUtc,
} from './spend-limits';

describe('spend-limits (ТЗ §26.4)', () => {
  it('у старшего режима потолок выше', () => {
    expect(dailyLimitForPlan('LITE', {})).toBeLessThan(
      dailyLimitForPlan('STANDARD', {}),
    );
    expect(dailyLimitForPlan('STANDARD', {})).toBeLessThan(
      dailyLimitForPlan('PREMIUM', {}),
    );
  });

  it('переменная окружения задаётся в долларах', () => {
    const env = { [PLAN_LIMIT_ENV.LITE]: '7.5' };
    expect(dailyLimitForPlan('LITE', env)).toBe(7_500_000);
  });

  it('ноль — законное значение: платные вызовы запрещены', () => {
    const env = { [PLAN_LIMIT_ENV.PREMIUM]: '0' };
    expect(dailyLimitForPlan('PREMIUM', env)).toBe(0);
    expect(checkBudget(0, 0).allowed).toBe(false);
  });

  it('мусор в переменной не обнуляет потолок', () => {
    // Молча остановить сервис из-за опечатки хуже, чем работать по
    // значению из кода.
    const base = dailyLimitForPlan('LITE', {});
    for (const bad of ['', '  ', 'много', '-3', 'NaN']) {
      expect(dailyLimitForPlan('LITE', { [PLAN_LIMIT_ENV.LITE]: bad })).toBe(
        base,
      );
    }
  });

  it('у анонимных свой общий потолок', () => {
    expect(dailyLimitForAnonymous({})).toBeGreaterThan(0);
    expect(dailyLimitForAnonymous({ [ANONYMOUS_LIMIT_ENV]: '1' })).toBe(
      1_000_000,
    );
  });

  it('пускаем, пока потолок не выбран целиком', () => {
    // Стоимость вызова заранее неизвестна: резать генерацию посередине
    // или угадывать её цену хуже, чем дать последнему вызову выйти за край.
    expect(checkBudget(999_999, 1_000_000).allowed).toBe(true);
    expect(checkBudget(1_000_000, 1_000_000).allowed).toBe(false);
    expect(checkBudget(5_000_000, 1_000_000).allowed).toBe(false);
  });

  it('остаток не уходит в минус', () => {
    expect(checkBudget(5_000_000, 1_000_000).remainingMicroUsd).toBe(0);
    expect(checkBudget(400_000, 1_000_000).remainingMicroUsd).toBe(600_000);
  });

  it('в тексте отказа нет долларов, а у гостя — путь дальше', () => {
    const guest = budgetDeniedMessage(true);
    const user = budgetDeniedMessage(false);
    expect(guest).not.toMatch(/\$/);
    expect(user).not.toMatch(/\$/);
    expect(guest).toMatch(/Войдите через Telegram/);
    expect(user).toMatch(/завтра/);
  });

  it('окно суток считается от полуночи UTC', () => {
    const d = startOfDayUtc(new Date('2026-09-06T23:45:00Z'));
    expect(d.toISOString()).toBe('2026-09-06T00:00:00.000Z');
  });

  it('сводка потолков покрывает все режимы и анонимных', () => {
    const all = allDailyLimits({});
    expect(Object.keys(all.byPlan).sort()).toEqual([
      'LITE',
      'PREMIUM',
      'STANDARD',
    ]);
    expect(all.anonymous).toBeGreaterThan(0);
  });
});
