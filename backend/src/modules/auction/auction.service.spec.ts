/**
 * AuctionService — полный цикл лота: подача → модерация → очередь →
 * торги → закрытие → оплата, плюс живой эфир. Полторы тысячи строк, в
 * которых каждая ветка решает, кто сколько кому должен.
 *
 * Зачем этот файл появился: до него на весь модуль аукциона
 * (auction.service.ts, auction-payment.service.ts,
 * live-auction-orchestrator.service.ts — около 3100 строк) не было ни
 * одного теста при двух с лишним сотнях spec-файлов в остальном
 * бэкенде. Все прежние аудиты (docs-tz/AUDIT-Auction-*.md) чинили
 * найденное чтением кода, и ни одна починка не была закреплена
 * проверкой — то есть могла молча вернуться.
 *
 * Что проверяется в первую очередь — не «каждый метод по разу», а те
 * ветки, ошибка в которых стоит денег или продаёт чужое:
 *   • порог ставки и запрет ставить на собственный лот;
 *   • антиснайпер (продлевает, но не сокращает; не мешает выкупу);
 *   • какая ставка выигрывает при закрытии по дедлайну и что делает
 *     резервная цена;
 *   • запрет снять с торгов лот, который уже фактически продан;
 *   • потолки очереди (5 активных / 3 эксклюзивных) и приоритет BLITZ;
 *   • кто имеет право начать оплату;
 *   • конвертация мажорных и минорных единиц на КАЖДОЙ границе.
 *
 * Стиль моков — тот же, что в остальном бэкенде (см.
 * publication.service.spec.ts): простой объект вместо PrismaService,
 * `$transaction` исполняет колбэк на нём же.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AuctionService } from './auction.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

const NOW = new Date('2026-09-21T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const portfolioItem = (over: Record<string, unknown> = {}) => ({
  id: 'pi1',
  creatorProfileId: 'cp1',
  status: 'PUBLISHED',
  title: 'Ролик про кружку',
  videoUrl: 'https://blob.test/original.mp4',
  watermarkedVideoUrl: null,
  watermarkStatus: 'NONE',
  thumbnailUrl: 'https://blob.test/thumb.jpg',
  ...over,
});

const listingRow = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  creatorProfileId: 'cp1',
  portfolioItemId: 'pi1',
  brandManifestId: null,
  includeBrandManifest: false,
  auctionType: 'STANDARD',
  payoutCurrency: 'UAH',
  rightsConfirmedAt: NOW,
  expiresAt: new Date(NOW.getTime() + DAY),
  aiAssessment: null,
  brandManifestAiAudit: null,
  startingPrice: 100_000, // 1000.00
  reservePrice: null,
  buyNowPrice: null,
  status: 'ACTIVE',
  createdAt: NOW,
  antiSnipeEnabled: false,
  extensions: 0,
  liveStreamOptIn: false,
  virtualStudioId: null,
  liveStreamActive: false,
  liveStreamStartedAt: null,
  liveStreamEndedAt: null,
  googleAdsCampaignId: null,
  bids: [],
  creatorProfile: { id: 'cp1', userId: 'seller', user: { firstName: 'Оля' } },
  portfolioItem: portfolioItem(),
  ...over,
});

const bidRow = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  listingId: 'l1',
  buyerId: 'buyer1',
  amount: 150_000, // 1500.00
  createdAt: NOW,
  ...over,
});

/** Аргумент `auctionListing.update` — то, что проверяет большинство тестов ниже. */
interface ListingUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}

function build() {
  const prisma = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    creatorProfile: {
      findUnique: jest.fn().mockResolvedValue({ id: 'cp1', userId: 'seller' }),
    },
    portfolioItem: { findUnique: jest.fn().mockResolvedValue(portfolioItem()) },
    brandManifest: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'bm1', userId: 'seller', isLocked: false }),
    },
    auctionListing: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(listingRow()),
      findUniqueOrThrow: jest.fn().mockResolvedValue(listingRow()),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(listingRow({ ...data, id: 'l-new' })),
        ),
      update: jest
        .fn()
        .mockImplementation(({ where, data }: ListingUpdateArgs) =>
          Promise.resolve(listingRow({ id: where.id, ...data })),
        ),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    bid: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(bidRow(data)),
        ),
      findUnique: jest
        .fn()
        .mockResolvedValue(bidRow({ buyer: { telegramId: '777' } })),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _max: { amount: null }, _count: { _all: 0 } }),
    },
    auctionPayment: {
      create: jest.fn().mockResolvedValue({ id: 'ap1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    auctionLiveVoiceCue: { findMany: jest.fn().mockResolvedValue([]) },
    virtualStudio: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'vs1', selectedVariantId: 'var1' }),
    },
    virtualStudioFragment: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'fr1',
        resultUrl: 'https://blob.test/studio.mp4',
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'buyer1', telegramId: '777' }]),
    },
    $transaction: jest.fn(),
  };
  // Обе формы $transaction, которые использует сервис: колбэк (placeBid,
  // promoteNextQueued, adminConfirmPayment) и массив операций
  // (closeListing, assignVirtualStudio, adminList).
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => unknown)(prisma)
      : Promise.all(arg as Promise<unknown>[]),
  );

  const billing = {
    startAuctionCheckout: jest.fn().mockResolvedValue({
      paymentId: 'pay1',
      checkout: { wayforpayFormUrl: 'https://wfp.test/pay' },
    }),
  };
  const auctionPayment = {
    applySuccess: jest.fn().mockResolvedValue(undefined),
  };
  const notify = { dm: jest.fn().mockResolvedValue(undefined) };
  const googleAds = {
    createBlitzCampaign: jest.fn().mockResolvedValue(null),
    pauseCampaign: jest.fn().mockResolvedValue(true),
  };
  const googleIndexing = { notify: jest.fn().mockResolvedValue(undefined) };
  const liveAuction = {
    onBidPlaced: jest.fn().mockResolvedValue(undefined),
    activateLiveStream: jest.fn().mockResolvedValue(undefined),
  };

  const service = new AuctionService(
    prisma as never,
    billing as never,
    auctionPayment as never,
    notify as never,
    googleAds as never,
    googleIndexing as never,
    liveAuction as never,
  );
  return {
    service,
    prisma,
    billing,
    auctionPayment,
    notify,
    googleAds,
    googleIndexing,
    liveAuction,
  };
}

/** Отложенные best-effort эффекты (void ...) — даём микрозадачам отработать. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Аргументы вызовов update по лоту, в data которых есть указанное поле. */
const updatesWith = (
  prisma: { auctionListing: { update: jest.Mock } },
  field: string,
): ListingUpdateArgs[] =>
  (prisma.auctionListing.update.mock.calls as [ListingUpdateArgs][])
    .map(([args]) => args)
    .filter((args) => args?.data != null && field in args.data);

