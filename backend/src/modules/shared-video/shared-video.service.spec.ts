import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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
  libraryEntryId: null,
  moderatorId: null,
  moderatedAt: null,
  rejectReason: null,
  viewCount: 0,
  firstGenerationCount: 0,
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

describe('toView / toPublicView', () => {
  it('serialises dates, keeps nulls; public view hides internal ids', () => {
    const v = toView(row({ moderatedAt: now }) as never);
    expect(v.createdAt).toBe('2026-09-08T12:00:00.000Z');
    expect(v.moderatedAt).toBe('2026-09-08T12:00:00.000Z');
    expect(v.userId).toBe('u1');

    const pub = toPublicView(row() as never);
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
  return {
    service: new SharedVideoService(
      prisma as never,
      sessions as never,
      plansMock() as never,
      library as never,
      blob as never,
    ),
    prisma,
    sessions,
    blob,
    library,
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
