import {
  StoryReferencesService,
  parseStoryReference,
  storyReferenceAnalysisPrice,
  STORY_REFERENCE_OUTPUT_TOKENS,
} from './story-references.service';
import { estimateCost } from '../../common/ai-pricing';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { createGeminiClient } from '../../common/gemini-client';
import { loadConfiguration } from '../../config/configuration';
jest.mock('../../common/gemini-client', () => ({
  createGeminiClient: jest.fn(),
}));
jest.mock('../../config/configuration', () => ({
  loadConfiguration: jest.fn(),
}));
const assessment = {
  observed: true,
  audioObserved: true,
  summary: 'Сказка',
  scenes: [
    { start: 0, end: 20, observation: 'Иллюстрация', confidence: 'high' },
  ],
  pacing: 'Спокойно',
  narration: 'Чтение',
  visuals: 'Картинки',
  music: 'Тихо',
  ownProductionPlan: 'Собственные рисунки',
  limitations: 'Выводы модели',
};
describe('Story YouTube reference boundaries', () => {
  afterEach(() => jest.restoreAllMocks());
  function setup() {
    const rows = new Map<string, { key: string; value: string }>();
    const prisma = {
      platformSetting: {
        updateMany: jest.fn(async ({ where, data }) => {
          const old = rows.get(where.key);
          if (!old || old.value !== where.value) return { count: 0 };
          rows.set(where.key, { ...old, ...data });
          return { count: 1 };
        }),
        findUnique: jest.fn(
          async ({ where: { key } }) => rows.get(key) ?? null,
        ),
        findUniqueOrThrow: jest.fn(
          async ({ where: { key } }) => rows.get(key)!,
        ),
        findMany: jest.fn(
          async ({
            where: {
              key: { startsWith },
            },
          }) => [...rows.values()].filter((r) => r.key.startsWith(startsWith)),
        ),
        create: jest.fn(async ({ data }) => {
          if (rows.has(data.key)) throw { code: 'P2002' };
          rows.set(data.key, data);
          return data;
        }),
        deleteMany: jest.fn(async ({ where }) => {
          const old = rows.get(where.key);
          if (!old || old.value !== where.value) return { count: 0 };
          rows.delete(where.key);
          return { count: 1 };
        }),
        update: jest.fn(async ({ where: { key }, data }) => {
          const r = { ...rows.get(key)!, ...data };
          rows.set(key, r);
          return r;
        }),
      },
    };
    const generateContent = jest
      .fn()
      .mockResolvedValue({ text: JSON.stringify(assessment) });
    (createGeminiClient as jest.Mock).mockReturnValue({
      models: { generateContent },
    });
    (loadConfiguration as jest.Mock).mockReturnValue({
      youtube: { apiKey: 'server-only' },
    });
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            snippet: {
              title: 'Репка',
              channelTitle: 'Канал',
              liveBroadcastContent: 'none',
            },
            contentDetails: { duration: 'PT1M' },
            status: { privacyStatus: 'public' },
          },
        ],
      }),
    } as Response);
    return {
      service: new StoryReferencesService(
        prisma as never,
        { assertCanSpendUser: jest.fn().mockResolvedValue(undefined) } as never,
        { recordGemini: jest.fn().mockResolvedValue(undefined) } as never,
      ),
      generateContent,
      rows,
    };
  }
  it('rejects impossible scenes and flags overlapping observations', () => {
    expect(
      parseStoryReference(JSON.stringify(assessment), 60).scenes,
    ).toHaveLength(1);
    expect(() =>
      parseStoryReference(
        JSON.stringify({
          ...assessment,
          scenes: [{ ...assessment.scenes[0], end: 70 }],
        }),
        60,
      ),
    ).toThrow();
    expect(
      parseStoryReference(
        JSON.stringify({
          ...assessment,
          scenes: [
            assessment.scenes[0],
            { ...assessment.scenes[0], start: 10, end: 30 },
          ],
        }),
        60,
      ).limitations,
    ).toContain('пересекаются');
    expect(() =>
      parseStoryReference(
        JSON.stringify({ ...assessment, observed: false }),
        60,
      ),
    ).toThrow();
  });
  it('rejects arbitrary destinations before any external call', async () => {
    const { service, generateContent } = setup();
    await expect(
      service.analyze('owner', 'https://example.org/private'),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent and repeated paid requests', async () => {
    const { service, generateContent } = setup();
    await Promise.all([
      service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM'),
      service.analyze('owner', 'https://www.youtube.com/watch?v=Q1hbf5TrWCM'),
    ]);
    expect(
      (await service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM')).status,
    ).toBe('complete');
    expect(generateContent).toHaveBeenCalledTimes(1);
    // The losing concurrent request returns its daily slot (no paid call).
    expect((await service.quota('owner')).used).toBe(1);
  });
  it('U-07: quota carries the server price of a 300 s analysis, no provider call', async () => {
    const { service, generateContent, rows } = setup();
    const q = await service.quota('owner');
    expect(q.analysis).toEqual({
      estimateMicroUsd: expect.any(Number),
      reserveMicroUsd: q.analysis.estimateMicroUsd,
      maxSeconds: 300,
      model: GEMINI_MODEL,
    });
    expect(q.analysis.estimateMicroUsd).toBeGreaterThan(0);
    // 300 s × (258 video + 32 audio tokens/s) + prompt, output at its ceiling.
    const floor = estimateCost(GEMINI_MODEL, {
      inputTokens: 300 * 290,
      inputByModality: { VIDEO: 300 * 258, AUDIO: 300 * 32 },
      outputTokens: STORY_REFERENCE_OUTPUT_TOKENS,
    }).costMicroUsd;
    expect(q.analysis.estimateMicroUsd).toBeGreaterThanOrEqual(floor);
    expect(q.analysis.estimateMicroUsd! - floor).toBeLessThan(2000);
    expect(generateContent).not.toHaveBeenCalled();
    // The analysis model setting is honoured; unpriced → no amount.
    rows.set('analysis.geminiModel', {
      key: 'analysis.geminiModel',
      value: 'gemini-3.6-flash',
    });
    expect((await service.quota('owner')).analysis.model).toBe(
      'gemini-3.6-flash',
    );
    expect(storyReferenceAnalysisPrice('no-such-model')).toEqual({
      estimateMicroUsd: null,
      reserveMicroUsd: null,
      maxSeconds: 300,
      model: 'no-such-model',
    });
  });
  it('isolates saved references by owner', async () => {
    const { service, rows, generateContent } = setup();
    await service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM');
    expect(await service.list('someone-else')).toEqual([]);
    const entry = [...rows.values()].find((row) =>
      row.key.startsWith('story-ref:v1:'),
    )!;
    const saved = JSON.parse(entry.value);
    saved.status = 'unknown';
    saved.pendingAssessment = JSON.stringify(assessment);
    delete saved.assessment;
    rows.set(entry.key, { ...entry, value: JSON.stringify(saved) });
    expect(JSON.stringify(await service.list('owner'))).not.toContain(
      'pendingAssessment',
    );
    expect(
      (await service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM')).status,
    ).toBe('complete');
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
  it('rejects long videos before model billing', async () => {
    const { service, generateContent } = setup();
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            contentDetails: { duration: 'PT30M' },
            status: { privacyStatus: 'public' },
          },
        ],
      }),
    });
    await expect(
      service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM'),
    ).rejects.toThrow();
    expect(generateContent).not.toHaveBeenCalled();
  });
  it('does not retry a failed provider call', async () => {
    const { service, generateContent } = setup();
    generateContent.mockRejectedValue(new Error('503'));
    expect(
      (await service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM')).status,
    ).toBe('unknown');
    await service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM');
    expect(generateContent).toHaveBeenCalledTimes(1);
    await service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM', true);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });
  it('does not claim inaccessible video was reviewed', async () => {
    const { service, generateContent } = setup();
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        ...assessment,
        observed: false,
        audioObserved: false,
        scenes: [],
      }),
    });
    expect(
      (await service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM')).status,
    ).toBe('unavailable');
  });
  it('allows an explicit retry of an existing reference at the storage cap', async () => {
    const { service, rows, generateContent } = setup();
    generateContent.mockRejectedValueOnce(new Error('503'));
    await service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM');
    const entry = [...rows.values()].find((r) =>
      r.key.startsWith('story-ref:v1:'),
    )!;
    const prefix = entry.key.slice(0, -11);
    for (let i = 0; i < 19; i++)
      rows.set(`${prefix}stored-${i}`, {
        ...entry,
        key: `${prefix}stored-${i}`,
      });
    expect(await service.list('owner')).toHaveLength(20);
    await expect(
      service.analyze('owner', 'https://youtu.be/Z7FgMniveRI'),
    ).rejects.toThrow('20 сохранённых');
    expect(
      (await service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM', true))
        .status,
    ).toBe('complete');
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(await service.list('owner')).toHaveLength(20);
  });
  it('caps new paid calls at three a day', async () => {
    const { service, generateContent } = setup();
    await service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM');
    await service.analyze('owner', 'https://youtu.be/tOMZ_kKE2Y0');
    await service.analyze('owner', 'https://youtu.be/_vOhhPLk2ss');
    await expect(
      service.analyze('owner', 'https://youtu.be/Z7FgMniveRI'),
    ).rejects.toThrow('три новых');
    expect(generateContent).toHaveBeenCalledTimes(3);
  });
});
