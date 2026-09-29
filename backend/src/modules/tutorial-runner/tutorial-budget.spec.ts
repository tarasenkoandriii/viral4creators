import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Бюджет времени тика — четвёртый боевой прогон 29.09.2026.
 *
 * Тесты здесь не про «число такое-то», а про то, что оно ВЫВЕДЕНО из
 * потолка функции, а не выбрано круглым. Круглые четыре минуты
 * пережили бы любую правку соседних констант молча.
 */
describe('RUN_DEADLINE_MS выведен из потолка функции', () => {
  // Читаем исходник: константы приватные, и делать их публичными ради
  // теста значило бы расширять контракт модуля под инструмент.
  const src = readFileSync(
    join(__dirname, 'tutorial-scenario-runner.service.ts'),
    'utf8',
  );
  const num = (name: string) =>
    Number(
      (new RegExp(`const ${name} = ([0-9_]+)`).exec(src)?.[1] ?? '0').replace(
        /_/g,
        '',
      ),
    );

  it('дедлайн = потолок минус запас на хвост, а не круглое число', () => {
    expect(src).toContain(
      'const RUN_DEADLINE_MS = TICK_CEILING_MS - TICK_TAIL_RESERVE_MS',
    );
  });

  it('запас на хвост покрывает замеренную стоимость сценария', () => {
    // 278 с и 269 с на шесть сценариев — ≈46 с вместе со сборкой.
    expect(num('TICK_TAIL_RESERVE_MS')).toBeGreaterThanOrEqual(46_000);
  });

  it('потолок функции — 300 с, и он не выдуман здесь', () => {
    expect(num('TICK_CEILING_MS')).toBe(300_000);
  });

  it('таймаут одного сценария не превышает запас на хвост… не обязан', () => {
    // SCENARIO_TIMEOUT_MS (90 с) БОЛЬШЕ запаса — и это осознанно:
    // закладывать худший случай значило бы резать пропускную
    // способность вдвое ради события, которого не было ни в одном из
    // четырёх прогонов. Тест фиксирует само знание о разрыве, чтобы
    // следующий читатель не счёл его недосмотром.
    expect(num('SCENARIO_TIMEOUT_MS')).toBeGreaterThan(
      num('TICK_TAIL_RESERVE_MS'),
    );
  });
});
