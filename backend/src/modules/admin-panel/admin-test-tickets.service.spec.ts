import { AdminTestTicketsService } from './admin-test-tickets.service';

const NOW = new Date('2026-09-26T12:00:00.000Z');

const ENV = {
  surface: 'TMA',
  osFamily: 'ios',
  osVersion: '18.1',
  deviceKind: 'PHONE',
  viewport: { w: 390, h: 760 },
  uiLocale: 'uk',
  appBuild: '2026.09.25-a1b2c3d',
};

function ticket(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    number: 14,
    createdAt: NOW,
    source: 'BOT',
    status: 'NEW',
    text: 'кнопка не нажимается\nвообще никак',
    scenario: null,
    uiLocale: 'uk',
    envKey: '-:-:tma:ios:uk',
    env: ENV,
    envCapturedAt: NOW,
    appBuild: '2026.09.25-a1b2c3d',
    sessionId: null,
    sessionLocale: null,
    stepId: null,
    attachments: [{ url: 'a' }],
    comments: [],
    statusBy: null,
    statusAt: null,
    statusNote: null,
    replySentAt: null,
    replyFailedAt: null,
    userId: 'u1',
    user: {
      id: 'u1',
      telegramId: '42',
      firstName: 'Андрій',
      username: 'andrii',
      botChatOpenedAt: new Date('2026-09-20T00:00:00.000Z'),
    },
    ...over,
  };
}

