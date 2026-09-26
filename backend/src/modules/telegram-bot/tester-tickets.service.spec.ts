import { TesterTicketsService } from './tester-tickets.service';
import {
  MAX_ATTACHMENTS,
  MERGE_WINDOW_MS,
  RATE_LIMIT,
} from '../../common/test-ticket';

const NOW = new Date('2026-09-26T12:00:00.000Z');

const ENV = {
  surface: 'TMA',
  deviceKind: 'PHONE',
  osFamily: 'ios',
  tgPlatform: 'ios',
  uiLocale: 'uk',
  appBuild: '2026.09.25-a1b2c3d',
};

interface Options {
  user?: Record<string, unknown> | null;
  previous?: Record<string, unknown> | null;
  byReply?: Record<string, unknown> | null;
  rateCount?: number;
  messageId?: number | null;
}

function build(options: Options = {}) {
  const user =
    options.user === undefined
      ? {
          id: 'u1',
          isTestUser: true,
          testAccessUntil: null,
          lastEnvironment: ENV,
          lastEnvironmentAt: new Date('2026-09-26T09:00:00.000Z'),
        }
      : options.user;

  const created = { id: 't1', number: 14 };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    testerInvite: { findFirst: jest.fn().mockResolvedValue({ id: 'inv1' }) },
    testTicket: {
      findFirst: jest
        .fn()
        // Первый вызов — поиск по ответу; второй — поиск предыдущего.
        .mockImplementation((args: { where?: { botMessageIds?: unknown } }) =>
          args?.where?.botMessageIds
            ? Promise.resolve(options.byReply ?? null)
            : Promise.resolve(options.previous ?? null),
        ),
      create: jest.fn().mockResolvedValue(created),
      update: jest.fn().mockResolvedValue({ id: 't9', number: 9 }),
    },
    // Счётчик частоты живёт в сыром SQL.
    $queryRaw: jest.fn().mockResolvedValue([{ count: options.rateCount ?? 1 }]),
  };
  const notify = {
    dm: jest.fn().mockResolvedValue(true),
    stat: jest.fn().mockResolvedValue(true),
    dmWithId: jest.fn().mockResolvedValue({
      ok: true,
      messageId: options.messageId === undefined ? 500 : options.messageId,
    }),
  };
  const files = jest.fn().mockResolvedValue({ stored: [], failures: [] });
  const service = new TesterTicketsService(
    prisma as never,
    notify as never,
    { store: files } as never,
  );
  return { service, prisma, notify, files };
}

