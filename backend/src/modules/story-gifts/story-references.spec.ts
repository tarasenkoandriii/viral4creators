import {
  StoryReferencesService,
  parseStoryReference,
} from './story-references.service';
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
    };
  }
  it('rejects impossible, overlapping and unobserved scenes', () => {
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
    expect(() =>
      parseStoryReference(
        JSON.stringify({
          ...assessment,
          scenes: [
            assessment.scenes[0],
            { ...assessment.scenes[0], start: 10, end: 30 },
          ],
        }),
        60,
      ),
    ).toThrow();
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
  });
  it('isolates saved references by owner', async () => {
    const { service } = setup();
    await service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM');
    expect(await service.list('someone-else')).toEqual([]);
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
  it('caps new paid calls at two a day', async () => {
    const { service, generateContent } = setup();
    await service.analyze('owner', 'https://youtu.be/Q1hbf5TrWCM');
    await service.analyze('owner', 'https://youtu.be/tOMZ_kKE2Y0');
    await expect(
      service.analyze('owner', 'https://youtu.be/_vOhhPLk2ss'),
    ).rejects.toThrow('два новых');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });
});
