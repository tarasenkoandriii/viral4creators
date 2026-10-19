import {
  BadRequestException,
  ConflictException,
  ValidationPipe,
} from '@nestjs/common';
import {
  STORY_REFERENCE_RETENTION_DAYS,
  STORY_REFERENCE_STALE_DAYS,
  StoryReferencesService,
  storyReferenceExpiresAt,
} from './story-references.service';
import {
  StoryReferenceListQuery,
  StoryReferencePlanQuery,
  StoryReferenceSearchQuery,
} from './story-reference.dto';
import {
  STORY_RETENTION_READY_DAYS,
  STORY_RETENTION_STALE_DAYS,
} from './story-retention.service';
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
  summary: 'Сказка про ёжика',
  scenes: [
    { start: 0, end: 20, observation: 'Акварельный лес', confidence: 'high' },
    {
      start: 20,
      end: 55,
      observation: 'Рассказчик в кадре',
      confidence: 'medium',
    },
  ],
  pacing: 'Спокойно',
  narration: 'Чтение',
  visuals: 'Картинки',
  music: 'Тихо',
  ownProductionPlan: 'Собственные рисунки',
  limitations: 'Выводы модели',
};
type Row = { key: string; value: string; updatedBy?: string };

function setup(metadataTitle = 'Репка') {
  const rows = new Map<string, Row>();
  const startsWith = (where: { key?: { startsWith?: string } }) =>
    [...rows.values()].filter((r) =>
      r.key.startsWith(where.key?.startsWith ?? ''),
    );
  const prisma = {
    platformSetting: {
      updateMany: jest.fn(async ({ where, data }) => {
        const old = rows.get(where.key);
        if (!old || old.value !== where.value) return { count: 0 };
        rows.set(where.key, { ...old, ...data });
        return { count: 1 };
      }),
      deleteMany: jest.fn(async ({ where }) => {
        const old = rows.get(where.key);
        if (!old || (where.value !== undefined && old.value !== where.value))
          return { count: 0 };
        rows.delete(where.key);
        return { count: 1 };
      }),
      findUnique: jest.fn(async ({ where: { key } }) => rows.get(key) ?? null),
      findUniqueOrThrow: jest.fn(async ({ where: { key } }) => rows.get(key)!),
      findMany: jest.fn(async ({ where }) => startsWith(where)),
      create: jest.fn(async ({ data }) => {
        if (rows.has(data.key)) throw { code: 'P2002' };
        rows.set(data.key, data);
        return data;
      }),
      update: jest.fn(),
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
            title: metadataTitle,
            channelTitle: 'Канал сказок',
            liveBroadcastContent: 'none',
          },
          contentDetails: { duration: 'PT1M' },
          status: { privacyStatus: 'public' },
        },
      ],
    }),
  } as Response);
  const youtube = {
    configured: jest.fn().mockReturnValue(true),
    search: jest.fn(),
  };
  const service = new StoryReferencesService(
    prisma as never,
    { assertCanSpendUser: jest.fn().mockResolvedValue(undefined) } as never,
    { recordGemini: jest.fn().mockResolvedValue(undefined) } as never,
    youtube as never,
  );
  const refKey = () =>
    [...rows.keys()].find((k) => k.startsWith('story-ref:v1:'))!;
  return { service, rows, prisma, generateContent, youtube, refKey };
}
const URL_A = 'https://youtu.be/Q1hbf5TrWCM';

