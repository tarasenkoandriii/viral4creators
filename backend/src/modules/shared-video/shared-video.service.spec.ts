import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
// Этап 80: этот сервис инжектирует PlanService, чей файл (и цепочка ЕГО
// импортов) трогает @prisma/client напрямую — недоступный в песочнице
// клиент рушит ЗАГРУЗКУ модуля ещё до того, как тест успевает подменить
// что-либо конструктором. Тот же приём, что и в
// admin-panel.controller.spec.ts: подменяем модуль целиком заглушкой ДО
// реального импорта — конструкторные моки ниже (plansMock()) их не
// заменяют, а дополняют (сервис всё равно получает мок через DI).
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));
import {
  SharedVideoService,
  snapshotFromSession,
  toPublicView,
  toView,
} from './shared-video.service';
import type { Session } from '../../common/types/session.types';

const plansMock = () => ({
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

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

const session = {
  sessionId: 's1',
  librarySourceKey: 'yt:abc',
  productInformation: {
    productName: 'Кружка Steel 500',
    productDescription: 'Стальная термокружка',
    category: 'термокружки',
    price: 1990,
    currency: 'RUB',
    productImageUrl: 'https://blob.test/sessions/s1/product-image.jpg',
    productImagePathname: 'sessions/s1/product-image.jpg',
    addedAt: new Date(),
  },
  generatedVideo: {
    generatedVideoId: 'v1',
    pathname: 'sessions/s1/generated.mp4',
    status: 'complete',
    downloadUrl: 'https://blob.test/sessions/s1/generated.mp4',
    renderedAspectRatio: '9:16',
  },
} as unknown as Session;

const now = new Date('2026-09-08T12:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 'sv1',
  userId: 'u1',
  sessionId: 's1',
  generatedVideoId: 'v1',
  status: 'PENDING',
  videoUrl: 'https://blob.test/v.mp4',
  videoPathname: 'sessions/s1/generated.mp4',
  aspectRatio: '9:16',
  title: 't',
  productName: 'Кружка Steel 500',
  productDescription: 'd',
  price: 1990,
  currency: 'RUB',
  category: 'термокружки',
  productImageUrl: 'https://blob.test/photo.jpg',
  productImagePathname: 'sessions/s1/product-image.jpg',
  locale: 'ru',
  projectType: null,
  occasion: null,
  showcasedAt: null,
  libraryEntryId: null,
  moderatorId: null,
  moderatedAt: null,
  rejectReason: null,
  viewCount: 0,
  firstGenerationCount: 0,
  likeCount: 0,
  shareCount: 0,
  createdAt: now,
  updatedAt: now,
  ...over,
});

describe('snapshotFromSession', () => {
  it('copies video + product, defaults title, freezes locale', () => {
    const snap = snapshotFromSession(session, {});
    expect(snap).toEqual({
      videoUrl: 'https://blob.test/sessions/s1/generated.mp4',
      videoPathname: 'sessions/s1/generated.mp4',
      generatedVideoId: 'v1',
      aspectRatio: '9:16',
      title: 'Кружка Steel 500',
      projectType: null,
      occasion: null,
      productName: 'Кружка Steel 500',
      productDescription: 'Стальная термокружка',
      price: 1990,
      currency: 'RUB',
      category: 'термокружки',
      productImageUrl: 'https://blob.test/sessions/s1/product-image.jpg',
      productImagePathname: 'sessions/s1/product-image.jpg',
      locale: 'ru',
    });
  });

  it('client title wins; refuses without a completed video, product, or title', () => {
    const snap = snapshotFromSession(session, { title: '  Мой заголовок  ' });
    expect(snap.title).toBe('Мой заголовок');
    expect(() =>
      snapshotFromSession(
        {
          ...session,
          generatedVideo: { ...session.generatedVideo!, status: 'processing' },
        } as never,
        {},
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      snapshotFromSession(
        { ...session, productInformation: undefined } as never,
        {},
      ),
    ).toThrow(/No product information/);
  });
});

/**
 * Этап 1 плана docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md,
 * находка 1.1: до него публикация поздравления была невозможна в
 * принципе — `snapshotFromSession` требовал `productInformation`,
 * которого у GREETING_VIDEO нет по определению.
 */
const greetingSession = {
  sessionId: 's2',
  locale: 'ru',
  greetingBriefSnapshot: {
    sourceGreetingBriefId: 'gb1',
    occasion: 'BIRTHDAY',
    customOccasionText: null,
    recipientName: 'Марина',
    senderName: 'Андрей',
    tone: 'WARM',
    personalMessage: null,
    requestedPresenterProvider: 'grok',
    resolvedPresenterProvider: 'grok',
    requestedResolution: '720p',
    resolvedResolution: '720p',
    brandManifestId: null,
    occasionDate: null,
    addedAt: '2026-09-22T10:00:00.000Z',
  },
  generatedVideo: {
    generatedVideoId: 'v2',
    pathname: 'sessions/s2/generated.mp4',
    status: 'complete',
    downloadUrl: 'https://blob.test/sessions/s2/generated.mp4',
    renderedAspectRatio: '9:16',
  },
} as unknown as Session;

describe('snapshotFromSession — GREETING_VIDEO', () => {
  it('publishes a greeting without any product fields', () => {
    const snap = snapshotFromSession(greetingSession, {});
    expect(snap.projectType).toBe('GREETING_VIDEO');
    expect(snap.occasion).toBe('BIRTHDAY');
    expect(snap.productName).toBeNull();
    expect(snap.productDescription).toBeNull();
    expect(snap.price).toBeNull();
    expect(snap.currency).toBeNull();
    expect(snap.category).toBeNull();
    expect(snap.productImageUrl).toBeNull();
    expect(snap.productImagePathname).toBeNull();
  });

  /**
   * Приватность третьего лица. Имя получателя есть в брифе, но человек,
   * которого поздравляют, страницу не публиковал и о витрине не знает —
   * автоматически вынести его имя в публичный заголовок и в og:title
   * значило бы опубликовать его персональные данные за него.
   */
  it('never leaks the recipient name into the public title', () => {
    const snap = snapshotFromSession(greetingSession, {});
    expect(snap.title).not.toContain('Марина');
    expect(snap.title).toBe('BIRTHDAY');

    // Единственный путь имени в заголовок — автор вписал его сам.
    expect(snapshotFromSession(greetingSession, { title: 'Марине 30!' }).title).toBe(
      'Марине 30!',
    );
  });

  it('uses the custom occasion text when the occasion is OTHER', () => {
    const snap = snapshotFromSession(
      {
        ...greetingSession,
        greetingBriefSnapshot: {
          ...greetingSession.greetingBriefSnapshot!,
          occasion: 'OTHER',
          customOccasionText: '  Новоселье  ',
        },
      } as never,
      {},
    );
    expect(snap.title).toBe('Новоселье');
    expect(snap.occasion).toBe('OTHER');
  });

  it('still refuses a greeting without a completed video', () => {
    expect(() =>
      snapshotFromSession(
        {
          ...greetingSession,
          generatedVideo: {
            ...greetingSession.generatedVideo!,
            status: 'processing',
          },
        } as never,
        {},
      ),
    ).toThrow(BadRequestException);
  });

  /**
   * Дискриминатор — наличие снимка брифа, а НЕ отсутствие товара:
   * сессия без того и другого по-прежнему получает прежний отказ, а не
   * молча публикуется как поздравление без повода.
   */
  it('a session with neither a brief nor a product is still refused', () => {
    expect(() =>
      snapshotFromSession(
        { ...greetingSession, greetingBriefSnapshot: undefined } as never,
        {},
      ),
    ).toThrow(/No product information/);
  });
});

describe('toView / toPublicView', () => {
  it('serialises dates, keeps nulls; public view hides internal ids', () => {
    const v = toView(row({ moderatedAt: now }) as never);
    expect(v.createdAt).toBe('2026-09-08T12:00:00.000Z');
    expect(v.moderatedAt).toBe('2026-09-08T12:00:00.000Z');
    expect(v.userId).toBe('u1');

    // Наружу уходит булево `featured`, а не время отбора.
    expect(toView(row({ showcasedAt: now }) as never).featured).toBe(true);
    expect(toView(row() as never).featured).toBe(false);

    const pub = toPublicView(row() as never);
    expect(pub).not.toHaveProperty('showcasedAt');
    expect(pub.featured).toBe(false);
    expect(pub).not.toHaveProperty('userId');
    expect(pub).not.toHaveProperty('sessionId');
    expect(pub).not.toHaveProperty('status');
    expect(pub.title).toBe('t');
  });
});

function build(
  opts: {
    session?: Session | undefined;
    ownerId?: string | null;
    open?: unknown;
    rows?: unknown[];
    found?: unknown;
    libraryEntry?: unknown;
    likes?: unknown[];
  } = {},
) {
  let lastRow: ReturnType<typeof row> | null = null;
  const prisma = {
    session: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          'ownerId' in opts
            ? opts.ownerId === null
              ? { userId: null }
              : { userId: opts.ownerId }
            : { userId: 'u1' },
        ),
    },
    sharedVideoPage: {
      findFirst: jest.fn().mockResolvedValue(opts.open ?? null),
      create: jest
        .fn()
        .mockImplementation(
          async ({ data }: { data: Record<string, unknown> }) => {
            lastRow = row({ ...data });
            return lastRow;
          },
        ),
      findMany: jest.fn().mockResolvedValue(opts.rows ?? []),
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest
        .fn()
        .mockResolvedValue('found' in opts ? opts.found : row()),
      update: jest
        .fn()
        .mockImplementation(
          async ({ data }: { data: Record<string, unknown> }) => {
            lastRow = row({ ...(lastRow ?? row()), ...data });
            return lastRow;
          },
        ),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    sharedVideoLike: {
      create: jest.fn().mockResolvedValue({ id: 'like1' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue(opts.likes ?? []),
    },
    analysisLibraryEntry: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          'libraryEntry' in opts ? opts.libraryEntry : { id: 'lib1' },
        ),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const sessions = {
    getSession: jest
      .fn()
      .mockResolvedValue('session' in opts ? opts.session : session),
    createSession: jest
      .fn()
      .mockResolvedValue({ ...session, sessionId: 'new-s' }),
  };
  const blob = {
    copyBlob: jest
      .fn()
      .mockResolvedValue('https://blob.test/shared-videos/sv1/video.mp4'),
    deleteMany: jest.fn().mockResolvedValue(1),
  };
  const library = {
    applyEntryToSessionFree: jest.fn().mockResolvedValue(undefined),
  };
  const plans = plansMock();
  return {
    service: new SharedVideoService(
      prisma as never,
      sessions as never,
      plans as never,
      library as never,
      blob as never,
    ),
    prisma,
    sessions,
    blob,
    library,
    plans,
  };
}

describe('SharedVideoService.create', () => {
  it('rejects anonymous and foreign sessions, missing sessions', async () => {
    await expect(
      build({ session: undefined }).service.create('u1', 's0', {}),
    ).rejects.toThrow(NotFoundException);
    await expect(
      build({ ownerId: null }).service.create('u1', 's1', {}),
    ).rejects.toThrow(/анонимна/);
    await expect(
      build({ ownerId: 'u2' }).service.create('u1', 's1', {}),
    ).rejects.toThrow(ForbiddenException);
  });

  it('409 when the video already has a pending or published page', async () => {
    const { service } = build({ open: { id: 'x', status: 'PUBLISHED' } });
    await expect(service.create('u1', 's1', {})).rejects.toThrow(
      ConflictException,
    );
  });

  it('одна активная страница на сессию — под консультативной блокировкой', async () => {
    const { service, prisma } = build();
    await service.create('u1', 's1', {});
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [chunks, key] = prisma.$executeRaw.mock.calls[0] as [
      string[],
      string,
    ];
    expect(chunks.join('?')).toContain('pg_advisory_xact_lock');
    expect(key).toBe('shared-video:s1');
  });

  it('resolves libraryEntryId from the session’s sourceKey', async () => {
    const { service, prisma } = build();
    await service.create('u1', 's1', {});
    expect(prisma.analysisLibraryEntry.findUnique).toHaveBeenCalledWith({
      where: { sourceKey: 'yt:abc' },
      select: { id: true },
    });
    expect(prisma.sharedVideoPage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ libraryEntryId: 'lib1' }),
    });
  });

  it('a failed libraryEntryId lookup does not block creation', async () => {
    const { service, prisma } = build();
    prisma.analysisLibraryEntry.findUnique.mockRejectedValueOnce(
      new Error('db down'),
    );
    const v = await service.create('u1', 's1', {});
    expect(v.status).toBe('PENDING');
  });

  it('creates a PENDING snapshot and copies video + photo under its own prefix', async () => {
    const { service, prisma, blob } = build();
    const v = await service.create('u1', 's1', {});
    expect(prisma.sharedVideoPage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        sessionId: 's1',
        title: 'Кружка Steel 500',
      }),
    });
    expect(blob.copyBlob).toHaveBeenCalledWith(
      'sessions/s1/generated.mp4',
      expect.stringMatching(/^shared-videos\/.+\/video\.mp4$/),
      'video/mp4',
    );
    expect(blob.copyBlob).toHaveBeenCalledWith(
      'sessions/s1/product-image.jpg',
      expect.stringMatching(/^shared-videos\/.+\/photo\.jpg$/),
      'image/jpeg',
    );
    expect(v.status).toBe('PENDING');
  });
});

