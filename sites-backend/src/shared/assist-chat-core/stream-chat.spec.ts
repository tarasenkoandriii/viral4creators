// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/assist-chat-core/stream-chat.spec.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

import { ACTIONS_DELIMITER } from './delimiter-buffer';
import { ChatStreamEvent } from './protocol';
import {
  ChatStreamOutcome,
  ModelStreamChunk,
  runChatStream,
  RunChatStreamOptions,
} from './stream-chat';

type Ev = ChatStreamEvent<{ kind: string }, 'upstream'>;

function fromChunks(chunks: ModelStreamChunk[], failAfter?: Error) {
  return (async function* () {
    for (const c of chunks) yield c;
    if (failAfter) throw failAfter;
  })();
}

async function drain(
  options: Partial<RunChatStreamOptions<{ kind: string }, 'upstream'>> &
    Pick<RunChatStreamOptions<{ kind: string }, 'upstream'>, 'openStream'>,
): Promise<{ events: Ev[]; outcome: ChatStreamOutcome }> {
  const gen = runChatStream<{ kind: string }, 'upstream'>({
    timeouts: { firstTokenMs: 30_000, totalMs: 90_000 },
    resolveActions: async (raw) =>
      raw
        ? ((JSON.parse(raw) as { items: { kind: string }[] }).items ?? [])
        : [],
    upstreamError: () => ({ code: 'upstream', message: 'сбой' }),
    ...options,
  });
  const events: Ev[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { events, outcome: r.value };
    events.push(r.value);
  }
}

const tokens = (events: Ev[]) =>
  events
    .filter((e): e is Extract<Ev, { type: 'token' }> => e.type === 'token')
    .map((e) => e.t)
    .join('');

