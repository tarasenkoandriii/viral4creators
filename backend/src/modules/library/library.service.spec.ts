/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { LibraryRow } from './library.service';
import { sessionPreviewPathname } from './library.service';
import {
  canView,
  LibraryService,
  reviveAnalysis,
  toAdminView,
  toView,
} from './library.service';
import { AnalysisStatus } from '../../common/types/analysis.types';
import { VideoSourceType } from '../../common/types/video.types';

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

const NOW = new Date('2026-09-06T10:00:00.000Z');
const analysisJson = {
  analysisId: 'a1',
  analyzedAt: '2026-09-01T00:00:00.000Z',
  status: 'complete',
  sceneBreakdown: 'Scene 1…',
  scenes: [{ id: 's1', start: 0, end: 2, title: 'Hook', previewAt: 1 }],
  audience: {
    ageRange: '25-34',
    gender: 'women',
    interests: ['бег'],
    summary: null,
    source: 'gemini',
  },
  promotedProduct: {
    category: 'кроссовки',
    description: null,
    priceTier: 'mid',
  },
};
const row = (over: Partial<LibraryRow> = {}): LibraryRow =>
  ({
    id: 'l1',
    sourceKey: 'yt:abc',
    sourceType: 'youtube',
    sourceUrl: 'https://youtu.be/abc',
    title: 'Hook',
    thumbnailUrl: null,
    analysis: analysisJson,
    category: 'кроссовки',
    audienceGender: 'women',
    audienceAgeRange: '25-34',
    audienceInterests: ['бег'],
    aspectRatio: '9:16',
    sceneCount: 1,
    characterCount: 0,
    usageCount: 2,
    visibility: 'PUBLIC',
    hiddenReason: null,
    moderatedAt: null,
    userId: 'u1',
    sessionId: 's1',
    updatedAt: NOW,
    createdAt: NOW,
    ...over,
  }) as LibraryRow;

