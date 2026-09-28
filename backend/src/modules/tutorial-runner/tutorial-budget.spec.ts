import {
  budgetExhausted,
  openTutorialBudget,
  TUTORIAL_PAID_OPERATIONS,
} from './tutorial-budget';
import {
  DEFAULT_TUTORIAL_DAILY_BUDGET_USD,
  parseTutorialBudgetSetting,
} from './tutorial-voice';

describe('parseTutorialBudgetSetting', () => {
  it('число — потолок в долларах', () => {
    expect(parseTutorialBudgetSetting('5')).toBe(5);
    expect(parseTutorialBudgetSetting(' 0.5 ')).toBe(0.5);
  });

  it('off — потолка нет', () => {
    expect(parseTutorialBudgetSetting('off')).toBeNull();
    expect(parseTutorialBudgetSetting('OFF')).toBeNull();
  });

  it('мусор и пустота — УМОЛЧАНИЕ, а не «без потолка»', () => {
    // То же правило, что у озвучки: «не разобрали — значит человек
    // ничего не решил». Здесь особенно важно: опечатка в поле не
    // должна снимать ограничение расхода.
    for (const raw of [null, '', '   ', 'два доллара', 'NaN']) {
      expect(parseTutorialBudgetSetting(raw)).toBe(
        DEFAULT_TUTORIAL_DAILY_BUDGET_USD,
      );
    }
  });

  it('ноль и отрицательное — тоже умолчание', () => {
    // «Потолок ноль» остановил бы подсистему навсегда, и отличить это
    // от опечатки нельзя.
    expect(parseTutorialBudgetSetting('0')).toBe(
      DEFAULT_TUTORIAL_DAILY_BUDGET_USD,
    );
    expect(parseTutorialBudgetSetting('-3')).toBe(
      DEFAULT_TUTORIAL_DAILY_BUDGET_USD,
    );
  });
});

describe('budgetExhausted', () => {
  it('снятый потолок не исчерпывается никогда', () => {
    expect(
      budgetExhausted({ limitMicroUsd: null, spentMicroUsd: 999_000_000 }),
    ).toBe(false);
  });

  it('равенство считается исчерпанием', () => {
    // Строгое «больше» пропустило бы ровно одну лишнюю трату у
    // аккуратно подобранного потолка.
    expect(
      budgetExhausted({ limitMicroUsd: 1_000_000, spentMicroUsd: 1_000_000 }),
    ).toBe(true);
    expect(
      budgetExhausted({ limitMicroUsd: 1_000_000, spentMicroUsd: 999_999 }),
    ).toBe(false);
  });
});

describe('openTutorialBudget', () => {
  it('считает потраченное по ВСЕМ трём операциям одним запросом', () => {
    // Раздельные потолки позволили бы каждой операции остаться в своих
    // рамках при втрое большей сумме.
    expect([...TUTORIAL_PAID_OPERATIONS].sort()).toEqual([
      'tutorial-scenario-generate',
      'tutorial-video-assembly',
      'tutorial-voiceover',
    ]);
  });

  it('настройка переводится в микродоллары', async () => {
    const budget = await openTutorialBudget(
      { get: jest.fn().mockResolvedValue('3') } as never,
      { spentTodayForOperation: jest.fn().mockResolvedValue(250_000) } as never,
    );
    expect(budget).toEqual({
      limitMicroUsd: 3_000_000,
      spentMicroUsd: 250_000,
    });
  });

  it('журнал расходов недоступен — считаем ноль, работу не останавливаем', async () => {
    // Предохранитель не должен ронять исправный прогон.
    const budget = await openTutorialBudget(
      { get: jest.fn().mockResolvedValue('3') } as never,
      {
        spentTodayForOperation: jest.fn().mockRejectedValue(new Error('база')),
      } as never,
    );
    expect(budget.spentMicroUsd).toBe(0);
    expect(budgetExhausted(budget)).toBe(false);
  });

  it('настройка недоступна — умолчание, а не снятый потолок', async () => {
    const budget = await openTutorialBudget(
      { get: jest.fn().mockRejectedValue(new Error('база')) } as never,
      { spentTodayForOperation: jest.fn().mockResolvedValue(0) } as never,
    );
    expect(budget.limitMicroUsd).toBe(
      DEFAULT_TUTORIAL_DAILY_BUDGET_USD * 1_000_000,
    );
  });
});