describe('SharedVideoService.withdraw', () => {
  it('удаляет строку и обе собственные копии в ЛЮБОМ статусе — только своей', async () => {
    const { service, prisma, blob } = build();
    prisma.sharedVideoPage.findFirst.mockResolvedValueOnce(null);
    await expect(service.withdraw('u1', 's1', 'nope')).rejects.toThrow(
      NotFoundException,
    );

    prisma.sharedVideoPage.findFirst.mockResolvedValueOnce(
      row({ status: 'REJECTED' }),
    );
    await service.withdraw('u1', 's1', 'sv1');
    expect(prisma.sharedVideoPage.delete).toHaveBeenCalledWith({
      where: { id: 'sv1' },
    });
    expect(blob.deleteMany).toHaveBeenCalledWith([
      'shared-videos/sv1/video.mp4',
      'shared-videos/sv1/photo.jpg',
    ]);
  });
});

describe('SharedVideoService — публичная сторона', () => {
  it('getPublic отдаёт только PUBLISHED и бампает viewCount', async () => {
    const { service, prisma } = build({ found: row({ status: 'PENDING' }) });
    await expect(service.getPublic('sv1')).rejects.toThrow(NotFoundException);

    prisma.sharedVideoPage.findUnique.mockResolvedValueOnce(
      row({ status: 'PUBLISHED' }),
    );
    const v = await service.getPublic('sv1');
    expect(v.title).toBe('t');
    expect(v).not.toHaveProperty('userId');
    expect(prisma.sharedVideoPage.update).toHaveBeenCalledWith({
      where: { id: 'sv1' },
      data: { viewCount: { increment: 1 } },
    });
  });

  it('getPublic не падает, если счётчик не удалось обновить', async () => {
    const { service, prisma } = build({ found: row({ status: 'PUBLISHED' }) });
    prisma.sharedVideoPage.update.mockRejectedValueOnce(new Error('db down'));
    await expect(service.getPublic('sv1')).resolves.toEqual(
      expect.objectContaining({ id: 'sv1' }),
    );
  });

  it('fork создаёт анонимную сессию и применяет разбор без гейта тарифа', async () => {
    const { service, prisma, sessions, library } = build({
      found: row({ status: 'PUBLISHED', libraryEntryId: 'lib1' }),
    });
    const r = await service.fork('sv1', { locale: 'en' });
    expect(sessions.createSession).toHaveBeenCalledWith(
      undefined,
      undefined,
      'en',
      'sv1',
    );
    expect(library.applyEntryToSessionFree).toHaveBeenCalledWith(
      'new-s',
      'lib1',
    );
    expect(r).toEqual({ sessionId: 'new-s' });
    expect(prisma.sharedVideoPage.findUnique).toHaveBeenCalled();
  });

  it('fork отдаёт сессию, даже если разбор недоступен (§21.3 приватность)', async () => {
    const { service, library } = build({
      found: row({ status: 'PUBLISHED', libraryEntryId: 'lib1' }),
    });
    library.applyEntryToSessionFree.mockRejectedValueOnce(
      new NotFoundException('private'),
    );
    const r = await service.fork('sv1', {});
    expect(r).toEqual({ sessionId: 'new-s' });
  });

  it('fork на неопубликованную/несуществующую страницу — 404', async () => {
    const { service } = build({ found: null });
    await expect(service.fork('sv1', {})).rejects.toThrow(NotFoundException);
  });
});

