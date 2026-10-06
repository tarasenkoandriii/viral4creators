import { QA_HOOKS } from './qa-hooks';
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
// `AiUsageService` тянет `SessionService`, а тот рантайм-импортирует
// `WorkflowKind` из `@prisma/client` (см. тот же класс проблемы в
// доккомментариях `cron-jobs.service.spec.ts`) — мокается напрямую как
// прямая зависимость конструктора, глубже разматывать цепочку незачем:
// сам `AiUsageService` в этом файле не тестируется.
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));

const generateContent = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: class {
    // Ответ «модели» для темы поздравления — с экранами поздравления
    // (01.10.2026: валидатор отвергает экран чужого мастера). Тесты
    // задают ответ одним текстом на все темы; для поздравления он
    // переводится на эквивалентный сценарий его семьи.
    models = {
      generateContent: (args: { contents: Array<{ text: string }> }) =>
        Promise.resolve(generateContent(args)).then((res) =>
          greetingize(args?.contents?.[0]?.text ?? '', res),
        ),
    };
  },
}));

// Десять шагов реальной обучалки не нужны для этого теста — фиксируем
// свою короткую базу знаний, чтобы тест не зависел от содержимого
// generated.ts и не переписывался при каждой правке текстов обучалки.
jest.mock('../../common/tutorial-knowledge/generated', () => ({
  ASSISTANT_STEPS: {
    ru: [
      { title: 'Шаг 1', text: 'Первый шаг', details: [] },
      { title: 'Шаг 2', text: 'Второй шаг', details: [] },
    ],
    // Вторая локаль — с этапа C: без неё «генерируем на всех
    // запрошенных языках» проверить нечем.
    en: [
      { title: 'Step 1', text: 'First step', details: [] },
      { title: 'Step 2', text: 'Second step', details: [] },
    ],
  },
  // Вторая семья тем (29.09.2026) — поздравление. Здесь по одной на
  // локаль, а не пять: проверяется, что генератор ВООБЩЕ ходит по
  // второй семье и берёт её ключи как есть, а не выводит из индекса.
  GREETING_TUTORIAL_TOPICS: {
    'ru:greeting-brief': {
      title: 'Повод',
      text: 'Расскажите о поводе',
      details: [],
    },
    'en:greeting-brief': {
      title: 'Occasion',
      text: 'Describe the occasion',
      details: [],
    },
  },
}));

const keyBefore = process.env.GEMINI_API_KEY;
const telegramBefore = process.env.FIXTURE_TELEGRAM_ID;
beforeAll(() => {
  process.env.GEMINI_API_KEY = 'test-key';
  // Фикстура настроена — иначе расходу не на кого лечь, и проверка
  // владельца ниже проверяла бы только заглушку.
  process.env.FIXTURE_TELEGRAM_ID = '424242';
});
afterAll(() => {
  if (keyBefore === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = keyBefore;
  if (telegramBefore === undefined) delete process.env.FIXTURE_TELEGRAM_ID;
  else process.env.FIXTURE_TELEGRAM_ID = telegramBefore;
});

import {
  GENERATE_DEADLINE_MS,
  TutorialScenarioGeneratorService,
} from './tutorial-scenario-generator.service';
import { GENERATE_ROTATION_SETTING_KEY } from './generate-rotation';
import { stableStringify } from '../../common/stable-json';

function build(storedLocales: string | null = null) {
  const prisma = {
    tutorialScenario: {
      // По умолчанию строки нет — обычный первый прогон.
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'ts-1' }),
      update: jest.fn().mockResolvedValue({ id: 'ts-1' }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'usr_fixture' }) },
  };
  const aiUsage = {
    recordGemini: jest.fn().mockResolvedValue(undefined),
    // Суточный потолок (сквозной аудит 29.09.2026): ноль потраченного
    // — прежние тесты он не трогает, свои проверяют его явно.
    spentTodayForOperation: jest.fn().mockResolvedValue(0),
  };
  // `null` — настройки нет, то есть умолчание `['ru']`: ровно то, что
  // генератор делал до этапа C.
  const settings = {
    get: jest.fn().mockResolvedValue(storedLocales),
    // Карта ротации (пункт A1) пишется в конце прогона; прежним тестам
    // её содержимое безразлично, свои проверяют его явно.
    set: jest.fn().mockResolvedValue(undefined),
  };
  const service = new TutorialScenarioGeneratorService(
    prisma as any,
    aiUsage as any,
    settings as any,
  );
  return { service, prisma, aiUsage, settings };
}

