/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
const generateContent = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

import { BadRequestException } from '@nestjs/common';

// Этап 53 (В-6.15): клиент Gemini создаётся с явным ключом, и без него
// конструктор честно бросает — как уже делал AnalysisService. Ключ ставим
// и убираем за собой: process.env общий на весь воркер jest.
const keyBefore = process.env.GEMINI_API_KEY;
beforeAll(() => {
  process.env.GEMINI_API_KEY = 'test-key';
});
afterAll(() => {
  if (keyBefore === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = keyBefore;
});
import { RelevanceService } from './relevance.service';
import { AnalysisStatus } from '../../common/types/analysis.types';

/** Учёт расходов (ТЗ §26) — в тестах он ничего не должен делать. */
const usageMock = () => ({
  record: jest.fn(),
  recordGemini: jest.fn(),
  recordOpenAi: jest.fn(),
});

const plansMock = () => ({
  // §26.4: дневной лимит по умолчанию не выбран.
  assertCanSpendUser: jest.fn(),
  assertCanSpendSession: jest.fn(),
  assertUserNotBlocked: jest.fn(),
  assertSessionNotBlocked: jest.fn(),
  assertNotBlocked: jest.fn(),
  accessOf: jest.fn().mockResolvedValue({
    plan: 'PREMIUM',
    isBlocked: false,
    blockedReason: null,
  }),
  assertUser: jest.fn().mockResolvedValue(undefined),
  assertSession: jest.fn().mockResolvedValue(undefined),
  planOfUser: jest.fn().mockResolvedValue('PREMIUM'),
  planOfSession: jest.fn().mockResolvedValue('PREMIUM'),
});

const base = {
  sessionId: 's1',
  videoAnalysis: {
    analysisId: 'a1',
    analyzedAt: new Date(),
    status: AnalysisStatus.COMPLETE,
    sceneBreakdown: 'x',
    audience: {
      ageRange: '18-24',
      gender: 'men',
      interests: [],
      summary: null,
      source: 'gemini',
    },
  },
  productInformation: {
    productName: 'Кружка',
    productDescription: 'стальная',
    addedAt: new Date(),
  },
};

function build(session: Record<string, unknown> | null = base) {
  const sessions = {
    getSession: jest.fn().mockResolvedValue(session),
    updateSession: jest.fn().mockResolvedValue(undefined),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plans = plansMock();
  return {
    svc: new RelevanceService(
      sessions as any,
      plans as any,
      usageMock() as any,
    ),
    sessions,
    plans,
  };
}

describe('RelevanceService', () => {
  beforeEach(() => generateContent.mockReset());

  it('get: empty state before the first run', async () => {
    const { svc } = build();
    expect(await svc.get('s1')).toEqual({
      report: null,
      useInPrompt: true,
      updatedAt: '',
    });
  });

  it('run: text-only Gemini JSON call, stores the report with input flags', async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        score: 30,
        verdict: 'skip',
        summary: 'Не то',
        gaps: ['возраст'],
      }),
    });
    const { svc, sessions } = build();
    const state = await svc.run('s1');
    expect(generateContent).toHaveBeenCalledTimes(1);
    const args = generateContent.mock.calls[0][0];
    expect(args.config).toEqual({ responseMimeType: 'application/json' });
    expect(args.contents[0].text).toContain('Кружка');
    expect(state.report).toMatchObject({
      score: 30,
      verdict: 'skip',
      inputs: {
        productAudience: false,
        videoAudience: true,
        promotedProduct: false,
      },
    });
    expect(state.useInPrompt).toBe(true);
    expect(sessions.updateSession).toHaveBeenCalledWith('s1', {
      relevance: state,
    });
  });

  it('run: 400 without a complete analysis or without a product', async () => {
    await expect(
      build({
        ...base,
        videoAnalysis: {
          ...base.videoAnalysis,
          status: AnalysisStatus.PROCESSING,
        },
      }).svc.run('s1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      build({ ...base, productInformation: undefined }).svc.run('s1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('update: toggles useInPrompt, keeps the report', async () => {
    const report = { reportId: 'r', score: 50 };
    const { svc, sessions } = build({
      ...base,
      relevance: { report, useInPrompt: true, updatedAt: 't' },
    });
    const state = await svc.update('s1', false);
    expect(state.report).toBe(report);
    expect(state.useInPrompt).toBe(false);
    expect(sessions.updateSession).toHaveBeenCalled();
  });
});