describe('SharedVideoService.markConverted', () => {
  it('no-op без id, best-effort при сбое', async () => {
    const { service, prisma } = build();
    await service.markConverted(undefined);
    expect(prisma.sharedVideoPage.update).not.toHaveBeenCalled();

    prisma.sharedVideoPage.update.mockRejectedValueOnce(new Error('gone'));
    await expect(service.markConverted('sv1')).resolves.toBeUndefined();
    expect(prisma.sharedVideoPage.update).toHaveBeenCalledWith({
      where: { id: 'sv1' },
      data: { firstGenerationCount: { increment: 1 } },
    });
  });
});

describe('SharedVideoService.create — этап 80, блокировка (TODO §III.9)', () => {
  it('заблокированный не может поставить страницу на модерацию', async () => {
    const { service, plans } = build();
    plans.assertUserNotBlocked.mockRejectedValueOnce(
      new ForbiddenException('заблокирован'),
    );
    await expect(service.create('u1', 's1', {})).rejects.toThrow(
      /заблокирован/,
    );
  });

  it('проверка блокировки идёт ПОСЛЕ проверки тарифа', async () => {
    const { service, plans } = build();
    plans.assertUser.mockRejectedValueOnce(new ForbiddenException('тариф'));
    await expect(service.create('u1', 's1', {})).rejects.toThrow(/тариф/);
    expect(plans.assertUserNotBlocked).not.toHaveBeenCalled();
  });
});

