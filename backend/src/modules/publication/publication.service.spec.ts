import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  PublicationService,
  snapshotFromSession,
  toView,
  uniqueTags,
} from './publication.service';
import type { Session } from '../../common/types/session.types';

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

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

const session = {
  sessionId: 's1',
  projectId: 'p1',
  productItemId: 'i1',
  productInformation: {
    productName: 'Кружка Steel 500',
    productDescription: 'Стальная термокружка',
    category: 'термокружки',
    addedAt: new Date(),
  },
  generatedVideo: {
    generatedVideoId: 'v1',
    pathname: 'sessions/s1/generated.mp4',
    status: 'complete',
    downloadUrl: 'https://blob.test/sessions/s1/generated.mp4',
  },
} as unknown as Session;

const now = new Date('2026-09-05T21:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 'pr1',
  userId: 'u1',
  sessionId: 's1',
  generatedVideoId: 'v1',
  projectId: 'p1',
  productItemId: 'i1',
  platform: 'YOUTUBE',
  status: 'PENDING',
  videoUrl: 'https://blob.test/v.mp4',
  videoPathname: 'sessions/s1/generated.mp4',
  title: 't',
  description: 'd',
  tags: ['a'],
  category: 'c',
  moderatorId: null,
  moderatedAt: null,
  rejectReason: null,
  externalUrl: null,
  externalId: null,
  publishError: null,
  publishedAt: null,
  channelId: null,
  privacy: 'PRIVATE',
  attempts: 0,
  createdAt: now,
  updatedAt: now,
  ...over,
});

