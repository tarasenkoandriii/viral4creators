/**
 * Контроллеры аукциона. Делегирование в сервис тестировать по одному
 * методу смысла мало — но три вещи здесь стоят проверки, потому что
 * ломаются молча и наружу выглядят как «всё работает»:
 *
 *  1. ЧЕЙ идентификатор уходит в сервис. Все личные ручки берут
 *     `req.telegramUserId`, проставленный гардом. Перепутать его с любым
 *     другим полем запроса — значит дать одному человеку действовать от
 *     имени другого: снять чужой лот, поставить за чужой счёт, забрать
 *     чужую оплату. Ни один тип этого не поймает: там везде string.
 *  2. Порядок «сначала проверка прав оператора, потом действие» в
 *     админских ручках. Если `assertOperator` уедет ПОСЛЕ вызова
 *     сервиса, отказ будет приходить уже после того, как лот одобрен.
 *  3. SSE-стрим эфира — единственный кусок настоящей логики в этом
 *     файле: курсоры, самозавершение по таймеру, реакция на отключение
 *     клиента и гарантия, что ответ будет закрыт в любом случае.
 */

import {
  AdminAuctionController,
  AuctionController,
  PublicAuctionController,
} from './auction.controller';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

const USER = 'tg-user-1';

function serviceMock() {
  return {
    create: jest.fn().mockResolvedValue({ id: 'l1' }),
    listMine: jest.fn().mockResolvedValue([]),
    listMyBids: jest.fn().mockResolvedValue([]),
    withdraw: jest.fn().mockResolvedValue({ id: 'l1' }),
    placeBid: jest.fn().mockResolvedValue({ id: 'b1' }),
    startCheckout: jest.fn().mockResolvedValue({ wayforpayFormUrl: 'u' }),
    listPublic: jest.fn().mockResolvedValue([]),
    getPublic: jest.fn().mockResolvedValue({ id: 'l1' }),
    getLiveState: jest.fn().mockResolvedValue({ listingId: 'l1' }),
    getLiveUpdates: jest.fn().mockResolvedValue({ bids: [], cues: [] }),
    adminList: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    adminApprove: jest.fn().mockResolvedValue({ id: 'l1' }),
    adminReject: jest.fn().mockResolvedValue({ id: 'l1' }),
    adminConfirmPayment: jest.fn().mockResolvedValue({ id: 'l1' }),
    assignVirtualStudio: jest.fn().mockResolvedValue({ id: 'l1' }),
  };
}

/**
 * Запрос содержит и `telegramUserId` (от гарда), и посторонние поля,
 * похожие на идентификатор пользователя: контроллер обязан брать именно
 * первый.
 */
const identifiedRequest = () =>
  ({
    telegramUserId: USER,
    userId: 'подделка-из-тела',
    body: { userId: 'подделка-из-тела' },
    query: { userId: 'подделка-из-тела' },
  }) as never;

describe('AuctionController — личные ручки', () => {
  const cases: Array<
    [string, (c: AuctionController) => Promise<unknown>, string]
  > = [
    [
      'create',
      (c) => c.create(identifiedRequest(), { a: 1 } as never),
      'create',
    ],
    ['mine', (c) => c.mine(identifiedRequest()), 'listMine'],
    ['my-bids', (c) => c.myBids(identifiedRequest()), 'listMyBids'],
    ['withdraw', (c) => c.withdraw(identifiedRequest(), 'l1'), 'withdraw'],
    [
      'placeBid',
      (c) => c.placeBid(identifiedRequest(), 'l1', { amount: 10 } as never),
      'placeBid',
    ],
    [
      'checkout',
      (c) => c.startCheckout(identifiedRequest(), 'l1'),
      'startCheckout',
    ],
  ];

  it.each(cases)(
    '%s передаёт в сервис идентификатор ОТ ГАРДА, а не из тела запроса',
    async (_name, call, method) => {
      const service = serviceMock();
      await call(new AuctionController(service as never));

      const fn = service[method as keyof typeof service] as jest.Mock;
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn.mock.calls[0][0]).toBe(USER);
      expect(fn.mock.calls[0][0]).not.toBe('подделка-из-тела');
    },
  );

  it('идентификатор лота и тело доходят до сервиса без изменений', async () => {
    const service = serviceMock();
    const controller = new AuctionController(service as never);
    const dto = { amount: 1999.99 } as never;

    await controller.placeBid(identifiedRequest(), 'lot-42', dto);
    expect(service.placeBid).toHaveBeenCalledWith(USER, 'lot-42', dto);

    await controller.withdraw(identifiedRequest(), 'lot-42');
    expect(service.withdraw).toHaveBeenCalledWith(USER, 'lot-42');
  });
});