/** Аргументы вызовов update по лоту, переводящих его в указанный статус. */
const statusUpdates = (
  prisma: { auctionListing: { update: jest.Mock } },
  status: string,
): ListingUpdateArgs[] =>
  updatesWith(prisma, 'status').filter((args) => args.data.status === status);

beforeEach(() => {
  // Время подменяется ради антиснайпера и длительностей торгов, но
  // setImmediate/process.nextTick остаются настоящими: на них держится
  // flush() для отложенных best-effort эффектов (уведомления, Google Ads).
  jest
    .useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    .setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Подача заявки ────────────────────────────────────────────────────

describe('create — подача заявки на аукцион', () => {
  const dto = {
    portfolioItemId: 'pi1',
    startingPrice: 1000,
    rightsConfirmed: true,
  } as never;

  it('без профиля исполнителя — 403, а не молчаливое создание', async () => {
    const { service, prisma } = build();
    prisma.creatorProfile.findUnique.mockResolvedValueOnce(null);
    await expect(service.create('u1', dto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('чужая работа — 404, даже если id существует', async () => {
    const { service, prisma } = build();
    prisma.portfolioItem.findUnique.mockResolvedValueOnce(
      portfolioItem({ creatorProfileId: 'cp-другой' }),
    );
    await expect(service.create('seller', dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('неопубликованная работа на аукцион не подаётся', async () => {
    const { service, prisma } = build();
    prisma.portfolioItem.findUnique.mockResolvedValueOnce(
      portfolioItem({ status: 'DRAFT' }),
    );
    await expect(service.create('seller', dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('у работы уже есть незавершённая заявка — второй аукцион на тот же товар запрещён', async () => {
    // Фронтенд просто не предлагает такие работы в списке, но прямой
    // запрос обходит подсказку интерфейса: один эксклюзивный товар не
    // может продаваться на двух аукционах сразу.
    const { service, prisma } = build();
    prisma.auctionListing.findFirst.mockResolvedValueOnce(
      listingRow({ status: 'QUEUED' }),
    );
    await expect(service.create('seller', dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('проверка дубля смотрит именно на «живые» статусы, а не на все подряд', async () => {
    const { service, prisma } = build();
    await service.create('seller', dto);
    const where = prisma.auctionListing.findFirst.mock.calls[0][0].where;
    expect(where.portfolioItemId).toBe('pi1');
    expect(where.status.in).toEqual(
      expect.arrayContaining(['PENDING_MODERATION', 'QUEUED', 'ACTIVE', 'WON']),
    );
    // Терминальные статусы новую подачу блокировать не должны.
    expect(where.status.in).not.toContain('EXPIRED');
    expect(where.status.in).not.toContain('WITHDRAWN');
    expect(where.status.in).not.toContain('REJECTED');
  });

  it('эксклюзивный комплект без указанного брендбука — 400', async () => {
    const { service } = build();
    await expect(
      service.create('seller', {
        ...(dto as object),
        includeBrandManifest: true,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('уже проданный эксклюзивно брендбук нельзя выставить повторно', async () => {
    const { service, prisma } = build();
    prisma.brandManifest.findUnique.mockResolvedValueOnce({
      id: 'bm1',
      userId: 'seller',
      isLocked: true,
    });
    await expect(
      service.create('seller', {
        ...(dto as object),
        includeBrandManifest: true,
        brandManifestId: 'bm1',
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('чужой брендбук приложить нельзя', async () => {
    const { service, prisma } = build();
    prisma.brandManifest.findUnique.mockResolvedValueOnce({
      id: 'bm1',
      userId: 'кто-то-другой',
      isLocked: false,
    });
    await expect(
      service.create('seller', {
        ...(dto as object),
        includeBrandManifest: true,
        brandManifestId: 'bm1',
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('«купить сейчас» ниже резерва — 400: иначе выкуп обходил бы резервную цену', async () => {
    const { service } = build();
    await expect(
      service.create('seller', {
        ...(dto as object),
        reservePrice: 2000,
        buyNowPrice: 1500,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('без резерва «купить сейчас» сравнивается со стартовой ценой', async () => {
    const { service } = build();
    await expect(
      service.create('seller', {
        ...(dto as object),
        startingPrice: 1000,
        buyNowPrice: 900,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('цены уходят в БД в МИНОРНЫХ единицах, а наружу возвращаются в мажорных', async () => {
    const { service, prisma } = build();
    const view = await service.create('seller', {
      portfolioItemId: 'pi1',
      startingPrice: 1000,
      reservePrice: 1500.5,
      buyNowPrice: 4999.99,
      rightsConfirmed: true,
    } as never);

    const { data } = prisma.auctionListing.create.mock.calls[0][0];
    expect(data.startingPrice).toBe(100_000);
    expect(data.reservePrice).toBe(150_050);
    expect(data.buyNowPrice).toBe(499_999);

    expect(view.startingPrice).toBe(1000);
    expect(view.reservePrice).toBe(1500.5);
    expect(view.buyNowPrice).toBe(4999.99);
  });

  it('согласия по умолчанию выключены — антиснайпер и эфир только по явному чекбоксу', async () => {
    const { service, prisma } = build();
    await service.create('seller', dto);
    const { data } = prisma.auctionListing.create.mock.calls[0][0];
    expect(data.antiSnipeEnabled).toBe(false);
    expect(data.liveStreamOptIn).toBe(false);
    expect(data.rightsConfirmedAt).toBeInstanceOf(Date);
  });
});

// ── Отзыв лота ───────────────────────────────────────────────────────

describe('withdraw — снятие лота продавцом', () => {
  it('выигранный лот снять нельзя — сделка уже состоялась', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ status: 'WON' }),
    );
    await expect(service.withdraw('seller', 'l1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('чужой лот — 404', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ creatorProfileId: 'cp-чужой' }),
    );
    await expect(service.withdraw('seller', 'l1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('повторный отзыв уже снятого лота идемпотентен — без повторной записи', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ status: 'WITHDRAWN' }),
    );
    const view = await service.withdraw('seller', 'l1');
    expect(view.status).toBe('WITHDRAWN');
    expect(prisma.auctionListing.update).not.toHaveBeenCalled();
  });

  it('есть ставка, удовлетворяющая резерву — снять нельзя: лот и так был бы продан', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({
        status: 'ACTIVE',
        reservePrice: 120_000,
        bids: [bidRow({ amount: 130_000 })],
      }),
    );
    await expect(service.withdraw('seller', 'l1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('без резерва порогом служит стартовая цена', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({
        status: 'ACTIVE',
        reservePrice: null,
        startingPrice: 100_000,
        bids: [bidRow({ amount: 100_000 })],
      }),
    );
    await expect(service.withdraw('seller', 'l1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('все ставки ниже резерва — снять можно, участников уведомляют, очередь двигается', async () => {
    const { service, prisma, notify } = build();
    prisma.auctionListing.findUnique
      .mockResolvedValueOnce(
        listingRow({
          status: 'ACTIVE',
          reservePrice: 200_000,
          bids: [bidRow({ amount: 130_000 })],
        }),
      )
      // второй вызов — из notifyBiddersOfWithdrawal
      .mockResolvedValueOnce(listingRow({ portfolioItem: portfolioItem() }));

    const view = await service.withdraw('seller', 'l1');
    await flush();

    expect(view.status).toBe('WITHDRAWN');
    expect(prisma.auctionListing.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { status: 'WITHDRAWN' },
    });
    expect(notify.dm).toHaveBeenCalledTimes(1);
    expect(notify.dm.mock.calls[0][1]).toContain('снят продавцом');
    expect(prisma.$executeRaw).toHaveBeenCalled(); // promoteNextQueued взял advisory-лок
  });

  it('ссылка на кампанию Google Ads не обнуляется вместе со снятием', async () => {
    // Аудит-фикс: обнуление ДО подтверждённой паузы теряло единственную
    // ссылку на кампанию навсегда, и открученный бюджет было уже не
    // остановить. Поле обнуляет только сама пауза, после успеха.
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({
        status: 'ACTIVE',
        googleAdsCampaignId: 'customers/1/campaigns/2',
        bids: [],
      }),
    );
    await service.withdraw('seller', 'l1');

    const [withdrawUpdate] = statusUpdates(prisma, 'WITHDRAWN');
    expect(withdrawUpdate.data).not.toHaveProperty('googleAdsCampaignId');
  });

  it('лот из очереди снимается без продвижения очереди и без уведомлений', async () => {
    const { service, prisma, notify } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ status: 'QUEUED', bids: [] }),
    );
    await service.withdraw('seller', 'l1');
    await flush();

    expect(prisma.auctionListing.count).not.toHaveBeenCalled(); // promoteNextQueued не вызывался
    expect(notify.dm).not.toHaveBeenCalled();
  });
});

// ── Ставки ───────────────────────────────────────────────────────────

describe('placeBid — торги', () => {
  const dto = { amount: 2000 } as never;

  it('лот не в торгах — 404', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ status: 'QUEUED' }),
    );
    await expect(service.placeBid('buyer1', 'l1', dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('торги уже закончились по времени — 409, даже если статус ещё ACTIVE', async () => {
    // Крон закрывает лоты раз в несколько минут: между дедлайном и
    // закрытием есть окно, в которое ставка не должна проходить.
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ expiresAt: new Date(NOW.getTime() - 1000) }),
    );
    await expect(service.placeBid('buyer1', 'l1', dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('продавец не может ставить на собственный лот', async () => {
    // Иначе — накрутка цены, а с buyNowPrice ещё и фиктивная продажа с
    // блокировкой собственного брендбука.
    const { service } = build();
    await expect(service.placeBid('seller', 'l1', dto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('ставка не выше текущей лучшей — 400, и порог назван в мажорных единицах', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ bids: [bidRow({ amount: 250_000 })] }),
    );
    await expect(
      service.placeBid('buyer1', 'l1', { amount: 2500 } as never),
    ).rejects.toThrow(/2500/);
  });

  it('равная текущей лучшей ставка не принимается — нужен строгий перебой', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ bids: [bidRow({ amount: 200_000 })] }),
    );
    await expect(
      service.placeBid('buyer1', 'l1', { amount: 2000 } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('первая ставка должна быть выше стартовой цены, а не равна ей', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ startingPrice: 100_000, bids: [] }),
    );
    await expect(
      service.placeBid('buyer1', 'l1', { amount: 1000 } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.placeBid('buyer1', 'l1', { amount: 1000.01 } as never),
    ).resolves.toBeDefined();
  });

  it('порог — максимум из стартовой цены и лучшей ставки, а не просто последняя ставка', async () => {
    // Ставки приходят не отсортированными: взять «последнюю» вместо
    // максимума означало бы принять ставку ниже уже сделанной.
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({
        bids: [
          bidRow({ amount: 300_000 }),
          bidRow({ id: 'b2', amount: 180_000 }),
        ],
      }),
    );
    await expect(
      service.placeBid('buyer1', 'l1', { amount: 2900 } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('принятая ставка пишется в минорных единицах, а наружу отдаётся в мажорных', async () => {
    const { service, prisma } = build();
    const view = await service.placeBid('buyer1', 'l1', {
      amount: 1999.99,
    } as never);

    expect(prisma.bid.create).toHaveBeenCalledWith({
      data: { listingId: 'l1', buyerId: 'buyer1', amount: 199_999 },
    });
    expect(view.amount).toBe(1999.99);
  });

  it('вся проверка и вставка идут под блокировкой строки лота', async () => {
    // Аудит-фикс гонки: без FOR UPDATE два одновременных запроса читали
    // один и тот же currentHighest и оба проходили проверку.
    const { service, prisma } = build();
    await service.placeBid('buyer1', 'l1', dto);

    expect(prisma.$transaction).toHaveBeenCalled();
    const [chunks] = prisma.$executeRaw.mock.calls[0];
    expect(chunks.join('?')).toContain('FOR UPDATE');
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.bid.create.mock.invocationCallOrder[0],
    );
  });
});

describe('placeBid — антиснайпер', () => {
  const late = () =>
    listingRow({
      antiSnipeEnabled: true,
      expiresAt: new Date(NOW.getTime() + 30_000),
    });

  it('поздняя ставка продлевает торги на две минуты и считает продление', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(late());
    await service.placeBid('buyer1', 'l1', { amount: 2000 } as never);

    const [args] = updatesWith(prisma, 'expiresAt');
    expect((args.data.expiresAt as Date).getTime()).toBe(
      NOW.getTime() + 2 * 60 * 1000,
    );
    expect(args.data.extensions).toEqual({ increment: 1 });
  });

  it('ставка задолго до конца НЕ сокращает дедлайн', async () => {
    // Формула — max(expiresAt, now + 2 мин). Наивное присваивание
    // отрезало бы у лота целый час торгов.
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({
        antiSnipeEnabled: true,
        expiresAt: new Date(NOW.getTime() + HOUR),
      }),
    );
    await service.placeBid('buyer1', 'l1', { amount: 2000 } as never);

    expect(updatesWith(prisma, 'expiresAt')).toHaveLength(0);
  });

  it('без явного чекбокса продавца антиснайпер не срабатывает', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({
        antiSnipeEnabled: false,
        expiresAt: new Date(NOW.getTime() + 30_000),
      }),
    );
    await service.placeBid('buyer1', 'l1', { amount: 2000 } as never);

    expect(updatesWith(prisma, 'expiresAt')).toHaveLength(0);
  });

  it('мгновенный выкуп не продлевает торги, которые сам же закрывает', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({
        antiSnipeEnabled: true,
        expiresAt: new Date(NOW.getTime() + 30_000),
        buyNowPrice: 300_000,
      }),
    );
    await service.placeBid('buyer1', 'l1', { amount: 3000 } as never);

    expect(updatesWith(prisma, 'expiresAt')).toHaveLength(0);
  });
});

describe('placeBid — «купить сейчас»', () => {
  it('ставка не ниже buyNowPrice закрывает лот: WON + платёж на сумму ставки', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ buyNowPrice: 300_000 }),
    );
    await service.placeBid('buyer1', 'l1', { amount: 3000 } as never);

    expect(prisma.auctionListing.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { status: 'WON' },
    });
    expect(prisma.auctionPayment.create).toHaveBeenCalledWith({
      data: {
        listingId: 'l1',
        winningBidId: 'b1',
        amount: 300_000,
        commission: 0,
      },
    });
  });

  it('комиссия при создании платежа — ноль: считается по факту оплаты', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ buyNowPrice: 300_000 }),
    );
    await service.placeBid('buyer1', 'l1', { amount: 3000 } as never);

    expect(prisma.auctionPayment.create.mock.calls[0][0].data.commission).toBe(
      0,
    );
  });

  it('ставка ниже buyNowPrice лот не закрывает', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ buyNowPrice: 500_000 }),
    );
    await service.placeBid('buyer1', 'l1', { amount: 3000 } as never);

    expect(prisma.auctionPayment.create).not.toHaveBeenCalled();
    expect(updatesWith(prisma, 'status')).toHaveLength(0);
  });

  it('победитель получает уведомление со ссылкой на оплату и суммой в мажорных единицах', async () => {
    const { service, prisma, notify } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ buyNowPrice: 300_000 }),
    );
    prisma.bid.findUnique.mockResolvedValueOnce(
      bidRow({ amount: 300_000, buyer: { telegramId: '777' } }),
    );
    await service.placeBid('buyer1', 'l1', { amount: 3000 } as never);
    await flush();

    const text = notify.dm.mock.calls[0][1];
    expect(text).toContain('3000');
    expect(text).toContain('/my-bids');
  });

  it('эфир получает новую ставку только у лота с назначенной студией', async () => {
    const withStudio = build();
    withStudio.prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ virtualStudioId: 'vs1' }),
    );
    await withStudio.service.placeBid('buyer1', 'l1', {
      amount: 2000,
    } as never);
    expect(withStudio.liveAuction.onBidPlaced).toHaveBeenCalledWith('l1', {
      id: 'b1',
      amount: 200_000,
    });

    const withoutStudio = build();
    await withoutStudio.service.placeBid('buyer1', 'l1', {
      amount: 2000,
    } as never);
    expect(withoutStudio.liveAuction.onBidPlaced).not.toHaveBeenCalled();
  });

  it('мгновенный выкуп не отправляет в эфир подсказку про уже закрытый лот', async () => {
    const { service, prisma, liveAuction } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ virtualStudioId: 'vs1', buyNowPrice: 300_000 }),
    );
    await service.placeBid('buyer1', 'l1', { amount: 3000 } as never);

    expect(liveAuction.onBidPlaced).not.toHaveBeenCalled();
  });
});

// ── Закрытие по дедлайну ─────────────────────────────────────────────

describe('closeExpiredListings — закрытие по дедлайну', () => {
  it('выигрывает НАИБОЛЬШАЯ ставка, удовлетворяющая резерву, а не первая и не последняя', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      listingRow({
        reservePrice: 150_000,
        bids: [
          bidRow({ id: 'low', amount: 160_000 }),
          bidRow({ id: 'top', amount: 240_000 }),
          bidRow({ id: 'mid', amount: 200_000 }),
        ],
      }),
    ]);

    const result = await service.closeExpiredListings();
    expect(result).toEqual({ closed: 1 });
    expect(prisma.auctionPayment.create).toHaveBeenCalledWith({
      data: {
        listingId: 'l1',
        winningBidId: 'top',
        amount: 240_000,
        commission: 0,
      },
    });
  });

  it('ставки ниже резерва не выигрывают — лот истекает непроданным', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      listingRow({
        reservePrice: 300_000,
        bids: [bidRow({ amount: 290_000 })],
      }),
    ]);

    await service.closeExpiredListings();
    expect(prisma.auctionPayment.create).not.toHaveBeenCalled();
    expect(prisma.auctionListing.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { status: 'EXPIRED' },
    });
  });

  it('без резерва порогом служит стартовая цена', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      listingRow({
        reservePrice: null,
        startingPrice: 100_000,
        bids: [bidRow({ id: 'ok', amount: 100_000 })],
      }),
    ]);

    await service.closeExpiredListings();
    // Ставка ровно в стартовую цену резерв удовлетворяет (>=).
    expect(prisma.auctionPayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ winningBidId: 'ok' }),
      }),
    );
  });

  it('при пустом резерве порог — именно стартовая цена, а не ноль', async () => {
    // Ветка защитная: placeBid не пропустит ставку ниже стартовой цены,
    // так что в норме такой строки не появится. Но резерв здесь —
    // последняя проверка перед тем, как лот будет объявлен проданным, и
    // подставить в неё 0 вместо стартовой цены означает продать лот за
    // любую сумму, какой бы она ни была записана в обход торгов
    // (импорт, ручная правка, будущий админ-путь).
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      listingRow({
        reservePrice: null,
        startingPrice: 100_000,
        bids: [bidRow({ amount: 1 })],
      }),
    ]);

    await service.closeExpiredListings();
    expect(prisma.auctionPayment.create).not.toHaveBeenCalled();
    expect(prisma.auctionListing.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { status: 'EXPIRED' },
    });
  });

  it('лот без ставок истекает и освобождает место в очереди', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      listingRow({ bids: [] }),
    ]);

    await service.closeExpiredListings();
    expect(prisma.auctionListing.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { status: 'EXPIRED' },
    });
    expect(prisma.auctionListing.count).toHaveBeenCalled(); // promoteNextQueued
  });

  it('идущий эфир останавливается вместе с истечением торгов', async () => {
    const { service, prisma, googleIndexing } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      listingRow({ bids: [], liveStreamActive: true }),
    ]);

    await service.closeExpiredListings();
    await flush();

    const [args] = updatesWith(prisma, 'liveStreamActive');
    expect(args.data.liveStreamActive).toBe(false);
    expect(args.data.liveStreamEndedAt).toBeInstanceOf(Date);
    expect(googleIndexing.notify).toHaveBeenCalled(); // Google должен узнать, что эфир кончился
  });

  it('у лота без эфира liveStreamEndedAt не проставляется', async () => {
    const { service, prisma, googleIndexing } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      listingRow({ bids: [], liveStreamActive: false }),
    ]);

    await service.closeExpiredListings();
    await flush();

    expect(updatesWith(prisma, 'liveStreamEndedAt')).toHaveLength(0);
    expect(googleIndexing.notify).not.toHaveBeenCalled();
  });

  it('ссылка на кампанию Google Ads переживает истечение лота', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      listingRow({ bids: [], googleAdsCampaignId: 'customers/1/campaigns/2' }),
    ]);

    await service.closeExpiredListings();
    const [expiredUpdate] = statusUpdates(prisma, 'EXPIRED');
    expect(expiredUpdate.data).not.toHaveProperty('googleAdsCampaignId');
  });

  it('ничего не истекло — отчёт о нуле закрытых, без побочных эффектов', async () => {
    const { service, prisma } = build();
    const result = await service.closeExpiredListings();
    expect(result).toEqual({ closed: 0 });
    expect(prisma.auctionListing.update).not.toHaveBeenCalled();
  });
});

