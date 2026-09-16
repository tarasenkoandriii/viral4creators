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
  },
}));

const keyBefore = process.env.GEMINI_API_KEY;
beforeAll(() => {
  process.env.GEMINI_API_KEY = 'test-key';
});
afterAll(() => {
  if (keyBefore === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = keyBefore;
});

import { TutorialScenarioGeneratorService } from './tutorial-scenario-generator.service';

function build() {
  const prisma = {
    tutorialScenario: { create: jest.fn().mockResolvedValue({ id: 'ts-1' }) },
  };
  const aiUsage = { recordGemini: jest.fn().mockResolvedValue(undefined) };
  const service = new TutorialScenarioGeneratorService(
    prisma as any,
    aiUsage as any,
  );
  return { service, prisma, aiUsage };
}

const FREE_SCENARIO_TEXT = JSON.stringify({
  steps: [
    { kind: 'goto', route: 'wizard.product' },
    { kind: 'click', selector: '[data-testid="next"]' },
  ],
});

const COSTLY_SCENARIO_TEXT = JSON.stringify({
  steps: [
    { kind: 'goto', route: 'wizard.generation' },
    {
      kind: 'triggerPaidOperation',
      operation: 'generation',
      model: 'veo-3.1-generate-preview',
      expectedUnits: { seconds: 8 },
      note: 'Veo рендер',
    },
    { kind: 'click', selector: '[data-testid="generate"]' },
  ],
});

beforeEach(() => {
  generateContent.mockReset();
});

describe('TutorialScenarioGeneratorService.run', () => {
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
      subjectKeys: 2,
      generated: 2,
      costly: 0,
      failed: 0,
      failures: [],
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
      { subjectKey: '1', reason: 'ответ не JSON-объект' },
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
      { subjectKey: '1', reason: 'upstream недоступен' },
    ]);
  });
});