describe('PublicAuctionController — витрина', () => {
  it('список и карточка идут в публичные методы сервиса', async () => {
    const service = serviceMock();
    const controller = new PublicAuctionController(service as never);

    await controller.list();
    expect(service.listPublic).toHaveBeenCalledTimes(1);

    await controller.get('l1');
    expect(service.getPublic).toHaveBeenCalledWith('l1');
    // Витрина НЕ должна ходить в приватную проекцию.
    expect(service.listMine).not.toHaveBeenCalled();
  });

  it('снимок эфира отдаётся через getLiveState', async () => {
    const service = serviceMock();
    await new PublicAuctionController(service as never).state('l1');
    expect(service.getLiveState).toHaveBeenCalledWith('l1');
  });
});

// ── SSE-стрим эфира ──────────────────────────────────────────────────

interface FakeRes {
  writeHead: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  status: jest.Mock;
  json: jest.Mock;
  on: jest.Mock;
  off: jest.Mock;
  writableEnded: boolean;
}

function makeReqRes() {
  const handlers: Record<string, Array<() => void>> = {};
  const on = jest.fn((event: string, fn: () => void) => {
    (handlers[event] ??= []).push(fn);
  });
  const off = jest.fn((event: string, fn: () => void) => {
    handlers[event] = (handlers[event] ?? []).filter((h) => h !== fn);
  });
  const res: FakeRes = {
    writeHead: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(function (this: FakeRes) {
      res.writableEnded = true;
    }),
    status: jest.fn(() => res),
    json: jest.fn(() => res),
    on,
    off,
    writableEnded: false,
  };
  const req = { on, off };
  /** Имитирует разрыв соединения клиентом. */
  const closeConnection = () =>
    [...(handlers['close'] ?? [])].forEach((fn) => fn());
  return { req, res, closeConnection };
}

/** Разбирает записанные в поток SSE-кадры. */
const framesOf = (res: FakeRes) =>
  res.write.mock.calls
    .map(([chunk]) => chunk as string)
    .filter((c) => c.startsWith('event:'))
    .map((c) => {
      const [, event] = /^event: (\w+)/.exec(c) ?? [];
      const [, data] = /data: (.*)\n\n$/s.exec(c) ?? [];
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });

