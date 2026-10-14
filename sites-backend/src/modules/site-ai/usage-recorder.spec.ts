import { geminiUsageUnits } from '../../shared/ai-pricing';
import { AiUsageRecorder, productOf, type UsageDb } from './usage-recorder';
import { LEARNING_BUDGET_OPERATIONS, SITE_AI_OPERATIONS } from './operations';

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

  it('ответ Gemini со звуком на входе — звук по своей ставке (C1 захода 8)', async () => {
    const { db, rows } = fakeDb();
    const r = await new AiUsageRecorder().record(db, {
      accountId: 'acc',
      siteId: 'site',
      operation: 'assist-chat',
      model: 'gemini-2.5-flash-lite',
      units: geminiUsageUnits({
        promptTokenCount: 2_000_000,
        candidatesTokenCount: 0,
        promptTokensDetails: [
          { modality: 'TEXT', tokenCount: 1_000_000 },
          { modality: 'AUDIO', tokenCount: 1_000_000 },
        ],
      }),
    });
    // 1M звука × $0.30 + 1M текста × $0.10; в строку — весь вход.
    expect(r).toEqual({ costMicroUsd: 400_000, unpriced: false });
    expect(rows[0]).toMatchObject({ inputTokens: 2_000_000 });
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

describe('AI Publisher (P-A0, §12.1): операции pub-* — продукт publisher', () => {
  it('одиннадцать операций Publisher в списке, все — продукт publisher', () => {
    const pub = SITE_AI_OPERATIONS.filter((o) => o.startsWith('pub-'));
    expect(pub).toEqual([
      'pub-questions-cluster',
      'pub-brief-draft',
      'pub-draft-write',
      'pub-claims-extract',
      'pub-qa-review',
      'pub-adaptation-make',
      'pub-distribution-plan',
      'pub-venues-compare',
      'pub-helper-answer',
      'pub-eval',
      'pub-reddit-draft',
    ]);
    for (const o of pub) expect(productOf(o)).toBe('publisher');
    // Бюджет обучения помощника операции Publisher не трогают.
    expect(LEARNING_BUDGET_OPERATIONS.some((o) => o.startsWith('pub-'))).toBe(
      false,
    );
  });

  it('прочие операции — прежние продукты', () => {
    expect(productOf('assist-chat')).toBe('assist');
    expect(productOf('qa-anything')).toBe('qa');
  });

  it('строка вызова Publisher пишется с product=publisher', async () => {
    const { db, rows } = fakeDb();
    await new AiUsageRecorder().record(db, {
      accountId: 'acc',
      siteId: 'site',
      operation: 'pub-brief-draft',
      model: 'gemini-2.5-flash',
      units: { inputTokens: 10, outputTokens: 5 },
    });
    expect(rows[0]).toMatchObject({
      product: 'publisher',
      operation: 'pub-brief-draft',
    });
  });
});