describe('SharedVideoService.listFeed — этап 80 (TODO §III.9)', () => {
  it('только PUBLISHED, новые сверху, курсор — id последней строки', async () => {
    const { service, prisma } = build({
      rows: [row({ id: 'a' }), row({ id: 'b' })],
    });
    const r = await service.listFeed({ cursor: null, pageSize: 20 });
    expect(prisma.sharedVideoPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PUBLISHED' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
    expect(r.items).toHaveLength(2);
    expect(r.nextCursor).toBeNull();
  });

  it('nextCursor — id последней строки страницы, когда есть ещё', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => row({ id: `p${i}` }));
    const { service, prisma } = build({ rows });
    const r = await service.listFeed({ cursor: null, pageSize: 2 });
    expect(r.items).toHaveLength(2);
    expect(r.nextCursor).toBe('p1');
    expect(prisma.sharedVideoPage.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ cursor: expect.anything() }),
    );

    await service.listFeed({ cursor: 'p1', pageSize: 2 });
    expect(prisma.sharedVideoPage.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: { id: 'p1' }, skip: 1 }),
    );
  });

  it('likedByViewer — только по лайкам ЭТОГО вошедшего, и только если есть identity', async () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })];
    const { service, prisma } = build({
      rows,
      likes: [{ sharedVideoPageId: 'a' }],
    });
    const anon = await service.listFeed({ cursor: null, pageSize: 20 });
    expect(prisma.sharedVideoLike.findMany).not.toHaveBeenCalled();
    expect(anon.items.every((i) => i.likedByViewer === false)).toBe(true);

    const identified = await service.listFeed({
      cursor: null,
      pageSize: 20,
      viewerUserId: 'u1',
    });
    expect(prisma.sharedVideoLike.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', sharedVideoPageId: { in: ['a', 'b'] } },
      select: { sharedVideoPageId: true },
    });
    expect(identified.items.find((i) => i.id === 'a')?.likedByViewer).toBe(
      true,
    );
    expect(identified.items.find((i) => i.id === 'b')?.likedByViewer).toBe(
      false,
    );
  });
});