function build(
  over: {
    row?: Record<string, unknown> | null;
    same?: unknown[];
    sameTotal?: number;
  } = {},
) {
  const row = over.row === undefined ? ticket() : over.row;
  const prisma = {
    testTicket: {
      findMany: jest.fn().mockResolvedValue(over.same ?? []),
      count: jest.fn().mockResolvedValue(over.sameTotal ?? 0),
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const notify = {
    dmWithId: jest.fn().mockResolvedValue({ ok: true, messageId: 700 }),
  };
  const aiUsage = { spentTodayByUsers: jest.fn().mockResolvedValue({}) };
  return {
    service: new AdminTestTicketsService(
      prisma as never,
      notify as never,
      aiUsage as never,
    ),
    prisma,
    notify,
    aiUsage,
  };
}

describe('список находок', () => {
  it('«открытые» — это вопрос «что ждёт нас», а не статус', async () => {
    const { service, prisma } = build();
    prisma.testTicket.findMany.mockResolvedValue([ticket()]);
    await service.list({ status: 'OPEN' });
    expect(prisma.testTicket.findMany.mock.calls[0][0].where.status).toEqual({
      in: ['NEW', 'IN_PROGRESS', 'ANSWERED'],
    });
  });

  it('незнакомый статус не превращается в фильтр', async () => {
    // Иначе опечатка в адресной строке показывала бы пустую очередь и
    // читалась как «находок нет».
    const { service, prisma } = build();
    await service.list({ status: 'ЧЕПУХА' });
    expect(prisma.testTicket.findMany.mock.calls[0][0].where).toEqual({});
  });

  it('фильтр по окружению — это и есть «у всех или у него одного»', async () => {
    const { service, prisma } = build();
    await service.list({ envKey: '-:-:tma:ios:uk' });
    expect(prisma.testTicket.findMany.mock.calls[0][0].where.envKey).toBe(
      '-:-:tma:ios:uk',
    );
  });

  it('в строке — повод открыть, а не весь текст', async () => {
    const { service, prisma } = build();
    prisma.testTicket.findMany.mockResolvedValue([
      ticket({ text: 'а'.repeat(500) }),
    ]);
    const [row] = await service.list({});
    expect(row.preview).toHaveLength(121);
    expect(row.preview.endsWith('…')).toBe(true);
  });

  it('переносы строк в превью схлопываются', async () => {
    const { service, prisma } = build();
    prisma.testTicket.findMany.mockResolvedValue([ticket()]);
    const [row] = await service.list({});
    expect(row.preview).toBe('кнопка не нажимается вообще никак');
  });

  it('окружение приезжает строкой, а не объектом', async () => {
    const { service, prisma } = build();
    prisma.testTicket.findMany.mockResolvedValue([ticket()]);
    const [row] = await service.list({});
    expect(row.envSummary).toBe(
      'Telegram · iOS 18.1 · телефон · 390×760 · uk · сборка 2026.09.25-a1b2c3d',
    );
  });

  it('несвежее окружение помечено, свежее — нет', async () => {
    // «Снято раньше находки» — сигнал сам по себе: человек мог написать
    // боту с телефона про то, что видел на десктопе.
    const { service, prisma } = build();
    prisma.testTicket.findMany.mockResolvedValue([
      ticket({ envCapturedAt: NOW }),
      ticket({ envCapturedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000) }),
      ticket({ envCapturedAt: null }),
    ]);
    const rows = await service.list({});
    expect(rows.map((r) => r.envStale)).toEqual([false, true, true]);
  });

  it('вложения считаются, а не отдаются списком', async () => {
    const { service, prisma } = build();
    prisma.testTicket.findMany.mockResolvedValue([
      ticket({ attachments: [{ url: 'a' }, { url: 'b' }] }),
      ticket({ attachments: null }),
    ]);
    expect((await service.list({})).map((r) => r.attachments)).toEqual([2, 0]);
  });
});

describe('карточка находки', () => {
  it('похожие ищутся по ключу и без самой находки', async () => {
    const { service, prisma } = build({
      same: [
        { id: 't2', number: 9, createdAt: NOW, status: 'FIXED', text: 'то же' },
      ],
    });
    const detail = await service.get('t1');
    expect(prisma.testTicket.findMany.mock.calls[0][0].where).toEqual({
      envKey: '-:-:tma:ios:uk',
      id: { not: 't1' },
    });
    expect(detail.sameEnvironment[0]).toMatchObject({ number: 9 });
  });

  it('подпись знает полное число, а список обрезан', async () => {
    // Аудит этапа 158: длина обрезанного списка, выданная за общее
    // число, сообщает «ещё 10» там, где их полсотни — то есть ровно
    // тогда, когда число и важно.
    const { service, prisma } = build({
      same: [
        { id: 't2', number: 9, createdAt: NOW, status: 'FIXED', text: 'то же' },
      ],
      sameTotal: 47,
    });
    const detail = await service.get('t1');
    expect(detail.sameEnvironmentTotal).toBe(47);
    expect(detail.sameEnvironment).toHaveLength(1);
    expect(prisma.testTicket.findMany.mock.calls[0][0].take).toBe(10);
  });

  it('без ключа похожих не ищем вовсе', async () => {
    // Иначе в группу «нет окружения» попали бы все находки подряд.
    const { service, prisma } = build({ row: ticket({ envKey: null }) });
    const detail = await service.get('t1');
    expect(prisma.testTicket.findMany).not.toHaveBeenCalled();
    expect(prisma.testTicket.count).not.toHaveBeenCalled();
    expect(detail.sameEnvironment).toEqual([]);
    expect(detail.sameEnvironmentTotal).toBe(0);
  });

  it('право ответить известно ДО отправки', async () => {
    // Пусто — кнопка неактивна с подписью «диалог не открыт». Это не
    // сбой, а положение дел, и узнавать о нём из неотправленного
    // сообщения незачем.
    const open = build();
    expect((await open.service.get('t1')).canReply).toBe(true);

    const closed = build({
      row: ticket({
        user: {
          id: 'u1',
          telegramId: '42',
          firstName: 'А',
          username: null,
          botChatOpenedAt: null,
        },
      }),
    });
    expect((await closed.service.get('t1')).canReply).toBe(false);
  });

  it('нет такой находки — 404, а не пустая карточка', async () => {
    const { service } = build({ row: null });
    await expect(service.get('нет')).rejects.toThrow(/not found/);
  });
});

describe('смена статуса', () => {
  it('«отклонено» без причины не принимается', async () => {
    // Без неё человек, потративший время, прочитает это как «нам всё
    // равно».
    const { service, prisma } = build();
    await expect(
      service.setStatus('op', 't1', 'REJECTED', '  '),
    ).rejects.toThrow(/причина/);
    expect(prisma.testTicket.update).not.toHaveBeenCalled();
  });

  it('«дубль» — тоже', async () => {
    const { service } = build();
    await expect(
      service.setStatus('op', 't1', 'DUPLICATE', null),
    ).rejects.toThrow(/причина/);
  });

  it('рабочие статусы причины не требуют', async () => {
    const { service, prisma } = build();
    await service.setStatus('op', 't1', 'IN_PROGRESS', null);
    expect(prisma.testTicket.update.mock.calls[0][0].data).toMatchObject({
      status: 'IN_PROGRESS',
      statusBy: 'op',
    });
  });

  it('пустая причина не затирает написанную раньше', async () => {
    const { service, prisma } = build();
    await service.setStatus('op', 't1', 'FIXED', '');
    expect('statusNote' in prisma.testTicket.update.mock.calls[0][0].data).toBe(
      false,
    );
  });

  it('незнакомый статус отвергается', async () => {
    const { service } = build();
    await expect(service.setStatus('op', 't1', 'CLOSED', null)).rejects.toThrow(
      /статус/,
    );
  });
});

describe('ответ тестировщику', () => {
  it('уходит в личку и переводит тикет в «ждём его»', async () => {
    const { service, prisma, notify } = build();
    await service.reply('op', 't1', 'проверьте ещё раз');
    expect(notify.dmWithId).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('#14'),
    );
    const data = prisma.testTicket.update.mock.calls[0][0].data;
    expect(data.status).toBe('ANSWERED');
    expect(data.replySentAt).toBeInstanceOf(Date);
    expect(data.replyFailedAt).toBeNull();
  });

  it('идентификатор нашего сообщения запоминается', async () => {
    // По нему ответ тестировщика найдёт этот тикет и ляжет
    // комментарием, а не новой находкой в очередь.
    const { service, prisma } = build();
    await service.reply('op', 't1', 'ответ');
    expect(
      prisma.testTicket.update.mock.calls[0][0].data.botMessageIds,
    ).toEqual({ push: 700 });
  });

  it('недоставленный ответ виден, а тикет не закрывается', async () => {
    // `dm()` глотает отказ молча, и для тикета этого мало: иначе
    // оператор будет думать, что ответил.
    const { service, prisma, notify } = build();
    notify.dmWithId.mockResolvedValue({ ok: false, messageId: null });
    await service.reply('op', 't1', 'ответ');
    const data = prisma.testTicket.update.mock.calls[0][0].data;
    expect(data.replyFailedAt).toBeInstanceOf(Date);
    expect(data.status).toBeUndefined();
  });

  it('неудача не стирает факт прежнего доставленного ответа', async () => {
    // Аудит этапа 158: раньше провалившийся второй ответ ставил
    // `replySentAt: null`, и карточка начинала утверждать, что мы не
    // отвечали никогда — при том что первый ответ человек получил.
    const { service, prisma, notify } = build();
    notify.dmWithId.mockResolvedValue({ ok: false, messageId: null });
    await service.reply('op', 't1', 'ответ');
    expect(
      'replySentAt' in prisma.testTicket.update.mock.calls[0][0].data,
    ).toBe(false);
  });

  it('удача стирает прежнюю отметку о недоставке', async () => {
    // Иначе «не доставлено» висело бы на тикете, где всё уже дошло.
    const { service, prisma } = build();
    await service.reply('op', 't1', 'ответ');
    expect(
      prisma.testTicket.update.mock.calls[0][0].data.replyFailedAt,
    ).toBeNull();
  });

  it('ответ всё равно записывается комментарием, даже недоставленный', async () => {
    const { service, prisma, notify } = build();
    notify.dmWithId.mockResolvedValue({ ok: false, messageId: null });
    await service.reply('op', 't1', 'ответ');
    expect(
      prisma.testTicket.update.mock.calls[0][0].data.comments,
    ).toHaveLength(1);
  });

  it('без открытого диалога не отправляем вовсе', async () => {
    const { service, notify } = build({
      row: ticket({
        user: {
          id: 'u1',
          telegramId: '42',
          firstName: 'А',
          username: null,
          botChatOpenedAt: null,
        },
      }),
    });
    await expect(service.reply('op', 't1', 'ответ')).rejects.toThrow(/START/);
    expect(notify.dmWithId).not.toHaveBeenCalled();
  });

  it('пустой ответ отправлять незачем', async () => {
    const { service, notify } = build();
    await expect(service.reply('op', 't1', '   ')).rejects.toThrow(/Пустой/);
    expect(notify.dmWithId).not.toHaveBeenCalled();
  });
});

