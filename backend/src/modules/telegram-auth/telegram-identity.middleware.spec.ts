/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * CSRF на пользовательских маршрутах (Б-3.1).
 *
 * Личность из cookie — единственный источник, который браузер
 * прикладывает сам, без участия нашего кода: значит только на ней и
 * возможна CSRF. До этой правки страница злоумышленника могла
 * form-POST'ом от имени вошедшего человека принять оферту, завести
 * проект или потратить деньги владельца на пробу голоса.
 *
 * Здесь же закрывается прежний ноль покрытия этого файла: приоритет
 * источников личности и dev-обход тоже не исполнялись ни разу.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { createHmac } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { TelegramIdentityMiddleware } from './telegram-identity.middleware';

const ALLOWLIST = 'https://app.example.com';

function build(sessionUserId: string | null) {
  const prisma = {
    userSession: {
      findUnique: jest.fn().mockResolvedValue(
        sessionUserId
          ? {
              userId: sessionUserId,
              expiresAt: new Date(Date.now() + 60_000),
            }
          : null,
      ),
    },
    user: {
      upsert: jest.fn().mockResolvedValue({ id: 'usr_dev' }),
    },
  };
  return { mw: new TelegramIdentityMiddleware(prisma as any), prisma };
}

function request(
  method: string,
  origin: string | undefined,
  cookie: string | undefined,
  headers: Record<string, string> = {},
) {
  return {
    method,
    originalUrl: '/api/me/terms/accept',
    headers: { ...headers, ...(origin ? { origin } : {}), cookie },
  } as any;
}

describe('TelegramIdentityMiddleware — CSRF (Б-3.1)', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.CORS_ORIGIN = ALLOWLIST;
    delete process.env.ALLOW_DEV_AUTH;
  });
  afterAll(() => {
    process.env = env;
  });

  it('форма с чужого сайта отклоняется, а не выполняется от имени вошедшего', async () => {
    const { mw } = build('usr_1');
    const req = request('POST', 'https://зло.example', 'user_session=t1');
    const next = jest.fn();
    await expect(mw.use(req, {} as any, next)).rejects.toThrow(
      ForbiddenException,
    );
    // Ни личности, ни продолжения: «тихо анонимно» здесь хуже отказа —
    // операция ушла бы дальше без прав и упала бы позже и непонятнее.
    expect(req.telegramUserId).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('свой домен пишет как обычно', async () => {
    const { mw } = build('usr_1');
    const req = request('POST', ALLOWLIST, 'user_session=t1');
    const next = jest.fn();
    await mw.use(req, {} as any, next);
    expect(req.telegramUserId).toBe('usr_1');
    expect(next).toHaveBeenCalled();
  });

  it('чтение с чужого домена не запрещаем — GET состояние не меняет', async () => {
    const { mw } = build('usr_1');
    const req = request('GET', 'https://зло.example', 'user_session=t1');
    const next = jest.fn();
    await mw.use(req, {} as any, next);
    expect(req.telegramUserId).toBe('usr_1');
  });

  it('запрос без cookie остаётся анонимным и не отклоняется', async () => {
    // Анонимный сценарий — половина продукта; CSRF на нём бессмысленна:
    // подделывать нечего, sessionId злоумышленник не знает.
    const { mw } = build(null);
    const req = request('POST', 'https://зло.example', undefined);
    const next = jest.fn();
    await mw.use(req, {} as any, next);
    expect(req.telegramUserId).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('истёкшая cookie не даёт личности и не вызывает отказа', async () => {
    const { mw, prisma } = build('usr_1');
    prisma.userSession.findUnique.mockResolvedValue({
      userId: 'usr_1',
      expiresAt: new Date(Date.now() - 1000),
    });
    const req = request('POST', 'https://зло.example', 'user_session=t1');
    const next = jest.fn();
    await mw.use(req, {} as any, next);
    expect(req.telegramUserId).toBeUndefined();
  });

  it('dev-обход проверку Origin не проходит — его ставит только свой клиент', async () => {
    // Заголовок X-Dev-User-Id браузер сам не пришлёт: подделать личность
    // через него со страницы нельзя, а ломать локальный стенд проверкой
    // Origin незачем.
    process.env.ALLOW_DEV_AUTH = 'true';
    const { mw } = build(null);
    const req = request('POST', 'https://зло.example', undefined, {
      'x-dev-user-id': '123',
    });
    const next = jest.fn();
    await mw.use(req, {} as any, next);
    expect(req.telegramUserId).toBe('usr_dev');
  });

  it('без ALLOW_DEV_AUTH заголовок X-Dev-User-Id ничего не даёт', async () => {
    const { mw } = build(null);
    const req = request('POST', ALLOWLIST, undefined, {
      'x-dev-user-id': '123',
    });
    await mw.use(req, {} as any, jest.fn());
    expect(req.telegramUserId).toBeUndefined();
  });

  describe('fixture-токен (§3.3 ТЗ, этап 97)', () => {
    beforeEach(() => {
      process.env.FIXTURE_USER_TOKEN = 'sekret';
      process.env.FIXTURE_TELEGRAM_ID = 'fixture-1';
    });
    afterEach(() => {
      delete process.env.FIXTURE_USER_TOKEN;
      delete process.env.FIXTURE_TELEGRAM_ID;
    });

    it('верный X-Fixture-Token даёт identity и проходит CSRF-проверку Origin', async () => {
      // Как и dev-bypass — это заголовок, не cookie: браузер его сам не
      // пришлёт, проверка Origin для него бессмысленна.
      const { mw, prisma } = build(null);
      prisma.user.upsert.mockResolvedValue({ id: 'usr_fixture' });
      const req = request('POST', 'https://зло.example', undefined, {
        'x-fixture-token': 'sekret',
      });
      const next = jest.fn();
      await mw.use(req, {} as any, next);
      expect(req.telegramUserId).toBe('usr_fixture');
      expect(prisma.user.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { telegramId: 'fixture-1' } }),
      );
      expect(next).toHaveBeenCalled();
    });

    it('неверный X-Fixture-Token не даёт identity и не блокирует запрос', async () => {
      const { mw } = build(null);
      const req = request('POST', ALLOWLIST, undefined, {
        'x-fixture-token': 'неверно',
      });
      const next = jest.fn();
      await mw.use(req, {} as any, next);
      expect(req.telegramUserId).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('без FIXTURE_USER_TOKEN в окружении заголовок ничего не даёт (fail-closed)', async () => {
      delete process.env.FIXTURE_USER_TOKEN;
      const { mw } = build(null);
      const req = request('POST', ALLOWLIST, undefined, {
        'x-fixture-token': 'sekret',
      });
      await mw.use(req, {} as any, jest.fn());
      expect(req.telegramUserId).toBeUndefined();
    });

    it('fixture-токен проверяется раньше dev-обхода', async () => {
      process.env.ALLOW_DEV_AUTH = 'true';
      const { mw, prisma } = build(null);
      prisma.user.upsert.mockResolvedValue({ id: 'usr_fixture' });
      const req = request('POST', ALLOWLIST, undefined, {
        'x-fixture-token': 'sekret',
        'x-dev-user-id': '123',
      });
      await mw.use(req, {} as any, jest.fn());
      expect(req.telegramUserId).toBe('usr_fixture');
      expect(prisma.user.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { telegramId: 'fixture-1' } }),
      );
    });
  });
});