describe('SharedVideoService.like/unlike — этап 80 (TODO §III.9)', () => {
  it('like — только PUBLISHED, создаёт лайк и бампает likeCount', async () => {
    const { service, prisma } = build({ found: row({ status: 'PENDING' }) });
    await expect(service.like('u1', 'sv1')).rejects.toThrow(NotFoundException);

    prisma.sharedVideoPage.findUnique.mockResolvedValue(
      row({ status: 'PUBLISHED', likeCount: 3 }),
    );
    const r = await service.like('u1', 'sv1');
    expect(prisma.sharedVideoLike.create).toHaveBeenCalledWith({
      data: { userId: 'u1', sharedVideoPageId: 'sv1' },
    });
    expect(prisma.sharedVideoPage.update).toHaveBeenCalledWith({
      where: { id: 'sv1' },
      data: { likeCount: { increment: 1 } },
    });
    expect(r).toEqual({ likeCount: 4, likedByViewer: true });
  });

  it('повторный like — идемпотентно (P2002), без второго инкремента', async () => {
    const { service, prisma } = build({
      found: row({ status: 'PUBLISHED', likeCount: 5 }),
    });
    prisma.sharedVideoLike.create.mockRejectedValueOnce({ code: 'P2002' });
    const r = await service.like('u1', 'sv1');
    expect(r).toEqual({ likeCount: 5, likedByViewer: true });
    expect(prisma.sharedVideoPage.update).not.toHaveBeenCalled();
  });

  it('неожиданная ошибка create — не глотается', async () => {
    const { service, prisma } = build({
      found: row({ status: 'PUBLISHED' }),
    });
    prisma.sharedVideoLike.create.mockRejectedValueOnce(new Error('db down'));
    await expect(service.like('u1', 'sv1')).rejects.toThrow('db down');
  });

  it('unlike — удаляет лайк и уменьшает likeCount, не ниже нуля', async () => {
    const { service, prisma } = build({
      found: row({ status: 'PUBLISHED', likeCount: 1 }),
    });
    const r = await service.unlike('u1', 'sv1');
    expect(prisma.sharedVideoLike.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', sharedVideoPageId: 'sv1' },
    });
    expect(prisma.sharedVideoPage.update).toHaveBeenCalledWith({
      where: { id: 'sv1' },
      data: { likeCount: { decrement: 1 } },
    });
    expect(r).toEqual({ likeCount: 0, likedByViewer: false });
  });

  it('unlike без предшествующего лайка — no-op, не ошибка', async () => {
    const { service, prisma } = build({
      found: row({ status: 'PUBLISHED', likeCount: 0 }),
    });
    prisma.sharedVideoLike.deleteMany.mockResolvedValueOnce({ count: 0 });
    const r = await service.unlike('u1', 'sv1');
    expect(prisma.sharedVideoPage.update).not.toHaveBeenCalled();
    expect(r).toEqual({ likeCount: 0, likedByViewer: false });
  });
});