describe('прогресс', () => {
  function withTesters(testAccessUntil: Date | null = null) {
    const { service, prisma, notify } = build();
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        telegramId: '42',
        firstName: 'Андрій',
        username: 'andrii',
        freeScenarios: ['PRODUCT_VIDEO', 'GREETING_VIDEO'],
        testAccessUntil,
        testDailyLimitUsd: null,
      },
    ]);
    // Считает база: строки приходят уже свёрнутыми, с bigint из
    // COUNT(*), как их и отдаёт Postgres.
    prisma.$queryRaw.mockResolvedValue([
      { userId: 'u1', type: 'SINGLE', n: 1n },
      { userId: 'u1', type: 'LINE', n: 1n },
      { userId: 'u1', type: 'CLIENT_SITE', n: 1n },
      { userId: 'u1', type: null, n: 1n },
    ]);
    prisma.testTicket.groupBy
      .mockResolvedValueOnce([
        {
          userId: 'u1',
          status: 'NEW',
          scenario: 'PRODUCT_VIDEO',
          _count: { _all: 1 },
        },
        {
          userId: 'u1',
          status: 'FIXED',
          scenario: 'PRODUCT_VIDEO',
          _count: { _all: 1 },
        },
        {
          userId: 'u1',
          status: 'ANSWERED',
          scenario: null,
          _count: { _all: 1 },
        },
      ])
      .mockResolvedValueOnce([{ userId: 'u1', _max: { createdAt: NOW } }]);
    return { service, prisma, notify };
  }

  it('покрытие считается из существующих данных, без новых таблиц', async () => {
    // SINGLE и LINE — один сценарий: это одна продуктовая задача, и
    // разделять их значит спрашивать оператора о различии, которого
    // для тестирования нет.
    const { service } = withTesters();
    const [me] = await service.progress();
    const byKey = Object.fromEntries(me.scenarios.map((s) => [s.scenario, s]));
    expect(byKey.PRODUCT_VIDEO).toMatchObject({
      sessions: 2,
      tickets: 2,
      open: true,
    });
    expect(byKey.CLIENT_SITE).toMatchObject({
      sessions: 1,
      tickets: 0,
      open: false,
    });
    expect(byKey.GREETING_VIDEO).toMatchObject({
      sessions: 0,
      tickets: 0,
      open: true,
    });
  });

  it('сценарий, по которому тишина, виден как строка с нулями', async () => {
    // Это главный вопрос к любому тестированию, и ответ на него не
    // должен требовать вычитания в уме.
    const { service } = withTesters();
    const [me] = await service.progress();
    expect(me.scenarios).toHaveLength(3);
  });

  it('открытые и закрытые считаются по смыслу очереди', async () => {
    const { service } = withTesters();
    const [me] = await service.progress();
    expect(me.openTickets).toBe(2);
    expect(me.closedTickets).toBe(1);
    expect(me.lastActivityAt).toEqual(NOW);
  });

  it('тестировщиков нет — ни одного лишнего запроса', async () => {
    const { service, prisma } = build();
    expect(await service.progress()).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('считает база, а не мы по вытащенным строкам', async () => {
    // Аудит этапа 158: раньше здесь было два `findMany` с `take: 2000`
    // и без сортировки — на тестировщике с тремя тысячами сессий
    // счётчики становились произвольными, и молча.
    const { service, prisma } = build();
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        telegramId: '42',
        firstName: 'А',
        username: null,
        freeScenarios: [],
        testAccessUntil: null,
        testDailyLimitUsd: null,
      },
    ]);
    await service.progress();
    const [byCounts] = prisma.testTicket.groupBy.mock.calls[0];
    expect(byCounts.by).toEqual(['userId', 'status', 'scenario']);
    expect(byCounts._count).toEqual({ _all: true });
    expect(byCounts.take).toBeUndefined();
  });

  it('истёкший доступ закрывает сценарии, сколько бы галочек ни стояло', async () => {
    // Вкладка, рисующая «открыто» там, где доступа уже нет, отправляет
    // оператора ждать прогонов, которых не будет.
    const { service } = withTesters(new Date(Date.now() - 1000));
    const [me] = await service.progress();
    expect(me.accessActive).toBe(false);
    expect(me.scenarios.every((s) => !s.open)).toBe(true);
  });

  it('срок ещё не вышел — открыто остаётся открытым', async () => {
    const { service } = withTesters(new Date(Date.now() + 60_000));
    const [me] = await service.progress();
    expect(me.accessActive).toBe(true);
    expect(me.scenarios.filter((s) => s.open)).toHaveLength(2);
  });
});

