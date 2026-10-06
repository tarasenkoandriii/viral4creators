/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые дублёры */
/**
 * Версии роликов обучалки с другим темпом (06.10.2026).
 *
 * Дорогие инварианты здесь три: (1) версия не видна потребителям ролика,
 * пока её не активировали — до этого строка ролика не меняется ни на
 * байт; (2) одна платная задача на «Сохранить» — двойной клик и повтор
 * не платят второй раз, вторая версия во время сборки не запускается;
 * (3) провал сборки или проверки не трогает действующий ролик.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
}));
const checkMock = jest.fn();
jest.mock('../tutorial-runner/mp4-probe', () => ({
  probeMp4: () => ({ durationSeconds: 1, tracks: [] }),
  checkTutorialVideo: (...args: unknown[]) => checkMock(...args),
}));

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  MAX_VERSION_ATTEMPTS,
  TutorialVideoVersionsService,
} from './tutorial-video-versions.service';
import {
  buildTutorialManifest,
  ManifestFrame,
  TutorialTimelineManifest,
} from '../tutorial-runner/tutorial-manifest';
import { narrationFrameSeconds } from '../tutorial-runner/tutorial-video-assembly';

function frame(i: number, speech: number | null): ManifestFrame {
  return {
    frameId: `step-${i}`,
    stepIndex: i,
    image: {
      url: `https://blob/tutorial-video-frames/draft1/${i}.png`,
      pathname: `tutorial-video-frames/draft1/${i}.png`,
    },
    baseSeconds: speech === null ? 2 : narrationFrameSeconds(speech),
    speech:
      speech === null
        ? null
        : {
            url: `https://blob/tutorial-video-sources/a1/voice/${i}.mp3`,
            pathname: `tutorial-video-sources/a1/voice/${i}.mp3`,
            seconds: speech,
            text: `Реплика ${i}.`,
            provenance: {
              provider: 'resemble',
              voiceId: null,
              locale: 'ru',
              textSha: `sha${i}`,
            },
          },
    caption: speech === null ? null : `Реплика ${i}.`,
    readingSeconds: null,
    pointer: null,
  };
}

function manifest(
  over: Partial<TutorialTimelineManifest> = {},
): TutorialTimelineManifest {
  return {
    ...buildTutorialManifest({
      sourceAssetId: 'a1',
      owner: { kind: 'client-site', draftId: 'draft1', userId: 'u1' },
      assetContentHash: 'hash1',
      locale: 'ru',
      theme: null,
      motion: 'fade',
      captions: true,
      narration: 'per-frame',
      storage: 'draft-frames',
      frames: [frame(0, 3.2), frame(1, null), frame(2, 1.4)],
    }),
    ...over,
  };
}

interface World {
  assets: any[];
  versions: any[];
  drafts: any[];
  locks: Map<string, Date | null>;
}

function matches(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'assetId_idempotencyKey') {
      return (
        row.assetId === v.assetId && row.idempotencyKey === v.idempotencyKey
      );
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('not' in v) return row[k] !== v.not;
      if ('lt' in v) return row[k] < v.lt;
    }
    return row[k] === v;
  });
}

function setup(opts: { world?: Partial<World>; asset?: any } = {}) {
  const world: World = {
    assets: opts.world?.assets ?? [
      {
        id: 'a1',
        subjectKey: 'client-site',
        locale: 'ru',
        title: 'Как войти',
        clientSiteDraftId: 'draft1',
        scenarioId: null,
        assemblyStatus: 'complete',
        blobUrl: 'https://blob/tutorial-videos/client-site/a1.mp4',
        durationMs: 12_000,
        contentHash: 'hash1',
        tempoManifest: manifest(),
        activeVersionId: null,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        ...(opts.asset ?? {}),
      },
    ],
    versions: opts.world?.versions ?? [],
    drafts: opts.world?.drafts ?? [
      {
        id: 'draft1',
        title: 'Как войти',
        baseUrl: 'https://shop.example',
        framesPurgedAt: null,
        projectId: 'p1',
        project: { userId: 'u1', deletedAt: null },
      },
    ],
    locks: new Map(),
  };
  let seq = 0;
  const prisma: any = {
    tutorialVideoAsset: {
      findUnique: jest.fn(
        async ({ where }: any) =>
          world.assets.find((a) => a.id === where.id) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        world.assets.filter((a) => matches(a, where)),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = world.assets.filter((a) => matches(a, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = world.assets.find((a) => a.id === where.id);
        Object.assign(r, data);
        return r;
      }),
    },
    tutorialVideoVersion: {
      findUnique: jest.fn(
        async ({ where }: any) =>
          world.versions.find((v) => matches(v, where)) ?? null,
      ),
      findFirst: jest.fn(
        async ({ where }: any) =>
          world.versions.find((v) => matches(v, where)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        world.versions.filter((v) => matches(v, where)),
      ),
      create: jest.fn(async ({ data }: any) => {
        if (
          world.versions.some(
            (v) =>
              v.assetId === data.assetId &&
              v.idempotencyKey === data.idempotencyKey,
          )
        ) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = {
          id: `v${++seq}`,
          createdAt: new Date(2026, 9, 6, 12, 0, seq),
          updatedAt: new Date(),
          error: null,
          jobId: null,
          startedAt: null,
          attempts: 0,
          blobUrl: null,
          videoMs: null,
          approvedBy: null,
          approvedAt: null,
          activatedAt: null,
          ...data,
        };
        world.versions.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = world.versions.filter((v) => matches(v, where));
        rows.forEach((r) => {
          for (const [k, v] of Object.entries<any>(data)) {
            r[k] =
              v && typeof v === 'object' && 'increment' in v
                ? r[k] + v.increment
                : v;
          }
        });
        return { count: rows.length };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = world.versions.find((v) => v.id === where.id);
        Object.assign(r, data);
        return r;
      }),
    },
    clientSiteTutorialDraft: {
      findMany: jest.fn(async ({ where }: any) =>
        world.drafts.filter(
          (d) =>
            d.project?.userId === where.project.userId && !d.project?.deletedAt,
        ),
      ),
      findUnique: jest.fn(
        async ({ where }: any) =>
          world.drafts.find((d) => d.id === where.id) ?? null,
      ),
    },
    cronJobLock: {
      create: jest.fn(async ({ data }: any) => {
        if (world.locks.has(data.jobKey)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        world.locks.set(data.jobKey, data.lockedUntil);
        return {};
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const until = world.locks.get(where.jobKey);
        if (where.OR) {
          if (until && until > new Date()) return { count: 0 };
        }
        world.locks.set(where.jobKey, data.lockedUntil ?? null);
        return { count: 1 };
      }),
    },
  };
  const blob: any = {
    uploadBuffer: jest.fn(async (p: string) => ({ url: `https://blob/${p}` })),
    deleteBlob: jest.fn(async () => true),
    deleteMany: jest.fn(async (ps: string[]) => ps.length),
    listByPrefix: jest.fn(async () => ({ blobs: [], cursor: null })),
    copyBlob: jest.fn(async (_f: string, to: string) => `https://blob/${to}`),
  };
  const ffmpeg: any = {
    configured: jest.fn(() => true),
    submit: jest.fn(async () => ({ jobId: `job-${seq}`, status: 'queued' })),
    status: jest.fn(),
  };
  const aiUsage: any = { record: jest.fn(async () => undefined) };
  const plan: any = { assertCanSpendUser: jest.fn(async () => undefined) };
  const provider: any = {
    providerKey: 'resemble',
    configured: jest.fn(() => true),
    synthesize: jest.fn(async ({ text }: any) => ({
      ok: true,
      audio: Buffer.from(text),
      mimeType: 'audio/mpeg',
      characters: text.length,
      durationSeconds: 2.5,
      voiceId: 'voice-r',
      model: 'm',
    })),
  };
  const tts: any = { resolveByKey: jest.fn(() => provider) };
  const siteMedia: any = { syncForDraft: jest.fn(async () => undefined) };
  const service = new TutorialVideoVersionsService(
    prisma,
    blob,
    ffmpeg,
    aiUsage,
    plan,
    tts,
    siteMedia,
  );
  return {
    service,
    world,
    prisma,
    blob,
    ffmpeg,
    aiUsage,
    plan,
    tts,
    provider,
    siteMedia,
  };
}

const USER = { kind: 'user' as const, userId: 'u1' };
const STRANGER = { kind: 'user' as const, userId: 'u2' };
const OPERATOR = { kind: 'operator' as const, userId: 'op1' };

beforeEach(() => {
  checkMock.mockReset();
  checkMock.mockReturnValue({ ok: true, problems: [] });
});

describe('расчёт и предпросмотр — бесплатно', () => {
  it('длительность, исходная длительность и кадры предпросмотра по manifest', async () => {
    const { service, ffmpeg, aiUsage } = setup();
    const est = await service.estimate(USER, 'a1', 0.4);
    expect(est.editable).toBe(true);
    expect(est.preset).toBe('fast');
    expect(est.durationMs!).toBeLessThan(est.sourceDurationMs!);
    expect(est.preview!.frames.map((f) => f.frameId)).toEqual([
      'step-0',
      'step-1',
      'step-2',
    ]);
    expect(est.preview!.frames[0].speech!.url).toContain('voice/0.mp3');
    expect(ffmpeg.submit).not.toHaveBeenCalled();
    expect(aiUsage.record).not.toHaveBeenCalled();
  });

  it('чужой ролик — 404, как несуществующий', async () => {
    const { service } = setup();
    await expect(service.estimate(STRANGER, 'a1', 1)).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.requestVersion(STRANGER, 'a1', 0.4)).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.listVersions(STRANGER, 'a1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('без manifest — недоступно с причиной, а не угадывание', async () => {
    const { service } = setup({ asset: { tempoManifest: null } });
    const est = await service.estimate(USER, 'a1', 0.4);
    expect(est).toMatchObject({
      editable: false,
      reason: 'no-manifest',
      preview: null,
    });
    await expect(service.requestVersion(USER, 'a1', 0.4)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('одна дорожка на весь ролик — темп недоступен', async () => {
    const { service } = setup({
      asset: { tempoManifest: manifest({ narration: 'whole' }) },
    });
    expect((await service.estimate(USER, 'a1', 0.4)).reason).toBe(
      'whole-track',
    );
  });

  it('кадры черновика стёрты по сроку — недоступно', async () => {
    const built = setup();
    built.world.drafts[0].framesPurgedAt = new Date();
    expect((await built.service.estimate(USER, 'a1', 0.4)).reason).toBe(
      'frames-purged',
    );
  });

  it('темп вне диапазона — 400', async () => {
    const { service } = setup();
    await expect(service.estimate(USER, 'a1', 3)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('сборка версии', () => {
  it('одна задача, расход на пользователя, ролик не тронут до активации', async () => {
    const { service, world, ffmpeg, aiUsage, plan, siteMedia } = setup();
    const before = { ...world.assets[0] };
    const res = await service.requestVersion(USER, 'a1', 0.4);
    expect(res.reused).toBe(false);
    expect(res.version.status).toBe('pending');
    expect(ffmpeg.submit).toHaveBeenCalledTimes(1);
    expect(plan.assertCanSpendUser).toHaveBeenCalledWith('u1', {
      projectId: 'p1',
    });
    expect(aiUsage.record).toHaveBeenCalledWith({
      operation: 'tutorial-video-assembly',
      model: 'ffmpeg-api',
      userId: 'u1',
    });
    // Строка ролика — та же самая: потребители версию не видят.
    expect(world.assets[0]).toEqual(before);
    expect(siteMedia.syncForDraft).not.toHaveBeenCalled();
    // Исходник сохранён версией `source`.
    const source = world.versions.find((v) => v.kind === 'source');
    expect(source).toMatchObject({
      blobUrl: before.blobUrl,
      videoMs: 12_000,
      status: 'complete',
    });
    // Подписи версии — под префиксом исходников, команда на них ссылается.
    const cmd = ffmpeg.submit.mock.calls[0][0].commands[0] as string;
    expect(cmd).toContain('subtitles={{captions}}');
    expect(ffmpeg.submit.mock.calls[0][0].inputs.captions).toMatch(
      /tutorial-video-sources\/a1\/captions\/v\d+\.ass$/,
    );
  });

  it('двойной клик — та же версия, вторая задача не уходит', async () => {
    const { service, ffmpeg, world } = setup();
    const [a, b] = await Promise.all([
      service.requestVersion(USER, 'a1', 0.4),
      service.requestVersion(USER, 'a1', 0.4000001),
    ]);
    expect(ffmpeg.submit).toHaveBeenCalledTimes(1);
    expect(a.version.id).toBe(b.version.id);
    expect(world.versions.filter((v) => v.kind === 'tempo')).toHaveLength(1);
    const again = await service.requestVersion(USER, 'a1', 0.4);
    expect(again.reused).toBe(true);
    expect(ffmpeg.submit).toHaveBeenCalledTimes(1);
  });

  it('другой темп, пока первая версия собирается, — «уже собирается»', async () => {
    const { service, ffmpeg } = setup();
    await service.requestVersion(USER, 'a1', 0.4);
    await expect(service.requestVersion(USER, 'a1', 1.5)).rejects.toThrow(
      ConflictException,
    );
    expect(ffmpeg.submit).toHaveBeenCalledTimes(1);
  });

  it('суточный лимит исчерпан — отказ до задачи и без строки версии', async () => {
    const { service, plan, ffmpeg, world } = setup();
    plan.assertCanSpendUser.mockRejectedValue(new Error('лимит'));
    await expect(service.requestVersion(USER, 'a1', 0.4)).rejects.toThrow(
      'лимит',
    );
    expect(ffmpeg.submit).not.toHaveBeenCalled();
    expect(world.versions.filter((v) => v.kind === 'tempo')).toHaveLength(0);
  });

  it('«обычный» — без сборки и без денег', async () => {
    const { service, ffmpeg, aiUsage } = setup();
    const res = await service.requestVersion(USER, 'a1', 1);
    expect(res.reused).toBe(true);
    expect(res.version.active).toBe(true);
    expect(ffmpeg.submit).not.toHaveBeenCalled();
    expect(aiUsage.record).not.toHaveBeenCalled();
  });

  it('провалившийся темп повторяется до потолка попыток', async () => {
    const { service, world, ffmpeg } = setup();
    await service.requestVersion(USER, 'a1', 0.4);
    const v = world.versions.find((x) => x.kind === 'tempo');
    for (let i = 1; i < MAX_VERSION_ATTEMPTS; i++) {
      v.status = 'failed';
      await service.requestVersion(USER, 'a1', 0.4);
    }
    v.status = 'failed';
    await expect(service.requestVersion(USER, 'a1', 0.4)).rejects.toThrow(
      BadRequestException,
    );
    expect(ffmpeg.submit).toHaveBeenCalledTimes(MAX_VERSION_ATTEMPTS);
  });
});

describe('опрос, проверка и активация', () => {
  async function built(opts: Parameters<typeof setup>[0] = {}) {
    const s = setup(opts);
    await s.service.requestVersion(
      opts.asset?.clientSiteDraftId === null ? OPERATOR : USER,
      'a1',
      0.4,
    );
    s.ffmpeg.status.mockResolvedValue({
      status: 'completed',
      outputs: { 'tutorial.mp4': 'https://ffmpeg.example/out.mp4' },
    });
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array(4096).buffer,
    } as any);
    return s;
  }
  afterEach(() => jest.restoreAllMocks());

  it('клиент: проверка прошла — версия активна сама, набор сайта обновлён', async () => {
    const { service, world, siteMedia } = await built();
    const r = await service.pollVersions();
    expect(r).toMatchObject({ polled: 1, completed: 1 });
    const v = world.versions.find((x) => x.kind === 'tempo');
    expect(v.status).toBe('complete');
    expect(v.blobUrl).toBe(
      `https://blob/tutorial-videos/versions/a1/${v.id}.mp4`,
    );
    expect(world.assets[0]).toMatchObject({
      blobUrl: v.blobUrl,
      activeVersionId: v.id,
      durationMs: v.videoMs,
    });
    expect(siteMedia.syncForDraft).toHaveBeenCalledWith('draft1');
    // Проверка — против длительности ПЛАНА версии и с ожиданием звука.
    expect(checkMock.mock.calls[0][1]).toMatchObject({
      durationMs: v.videoMs,
      hasAudio: true,
      width: 720,
      height: 1560,
    });
  });

  it('проверка не прошла — версия failed, ролик и набор сайта не тронуты', async () => {
    const s = await built();
    checkMock.mockReturnValue({
      ok: false,
      problems: ['кадров 10 вместо 300'],
    });
    const before = { ...s.world.assets[0] };
    await s.service.pollVersions();
    const v = s.world.versions.find((x) => x.kind === 'tempo');
    expect(v.status).toBe('failed');
    expect(v.error).toContain('кадров 10 вместо 300');
    expect(s.world.assets[0]).toEqual(before);
    expect(s.blob.uploadBuffer).not.toHaveBeenCalledWith(
      expect.stringContaining('tutorial-videos/versions/'),
      expect.anything(),
      expect.anything(),
    );
    expect(s.siteMedia.syncForDraft).not.toHaveBeenCalled();
  });

  it('ffmpeg вернул ошибку — failed не затирает исходник', async () => {
    const s = await built();
    s.ffmpeg.status.mockResolvedValue({ status: 'failed', error: 'boom' });
    const before = { ...s.world.assets[0] };
    await s.service.pollVersions();
    expect(s.world.versions.find((x) => x.kind === 'tempo').status).toBe(
      'failed',
    );
    expect(s.world.assets[0]).toEqual(before);
  });

  it('публичное демо: версия собрана, но активна только после одобрения оператора', async () => {
    const s = await built({
      asset: { clientSiteDraftId: null, scenarioId: 'ts-1', subjectKey: '1' },
    });
    const before = { ...s.world.assets[0] };
    await s.service.pollVersions();
    const v = s.world.versions.find((x) => x.kind === 'tempo');
    expect(v).toMatchObject({ status: 'complete', requiresApproval: true });
    expect(s.world.assets[0]).toEqual(before);
    // Пользователь сценарный ролик не видит вовсе.
    await expect(s.service.activate(USER, 'a1', v.id)).rejects.toThrow(
      NotFoundException,
    );
    const view = await s.service.activate(OPERATOR, 'a1', v.id);
    expect(view).toMatchObject({ active: true, approved: true });
    expect(s.world.assets[0].blobUrl).toBe(v.blobUrl);
    expect(v.approvedBy).toBe('op1');
  });

  it('возврат к обычному — исходный файл и исходная длительность', async () => {
    const s = await built();
    await s.service.pollVersions();
    expect(s.world.assets[0].activeVersionId).not.toBeNull();
    const view = await s.service.revert(USER, 'a1');
    expect(view).toMatchObject({ kind: 'source', active: true });
    expect(s.world.assets[0]).toMatchObject({
      blobUrl: 'https://blob/tutorial-videos/client-site/a1.mp4',
      durationMs: 12_000,
      activeVersionId: null,
    });
  });

  it('повторный выбор уже собранного темпа — активация без новой задачи', async () => {
    const s = await built();
    await s.service.pollVersions();
    await s.service.revert(USER, 'a1');
    const res = await s.service.requestVersion(USER, 'a1', 0.4);
    expect(res.reused).toBe(true);
    expect(s.ffmpeg.submit).toHaveBeenCalledTimes(1);
    expect(s.world.assets[0].activeVersionId).toBe(res.version.id);
  });

  it('просроченная задача — failed, ролик цел', async () => {
    const s = await built();
    const v = s.world.versions.find((x) => x.kind === 'tempo');
    v.startedAt = new Date(Date.now() - 11 * 60 * 1000);
    await s.service.pollVersions();
    expect(v.status).toBe('failed');
    expect(s.world.assets[0].activeVersionId).toBeNull();
  });
});

describe('список обучалок пользователя', () => {
  it('только свои, последний собранный ролик черновика, с признаком редактируемости', async () => {
    const { service } = setup();
    const items = await service.listForUser('u1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      assetId: 'a1',
      editable: true,
      voiced: true,
      activeFactor: 1,
      inFlight: false,
    });
    expect(await service.listForUser('u2')).toEqual([]);
  });
});

describe('уборка', () => {
  it('файлы версий, исходник и исходники — по своим префиксам', async () => {
    const s = setup();
    s.world.versions.push(
      {
        assetId: 'a1',
        blobUrl: 'https://blob/tutorial-videos/client-site/a1.mp4',
      },
      {
        assetId: 'a1',
        blobUrl: 'https://blob/tutorial-videos/versions/a1/v9.mp4',
      },
      { assetId: 'a1', blobUrl: null },
    );
    await s.service.deleteAssetExtras('a1');
    expect(s.blob.deleteMany).toHaveBeenCalledWith([
      'tutorial-videos/client-site/a1.mp4',
      'tutorial-videos/versions/a1/v9.mp4',
    ]);
    expect(s.blob.listByPrefix).toHaveBeenCalledWith(
      'tutorial-video-sources/a1/',
      {
        cursor: undefined,
      },
    );
    expect(s.blob.listByPrefix).toHaveBeenCalledWith(
      'tutorial-videos/versions/a1/',
      {
        cursor: undefined,
      },
    );
  });
});

describe('озвучка обучалки клиента', () => {
  const input = {
    assetId: 'a2',
    draftId: 'draft1',
    ownerUserId: 'u1',
    projectId: 'p1',
    locale: 'uk',
    texts: ['Відкрийте сайт shop.example.', null, 'Готово.'],
    stepIndexes: [0, 1, 2],
  };

  it('Resemble, язык черновика, расход на владельца, немой кадр без текста', async () => {
    const s = setup();
    const res = await s.service.synthesizeClientVoices(input);
    expect(s.tts.resolveByKey).toHaveBeenCalledWith('resemble');
    expect(s.provider.synthesize).toHaveBeenCalledTimes(2);
    expect(s.provider.synthesize.mock.calls[0][0]).toEqual({
      text: 'Відкрийте сайт shop.example.',
      language: 'uk',
      voiceId: null,
    });
    expect(s.aiUsage.record).toHaveBeenCalledWith({
      operation: 'tutorial-voiceover',
      model: 'resemble-tts',
      characters: 'Відкрийте сайт shop.example.'.length,
      userId: 'u1',
    });
    expect(res.speech[1]).toBeNull();
    expect(res.speech[0]).toMatchObject({
      seconds: 2.5,
      provenance: { provider: 'resemble', locale: 'uk' },
    });
    expect(res.speech[0]!.pathname).toMatch(
      /^tutorial-video-sources\/a2\/voice\/0-[0-9a-f]{16}-2500\.mp3$/,
    );
    expect(res.skipped).toBeNull();
  });

  it('суточный лимит — ни одного синтеза, ролик немой с причиной', async () => {
    const s = setup();
    s.plan.assertCanSpendUser.mockRejectedValue(new Error('лимит'));
    const res = await s.service.synthesizeClientVoices(input);
    expect(s.provider.synthesize).not.toHaveBeenCalled();
    expect(res.skipped).toBe('daily-limit');
    expect(res.speech.every((x) => x === null)).toBe(true);
  });

  it('лимит кончился посреди ролика — дальше не синтезируем', async () => {
    const s = setup();
    s.plan.assertCanSpendUser
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('лимит'));
    const res = await s.service.synthesizeClientVoices(input);
    expect(s.provider.synthesize).toHaveBeenCalledTimes(1);
    expect(res.speech[0]).not.toBeNull();
    expect(res.speech[2]).toBeNull();
  });

  it('Resemble не настроен — немой с причиной', async () => {
    const s = setup();
    s.provider.configured.mockReturnValue(false);
    const res = await s.service.synthesizeClientVoices(input);
    expect(res.skipped).toBe('tts-not-configured');
  });

  it('та же реплика из прошлой сборки черновика — копия, не новый синтез', async () => {
    const s = setup();
    const first = await s.service.synthesizeClientVoices({
      ...input,
      assetId: 'a1',
    });
    s.world.assets[0].tempoManifest = manifest({
      locale: 'uk',
      frames: [
        { ...frame(0, 2.5), speech: first.speech[0] },
        frame(1, null),
        { ...frame(2, 2.5), speech: first.speech[2] },
      ],
    });
    s.provider.synthesize.mockClear();
    const again = await s.service.synthesizeClientVoices(input);
    expect(s.provider.synthesize).not.toHaveBeenCalled();
    expect(s.blob.copyBlob).toHaveBeenCalledTimes(2);
    expect(again.speech[0]!.pathname).toContain('tutorial-video-sources/a2/');
  });
});

describe('исходники сценарного ролика при complete', () => {
  it('кадры и дорожки копируются в постоянный префикс, manifest — storage: sources', async () => {
    const transit = manifest({
      owner: { kind: 'scenario', scenarioId: 's1', subjectKey: '1' },
      storage: 'transit',
      frames: [
        {
          ...frame(0, 3.2),
          image: {
            url: 'https://blob/tutorial-video-frames/a1/0.png',
            pathname: 'tutorial-video-frames/a1/0.png',
          },
        },
        {
          ...frame(1, null),
          image: {
            url: 'https://blob/tutorial-video-frames/a1/1.png',
            pathname: 'tutorial-video-frames/a1/1.png',
          },
        },
      ],
    });
    const s = setup({
      asset: {
        clientSiteDraftId: null,
        scenarioId: 's1',
        tempoManifest: transit,
      },
    });
    await s.service.captureScenarioSources('a1');
    const m = s.world.assets[0].tempoManifest;
    expect(m.storage).toBe('sources');
    expect(m.frames[0].image.pathname).toBe(
      'tutorial-video-sources/a1/frames/0.png',
    );
    expect(m.frames[0].speech.pathname).toMatch(
      /^tutorial-video-sources\/a1\/voice\/0-/,
    );
    expect(m.sourceHash).toBe(transit.sourceHash);
    expect(s.blob.copyBlob).toHaveBeenCalledWith(
      'tutorial-video-frames/a1/0.png',
      'tutorial-video-sources/a1/frames/0.png',
      'image/png',
    );
  });

  it('копия не удалась — manifest остаётся транзитным (темп недоступен), ролик цел', async () => {
    const transit = manifest({ storage: 'transit' });
    const s = setup({
      asset: {
        clientSiteDraftId: null,
        scenarioId: 's1',
        tempoManifest: transit,
      },
    });
    s.blob.copyBlob.mockResolvedValueOnce(null);
    await s.service.captureScenarioSources('a1');
    expect(s.world.assets[0].tempoManifest).toBe(transit);
    expect((await s.service.estimate(OPERATOR, 'a1', 0.4)).reason).toBe(
      'sources-pending',
    );
  });
});

describe('активация пользователем', () => {
  it('версию, требующую одобрения, пользователь активировать не может (защита в глубину)', async () => {
    const s = setup();
    s.world.versions.push({
      id: 'vx',
      assetId: 'a1',
      kind: 'tempo',
      tempoFactor: 0.4,
      status: 'complete',
      blobUrl: 'https://blob/tutorial-videos/versions/a1/vx.mp4',
      videoMs: 9000,
      requiresApproval: true,
      createdAt: new Date(),
    });
    await expect(s.service.activate(USER, 'a1', 'vx')).rejects.toThrow(
      ConflictException,
    );
    expect(s.world.assets[0].activeVersionId).toBeNull();
    await expect(s.service.activate(USER, 'a1', 'nope')).rejects.toThrow(
      NotFoundException,
    );
  });
});
