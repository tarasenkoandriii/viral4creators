/**
 * SiteChatModel (стрим виджета): потолок провайдеру — с запасом на
 * размышления; `finishReason` последнего куска виден вызывающему через
 * StreamFinish (runChatStream из shared его не читает), куски — без изменений.
 */
import {
  newStreamFinish,
  SiteChatModel,
  streamTruncated,
  type ChatModelClient,
} from './chat-model';
import { GEMINI_THINKING_HEADROOM } from '../site-ai/gemini-output';

function fakeStreamClient(chunks: unknown[]): {
  client: ChatModelClient;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    models: {
      generateContentStream: async (p: Record<string, unknown>) => {
        calls.push(p);
        return (async function* () {
          for (const c of chunks) yield c;
        })();
      },
    },
  } as unknown as ChatModelClient;
  return { client, calls };
}

async function readAll(it: AsyncIterable<{ text?: string }>): Promise<string> {
  let out = '';
  for await (const c of it) out += c.text ?? '';
  return out;
}

const req = {
  system: 'SYS',
  contents: [{ role: 'user' as const, content: 'Q' }],
  maxOutputTokens: 800,
};

describe('SiteChatModel.openStream', () => {
  it('потолок = видимый ответ + запас; обрыв MAX_TOKENS и мысли — в StreamFinish, текст кусков не тронут', async () => {
    const { client, calls } = fakeStreamClient([
      { text: 'Доставка ' },
      { text: 'коштує', candidates: [{ index: 0 }] },
      {
        text: ' 8',
        candidates: [{ finishReason: 'MAX_TOKENS' }],
        usageMetadata: { candidatesTokenCount: 30, thoughtsTokenCount: 1794 },
      },
    ]);
    const finish = newStreamFinish();
    const model = new SiteChatModel().useClient(client);
    const stream = await model.openStream(
      req,
      new AbortController().signal,
      finish,
    );
    expect(await readAll(stream)).toBe('Доставка коштує 8');
    expect(finish).toEqual({ reason: 'MAX_TOKENS', thoughts: 1794 });
    expect(streamTruncated(finish)).toBe(true);
    const cfg = calls[0].config as Record<string, unknown>;
    expect(cfg.maxOutputTokens).toBe(800 + GEMINI_THINKING_HEADROOM);
    expect(cfg.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('штатный конец (STOP) — не обрыв; без StreamFinish стрим отдаётся как есть', async () => {
    const chunks = [{ text: 'ok', candidates: [{ finishReason: 'STOP' }] }];
    const finish = newStreamFinish();
    const a = await new SiteChatModel()
      .useClient(fakeStreamClient(chunks).client)
      .openStream(req, new AbortController().signal, finish);
    expect(await readAll(a)).toBe('ok');
    expect(streamTruncated(finish)).toBe(false);
    const b = await new SiteChatModel()
      .useClient(fakeStreamClient(chunks).client)
      .openStream(req, new AbortController().signal);
    expect(await readAll(b)).toBe('ok');
  });
});

describe('transient stream opening', () => {
  it('retries one 503 before opening, using the same model and signal', async () => {
    const open = jest
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValue(
        (async function* () {
          yield { text: 'ok' };
        })(),
      );
    const model = new SiteChatModel().useClient({
      models: { generateContentStream: open },
    } as unknown as ChatModelClient);
    const signal = new AbortController().signal;
    expect(await readAll(await model.openStream(req, signal))).toBe('ok');
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[0][0]).toEqual(open.mock.calls[1][0]);
  });
  it('retries a 503 in the first stream read before any chunk', async () => {
    const open = jest
      .fn()
      .mockResolvedValueOnce(
        (async function* () {
          throw { status: 503 };
        })(),
      )
      .mockResolvedValue(
        (async function* () {
          yield { text: 'recovered' };
        })(),
      );
    const model = new SiteChatModel().useClient({
      models: { generateContentStream: open },
    } as unknown as ChatModelClient);
    expect(
      await readAll(await model.openStream(req, new AbortController().signal)),
    ).toBe('recovered');
    expect(open).toHaveBeenCalledTimes(2);
  });
  it('shares the retry limit between opening and first read', async () => {
    const error = { status: 503 };
    const open = jest
      .fn()
      .mockRejectedValueOnce(error)
      .mockImplementation(async () =>
        (async function* () {
          throw error;
        })(),
      );
    const model = new SiteChatModel().useClient({
      models: { generateContentStream: open },
    } as unknown as ChatModelClient);
    await expect(
      readAll(await model.openStream(req, new AbortController().signal)),
    ).rejects.toBe(error);
    expect(open).toHaveBeenCalledTimes(3);
  });
  it('honors a short explicit minute quota retry without changing the model', async () => {
    const error = {
      status: 429,
      message: JSON.stringify({
        error: {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [
                { quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' },
              ],
            },
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: '0.001s',
            },
          ],
        },
      }),
    };
    const open = jest
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(
        (async function* () {
          yield { text: 'ok' };
        })(),
      );
    const model = new SiteChatModel().useClient({
      models: { generateContentStream: open },
    } as unknown as ChatModelClient);
    expect(
      await readAll(await model.openStream(req, new AbortController().signal)),
    ).toBe('ok');
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[0][0]).toEqual(open.mock.calls[1][0]);
  });
  it.each([
    ['GenerateRequestsPerDayPerProjectPerModel', '1s'],
    ['GenerateRequestsPerMinutePerProjectPerModel', '45s'],
  ])(
    'does not retry daily quota or a wait exceeding the deadline (%s)',
    async (quotaId, retryDelay) => {
      const error = {
        status: 429,
        message: JSON.stringify({
          error: {
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [{ quotaId }],
              },
              {
                '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                retryDelay,
              },
            ],
          },
        }),
      };
      const open = jest.fn().mockRejectedValue(error);
      const model = new SiteChatModel().useClient({
        models: { generateContentStream: open },
      } as unknown as ChatModelClient);
      await expect(
        model.openStream(req, new AbortController().signal),
      ).rejects.toBe(error);
      expect(open).toHaveBeenCalledTimes(1);
    },
  );
  it.each([402, 401, 429])(
    'does not retry billing/auth/limit status %s',
    async (status) => {
      const error = { status };
      const open = jest.fn().mockRejectedValue(error);
      const model = new SiteChatModel().useClient({
        models: { generateContentStream: open },
      } as unknown as ChatModelClient);
      await expect(
        model.openStream(req, new AbortController().signal),
      ).rejects.toBe(error);
      expect(open).toHaveBeenCalledTimes(1);
    },
  );
  it('does not reopen a stream after it emits text and fails', async () => {
    const error = { status: 503 };
    const open = jest.fn().mockResolvedValue(
      (async function* () {
        yield { text: 'first' };
        throw error;
      })(),
    );
    const model = new SiteChatModel().useClient({
      models: { generateContentStream: open },
    } as unknown as ChatModelClient);
    const stream = await model.openStream(req, new AbortController().signal);
    await expect(readAll(stream)).rejects.toBe(error);
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('cancels the wait without making a second request', async () => {
    const abort = new AbortController();
    const open = jest.fn().mockRejectedValue({ status: 503 });
    const model = new SiteChatModel().useClient({
      models: { generateContentStream: open },
    } as unknown as ChatModelClient);
    const pending = model.openStream(req, abort.signal);
    abort.abort();
    await expect(pending).rejects.toBeDefined();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
