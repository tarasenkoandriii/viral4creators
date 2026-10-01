import { AiUsageRecorder, type UsageDb } from './usage-recorder';

function fakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  const db: UsageDb = {
    siteAiUsage: {
      // Только createMany: INSERT…RETURNING под assist_public упал бы (нет SELECT).
      createMany: async (args) => {
        rows.push(...(args.data as Array<Record<string, unknown>>));
        return { count: args.data.length };
      },
    },
  };
  return { db, rows };
}

describe('AiUsageRecorder → site_ai_usage', () => {
  it('эмбеддинг: $0.15 за 1M входных токенов, продукт assist, провайдер GEMINI', async () => {
    const { db, rows } = fakeDb();
    const r = await new AiUsageRecorder().record(db, {
      accountId: 'acc',
      siteId: 'site',
      operation: 'assist-embed',
      model: 'gemini-embedding-001',
      units: { inputTokens: 2_000_000 },
    });
    expect(r).toEqual({ costMicroUsd: 300_000, unpriced: false });
    expect(rows[0]).toMatchObject({
      accountId: 'acc',
      siteId: 'site',
      product: 'assist',
      provider: 'GEMINI',
      operation: 'assist-embed',
      model: 'gemini-embedding-001',
      inputTokens: 2_000_000,
      outputTokens: 0,
      calls: 1,
      costMicroUsd: 300_000,
      unpriced: false,
    });
    expect(typeof rows[0].pricingVersion).toBe('string');
  });

  it('неизвестная модель — unpriced, объём записан, деньги 0', async () => {
    const { db, rows } = fakeDb();
    const r = await new AiUsageRecorder().record(db, {
      accountId: null,
      siteId: null,
      operation: 'assist-sandbox-embed',
      model: 'no-such-model',
      units: { inputTokens: 10, calls: 3 },
    });
    expect(r).toEqual({ costMicroUsd: 0, unpriced: true });
    expect(rows[0]).toMatchObject({
      accountId: null,
      unpriced: true,
      inputTokens: 10,
      calls: 3,
    });
  });

  it('мусор в единицах не роняет запись', async () => {
    const { db, rows } = fakeDb();
    await new AiUsageRecorder().record(db, {
      accountId: 'a',
      siteId: 's',
      operation: 'assist-eval',
      model: 'gemini-3.6-flash',
      units: { inputTokens: NaN, outputTokens: -5, cachedInputTokens: 1.6 },
    });
    expect(rows[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 2,
    });
  });
});
