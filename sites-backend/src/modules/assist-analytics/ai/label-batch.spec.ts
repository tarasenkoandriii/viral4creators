/**
 * Заход 9 (хвост Э3-бис (5)): выключатель пакетного режима и разбор ответа
 * Gemini Batch API (подделка `ai.batches`, без сети).
 */
import {
  GeminiLabelBatch,
  labelBatchEnabled,
  labelBatchPriceFactor,
} from './label-batch';

describe('пакетная разметка (Gemini Batch API)', () => {
  it('выключатель: только ASSIST_LABEL_BATCH=1; доля цены — (0, 1], мусор — 0.5', () => {
    expect(labelBatchEnabled({})).toBe(false);
    expect(labelBatchEnabled({ ASSIST_LABEL_BATCH: 'true' })).toBe(false);
    expect(labelBatchEnabled({ ASSIST_LABEL_BATCH: ' 1 ' })).toBe(true);
    expect(labelBatchPriceFactor({})).toBe(0.5);
    expect(
      labelBatchPriceFactor({ ASSIST_LABEL_BATCH_PRICE_FACTOR: '0.6' }),
    ).toBe(0.6);
    for (const bad of ['0', '-1', '2', 'abc'])
      expect(
        labelBatchPriceFactor({ ASSIST_LABEL_BATCH_PRICE_FACTOR: bad }),
      ).toBe(0.5);
  });

  it('отправка: inline-запросы с ключом, JSON-ответ, потолок с запасом; ответ: текст без «мыслей», обрезанный и ошибка — null', async () => {
    const created: unknown[] = [];
    const states: Record<string, unknown> = {};
    const cancelled: string[] = [];
    const fake = {
      batches: {
        create: async (p: unknown) => {
          created.push(p);
          return { name: 'batches/1' };
        },
        get: async ({ name }: { name: string }) => states[name],
        cancel: async ({ name }: { name: string }) => {
          cancelled.push(name);
        },
      },
    };
    const c = new GeminiLabelBatch();
    (c as unknown as { client: unknown }).client = fake;
    const name = await c.submit('gemini-2.5-flash-lite', [
      {
        key: 'conv1',
        system: 'S',
        user: 'U',
        maxOutputTokens: 900,
        meta: { a: 'acc', s: 'site', e: '10', t: '2026-10-08T00:00:00.000Z' },
      },
    ]);
    expect(name).toBe('batches/1');
    const req = created[0] as {
      model: string;
      src: Array<{
        metadata: { key: string };
        config: Record<string, unknown>;
      }>;
    };
    expect(req.model).toBe('gemini-2.5-flash-lite');
    expect(req.src[0].metadata).toEqual({
      a: 'acc',
      s: 'site',
      e: '10',
      t: '2026-10-08T00:00:00.000Z',
      key: 'conv1',
    });
    expect(req.src[0].config).toMatchObject({
      systemInstruction: 'S',
      responseMimeType: 'application/json',
      temperature: 0,
    });
    expect(req.src[0].config.maxOutputTokens).toBeGreaterThan(900);

    states['batches/1'] = { state: 'JOB_STATE_RUNNING' };
    expect(await c.poll('batches/1')).toEqual({ state: 'pending' });
    states['batches/1'] = { state: 'JOB_STATE_FAILED' };
    expect(await c.poll('batches/1')).toEqual({ state: 'failed' });
    // Истекло/отменено — не «сбой»: часть ответов могла быть оплачена.
    states['batches/1'] = { state: 'JOB_STATE_EXPIRED' };
    expect(await c.poll('batches/1')).toEqual({ state: 'ended', results: [] });
    states['batches/1'] = { state: 'JOB_STATE_CANCELLED' };
    expect(await c.poll('batches/1')).toEqual({ state: 'ended', results: [] });
    await c.cancel('batches/1');
    expect(cancelled).toEqual(['batches/1']);
    const usage = {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 5,
    };
    states['batches/1'] = {
      state: 'JOB_STATE_SUCCEEDED',
      dest: {
        inlinedResponses: [
          {
            metadata: { key: 'a', s: 'site' },
            response: {
              usageMetadata: usage,
              candidates: [
                {
                  finishReason: 'STOP',
                  content: {
                    parts: [
                      { text: 'думаю', thought: true },
                      { text: '{"x":1}' },
                    ],
                  },
                },
              ],
            },
          },
          {
            metadata: { key: 'b' },
            response: {
              usageMetadata: usage,
              candidates: [
                {
                  finishReason: 'MAX_TOKENS',
                  content: { parts: [{ text: '{"x"' }] },
                },
              ],
            },
          },
          { metadata: { key: 'c' }, error: { code: 500 } },
        ],
      },
    };
    const r = await c.poll('batches/1');
    expect(r.state).toBe('succeeded');
    if (r.state !== 'succeeded') return;
    expect(r.results).toEqual([
      {
        key: 'a',
        meta: { s: 'site' },
        text: '{"x":1}',
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 25,
      },
      {
        key: 'b',
        meta: {},
        text: null,
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 25,
      },
      {
        key: 'c',
        meta: {},
        text: null,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    ]);
  });
});