describe('snapshotFromSession', () => {
  it('copies video + product, defaults title/description, adds category and product name to tags', () => {
    const snap = snapshotFromSession(session, {
      platform: 'YOUTUBE',
      tags: ['#running', 'Running'],
    });
    expect(snap).toEqual({
      videoUrl: 'https://blob.test/sessions/s1/generated.mp4',
      videoPathname: 'sessions/s1/generated.mp4',
      generatedVideoId: 'v1',
      title: 'Кружка Steel 500',
      description: 'Стальная термокружка',
      tags: ['running', 'термокружки', 'Кружка Steel 500'],
      category: 'термокружки',
    });
  });

  it('client title/description win; refuses without a completed video or any title', () => {
    const snap = snapshotFromSession(session, {
      platform: 'TIKTOK',
      title: ' Мой заголовок ',
      description: 'своё',
    });
    expect(snap.title).toBe('Мой заголовок');
    expect(snap.description).toBe('своё');
    expect(() =>
      snapshotFromSession(
        {
          ...session,
          generatedVideo: { ...session.generatedVideo!, status: 'processing' },
        } as never,
        { platform: 'YOUTUBE' },
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      snapshotFromSession(
        { ...session, productInformation: undefined } as never,
        { platform: 'YOUTUBE' },
      ),
    ).toThrow(/title is required/);
  });
});

describe('snapshotFromSession — семейство кадра под площадку (этап 75, §6)', () => {
  const sessionWithVariant = (over: Record<string, unknown> = {}) =>
    ({
      ...session,
      generatedVideo: {
        ...session.generatedVideo,
        renderedAspectRatio: '9:16',
        ...over,
      },
    }) as unknown as Session;

  it('заявка на площадку того же семейства, что уже отрендерено — берёт основной файл как раньше', () => {
    // TikTok хочет 9:16 — ролик уже 9:16, вариант из exportVariants не нужен.
    const snap = snapshotFromSession(sessionWithVariant(), {
      platform: 'TIKTOK',
    });
    expect(snap.videoUrl).toBe('https://blob.test/sessions/s1/generated.mp4');
  });

  it('другое семейство и готовый подходящий вариант есть — публикация берёт его, а не основной файл', () => {
    // YouTube хочет 16:9, ролик отрендерен в 9:16 — раньше портретный
    // файл ушёл бы на YouTube как есть; теперь берём готовый 16:9-вариант.
    const snap = snapshotFromSession(
      sessionWithVariant({
        exportVariants: [
          {
            format: '16:9',
            tier: 'B',
            status: 'complete',
            url: 'https://blob.test/sessions/s1/export-16x9.mp4',
            pathname: 'sessions/s1/export-16x9.mp4',
            requestedAt: 'x',
          },
        ],
      }),
      { platform: 'YOUTUBE' },
    );
    expect(snap.videoUrl).toBe('https://blob.test/sessions/s1/export-16x9.mp4');
    expect(snap.videoPathname).toBe('sessions/s1/export-16x9.mp4');
  });

  it('другое семейство, но подходящего готового варианта нет — прежнее поведение (что лежит, то и уходит)', () => {
    const snap = snapshotFromSession(sessionWithVariant(), {
      platform: 'YOUTUBE',
    });
    expect(snap.videoUrl).toBe('https://blob.test/sessions/s1/generated.mp4');
  });

  it('подходящий вариант есть, но ещё не завершён (pending) — не используется', () => {
    const snap = snapshotFromSession(
      sessionWithVariant({
        exportVariants: [
          {
            format: '16:9',
            tier: 'B',
            status: 'pending',
            requestedAt: 'x',
            childSessionId: 'child-1',
          },
        ],
      }),
      { platform: 'YOUTUBE' },
    );
    expect(snap.videoUrl).toBe('https://blob.test/sessions/s1/generated.mp4');
  });

  it('вариант того же семейства, что уже отрендерено, не подходит под запрос другого семейства', () => {
    // Единственный готовый вариант — 3:4 (семейство 9:16), а нужен 16:9.
    const snap = snapshotFromSession(
      sessionWithVariant({
        exportVariants: [
          {
            format: '3:4',
            tier: 'A',
            status: 'complete',
            url: 'https://blob.test/sessions/s1/export-3x4.mp4',
            pathname: 'sessions/s1/export-3x4.mp4',
            requestedAt: 'x',
          },
        ],
      }),
      { platform: 'YOUTUBE' },
    );
    expect(snap.videoUrl).toBe('https://blob.test/sessions/s1/generated.mp4');
  });
});

describe('uniqueTags', () => {
  it('trims, strips #, dedupes case-insensitively, caps at 30', () => {
    expect(uniqueTags([' #Shoes ', 'shoes', '', 'run'])).toEqual([
      'Shoes',
      'run',
    ]);
    expect(
      uniqueTags(Array.from({ length: 40 }, (_, i) => `t${i}`)),
    ).toHaveLength(30);
  });
});

describe('toView', () => {
  it('serialises dates and keeps nulls', () => {
    const v = toView(row({ moderatedAt: now }) as never);
    expect(v.createdAt).toBe('2026-09-05T21:00:00.000Z');
    expect(v.moderatedAt).toBe('2026-09-05T21:00:00.000Z');
    expect(v.publishedAt).toBeNull();
    expect(v).not.toHaveProperty('videoPathname');
  });
});

function build(
  opts: {
    session?: Session | undefined;
    ownerId?: string | null;
    open?: unknown;
    rows?: unknown[];
    found?: unknown;
    project?: unknown;
    brandManifest?: unknown;
    channel?: unknown;
    channels?: unknown[];
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
    publicationRequest: {
      findFirst: jest.fn().mockResolvedValue(opts.open ?? null),
      // Копия ролика (§22, этап 39) делается ПОСЛЕ создания и обновляет
      // ту же строку — мок обязан помнить созданное, иначе `update`
      // вернёт строку по умолчанию и проверки поедут не по делу.
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
            lastRow = row({ ...(lastRow ?? {}), ...data });
            return lastRow;
          },
        ),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    // Этап 61 (§14.2): разрешение канала при approve() — по умолчанию
    // ни у проекта, ни у бренда нет назначенного канала, и у автора нет
    // ни одного подключённого — значит channelId останется null.
    project: {
      findUnique: jest.fn().mockResolvedValue(
        'project' in opts
          ? opts.project
          : {
              youtubeChannelId: null,
              tiktokChannelId: null,
              brandManifestId: null,
            },
      ),
    },
    brandManifest: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          'brandManifest' in opts
            ? opts.brandManifest
            : { youtubeChannelId: null, tiktokChannelId: null },
        ),
    },
    publishingChannel: {
      findUnique: jest
        .fn()
        .mockResolvedValue('channel' in opts ? opts.channel : null),
      findMany: jest.fn().mockResolvedValue(opts.channels ?? []),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    // Транзакция здесь не декорация: проверка «нет открытой заявки» и
    // создание должны идти под одной блокировкой (этап 38, А-1.4).
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const sessions = {
    getSession: jest
      .fn()
      .mockResolvedValue('session' in opts ? opts.session : session),
  };
  // §22 (этап 39): у заявки своя копия ролика — она переживает сессию.
  const blob = {
    copyBlob: jest
      .fn()
      .mockResolvedValue('https://blob.test/publications/pr1/video.mp4'),
    deleteMany: jest.fn().mockResolvedValue(1),
  };
  return {
    service: new PublicationService(
      prisma as never,
      sessions as never,
      plansMock() as never,
      blob as never,
    ),
    prisma,
    blob,
  };
}