describe('runChatStream', () => {
  it('штатный путь: токены без разделителя → actions → done; итог с полным текстом', async () => {
    const usage = { promptTokenCount: 10, candidatesTokenCount: 3 };
    const { events, outcome } = await drain({
      openStream: async () =>
        fromChunks([
          { text: 'Ответ ' },
          { text: 'готов.' },
          { text: ACTIONS_DELIMITER },
          { text: '{"items":[{"kind":"x"}]}', usageMetadata: usage },
        ]),
    });
    expect(tokens(events)).toBe('Ответ готов.');
    expect(events.slice(-2)).toEqual([
      { type: 'actions', items: [{ kind: 'x' }] },
      { type: 'done', usage: { in: 10, out: 3, cached: 0 } },
    ]);
    expect(outcome).toEqual({
      ok: true,
      fullText: `Ответ готов.${ACTIONS_DELIMITER}{"items":[{"kind":"x"}]}`,
      usageMeta: usage,
    });
  });

  it('без разделителя хвост буфера отдаётся в конце, actions нет', async () => {
    const { events } = await drain({
      openStream: async () => fromChunks([{ text: 'коротко' }]),
    });
    expect(events).toEqual([
      { type: 'token', t: 'коротко' },
      { type: 'done', usage: { in: 0, out: 0, cached: 0 } },
    ]);
  });

  it('ответ, оборванный посреди разделителя, — без служебного обрывка и без actions', async () => {
    let raw: string | null | undefined;
    const { events, outcome } = await drain({
      openStream: async () =>
        fromChunks([{ text: 'Готово. ' }, { text: '<<<acti' }]),
      resolveActions: async (r) => {
        raw = r;
        return [];
      },
    });
    expect(tokens(events)).toBe('Готово. ');
    expect(raw).toBeNull();
    expect(events.at(-1)?.type).toBe('done');
    // Полный текст (для журнала) — как пришёл от модели.
    expect(outcome.fullText).toBe('Готово. <<<acti');
  });

  it('потребитель бросил стрим посреди (return()) — таймеры сняты', async () => {
    jest.useFakeTimers();
    try {
      const gen = runChatStream<{ kind: string }, 'upstream'>({
        timeouts: { firstTokenMs: 30_000, totalMs: 90_000 },
        resolveActions: async () => [],
        upstreamError: () => ({ code: 'upstream', message: 'сбой' }),
        openStream: async () =>
          (async function* () {
            yield { text: 'первый кусок, достаточно длинный для отдачи' };
            await new Promise(() => undefined); // стрим «висит»
          })(),
      });
      const first = await gen.next();
      expect(first.done).toBe(false);
      expect(jest.getTimerCount()).toBeGreaterThan(0);
      await gen.return({ ok: false, fullText: '', usageMeta: null });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('resolveActions получает сырой JSON после разделителя (null без него)', async () => {
    const resolveActions = jest.fn().mockResolvedValue([]);
    await drain({
      openStream: async () => fromChunks([{ text: 'a' }]),
      resolveActions,
    });
    expect(resolveActions).toHaveBeenCalledWith(null);
    resolveActions.mockClear();
    await drain({
      openStream: async () =>
        fromChunks([{ text: `a${ACTIONS_DELIMITER}{"items":[]}` }]),
      resolveActions,
    });
    expect(resolveActions).toHaveBeenCalledWith('{"items":[]}');
  });

  it('сбой посреди стрима → ровно одно error, без done; итог — накопленное', async () => {
    const upstreamError = jest
      .fn()
      .mockReturnValue({ code: 'upstream', message: 'сбой' });
    const { events, outcome } = await drain({
      openStream: async () =>
        fromChunks(
          [{ text: 'Начало ответа и ещё текст' }],
          new Error('network drop'),
        ),
      upstreamError,
    });
    expect(events.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', code: 'upstream', message: 'сбой' },
    ]);
    expect(events.at(-1)?.type).toBe('error');
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(upstreamError).toHaveBeenCalledWith(expect.any(Error));
    expect(outcome).toEqual({
      ok: false,
      fullText: 'Начало ответа и ещё текст',
      usageMeta: null,
    });
  });

  it('сбой при открытии стрима — тоже error, а не исключение наружу', async () => {
    const { events, outcome } = await drain({
      openStream: () => Promise.reject(new Error('401')),
    });
    expect(events).toEqual([
      { type: 'error', code: 'upstream', message: 'сбой' },
    ]);
    expect(outcome.ok).toBe(false);
  });

  it('openStream получает сигнал, который отменяется уходом клиента', async () => {
    const ext = new AbortController();
    let seen: AbortSignal | undefined;
    await drain({
      externalSignal: ext.signal,
      openStream: async (signal) => {
        seen = signal;
        ext.abort();
        return fromChunks([]);
      },
    });
    expect(seen?.aborted).toBe(true);
  });

  it('usageMetadata берётся из последнего куска, где он был', async () => {
    const { outcome } = await drain({
      openStream: async () =>
        fromChunks([
          { text: 'a', usageMetadata: { promptTokenCount: 1 } },
          { text: 'b' },
          { text: 'c', usageMetadata: { promptTokenCount: 5 } },
        ]),
    });
    expect(outcome.usageMeta).toEqual({ promptTokenCount: 5 });
  });

  it('свой разделитель — и для стрима, и для блока действий', async () => {
    const resolveActions = jest.fn().mockResolvedValue([]);
    const { events } = await drain({
      delimiter: '##',
      openStream: async () =>
        fromChunks([{ text: 'текст#' }, { text: '#[1]' }]),
      resolveActions,
    });
    expect(tokens(events)).toBe('текст');
    expect(resolveActions).toHaveBeenCalledWith('[1]');
  });

  it('после первого куска таймер первого токена снят: пауза дольше него не обрывает стрим', async () => {
    let abortedMidway: boolean | undefined;
    const { events } = await drain({
      timeouts: { firstTokenMs: 20, totalMs: 5_000 },
      openStream: async (signal) =>
        (async function* () {
          yield { text: 'раз ' };
          await new Promise((r) => setTimeout(r, 60));
          abortedMidway = signal.aborted;
          yield { text: 'два' };
        })(),
    });
    expect(abortedMidway).toBe(false);
    expect(tokens(events)).toBe('раз два');
  });
});