function build(session: Record<string, unknown> | null = { sessionId: 's1' }) {
  const prisma = {
    analysisLibraryEntry: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      upsert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // М-3.13: записи, на которые ссылаются незавершённые партии/A-B,
    // уборка не трогает — по умолчанию таких нет.
    catalogBatchRun: { findMany: jest.fn().mockResolvedValue([]) },
    abTestRun: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const sessions = {
    getSession: jest.fn().mockResolvedValue(session),
    updateSession: jest.fn().mockResolvedValue(undefined),
  };
  const blob = {
    deleteMany: jest.fn().mockResolvedValue(0),
    copyBlob: jest
      .fn()
      .mockImplementation((_from: string, to: string) =>
        Promise.resolve(`https://cdn/${to}`),
      ),
  };
  const plans = plansMock();
  const svc = new LibraryService(
    prisma as any,
    sessions as any,
    blob as any,
    plans as any,
  );
  return { svc, prisma, sessions, blob, plans };
}

describe('library helpers', () => {
  it('reviveAnalysis turns the Json column back into a VideoAnalysis, rejects junk', () => {
    const a = reviveAnalysis(analysisJson)!;
    expect(a.sceneBreakdown).toBe('Scene 1…');
    expect(a.analyzedAt).toBeInstanceOf(Date);
    expect(reviveAnalysis(null)).toBeNull();
    expect(reviveAnalysis([1])).toBeNull();
    expect(reviveAnalysis({ nope: 1 })).toBeNull();
  });
  it('toView exposes facets only, never the stored analysis; `own` is per viewer', () => {
    const v = toView(row(), 'u1');
    expect(v).toMatchObject({
      id: 'l1',
      sourceType: 'youtube',
      sceneCount: 1,
      usageCount: 2,
      visibility: 'PUBLIC',
      own: true,
    });
    expect(v).not.toHaveProperty('analysis');
    expect(toView(row(), 'someone-else').own).toBe(false);
    expect(toView(row()).own).toBe(false);
  });

  it('canView: public to everyone, private to its author, hidden to nobody (§21.1/§21.3)', () => {
    expect(canView({ visibility: 'PUBLIC', userId: 'u1' }, null)).toBe(true);
    expect(canView({ visibility: 'PRIVATE', userId: 'u1' }, 'u1')).toBe(true);
    expect(canView({ visibility: 'PRIVATE', userId: 'u1' }, 'u2')).toBe(false);
    expect(canView({ visibility: 'PRIVATE', userId: 'u1' }, null)).toBe(false);
    expect(canView({ visibility: 'HIDDEN', userId: 'u1' }, 'u1')).toBe(false);
  });

  it('toAdminView adds the moderation trail', () => {
    const v = toAdminView(
      row({ visibility: 'HIDDEN', hiddenReason: 'мусор', moderatedAt: NOW }),
    );
    expect(v).toMatchObject({
      sourceKey: 'yt:abc',
      visibility: 'HIDDEN',
      hiddenReason: 'мусор',
      moderatedAt: NOW.toISOString(),
      ownerId: 'u1',
      sessionId: 's1',
    });
  });
});

describe('LibraryService', () => {
  it('findAnalysis: cache hit / miss by source key; a hidden entry never serves the cache', async () => {
    const { svc, prisma } = build();
    prisma.analysisLibraryEntry.findUnique.mockResolvedValueOnce(row());
    expect((await svc.findAnalysis('yt:abc'))?.sceneBreakdown).toBe('Scene 1…');
    prisma.analysisLibraryEntry.findUnique.mockResolvedValueOnce(null);
    expect(await svc.findAnalysis('yt:none')).toBeNull();
    // §21.1: скрытая запись — как будто её нет, следующий анализ сделает заново
    prisma.analysisLibraryEntry.findUnique.mockResolvedValueOnce(
      row({ visibility: 'HIDDEN' }),
    );
    expect(await svc.findAnalysis('yt:abc')).toBeNull();
    // Приватная — из кеша отдаётся всем: тот же файл у другого человека
    // и есть тот же самый ролик (см. doc-комментарий сервиса)
    prisma.analysisLibraryEntry.findUnique.mockResolvedValueOnce(
      row({ visibility: 'PRIVATE' }),
    );
    expect(await svc.findAnalysis('sha256:x')).not.toBeNull();
  });

  it('save upserts denormalised facets and never throws on a DB error', async () => {
    const { svc, prisma } = build();
    await svc.save({
      sourceKey: 'yt:abc',
      sourceType: 'youtube',
      sourceUrl: 'https://youtu.be/abc',
      aspectRatio: '9:16',
      analysis: {
        ...(analysisJson as any),
        analyzedAt: NOW,
        status: AnalysisStatus.COMPLETE,
      },
      sessionId: 's1',
      userId: null,
    });
    const args = prisma.analysisLibraryEntry.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ sourceKey: 'yt:abc' });
    // §21.3: у ссылки — публично; решение оператора при повторном анализе
    // не трогается (visibility нет в update)
    expect(args.create.visibility).toBe('PUBLIC');
    expect(args.update).not.toHaveProperty('visibility');
    // Этап 54 (В-2.14): автор и сессия первого разбора при повторном
    // разборе не затираются — `undefined` для Prisma значит «не трогать».
    expect(args.create.sessionId).toBe('s1');
    expect(args.update.sessionId).toBeUndefined();
    expect(args.update.userId).toBeUndefined();
    expect(args.create).toMatchObject({
      category: 'кроссовки',
      audienceGender: 'women',
      audienceInterests: ['бег'],
      sceneCount: 1,
      title: 'Hook',
      aspectRatio: '9:16',
    });
    prisma.analysisLibraryEntry.upsert.mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(
      svc.save({
        sourceKey: 'yt:x',
        sourceType: 'youtube',
        sourceUrl: null,
        aspectRatio: null,
        analysis: { ...(analysisJson as any), analyzedAt: NOW },
        sessionId: null,
        userId: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('save: an upload starts PRIVATE (§21.3)', async () => {
    const { svc, prisma } = build();
    await svc.save({
      sourceKey: 'sha256:abc',
      sourceType: 'upload',
      sourceUrl: null,
      aspectRatio: null,
      analysis: { ...(analysisJson as any), analyzedAt: NOW },
      sessionId: 's1',
      userId: 'u1',
    });
    expect(
      prisma.analysisLibraryEntry.upsert.mock.calls[0][0].create.visibility,
    ).toBe('PRIVATE');
  });

  it('recommend: ranks against the product, skips the current reference', async () => {
    const { svc, prisma } = build({
      sessionId: 's1',
      productInformation: {
        productName: 'Кроссовки',
        category: 'кроссовки',
        audience: {
          ageRange: '25-34',
          gender: 'women',
          interests: ['бег'],
          summary: null,
          source: 'gemini',
        },
      },
      originalVideo: {
        sourceType: VideoSourceType.YOUTUBE,
        youtubeUrl: 'https://youtu.be/current',
        registeredAt: NOW,
      },
    });
    prisma.analysisLibraryEntry.findMany.mockResolvedValue([
      row(),
      row({ id: 'l2', sourceUrl: 'https://youtu.be/current' }),
      row({
        id: 'l3',
        category: 'гарнитуры',
        audienceGender: 'men',
        audienceAgeRange: '18-24',
        audienceInterests: [],
        usageCount: 0,
      }),
    ]);
    const recs = await svc.recommend('s1', 5);
    expect(recs.map((r) => r.id)).toEqual(['l1', 'l3']);
    // §21.3: анонимная сессия видит только публичное, вошедший — ещё и своё
    expect(prisma.analysisLibraryEntry.findMany.mock.calls[0][0].where).toEqual(
      {
        visibility: 'PUBLIC',
      },
    );
    expect(recs[0].score).toBeGreaterThan(recs[1].score);
    expect(recs[0].reasons[0]).toContain('та же категория');
  });

  it('applyToSession: copies the analysis, restores the YouTube source, resets stale choices, bumps usage', async () => {
    const { svc, prisma, sessions } = build();
    prisma.analysisLibraryEntry.findUnique.mockResolvedValue(row());
    const a = await svc.applyToSession('s1', 'l1');
    expect(a.sceneBreakdown).toBe('Scene 1…');
    const patch = sessions.updateSession.mock.calls[0][1];
    expect(patch.originalVideo).toMatchObject({
      sourceType: VideoSourceType.YOUTUBE,
      youtubeUrl: 'https://youtu.be/abc',
      frame: { aspectRatio: '9:16', source: 'gemini' },
    });
    expect(patch.status).toBe('analysis_complete');
    expect(patch.characterCasting).toBeUndefined();
    expect(patch.relevance).toBeUndefined();
    expect(prisma.analysisLibraryEntry.update).toHaveBeenCalledWith({
      where: { sourceKey: 'yt:abc' },
      data: { usageCount: { increment: 1 } },
    });
  });

  it('applyToSession: 404 for an unknown entry or session', async () => {
    const { svc, prisma } = build();
    prisma.analysisLibraryEntry.findUnique.mockResolvedValue(null);
    await expect(svc.applyToSession('s1', 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const missing = build(null);
    await expect(missing.svc.applyToSession('s9', 'l1')).rejects.toThrow(
      /Session s9 not found/,
    );
  });
});

describe('LibraryService — приватность и модерация (§21.1/§21.3)', () => {
  it('recommend вошедшего пользователя добавляет его приватные записи', async () => {
    const { svc, prisma } = build({
      sessionId: 's1',
      userId: 'u7',
      productInformation: {
        productName: 'x',
        category: 'кроссовки',
        audience: null,
      },
    });
    // Б-1.3: два запроса вместо одного `OR` — с `OR` планировщик не
    // берёт составной индекс и идёт полным сканом (30,6 мс против
    // 0,49). Проверяем не форму ради формы, а что обе половины выборки
    // на месте и приватные принадлежат именно этому зрителю.
    await svc.recommend('s1', 5);
    const wheres = prisma.analysisLibraryEntry.findMany.mock.calls.map(
      (c: [{ where: unknown }]) => c[0].where,
    );
    expect(wheres).toEqual([
      { visibility: 'PUBLIC' },
      { visibility: 'PRIVATE', userId: 'u7' },
    ]);
    // Каждая половина ограничена: без `take` один пользователь с
    // тысячей приватных записей вытеснил бы всё публичное.
    for (const call of prisma.analysisLibraryEntry.findMany.mock.calls) {
      expect(call[0].take).toBe(200);
    }
  });

  it('recommend анонимной сессии не делает второго запроса', async () => {
    // Своих записей у неё быть не может — лишний запрос был бы просто
    // лишним.
    const { svc, prisma } = build({
      sessionId: 's1',
      userId: null,
      productInformation: {
        productName: 'x',
        category: 'кроссовки',
        audience: null,
      },
    });
    await svc.recommend('s1', 5);
    expect(prisma.analysisLibraryEntry.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.analysisLibraryEntry.findMany.mock.calls[0][0].where).toEqual(
      {
        visibility: 'PUBLIC',
      },
    );
  });

  it('get / applyToSession не отдают чужую приватную и любую скрытую запись', async () => {
    const foreign = build({ sessionId: 's1', userId: 'u2' });
    foreign.prisma.analysisLibraryEntry.findUnique.mockResolvedValue(
      row({ visibility: 'PRIVATE', userId: 'u1' }),
    );
    await expect(foreign.svc.get('l1', 'u2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(foreign.svc.applyToSession('s1', 'l1')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const own = build({ sessionId: 's1', userId: 'u1' });
    own.prisma.analysisLibraryEntry.findUnique.mockResolvedValue(
      row({ visibility: 'PRIVATE', userId: 'u1' }),
    );
    expect((await own.svc.get('l1', 'u1')).own).toBe(true);
    await expect(own.svc.applyToSession('s1', 'l1')).resolves.toBeDefined();

    const hidden = build({ sessionId: 's1', userId: 'u1' });
    hidden.prisma.analysisLibraryEntry.findUnique.mockResolvedValue(
      row({ visibility: 'HIDDEN' }),
    );
    await expect(hidden.svc.get('l1', 'u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('adminList: фильтры и поиск попадают в запрос, страница считается', async () => {
    const { svc, prisma } = build();
    prisma.analysisLibraryEntry.findMany.mockResolvedValue([row()]);
    prisma.analysisLibraryEntry.count.mockResolvedValue(42);
    const page = await svc.adminList({
      visibility: 'HIDDEN',
      sourceType: 'upload',
      q: 'крос',
      page: 2,
      pageSize: 20,
    });
    const args = prisma.analysisLibraryEntry.findMany.mock.calls[0][0];
    expect(args.where.visibility).toBe('HIDDEN');
    expect(args.where.sourceType).toBe('upload');
    expect(args.where.OR).toHaveLength(3);
    expect(args.skip).toBe(20);
    expect(page).toMatchObject({ total: 42, page: 2, pageSize: 20 });
    expect(page.items[0].sourceKey).toBe('yt:abc');
    // мусорные значения фильтров просто игнорируются
    await svc.adminList({
      visibility: 'nope',
      sourceType: 'nope',
      page: 1,
      pageSize: 20,
    });
    expect(prisma.analysisLibraryEntry.findMany.mock.calls[1][0].where).toEqual(
      {},
    );
  });

  it('adminUpdate: скрытие требует причину, штампует модератора, пустой патч ничего не пишет', async () => {
    const { svc, prisma } = build();
    prisma.analysisLibraryEntry.findUnique.mockResolvedValue(row());
    await expect(
      svc.adminUpdate('l1', 'op1', { visibility: 'HIDDEN' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    prisma.analysisLibraryEntry.update.mockResolvedValue(
      row({
        visibility: 'HIDDEN',
        hiddenReason: 'битый разбор',
        moderatedAt: NOW,
      }),
    );
    const v = await svc.adminUpdate('l1', 'op1', {
      visibility: 'HIDDEN',
      hiddenReason: ' битый разбор ',
    });
    const data = prisma.analysisLibraryEntry.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      visibility: 'HIDDEN',
      hiddenReason: 'битый разбор',
      moderatedById: 'op1',
    });
    expect(data.moderatedAt).toBeInstanceOf(Date);
    expect(v.visibility).toBe('HIDDEN');

    prisma.analysisLibraryEntry.update.mockClear();
    await svc.adminUpdate('l1', 'op1', {});
    expect(prisma.analysisLibraryEntry.update).not.toHaveBeenCalled();
  });

  it('adminGet отдаёт разбор целиком, adminDelete проверяет существование', async () => {
    const { svc, prisma } = build();
    prisma.analysisLibraryEntry.findUnique.mockResolvedValue(row());
    expect((await svc.adminGet('l1')).analysis?.sceneBreakdown).toBe(
      'Scene 1…',
    );
    await svc.adminDelete('l1');
    expect(prisma.analysisLibraryEntry.delete).toHaveBeenCalledWith({
      where: { id: 'l1' },
    });
    prisma.analysisLibraryEntry.findUnique.mockResolvedValue(null);
    await expect(svc.adminDelete('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('копии кадров-превью в библиотеке (этап 26, doc/STORAGE-AUDIT.md)', () => {
  it('sessionPreviewPathname узнаёт кадр сессии и отвергает всё остальное', () => {
    expect(
      sessionPreviewPathname(
        'https://x.public.blob.vercel-storage.com/sessions/s1/previews/scene-s2.jpg',
      ),
    ).toBe('sessions/s1/previews/scene-s2.jpg');
    // уже наша копия
    expect(
      sessionPreviewPathname('https://x.test/library/yt-abc/scene-s2.jpg'),
    ).toBeNull();
    expect(
      sessionPreviewPathname('https://x.test/sessions/s1/generated.mp4'),
    ).toBeNull();
    expect(sessionPreviewPathname('мусор')).toBeNull();
  });

  it('save копирует кадры под library/<ключ>/ и сохраняет уже переписанный разбор', async () => {
    const { svc, prisma, blob } = build();
    await svc.save({
      sourceKey: 'yt:abc',
      sourceType: 'youtube',
      sourceUrl: 'https://youtu.be/abc',
      aspectRatio: '9:16',
      analysis: {
        ...(analysisJson as any),
        analyzedAt: NOW,
        characters: [
          {
            id: 'c1',
            previewUrl:
              'https://x.public.blob.vercel-storage.com/sessions/s1/previews/character-c1.jpg',
          },
        ],
        scenes: [
          {
            id: 's1',
            start: 0,
            end: 2,
            title: 'Hook',
            previewAt: 1,
            previewUrl:
              'https://x.public.blob.vercel-storage.com/sessions/s1/previews/scene-s1.jpg',
          },
        ],
        extras: [{ id: 'e1', label: 'x', description: 'y', previewUrl: null }],
      },
      sessionId: 's1',
      userId: 'u1',
    });
    expect(
      blob.copyBlob.mock.calls.map((c: string[]) => c.slice(0, 2)),
    ).toEqual([
      [
        'sessions/s1/previews/character-c1.jpg',
        'library/yt-abc/character-c1.jpg',
      ],
      ['sessions/s1/previews/scene-s1.jpg', 'library/yt-abc/scene-s1.jpg'],
    ]);
    const stored = prisma.analysisLibraryEntry.upsert.mock.calls[0][0].create;
    expect(stored.analysis.characters[0].previewUrl).toBe(
      'https://cdn/library/yt-abc/character-c1.jpg',
    );
    expect(stored.analysis.scenes[0].previewUrl).toBe(
      'https://cdn/library/yt-abc/scene-s1.jpg',
    );
    // превью первой сцены с картинкой становится обложкой записи
    expect(stored.thumbnailUrl).toBe('https://cdn/library/yt-abc/scene-s1.jpg');
  });

  it('неудачная копия просто оставляет запись без кадра и не роняет сохранение', async () => {
    const { svc, prisma, blob } = build();
    blob.copyBlob.mockResolvedValue(null);
    await svc.save({
      sourceKey: 'sha256:zzz',
      sourceType: 'upload',
      sourceUrl: null,
      aspectRatio: null,
      analysis: {
        ...(analysisJson as any),
        analyzedAt: NOW,
        scenes: [
          {
            id: 's1',
            start: 0,
            end: 1,
            title: 'Hook',
            previewAt: 0,
            previewUrl: 'https://x.test/sessions/s1/previews/scene-s1.jpg',
          },
        ],
      },
      sessionId: 's1',
      userId: 'u1',
    });
    const stored = prisma.analysisLibraryEntry.upsert.mock.calls[0][0].create;
    expect(stored.analysis.scenes[0].previewUrl).toBeNull();
    expect(stored.thumbnailUrl).toBeNull();
  });
});

describe('LibraryService.pruneUnused — невостребованные разборы (этап 51, В-4.6)', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  const stale = (id: string) => ({
    id,
    sourceKey: `yt:${id}`,
    analysis: {
      ...analysisJson,
      scenes: [
        {
          id: 's1',
          start: 0,
          end: 2,
          title: 'Хук',
          previewAt: 1,
          previewUrl: `https://x.public.blob.vercel-storage.com/library/yt-${id}/previews/scene-s1.jpg`,
        },
      ],
    },
  });

  it('берёт только usageCount = 0, старше срока и не скрытые', async () => {
    const { svc, prisma } = build();
    prisma.analysisLibraryEntry.deleteMany.mockResolvedValue({ count: 0 });
    const now = new Date('2026-09-10T00:00:00Z');
    await svc.pruneUnused(now);
    const where = prisma.analysisLibraryEntry.findMany.mock.calls[0][0].where;
    expect(where.usageCount).toBe(0);
    // Скрытое оператором — след нарушения, его не трогаем (В-2.14).
    expect(where.visibility).toEqual({ not: 'HIDDEN' });
    const cutoff: Date = where.createdAt.lt;
    expect(now.getTime() - cutoff.getTime()).toBe(180 * 24 * 60 * 60 * 1000);
    // И ничего лишнего не выбирается — колонка analysis нужна только ради
    // путей к кадрам.
    expect(
      prisma.analysisLibraryEntry.findMany.mock.calls[0][0].select,
    ).toEqual({ id: true, sourceKey: true, analysis: true });
  });

  it('строки удаляются раньше файлов, и файлы — всех удалённых записей', async () => {
    const { svc, prisma, blob } = build();
    prisma.analysisLibraryEntry.findMany.mockResolvedValue([
      stale('a'),
      stale('b'),
    ]);
    prisma.analysisLibraryEntry.deleteMany.mockResolvedValue({ count: 2 });
    const r = await svc.pruneUnused();
    expect(r).toEqual({ count: 2, hasMore: false, disabled: false });
    // Удаление строк — с повторной проверкой usageCount: запись могли
    // взять в сессию между выборкой и удалением.
    expect(
      prisma.analysisLibraryEntry.deleteMany.mock.calls[0][0].where,
    ).toEqual({
      id: { in: ['a', 'b'] },
      usageCount: 0,
    });
    const del =
      prisma.analysisLibraryEntry.deleteMany.mock.invocationCallOrder[0];
    const files = blob.deleteMany.mock.invocationCallOrder[0];
    expect(del).toBeLessThan(files);
    const paths = blob.deleteMany.mock.calls[0][0] as string[];
    expect(paths.some((p) => p.startsWith('library/yt-a/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('library/yt-b/'))).toBe(true);
  });

  it('сбой хранилища не отменяет удаление строк и не бросает', async () => {
    const { svc, prisma, blob } = build();
    prisma.analysisLibraryEntry.findMany.mockResolvedValue([stale('a')]);
    prisma.analysisLibraryEntry.deleteMany.mockResolvedValue({ count: 1 });
    blob.deleteMany.mockRejectedValue(new Error('токен протух'));
    await expect(svc.pruneUnused()).resolves.toMatchObject({ count: 1 });
  });

  it('LIBRARY_UNUSED_TTL_DAYS=0 выключает чистку, мусор в переменной — умолчание', async () => {
    process.env.LIBRARY_UNUSED_TTL_DAYS = '0';
    const off = build();
    expect(await off.svc.pruneUnused()).toEqual({
      count: 0,
      hasMore: false,
      disabled: true,
    });
    expect(off.prisma.analysisLibraryEntry.findMany).not.toHaveBeenCalled();

    process.env.LIBRARY_UNUSED_TTL_DAYS = 'много';
    const dflt = build();
    dflt.prisma.analysisLibraryEntry.deleteMany.mockResolvedValue({ count: 0 });
    const now = new Date('2026-09-10T00:00:00Z');
    await dflt.svc.pruneUnused(now);
    const cutoff: Date =
      dflt.prisma.analysisLibraryEntry.findMany.mock.calls[0][0].where.createdAt
        .lt;
    expect(now.getTime() - cutoff.getTime()).toBe(180 * 24 * 60 * 60 * 1000);
  });

  it('полная партия — hasMore: остаток доберёт следующий прогон', async () => {
    const { svc, prisma } = build();
    prisma.analysisLibraryEntry.findMany.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => stale(`e${i}`)),
    );
    prisma.analysisLibraryEntry.deleteMany.mockResolvedValue({ count: 200 });
    expect((await svc.pruneUnused()).hasMore).toBe(true);
  });
});

describe('LibraryService.pruneUnused — М-3.13: записи с незавершённой партией не удаляются', () => {
  it('libraryEntryId ожидающей партии попадает в notIn', async () => {
    const { svc, prisma } = build();
    process.env.LIBRARY_UNUSED_TTL_DAYS = '7';
    prisma.catalogBatchRun.findMany.mockResolvedValueOnce([
      { libraryEntryId: 'lib-busy' },
    ]);
    await svc.pruneUnused();
    const where = prisma.analysisLibraryEntry.findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ notIn: ['lib-busy'] });
  });
});
