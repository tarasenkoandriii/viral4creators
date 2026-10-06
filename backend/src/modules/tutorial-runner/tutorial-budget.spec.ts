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
import { countExpectedRuns } from '../cron/cron-schedule';

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
 * Бюджет времени тика — четвёртый и пятый боевые прогоны 29.09.2026.
 *
 * Тесты здесь не про «число такое-то», а про то, что оно ВЫВЕДЕНО из
 * потолка функции, а не выбрано круглым. Круглые четыре минуты
 * пережили бы любую правку соседних констант молча.
 *
 * ## Что здесь стояло раньше и почему это было хуже, чем ничего
 *
 * До пятого прогона последний тест этого блока назывался «таймаут
 * одного сценария не превышает запас на хвост… не обязан» и закреплял
 * РАЗРЫВ: `SCENARIO_TIMEOUT_MS` (90 с) больше запаса (55 с), и это
 * объявлялось осознанным, потому что «события не было ни в одном из
 * четырёх прогонов». Пятый прогон занял 298.6 с при потолке 300 —
 * хвост съел 53.6 с из 55.
 *
 * Тест, который убеждает следующего читателя, что известный разрыв —
 * не недосмотр, опаснее отсутствующего теста: отсутствующий оставляет
 * вопрос открытым, а этот закрывал его неверным ответом. Инвариант
 * ниже («худший случай помещается под потолок») — то, что должно было
 * стоять там с самого начала.
 */