function greetingize(prompt: string, res: any): any {
  if (!res || typeof res.text !== 'string') return res;
  // Тема поздравления узнаётся по промпту: в нём нет экранов рекламного
  // мастера. Сценарий переводится на экраны своей семьи с сохранением
  // всего остального (реплик, платных маркеров) — тесты проверяют их.
  if (!/"greeting-video"/.test(prompt) || /"generate-ready"/.test(prompt)) {
    return res;
  }
  if (res.text === FREE_SCENARIO_TEXT) {
    return { ...res, text: GREETING_SCENARIO_TEXT };
  }
  let json: any;
  try {
    json = JSON.parse(res.text);
  } catch {
    return res;
  }
  if (!Array.isArray(json?.steps)) return res;
  json.steps = json.steps.map((st: any) => {
    if (st?.kind === 'goto' && !String(st.route).startsWith('greeting-')) {
      return { ...st, route: 'greeting-video' };
    }
    // Только хуки каталога: выдуманный селектор обязан остаться выдуманным
    // — его отказ проверяют отдельно.
    const hook = /data-qa="([^"]+)"/.exec(String(st?.selector ?? ''))?.[1];
    if (hook && hook in QA_HOOKS && !hook.startsWith('greeting-')) {
      return {
        ...st,
        selector:
          st.kind === 'click'
            ? '[data-qa="greeting-brief-save"]'
            : '[data-qa="greeting-brief-card"]',
      };
    }
    return st;
  });
  return { ...res, text: JSON.stringify(json) };
}

const GREETING_SCENARIO_TEXT = JSON.stringify({
  steps: [
    { route: 'greeting-video', kind: 'goto' },
    { selector: '[data-qa="greeting-brief-card"]', kind: 'waitFor' },
  ],
});

// Порядок ключей НАРОЧНО не тот, в каком их вернёт `jsonb`:
// `selector` короче `kind`? нет — значит Postgres переставит. На этой
// разнице и ломалось сравнение «изменились ли шаги».
const FREE_SCENARIO_TEXT = JSON.stringify({
  steps: [
    { route: 'generate-ready', kind: 'goto' },
    { selector: '[data-qa="analysis-continue"]', kind: 'click' },
  ],
});

const COSTLY_SCENARIO_TEXT = JSON.stringify({
  steps: [
    { kind: 'goto', route: 'generate-ready-to-render' },
    {
      kind: 'triggerPaidOperation',
      operation: 'generation',
      model: 'veo-3.1-generate-preview',
      expectedUnits: { seconds: 8 },
      note: 'Veo рендер',
    },
    { kind: 'click', selector: '[data-qa="video-generate"]' },
  ],
});

beforeEach(() => {
  generateContent.mockReset();
});