describe('SharedVideoService.recordShare — этап 80 (TODO §III.9)', () => {
  it('бампает shareCount, best-effort при сбое', async () => {
    const { service, prisma } = build();
    await service.recordShare('sv1');
    expect(prisma.sharedVideoPage.update).toHaveBeenCalledWith({
      where: { id: 'sv1' },
      data: { shareCount: { increment: 1 } },
    });

    prisma.sharedVideoPage.update.mockRejectedValueOnce(new Error('gone'));
    await expect(service.recordShare('sv1')).resolves.toBeUndefined();
  });
});

describe('SharedVideoService — operator', () => {
  it('list filters by a known status only and reports the pending count', async () => {
    const { service, prisma } = build({ rows: [row()] });
    const r = await service.list({ status: 'bogus', page: 2, pageSize: 10 });
    expect(prisma.sharedVideoPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, skip: 10, take: 10 }),
    );
    expect(r.pending).toBe(1);
  });

  it('approve / reject only from PENDING, stamping the moderator; reject keeps the video copy', async () => {
    const { service, prisma, blob } = build();
    const a = await service.approve('sv1', 'op1');
    expect(prisma.sharedVideoPage.update).toHaveBeenCalledWith({
      where: { id: 'sv1' },
      data: expect.objectContaining({
        status: 'PUBLISHED',
        moderatorId: 'op1',
        rejectReason: null,
      }),
    });
    expect(a.status).toBe('PUBLISHED');

    const r = await service.reject('sv1', 'op1', {
      reason: 'логотип конкурента',
    });
    expect(r.status).toBe('REJECTED');
    // В отличие от PublicationService: withdraw доступен и после отказа,
    // поэтому reject копию не трогает.
    expect(blob.deleteMany).not.toHaveBeenCalled();

    prisma.sharedVideoPage.findUnique.mockResolvedValueOnce(
      row({ status: 'REJECTED' }),
    );
    await expect(service.approve('sv1', 'op1')).rejects.toThrow(/only PENDING/);
  });
});