// ── Очередь и продвижение ────────────────────────────────────────────

describe('promoteNextQueued — кто занимает освободившееся место', () => {
  /** Продвижение вызывается из withdraw(); лот в QUEUED сам очередь не двигает, поэтому снимаем ACTIVE без ставок. */
  const triggerPromotion = async (svc: ReturnType<typeof build>) => {
    svc.prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ status: 'ACTIVE', bids: [] }),
    );
    await svc.service.withdraw('seller', 'l1');
    await flush();
  };

  const queued = (over: Record<string, unknown> = {}) =>
    listingRow({ status: 'QUEUED', expiresAt: null, ...over });

  it('BLITZ обгоняет поданный раньше STANDARD', async () => {
    const svc = build();
    svc.prisma.auctionListing.findMany.mockResolvedValue([
      queued({
        id: 'старый-standard',
        auctionType: 'STANDARD',
        createdAt: new Date(NOW.getTime() - 10 * DAY),
      }),
      queued({
        id: 'свежий-blitz',
        auctionType: 'BLITZ',
        createdAt: new Date(NOW.getTime() - HOUR),
      }),
    ]);
    await triggerPromotion(svc);

    const promoted = statusUpdates(svc.prisma, 'ACTIVE');
    expect(promoted[0].where.id).toBe('свежий-blitz');
    expect(promoted[1].where.id).toBe('старый-standard');
  });

  it('внутри одного типа порядок — по дате подачи', async () => {
    const svc = build();
    svc.prisma.auctionListing.findMany.mockResolvedValue([
      queued({ id: 'поздний', createdAt: new Date(NOW.getTime() - HOUR) }),
      queued({ id: 'ранний', createdAt: new Date(NOW.getTime() - 5 * DAY) }),
    ]);
    await triggerPromotion(svc);

    const promoted = statusUpdates(svc.prisma, 'ACTIVE');
    expect(promoted[0].where.id).toBe('ранний');
  });

  it('потолок в пять активных лотов не пробивается', async () => {
    const svc = build();
    svc.prisma.auctionListing.count.mockResolvedValue(5);
    svc.prisma.auctionListing.findMany.mockResolvedValue([
      queued({ id: 'q1' }),
      queued({ id: 'q2' }),
    ]);
    await triggerPromotion(svc);

    expect(statusUpdates(svc.prisma, 'ACTIVE')).toHaveLength(0);
  });

  it('свободно два места — продвигаются ровно два кандидата из трёх', async () => {
    const svc = build();
    svc.prisma.auctionListing.count.mockResolvedValue(3);
    svc.prisma.auctionListing.findMany.mockResolvedValue([
      queued({ id: 'q1' }),
      queued({ id: 'q2' }),
      queued({ id: 'q3' }),
    ]);
    await triggerPromotion(svc);

    const promoted = statusUpdates(svc.prisma, 'ACTIVE');
    expect(promoted.map((args) => args.where.id)).toEqual(['q1', 'q2']);
  });

  it('исчерпанный подлимит эксклюзивов пропускает такого кандидата, но не блокирует очередь', async () => {
    // Иначе один эксклюзивный лот в голове очереди держал бы всю витрину.
    const svc = build();
    svc.prisma.auctionListing.count
      .mockResolvedValueOnce(0) // всего активных
      .mockResolvedValueOnce(3); // из них эксклюзивных — подлимит исчерпан
    svc.prisma.auctionListing.findMany.mockResolvedValue([
      queued({ id: 'эксклюзив', includeBrandManifest: true }),
      queued({ id: 'обычный', includeBrandManifest: false }),
    ]);
    await triggerPromotion(svc);

    const ids = statusUpdates(svc.prisma, 'ACTIVE').map(
      (args) => args.where.id,
    );
    expect(ids).toEqual(['обычный']);
  });

  it('BLITZ получает 48 часов, STANDARD — пять суток', async () => {
    const svc = build();
    svc.prisma.auctionListing.findMany.mockResolvedValue([
      queued({ id: 'b', auctionType: 'BLITZ' }),
      queued({ id: 's', auctionType: 'STANDARD' }),
    ]);
    await triggerPromotion(svc);

    const byId = Object.fromEntries(
      updatesWith(svc.prisma, 'expiresAt').map((args) => [
        args.where.id,
        (args.data.expiresAt as Date).getTime(),
      ]),
    );
    expect(byId['b']).toBe(NOW.getTime() + 48 * HOUR);
    expect(byId['s']).toBe(NOW.getTime() + 5 * DAY);
  });

  it('подсчёт мест и продвижение идут под общим advisory-локом', async () => {
    // Аудит-фикс гонки: метод вызывается из withdraw, крона закрытия,
    // закрытия по выкупу и одобрения оператором — без лока два вызова
    // читали «активных меньше пяти» до коммита друг друга.
    const svc = build();
    await triggerPromotion(svc);

    const lockCall = (svc.prisma.$executeRaw.mock.calls as [string[]][]).find(
      ([chunks]) => chunks.join('?').includes('pg_advisory_xact_lock'),
    );
    expect(lockCall).toBeDefined();
    expect(svc.prisma.$transaction).toHaveBeenCalled();
  });

  it('эфир заводится только у продвинутого лота с назначенной студией', async () => {
    const svc = build();
    svc.prisma.auctionListing.findMany.mockResolvedValue([
      queued({ id: 'со-студией', virtualStudioId: 'vs1' }),
      queued({ id: 'без-студии', virtualStudioId: null }),
    ]);
    await triggerPromotion(svc);

    expect(svc.liveAuction.activateLiveStream).toHaveBeenCalledTimes(1);
    expect(svc.liveAuction.activateLiveStream).toHaveBeenCalledWith(
      'со-студией',
    );
  });

  it('Google Ads включается только блиц-лотам и только после коммита', async () => {
    const svc = build();
    svc.prisma.auctionListing.findMany.mockResolvedValue([
      queued({ id: 'b', auctionType: 'BLITZ' }),
      queued({ id: 's', auctionType: 'STANDARD' }),
    ]);
    svc.prisma.auctionListing.findUnique.mockResolvedValue(
      listingRow({ portfolioItem: portfolioItem() }),
    );
    await triggerPromotion(svc);
    await flush();

    expect(svc.googleAds.createBlitzCampaign).toHaveBeenCalledTimes(1);
    expect(svc.prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      svc.googleAds.createBlitzCampaign.mock.invocationCallOrder[0],
    );
  });

  it('отказ Google Ads не откатывает уже состоявшийся перевод лота в торги', async () => {
    const svc = build();
    svc.googleAds.createBlitzCampaign.mockRejectedValue(
      new Error('403 from Google'),
    );
    svc.prisma.auctionListing.findMany.mockResolvedValue([
      queued({ id: 'b', auctionType: 'BLITZ' }),
    ]);
    await triggerPromotion(svc);
    await flush();

    expect(statusUpdates(svc.prisma, 'ACTIVE')).toHaveLength(1);
  });
});