describe('TutorialScenarioGeneratorService.run', () => {
  it('движок для промпта берётся из настройки мастера, а не зашит', async () => {
    // Иначе прикидка разойдётся с настоящей тратой в разы, как только
    // оператор переключит провайдера: промпт продолжит просить модели
    // прежнего движка.
    const { service, settings } = build();
    settings.get.mockImplementation(async (key: string) =>
      key === 'default_video_provider' ? 'veo' : '["ru"]',
    );

    await service.run();

    const prompt = generateContent.mock.calls[0][0].contents[0].text as string;
    expect(prompt).toContain('veo-3.1-generate-preview');
    expect(prompt).not.toContain('grok-imagine-video-1.5:480p');
  });

  it('настройки нет — промпт просит Grok, умолчание продукта', async () => {
    const { service } = build();

    await service.run();

    const prompt = generateContent.mock.calls[0][0].contents[0].text as string;
    expect(prompt).toContain('grok-imagine-video-1.5:480p');
    expect(prompt).not.toContain('veo-3.1-generate-preview');
  });

  it('правленная руками пара не доходит до модели — и не оплачивается', async () => {
    // `generatedBy: 'manual'` объявлен договором «со следующей ночи
    // генератор эту строку не трогает». До сквозного аудита 29.09.2026
    // проверка стояла ПОСЛЕ вызова модели и после записи расхода: он
    // её трогал, просто платно и впустую.
    const { service, prisma, aiUsage } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      generatedBy: 'manual',
    });

    const result = await service.run();

    expect(generateContent).not.toHaveBeenCalled();
    expect(aiUsage.recordGemini).not.toHaveBeenCalled();
    expect(result.skippedManual).toBeGreaterThan(0);
    expect(result.generated).toBe(0);
  });

  it('суточный потолок выбран — генерация откладывается, модель не зовём', async () => {
    const { service, settings, aiUsage } = build();
    settings.get.mockImplementation(async (key: string) =>
      key === 'postprod.tutorialDailyBudgetUsd' ? '1' : '["ru"]',
    );
    aiUsage.spentTodayForOperation.mockResolvedValue(1_000_000);

    const result = await service.run();

    expect(result.skipped).toContain('потолок');
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('селектор не из каталога data-qa — сценарий отклонён целиком, в базу не пишется (этап I)', async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        steps: [
          { kind: 'goto', route: 'generate' },
          { kind: 'click', selector: '[data-qa="next-button"]' },
        ],
      }),
      usageMetadata: {},
    });
    const { service, prisma } = build();

    const result = await service.run();

    expect(result.generated).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures[0].reason).toContain('next-button');
    expect(result.failures[0].reason).toContain('шаг 2');
    expect(prisma.tutorialScenario.create).not.toHaveBeenCalled();
  });

  it('вторая ночь с другой формулировкой — строка НЕ считается изменённой', async () => {
    // Главная находка аудита этапа D. Крон идёт каждую ночь, реплика
    // — свободный текст, и модель формулирует её заново. Без
    // слияния «строка не совпала» означало бы: полный пересинтез
    // набора (до $6), полная пересборка всех роликов и снятая
    // отметка о вычитке — каждую ночь, молча.
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        steps: [
          {
            kind: 'goto',
            route: 'generate-ready',
            narration: 'Сегодня модель сказала иначе.',
          },
        ],
      }),
      usageMetadata: {},
    });
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      steps: [
        {
          kind: 'goto',
          route: 'generate-ready',
          narration: 'Вчерашняя формулировка.',
        },
      ],
      generatedBy: 'ai',
      costly: false,
      approved: false,
      narrationReviewedAt: new Date('2026-09-01'),
    });

    await service.run();

    const data = prisma.tutorialScenario.update.mock.calls[0][0].data;
    // Реплика осталась вчерашняя — значит совпадут и ключ кеша
    // озвучки, и отпечаток сборки.
    expect((data.steps as Record<string, unknown>[])[0].narration).toBe(
      'Вчерашняя формулировка.',
    );
    // И ничего не сброшено: ни отметка о вычитке, ни результат
    // прогона.
    expect(data).not.toHaveProperty('narrationReviewedAt');
    expect(data).not.toHaveProperty('lastRunStatus');
  });

  it('изменился САМ шаг — новая реплика приезжает вместе с ним', async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        steps: [
          {
            kind: 'goto',
            route: 'generate-ready-to-render',
            narration: 'Новая реплика к новому шагу.',
          },
        ],
      }),
      usageMetadata: {},
    });
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      steps: [
        {
          kind: 'goto',
          route: 'generate-ready',
          narration: 'Старая реплика.',
        },
      ],
      generatedBy: 'ai',
      costly: false,
      approved: false,
      narrationReviewedAt: new Date('2026-09-01'),
    });

    await service.run();

    const data = prisma.tutorialScenario.update.mock.calls[0][0].data;
    expect((data.steps as Record<string, unknown>[])[0].narration).toBe(
      'Новая реплика к новому шагу.',
    );
    expect(data).toMatchObject({ narrationReviewedAt: null });
  });

  it('шаги изменились — отметка о вычитке снимается', async () => {
    // Вычитан был ПРЕЖНИЙ текст. Перенести подпись человека на новый
    // значит подписаться за то, чего он не читал (§3-бис.5 ТЗ).
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      steps: [{ kind: 'goto', route: 'item' }],
      generatedBy: 'ai',
      costly: false,
      approved: false,
      narrationReviewedAt: new Date('2026-09-01'),
    });

    await service.run();

    expect(prisma.tutorialScenario.update.mock.calls[0][0].data).toMatchObject({
      narrationReviewedBy: null,
      narrationReviewedAt: null,
    });
  });

  it('шаги НЕ изменились — отметка остаётся', async () => {
    // Без этого условия крон снимал бы отметку каждую ночь, и при
    // включённом требовании вычитки озвучить что-либо стало бы
    // невозможно в принципе: оператор отмечает днём, крон снимает
    // ночью.
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      // Те же шаги в порядке ключей, в каком их вернёт `jsonb`
      // (короткие раньше длинных) — то есть «не изменилось».
      steps: [
        { kind: 'goto', route: 'generate-ready' },
        { kind: 'click', selector: '[data-qa="analysis-continue"]' },
      ],
      generatedBy: 'ai',
      costly: false,
      approved: false,
      narrationReviewedAt: new Date('2026-09-01'),
    });

    await service.run();

    const data = prisma.tutorialScenario.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('narrationReviewedAt');
    expect(data).not.toHaveProperty('narrationReviewedBy');
  });

  it('повисшее объявление платного вызова вырезано, сценарий записан НЕплатным (повторный аудит этапа F)', async () => {
    // Без вырезания сценарий получал бы `costly: true`, выпадал бы из
    // ночной выборки `OR: [{costly:false},{approved:true}]` и ролика
    // не получал ВОВСЕ — до одобрения траты, которой в нём не
    // случится. Строки в журнале при этом нет: он просто не попадает
    // в `findMany`.
    const withDanglingPaid = JSON.stringify({
      steps: [
        {
          kind: 'goto',
          route: 'generate-ready',
          narration: 'Открываем экран.',
        },
        {
          kind: 'triggerPaidOperation',
          operation: 'generation',
          model: 'veo-3.1-generate-preview',
          expectedUnits: { seconds: 8 },
          note: 'Veo, ожидаемо 8 секунд рендера',
        },
        {
          kind: 'assertVisible',
          selector: '[data-qa="video-result"]',
          narration: 'Ролик готов.',
        },
      ],
    });
    generateContent.mockResolvedValue({
      text: withDanglingPaid,
      usageMetadata: {},
    });
    const { service, prisma } = build();

    const result = await service.run();

    expect(result.generated).toBe(3);
    expect(result.failed).toBe(0);
    // Оператору сказано поимённо — иначе единственным следом правки
    // было бы то, что сценарий ПЕРЕСТАЛ быть платным, а «перестал» в
    // журнале не видно вовсе.
    expect(result.failures[0]).toEqual({
      subjectKey: '1',
      locale: 'ru',
      reason: expect.stringContaining('шаг 2'),
    });
    expect(result.failures[0].reason).toContain('generation');
    const written = prisma.tutorialScenario.create.mock.calls[0][0].data;
    expect(written.costly).toBe(false);
    expect(
      (written.steps as Record<string, unknown>[]).map((s) => s.kind),
    ).toEqual(['goto', 'assertVisible']);
  });

  it('отброшенная реплика НЕ отменяет сценарий — он записан, кадр немой', async () => {
    // Единственное место, где всё-или-ничего сознательно не
    // применяется: плохая подпись к кадру не должна лишать нас
    // регрессионного прогона, ради которого сценарий и существует
    // (§3-бис.2 ТЗ).
    const withBadNarration = JSON.stringify({
      steps: [
        { kind: 'goto', route: 'generate-ready', narration: 'x'.repeat(300) },
        {
          kind: 'click',
          selector: '[data-qa="analysis-continue"]',
          narration: 'Идём дальше.',
        },
      ],
    });
    generateContent.mockResolvedValue({
      text: withBadNarration,
      usageMetadata: {},
    });
    const { service, prisma } = build();

    const result = await service.run();

    expect(result.generated).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.narrationsDropped).toBe(3);
    // Поимённо, а не числом: «отброшено 2» не даёт починить ни одну.
    expect(result.failures[0]).toEqual({
      subjectKey: '1',
      locale: 'ru',
      reason: expect.stringContaining('реплика шага 1 отброшена'),
    });
    // Годная реплика при этом доехала до базы, а плохая вырезана.
    const written = prisma.tutorialScenario.create.mock.calls[0][0].data
      .steps as Record<string, unknown>[];
    expect(written[0]).not.toHaveProperty('narration');
    expect(written[1].narration).toBe('Идём дальше.');
  });

  it('отброшенная реплика — это не «отказ»: счётчики разные', async () => {
    // `failed` означает «регрессионного прогона на этот шаг не
    // будет», отброшенная реплика — «прогон будет, кадр будет,
    // диктор промолчит». Смешать их значит поднять тревогу там, где
    // потерялась подпись.
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        steps: [
          {
            kind: 'click',
            selector: '[data-qa="analysis-continue"]',
            narration: '',
          },
        ],
      }),
      usageMetadata: {},
    });
    const { service } = build();

    const result = await service.run();

    expect(result.failed).toBe(0);
    expect(result.generated).toBe(3);
    expect(result.narrationsDropped).toBe(3);
  });

  it('расход генерации ложится на фикстуру, а не в анонимный потолок', async () => {
    // Пятьдесят вызовов Gemini за ночь (пять локалей × десять шагов)
    // шли БЕЗ владельца: `AiUsageService.record` помечает такую
    // строку `anonymous`, и она выбирает общий суточный потолок
    // анонимных посетителей (≈$5) — тот же, из которого платит
    // настоящий гость на лендинге (находка сквозного аудита A+B+C).
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service, prisma, aiUsage } = build();

    await service.run();

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { telegramId: '424242' },
      select: { id: true },
    });
    for (const call of aiUsage.recordGemini.mock.calls) {
      expect(call[1]).toMatchObject({ userId: 'usr_fixture' });
    }
    // Фикстуру ищем ОДИН раз на прогон, а не на каждый из пятидесяти
    // вызовов модели.
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('фикстуры нет — сценарии всё равно генерируются', async () => {
    // Расход без владельца хуже, чем с владельцем; несгенерированные
    // сценарии хуже обоих. Отказ поиска не должен ронять прогон.
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service, prisma, aiUsage } = build();
    prisma.user.findUnique.mockRejectedValue(new Error('база недоступна'));

    const result = await service.run();

    expect(result.generated).toBe(3);
    expect(aiUsage.recordGemini.mock.calls[0][1].userId).toBeUndefined();
  });

  it('генерирует по одному сценарию на каждую ТЕМУ — обе семьи', async () => {
    // Две семьи тем (29.09.2026): два шага мастера под номерами и одна
    // тема поздравления под именем. Три вызова, а не два.
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service, prisma, aiUsage } = build();

    const result = await service.run();

    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(prisma.tutorialScenario.create).toHaveBeenCalledTimes(3);
    expect(aiUsage.recordGemini).toHaveBeenCalledTimes(3);
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.objectContaining({ text: FREE_SCENARIO_TEXT }),
      expect.objectContaining({ operation: 'tutorial-scenario-generate' }),
    );
    // Ключи — как объявлены, а не как вышел индекс: тема поздравления
    // под своим именем, иначе она перезаписала бы сценарий шага «1».
    expect(
      prisma.tutorialScenario.create.mock.calls.map(
        ([a]: [{ data: { subjectKey: string } }]) => a.data.subjectKey,
      ),
    ).toEqual(['1', '2', 'greeting-brief']);
    expect(result).toEqual({
      pairs: 3,
      locales: ['ru'],
      skippedManual: 0,
      deferred: 0,
      generated: 3,
      costly: 0,
      failed: 0,
      failures: [],
      narrationsDropped: 0,
    });
  });

  it('оценивает стоимость costly-сценария через estimateScenarioCost и сохраняет её', async () => {
    generateContent
      .mockResolvedValueOnce({ text: COSTLY_SCENARIO_TEXT, usageMetadata: {} })
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} });
    const { service, prisma } = build();

    const result = await service.run();

    expect(result.costly).toBe(1);
    expect(prisma.tutorialScenario.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        subjectKey: '1',
        locale: 'ru',
        costly: true,
        estimatedCostMicroUsd: 3_200_000,
        costUnpriced: false,
      }),
    });
  });

  it('невалидный JSON на одном шаге — не роняет весь прогон, считается как failed', async () => {
    generateContent
      .mockResolvedValueOnce({ text: 'не JSON вовсе', usageMetadata: {} })
      // Хвост, а не второй `Once`: тем теперь три, и молчаливый
      // `undefined` на третьей выглядел бы вторым отказом.
      .mockResolvedValue({ text: FREE_SCENARIO_TEXT, usageMetadata: {} });
    const { service, prisma } = build();

    const result = await service.run();

    expect(result.generated).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([
      { subjectKey: '1', locale: 'ru', reason: 'ответ не JSON-объект' },
    ]);
    expect(prisma.tutorialScenario.create).toHaveBeenCalledTimes(2);
  });

  it('сетевая ошибка Gemini на одном шаге — best-effort, следующий шаг всё равно обрабатывается', async () => {
    generateContent
      .mockRejectedValueOnce(new Error('upstream недоступен'))
      .mockResolvedValue({ text: FREE_SCENARIO_TEXT, usageMetadata: {} });
    const { service } = build();

    const result = await service.run();

    expect(result.failed).toBe(1);
    expect(result.generated).toBe(2);
    expect(result.failures).toEqual([
      { subjectKey: '1', locale: 'ru', reason: 'upstream недоступен' },
    ]);
  });

  it('по умолчанию генерирует ТОЛЬКО по-русски — как до этапа C', async () => {
    // Деплой этапа не должен сам по себе учетверить ночной расход:
    // пять локалей — это пять генераций, потом пятьдесят сборок и
    // пятьдесят синтезов. Решение человека, а не побочный эффект
    // выката.
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service, prisma } = build(null);

    const result = await service.run();

    expect(result.locales).toEqual(['ru']);
    expect(prisma.tutorialScenario.create).toHaveBeenCalledTimes(3);
    for (const [arg] of prisma.tutorialScenario.create.mock.calls) {
      expect(arg.data.locale).toBe('ru');
    }
  });

  it('две локали — вдвое больше сценариев, каждый на своём языке', async () => {
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service, prisma } = build('["ru","en"]');

    const result = await service.run();

    expect(result).toMatchObject({
      pairs: 6,
      locales: ['ru', 'en'],
      generated: 6,
    });
    const pairs = prisma.tutorialScenario.create.mock.calls.map(
      ([arg]: [{ data: { subjectKey: string; locale: string } }]) => ({
        subjectKey: arg.data.subjectKey,
        locale: arg.data.locale,
      }),
    );
    // Порядок значим: сначала мастер, потом поздравление. Кончится
    // бюджет тика на середине — отложится менее обжитая половина.
    // Это порядок ПЕРВОЙ ночи (отметок ротации ещё нет); со второй его
    // определяет давность — см. блок «ротация» ниже.
    expect(pairs).toEqual([
      { subjectKey: '1', locale: 'ru' },
      { subjectKey: '2', locale: 'ru' },
      { subjectKey: 'greeting-brief', locale: 'ru' },
      { subjectKey: '1', locale: 'en' },
      { subjectKey: '2', locale: 'en' },
      { subjectKey: 'greeting-brief', locale: 'en' },
    ]);
  });

  it('промпт уходит на языке своей локали, а не на языке настройки', async () => {
    // Иначе английский сценарий получил бы русское описание шага и
    // русский `assertText` — тихий отказ, от которого §3-бис.6
    // предостерегает.
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service } = build('["ru","en"]');

    await service.run();

    const prompts = generateContent.mock.calls.map(
      ([arg]: [{ contents: { text: string }[] }]) => arg.contents[0].text,
    );
    // На локаль приходится ТРИ темы (два шага мастера и одна тема
    // поздравления), поэтому вторая локаль начинается с четвёртого
    // вызова, а не с третьего.
    expect(prompts[0]).toContain('Первый шаг');
    expect(prompts[0]).toContain('Russian');
    expect(prompts[3]).toContain('First step');
    expect(prompts[3]).toContain('English');
    // И темы разных семей описаны РАЗНЫМИ мастерами: иначе модель
    // напишет сценарий поздравления по экранам товарки.
    expect(prompts[0]).toContain('мастера генерации рекламных роликов');
    expect(prompts[2]).toContain('мастера ПОЗДРАВИТЕЛЬНОГО ролика');
  });

  it('запрошенная локаль без словаря шагов — громкий пропуск, а не «ноль шагов»', async () => {
    // Молча она выглядела бы как «сгенерировали, просто нечего».
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service, prisma } = build('["de"]');

    const result = await service.run();

    expect(result).toMatchObject({
      pairs: 0,
      generated: 0,
      failed: 0,
      // Локали в отчёте нет: рапортовать «генерировали на de», не
      // сгенерировав ничего, нельзя (правка аудита этапа C).
      locales: [],
    });
    expect(prisma.tutorialScenario.create).not.toHaveBeenCalled();
  });

  it('упавший вызов тоже помнит язык, а не только невалидный ответ', async () => {
    // Две разные ветки записи отказа — разбор и `catch`; у второй
    // локаль легко потерять, она дальше от места, где язык виден.
    // Три удачи, потом отказ: на локаль приходится ТРИ темы, поэтому
    // четвёртый вызов — первая тема второй локали.
    generateContent
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} })
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} })
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} })
      .mockRejectedValueOnce(new Error('upstream недоступен'))
      .mockResolvedValue({ text: FREE_SCENARIO_TEXT, usageMetadata: {} });
    const { service } = build('["ru","en"]');

    const result = await service.run();

    expect(result.failures).toEqual([
      { subjectKey: '1', locale: 'en', reason: 'upstream недоступен' },
    ]);
  });

  it('отказ помнит, на каком языке случился', async () => {
    // Пять локалей без этого дают пять неразличимых строк «шаг 1 не
    // сгенерирован».
    generateContent
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} })
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} })
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} })
      .mockResolvedValueOnce({ text: 'не JSON вовсе', usageMetadata: {} })
      .mockResolvedValue({ text: FREE_SCENARIO_TEXT, usageMetadata: {} });
    const { service } = build('["ru","en"]');

    const result = await service.run();

    expect(result.failures).toEqual([
      { subjectKey: '1', locale: 'en', reason: 'ответ не JSON-объект' },
    ]);
  });

  it('строку, правленную руками, генератор не трогает', async () => {
    // Промпт сам требует плейсхолдеры `[data-testid="..."]`, которые
    // оператор поправит на настоящие; §11 п.8 приёмки стоит на
    // сценарии с руками проставленными селекторами. Безусловный
    // upsert затирал эту правку молча и перещёлкивал `generatedBy`
    // обратно в `ai` (находка аудита этапа C).
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      steps: [],
      generatedBy: 'manual',
      costly: false,
      approved: false,
    });

    const result = await service.run();

    expect(prisma.tutorialScenario.update).not.toHaveBeenCalled();
    expect(prisma.tutorialScenario.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skippedManual: 3, generated: 0 });
  });

  it('шаги не изменились — одобрение и результат прогона на месте', async () => {
    // Сбрасывать их на неизменившемся сценарии значило бы гонять
    // оператора переодобрять одно и то же каждую ночь.
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      // Ключи в порядке, в каком их возвращает `jsonb`: Postgres
      // хранит короткие раньше длинных, а не в порядке записи.
      // Двойник обязан это воспроизводить, иначе сравнение через
      // `JSON.stringify` выглядело бы рабочим и на деле объявляло
      // «изменилось» на каждом прогоне (находка сквозного аудита).
      steps: [
        { kind: 'goto', route: 'generate-ready' },
        { kind: 'click', selector: '[data-qa="analysis-continue"]' },
      ],
      generatedBy: 'ai',
      costly: true,
      approved: true,
    });

    await service.run();

    const data = prisma.tutorialScenario.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('approved');
    expect(data).not.toHaveProperty('lastRunStatus');
  });

  it('база вернула те же шаги в другом порядке ключей — это НЕ изменение', () => {
    // Не тест, а напоминание: `steps` — колонка `jsonb`, Postgres
    // хранит ключи в своём порядке, и прямое сравнение строк считало
    // изменением любой сценарий с `fill`. Полноценная проверка — в
    // `common/stable-json.spec.ts`, здесь фиксируется связь.
    const fromCode = { kind: 'fill', selector: '#a', value: 'x' };
    const fromDb = { kind: 'fill', value: 'x', selector: '#a' };
    expect(stableStringify(fromCode)).toBe(stableStringify(fromDb));
  });

  it('шаги переписаны и сценарий платный — одобрение снимается', async () => {
    // Старое «да» означало бы деньги за то, чего оператор не видел:
    // модель могла поменять и модель рендера, и единицы.
    generateContent.mockResolvedValue({
      text: COSTLY_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      steps: [{ kind: 'click', selector: '[data-testid="other"]' }],
      generatedBy: 'ai',
      costly: true,
      approved: true,
    });

    await service.run();

    expect(prisma.tutorialScenario.update.mock.calls[0][0].data).toMatchObject({
      approved: false,
      approvedBy: null,
      approvedAt: null,
    });
  });

  it('шаги переписаны — статус прогона стирается, а ДАТА остаётся', async () => {
    // `lastRunStatus` относится к ШАГАМ, которых больше нет: карточка
    // показывала бы зелёное «ok» на переписанном сценарии. А вот
    // `lastRunAt` остаётся: по ней исполнитель выбирает «кто дольше
    // всех не исполнялся», и обнуление у всех строк разом вырождало
    // порядок обратно в стабильный (находка сквозного аудита).
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      steps: [{ kind: 'click', selector: '[data-testid="other"]' }],
      generatedBy: 'ai',
      costly: false,
      approved: false,
    });

    await service.run();

    const data = prisma.tutorialScenario.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ lastRunStatus: null, lastRunError: null });
    expect(data).not.toHaveProperty('lastRunAt');
  });

  it('бесплатный сценарий переписан — одобрение не трогаем, тратить нечего', async () => {
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: {},
    });
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      steps: [{ kind: 'click', selector: '[data-testid="other"]' }],
      generatedBy: 'ai',
      costly: false,
      approved: true,
    });

    await service.run();

    expect(
      prisma.tutorialScenario.update.mock.calls[0][0].data,
    ).not.toHaveProperty('approved');
  });
});

