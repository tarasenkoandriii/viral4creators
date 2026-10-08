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

// Мок модуля `@google/genai` создаётся ОДИН раз на файл, а `mock.calls`
// накапливаются между тестами. Без очистки `mock.calls[0]` — это первый
// вызов во всём файле, а не вызов текущего теста: проверки системного
// промпта читали чужой запрос. На части из них это не проявлялось лишь
// потому, что искомая подстрока («Выберите референс») встречается ещё и
// в базе знаний, то есть в ЛЮБОМ промпте.
beforeEach(() => {
  generateContentStream.mockClear();
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
    recordGemini: jest.fn().mockImplementation(async () => {
      budget.log.push('ai-usage');
    }),
  };
  // П-Г5: резерв бюджета — транзакция с advisory-lock и строки «в полёте»
  // в `rate_limits`. Дублёр: транзакции идут строго по очереди (как под
  // `pg_advisory_xact_lock`), строки резерва — в памяти.
  const budget = {
    rows: new Map<string, { at: Date; amount: number }>(),
    reserveFails: false,
    log: [] as string[],
  };
  let chain: Promise<unknown> = Promise.resolve();
  const sqlOf = (q: TemplateStringsArray) => q.join('?');
  const tx = {
    $executeRaw: jest.fn(async (q: TemplateStringsArray, ...v: any[]) => {
      if (sqlOf(q).includes('INSERT INTO "rate_limits"')) {
        budget.rows.set(v[0], { at: v[1], amount: v[2] });
        budget.log.push('reserve');
      }
      return 1;
    }),
    $queryRaw: jest.fn(async (_q: TemplateStringsArray, ...v: any[]) => {
      const prefix = String(v[0]).replace(/%$/, '');
      let sum = 0;
      for (const [k, r] of budget.rows) {
        if (k.startsWith(prefix) && r.at > v[1]) sum += r.amount;
      }
      return [{ s: sum }];
    }),
    aiUsage: {
      aggregate: jest.fn(async () => ({
        _sum: { costMicroUsd: overrides.spentToday ?? 0 },
      })),
    },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => {
      if (budget.reserveFails) {
        return Promise.reject(new Error('db down'));
      }
      const run = chain.then(() => fn(tx));
      chain = run.catch(() => undefined);
      return run;
    }),
    $executeRaw: jest.fn(async (q: TemplateStringsArray, ...v: any[]) => {
      if (sqlOf(q).includes('DELETE FROM "rate_limits"')) {
        budget.rows.delete(v[0]);
        budget.log.push('release');
      }
      if (sqlOf(q).includes('UPDATE "rate_limits"')) {
        const row = budget.rows.get(v[1]);
        if (row) row.at = v[0];
        budget.log.push('commit');
      }
      return 1;
    }),
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
  return { svc, settingsService, aiUsage, prisma, notify, budget };
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

  it('Ш0.7: вопрос посетителя маскируется в журнале (телефон, карта, e-mail)', async () => {
    generateContentStream.mockResolvedValue(fakeStream([{ text: 'Ок.' }]));
    const { svc, prisma } = build();
    await drain(
      svc.streamChat(
        {
          ...baseRequest,
          messages: [
            {
              role: 'user',
              content:
                'Перезвоните +380 (67) 123-45-67, почта a.b@c.ua, карта 4111 1111 1111 1111',
            },
          ],
        },
        '1.2.3.4',
      ),
    );
    const created = (prisma.assistantExchange.create as jest.Mock).mock
      .calls[0][0].data;
    expect(created.question).toBe(
      'Перезвоните [телефон скрыт], почта [e-mail скрыт], карта [номер карты скрыт]',
    );
    // Сырой IP в журнал тоже не попадает — только хеш.
    expect(JSON.stringify(created)).not.toContain('1.2.3.4');
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
    // Сверяемся с ЗАГОЛОВКОМ блока, а не с названием шага: «Выберите
    // референс» встречается ещё и в базе знаний (раздел «Шаги
    // обучалки»), то есть в любом промпте — проверка на него одна
    // проходила бы, даже если карточку шага перестать подставлять вовсе.
    expect(callArgs.config.systemInstruction).toContain(
      '## Контекст: посетитель спрашивает про шаг обучалки',
    );
    expect(callArgs.config.systemInstruction).toContain('Выберите референс');
  });

  it('без stepId карточка шага не подставляется', async () => {
    generateContentStream.mockResolvedValue(fakeStream([{ text: 'ок' }]));
    const { svc } = build();
    await drain(svc.streamChat(baseRequest, '1.2.3.4'));
    const callArgs = generateContentStream.mock.calls[0][0];
    expect(callArgs.config.systemInstruction).not.toContain(
      '## Контекст: посетитель спрашивает про шаг обучалки',
    );
  });

  describe('видео-действие (этап 99, §4.8)', () => {
    it('доступные subjectKey подставляются в системный промпт', async () => {
      generateContentStream.mockResolvedValue(fakeStream([{ text: 'ок' }]));
      const { svc, prisma } = build({
        videoSubjectKeys: ['plan-upgrade', 'export-video'],
      });
      await drain(svc.streamChat(baseRequest, '1.2.3.4'));
      const callArgs = generateContentStream.mock.calls[0][0];
      expect(callArgs.config.systemInstruction).toContain(
        '## Доступные обучающие видео',
      );
      expect(callArgs.config.systemInstruction).toContain('plan-upgrade');
      expect(callArgs.config.systemInstruction).toContain('export-video');
      expect(prisma.tutorialVideoAsset.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            locale: 'ru',
            reviewed: true,
            blobUrl: { not: null },
            clientSiteDraftId: null,
            OR: [{ theme: null }, { theme: 'light' }],
            NOT: { subjectKey: { startsWith: 'site-tutorial-demo-' } },
          },
        }),
      );
    });

    it('демо обучающего лендинга в промпт не попадает — даже если база его вернула', async () => {
      // Раздел 5.3 черновика демо: ролики витрины-полигона — для секции
      // одного лендинга, консультант их не предлагает. Барьер — в
      // запросе (проверено выше) И в коде: здесь база «забыла» `NOT`.
      generateContentStream.mockResolvedValue(fakeStream([{ text: 'ок' }]));
      const { svc } = build({
        videoSubjectKeys: ['plan-upgrade', 'site-tutorial-demo-1'],
      });
      await drain(svc.streamChat(baseRequest, '1.2.3.4'));
      const prompt = generateContentStream.mock.calls[0][0].config
        .systemInstruction as string;
      expect(prompt).toContain('plan-upgrade');
      expect(prompt).not.toContain('site-tutorial-demo-1');
    });

    it('kind:video с ключом демо обучающего лендинга выбрасывается без запроса к базе', async () => {
      generateContentStream.mockResolvedValue(
        fakeStream([
          { text: 'Вот видео.' },
          { text: '<<<actions>>>' },
          {
            text: '{"items":[{"kind":"video","subjectKey":"site-tutorial-demo-2"}]}',
          },
        ]),
      );
      const { svc, prisma } = build({
        videoAsset: {
          blobUrl: 'https://blob.example/demo.mp4',
          title: 'Как оформить заказ',
        },
      });
      const events = await drain(svc.streamChat(baseRequest, '1.2.3.4'));
      const actionsEvent = events.find((e) => e.type === 'actions');
      expect(actionsEvent?.items ?? []).toEqual([]);
      expect(prisma.tutorialVideoAsset.findFirst).not.toHaveBeenCalled();
    });

    it('без одобренных видео раздел в промпт не добавляется', async () => {
      generateContentStream.mockResolvedValue(fakeStream([{ text: 'ок' }]));
      const { svc } = build({ videoSubjectKeys: [] });
      await drain(svc.streamChat(baseRequest, '1.2.3.4'));
      const callArgs = generateContentStream.mock.calls[0][0];
      // Сверяемся именно с ЗАГОЛОВКОМ блока: саму формулировку
      // «Доступные обучающие видео» правило 10 базового промпта
      // упоминает всегда — она есть в любом запросе, и проверка на
      // голую подстроку не может отличить «блок добавлен» от «блока
      // нет».
      expect(callArgs.config.systemInstruction).not.toContain(
        '## Доступные обучающие видео',
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
            clientSiteDraftId: null,
            OR: [{ theme: null }, { theme: 'light' }],
            NOT: { subjectKey: { startsWith: 'site-tutorial-demo-' } },
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

  describe('П-Г5: атомарный резерв дневного бюджета (Р-З10-5)', () => {
    /** Стрим, который стоит, пока тест не отпустит, — вопросы «в полёте». */
    function heldStream() {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      generateContentStream.mockImplementation(async () =>
        (async function* () {
          await gate;
          yield {
            text: 'Ответ.',
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          };
        })(),
      );
      return () => release();
    }

    async function oneEstimate(): Promise<number> {
      generateContentStream.mockResolvedValue(fakeStream([{ text: 'Ок.' }]));
      const probe = build();
      let amount = 0;
      const set = probe.budget.rows.set.bind(probe.budget.rows);
      probe.budget.rows.set = (k, v) => {
        amount = v.amount;
        return set(k, v);
      };
      await drain(probe.svc.streamChat(baseRequest, '1.2.3.4'));
      generateContentStream.mockClear();
      return amount;
    }

    it('10 параллельных вопросов при остатке на 2 → ровно 2 вызова модели, остальным budget_exhausted', async () => {
      const estimate = await oneEstimate();
      expect(estimate).toBeGreaterThan(1);
      const releaseModel = heldStream();
      const { svc, budget } = build({
        spentToday: 1_000_000,
        settings: {
          dailyBudgetMicroUsd: 1_000_000 + Math.floor(estimate * 2.5),
        },
      });
      const runs = Array.from({ length: 10 }, () =>
        drain(svc.streamChat(baseRequest, '1.2.3.4')),
      );
      // Все десять успели зарезервировать или получить отказ, пока
      // первые два ещё ждут модель.
      await new Promise((r) => setTimeout(r, 20));
      expect(budget.rows.size).toBe(2);
      releaseModel();
      const all = await Promise.all(runs);
      expect(generateContentStream).toHaveBeenCalledTimes(2);
      expect(
        all.filter((ev) =>
          ev.some((e) => e.type === 'error' && e.code === 'budget_exhausted'),
        ),
      ).toHaveLength(8);
      expect(budget.rows.size).toBe(0);
    });

    it('резерв снимается после записи AiUsage; при сбое стрима — тоже', async () => {
      generateContentStream.mockResolvedValue(
        fakeStream([
          {
            text: 'Ок.',
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
          },
        ]),
      );
      const ok = build();
      await drain(ok.svc.streamChat(baseRequest, '1.2.3.4'));
      expect(ok.budget.log).toEqual(['reserve', 'ai-usage', 'release']);
      expect(ok.budget.rows.size).toBe(0);

      generateContentStream.mockRejectedValue(new Error('gemini down'));
      const failed = build();
      const events = await drain(failed.svc.streamChat(baseRequest, '1.2.3.4'));
      expect(events.some((e) => e.code === 'upstream')).toBe(true);
      expect(failed.budget.log).toEqual(['reserve', 'release']);
      expect(failed.budget.rows.size).toBe(0);
    });

    it('P2-1: клиент бросил стрим после первого токена — резерв становится расходом до конца суток', async () => {
      generateContentStream.mockResolvedValue(
        fakeStream([{ text: 'Первый ' }, { text: 'второй.' }]),
      );
      // Таймеры 30/90 с ядра (`runChatStream`) при `return()` посреди
      // стрима не снимаются (ядро чистит их только на штатном выходе) —
      // поддельные таймеры, чтобы jest не ждал их 90 секунд.
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      try {
        const { svc, budget } = build();
        const gen = svc.streamChat(baseRequest, '1.2.3.4');
        const first = await gen.next();
        expect(first.value).toMatchObject({ type: 'token' });
        await gen.return(undefined);
        expect(budget.log).toEqual(['reserve', 'commit']);
        expect(budget.rows.size).toBe(1);
        const [row] = [...budget.rows.values()];
        const end = new Date();
        end.setUTCHours(24, 0, 0, 0);
        expect(row.at.getTime()).toBe(end.getTime());
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    it('P2-1: ответ без usageMetadata (расход в AiUsage не записан) — оценка остаётся расходом', async () => {
      generateContentStream.mockResolvedValue(fakeStream([{ text: 'Ок.' }]));
      const { svc, budget } = build();
      await drain(svc.streamChat(baseRequest, '1.2.3.4'));
      expect(budget.log).toEqual(['reserve', 'ai-usage', 'commit']);
    });

    it('P2-1: клиент ушёл до первого токена — резерв снимается сразу', async () => {
      generateContentStream.mockImplementation(
        async (req: { config: { abortSignal: AbortSignal } }) =>
          (async function* () {
            await new Promise((_r, reject) =>
              req.config.abortSignal.addEventListener('abort', () =>
                reject(new Error('aborted')),
              ),
            );
          })(),
      );
      const { svc, budget } = build();
      const ac = new AbortController();
      const run = drain(svc.streamChat(baseRequest, '1.2.3.4', ac.signal));
      for (let k = 0; k < 50 && budget.rows.size === 0; k++) {
        await new Promise((r) => setTimeout(r, 1));
      }
      expect(budget.rows.size).toBe(1);
      ac.abort();
      await run;
      expect(generateContentStream).toHaveBeenCalledTimes(1);
      expect(budget.log).toEqual(['reserve', 'release']);
      expect(budget.rows.size).toBe(0);
    });

    it('P3-1: тревога различает «потрачено» и «занято резервом»', async () => {
      const spent = build({
        spentToday: 3_000_000,
        settings: { dailyBudgetMicroUsd: 3_000_000 },
      });
      await drain(spent.svc.streamChat(baseRequest, '1.2.3.4'));
      expect(spent.notify.alert.mock.calls[0][1]).toBe(
        'ИИ-консультант на лендинге: дневной бюджет исчерпан — потрачено $3.00 из $3.00.',
      );

      const busy = build({
        spentToday: 1_000_000,
        settings: { dailyBudgetMicroUsd: 3_000_000 },
      });
      busy.budget.rows.set(
        'assistant-budget:' + new Date().toISOString().slice(0, 10) + ':x',
        {
          at: new Date(Date.now() + 60_000),
          amount: 1_999_999,
        },
      );
      const events = await drain(busy.svc.streamChat(baseRequest, '1.2.3.4'));
      expect(events[0]).toMatchObject({ code: 'budget_exhausted' });
      const text = busy.notify.alert.mock.calls[0][1] as string;
      expect(text).toContain('потрачено $1.00');
      expect(text).toContain('$2.00 занято вопросами в полёте и оборванными');
      expect(text).not.toContain('исчерпан');
    });

    it('база недоступна при резерве → error upstream, модель не зовётся', async () => {
      const { svc, budget, notify } = build();
      budget.reserveFails = true;
      const events = await drain(svc.streamChat(baseRequest, '1.2.3.4'));
      expect(events).toEqual([
        { type: 'error', code: 'upstream', message: expect.any(String) },
      ]);
      expect(generateContentStream).not.toHaveBeenCalled();
      expect(notify.alert).not.toHaveBeenCalled();
    });
  });
});