describe('TelegramIdentityMiddleware — имя и @username из initData', () => {
  // Раньше upsert(update: {}) не писал их никогда, и в админке у
  // пользователей TMA вместо @username висел голый cuid. Но и писать на
  // каждый запрос нельзя — middleware стоит на всех маршрутах.
  const BOT = 'bot-token-for-spec';
  const env = { ...process.env };
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = BOT;
  });
  afterAll(() => {
    process.env = env;
  });

  function signedInitData(user: Record<string, unknown>): string {
    const fields: Record<string, string> = {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify(user),
    };
    const dcs = Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(BOT).digest();
    const hash = createHmac('sha256', secret).update(dcs).digest('hex');
    return new URLSearchParams({ ...fields, hash }).toString();
  }

  function run(
    stored: Record<string, unknown>,
    tgUser: Record<string, unknown>,
  ) {
    const { mw, prisma } = build(null);
    prisma.user.upsert.mockResolvedValue({ id: 'usr_tg', ...stored });
    (prisma.user as any).update = jest.fn().mockResolvedValue({});
    const req = request('GET', undefined, undefined, {
      'x-telegram-init-data': signedInitData(tgUser),
    });
    const next = jest.fn();
    return { done: mw.use(req, {} as any, next), prisma, req, next };
  }

  it('совпадает с сохранённым — в базу не пишет', async () => {
    const { done, prisma, req } = run(
      { firstName: 'Аня', username: 'anya' },
      { id: 777, first_name: 'Аня', username: 'anya' },
    );
    await done;
    expect(req.telegramUserId).toBe('usr_tg');
    expect((prisma.user as any).update).not.toHaveBeenCalled();
  });

  it('новый пользователь заводится сразу с именем — без второй записи', async () => {
    const { done, prisma } = run(
      { firstName: 'Аня', username: 'anya' },
      { id: 777, first_name: 'Аня', username: 'anya' },
    );
    await done;
    expect(prisma.user.upsert).toHaveBeenCalledWith({
      where: { telegramId: '777' },
      update: {},
      create: { telegramId: '777', firstName: 'Аня', username: 'anya' },
    });
  });

  it('пустые в базе — дописывает оба поля', async () => {
    const { done, prisma } = run(
      { firstName: null, username: null },
      { id: 777, first_name: 'Аня', username: 'anya' },
    );
    await done;
    expect((prisma.user as any).update).toHaveBeenCalledWith({
      where: { id: 'usr_tg' },
      data: { firstName: 'Аня', username: 'anya' },
    });
  });

  it('поменялся только @username — пишет только его; убранный — null', async () => {
    const { done, prisma } = run(
      { firstName: 'Аня', username: 'old' },
      { id: 777, first_name: 'Аня' },
    );
    await done;
    expect((prisma.user as any).update).toHaveBeenCalledWith({
      where: { id: 'usr_tg' },
      data: { username: null },
    });
  });

  it('сбой записи профиля не отнимает личность и не роняет запрос', async () => {
    const { mw, prisma } = build(null);
    prisma.user.upsert.mockResolvedValue({
      id: 'usr_tg',
      firstName: null,
      username: null,
    });
    (prisma.user as any).update = jest
      .fn()
      .mockRejectedValue(new Error('db down'));
    const req = request('GET', undefined, undefined, {
      'x-telegram-init-data': signedInitData({ id: 777, first_name: 'Аня' }),
    });
    const next = jest.fn();
    await mw.use(req, {} as any, next);
    expect(req.telegramUserId).toBe('usr_tg');
    expect(next).toHaveBeenCalled();
  });
});