// ── Оплата ───────────────────────────────────────────────────────────

describe('startCheckout — кто и когда платит', () => {
  const won = (over: Record<string, unknown> = {}) =>
    listingRow({
      status: 'WON',
      payment: {
        id: 'ap1',
        amount: 300_000,
        paidAt: null,
        paymentId: null,
        winningBidId: 'b1',
      },
      ...over,
    });

  it('лот ещё не выигран — платить нечего', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ status: 'ACTIVE', payment: null }),
    );
    await expect(service.startCheckout('buyer1', 'l1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('уже оплачено — 409, а не второй платёж', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      won({
        payment: {
          id: 'ap1',
          amount: 300_000,
          paidAt: NOW,
          paymentId: 'pay1',
          winningBidId: 'b1',
        },
      }),
    );
    await expect(service.startCheckout('buyer1', 'l1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('чек-аут уже начат — отдаётся 409, чтобы не плодить платёжные ссылки', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      won({
        payment: {
          id: 'ap1',
          amount: 300_000,
          paidAt: null,
          paymentId: 'pay-старый',
          winningBidId: 'b1',
        },
      }),
    );
    await expect(service.startCheckout('buyer1', 'l1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('платить может только победивший участник, а не любой залогиненный', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(won());
    prisma.bid.findUnique.mockResolvedValueOnce(
      bidRow({ buyerId: 'кто-то-другой' }),
    );
    await expect(service.startCheckout('buyer1', 'l1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('победитель начинает оплату: в billing уходит сумма в МАЖОРНЫХ единицах', async () => {
    const { service, prisma, billing } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(won());
    prisma.bid.findUnique.mockResolvedValueOnce(bidRow({ buyerId: 'buyer1' }));

    const checkout = await service.startCheckout('buyer1', 'l1');

    expect(billing.startAuctionCheckout).toHaveBeenCalledWith(
      'buyer1',
      'ap1',
      3000,
      'UAH',
      'Ролик про кружку',
    );
    expect(checkout).toEqual({ wayforpayFormUrl: 'https://wfp.test/pay' });
    expect(prisma.auctionPayment.update).toHaveBeenCalledWith({
      where: { id: 'ap1' },
      data: { paymentId: 'pay1' },
    });
  });

  it('платёж идёт в валюте, которую выбрал продавец', async () => {
    const { service, prisma, billing } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      won({ payoutCurrency: 'USD' }),
    );
    prisma.bid.findUnique.mockResolvedValueOnce(bidRow({ buyerId: 'buyer1' }));

    await service.startCheckout('buyer1', 'l1');
    expect(billing.startAuctionCheckout.mock.calls[0][3]).toBe('USD');
  });
});