/*
 * Ротация по давности (пункт A1 обучалок). Ночь моделируется честно:
 * часы подменены, каждый вызов модели «стоит» чуть больше половины
 * бюджета, то есть за ночь успеваются ровно ДВЕ пары из шести (две
 * локали × три темы). Карта отметок живёт в настоящем хранилище между
 * ночами — так проверяется не только порядок, но и то, что он
 * переживает запись и чтение настройки.
 */
describe('TutorialScenarioGeneratorService — ротация пар по давности', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const PAIR_COST_MS = GENERATE_DEADLINE_MS / 2 + 1;
  let clock = 0;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Сервис с живым хранилищем настроек и «дорогой» моделью. */
  function buildNights(fail?: (prompt: string) => boolean) {
    const built = build('["ru","en"]');
    const store = new Map<string, string>([
      ['tutorial.scenarioLocales', '["ru","en"]'],
    ]);
    built.settings.get.mockImplementation(
      async (key: string) => store.get(key) ?? null,
    );
    built.settings.set.mockImplementation(
      async (key: string, value: string) => {
        store.set(key, value);
      },
    );
    generateContent.mockImplementation(
      async (arg: { contents: { text: string }[] }) => {
        clock += PAIR_COST_MS;
        return {
          text:
            fail && fail(arg.contents[0].text)
              ? 'не JSON вовсе'
              : FREE_SCENARIO_TEXT,
          usageMetadata: {},
        };
      },
    );
    /** Одна ночь: пары, взятые в работу, в порядке обхода. */
    async function night(n: number) {
      clock = n * DAY;
      built.prisma.tutorialScenario.findUnique.mockClear();
      const result = await built.service.run();
      // Первый `findUnique` пары — проверка «правлено руками»; он
      // идёт ровно один раз на взятую пару, до вызова модели.
      const taken = built.prisma.tutorialScenario.findUnique.mock.calls
        .map(([a]: [{ where: any; select: any }]) => a)
        .filter((a: { select: any }) => a.select.generatedBy && !a.select.steps)
        .map(
          (a: { where: { subjectKey_locale: any } }) =>
            `${a.where.subjectKey_locale.locale}:${a.where.subjectKey_locale.subjectKey}`,
        );
      return { result, taken };
    }
    return { ...built, store, night };
  }

  it('вторая ночь начинает с того, что не успела первая, — порядок не фиксирован', async () => {
    const { night } = buildNights();

    const first = await night(1);
    const second = await night(2);

    expect(first.taken).toEqual(['ru:1', 'ru:2']);
    // `en` в эту ночь не брали вовсе — и в отчёте его нет: «генерировали
    // на en», не тронув ни одной его пары, было бы неправдой.
    expect(first.result).toMatchObject({
      pairs: 6,
      deferred: 4,
      locales: ['ru'],
    });
    // Без ротации вторая ночь снова взяла бы ru:1, ru:2 — и `en` не
    // дошёл бы никогда.
    expect(second.taken).toEqual(['ru:greeting-brief', 'en:1']);
    expect(second.result.locales).toEqual(['ru', 'en']);
  });

  it('за ⌈пар / пар-за-ночь⌉ ночей покрыт весь круг, каждая пара ровно раз', async () => {
    const { night } = buildNights();

    const covered: string[] = [];
    for (let n = 1; n <= 3; n++) covered.push(...(await night(n)).taken);

    expect(covered).toHaveLength(6);
    expect(new Set(covered)).toEqual(
      new Set([
        'ru:1',
        'ru:2',
        'ru:greeting-brief',
        'en:1',
        'en:2',
        'en:greeting-brief',
      ]),
    );
    // Четвёртая ночь — второй круг, и он снова начинается с самых
    // давних, то есть с пар первой ночи.
    expect((await night(4)).taken).toEqual(['ru:1', 'ru:2']);
  });

  it('отказ модели тоже ставит отметку — сломанная пара не держит голову очереди', async () => {
    // Иначе локаль, на которой модель стабильно отказывает, каждую
    // ночь съедала бы бюджет первой, и круг не замыкался бы.
    const { night } = buildNights((prompt) => prompt.includes('Первый шаг'));

    const first = await night(1);
    const second = await night(2);

    expect(first.result.failures).toEqual([
      { subjectKey: '1', locale: 'ru', reason: 'ответ не JSON-объект' },
    ]);
    expect(second.taken).not.toContain('ru:1');
  });

  it('карта отметок хранит только пары текущего круга', async () => {
    const { night, store } = buildNights();
    store.set(
      GENERATE_ROTATION_SETTING_KEY,
      JSON.stringify({ 'de:1': '2020-01-01T00:00:00.000Z' }),
    );

    await night(1);

    const saved = JSON.parse(store.get(GENERATE_ROTATION_SETTING_KEY) ?? '{}');
    expect(Object.keys(saved).sort()).toEqual(['ru:1', 'ru:2']);
  });

  it('денежный потолок посреди прогона — остаток посчитан отложенным', async () => {
    // Без этого числа журнал ночи, оборванной деньгами, выглядел бы как
    // «круг пройден»: `pairs` — размер круга, а не число обойдённых.
    const { service, settings, aiUsage } = build();
    settings.get.mockImplementation(async (key: string) =>
      key === 'postprod.tutorialDailyBudgetUsd' ? '1' : null,
    );
    aiUsage.spentTodayForOperation.mockResolvedValue(999_999);
    generateContent.mockResolvedValue({
      text: FREE_SCENARIO_TEXT,
      usageMetadata: { promptTokenCount: 1_000_000 },
    });

    const result = await service.run();

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pairs: 3, deferred: 2, generated: 1 });
  });

  it('не удалось сохранить отметки — прогон всё равно отдаёт отчёт', async () => {
    // Сценарии уже записаны; ронять отчёт (и с ним `failures[]`) из-за
    // вспомогательной отметки хуже, чем одну ночь пройти по-старому.
    const { night, settings } = buildNights();
    settings.set.mockRejectedValue(new Error('база недоступна'));

    const { result } = await night(1);

    expect(result.generated).toBe(2);
  });
});
