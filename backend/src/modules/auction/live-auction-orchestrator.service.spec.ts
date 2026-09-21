/**
 * LiveAuctionOrchestratorService — озвучка живого эфира лота: три
 * pregen-реплики при выходе в эфир, реплика статистики на ставку,
 * авто-сворачивание эфира без ставок.
 *
 * Почему это стоит тестов отдельно от AuctionService: здесь ЕДИНСТВЕННОЕ
 * место, где сервис сам тратит деньги на внешний вызов (синтез речи), и
 * три независимых механизма защиты вокруг него — троттлинг, резерв `seq`
 * под advisory-локом и best-effort-обёртка, из-за которой сбой ничего не
 * ломает, а значит и не виден. Молча сломавшийся троттлинг не уронит ни
 * одного запроса — он просто будет платить провайдеру на каждую ставку
 * горячего лота, и узнаётся это по счёту.
 *
 * Что проверяется:
 *  - идемпотентность выхода в эфир (метод зовут из двух мест);
 *  - потолок платных реплик в минуту и то, что он НЕ мешает самой ставке;
 *  - `seq` берётся под локом и растёт от максимума;
 *  - заглушка `pending` заводится ДО платного вызова, а при любом исходе
 *    доводится до COMPLETE или FAILED — не остаётся висеть;
 *  - сворачивание эфира считает «последнюю активность» правильно и не
 *    прерывается на одном сбойном лоте;
 *  - Google узнаёт о начале и конце эфира ровно по одному разу на событие.
 */

import { LiveAuctionOrchestratorService } from './live-auction-orchestrator.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

const NOW = new Date('2026-09-21T12:00:00Z');
const MIN = 60_000;

const listingRow = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  status: 'ACTIVE',
  virtualStudioId: 'vs1',
  payoutCurrency: 'UAH',
  auctionType: 'BLITZ',
  startingPrice: 100_000, // 1000.00
  liveStreamActive: false,
  liveStreamStartedAt: null,
  liveStreamEndedAt: null,
  portfolioItem: { title: 'Ролик про кружку', collectionTag: null },
  bids: [],
  ...over,
});

function build(over: { configured?: boolean; synthOk?: boolean } = {}) {
  const prisma = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
    auctionListing: {
      findUnique: jest.fn().mockResolvedValue(listingRow()),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auctionLiveVoiceCue: {
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _max: { seq: null } }),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: { seq: number } }) =>
          Promise.resolve({ id: `cue-${data.seq}`, ...data }),
        ),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    virtualStudioFragment: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'fr-voice' }),
    },
    bid: { groupBy: jest.fn().mockResolvedValue([{ buyerId: 'b1' }]) },
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );

  const blob = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ url: 'https://blob.test/cue.mp3' }),
  };
  const aiUsage = { record: jest.fn().mockResolvedValue(undefined) };
  const provider = {
    providerKey: 'elevenlabs',
    configured: jest.fn().mockReturnValue(over.configured ?? true),
    synthesize: jest.fn().mockResolvedValue(
      over.synthOk === false
        ? { ok: false, skipped: false, reason: 'quota exhausted' }
        : {
            ok: true,
            audio: Buffer.from('mp3'),
            mimeType: 'audio/mpeg',
            characters: 42,
          },
    ),
  };
  const tts = { resolve: jest.fn().mockResolvedValue(provider) };
  const googleIndexing = { notify: jest.fn().mockResolvedValue(undefined) };

  const service = new LiveAuctionOrchestratorService(
    prisma as never,
    blob as never,
    aiUsage as never,
    tts as never,
    googleIndexing as never,
  );
  return { service, prisma, blob, aiUsage, tts, provider, googleIndexing };
}

/** Отложенные best-effort эффекты (void ...) — даём микрозадачам отработать. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Тексты заведённых реплик, в порядке появления. */
const cueTexts = (blob: { uploadBuffer: jest.Mock }) =>
  blob.uploadBuffer.mock.calls;