describe('adminConfirmPayment — ручной путь оператора', () => {
  it('подтверждает через общий applySuccess, внутри транзакции', async () => {
    const { service, prisma, auctionPayment } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ status: 'WON', payment: { id: 'ap1', paidAt: null } }),
    );
    await service.adminConfirmPayment('l1');

    expect(auctionPayment.applySuccess).toHaveBeenCalledWith(
      expect.anything(),
      'ap1',
    );
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('уже оплаченный лот повторно не подтверждается', async () => {
    const { service, prisma, auctionPayment } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ status: 'WON', payment: { id: 'ap1', paidAt: NOW } }),
    );
    await expect(service.adminConfirmPayment('l1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(auctionPayment.applySuccess).not.toHaveBeenCalled();
  });

  it('лот не в статусе WON — 404', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ status: 'ACTIVE', payment: null }),
    );
    await expect(service.adminConfirmPayment('l1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ── Модерация ────────────────────────────────────────────────────────

describe('adminApprove / adminReject', () => {
  it('одобрение ставит лот в очередь и сразу пытается продвинуть', async () => {
    const { service, prisma } = build();
    await service.adminApprove('l1');

    expect(prisma.auctionListing.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { status: 'QUEUED', rejectionReason: null },
    });
    expect(prisma.auctionListing.count).toHaveBeenCalled();
  });

  it('одобрение возвращает ПОЛНУЮ админ-проекцию, а не урезанную', async () => {
    // Аудит-фикс: админка подставляет этот ответ прямо в строку таблицы —
    // без этих полей превью, заголовок и ссылка на исполнителя исчезали
    // сразу после клика «Одобрить».
    const { service } = build();
    const view = await service.adminApprove('l1');

    expect(view.portfolioItemTitle).toBe('Ролик про кружку');
    expect(view.portfolioItemVideoUrl).toBe('https://blob.test/original.mp4');
    expect(view.creatorDisplayName).toBe('Оля');
    expect(view).toHaveProperty('currentPriceUahEquivalent');
  });

  it('отклонение сохраняет причину и тоже отдаёт полную проекцию', async () => {
    const { service, prisma } = build();
    const view = await service.adminReject('l1', {
      reason: 'нет прав на музыку',
    } as never);

    expect(prisma.auctionListing.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'REJECTED', rejectionReason: 'нет прав на музыку' },
      }),
    );
    expect(view.portfolioItemTitle).toBe('Ролик про кружку');
    expect(view.bidCount).toBe(0);
  });
});

