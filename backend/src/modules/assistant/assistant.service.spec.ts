/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
const generateContentStream = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContentStream };
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

import { AssistantService } from './assistant.service';
import { AssistantChatRequest } from './assistant.types';

/** Стрим из готовых текстовых кусков — как в реальном @google/genai. */
function fakeStream(chunks: Array<{ text?: string; usageMetadata?: unknown }>) {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

function build(
  overrides: {
    settings?: Partial<{
      enabled: boolean;
      proactiveEnabled: boolean;
      dailyBudgetMicroUsd: number;
      model: string;
    }>;
    spentToday?: number;
    /** Этап 99 — строки, которые вернёт `tutorialVideoAsset.findMany` (§4.8 список для промпта). */
    videoSubjectKeys?: string[];
    /** Этап 99 — что вернёт `tutorialVideoAsset.findFirst` при резолве kind:"video" (`null` — не найдено/не одобрено). */
    videoAsset?: { blobUrl: string | null; title: string } | null;
  } = {},
) {
  const settingsService = {
    get: jest.fn().mockResolvedValue({
      enabled: true,
      proactiveEnabled: true,
      dailyBudgetMicroUsd: 3_000_000,
      model: 'gemini-3.6-flash',
      ...overrides.settings,
    }),
  };
  const aiUsage = {
    spentTodayForOperation: jest
      .fn()
      .mockResolvedValue(overrides.spentToday ?? 0),
    recordGemini: jest.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    assistantExchange: { create: jest.fn().mockResolvedValue({}) },
    assistantEvent: { create: jest.fn().mockResolvedValue({}) },
    tutorialVideoAsset: {
      findMany: jest.fn().mockResolvedValue(
        (overrides.videoSubjectKeys ?? []).map((subjectKey) => ({
          subjectKey,
        })),
      ),
      findFirst: jest.fn().mockResolvedValue(overrides.videoAsset ?? null),
    },
  };
  const notify = { alert: jest.fn().mockResolvedValue(true) };
  const svc = new AssistantService(
    settingsService as any,
    aiUsage as any,
    prisma as any,
    notify as any,
  );
  return { svc, settingsService, aiUsage, prisma, notify };
}

const baseRequest: AssistantChatRequest = {
  locale: 'ru',
  page: 'how-it-works',
  messages: [{ role: 'user', content: 'Сколько стоит ролик?' }],
};

async function drain(gen: AsyncGenerator<any>) {
  const events: any[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('AssistantService.streamChat (ТЗ §4.4)', () => {
  it('disabled=false → error disabled, Gemini не зовётся', async () => {
    const { svc } = build({ settings: { enabled: false } });
    const events = await drain(svc.streamChat(baseRequest, '1.2.3.4'));
    expect(events).toEqual([
      { type: 'error', code: 'disabled', message: expect.any(String) },
    ]);
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('дневной бюджет исчерпан → error budget_exhausted, уведомление и событие в аналитику', async () => {
    const { svc, notify, prisma } = build({
      spentToday: 5_000_000,
      settings: { dailyBudgetMicroUsd: 3_000_000 },
    });
    const events = await drain(svc.streamChat(baseRequest, '1.2.3.4'));
    expect(events).toEqual([
      { type: 'error', code: 'budget_exhausted', message: expect.any(String) },
    ]);
    expect(generateContentStream).not.toHaveBeenCalled();
    expect(notify.alert).toHaveBeenCalledWith(
      'assistant-budget-exhausted',
      expect.any(String),
    );
    expect(prisma.assistantEvent.create).toHaveBeenCalledWith({
      data: { kind: 'server_error', detail: 'budget_exhausted' },
    });
  });

  it('стримит токены, разбирает actions, не пропускает разделитель в токены (§5.4)', async () => {
    generateContentStream.mockResolvedValue(
      fakeStream([
        { text: 'Ролик ' },
        { text: 'стоит по формуле.' },
        { text: '<<<actions>>>' },
        {
          text: '{"items":[{"kind":"plan","planId":"STANDARD"}]}',
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            cachedContentTokenCount: 80,
          },
        },
      ]),
    );
    const { svc, aiUsage, prisma } = build();
    const events = await drain(svc.streamChat(baseRequest, '1.2.3.4'));

    const tokenText = events
      .filter((e) => e.type === 'token')
      .map((e) => e.t)
      .join('');
    expect(tokenText).toBe('Ролик стоит по формуле.');
    expect(tokenText).not.toContain('<<<actions>>>');

    const actionsEvent = events.find((e) => e.type === 'actions');
    expect(actionsEvent.items).toEqual([{ kind: 'plan', planId: 'STANDARD' }]);

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent.usage).toEqual({ in: 100, out: 20, cached: 80 });

    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'assistant',
        userId: null,
        sessionId: null,
      }),
    );
    expect(prisma.assistantExchange.create).toHaveBeenCalledTimes(1);
    const created = (prisma.assistantExchange.create as jest.Mock).mock
      .calls[0][0].data;
    expect(created.answer).toBe('Ролик стоит по формуле.');
    expect(created.actions).toEqual([{ kind: 'plan', planId: 'STANDARD' }]);
    expect(created.triggeredBy).toBe('user');
  });

  it('буферизует разделитель, даже когда он приходит по одному символу за раз', async () => {
    const delimiter = '<<<actions>>>';
    generateContentStream.mockResolvedValue(
      fakeStream([
        { text: 'Ответ.' },
        ...delimiter.split('').map((ch) => ({ text: ch })),
        { text: '{"items":[]}' },
      ]),
    );
    const { svc } = build();
    const events = await drain(svc.streamChat(baseRequest, '1.2.3.4'));
    const tokenText = events
      .filter((e) => e.type === 'token')
      .map((e) => e.t)
      .join('');
    expect(tokenText).toBe('Ответ.');
  });

  it('маскирует e-mail в сохранённом ответе, помечает flagged на запрещённых обещаниях', async () => {
    generateContentStream.mockResolvedValue(
      fakeStream([{ text: 'Пишите на test@example.com — у нас безлимит.' }]),
    );
    const { svc, prisma } = build();
    await drain(svc.streamChat(baseRequest, '1.2.3.4'));
    const created = (prisma.assistantExchange.create as jest.Mock).mock
      .calls[0][0].data;
    expect(created.answer).not.toContain('test@example.com');
    expect(created.flagged).toBe(true);
  });

  it('сбой стрима после первых токенов → error upstream, накопленное всё равно записывается', async () => {
    generateContentStream.mockResolvedValue(
      (async function* () {
        yield { text: 'Начало ответа' };
        throw new Error('network drop');
      })(),
    );
    const { svc, prisma } = build();
    const events = await drain(svc.streamChat(baseRequest, '1.2.3.4'));
    expect(
      events.some((e) => e.type === 'error' && e.code === 'upstream'),
    ).toBe(true);
    expect(prisma.assistantExchange.create).toHaveBeenCalledTimes(1);
  });

  it('подставляет карточку шага в системный промпт, когда пришёл stepId', async () => {
    generateContentStream.mockResolvedValue(fakeStream([{ text: 'ок' }]));
    const { svc } = build();
    await drain(svc.streamChat({ ...baseRequest, stepId: 2 }, '1.2.3.4'));
    const callArgs = generateContentStream.mock.calls[0][0];
    expect(callArgs.config.systemInstruction).toContain('Выберите референс');
  });

  describe('видео-действие (этап 99, §4.8)', () => {
    it('доступные subjectKey подставляются в системный промпт', async () => {
      generateContentStream.mockResolvedValue(fakeStream([{ text: 'ок' }]));
      const { svc, prisma } = build({
        videoSubjectKeys: ['plan-upgrade', 'export-video'],
      });
      await drain(svc.streamChat(baseRequest, '1.2.3.4'));
      const callArgs = generateContentStream.mock.calls[0][0];
      expect(callArgs.config.systemInstruction).toContain('plan-upgrade');
      expect(callArgs.config.systemInstruction).toContain('export-video');
      expect(prisma.tutorialVideoAsset.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { locale: 'ru', reviewed: true, blobUrl: { not: null } },
        }),
      );
    });

    it('без одобренных видео раздел в промпт не добавляется', async () => {
      generateContentStream.mockResolvedValue(fakeStream([{ text: 'ок' }]));
      const { svc } = build({ videoSubjectKeys: [] });
      await drain(svc.streamChat(baseRequest, '1.2.3.4'));
      const callArgs = generateContentStream.mock.calls[0][0];
      expect(callArgs.config.systemInstruction).not.toContain(
        'Доступные обучающие видео',
      );
    });

    it('kind:video с найденным одобренным видео получает url/title от сервера, не от модели', async () => {
      generateContentStream.mockResolvedValue(
        fakeStream([
          { text: 'Вот видео.' },
          { text: '<<<actions>>>' },
          {
            text: '{"items":[{"kind":"video","subjectKey":"plan-upgrade"}]}',
          },
        ]),
      );
      const { svc, prisma } = build({
        videoAsset: {
          blobUrl: 'https://blob.example/plan-upgrade.mp4',
          title: 'Как сменить тариф',
        },
      });
      const events = await drain(svc.streamChat(baseRequest, '1.2.3.4'));
      const actionsEvent = events.find((e) => e.type === 'actions');
      expect(actionsEvent.items).toEqual([
        {
          kind: 'video',
          subjectKey: 'plan-upgrade',
          url: 'https://blob.example/plan-upgrade.mp4',
          title: 'Как сменить тариф',
        },
      ]);
      expect(prisma.tutorialVideoAsset.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            subjectKey: 'plan-upgrade',
            locale: 'ru',
            reviewed: true,
            blobUrl: { not: null },
          },
        }),
      );
      const created = (prisma.assistantExchange.create as jest.Mock).mock
        .calls[0][0].data;
      expect(created.actions).toEqual([
        {
          kind: 'video',
          subjectKey: 'plan-upgrade',
          url: 'https://blob.example/plan-upgrade.mp4',
          title: 'Как сменить тариф',
        },
      ]);
    });

    it('kind:video без найденного одобренного видео молча выбрасывается', async () => {
      generateContentStream.mockResolvedValue(
        fakeStream([
          { text: 'Вот видео.' },
          { text: '<<<actions>>>' },
          {
            text: '{"items":[{"kind":"video","subjectKey":"nonexistent"}]}',
          },
        ]),
      );
      const { svc } = build({ videoAsset: null });
      const events = await drain(svc.streamChat(baseRequest, '1.2.3.4'));
      const actionsEvent = events.find((e) => e.type === 'actions');
      expect(actionsEvent).toBeUndefined();
    });
  });
});