beforeEach(() => {
  jest
    .useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    .setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Выход в эфир ─────────────────────────────────────────────────────

describe('activateLiveStream', () => {
  it('лот без назначенной студии в эфир не выходит', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ virtualStudioId: null }),
    );
    await service.activateLiveStream('l1');

    expect(prisma.auctionListing.updateMany).not.toHaveBeenCalled();
    expect(prisma.auctionLiveVoiceCue.create).not.toHaveBeenCalled();
  });

  it('лот вне торгов в эфир не выходит', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ status: 'QUEUED' }),
    );
    await service.activateLiveStream('l1');

    expect(prisma.auctionListing.updateMany).not.toHaveBeenCalled();
  });

  it('несуществующий лот не роняет вызов', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(null);
    await expect(service.activateLiveStream('нет')).resolves.toBeUndefined();
  });

  it('включение эфира защищено условием liveStreamActive: false — второй вызов не переписывает состояние', async () => {
    // Метод зовут из ДВУХ мест (продвижение очереди и назначение студии),
    // и update без этого условия сбрасывал бы отметку начала эфира.
    const { service, prisma } = build();
    await service.activateLiveStream('l1');

    const [args] = prisma.auctionListing.updateMany.mock.calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    expect(args.where).toEqual({ id: 'l1', liveStreamActive: false });
    expect(args.data.liveStreamActive).toBe(true);
    expect(args.data.liveStreamEndedAt).toBeNull();
  });

  it('повторный выход в эфир сохраняет ИСХОДНОЕ время начала', async () => {
    const started = new Date(NOW.getTime() - 30 * MIN);
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ liveStreamStartedAt: started }),
    );
    await service.activateLiveStream('l1');

    const [args] = prisma.auctionListing.updateMany.mock.calls[0] as [
      { data: { liveStreamStartedAt: Date } },
    ];
    expect(args.data.liveStreamStartedAt).toBe(started);
  });

  it('Google узнаёт о начале эфира только при РЕАЛЬНОМ переходе', async () => {
    const real = build();
    await real.service.activateLiveStream('l1');
    await flush();
    expect(real.googleIndexing.notify).toHaveBeenCalledTimes(1);
    expect(real.googleIndexing.notify.mock.calls[0][1]).toBe('URL_UPDATED');

    // count: 0 — лот уже был в эфире, второй «эфир начался» Google не нужен.
    const idempotent = build();
    idempotent.prisma.auctionListing.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    await idempotent.service.activateLiveStream('l1');
    await flush();
    expect(idempotent.googleIndexing.notify).not.toHaveBeenCalled();
  });

  it('три pregen-реплики заводятся один раз, в нужном порядке', async () => {
    const { service, prisma } = build();
    await service.activateLiveStream('l1');

    const kinds = prisma.auctionLiveVoiceCue.create.mock.calls.map(
      ([a]: [{ data: { kind: string; triggeredBy: string } }]) => a.data.kind,
    );
    expect(kinds).toEqual(['LOT_DESC', 'INVITE', 'PRAISE']);
    for (const [args] of prisma.auctionLiveVoiceCue.create.mock.calls as [
      { data: { triggeredBy: string; bidId: null } },
    ][]) {
      expect(args.data.triggeredBy).toBe('PREGEN');
      expect(args.data.bidId).toBeNull();
    }
  });

  it('pregen-реплики уже есть — повторный вызов их не задваивает', async () => {
    const { service, prisma } = build();
    prisma.auctionLiveVoiceCue.count.mockResolvedValueOnce(3);
    await service.activateLiveStream('l1');

    expect(prisma.auctionLiveVoiceCue.create).not.toHaveBeenCalled();
    // При этом сам эфир включить всё равно пытаемся — лот мог быть свёрнут.
    expect(prisma.auctionListing.updateMany).toHaveBeenCalled();
  });

  it('описание лота собирается из данных лота, когда разбора студии нет', async () => {
    const { service, provider } = build();
    await service.activateLiveStream('l1');

    const lotDesc = provider.synthesize.mock.calls[0][0].text as string;
    expect(lotDesc).toContain('Блиц-лот');
    expect(lotDesc).toContain('Ролик про кружку');
    expect(lotDesc).toContain('1000 грн'); // мажорные единицы + подпись валюты
    expect(lotDesc).not.toContain('100000');
  });

  it('обычный лот называется лотом, а не блиц-лотом, и валюта берётся своя', async () => {
    const { service, prisma, provider } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({
        auctionType: 'STANDARD',
        payoutCurrency: 'USD',
        startingPrice: 25_000,
        portfolioItem: { title: 'Промо', collectionTag: 'весна' },
      }),
    );
    await service.activateLiveStream('l1');

    const lotDesc = provider.synthesize.mock.calls[0][0].text as string;
    expect(lotDesc).toContain('Лот «Промо»');
    expect(lotDesc).not.toContain('Блиц-лот');
    expect(lotDesc).toContain('категория «весна»');
    expect(lotDesc).toContain('250 $');
  });

  it('готовый разбор студии переиспользуется вместо собранного описания', async () => {
    const { service, prisma, provider } = build();
    prisma.virtualStudioFragment.findFirst.mockResolvedValueOnce({
      resultText: '  Авторский разбор ролика от ведущей.  ',
    });
    await service.activateLiveStream('l1');

    expect(provider.synthesize.mock.calls[0][0].text).toBe(
      'Авторский разбор ролика от ведущей.',
    );
  });

  it('пустой разбор студии не вытесняет собранное описание', async () => {
    const { service, prisma, provider } = build();
    prisma.virtualStudioFragment.findFirst.mockResolvedValueOnce({
      resultText: '   ',
    });
    await service.activateLiveStream('l1');

    expect(provider.synthesize.mock.calls[0][0].text).toContain('Блиц-лот');
  });

  it('сбой БД не пробрасывается наружу — хук best-effort', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockRejectedValueOnce(
      new Error('db is down'),
    );
    await expect(service.activateLiveStream('l1')).resolves.toBeUndefined();
  });
});

