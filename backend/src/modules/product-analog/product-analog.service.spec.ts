/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * ProductAnalogService — orchestration of the photo flow with every
 * external dependency mocked: Blob (head/download), SerpApi, Gemini,
 * usage counter, Prisma. Verifies the ORDER and the decisions in
 * doc/PRODUCT-PROJECT-SPEC.md §7.5 (cache before paying; count only
 * billed calls; 429 at the cap) and §7.4 (failures degrade, don't block).
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
}));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));

import { head } from '@vercel/blob';
import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import {
  ProductAnalogService,
  analogRowsFromMatches,
  hashPhoto,
  photoPathname,
} from './product-analog.service';
import {
  parseAudienceBlock,
  parseRecognition,
} from './product-recognition.service';
import { utcDay } from './serpapi-usage.service';

/** Учёт расходов (ТЗ §26) — в тестах он ничего не должен делать. */
/** Блокировка (ТЗ §25.3) — по умолчанию пользователь не заблокирован. */
const accessMock = () => ({
  // §26.4: дневной лимит по умолчанию не выбран.
  assertCanSpendUser: jest.fn(),
  assertCanSpendSession: jest.fn(),
  accessOf: jest.fn().mockResolvedValue({
    plan: 'PREMIUM',
    isBlocked: false,
    blockedReason: null,
  }),
  assertNotBlocked: jest.fn(),
  assertUserNotBlocked: jest.fn(),
  assertSessionNotBlocked: jest.fn(),
  assertUser: jest.fn(),
  assertSession: jest.fn(),
  planOfUser: jest.fn().mockResolvedValue('PREMIUM'),
  planOfSession: jest.fn().mockResolvedValue('PREMIUM'),
});

const usageMock = () => ({
  record: jest.fn(),
  recordGemini: jest.fn(),
  recordOpenAi: jest.fn(),
});

const mockedHead = head as jest.MockedFunction<typeof head>;
const USER = 'u1';
const NOW = new Date('2026-09-05T12:00:00.000Z');
const PHOTO = Buffer.from('fake-jpeg-bytes');

const ownedItem = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  projectId: 'p1',
  title: null,
  photoHash: null,
  project: { userId: USER, countryCode: 'UA' },
  ...over,
});

const updatedRow = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  projectId: 'p1',
  title: null,
  photoUrl: 'https://blob/x.jpg',
  description: null,
  category: 'кроссовки',
  price: null,
  priceSource: 'MANUAL' as const,
  createdAt: NOW,
  updatedAt: NOW,
  analogs: [],
  ...over,
});