describe('Story reference library (WP2)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('searches by title, channel and scene observations and filters by status', async () => {
    const { service, generateContent } = setup();
    await service.analyze('owner', URL_A);
    generateContent.mockRejectedValueOnce(new Error('503'));
    await service.analyze('owner', 'https://youtu.be/tOMZ_kKE2Y0');
    expect(await service.list('owner')).toHaveLength(2);
    expect(
      (await service.list('owner', { query: 'АКВАРЕЛЬНЫЙ' })).map((r) => r.id),
    ).toEqual(['Q1hbf5TrWCM']);
    expect(await service.list('owner', { query: 'ежика' })).toHaveLength(1);
    expect(await service.list('owner', { query: 'канал сказок' })).toHaveLength(
      2,
    );
    expect(
      (await service.list('owner', { status: 'unknown' })).map((r) => r.id),
    ).toEqual(['tOMZ_kKE2Y0']);
    expect(await service.list('owner', { query: 'нет такого' })).toEqual([]);
    const [one] = await service.list('owner', { status: 'complete' });
    expect(one).toMatchObject({
      editionId: null,
      attempts: 1,
      retryAllowed: false,
    });
    expect(one.expiresAt).toMatch(/^\d{4}-/);
  });

  it('deletes a record with its pending model JSON, never a running claim', async () => {
    const { service, rows, refKey } = setup();
    await service.analyze('owner', URL_A);
    const key = refKey();
    const saved = JSON.parse(rows.get(key)!.value);
    rows.set(key, {
      key,
      value: JSON.stringify({
        ...saved,
        status: 'running',
        startedAt: new Date().toISOString(),
      }),
    });
    await expect(service.remove('owner', 'Q1hbf5TrWCM')).rejects.toThrow(
      'выполняется',
    );
    rows.set(key, {
      key,
      value: JSON.stringify({
        ...saved,
        status: 'unknown',
        pendingAssessment: '{"broken"',
      }),
    });
    await expect(service.remove('someone', 'Q1hbf5TrWCM')).rejects.toThrow(
      'не найден',
    );
    await expect(service.remove('owner', 'bad id')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(await service.remove('owner', 'Q1hbf5TrWCM')).toEqual({
      deleted: true,
      id: 'Q1hbf5TrWCM',
    });
    expect([...rows.keys()].some((k) => k.startsWith('story-ref:v1:'))).toBe(
      false,
    );
    // Quota slots are not refunded by deletion.
    expect((await service.quota('owner')).used).toBe(1);
  });

  it('retries only explicitly, re-validates pending JSON for free and counts quota', async () => {
    const { service, rows, generateContent, refKey } = setup();
    generateContent.mockRejectedValueOnce(new Error('503'));
    const first = await service.analyze('owner', URL_A);
    expect(first).toMatchObject({ status: 'unknown', retryAllowed: true });
    // Plain repeat: no provider call, no quota.
    await service.analyze('owner', URL_A);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(await service.quota('owner')).toMatchObject({
      used: 1,
      remaining: 2,
      limit: 3,
    });
    // A stored candidate answer is re-validated without Gemini even on retry.
    const key = refKey();
    rows.set(key, {
      key,
      value: JSON.stringify({
        ...JSON.parse(rows.get(key)!.value),
        pendingAssessment: JSON.stringify(assessment),
      }),
    });
    expect((await service.analyze('owner', URL_A, true)).status).toBe(
      'complete',
    );
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect((await service.quota('owner')).used).toBe(1);
    // Complete is never re-bought, even with retry.
    await service.analyze('owner', URL_A, true);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('spends a new daily slot per explicit retry and keeps the edition link', async () => {
    const { service, generateContent } = setup();
    generateContent.mockRejectedValue(new Error('503'));
    await service.analyze('owner', URL_A);
    await service.link('owner', 'Q1hbf5TrWCM', 'turnip-ushinsky-ru-1949-v1');
    const second = await service.analyze('owner', URL_A, true);
    expect(second).toMatchObject({
      status: 'unknown',
      attempts: 2,
      editionId: 'turnip-ushinsky-ru-1949-v1',
    });
    await service.analyze('owner', URL_A, true);
    expect(generateContent).toHaveBeenCalledTimes(3);
    await expect(service.analyze('owner', URL_A, true)).rejects.toThrow(
      'включая явные повторы',
    );
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(await service.quota('owner')).toMatchObject({ remaining: 0 });
  });

  it('returns the quota slot when a concurrent claim wins', async () => {
    const { service, rows, prisma, generateContent, refKey } = setup();
    generateContent.mockRejectedValueOnce(new Error('503'));
    await service.analyze('owner', URL_A);
    const key = refKey();
    const original = prisma.platformSetting.updateMany.getMockImplementation()!;
    prisma.platformSetting.updateMany.mockImplementationOnce(async (args) => {
      // Another instance claimed the record first.
      const row = rows.get(key)!;
      rows.set(key, { ...row, value: row.value.replace('unknown', 'running') });
      return original(args);
    });
    await service.analyze('owner', URL_A, true);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect((await service.quota('owner')).used).toBe(1);
  });

  it('never resurrects a record deleted while its analysis was running', async () => {
    const { service, rows, generateContent } = setup();
    generateContent.mockImplementationOnce(async () => {
      for (const k of [...rows.keys()])
        if (k.startsWith('story-ref:v1:')) rows.delete(k);
      return { text: JSON.stringify(assessment) };
    });
    expect((await service.analyze('owner', URL_A)).status).toBe('complete');
    expect(await service.list('owner')).toEqual([]);
  });

  it('links only existing, not retired editions', async () => {
    const { service } = setup();
    await service.analyze('owner', URL_A);
    await expect(
      service.link('owner', 'Q1hbf5TrWCM', 'invented-edition-v1'),
    ).rejects.toThrow('Редакция');
    await expect(
      service.link('owner', 'Z7FgMniveRI', 'turnip-ushinsky-ru-1949-v1'),
    ).rejects.toThrow('не найден');
    expect(
      (await service.link('owner', 'Q1hbf5TrWCM', 'mitten-uk-short-v1'))
        .editionId,
    ).toBe('mitten-uk-short-v1');
    expect(
      (await service.list('owner', { query: 'Рукавичка' })).map((r) => r.id),
    ).toEqual(['Q1hbf5TrWCM']);
    expect((await service.link('owner', 'Q1hbf5TrWCM', null)).editionId).toBe(
      null,
    );
  });

  it('refuses to relink while the analysis is running (B-S3-3), like remove()', async () => {
    const { service, rows, refKey } = setup();
    await service.analyze('owner', URL_A);
    const key = refKey();
    const saved = JSON.parse(rows.get(key)!.value);
    const running = JSON.stringify({
      ...saved,
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    rows.set(key, { key, value: running });
    await expect(
      service.link('owner', 'Q1hbf5TrWCM', 'mitten-uk-short-v1'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.link('owner', 'Q1hbf5TrWCM', null),
    ).rejects.toBeInstanceOf(ConflictException);
    // The analyzer's compare-and-set target is untouched.
    expect(rows.get(key)!.value).toBe(running);
  });

  it('builds a staging plan only from a confirmed analysis and an available edition', async () => {
    const { service, generateContent } = setup();
    generateContent.mockRejectedValueOnce(new Error('503'));
    await service.analyze('owner', URL_A);
    await expect(
      service.stagingPlan('owner', 'Q1hbf5TrWCM', {}),
    ).rejects.toThrow('подтверждённому');
    await service.analyze('owner', URL_A, true);
    await expect(
      service.stagingPlan('owner', 'Q1hbf5TrWCM', {}),
    ).rejects.toThrow('Выберите редакцию');
    await service.link('owner', 'Q1hbf5TrWCM', 'turnip-ushinsky-ru-1949-v1');
    const plan = await service.stagingPlan('owner', 'Q1hbf5TrWCM', {
      budgetUsd: 5,
    });
    expect(plan).toMatchObject({
      editionId: 'turnip-ushinsky-ru-1949-v1',
      baseRevision: 'turnip-v1',
      fits: true,
    });
    expect(plan.scenes).toHaveLength(3);
    const other = await service.stagingPlan('owner', 'Q1hbf5TrWCM', {
      editionId: 'three-pigs-en-short-v1',
      budgetUsd: 2,
    });
    expect(other.editionKind).toBe('adaptation');
    await expect(
      service.stagingPlan('owner', 'Q1hbf5TrWCM', { editionId: 'nope' }),
    ).rejects.toThrow('недоступна');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('finds new public candidates up to five minutes through the existing search', async () => {
    const { service, youtube } = setup();
    await service.analyze('owner', URL_A);
    const row = (videoId: string, durationSeconds: number | null) => ({
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: videoId,
      channelTitle: 'c',
      channelId: 'x',
      publishedAt: '',
      thumbnailUrl: null,
      durationSeconds,
      durationLabel: null,
      viewCount: null,
      likeCount: null,
    });
    youtube.search.mockResolvedValue({
      query: 'репка',
      usage: { used: 1, limit: 20, remaining: 19 },
      results: [
        row('Q1hbf5TrWCM', 60),
        row('tOMZ_kKE2Y0', 300),
        row('_vOhhPLk2ss', 301),
        row('Z7FgMniveRI', null),
        row('aaaaaaaaaaa', 0),
      ],
    });
    const found = await service.search('owner', 'репка', 'ru');
    expect(youtube.search).toHaveBeenCalledWith('owner', 'репка', {
      language: 'ru',
    });
    expect(found.results.map((r) => [r.videoId, r.saved])).toEqual([
      ['Q1hbf5TrWCM', true],
      ['tOMZ_kKE2Y0', false],
    ]);
    expect(found.hiddenLongOrUnknown).toBe(3);
    youtube.configured.mockReturnValue(false);
    await expect(service.search('owner', 'репка')).rejects.toThrow(
      'не настроен',
    );
  });

  it('uses the same retention terms as the WP1 cron', () => {
    expect(STORY_REFERENCE_RETENTION_DAYS).toBe(STORY_RETENTION_READY_DAYS);
    expect(STORY_REFERENCE_STALE_DAYS).toBe(STORY_RETENTION_STALE_DAYS);
    const at = new Date('2026-01-01T00:00:00.000Z');
    const base = { startedAt: '2025-01-01T00:00:00.000Z' };
    expect(storyReferenceExpiresAt({ ...base, status: 'complete' }, at)).toBe(
      '2026-06-30T00:00:00.000Z',
    );
    expect(storyReferenceExpiresAt({ ...base, status: 'unknown' }, at)).toBe(
      '2026-01-31T00:00:00.000Z',
    );
    expect(storyReferenceExpiresAt({ ...base, status: 'partial' })).toBe(
      '2025-06-30T00:00:00.000Z',
    );
  });

  it('validates query parameters', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const run = (metatype: new () => object, value: unknown) =>
      pipe.transform(value, { type: 'query', metatype, data: '' });
    await expect(
      run(StoryReferenceListQuery, { query: 'лес', status: 'unknown' }),
    ).resolves.toBeDefined();
    await expect(
      run(StoryReferenceListQuery, { status: 'deleted' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(StoryReferencePlanQuery, { budgetUsd: '2.5' }),
    ).resolves.toMatchObject({ budgetUsd: 2.5 });
    await expect(
      run(StoryReferencePlanQuery, { budgetUsd: '0' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(StoryReferenceSearchQuery, { q: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(StoryReferenceSearchQuery, { q: 'репка', maxResults: '5' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