// ── Реплика на ставку ────────────────────────────────────────────────

describe('onBidPlaced', () => {
  const bid = { id: 'b1', amount: 250_000 };

  it('лот без студии реплик не получает', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ virtualStudioId: null }),
    );
    await service.onBidPlaced('l1', bid);

    expect(prisma.auctionLiveVoiceCue.create).not.toHaveBeenCalled();
    expect(prisma.auctionListing.update).not.toHaveBeenCalled();
  });

  it('ставка возвращает в эфир свёрнутый лот и сообщает об этом Google', async () => {
    const { service, prisma, googleIndexing } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ liveStreamActive: false }),
    );
    await service.onBidPlaced('l1', bid);
    await flush();

    expect(prisma.auctionListing.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { liveStreamActive: true, liveStreamEndedAt: null },
    });
    expect(googleIndexing.notify).toHaveBeenCalledTimes(1);
  });

  it('эфир уже идёт — лишней записи и лишнего сигнала Google нет', async () => {
    const { service, prisma, googleIndexing } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ liveStreamActive: true }),
    );
    await service.onBidPlaced('l1', bid);
    await flush();

    expect(prisma.auctionListing.update).not.toHaveBeenCalled();
    expect(googleIndexing.notify).not.toHaveBeenCalled();
  });

  it('потолок реплик в минуту останавливает ПЛАТНЫЙ синтез', async () => {
    // Горячий блиц-лот — «до сотен ставок» по ТЗ; без потолка это
    // неограниченная серия платных вызовов провайдера за секунды.
    const { service, prisma, provider } = build();
    prisma.auctionLiveVoiceCue.count.mockResolvedValueOnce(4);
    await service.onBidPlaced('l1', bid);

    expect(provider.synthesize).not.toHaveBeenCalled();
    expect(prisma.auctionLiveVoiceCue.create).not.toHaveBeenCalled();
  });

  it('под потолком реплика синтезируется', async () => {
    const { service, prisma, provider } = build();
    prisma.auctionLiveVoiceCue.count.mockResolvedValueOnce(3);
    await service.onBidPlaced('l1', bid);

    expect(provider.synthesize).toHaveBeenCalledTimes(1);
  });

  it('потолок не мешает вернуть свёрнутый эфир — ставка важнее реплики', async () => {
    const { service, prisma, provider } = build();
    prisma.auctionListing.findUnique.mockResolvedValueOnce(
      listingRow({ liveStreamActive: false }),
    );
    prisma.auctionLiveVoiceCue.count.mockResolvedValueOnce(10);
    await service.onBidPlaced('l1', bid);

    expect(prisma.auctionListing.update).toHaveBeenCalled(); // эфир вернули
    expect(provider.synthesize).not.toHaveBeenCalled(); // реплику — нет
  });

  it('окно потолка — ровно последняя минута', async () => {
    const { service, prisma } = build();
    await service.onBidPlaced('l1', bid);

    const [args] = prisma.auctionLiveVoiceCue.count.mock.calls[0] as [
      { where: { kind: string; createdAt: { gte: Date } } },
    ];
    expect(args.where.kind).toBe('BID_STATS');
    expect(args.where.createdAt.gte.getTime()).toBe(NOW.getTime() - MIN);
  });

  it('текст реплики называет сумму в мажорных единицах и число УЧАСТНИКОВ, а не ставок', async () => {
    const { service, prisma, provider } = build();
    // Три ставки, но два разных покупателя — groupBy по buyerId.
    prisma.bid.groupBy.mockResolvedValueOnce([
      { buyerId: 'b1' },
      { buyerId: 'b2' },
    ]);
    await service.onBidPlaced('l1', bid);

    const text = provider.synthesize.mock.calls[0][0].text as string;
    expect(text).toContain('2500 грн');
    expect(text).not.toContain('250000');
    expect(text).toContain('2 участников');
  });

  it('единственный участник называется в единственном числе', async () => {
    const { service, prisma, provider } = build();
    prisma.bid.groupBy.mockResolvedValueOnce([{ buyerId: 'b1' }]);
    await service.onBidPlaced('l1', bid);

    expect(provider.synthesize.mock.calls[0][0].text).toContain(
      'один участник',
    );
  });

  it('реплика привязывается к конкретной ставке', async () => {
    const { service, prisma } = build();
    await service.onBidPlaced('l1', bid);

    const [args] = prisma.auctionLiveVoiceCue.create.mock.calls[0] as [
      { data: { kind: string; triggeredBy: string; bidId: string } },
    ];
    expect(args.data).toMatchObject({
      kind: 'BID_STATS',
      triggeredBy: 'BID',
      bidId: 'b1',
    });
  });

  it('сбой не пробрасывается — приём ставки уже состоялся', async () => {
    const { service, prisma } = build();
    prisma.bid.groupBy.mockRejectedValueOnce(new Error('db is down'));
    await expect(service.onBidPlaced('l1', bid)).resolves.toBeUndefined();
  });
});

