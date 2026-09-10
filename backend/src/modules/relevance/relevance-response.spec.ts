import {
  parseRelevanceResponse,
  relevanceBriefText,
  relevancePrompt,
  verdictFor,
} from './relevance-response';
import {
  AnalysisStatus,
  VideoAnalysis,
} from '../../common/types/analysis.types';
import { ProductInformation } from '../../common/types/product.types';

const product: ProductInformation = {
  productName: 'Кроссовки Pegasus 40',
  productDescription: 'Лёгкие беговые кроссовки с амортизацией',
  addedAt: new Date(),
  category: 'кроссовки',
  price: 4799,
  currency: 'UAH',
  countryCode: 'UA',
  languageCode: 'uk',
  audience: {
    ageRange: '25-34',
    gender: 'women',
    interests: ['бег', 'ЗОЖ'],
    summary: 'Бегуньи-любительницы',
    source: 'gemini',
  },
};
const analysis: VideoAnalysis = {
  analysisId: 'a1',
  analyzedAt: new Date(),
  status: AnalysisStatus.COMPLETE,
  sceneBreakdown: 'SCENE 1 …',
  scenes: [
    { id: 's1', start: 0, end: 3, title: 'Hook: unboxing', previewAt: 1 },
  ],
  audience: {
    ageRange: '18-24',
    gender: 'men',
    interests: ['гейминг'],
    summary: 'Подростки-геймеры',
    source: 'gemini',
  },
  promotedProduct: {
    category: 'gaming headset',
    description: 'x',
    priceTier: 'budget',
  },
};
const meta = {
  reportId: 'r1',
  now: new Date('2026-09-06T10:00:00Z'),
  inputs: { productAudience: true, videoAudience: true, promotedProduct: true },
};

describe('relevancePrompt', () => {
  it('lays both sides out and asks for strict JSON in the product language', () => {
    const p = relevancePrompt(product, analysis);
    expect(p).toContain(
      'Target audience of the product: age 25-34; gender: women; interests: бег, ЗОЖ; Бегуньи-любительницы',
    );
    expect(p).toContain(
      'Audience the reference speaks to: age 18-24; gender: men',
    );
    expect(p).toContain(
      'What the reference sells: category: gaming headset; x; price tier: budget',
    );
    expect(p).toContain('- 0-3s: Hook: unboxing');
    expect(p).toContain('Price: 4799 UAH');
    expect(p).toContain('"verdict": "use" | "adapt" | "skip"');
  });
  it('says "unknown" for missing sides instead of inventing them', () => {
    const p = relevancePrompt(
      { productName: 'x', productDescription: 'y', addedAt: new Date() },
      {
        ...analysis,
        audience: undefined,
        promotedProduct: undefined,
        scenes: undefined,
      },
    );
    expect(p).toContain('Target audience of the product: unknown');
    expect(p).toContain('Audience the reference speaks to: unknown');
    expect(p).toContain('What the reference sells: unknown');
    expect(p).not.toContain('Scenes:');
  });
});

describe('verdictFor', () => {
  it('trusts the model when consistent with the score, otherwise derives from the score', () => {
    expect(verdictFor(80, 'use')).toBe('use');
    expect(verdictFor(20, 'skip')).toBe('skip');
    expect(verdictFor(50, 'adapt')).toBe('adapt');
    expect(verdictFor(20, 'use')).toBe('skip'); // contradiction → score wins
    expect(verdictFor(85, 'skip')).toBe('use');
    expect(verdictFor(72, undefined)).toBe('use');
    expect(verdictFor(50, 'whatever')).toBe('adapt');
  });
});

describe('parseRelevanceResponse', () => {
  it('parses a full answer, clamps the score, caps lists', () => {
    const r = parseRelevanceResponse(
      '```json\n' +
        JSON.stringify({
          score: 137,
          verdict: 'use',
          summary: 'Подходит',
          reasoning: ['a', 'b'],
          matches: ['m'],
          gaps: [],
          adjustments: Array.from({ length: 12 }, (_, i) => `adj ${i}`),
          promptAdvice: 'Сделай ведущую 25-34…',
        }) +
        '\n```',
      meta,
    );
    expect(r).toMatchObject({
      reportId: 'r1',
      generatedAt: '2026-09-06T10:00:00.000Z',
      score: 100,
      verdict: 'use',
      summary: 'Подходит',
      reasoning: ['a', 'b'],
      matches: ['m'],
      gaps: [],
      promptAdvice: 'Сделай ведущую 25-34…',
      inputs: meta.inputs,
    });
    expect(r.adjustments).toHaveLength(8);
  });
  it('defaults: missing score → 50/adapt, missing lists → [], non-JSON → throws', () => {
    const r = parseRelevanceResponse('{"summary":"s"}', meta);
    expect(r.score).toBe(50);
    expect(r.verdict).toBe('adapt');
    expect(r.gaps).toEqual([]);
    expect(() => parseRelevanceResponse('nope', meta)).toThrow(/non-JSON/);
  });
});

describe('relevanceBriefText', () => {
  const report = parseRelevanceResponse(
    JSON.stringify({
      score: 40,
      verdict: 'adapt',
      summary: 's',
      adjustments: ['older presenter'],
      promptAdvice: 'Make it 35+',
    }),
    meta,
  );
  it('renders advice + adjustments when enabled', () => {
    const t = relevanceBriefText({ report, useInPrompt: true });
    expect(t).toContain('AUDIENCE FIT');
    expect(t).toContain('fit score 40/100');
    expect(t).toContain('Make it 35+');
    expect(t).toContain('- older presenter');
  });
  it('empty when disabled, absent, or without advice', () => {
    expect(relevanceBriefText({ report, useInPrompt: false })).toBe('');
    expect(relevanceBriefText(undefined)).toBe('');
    expect(relevanceBriefText({ report: null, useInPrompt: true })).toBe('');
    expect(
      relevanceBriefText({
        report: { ...report, promptAdvice: '', adjustments: [] },
        useInPrompt: true,
      }),
    ).toBe('');
  });
});