describe('приём находки из бота', () => {
  it('обычное сообщение заводит тикет и подтверждается номером', async () => {
    // Подтверждение обязательно: без него человек не знает, дошло ли,
    // и пишет второй раз.
    const { service, prisma, notify } = build();
    await expect(
      service.accept('42', { text: 'кнопка не нажимается' }, NOW),
    ).resolves.toBe(true);
    expect(prisma.testTicket.create).toHaveBeenCalled();
    expect(notify.dmWithId).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('#14'),
    );
  });

  it('не тестировщик — не наше дело', async () => {
    const { service, prisma } = build({
      user: {
        id: 'u2',
        isTestUser: false,
        testAccessUntil: null,
        testerInvites: [],
      },
    });
    await expect(service.accept('42', { text: 'привет' }, NOW)).resolves.toBe(
      false,
    );
    expect(prisma.testTicket.create).not.toHaveBeenCalled();
  });

  it('истёкший доступ: находку не заводим, но и не молчим', async () => {
    // Аудит этапа 159. Человек, который вчера присылал находки и
    // получал «Принято, #14», сегодня получил бы ничего — и не отличил
    // бы кончившийся доступ от сломанного бота.
    const { service, prisma, notify } = build({
      user: {
        id: 'u3',
        isTestUser: true,
        testAccessUntil: new Date(NOW.getTime() - 1),
        lastEnvironment: null,
        lastEnvironmentAt: null,
        testerInvites: [{ id: 'inv1' }],
      },
    });
    await expect(service.accept('42', { text: 'баг' }, NOW)).resolves.toBe(
      true,
    );
    expect(prisma.testTicket.create).not.toHaveBeenCalled();
    expect(notify.dm).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('Тестовый доступ закончился'),
    );
  });

  it('и повторяет это не чаще раза в сутки', async () => {
    // Повторять на каждое сообщение — тот же спам, от которого бережёт
    // ограничитель частоты.
    const { service, prisma, notify } = build({
      user: {
        id: 'u3',
        isTestUser: true,
        testAccessUntil: new Date(NOW.getTime() - 1),
        lastEnvironment: null,
        lastEnvironmentAt: null,
        testerInvites: [{ id: 'inv1' }],
      },
      rateCount: 2,
    });
    await service.accept('42', { text: 'ещё баг' }, NOW);
    expect(notify.dm).not.toHaveBeenCalled();
    expect(prisma.testTicket.create).not.toHaveBeenCalled();
  });

  it('незнакомый человек тикета не заводит', async () => {
    const { service, prisma } = build({ user: null });
    await expect(service.accept('42', { text: 'баг' }, NOW)).resolves.toBe(
      false,
    );
    expect(prisma.testTicket.create).not.toHaveBeenCalled();
  });

  it('окружение приезжает последнее известное, с датой снятия', async () => {
    // Человек мог написать боту с телефона про то, что видел на
    // десктопе; уверенное «iOS» отправило бы оператора искать не там —
    // спасает только дата снятия рядом.
    const { service, prisma } = build();
    await service.accept('42', { text: 'баг' }, NOW);
    const data = prisma.testTicket.create.mock.calls[0][0].data;
    expect(data.envCapturedAt).toEqual(new Date('2026-09-26T09:00:00.000Z'));
    expect(data.envKey).toBe('-:-:tma:ios:uk');
    expect(data.uiLocale).toBe('uk');
    expect(data.appBuild).toBe('2026.09.25-a1b2c3d');
    expect(data.inviteId).toBe('inv1');
    expect(data.source).toBe('BOT');
  });

  it('окружения не было ни разу — тикет всё равно заводится', async () => {
    // Тестировщик может написать боту, ни разу не открыв мини-апп.
    // Потерять из-за этого находку было бы худшим исходом.
    const { service, prisma } = build({
      user: {
        id: 'u1',
        isTestUser: true,
        testAccessUntil: null,
        lastEnvironment: null,
        lastEnvironmentAt: null,
        testerInvites: [{ id: 'inv1' }],
      },
    });
    await service.accept('42', { text: 'баг' }, NOW);
    const data = prisma.testTicket.create.mock.calls[0][0].data;
    expect(data.env).toBeUndefined();
    expect(data.envKey).toBeNull();
    expect(data.envCapturedAt).toBeNull();
    expect(data.uiLocale).toBe('unknown');
  });

  it('второе сообщение в окне склеивается, а не заводит вторую находку', async () => {
    // Скриншот и подпись к нему — одна находка.
    const { service, prisma } = build({
      previous: {
        id: 'told',
        number: 9,
        text: 'вот тут',
        attachments: [],
        lastMessageAt: new Date(NOW.getTime() - 30_000),
      },
    });
    await service.accept('42', { text: 'и ещё вот так' }, NOW);
    expect(prisma.testTicket.create).not.toHaveBeenCalled();
    expect(prisma.testTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'told' },
        data: expect.objectContaining({ text: 'вот тут\n\nи ещё вот так' }),
      }),
    );
  });

  it('за окном — новая находка', async () => {
    const { service, prisma } = build({
      previous: {
        id: 'told',
        number: 9,
        text: 'вчерашнее',
        attachments: [],
        lastMessageAt: new Date(NOW.getTime() - MERGE_WINDOW_MS - 1000),
      },
    });
    await service.accept('42', { text: 'сегодняшнее' }, NOW);
    expect(prisma.testTicket.create).toHaveBeenCalled();
  });

  it('ответ на наше сообщение — комментарий, а не новая находка', async () => {
    // Оператор ответил в тикет, тестировщик ответил на это сообщение.
    // Без правила в очередь лёг бы тикет «да, теперь работает».
    const { service, prisma, notify } = build({
      byReply: {
        id: 'told',
        comments: [{ at: 'вчера', from: 'OPERATOR', text: 'проверьте' }],
      },
    });
    await expect(
      service.accept(
        '42',
        { text: 'да, теперь работает', reply_to_message: { message_id: 500 } },
        NOW,
      ),
    ).resolves.toBe(true);
    expect(prisma.testTicket.create).not.toHaveBeenCalled();
    const data = prisma.testTicket.update.mock.calls[0][0].data;
    expect(data.comments).toHaveLength(2);
    expect(data.comments[1]).toMatchObject({
      from: 'TESTER',
      text: 'да, теперь работает',
    });
    // Комментарий не подтверждается номером: он не новая находка.
    expect(notify.dmWithId).not.toHaveBeenCalled();
  });

  it('ответ тестировщика возвращает находку в очередь к нам', async () => {
    // Приёмка ТЗ: `ANSWERED` значит «ждём тестировщика» — а он уже
    // ответил. Оставить этот статус значит спрятать его ответ в
    // положении «ждёт ЕГО».
    const { service, prisma, notify } = build({
      byReply: { id: 'told', number: 9, status: 'ANSWERED', comments: [] },
    });
    await service.accept(
      '42',
      { text: 'всё ещё ломается', reply_to_message: { message_id: 500 } },
      NOW,
    );
    const data = prisma.testTicket.update.mock.calls[0][0].data;
    expect(data.status).toBe('IN_PROGRESS');
    // Статус вернул не оператор — подписывать им кого-то было бы
    // неправдой.
    expect(data.statusBy).toBeNull();
    expect(notify.stat).toHaveBeenCalledWith(expect.stringContaining('#9'));
  });

  it('и поднимает даже закрытую находку', async () => {
    // «Всё ещё ломается» по исправленной — ровно тот случай, где
    // молчание дороже всего.
    const { service, prisma } = build({
      byReply: { id: 'told', number: 9, status: 'FIXED', comments: [] },
    });
    await service.accept(
      '42',
      { text: 'не починилось', reply_to_message: { message_id: 500 } },
      NOW,
    );
    expect(prisma.testTicket.update.mock.calls[0][0].data.status).toBe(
      'IN_PROGRESS',
    );
  });

  it('новую находку в «чиним» не переводит', async () => {
    // Она и так ждёт нас; менять `NEW` на `IN_PROGRESS` значит соврать,
    // что за неё уже взялись.
    const { service, prisma } = build({
      byReply: { id: 'told', number: 9, status: 'NEW', comments: [] },
    });
    await service.accept(
      '42',
      { text: 'ещё подробность', reply_to_message: { message_id: 500 } },
      NOW,
    );
    expect(
      prisma.testTicket.update.mock.calls[0][0].data.status,
    ).toBeUndefined();
  });

  it('ответ НЕ на наше сообщение находкой всё-таки становится', async () => {
    // Человек уточняет собственную мысль, отвечая себе же. Потерять
    // это было бы хуже, чем завести лишний тикет.
    const { service, prisma } = build({ byReply: null });
    await service.accept(
      '42',
      { text: 'ещё подробность', reply_to_message: { message_id: 999 } },
      NOW,
    );
    expect(prisma.testTicket.create).toHaveBeenCalled();
  });

  it('идентификатор подтверждения запоминается — по нему найдётся ответ', async () => {
    const { service, prisma } = build();
    await service.accept('42', { text: 'баг' }, NOW);
    expect(prisma.testTicket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { botMessageIds: { push: 500 } },
    });
  });

  it('Telegram не отдал идентификатор — тикет остаётся, запоминать нечего', async () => {
    const { service, prisma } = build({ messageId: null });
    await service.accept('42', { text: 'баг' }, NOW);
    expect(prisma.testTicket.create).toHaveBeenCalled();
    expect(prisma.testTicket.update).not.toHaveBeenCalled();
  });

  it('отозванному доступу отвечаем, а не молчим', async () => {
    // Приёмка ТЗ: `isTestUser: false` значит и «случайный прохожий», и
    // «человек, у которого доступ вчера отобрали». Второму молчание
    // читается как сломанный бот.
    const { service, notify, prisma } = build({
      user: {
        id: 'u9',
        isTestUser: false,
        testAccessUntil: null,
        testerInvites: [{ id: 'inv1' }],
      },
    });
    await expect(service.accept('42', { text: 'баг' }, NOW)).resolves.toBe(
      true,
    );
    expect(notify.dm).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('Тестовый доступ закончился'),
    );
    expect(prisma.testTicket.create).not.toHaveBeenCalled();
  });

  it('случайному прохожему по-прежнему молчим', async () => {
    // Он не начинал этого разговора.
    const { service, notify } = build({
      user: {
        id: 'u2',
        isTestUser: false,
        testAccessUntil: null,
        testerInvites: [],
      },
    });
    await expect(service.accept('42', { text: 'привет' }, NOW)).resolves.toBe(
      false,
    );
    expect(notify.dm).not.toHaveBeenCalled();
  });

  it('оператор узнаёт о находке сам', async () => {
    // Между «принять находку» и «разобрать её» не было ничего: вкладку
    // надо было открыть и посмотреть.
    const { service, notify } = build();
    await service.accept('42', { text: 'кнопка не нажимается' }, NOW);
    expect(notify.stat).toHaveBeenCalledWith(expect.stringContaining('#14'));
    expect(notify.stat.mock.calls[0][0]).toContain('кнопка не нажимается');
  });

  it('перебор частоты: отказ один раз, дальше молчание', async () => {
    const warn = build({ rateCount: RATE_LIMIT + 1 });
    await expect(warn.service.accept('42', { text: 'баг' }, NOW)).resolves.toBe(
      true,
    );
    expect(warn.notify.dm).toHaveBeenCalledTimes(1);
    expect(warn.prisma.testTicket.create).not.toHaveBeenCalled();

    const silent = build({ rateCount: RATE_LIMIT + 5 });
    await silent.service.accept('42', { text: 'баг' }, NOW);
    expect(silent.notify.dm).not.toHaveBeenCalled();
    expect(silent.prisma.testTicket.create).not.toHaveBeenCalled();
  });

  it('счётчик лёг — сообщение проходит', async () => {
    // Отказать человеку из-за неработающей проверки дороже, чем
    // пропустить лишнее сообщение.
    const { service, prisma } = build();
    prisma.$queryRaw.mockRejectedValue(new Error('база недоступна'));
    await service.accept('42', { text: 'баг' }, NOW);
    expect(prisma.testTicket.create).toHaveBeenCalled();
  });

  it('ни текста, ни файла — говорим об этом, а не заводим пустышку', async () => {
    const { service, prisma, notify } = build();
    await expect(
      service.accept('42', { reply_to_message: undefined }, NOW),
    ).resolves.toBe(true);
    expect(prisma.testTicket.create).not.toHaveBeenCalled();
    expect(notify.dm).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('Не вижу'),
    );
  });

  it('слишком большой файл: тикет заводится, а человеку говорят про потолок', async () => {
    // Молча терять вложение нельзя: он будет считать, что прислал.
    const { service, notify, files } = build();
    files.mockResolvedValue({ stored: [], failures: ['too-big'] });
    await service.accept(
      '42',
      { caption: 'запись экрана', video: { file_id: 'v', file_size: 99e6 } },
      NOW,
    );
    const text = notify.dmWithId.mock.calls[0][1] as string;
    expect(text).toContain('#14');
    expect(text).toContain('20 МБ');
  });

  it('вложение не сохранилось — тоже вслух', async () => {
    const { service, notify, files } = build();
    files.mockResolvedValue({ stored: [], failures: ['failed'] });
    await service.accept('42', { photo: [{ file_id: 'p' }] }, NOW);
    expect(notify.dmWithId.mock.calls[0][1]).toContain('не удалось сохранить');
  });

  // ── Находки аудита этапа 157 ──────────────────────────────────────

  it('окно склейки не сдвигает ответ оператора', async () => {
    // Главная находка аудита. Раньше окно считалось от `updatedAt`, а
    // его двигает любая правка строки: ответ оператора, смена статуса,
    // дописанный `botMessageIds`. Оператор ответил на вчерашний тикет —
    // и следующая, ни с чем не связанная находка молча уезжала туда же.
    const { service, prisma } = build({
      previous: {
        id: 'told',
        number: 9,
        text: 'вчерашнее',
        attachments: [],
        // Человек писал сюда вчера, а тронули строку только что.
        lastMessageAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      },
    });
    await service.accept('42', { text: 'новая находка' }, NOW);
    expect(prisma.testTicket.create).toHaveBeenCalled();
    // И ищем мы теперь по отметке человека, а не по правкам строки.
    expect(prisma.testTicket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { lastMessageAt: 'desc' } }),
    );
  });

  it('отметка сообщения ставится и при создании, и при склейке', async () => {
    const fresh = build();
    await fresh.service.accept('42', { text: 'баг' }, NOW);
    expect(
      fresh.prisma.testTicket.create.mock.calls[0][0].data.lastMessageAt,
    ).toEqual(NOW);

    const merging = build({
      previous: {
        id: 'told',
        number: 9,
        text: 'вот тут',
        attachments: [],
        lastMessageAt: new Date(NOW.getTime() - 1000),
      },
    });
    await merging.service.accept('42', { text: 'и ещё' }, NOW);
    expect(
      merging.prisma.testTicket.update.mock.calls[0][0].data.lastMessageAt,
    ).toEqual(NOW);
  });

  it('склейка подтверждается другими словами, чем новая находка', async () => {
    // Одинаковое «Принято, #9» дважды читается как два тикета с одним
    // номером — а подтверждение и существует затем, чтобы человек знал,
    // что произошло.
    const { service, notify } = build({
      previous: {
        id: 'told',
        number: 9,
        text: 'вот тут',
        attachments: [],
        lastMessageAt: NOW,
      },
    });
    await service.accept('42', { text: 'и ещё' }, NOW);
    expect(notify.dmWithId.mock.calls[0][1]).toBe('Добавлено к #9.');
  });

  it('скриншот в ответе на наше сообщение не теряется', async () => {
    // До аудита вложения качались ПОСЛЕ развилки, то есть в
    // комментарий не попадали вовсе.
    const { service, prisma, files } = build({
      byReply: { id: 'told', number: 9, status: 'NEW', comments: [] },
    });
    files.mockResolvedValue({ stored: [{ url: 'b' }], failures: [] });
    await service.accept(
      '42',
      {
        caption: 'вот как выглядит',
        photo: [{ file_id: 'p' }],
        reply_to_message: { message_id: 500 },
      },
      NOW,
    );
    const data = prisma.testTicket.update.mock.calls[0][0].data;
    expect(data.comments[0]).toMatchObject({
      from: 'TESTER',
      text: 'вот как выглядит',
      attachments: [{ url: 'b' }],
    });
  });

  it('ответ из одного файла без текста не пропадает целиком', async () => {
    const { service, prisma, files } = build({
      byReply: { id: 'told', number: 9, status: 'NEW', comments: [] },
    });
    files.mockResolvedValue({ stored: [{ url: 'b' }], failures: [] });
    await service.accept(
      '42',
      { photo: [{ file_id: 'p' }], reply_to_message: { message_id: 500 } },
      NOW,
    );
    expect(
      prisma.testTicket.update.mock.calls[0][0].data.comments[0].attachments,
    ).toEqual([{ url: 'b' }]);
  });

  it('комментарий двигает окно склейки', async () => {
    // Комментарий — тоже сообщение человека; иначе следующая фраза из
    // той же мысли заведёт находку.
    const { service, prisma } = build({
      byReply: { id: 'told', number: 9, status: 'NEW', comments: [] },
    });
    await service.accept(
      '42',
      { text: 'ещё вот что', reply_to_message: { message_id: 500 } },
      NOW,
    );
    expect(
      prisma.testTicket.update.mock.calls[0][0].data.lastMessageAt,
    ).toEqual(NOW);
  });

  it('не доехавшее вложение в комментарии — тоже вслух', async () => {
    const { service, notify, files } = build({
      byReply: { id: 'told', number: 9, status: 'NEW', comments: [] },
    });
    files.mockResolvedValue({ stored: [], failures: ['too-big'] });
    await service.accept(
      '42',
      {
        caption: 'запись',
        video: { file_id: 'v' },
        reply_to_message: { message_id: 500 },
      },
      NOW,
    );
    expect(notify.dm).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('20 МБ'),
    );
  });

  it('вложения кладутся под владельца, а не в свой префикс', async () => {
    // Метла обходит закрытый список областей и разбирает пути как
    // `<префикс>/<id>/…`: под собственным префиксом эти файлы не
    // подбирал бы никто и никогда.
    const { service, files } = build();
    await service.accept('42', { photo: [{ file_id: 'p' }] }, NOW);
    expect(files.mock.calls[0][1]).toBe(`u1/tickets/${NOW.getTime()}`);
  });

  it('склейка не обходит потолок в пять вложений', async () => {
    // Мутация «потолок снят» пережила тест: на этом пути его не
    // проверял никто, а склейка — единственное место, где вложения
    // складываются, то есть единственное, где потолок и может быть
    // превышен.
    const { service, prisma, files } = build({
      previous: {
        id: 'told',
        number: 9,
        text: 'вот тут',
        attachments: [1, 2, 3, 4, 5].map((n) => ({ url: `a${n}` })),
        lastMessageAt: NOW,
      },
    });
    files.mockResolvedValue({ stored: [{ url: 'b' }], failures: [] });
    await service.accept('42', { photo: [{ file_id: 'p' }] }, NOW);
    expect(
      prisma.testTicket.update.mock.calls[0][0].data.attachments,
    ).toHaveLength(MAX_ATTACHMENTS);
  });

  it('склейка добавляет вложения к прежним, не заменяя их', async () => {
    const { service, prisma, files } = build({
      previous: {
        id: 'told',
        number: 9,
        text: 'вот тут',
        attachments: [{ url: 'a' }],
        lastMessageAt: NOW,
      },
    });
    files.mockResolvedValue({ stored: [{ url: 'b' }], failures: [] });
    await service.accept('42', { photo: [{ file_id: 'p' }] }, NOW);
    const data = prisma.testTicket.update.mock.calls[0][0].data;
    expect(data.attachments).toEqual([{ url: 'a' }, { url: 'b' }]);
  });
});