// ── Живой эфир ───────────────────────────────────────────────────────

describe('assignVirtualStudio — назначение студии эфира', () => {
  const blitz = (over: Record<string, unknown> = {}) =>
    listingRow({
      auctionType: 'BLITZ',
      liveStreamOptIn: true,
      status: 'QUEUED',
      ...over,
    });
  const dto = { virtualStudioId: 'vs1' } as never;

  it('STANDARD-лоту эфир не назначается', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      blitz({ auctionType: 'STANDARD' }),
    );
    await expect(service.assignVirtualStudio('l1', dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('без согласия продавца оператор не может включить эфир в обход чекбокса', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      blitz({ liveStreamOptIn: false }),
    );
    await expect(service.assignVirtualStudio('l1', dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('лоту вне очереди и торгов студию не назначить', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      blitz({ status: 'WON' }),
    );
    await expect(service.assignVirtualStudio('l1', dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('студия без выбранного референс-кадра не годится', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(blitz());
    prisma.virtualStudio.findFirst.mockResolvedValueOnce({
      id: 'vs1',
      selectedVariantId: null,
    });
    await expect(service.assignVirtualStudio('l1', dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('у студии нет готового видео — отказ с понятным оператору текстом', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(blitz());
    prisma.virtualStudioFragment.findFirst.mockResolvedValueOnce(null);
    await expect(service.assignVirtualStudio('l1', dto)).rejects.toThrow(
      /готового видео-фрагмента/,
    );
  });

  it('успех: студия у лота, фрагмент закреплён за этим лотом', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(blitz());
    await service.assignVirtualStudio('l1', dto);

    expect(prisma.auctionListing.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { virtualStudioId: 'vs1' },
    });
    expect(prisma.virtualStudioFragment.update).toHaveBeenCalledWith({
      where: { id: 'fr1' },
      data: { liveAuctionListingId: 'l1' },
    });
  });

  it('лот уже в торгах и студии не было — эфир заводится сразу', async () => {
    const { service, prisma, liveAuction } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      blitz({ status: 'ACTIVE', virtualStudioId: null }),
    );
    await service.assignVirtualStudio('l1', dto);
    expect(liveAuction.activateLiveStream).toHaveBeenCalledWith('l1');
  });

  it('смена студии у лота, где эфир уже шёл, второй раз его не запускает', async () => {
    const { service, prisma, liveAuction } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      blitz({ status: 'ACTIVE', virtualStudioId: 'старая' }),
    );
    await service.assignVirtualStudio('l1', dto);
    expect(liveAuction.activateLiveStream).not.toHaveBeenCalled();
  });

  it('лот в очереди — эфир ждёт перехода в торги, а не стартует сейчас', async () => {
    const { service, prisma, liveAuction } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      blitz({ status: 'QUEUED' }),
    );
    await service.assignVirtualStudio('l1', dto);
    expect(liveAuction.activateLiveStream).not.toHaveBeenCalled();
  });
});

describe('getLiveState — снимок эфира для подключившегося зрителя', () => {
  const cueRow = (
    seq: number,
    kind: string,
    resultUrl: string | null = `https://blob.test/${seq}.mp3`,
  ) => ({
    id: `c${seq}`,
    seq,
    kind,
    readyAt: new Date(NOW.getTime() + seq * 1000),
    createdAt: NOW,
    voiceFragment: resultUrl ? { resultUrl } : null,
  });

  it('максимум и количество ставок считает БД, а не выборка всех ставок в память', async () => {
    // Аудит L-4: эндпоинт опрашивает каждый зритель раз в 4 секунды, а
    // на горячем лоте ставок — сотни.
    const { service, prisma } = build();
    prisma.bid.aggregate.mockResolvedValueOnce({
      _max: { amount: 240_000 },
      _count: { _all: 7 },
    });

    const state = await service.getLiveState('l1');

    expect(prisma.bid.aggregate).toHaveBeenCalledWith({
      where: { listingId: 'l1' },
      _max: { amount: true },
      _count: { _all: true },
    });
    expect(prisma.bid.findMany).not.toHaveBeenCalled();
    expect(state.highestBidAmount).toBe(2400); // мажорные единицы наружу
    expect(state.bidCount).toBe(7);
  });

  it('ставок нет — цена null, а не ноль', async () => {
    const { service } = build();
    const state = await service.getLiveState('l1');
    expect(state.highestBidAmount).toBeNull();
    expect(state.bidCount).toBe(0);
  });

  it('подсказки отдаются в хронологическом порядке, хотя БД отдаёт их с конца', async () => {
    // Выбираются последние 50 по убыванию seq — плеер же ждёт порядок по
    // возрастанию, иначе голос «идёт назад по времени».
    const { service, prisma } = build();
    prisma.auctionLiveVoiceCue.findMany.mockResolvedValueOnce([
      cueRow(12, 'BID_STATS'),
      cueRow(11, 'PRAISE'),
      cueRow(10, 'LOT_DESC'),
    ]);

    const state = await service.getLiveState('l1');
    expect(state.cues.map((c) => c.seq)).toEqual([10, 11, 12]);

    const query = prisma.auctionLiveVoiceCue.findMany.mock.calls[0][0];
    expect(query.orderBy).toEqual({ seq: 'desc' });
    expect(query.take).toBe(50);
  });

  it('подсказка без готового аудио отбрасывается, а не отдаётся с пустым src', async () => {
    const { service, prisma } = build();
    prisma.auctionLiveVoiceCue.findMany.mockResolvedValueOnce([
      cueRow(11, 'BID_STATS', null),
      cueRow(10, 'LOT_DESC'),
    ]);

    const state = await service.getLiveState('l1');
    expect(state.cues.map((c) => c.seq)).toEqual([10]);
  });

  it('закрытый лот отдаёт состояние, а не 404 — зритель должен увидеть финал', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ status: 'WON' }),
    );
    const state = await service.getLiveState('l1');
    expect(state.status).toBe('WON');
  });

  it('несуществующий лот — всё-таки 404', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(null);
    await expect(service.getLiveState('нет')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('видео эфира берётся только у лота с назначенной студией', async () => {
    const withStudio = build();
    withStudio.prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ virtualStudioId: 'vs1' }),
    );
    expect((await withStudio.service.getLiveState('l1')).videoUrl).toBe(
      'https://blob.test/studio.mp4',
    );

    const withoutStudio = build();
    expect(
      (await withoutStudio.service.getLiveState('l1')).videoUrl,
    ).toBeNull();
    expect(
      withoutStudio.prisma.virtualStudioFragment.findFirst,
    ).not.toHaveBeenCalled();
  });
});