// ── Синтез одной реплики ─────────────────────────────────────────────

describe('синтез реплики', () => {
  it('номер реплики берётся под advisory-локом и продолжает максимум', async () => {
    const { service, prisma } = build();
    prisma.auctionLiveVoiceCue.aggregate.mockResolvedValue({
      _max: { seq: 7 },
    });
    await service.onBidPlaced('l1', { id: 'b1', amount: 1000 });

    const [chunks] = prisma.$executeRaw.mock.calls[0] as [string[]];
    expect(chunks.join('?')).toContain('pg_advisory_xact_lock');
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.auctionLiveVoiceCue.aggregate.mock.invocationCallOrder[0],
    );

    const [args] = prisma.auctionLiveVoiceCue.create.mock.calls[0] as [
      { data: { seq: number } },
    ];
    expect(args.data.seq).toBe(8);
  });

  it('первая реплика лота получает номер 1', async () => {
    const { service, prisma } = build();
    await service.onBidPlaced('l1', { id: 'b1', amount: 1000 });

    const [args] = prisma.auctionLiveVoiceCue.create.mock.calls[0] as [
      { data: { seq: number } },
    ];
    expect(args.data.seq).toBe(1);
  });

  it('заглушка заводится со статусом pending ДО платного вызова', async () => {
    const { service, prisma, provider } = build();
    await service.onBidPlaced('l1', { id: 'b1', amount: 1000 });

    const [args] = prisma.auctionLiveVoiceCue.create.mock.calls[0] as [
      { data: { status: string } },
    ];
    expect(args.data.status).toBe('pending');
    expect(
      prisma.auctionLiveVoiceCue.create.mock.invocationCallOrder[0],
    ).toBeLessThan(provider.synthesize.mock.invocationCallOrder[0]);
  });

  it('успех: расход записан, аудио загружено, фрагмент и реплика доведены до complete', async () => {
    const { service, prisma, blob, aiUsage } = build();
    await service.onBidPlaced('l1', { id: 'b1', amount: 1000 });

    expect(aiUsage.record).toHaveBeenCalledWith({
      operation: 'virtual-studio-voice',
      model: 'elevenlabs-tts',
      characters: 42,
    });
    expect(blob.uploadBuffer).toHaveBeenCalledWith(
      'virtual-studio/vs1/live-voice-cue-cue-1.mp3',
      expect.any(Buffer),
      'audio/mpeg',
    );
    expect(prisma.virtualStudioFragment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        studioId: 'vs1',
        kind: 'VOICE',
        status: 'complete',
        provider: 'elevenlabs',
        resultUrl: 'https://blob.test/cue.mp3',
      }),
    });
    expect(prisma.auctionLiveVoiceCue.update).toHaveBeenCalledWith({
      where: { id: 'cue-1' },
      data: {
        voiceFragmentId: 'fr-voice',
        status: 'complete',
        readyAt: expect.any(Date),
      },
    });
  });

  it('провайдер не настроен — реплика помечается failed, денег не тратим', async () => {
    const { service, prisma, blob, aiUsage, provider } = build({
      configured: false,
    });
    await service.onBidPlaced('l1', { id: 'b1', amount: 1000 });

    expect(provider.synthesize).not.toHaveBeenCalled();
    expect(aiUsage.record).not.toHaveBeenCalled();
    expect(blob.uploadBuffer).not.toHaveBeenCalled();
    expect(prisma.auctionLiveVoiceCue.update).toHaveBeenCalledWith({
      where: { id: 'cue-1' },
      data: { status: 'failed' },
    });
  });

  it('провайдер отказал — реплика failed, расход не записывается', async () => {
    const { service, prisma, aiUsage } = build({ synthOk: false });
    await service.onBidPlaced('l1', { id: 'b1', amount: 1000 });

    expect(aiUsage.record).not.toHaveBeenCalled();
    expect(prisma.auctionLiveVoiceCue.update).toHaveBeenCalledWith({
      where: { id: 'cue-1' },
      data: { status: 'failed' },
    });
  });

  it('падение посреди синтеза не оставляет реплику висеть в pending', async () => {
    const { service, prisma, blob } = build();
    blob.uploadBuffer.mockRejectedValueOnce(new Error('blob store 503'));
    await service.onBidPlaced('l1', { id: 'b1', amount: 1000 });

    expect(prisma.auctionLiveVoiceCue.update).toHaveBeenCalledWith({
      where: { id: 'cue-1' },
      data: { status: 'failed' },
    });
  });

  it('сбой резервирования номера не доходит до платного вызова', async () => {
    const { service, prisma, provider } = build();
    prisma.$transaction.mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(
      service.onBidPlaced('l1', { id: 'b1', amount: 1000 }),
    ).resolves.toBeUndefined();

    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it('одна несинтезировавшаяся pregen-реплика не отменяет остальные две', async () => {
    const { service, prisma, blob } = build();
    blob.uploadBuffer.mockRejectedValueOnce(new Error('blob store 503'));
    await service.activateLiveStream('l1');

    expect(prisma.auctionLiveVoiceCue.create).toHaveBeenCalledTimes(3);
    expect(cueTexts(blob)).toHaveLength(3);
  });
});