function build() {
  const tx = {
    productAnalog: { deleteMany: jest.fn(), createMany: jest.fn() },
    productItem: { update: jest.fn().mockResolvedValue(updatedRow()) },
    project: { update: jest.fn() },
  };
  const prisma = {
    productItem: { findFirst: jest.fn() },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const blob = {
    createUploadUrl: jest.fn().mockResolvedValue({ uploadUrl: 'https://put' }),
    downloadBuffer: jest.fn().mockResolvedValue(PHOTO),
  };
  const lens = {
    visualMatches: jest.fn().mockResolvedValue({
      matches: [
        {
          position: 1,
          title: 'A',
          url: 'https://a',
          source: null,
          priceValue: '₴10',
          priceNumber: 10,
          currency: '₴',
          image: null,
          thumbnail: 'https://t/a',
        },
      ],
      billed: true,
    }),
  };
  const recognition = {
    recognize: jest.fn().mockResolvedValue({
      category: 'кроссовки',
      title: 'Nike Pegasus',
      audience: null,
    }),
  };
  const usage = {
    // Б-1.9: слот квоты занимается АТОМАРНО до платного вызова и
    // возвращается, если счёта не было.
    reserve: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(undefined),
    canSearch: jest.fn().mockResolvedValue(true),
    recordSearch: jest.fn(),
    status: jest.fn().mockResolvedValue({ used: 50, limit: 50, remaining: 0 }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new ProductAnalogService(
    prisma as any,
    blob as any,
    lens as any,
    recognition as any,
    usage as any,
    usageMock() as any,
    accessMock() as any,
  );
  return { svc, prisma, tx, blob, lens, recognition, usage };
}

beforeEach(() => {
  mockedHead.mockReset();
  mockedHead.mockResolvedValue({
    url: 'https://blob/x.jpg',
    contentType: 'image/jpeg',
  } as never);
});

describe('helpers', () => {
  it('photoPathname is per-item and normalises jpeg→jpg', () => {
    expect(photoPathname('p1', 'i1', 'image/jpeg')).toBe(
      'projects/p1/items/i1/photo.jpg',
    );
    expect(photoPathname('p1', 'i1', 'image/webp')).toBe(
      'projects/p1/items/i1/photo.webp',
    );
  });
  it('hashPhoto is sha256 hex, stable for identical bytes', () => {
    expect(hashPhoto(PHOTO)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPhoto(Buffer.from('fake-jpeg-bytes'))).toBe(hashPhoto(PHOTO));
    expect(hashPhoto(Buffer.from('other'))).not.toBe(hashPhoto(PHOTO));
  });
  it('analogRowsFromMatches uses SerpApi position as relevanceRank and thumbnail→image fallback', () => {
    const rows = analogRowsFromMatches([
      {
        position: 7,
        title: 'T',
        url: 'https://u',
        source: null,
        priceValue: null,
        priceNumber: null,
        currency: null,
        image: 'https://img',
        thumbnail: null,
      },
    ]);
    expect(rows[0]).toEqual({
      title: 'T',
      sourceUrl: 'https://u',
      price: null,
      currency: null,
      thumbnailUrl: 'https://img',
      relevanceRank: 7,
    });
  });
  it('utcDay keys the counter by UTC date', () => {
    expect(utcDay(new Date('2026-09-05T23:59:59Z'))).toBe('2026-09-05');
    expect(utcDay(new Date('2026-09-06T00:00:01Z'))).toBe('2026-09-06');
  });
});

describe('parseRecognition (SilverFinance recognize.ts parse pattern)', () => {
  it('parses clean JSON', () => {
    expect(parseRecognition('{"title":"Nike","category":"кроссовки"}')).toEqual(
      { title: 'Nike', category: 'кроссовки', audience: null },
    );
  });
  it('strips ```json fences and surrounding prose', () => {
    expect(
      parseRecognition(
        'Вот ответ:\n```json\n{"title":" X ","category":"обувь"}\n```\nГотово',
      ),
    ).toEqual({ title: 'X', category: 'обувь', audience: null });
  });
  it('non-JSON → nulls with reason, never throws', () => {
    const r = parseRecognition('I cannot tell');
    expect(r.category).toBeNull();
    expect(r.reason).toMatch(/non-JSON/);
  });
  it('empty/garbage fields become null; long values are clipped', () => {
    expect(parseRecognition('{"title":"","category":42}')).toEqual({
      title: null,
      category: null,
      audience: null,
    });
    expect(
      parseRecognition(`{"category":"${'x'.repeat(100)}"}`).category,
    ).toHaveLength(60);
  });
});

describe('parseAudienceBlock — target audience from the product photo (§18)', () => {
  it('normalises gender words in two languages, trims tags, stamps source gemini', () => {
    expect(
      parseAudienceBlock({
        ageRange: '25-34',
        gender: 'Женщины',
        interests: [' бег ', 'ЗОЖ', ''],
        summary: 'Бегуньи-любительницы',
      }),
    ).toEqual({
      ageRange: '25-34',
      gender: 'women',
      interests: ['бег', 'ЗОЖ'],
      summary: 'Бегуньи-любительницы',
      source: 'gemini',
    });
    expect(parseAudienceBlock({ gender: 'male' })?.gender).toBe('men');
    expect(parseAudienceBlock({ gender: 'любой' })?.gender).toBe('any');
  });
  it('null for nothing usable', () => {
    expect(parseAudienceBlock(undefined)).toBeNull();
    expect(parseAudienceBlock({ gender: 'robots' })).toBeNull();
  });
  it('rides in parseRecognition', () => {
    expect(
      parseRecognition(
        '{"title":"Nike","category":"кроссовки","audience":{"ageRange":"18-24","gender":"any","interests":["бег"],"summary":"s"}}',
      ).audience,
    ).toMatchObject({ ageRange: '18-24', gender: 'any' });
  });
});

describe('createPhotoUploadUrl', () => {
  it('404 when the item is not the caller’s', async () => {
    const { svc, prisma } = build();
    prisma.productItem.findFirst.mockResolvedValue(null);
    await expect(
      svc.createPhotoUploadUrl(USER, 'p1', 'i1', {
        fileName: 'a.jpg',
        fileSize: 10,
        mimeType: 'image/jpeg',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it('issues a presigned URL under the item’s own pathname', async () => {
    const { svc, prisma, blob } = build();
    prisma.productItem.findFirst.mockResolvedValue(ownedItem());
    const r = await svc.createPhotoUploadUrl(USER, 'p1', 'i1', {
      fileName: 'a.jpg',
      fileSize: 10,
      mimeType: 'image/jpeg',
    });
    expect(r).toEqual({
      uploadUrl: 'https://put',
      pathname: 'projects/p1/items/i1/photo.jpg',
    });
    expect(blob.createUploadUrl).toHaveBeenCalledWith(
      'projects/p1/items/i1/photo.jpg',
      'image/jpeg',
      10 * 1024 * 1024,
    );
  });
});

describe('processPhoto', () => {
  const dto = { pathname: 'projects/p1/items/i1/photo.jpg' };

  it('refuses a pathname belonging to another item', async () => {
    const { svc, prisma } = build();
    prisma.productItem.findFirst.mockResolvedValue(ownedItem());
    await expect(
      svc.processPhoto(USER, 'p1', 'i1', {
        pathname: 'projects/p1/items/OTHER/photo.jpg',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 when nothing was PUT to Blob yet', async () => {
    const { svc, prisma } = build();
    prisma.productItem.findFirst.mockResolvedValue(ownedItem());
    mockedHead.mockRejectedValue(
      new Error('Vercel Blob: The requested blob does not exist'),
    );
    await expect(svc.processPhoto(USER, 'p1', 'i1', dto)).rejects.toThrow(
      /upload it first/,
    );
  });

  it('happy path: hash → no cache → limit ok → lens (billed → counted) → gemini → persist', async () => {
    const { svc, prisma, tx, lens, recognition, usage } = build();
    prisma.productItem.findFirst
      .mockResolvedValueOnce(ownedItem()) // ownership
      .mockResolvedValueOnce(null); // cache miss
    tx.productItem.update.mockResolvedValue(
      updatedRow({
        title: 'Nike Pegasus',
        analogs: [
          {
            id: 'a1',
            title: 'A',
            sourceUrl: 'https://a',
            price: { toString: () => '10' },
            currency: '₴',
            thumbnailUrl: 'https://t/a',
            relevanceRank: 1,
          },
        ],
      }),
    );

    const r = await svc.processPhoto(USER, 'p1', 'i1', dto);

    // cache lookup is scoped to the user and requires saved analogs; также
    // фильтрует deletedAt: null (этап 89, найдено доп. аудитом) — мягко
    // удалённый товар/проект не должен отдавать закешированные аналоги.
    expect(prisma.productItem.findFirst.mock.calls[1][0].where).toEqual({
      photoHash: hashPhoto(PHOTO),
      deletedAt: null,
      project: { userId: USER, deletedAt: null },
      analogs: { some: {} },
    });
    // lens is localised to the project's market (UA → hl uk)
    expect(lens.visualMatches).toHaveBeenCalledWith('https://blob/x.jpg', {
      countryCode: 'UA',
      language: 'uk',
    });
    // Слот занят один раз и не возвращён: счёт от провайдера был.
    expect(usage.reserve).toHaveBeenCalledTimes(1);
    expect(usage.reserve).toHaveBeenCalledWith(USER);
    expect(usage.release).not.toHaveBeenCalled();
    // Владелец расхода уходит вместе с фото (ТЗ §26); локаль (этап 59) —
    // из dto, здесь его не передавали, значит undefined (== DEFAULT_LOCALE
    // внутри самого ProductRecognitionService.recognize).
    expect(recognition.recognize).toHaveBeenCalledWith(
      PHOTO,
      'image/jpeg',
      { userId: USER },
      undefined,
    );
    // persist: old analogs replaced, item updated with hash/url/category/title (title only because item had none)
    expect(tx.productAnalog.deleteMany).toHaveBeenCalledWith({
      where: { productItemId: 'i1' },
    });
    expect(tx.productAnalog.createMany.mock.calls[0][0].data).toEqual([
      {
        title: 'A',
        sourceUrl: 'https://a',
        price: 10,
        currency: '₴',
        thumbnailUrl: 'https://t/a',
        relevanceRank: 1,
        productItemId: 'i1',
      },
    ]);
    expect(tx.productItem.update.mock.calls[0][0].data).toEqual({
      photoUrl: 'https://blob/x.jpg',
      photoHash: hashPhoto(PHOTO),
      category: 'кроссовки',
      title: 'Nike Pegasus',
      // Новое фото отвязывает прежний скетч (§3.3 ТЗ, аудит A-14).
      activeSketchId: null,
      originalDeletedAt: null,
    });
    expect(tx.project.update).toHaveBeenCalled();
    expect(r.analogsSource).toBe('serpapi');
    expect(r.item.analogs[0].price).toBe(10);
    expect(r.analogsReason).toBeUndefined();
  });

  it('does NOT overwrite an existing title with the suggestion', async () => {
    const { svc, prisma, tx } = build();
    prisma.productItem.findFirst
      .mockResolvedValueOnce(ownedItem({ title: 'Мой товар' }))
      .mockResolvedValueOnce(null);
    await svc.processPhoto(USER, 'p1', 'i1', dto);
    expect(tx.productItem.update.mock.calls[0][0].data).not.toHaveProperty(
      'title',
    );
  });

  it('cache hit from another item: copies analogs + category, no lens, no counter', async () => {
    const { svc, prisma, tx, lens, usage } = build();
    prisma.productItem.findFirst
      .mockResolvedValueOnce(ownedItem())
      .mockResolvedValueOnce({
        id: 'i-old',
        category: 'обувь',
        analogs: [
          {
            title: 'Old',
            sourceUrl: 'https://old',
            price: { toString: () => '5' },
            currency: null,
            thumbnailUrl: null,
            relevanceRank: 1,
          },
        ],
      });
    const r = await svc.processPhoto(USER, 'p1', 'i1', dto);
    expect(lens.visualMatches).not.toHaveBeenCalled();
    // Кеш другого товара: до квоты дело вообще не доходит.
    expect(usage.reserve).not.toHaveBeenCalled();
    expect(usage.release).not.toHaveBeenCalled();
    expect(tx.productAnalog.createMany.mock.calls[0][0].data[0]).toMatchObject({
      title: 'Old',
      productItemId: 'i1',
    });
    expect(tx.productItem.update.mock.calls[0][0].data.category).toBe('обувь');
    expect(r.analogsSource).toBe('cache');
  });

  it('cache hit on the SAME item (re-entering the screen): analogs untouched, nothing paid', async () => {
    const { svc, prisma, tx, lens } = build();
    prisma.productItem.findFirst
      .mockResolvedValueOnce(ownedItem({ photoHash: hashPhoto(PHOTO) }))
      .mockResolvedValueOnce({
        id: 'i1',
        category: 'обувь',
        analogs: [
          {
            title: 'X',
            sourceUrl: 'https://x',
            price: null,
            currency: null,
            thumbnailUrl: null,
            relevanceRank: 1,
          },
        ],
      });
    await svc.processPhoto(USER, 'p1', 'i1', dto);
    expect(lens.visualMatches).not.toHaveBeenCalled();
    expect(tx.productAnalog.deleteMany).not.toHaveBeenCalled();
    expect(tx.productAnalog.createMany).not.toHaveBeenCalled();
  });

  it('429 at the daily cap — before any paid call', async () => {
    const { svc, prisma, lens, usage } = build();
    prisma.productItem.findFirst
      .mockResolvedValueOnce(ownedItem())
      .mockResolvedValueOnce(null);
    usage.reserve.mockResolvedValue(false);
    await expect(svc.processPhoto(USER, 'p1', 'i1', dto)).rejects.toMatchObject(
      { status: 429 } as Partial<HttpException>,
    );
    expect(lens.visualMatches).not.toHaveBeenCalled();
  });

  it('lens failure (not billed) → item still saved, counter untouched, reason surfaced', async () => {
    const { svc, prisma, lens, usage, tx } = build();
    prisma.productItem.findFirst
      .mockResolvedValueOnce(ownedItem())
      .mockResolvedValueOnce(null);
    lens.visualMatches.mockResolvedValue({
      matches: [],
      reason: 'ETIMEDOUT',
      billed: false,
    });
    const r = await svc.processPhoto(USER, 'p1', 'i1', dto);
    // Счёта не было — слот возвращается, квота не тратится.
    expect(usage.release).toHaveBeenCalledWith(USER);
    expect(tx.productAnalog.createMany).not.toHaveBeenCalled(); // empty list → nothing to insert
    expect(tx.productItem.update).toHaveBeenCalled(); // photo/hash/category still persisted
    expect(r.analogsSource).toBe('none');
    expect(r.analogsReason).toBe('ETIMEDOUT');
  });

  it('billed-but-empty lens result (Google found nothing) IS counted', async () => {
    const { svc, prisma, lens, usage } = build();
    prisma.productItem.findFirst
      .mockResolvedValueOnce(ownedItem())
      .mockResolvedValueOnce(null);
    lens.visualMatches.mockResolvedValue({
      matches: [],
      reason: "Google hasn't returned any results",
      billed: true,
    });
    const r = await svc.processPhoto(USER, 'p1', 'i1', dto);
    expect(usage.reserve).toHaveBeenCalledWith(USER);
    expect(usage.release).not.toHaveBeenCalled();
    expect(r.analogsSource).toBe('none');
  });

  it('recognition failure never wipes a previous category and is reported softly', async () => {
    const { svc, prisma, recognition, tx } = build();
    prisma.productItem.findFirst
      .mockResolvedValueOnce(ownedItem())
      .mockResolvedValueOnce(null);
    recognition.recognize.mockResolvedValue({
      category: null,
      title: null,
      audience: null,
      reason: 'gemini 503',
    });
    const r = await svc.processPhoto(USER, 'p1', 'i1', dto);
    expect(tx.productItem.update.mock.calls[0][0].data).not.toHaveProperty(
      'category',
    );
    expect(r.recognitionReason).toBe('gemini 503');
  });
});
