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