describe('PublicAuctionController.stream — SSE живого эфира', () => {
  beforeEach(() => {
    jest
      .useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-09-21T12:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('несуществующий лот — 404 JSON, поток не открывается', async () => {
    const service = serviceMock();
    service.getLiveState.mockRejectedValueOnce(new Error('not found'));
    const { req, res } = makeReqRes();

    await new PublicAuctionController(service as never).stream(
      'нет',
      req as never,
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'not_found', message: 'auction listing not found' },
    });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(service.getLiveUpdates).not.toHaveBeenCalled();
  });

  it('заголовки потока запрещают кеширование и буферизацию прокси', async () => {
    // Без no-transform/X-Accel-Buffering прокси может копить ответ и
    // отдавать его пачкой — для эфира это те же секунды задержки, ради
    // ухода от которых стрим и заводили.
    const service = serviceMock();
    const { req, res, closeConnection } = makeReqRes();

    const streaming = new PublicAuctionController(service as never).stream(
      'l1',
      req as never,
      res as never,
    );
    await Promise.resolve();
    closeConnection();
    await jest.advanceTimersByTimeAsync(3000);
    await streaming;

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  });

  it('новые ставки и подсказки уходят событиями bid и cue', async () => {
    const service = serviceMock();
    service.getLiveUpdates.mockResolvedValueOnce({
      bids: [{ id: 'b1', amount: 2500, createdAt: '2026-09-21T12:00:05.000Z' }],
      cues: [
        { id: 'c1', seq: 4, kind: 'BID_STATS', audioUrl: 'https://a/1.mp3' },
      ],
    });
    const { req, res, closeConnection } = makeReqRes();

    const streaming = new PublicAuctionController(service as never).stream(
      'l1',
      req as never,
      res as never,
    );
    await Promise.resolve();
    closeConnection();
    await jest.advanceTimersByTimeAsync(3000);
    await streaming;

    const frames = framesOf(res);
    expect(frames.map((f) => f.event)).toEqual(['bid', 'cue']);
    expect(frames[0].data).toMatchObject({ id: 'b1', amount: 2500 });
    expect(frames[1].data).toMatchObject({
      seq: 4,
      audioUrl: 'https://a/1.mp3',
    });
  });

  it('курсоры сдвигаются — второй опрос не переспрашивает уже отданное', async () => {
    const service = serviceMock();
    service.getLiveUpdates
      .mockResolvedValueOnce({
        bids: [
          { id: 'b1', amount: 10, createdAt: '2026-09-21T12:00:05.000Z' },
          { id: 'b2', amount: 20, createdAt: '2026-09-21T12:00:07.000Z' },
        ],
        cues: [
          { id: 'c1', seq: 3, kind: 'BID_STATS', audioUrl: 'a' },
          { id: 'c2', seq: 9, kind: 'PRAISE', audioUrl: 'b' },
        ],
      })
      .mockResolvedValue({ bids: [], cues: [] });
    const { req, res, closeConnection } = makeReqRes();

    const streaming = new PublicAuctionController(service as never).stream(
      'l1',
      req as never,
      res as never,
    );
    await jest.advanceTimersByTimeAsync(2500);
    closeConnection();
    await jest.advanceTimersByTimeAsync(3000);
    await streaming;

    const secondCall = service.getLiveUpdates.mock.calls[1];
    expect(secondCall[1]).toEqual(new Date('2026-09-21T12:00:07.000Z')); // последняя ставка
    expect(secondCall[2]).toBe(9); // максимальный seq, а не последний по порядку
  });

  it('первый опрос берёт всё с момента подключения, а не с начала эфира', async () => {
    // История до подключения приходит отдельным снимком GET /state —
    // иначе зритель получил бы её дважды.
    const service = serviceMock();
    const { req, res, closeConnection } = makeReqRes();
    const connectedAt = Date.now();

    const streaming = new PublicAuctionController(service as never).stream(
      'l1',
      req as never,
      res as never,
    );
    await Promise.resolve();
    closeConnection();
    await jest.advanceTimersByTimeAsync(3000);
    await streaming;

    const [id, sinceBidAt, sinceSeq] = service.getLiveUpdates.mock.calls[0];
    expect(id).toBe('l1');
    expect(sinceBidAt).toBeInstanceOf(Date);
    expect((sinceBidAt as Date).getTime()).toBe(connectedAt);
    expect(sinceSeq).toBe(0);
  });

  it('отключение клиента останавливает опрос', async () => {
    const service = serviceMock();
    const { req, res, closeConnection } = makeReqRes();

    const streaming = new PublicAuctionController(service as never).stream(
      'l1',
      req as never,
      res as never,
    );
    await jest.advanceTimersByTimeAsync(2500);
    const callsBeforeClose = service.getLiveUpdates.mock.calls.length;
    closeConnection();
    await jest.advanceTimersByTimeAsync(20_000);
    await streaming;

    expect(service.getLiveUpdates.mock.calls.length).toBeLessThanOrEqual(
      callsBeforeClose + 1,
    );
    expect(res.end).toHaveBeenCalled();
  });

  it('поток закрывается сам, не дожидаясь лимита serverless-функции', async () => {
    const service = serviceMock();
    const { req, res } = makeReqRes();

    const streaming = new PublicAuctionController(service as never).stream(
      'l1',
      req as never,
      res as never,
    );
    await jest.advanceTimersByTimeAsync(70_000);
    await streaming;

    expect(res.end).toHaveBeenCalled();
    // 55 секунд при опросе раз в 2 секунды — около 28 проходов; главное,
    // что цикл ЗАВЕРШИЛСЯ, а не крутится дальше.
    expect(service.getLiveUpdates.mock.calls.length).toBeLessThan(40);
  });

  it('heartbeat уходит комментарием, а не событием', async () => {
    const service = serviceMock();
    const { req, res } = makeReqRes();

    const streaming = new PublicAuctionController(service as never).stream(
      'l1',
      req as never,
      res as never,
    );
    await jest.advanceTimersByTimeAsync(70_000);
    await streaming;

    const heartbeats = res.write.mock.calls.filter(
      ([c]) => (c as string) === ': heartbeat\n\n',
    );
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(framesOf(res)).toHaveLength(0); // ни одного bid/cue не выдумано
  });

  it('сбой опроса закрывает соединение, а не роняет обработчик', async () => {
    const service = serviceMock();
    service.getLiveUpdates.mockRejectedValueOnce(new Error('db gone'));
    const { req, res } = makeReqRes();

    await expect(
      new PublicAuctionController(service as never).stream(
        'l1',
        req as never,
        res as never,
      ),
    ).resolves.toBeUndefined();

    expect(res.end).toHaveBeenCalled();
  });

  it('подписки на close снимаются — обработчики не копятся на каждом подключении', async () => {
    const service = serviceMock();
    const { req, res } = makeReqRes();

    const streaming = new PublicAuctionController(service as never).stream(
      'l1',
      req as never,
      res as never,
    );
    await jest.advanceTimersByTimeAsync(70_000);
    await streaming;

    expect(req.off).toHaveBeenCalledWith('close', expect.any(Function));
    expect(res.off).toHaveBeenCalledWith('close', expect.any(Function));
  });
});

