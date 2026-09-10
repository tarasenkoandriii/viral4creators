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
});