describe('RUN_DEADLINE_MS выведен из потолка функции', () => {
  // Читаем исходник: константы приватные, и делать их публичными ради
  // теста значило бы расширять контракт модуля под инструмент.
  const src = readFileSync(
    join(__dirname, 'tutorial-scenario-runner.service.ts'),
    'utf8',
  );
  /** Литеральная константа из исходника. */
  const lit = (name: string) => {
    const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(src);
    if (!m) throw new Error(`константа ${name} не литеральна или исчезла`);
    return Number(m[1].replace(/_/g, ''));
  };
  // Производные считаем ТАК ЖЕ, как их считает модуль. Иначе тест
  // читает выражение как ноль и проходит впустую — что и случилось
  // при первом заходе этой правки.
  const reserve = () =>
    lit('SCENARIO_TIMEOUT_MS') +
    lit('ASSEMBLY_SUBMIT_TIMEOUT_MS') +
    lit('TICK_EXIT_RESERVE_MS');
  const deadline = () => lit('TICK_CEILING_MS') - reserve();

  it('дедлайн = потолок минус запас на хвост, а не круглое число', () => {
    expect(src).toContain(
      'const RUN_DEADLINE_MS = TICK_CEILING_MS - TICK_TAIL_RESERVE_MS',
    );
  });

  it('потолок функции — 300 с, и он не выдуман здесь', () => {
    expect(lit('TICK_CEILING_MS')).toBe(300_000);
  });

  it('запас на хвост — сумма двух границ и резерва на выход, а не замер', () => {
    // Именно выражение, а не число: замер стареет молча, сумма —
    // нет. Поменяли любое слагаемое — запас поехал следом.
    expect(src.replace(/\s+/g, ' ')).toContain(
      'const TICK_TAIL_RESERVE_MS = SCENARIO_TIMEOUT_MS + ASSEMBLY_SUBMIT_TIMEOUT_MS + TICK_EXIT_RESERVE_MS',
    );
  });

  it('после хвоста под потолком остаётся резерв на выход — не меньше 15 с', () => {
    // Аудит кронов 06.10.2026: сумма двух таймаутов была ровно 150 с,
    // и закрытие браузера, итоговая тревога и запись журнала крона в
    // арифметику не входили вовсе.
    expect(lit('TICK_EXIT_RESERVE_MS')).toBeGreaterThanOrEqual(15_000);
    expect(
      lit('TICK_CEILING_MS') -
        (deadline() +
          lit('SCENARIO_TIMEOUT_MS') +
          lit('ASSEMBLY_SUBMIT_TIMEOUT_MS')),
    ).toBeGreaterThanOrEqual(15_000);
  });

  it('худший случай помещается под потолок функции', () => {
    // Главный инвариант, и единственный, ради которого весь блок.
    // Дедлайн проверяется ПЕРЕД запуском сценария, значит последний
    // стартует в худшем случае за миг до него и стоит ещё «сценарий
    // + сборка». Сумма обязана быть под потолком — иначе платформа
    // убьёт процесс посреди отправки.
    expect(
      deadline() +
        lit('SCENARIO_TIMEOUT_MS') +
        lit('ASSEMBLY_SUBMIT_TIMEOUT_MS'),
    ).toBeLessThanOrEqual(lit('TICK_CEILING_MS'));
  });

  it('обе границы запаса ДЕЙСТВИТЕЛЬНО применяются, а не заявлены', () => {
    // Запас имеет смысл ровно настолько, насколько каждое слагаемое
    // кем-то принудительно обрывается. До пятого прогона второе
    // слагаемое не существовало вовсе: заливка кадров, синтез
    // озвучки и submit шли без единого таймаута, а время под них
    // резервировалось.
    //
    // Проверяется АРГУМЕНТ вызова, а не присутствие имени: первая
    // версия этого теста искала имя константы рядом с `withTimeout`
    // и пережила мутацию «подставить сюда другой таймаут» — имя
    // осталось в тексте сообщения об ошибке строкой ниже. Тот же
    // промах, что у швов S1/S2 в check-docs.
    expect(src).toMatch(/runScenario\([\s\S]*?\n\s*SCENARIO_TIMEOUT_MS,/);
    expect(src).toMatch(
      /this\.submitVideoAssembly\([\s\S]*?\n\s*ASSEMBLY_SUBMIT_TIMEOUT_MS,/,
    );
  });

  it('запуск браузера ограничен, и граница входит в счёт', () => {
    // До 29.09.2026 `puppeteer.launch` не был обёрнут ничем, а бюджет
    // тика отсчитывался ПОСЛЕ него. Зависший запуск не давал ни
    // ошибки, ни строки в журнале — платформа убивала функцию молча.
    const chromium = readFileSync(
      join(__dirname, '..', '..', 'common', 'headless-chromium.ts'),
      'utf8',
    );
    expect(chromium).toMatch(/withTimeout\(\s*launching,\s*LAUNCH_TIMEOUT_MS,/);
    // И бюджет считается от ВХОДА в обработчик, иначе запуск снова
    // окажется снаружи счёта.
    expect(src).toContain('const tickStartedAt = Date.now();');
    expect(src).toContain('const deadline = tickStartedAt + RUN_DEADLINE_MS;');
  });

  it('худший случай с запуском браузера тоже под потолком', () => {
    // Полная цепочка тика: запуск + последний сценарий + его сборка.
    const chromium = readFileSync(
      join(__dirname, '..', '..', 'common', 'headless-chromium.ts'),
      'utf8',
    );
    const launch = Number(
      (
        /const LAUNCH_TIMEOUT_MS = ([0-9_]+);/.exec(chromium)?.[1] ?? '0'
      ).replace(/_/g, ''),
    );
    expect(launch).toBeGreaterThan(0);
    // Запуск внутри бюджета, значит к потолку добавляется только
    // хвост: дедлайн отсчитан от входа, и всё, что было до браузера,
    // уже съело часть бюджета.
    expect(
      deadline() +
        lit('SCENARIO_TIMEOUT_MS') +
        lit('ASSEMBLY_SUBMIT_TIMEOUT_MS'),
    ).toBeLessThanOrEqual(lit('TICK_CEILING_MS'));
    // А сам запуск обязан помещаться в бюджет — иначе тик, у которого
    // браузер поднимался предельно долго, не успеет НИ ОДНОГО
    // сценария и отчитается `executed=0` без объяснения.
    expect(launch).toBeLessThan(deadline());
  });

  it('тиков в сутки хватает на полный круг одной локали по замеренной скорости', () => {
    // Пятый прогон: 8 сценариев за 298.6 с — ≈37 с на сценарий.
    // Стартов в тике: сколько их влезает до дедлайна. Тиков — сколько
    // их в сутках по расписанию `vercel.json` (решение владельца:
    // тики, а не длинная функция). Тем на локаль — 15 (десять шагов
    // мастера и пять тем поздравления).
    //
    // Пяти локалям (75 пар) круг за сутки не помещается (≈60 стартов),
    // и это осознанно: прошедший сценарий с неизменными шагами
    // повторяется не чаще `OK_RERUN_INTERVAL_MS`, а круг в сутки с
    // четвертью регрессу интерфейса хватает.
    const perScenarioMs = 37_000;
    const startsPerTick = Math.floor((deadline() - 1) / perScenarioMs) + 1;
    const vercel = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'vercel.json'), 'utf8'),
    ) as { crons: Array<{ path: string; schedule: string }> };
    const run = vercel.crons.find(
      (c) => c.path === '/api/cron/tutorial-scenario-run',
    );
    expect(run).toBeDefined();
    const day = Date.UTC(2026, 9, 6);
    const ticksPerDay = countExpectedRuns(
      run!.schedule,
      new Date(day),
      new Date(day + 86_400_000),
    );
    expect(startsPerTick * ticksPerDay).toBeGreaterThanOrEqual(15);
  });
});