// ── Админские ручки ──────────────────────────────────────────────────

describe('AdminAuctionController', () => {
  const adminRequest = () => ({ userId: 'admin-1' }) as never;

  function build() {
    const service = serviceMock();
    const adminPanel = {
      assertOperator: jest.fn().mockResolvedValue(undefined),
    };
    return {
      controller: new AdminAuctionController(
        service as never,
        adminPanel as never,
      ),
      service,
      adminPanel,
    };
  }

  const actions: Array<
    [string, (c: AdminAuctionController) => Promise<unknown>, string]
  > = [
    ['список', (c) => c.list(adminRequest()), 'adminList'],
    ['одобрение', (c) => c.approve(adminRequest(), 'l1'), 'adminApprove'],
    [
      'отклонение',
      (c) => c.reject(adminRequest(), 'l1', { reason: 'нет прав' } as never),
      'adminReject',
    ],
    [
      'подтверждение оплаты',
      (c) => c.confirmPayment(adminRequest(), 'l1'),
      'adminConfirmPayment',
    ],
    [
      'назначение студии',
      (c) =>
        c.assignStudio(adminRequest(), 'l1', {
          virtualStudioId: 'vs1',
        } as never),
      'assignVirtualStudio',
    ],
  ];

  it.each(actions)(
    '%s: права оператора проверяются ДО действия',
    async (_name, call, method) => {
      const { controller, service, adminPanel } = build();
      await call(controller);

      expect(adminPanel.assertOperator).toHaveBeenCalledWith('admin-1');
      const fn = service[method as keyof typeof service] as jest.Mock;
      expect(
        adminPanel.assertOperator.mock.invocationCallOrder[0],
      ).toBeLessThan(fn.mock.invocationCallOrder[0]);
    },
  );

  it.each(actions)(
    '%s: отказ в правах не доходит до сервиса',
    async (_name, call, method) => {
      const { controller, service, adminPanel } = build();
      adminPanel.assertOperator.mockRejectedValueOnce(
        new Error('not an operator'),
      );

      await expect(call(controller)).rejects.toThrow('not an operator');
      expect(service[method as keyof typeof service]).not.toHaveBeenCalled();
    },
  );

  it('страница и размер страницы приводятся к разумным границам', async () => {
    const { controller, service } = build();

    await controller.list(adminRequest(), undefined, undefined, undefined);
    expect(service.adminList).toHaveBeenLastCalledWith({
      status: undefined,
      page: 1,
      pageSize: 20,
    });

    await controller.list(adminRequest(), 'QUEUED', '3', '50');
    expect(service.adminList).toHaveBeenLastCalledWith({
      status: 'QUEUED',
      page: 3,
      pageSize: 50,
    });
  });

  it('мусор и выходящие за границы значения не доходят до запроса к БД', async () => {
    // pageSize=100000 — это не «широкая страница», а выгрузка всей
    // таблицы одним запросом по чужому желанию; page=0 дал бы
    // отрицательный skip.
    const { controller, service } = build();

    await controller.list(adminRequest(), undefined, '0', '100000');
    expect(service.adminList).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 100 }),
    );

    // Отрицательная страница поднимается до первой, а не даёт
    // отрицательный skip.
    await controller.list(adminRequest(), undefined, '-5', '7');
    expect(service.adminList).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 7 }),
    );

    // Нечисловой ввод и ноль одинаково откатываются на значения по
    // умолчанию: `parseInt('abc')` даёт NaN, а ноль ложен — обе ветки
    // ловит один и тот же `|| 20`.
    await controller.list(adminRequest(), undefined, 'abc', 'xyz');
    expect(service.adminList).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 20 }),
    );
    await controller.list(adminRequest(), undefined, '0', '0');
    expect(service.adminList).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 20 }),
    );
  });
});