describe('PublicationService.create', () => {
  it('rejects anonymous and foreign sessions, missing sessions', async () => {
    await expect(
      build({ session: undefined }).service.create('u1', 's0', {
        platform: 'YOUTUBE',
      }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      build({ ownerId: null }).service.create('u1', 's1', {
        platform: 'YOUTUBE',
      }),
    ).rejects.toThrow(/signed-in owner/);
    await expect(
      build({ ownerId: 'u2' }).service.create('u1', 's1', {
        platform: 'YOUTUBE',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('409 when an open request for the same session+platform exists', async () => {
    const { service } = build({ open: { id: 'x', status: 'APPROVED' } });
    await expect(
      service.create('u1', 's1', { platform: 'YOUTUBE' }),
    ).rejects.toThrow(ConflictException);
  });

  it('проверка и создание идут в одной транзакции под блокировкой', async () => {
    // Двойной клик по «Опубликовать» давал две карточки в очереди
    // оператора, а с §14 дал бы две выгрузки на площадку: между
    // findFirst и create успевал вклиниться второй запрос.
    const { service, prisma } = build();
    await service.create('u1', 's1', { platform: 'TIKTOK' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [chunks, key] = prisma.$executeRaw.mock.calls[0] as [
      string[],
      string,
    ];
    expect(chunks.join('?')).toContain('pg_advisory_xact_lock');
    // Ключ различает площадки: одна сессия может ждать и YouTube, и TikTok.
    expect(key).toBe('publication:s1:TIKTOK');
  });

  it('блокировка снимается коммитом — сессионная утекла бы за пулером', async () => {
    // PgBouncer в режиме транзакций возвращает соединение в пул сразу
    // после коммита; сессионная блокировка досталась бы чужому запросу.
    const { service, prisma } = build();
    await service.create('u1', 's1', { platform: 'YOUTUBE' });
    const sql = (prisma.$executeRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain('_xact_');
  });

  it('creates a PENDING snapshot with the session’s project/item ids', async () => {
    const { service, prisma } = build();
    const v = await service.create('u1', 's1', { platform: 'TIKTOK' });
    expect(prisma.publicationRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        sessionId: 's1',
        projectId: 'p1',
        productItemId: 'i1',
        platform: 'TIKTOK',
        videoUrl: 'https://blob.test/sessions/s1/generated.mp4',
        title: 'Кружка Steel 500',
        category: 'термокружки',
      }),
    });
    expect(v.status).toBe('PENDING');
    expect(v.platform).toBe('TIKTOK');
  });
});

describe('PublicationService — своя копия ролика (этап 39, А-2.6)', () => {
  it('заявка получает копию под собственным префиксом', async () => {
    // TTL сессии — сутки. Без копии оператор в понедельник открывает
    // пятничную заявку с битой ссылкой.
    const { service, blob, prisma } = build();
    const v = await service.create('u1', 's1', { platform: 'TIKTOK' });
    expect(blob.copyBlob).toHaveBeenCalledWith(
      'sessions/s1/generated.mp4',
      expect.stringMatching(/^publications\/.+\/video\.mp4$/),
      'video/mp4',
    );
    expect(prisma.publicationRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          videoUrl: 'https://blob.test/publications/pr1/video.mp4',
        }),
      }),
    );
    expect(v.videoUrl).toBe('https://blob.test/publications/pr1/video.mp4');
  });

  it('сбой копирования не отменяет заявку', async () => {
    // Прежнее поведение (ссылка на файл сессии) хуже нового, но лучше,
    // чем отказ поставить ролик в очередь.
    const { service, blob } = build();
    blob.copyBlob.mockResolvedValue(null);
    const v = await service.create('u1', 's1', { platform: 'TIKTOK' });
    expect(v.videoUrl).toBe('https://blob.test/sessions/s1/generated.mp4');
  });

  it('отзыв заявки уносит её копию', async () => {
    const { service, blob, prisma } = build();
    prisma.publicationRequest.findFirst.mockResolvedValueOnce(row());
    await service.withdraw('u1', 's1', 'pr1');
    expect(blob.deleteMany).toHaveBeenCalledWith([
      'publications/pr1/video.mp4',
    ]);
  });
});

describe('PublicationService.withdraw', () => {
  it('only PENDING and only own', async () => {
    const { service, prisma } = build({ found: null });
    prisma.publicationRequest.findFirst.mockResolvedValueOnce(null);
    await expect(service.withdraw('u1', 's1', 'nope')).rejects.toThrow(
      NotFoundException,
    );
    prisma.publicationRequest.findFirst.mockResolvedValueOnce(
      row({ status: 'APPROVED' }),
    );
    await expect(service.withdraw('u1', 's1', 'pr1')).rejects.toThrow(
      /Only PENDING/,
    );
    prisma.publicationRequest.findFirst.mockResolvedValueOnce(row());
    await service.withdraw('u1', 's1', 'pr1');
    expect(prisma.publicationRequest.delete).toHaveBeenCalledWith({
      where: { id: 'pr1' },
    });
  });
});

describe('PublicationService — operator', () => {
  it('list filters by a known status only and reports the pending count', async () => {
    const { service, prisma } = build({ rows: [row()] });
    const r = await service.list({ status: 'bogus', page: 2, pageSize: 10 });
    expect(prisma.publicationRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, skip: 10, take: 10 }),
    );
    expect(r.pending).toBe(1);
    await service.list({ status: 'REJECTED', page: 1, pageSize: 20 });
    expect(prisma.publicationRequest.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { status: 'REJECTED' } }),
    );
  });

  it('approve / reject only from PENDING, stamping the moderator', async () => {
    const { service, prisma } = build();
    const a = await service.approve('pr1', 'op1');
    expect(prisma.publicationRequest.update).toHaveBeenCalledWith({
      where: { id: 'pr1' },
      data: expect.objectContaining({
        status: 'APPROVED',
        moderatorId: 'op1',
        rejectReason: null,
      }),
    });
    expect(a.status).toBe('APPROVED');

    const r = await service.reject('pr1', 'op1', {
      reason: '  логотип конкурента в кадре ',
    });
    expect(prisma.publicationRequest.update).toHaveBeenLastCalledWith({
      where: { id: 'pr1' },
      data: expect.objectContaining({
        status: 'REJECTED',
        rejectReason: 'логотип конкурента в кадре',
      }),
    });
    expect(r.status).toBe('REJECTED');

    prisma.publicationRequest.findUnique.mockResolvedValueOnce(
      row({ status: 'REJECTED' }),
    );
    await expect(service.approve('pr1', 'op1')).rejects.toThrow(/only PENDING/);
    prisma.publicationRequest.findUnique.mockResolvedValueOnce(null);
    await expect(service.get('zz')).rejects.toThrow(NotFoundException);
  });
});