/**
 * Витрина (этап 1 плана docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md,
 * §5 docs-tz/TZ-Greeting-Video-Landing.md).
 */
describe('SharedVideoService.listShowcase', () => {
  it('shows only curated published pages, never everything published', async () => {
    const { service, prisma } = build({ rows: [] });
    await service.listShowcase({ projectType: 'GREETING_VIDEO', pageSize: 9 });
    const where = prisma.sharedVideoPage.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('PUBLISHED');
    // Без этого условия витрина показывала бы ЛЮБОЕ опубликованное
    // поздравление, включая чужое личное — ровно то, что §5 ТЗ
    // лендинга запрещает.
    expect(where.showcasedAt).toEqual({ not: null });
    expect(where.projectType).toBe('GREETING_VIDEO');
  });

  it('omits empty filters instead of matching them literally', async () => {
    const { service, prisma } = build({ rows: [] });
    await service.listShowcase({
      projectType: null,
      occasion: null,
      pageSize: 9,
    });
    const where = prisma.sharedVideoPage.findMany.mock.calls[0][0].where;
    expect('projectType' in where).toBe(false);
    expect('occasion' in where).toBe(false);
  });

  it('paginates by cursor and reports the next one only when there is more', async () => {
    const many = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const { service } = build({ rows: many });
    const res = await service.listShowcase({ pageSize: 2 });
    expect(res.items).toHaveLength(2);
    expect(res.nextCursor).toBe('b');

    const short = build({ rows: [row({ id: 'a' })] });
    expect((await short.service.listShowcase({ pageSize: 2 })).nextCursor).toBe(
      null,
    );
  });
});

describe('SharedVideoService.setShowcase', () => {
  it('adds only a published page to the showcase', async () => {
    const { service, prisma } = build({ found: row({ status: 'PUBLISHED' }) });
    const view = await service.setShowcase('sv1', true);
    expect(prisma.sharedVideoPage.update.mock.calls[0][0].data.showcasedAt).toBeInstanceOf(
      Date,
    );
    expect(view.featured).toBe(true);
  });

  it('refuses to showcase a page that is not published', async () => {
    const { service } = build({ found: row({ status: 'PENDING' }) });
    await expect(service.setShowcase('sv1', true)).rejects.toThrow(
      ConflictException,
    );
  });

  /**
   * Снятие разрешено в любом статусе: запрет означал бы, что
   * отклонённую страницу нельзя убрать с витрины.
   */
  it('allows removal from the showcase in any status', async () => {
    const { service, prisma } = build({ found: row({ status: 'REJECTED' }) });
    await service.setShowcase('sv1', false);
    expect(prisma.sharedVideoPage.update.mock.calls[0][0].data.showcasedAt).toBeNull();
  });

  it('404 on an unknown page', async () => {
    const { service } = build({ found: null });
    await expect(service.setShowcase('nope', true)).rejects.toThrow(
      NotFoundException,
    );
  });
});