// ── Авто-сворачивание ────────────────────────────────────────────────

describe('collapseInactiveStreams', () => {
  const quiet = (over: Record<string, unknown> = {}) =>
    listingRow({
      liveStreamActive: true,
      liveStreamStartedAt: new Date(NOW.getTime() - 60 * MIN),
      ...over,
    });

  it('лот без ставок дольше 15 минут сворачивается, Google узнаёт', async () => {
    const { service, prisma, googleIndexing } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([quiet()]);

    const result = await service.collapseInactiveStreams();
    await flush();

    expect(result.collapsed).toBe(1);
    expect(prisma.auctionListing.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { liveStreamActive: false, liveStreamEndedAt: expect.any(Date) },
    });
    expect(googleIndexing.notify).toHaveBeenCalledTimes(1);
  });

  it('свежая ставка удерживает эфир, даже если он начался давно', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      quiet({ bids: [{ createdAt: new Date(NOW.getTime() - MIN) }] }),
    ]);

    const result = await service.collapseInactiveStreams();
    expect(result.collapsed).toBe(0);
    expect(prisma.auctionListing.update).not.toHaveBeenCalled();
  });

  it('старая ставка эфир не удерживает', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      quiet({
        liveStreamStartedAt: new Date(NOW.getTime() - MIN), // эфир начат недавно…
        bids: [{ createdAt: new Date(NOW.getTime() - 20 * MIN) }], // …но ставка старая
      }),
    ]);

    // Последняя активность — именно ставка, а не начало эфира: иначе
    // перезапущенный эфир висел бы бесконечно.
    const result = await service.collapseInactiveStreams();
    expect(result.collapsed).toBe(1);
  });

  it('только что начатый эфир без ставок не сворачивается', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      quiet({ liveStreamStartedAt: new Date(NOW.getTime() - MIN) }),
    ]);

    expect((await service.collapseInactiveStreams()).collapsed).toBe(0);
  });

  it('эфир без отметки начала и без ставок не трогается', async () => {
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      quiet({ liveStreamStartedAt: null, bids: [] }),
    ]);

    expect((await service.collapseInactiveStreams()).collapsed).toBe(0);
    expect(prisma.auctionListing.update).not.toHaveBeenCalled();
  });

  it('сбой на одном лоте не обрывает обработку остальных', async () => {
    // Аудит-фикс: без изоляции один сбойный update оставлял бы остальные
    // кандидаты тика необработанными до следующего прогона крона.
    const { service, prisma } = build();
    prisma.auctionListing.findMany.mockResolvedValueOnce([
      quiet({ id: 'плохой' }),
      quiet({ id: 'хороший' }),
    ]);
    prisma.auctionListing.update
      .mockRejectedValueOnce(new Error('row is locked'))
      .mockResolvedValueOnce({});

    const result = await service.collapseInactiveStreams();
    expect(result.collapsed).toBe(1);
    expect(prisma.auctionListing.update).toHaveBeenCalledTimes(2);
  });

  it('берутся только лоты, которые сейчас в эфире и в торгах', async () => {
    const { service, prisma } = build();
    await service.collapseInactiveStreams();

    const [args] = prisma.auctionListing.findMany.mock.calls[0] as [
      { where: Record<string, unknown>; include: Record<string, unknown> },
    ];
    expect(args.where).toEqual({ liveStreamActive: true, status: 'ACTIVE' });
    expect(args.include).toEqual({
      bids: { orderBy: { createdAt: 'desc' }, take: 1 },
    });
  });

  it('зависшие pending-реплики старше двух минут помечаются failed', async () => {
    const { service, prisma } = build();
    prisma.auctionLiveVoiceCue.updateMany.mockResolvedValueOnce({ count: 5 });

    const result = await service.collapseInactiveStreams();

    const [args] = prisma.auctionLiveVoiceCue.updateMany.mock.calls[0] as [
      { where: { status: string; createdAt: { lt: Date } }; data: unknown },
    ];
    expect(args.where.status).toBe('pending');
    expect(args.where.createdAt.lt.getTime()).toBe(NOW.getTime() - 2 * MIN);
    expect(args.data).toEqual({ status: 'failed' });
    expect(result.reapedStalePendingCues).toBe(5);
  });
});
