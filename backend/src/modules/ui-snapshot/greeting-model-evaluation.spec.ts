jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
const generateContent = jest.fn();
jest.mock('../../common/gemini-client', () => ({
  createGeminiClient: () => ({ models: { generateContent } }),
}));
import { GreetingModelEvaluationService } from './greeting-model-evaluation.service';
import {
  GREETING_EVAL_PROMPT,
  parseGreetingAssessment,
} from './greeting-model-evaluation';

function assessment() {
  return {
    durationSeconds: 2,
    summary: 'Наблюдение',
    scores: {
      naturalness: { score: 3, reason: 'Виден взгляд' },
      gestures: { score: null, reason: 'Руки не видны' },
      lipSync: { score: null, reason: 'Рот не виден' },
    },
    evidence: [
      {
        start: 0,
        end: 1,
        criterion: 'naturalness',
        severity: 'minor',
        confidence: 'medium',
        observation: 'Взгляд замирает',
        recommendation: 'Проверить вручную',
      },
    ],
    limitations: ['Без измерения фонем'],
  };
}
function build() {
  const store = new Map<string, { key: string; value: string }>();
  const prisma = {
    session: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 's1',
          createdAt: new Date(),
          data: {
            generatedVideo: {
              status: 'complete',
              downloadUrl:
                'https://own.public.blob.vercel-storage.com/video.mp4',
            },
          },
          liveData: {},
          project: { title: 'Test' },
        },
      ]),
    },
    platformSetting: {
      findMany: jest.fn(async () => [...store.values()]),
      findUnique: jest.fn(
        async ({ where }: { where: { key: string } }) =>
          store.get(where.key) ?? null,
      ),
      findUniqueOrThrow: jest.fn(
        async ({ where }: { where: { key: string } }) => store.get(where.key),
      ),
      create: jest.fn(
        async ({ data }: { data: { key: string; value: string } }) => {
          if (store.has(data.key))
            throw Object.assign(new Error(), { code: 'P2002' });
          store.set(data.key, data);
          return data;
        },
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { key: string };
          data: { value: string };
        }) => {
          const row = { key: where.key, value: data.value };
          store.set(where.key, row);
          return row;
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { key: string; value: string };
          data: { value: string };
        }) => {
          if (store.get(where.key)?.value !== where.value) return { count: 0 };
          store.set(where.key, { key: where.key, value: data.value });
          return { count: 1 };
        },
      ),
    },
  };
  const files = {
    uploadAndWaitActive: jest
      .fn()
      .mockResolvedValue({ name: 'files/one', uri: 'https://gemini.test/one' }),
    deleteFile: jest.fn().mockResolvedValue(undefined),
  };
  const usage = { recordGemini: jest.fn().mockResolvedValue(undefined) };
  const plans = { assertCanSpendUser: jest.fn().mockResolvedValue(undefined) };
  const svc = new GreetingModelEvaluationService(
    prisma as never,
    files as never,
    usage as never,
    plans as never,
  );
  return { svc, store, prisma, files, usage, plans };
}
beforeEach(() => {
  jest
    .spyOn(global, 'fetch')
    .mockImplementation(async () => new Response(Buffer.from('same video')));
  generateContent.mockReset().mockResolvedValue({
    text: JSON.stringify(assessment()),
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
  });
});
afterEach(() => jest.restoreAllMocks());
it('requires timestamp evidence for every numeric score', () => {
  const v = assessment();
  v.evidence = [];
  expect(() => parseGreetingAssessment(JSON.stringify(v))).toThrow();
});
it('rejects timestamps outside the reported duration', () => {
  const v = assessment();
  v.evidence[0].end = 8;
  expect(() => parseGreetingAssessment(JSON.stringify(v))).toThrow();
});
it('preserves inability to assess lip sync instead of inventing a score', () => {
  expect(
    parseGreetingAssessment(JSON.stringify(assessment())).scores.lipSync.score,
  ).toBeNull();
});
it('rejects a score outside the common scale', () => {
  const v = assessment();
  v.scores.naturalness.score = 9;
  expect(() => parseGreetingAssessment(JSON.stringify(v))).toThrow();
});
it('ignores arbitrary extra fields in model output', () => {
  expect(
    parseGreetingAssessment(
      JSON.stringify({ ...assessment(), html: 'malicious' }),
    ),
  ).not.toHaveProperty('html');
});
it('uses actual requested model, identical rubric, 8 fps, bills and cleans up', async () => {
  const { svc, usage, files } = build();
  const result = await svc.run('s1', 'gemini-4-argon', false, 'operator');
  expect(result.status).toBe('complete');
  expect(generateContent).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'gemini-4-argon',
      contents: [
        expect.objectContaining({ videoMetadata: { fps: 8 } }),
        { text: GREETING_EVAL_PROMPT },
      ],
    }),
  );
  expect(usage.recordGemini).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ model: 'gemini-4-argon', userId: 'operator' }),
  );
  expect(files.deleteFile).toHaveBeenCalledWith('files/one');
});
it('deduplicates concurrent and repeated paid launches across instances', async () => {
  const { svc } = build();
  await Promise.all([
    svc.run('s1', 'gemini-3.6-flash', false, 'operator'),
    svc.run('s1', 'gemini-3.6-flash', false, 'operator'),
  ]);
  await svc.run('s1', 'gemini-3.6-flash', false, 'operator');
  expect(generateContent).toHaveBeenCalledTimes(1);
});
it('persists failure without fallback or implicit retry, permits explicit retry', async () => {
  const { svc, files } = build();
  generateContent.mockRejectedValueOnce(
    Object.assign(new Error('private message'), { status: 503 }),
  );
  expect(
    (await svc.run('s1', 'gemini-4-argon', false, 'operator')).error,
  ).toContain('503');
  await svc.run('s1', 'gemini-4-argon', false, 'operator');
  expect(generateContent).toHaveBeenCalledTimes(1);
  expect((await svc.run('s1', 'gemini-4-argon', true, 'operator')).status).toBe(
    'complete',
  );
  expect(generateContent).toHaveBeenCalledTimes(2);
  expect(files.deleteFile).toHaveBeenCalledTimes(2);
});
it('rejects unknown models before querying videos or spending', async () => {
  const { svc, prisma, plans } = build();
  await expect(
    svc.run('s1', 'other-model', false, 'operator'),
  ).rejects.toThrow();
  expect(prisma.session.findMany).not.toHaveBeenCalled();
  expect(plans.assertCanSpendUser).not.toHaveBeenCalled();
});
it('charges and records usage before rejecting an unsupported model response', async () => {
  const { svc, usage } = build();
  generateContent.mockResolvedValue({ text: 'not json', usageMetadata: {} });
  expect(
    (await svc.run('s1', 'gemini-3.6-flash', false, 'operator')).status,
  ).toBe('failed');
  expect(usage.recordGemini).toHaveBeenCalledTimes(1);
});