describe('getLiveUpdates — добор по курсорам', () => {
  it('ставки и подсказки запрашиваются строго новее курсоров', async () => {
    const { service, prisma } = build();
    const since = new Date(NOW.getTime() - HOUR);
    await service.getLiveUpdates('l1', since, 7);

    expect(prisma.bid.findMany.mock.calls[0][0].where).toEqual({
      listingId: 'l1',
      createdAt: { gt: since },
    });
    expect(
      prisma.auctionLiveVoiceCue.findMany.mock.calls[0][0].where.seq,
    ).toEqual({ gt: 7 });
  });

  it('без курсора по времени отдаются все ставки лота', async () => {
    const { service, prisma } = build();
    await service.getLiveUpdates('l1', null, 0);
    expect(prisma.bid.findMany.mock.calls[0][0].where).toEqual({
      listingId: 'l1',
    });
  });

  it('суммы ставок конвертируются в мажорные единицы', async () => {
    const { service, prisma } = build();
    prisma.bid.findMany.mockResolvedValueOnce([bidRow({ amount: 199_999 })]);
    const { bids } = await service.getLiveUpdates('l1', null, 0);
    expect(bids[0].amount).toBe(1999.99);
  });
});

// ── Проекции наружу ──────────────────────────────────────────────────

describe('проекции — что видит покупатель и оператор', () => {
  it('публичная витрина отдаёт лот с ценами в мажорных единицах', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      listingRow({
        startingPrice: 100_000,
        buyNowPrice: 500_000,
        bids: [bidRow({ amount: 250_000 })],
      }),
    ]);

    const [view] = await service.listPublic();
    expect(view.startingPrice).toBe(1000);
    expect(view.buyNowPrice).toBe(5000);
    expect(view.highestBidAmount).toBe(2500);
    expect(view.bidCount).toBe(1);
  });

  it('витрина отдаёт защищённую знаком копию, если она готова', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({
        portfolioItem: portfolioItem({
          watermarkStatus: 'READY',
          watermarkedVideoUrl: 'https://blob.test/wm.mp4',
        }),
      }),
    );

    const view = await service.getPublic('l1');
    expect(view.videoUrl).toBe('https://blob.test/wm.mp4');
  });

  it('лот вне торгов публично не отдаётся — никаких мёртвых ссылок', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ status: 'WON' }),
    );
    await expect(service.getPublic('l1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('оператору UAH-лот не пересчитывается сам в себя', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      listingRow({ payoutCurrency: 'UAH' }),
    ]);
    prisma.auctionListing.count.mockResolvedValueOnce(1);

    const { items } = await service.adminList({ page: 1, pageSize: 20 });
    expect(items[0].currentPriceUahEquivalent).toBeNull();
  });

  it('валютный лот получает гривневую оценку, считая от текущей цены', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      listingRow({
        payoutCurrency: 'USD',
        startingPrice: 10_000,
        bids: [bidRow({ amount: 20_000 })],
      }),
    ]);
    prisma.auctionListing.count.mockResolvedValueOnce(1);

    const { items } = await service.adminList({ page: 1, pageSize: 20 });
    // Текущая цена — лучшая ставка (200 USD), а не стартовая (100 USD).
    expect(items[0].currentPriceUahEquivalent).toBeGreaterThan(200);
    expect(items[0].currentPriceUahEquivalent).toBe(
      Math.round(items[0].currentPriceUahEquivalent! * 100) / 100,
    );
  });

  it('без ставок гривневая оценка считается от стартовой цены', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      listingRow({ payoutCurrency: 'EUR', startingPrice: 10_000, bids: [] }),
    ]);
    prisma.auctionListing.count.mockResolvedValueOnce(1);

    const { items } = await service.adminList({ page: 1, pageSize: 20 });
    expect(items[0].currentPriceUahEquivalent).toBeGreaterThan(100);
  });

  it('пагинация считает пропуск от номера страницы', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.count.mockResolvedValueOnce(42);
    const result = await service.adminList({
      page: 3,
      pageSize: 20,
      status: 'QUEUED',
    });

    const query = prisma.auctionListing.findMany.mock.calls[0][0];
    expect(query.skip).toBe(40);
    expect(query.take).toBe(20);
    expect(query.where).toEqual({ status: 'QUEUED' });
    expect(result.total).toBe(42);
  });
});

