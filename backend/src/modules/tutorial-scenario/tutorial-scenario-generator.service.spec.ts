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
    models = { generateContent };
  },
}));

// Десять шагов реальной обучалки не нужны для этого теста — фиксируем
// свою короткую базу знаний, чтобы тест не зависел от содержимого
// generated.ts и не переписывался при каждой правке текстов обучалки.
jest.mock('../assistant/knowledge/generated', () => ({
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

import { TutorialScenarioGeneratorService } from './tutorial-scenario-generator.service';
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
  const settings = { get: jest.fn().mockResolvedValue(storedLocales) };
  const service = new TutorialScenarioGeneratorService(
    prisma as any,
    aiUsage as any,
    settings as any,
  );
  return { service, prisma, aiUsage, settings };
}

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

    expect(result.generated).toBe(2);
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

    expect(result.generated).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.narrationsDropped).toBe(2);
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
    expect(result.generated).toBe(2);
    expect(result.narrationsDropped).toBe(2);
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

    expect(result.generated).toBe(2);
    expect(aiUsage.recordGemini.mock.calls[0][1].userId).toBeUndefined();
  });

  it('генерирует по одному сценарию на каждый шаг обучалки и пишет их в базу', async () => {
    generateContent
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} })
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} });
    const { service, prisma, aiUsage } = build();

    const result = await service.run();

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(prisma.tutorialScenario.create).toHaveBeenCalledTimes(2);
    expect(aiUsage.recordGemini).toHaveBeenCalledTimes(2);
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.objectContaining({ text: FREE_SCENARIO_TEXT }),
      expect.objectContaining({ operation: 'tutorial-scenario-generate' }),
    );
    expect(result).toEqual({
      pairs: 2,
      locales: ['ru'],
      skippedManual: 0,
      generated: 2,
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
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} });
    const { service, prisma } = build();

    const result = await service.run();

    expect(result.generated).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([
      { subjectKey: '1', locale: 'ru', reason: 'ответ не JSON-объект' },
    ]);
    expect(prisma.tutorialScenario.create).toHaveBeenCalledTimes(1);
  });

  it('сетевая ошибка Gemini на одном шаге — best-effort, следующий шаг всё равно обрабатывается', async () => {
    generateContent
      .mockRejectedValueOnce(new Error('upstream недоступен'))
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} });
    const { service } = build();

    const result = await service.run();

    expect(result.failed).toBe(1);
    expect(result.generated).toBe(1);
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
    expect(prisma.tutorialScenario.create).toHaveBeenCalledTimes(2);
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
      pairs: 4,
      locales: ['ru', 'en'],
      generated: 4,
    });
    const pairs = prisma.tutorialScenario.create.mock.calls.map(
      ([arg]: [{ data: { subjectKey: string; locale: string } }]) => ({
        subjectKey: arg.data.subjectKey,
        locale: arg.data.locale,
      }),
    );
    expect(pairs).toEqual([
      { subjectKey: '1', locale: 'ru' },
      { subjectKey: '2', locale: 'ru' },
      { subjectKey: '1', locale: 'en' },
      { subjectKey: '2', locale: 'en' },
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
    expect(prompts[0]).toContain('Первый шаг');
    expect(prompts[0]).toContain('Russian');
    expect(prompts[2]).toContain('First step');
    expect(prompts[2]).toContain('English');
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
    generateContent
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} })
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} })
      .mockRejectedValueOnce(new Error('upstream недоступен'))
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} });
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
      .mockResolvedValueOnce({ text: 'не JSON вовсе', usageMetadata: {} })
      .mockResolvedValueOnce({ text: FREE_SCENARIO_TEXT, usageMetadata: {} });
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
    expect(result).toMatchObject({ skippedManual: 2, generated: 0 });
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