describe('расход тестировщика рядом со списком (этап 159)', () => {
  it('фактический расход и потолок приезжают вместе с прогрессом', async () => {
    // Общий `DAILY_SPEND_LIMIT_USD_TEST_USER` — потолок НА КАЖДОГО:
    // трое тестировщиков это втрое больше денег в сутки, и пока это не
    // стоит рядом с именами, никто этого не замечает (§4.3 ТЗ).
    const { service, prisma, aiUsage } = build();
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        telegramId: '42',
        firstName: 'А',
        username: null,
        freeScenarios: [],
        testAccessUntil: null,
        testDailyLimitUsd: 5,
      },
    ]);
    aiUsage.spentTodayByUsers.mockResolvedValue({ u1: 1_250_000 });
    const [me] = await service.progress();
    expect(me.spentTodayMicroUsd).toBe(1_250_000);
    expect(me.dailyLimitMicroUsd).toBe(5_000_000);
  });

  it('без своего потолка показывается общий', async () => {
    const { service, prisma } = build();
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        telegramId: '42',
        firstName: 'А',
        username: null,
        freeScenarios: [],
        testAccessUntil: null,
        testDailyLimitUsd: null,
      },
    ]);
    const [me] = await service.progress();
    expect(me.dailyLimitMicroUsd).toBeGreaterThan(0);
    expect(me.spentTodayMicroUsd).toBe(0);
  });
});