/**
 * Разрешение канала при approve() (§14.2, этап 61): явный channelId →
 * канал проекта → канал бренд-манифеста → единственный канал автора →
 * null («канал не подключён», не ошибка).
 */
describe('PublicationService.approve — разрешение канала (§14.2)', () => {
  it('явный channelId используется как есть, если канал принадлежит автору и платформе', async () => {
    const { service, prisma } = build({
      channel: { id: 'ch1', userId: 'u1', platform: 'YOUTUBE' },
    });
    const a = await service.approve('pr1', 'op1', { channelId: 'ch1' });
    expect(a.channelId).toBe('ch1');
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
  });

  it('отклоняет явный channelId чужого владельца', async () => {
    const { service } = build({
      channel: { id: 'ch1', userId: 'someone-else', platform: 'YOUTUBE' },
    });
    await expect(
      service.approve('pr1', 'op1', { channelId: 'ch1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('отклоняет явный channelId другой платформы', async () => {
    const { service } = build({
      channel: { id: 'ch1', userId: 'u1', platform: 'TIKTOK' },
    });
    await expect(
      service.approve('pr1', 'op1', { channelId: 'ch1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('без явного channelId берёт канал проекта по умолчанию', async () => {
    const { service, prisma } = build({
      project: {
        youtubeChannelId: 'proj-ch',
        tiktokChannelId: null,
        brandManifestId: 'bm1',
      },
    });
    const a = await service.approve('pr1', 'op1');
    expect(a.channelId).toBe('proj-ch');
    expect(prisma.brandManifest.findUnique).not.toHaveBeenCalled();
  });

  it('без канала у проекта берёт канал бренд-манифеста проекта', async () => {
    const { service } = build({
      project: {
        youtubeChannelId: null,
        tiktokChannelId: null,
        brandManifestId: 'bm1',
      },
      brandManifest: { youtubeChannelId: 'manifest-ch', tiktokChannelId: null },
    });
    const a = await service.approve('pr1', 'op1');
    expect(a.channelId).toBe('manifest-ch');
  });

  it('без канала у проекта/бренда берёт единственный активный канал автора', async () => {
    const { service } = build({ channels: [{ id: 'solo-ch' }] });
    const a = await service.approve('pr1', 'op1');
    expect(a.channelId).toBe('solo-ch');
  });

  it('несколько каналов автора без назначенного по умолчанию — channelId остаётся null', async () => {
    const { service } = build({ channels: [{ id: 'ch1' }, { id: 'ch2' }] });
    const a = await service.approve('pr1', 'op1');
    expect(a.channelId).toBeNull();
  });

  it('privacy по умолчанию наследуется от заявки, явный privacy переопределяет', async () => {
    const { service: s1 } = build();
    const a = await s1.approve('pr1', 'op1');
    expect(a.privacy).toBe('PRIVATE');

    const { service: s2 } = build();
    const b = await s2.approve('pr1', 'op1', { privacy: 'UNLISTED' });
    expect(b.privacy).toBe('UNLISTED');
  });
});

describe('PublicationService.retry — FAILED → APPROVED (§14.5)', () => {
  it('сбрасывает backoff и возвращает заявку в очередь воркера', async () => {
    const { service, prisma } = build({
      found: row({
        status: 'FAILED',
        attempts: 4,
        publishError: 'quota exceeded',
      }),
    });
    const r = await service.retry('pr1');
    expect(r.status).toBe('APPROVED');
    expect(r.attempts).toBe(0);
    expect(prisma.publicationRequest.update).toHaveBeenCalledWith({
      where: { id: 'pr1' },
      data: {
        status: 'APPROVED',
        attempts: 0,
        nextAttemptAt: null,
        publishError: null,
        uploadJobId: null,
      },
    });
  });

  it('отказывает вне FAILED', async () => {
    const { service } = build({ found: row({ status: 'APPROVED' }) });
    await expect(service.retry('pr1')).rejects.toThrow(/only FAILED/);
  });
});

/**
 * Б-1.2: копия ролика заявки не удалялась никогда, кроме отзыва PENDING.
 *
 * Отклонённые, опубликованные и провалившиеся заявки держали самый
 * тяжёлый файл сервиса вечно, а маршрута, которым его можно было бы
 * убрать, не существовало вовсе.
 */
describe('PublicationService — копия ролика после отказа (Б-1.2)', () => {
  it('отказ оператора уносит собственную копию ролика', async () => {
    const { service, prisma, blob } = build();
    prisma.publicationRequest.findUnique.mockResolvedValue(
      row({ videoPathname: 'publications/pr1/video.mp4' }),
    );

    await service.reject('pr1', 'op1', { reason: 'логотип конкурента' });

    expect(blob.deleteMany).toHaveBeenCalledWith([
      'publications/pr1/video.mp4',
    ]);
  });

  it('строка заявки остаётся: автор должен увидеть причину', async () => {
    const { service, prisma } = build();
    prisma.publicationRequest.findUnique.mockResolvedValue(
      row({ videoPathname: 'publications/pr1/video.mp4' }),
    );

    const r = await service.reject('pr1', 'op1', { reason: 'причина' });

    expect(prisma.publicationRequest.delete).not.toHaveBeenCalled();
    expect(r.status).toBe('REJECTED');
    expect(r.rejectReason).toBe('причина');
  });

  it('старая заявка, указывающая на файл сессии, его не трогает', async () => {
    // До этапа 39 заявка ссылалась на файл, владелец которого — сессия.
    // Удалить его здесь значило бы отнять у пользователя готовый ролик.
    const { service, prisma, blob } = build();
    prisma.publicationRequest.findUnique.mockResolvedValue(
      row({ videoPathname: 'sessions/s1/generated.mp4' }),
    );

    await service.reject('pr1', 'op1', { reason: 'причина' });

    expect(blob.deleteMany).not.toHaveBeenCalled();
  });

  it('отказ хранилища не отменяет решение оператора', async () => {
    // Решение уже записано; недобитый файл подберёт метла.
    const { service, prisma, blob } = build();
    prisma.publicationRequest.findUnique.mockResolvedValue(
      row({ videoPathname: 'publications/pr1/video.mp4' }),
    );
    blob.deleteMany.mockRejectedValue(new Error('Blob недоступен'));

    const r = await service.reject('pr1', 'op1', { reason: 'причина' });

    expect(r.status).toBe('REJECTED');
  });
});