describe('listMyBids — «мои ставки» для победителя обычных торгов', () => {
  it('на лот отдаётся одна строка с МОЕЙ лучшей ставкой', async () => {
    const { service, prisma } = build();
    const listing = {
      id: 'l1',
      status: 'ACTIVE',
      portfolioItem: portfolioItem(),
      payment: null,
    };
    prisma.bid.findMany.mockResolvedValueOnce([
      { ...bidRow({ id: 'b3', amount: 220_000 }), listing },
      { ...bidRow({ id: 'b2', amount: 180_000 }), listing },
      { ...bidRow({ id: 'b1', amount: 150_000 }), listing },
    ]);

    const rows = await service.listMyBids('buyer1');
    expect(rows).toHaveLength(1);
    expect(rows[0].myBidAmount).toBe(2200);
  });

  it('победа определяется по покупателю выигравшей ставки, а не по наличию платежа', async () => {
    const { service, prisma } = build();
    const base = {
      id: 'l1',
      status: 'WON',
      portfolioItem: portfolioItem(),
    };
    prisma.bid.findMany.mockResolvedValueOnce([
      {
        ...bidRow({ amount: 220_000 }),
        listing: {
          ...base,
          payment: { paidAt: null, winningBid: { buyerId: 'buyer1' } },
        },
      },
    ]);
    expect((await service.listMyBids('buyer1'))[0]).toEqual(
      expect.objectContaining({ isWinner: true, paymentPaid: false }),
    );

    const other = build();
    other.prisma.bid.findMany.mockResolvedValueOnce([
      {
        ...bidRow({ amount: 220_000 }),
        listing: {
          ...base,
          payment: { paidAt: NOW, winningBid: { buyerId: 'кто-то-другой' } },
        },
      },
    ]);
    expect((await other.service.listMyBids('buyer1'))[0]).toEqual(
      expect.objectContaining({ isWinner: false, paymentPaid: true }),
    );
  });
});
