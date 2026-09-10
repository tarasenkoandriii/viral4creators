/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * Cookie постоянного логина frontend/ — единственное, что связывает
 * браузер с Telegram-пользователем вне Telegram. Флаги этой cookie не
 * косметика, и ошибиться в них можно молча:
 *
 *  - без `httpOnly` любой XSS на домене уносит сессию на 30 дней;
 *  - в проде frontend и backend — РАЗНЫЕ домены Vercel, то есть
 *    `fetch(credentials:'include')` кросс-сайтовый: при `SameSite=Lax`
 *    браузер cookie просто не пришлёт, и вход «работает, но не
 *    работает»;
 *  - `SameSite=None` без `Secure` браузер отбрасывает вовсе — эти два
 *    флага обязаны включаться вместе;
 *  - у `clearCookie` атрибуты должны совпадать с теми, что ставили,
 *    иначе выход не гасит ничего и человек остаётся вошедшим.
 *
 * Ни одно из этого не проверялось: контроллер не исполнялся ни разу.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { TelegramLoginController } from './telegram-login.controller';

const EXPIRES = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

function build() {
  const service = {
    loginWithTelegram: jest
      .fn()
      .mockResolvedValue({ token: 'tok_1', expiresAt: EXPIRES }),
    devLogin: jest
      .fn()
      .mockResolvedValue({ token: 'tok_dev', expiresAt: EXPIRES }),
    logout: jest.fn().mockResolvedValue({ ok: true }),
    resolveToken: jest.fn().mockResolvedValue('usr_1'),
    me: jest.fn().mockResolvedValue({
      telegramId: '4242',
      firstName: 'Пётр',
      username: 'petr',
    }),
  };
  const res = { cookie: jest.fn(), clearCookie: jest.fn() } as any;
  return {
    controller: new TelegramLoginController(service as any),
    service,
    res,
  };
}

const req = (cookie?: string) => ({ headers: { cookie } }) as any;

const envBackup = { ...process.env };
beforeEach(() => {
  process.env.NODE_ENV = 'test';
});
afterEach(() => {
  process.env = { ...envBackup };
});

describe('TelegramLoginController — флаги cookie', () => {
  it('вне прода: httpOnly, без Secure, SameSite=Lax', async () => {
    // Локальный стенд ходит по http://localhost — Secure там сделал бы
    // cookie неустанавливаемой, а два localhost-порта остаются
    // same-site по RFC, поэтому Lax работает.
    const { controller, res } = build();
    await controller.telegramCallback({} as any, res);

    expect(res.cookie).toHaveBeenCalledWith('user_session', 'tok_1', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      expires: EXPIRES,
      path: '/',
    });
  });

  it('в проде: Secure и SameSite=None включаются вместе', async () => {
    // None нужен потому, что frontend и backend — разные домены, а
    // Secure обязателен: None без него браузер отбрасывает по
    // спецификации, и вход перестал бы работать целиком.
    process.env.NODE_ENV = 'production';
    const { controller, res } = build();
    await controller.telegramCallback({} as any, res);

    const options = res.cookie.mock.calls[0][2];
    expect(options.secure).toBe(true);
    expect(options.sameSite).toBe('none');
    expect(options.httpOnly).toBe(true);
  });

  it('срок жизни cookie равен сроку жизни серверной сессии', async () => {
    // Разъедься они — либо браузер шлёт мёртвый токен и получает
    // «аноним» без объяснения, либо cookie исчезает раньше, чем
    // сессия, и человека разлогинивает без причины.
    const { controller, res } = build();
    await controller.telegramCallback({} as any, res);
    expect(res.cookie.mock.calls[0][2].expires).toBe(EXPIRES);
  });

  it('токен не попадает в тело ответа — иначе httpOnly бессмысленна', async () => {
    // Токен, отданный в JSON, доступен любому скрипту на странице; ради
    // защиты от этого cookie и делалась httpOnly.
    const { controller, res } = build();
    const body = await controller.telegramCallback({} as any, res);
    expect(body).toEqual({ expiresAt: EXPIRES });
    expect(JSON.stringify(body)).not.toContain('tok_1');
  });

  it('dev-вход выдаёт ту же cookie с теми же флагами', async () => {
    // Иначе локальный стенд проверял бы не тот путь, которым люди
    // пользуются в проде.
    const { controller, res, service } = build();
    await controller.devLogin({ devUserId: 7 }, res);

    expect(service.devLogin).toHaveBeenCalledWith('7');
    expect(res.cookie).toHaveBeenCalledWith(
      'user_session',
      'tok_dev',
      expect.objectContaining({ httpOnly: true, path: '/' }),
    );
  });
});

describe('TelegramLoginController — выход', () => {
  it('гасит и серверную сессию, и cookie', async () => {
    // Удалить только cookie мало: токен остался бы действующим и
    // работал бы у всякого, кто его успел скопировать.
    const { controller, res, service } = build();
    await expect(
      controller.logout(req('user_session=tok_1'), res),
    ).resolves.toEqual({ ok: true });

    expect(service.logout).toHaveBeenCalledWith('tok_1');
    expect(res.clearCookie).toHaveBeenCalledWith('user_session', {
      path: '/',
      secure: false,
      sameSite: 'lax',
    });
  });

  it('в проде cookie гасится теми же атрибутами, с какими ставилась', async () => {
    // Браузер удаляет cookie только при совпадении path/secure/sameSite;
    // разошлись атрибуты — «Выйти» ничего не делает, и человек остаётся
    // вошедшим в чужом браузере.
    process.env.NODE_ENV = 'production';
    const { controller, res } = build();
    await controller.telegramCallback({} as any, res);
    await controller.logout(req('user_session=tok_1'), res);

    const setOptions = res.cookie.mock.calls[0][2];
    const clearOptions = res.clearCookie.mock.calls[0][1];
    expect(clearOptions.path).toBe(setOptions.path);
    expect(clearOptions.secure).toBe(setOptions.secure);
    expect(clearOptions.sameSite).toBe(setOptions.sameSite);
  });

  it('выход без cookie не ходит в базу, но cookie всё равно гасит', async () => {
    // Повторное нажатие «Выйти» — обычное дело; запрос на удаление
    // пустого токена удалил бы строку с token=undefined или упал.
    const { controller, res, service } = build();
    await controller.logout(req(undefined), res);
    expect(service.logout).not.toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalled();
  });
});

describe('TelegramLoginController — /me', () => {
  it('без cookie отвечает «не вошёл», а не ошибкой', async () => {
    // Анонимный посетитель — самый частый случай; 401 здесь ломал бы
    // главную страницу всем, кто ни разу не логинился.
    const { controller, service } = build();
    await expect(controller.me(req(undefined))).resolves.toEqual({
      loggedIn: false,
    });
    expect(service.resolveToken).not.toHaveBeenCalled();
  });

  it('протухшая сессия не отдаёт пользователя', async () => {
    // Cookie переживает серверную сессию (её срок хранится в браузере
    // независимо). Если бы /me отвечал по одной cookie, истёкшая сессия
    // выглядела бы действующей до самого первого отказа где-то дальше.
    const { controller, service } = build();
    service.resolveToken.mockResolvedValue(null);

    const result = await controller.me(req('user_session=протухший'));
    expect(result).toEqual({ loggedIn: false });
    expect(service.me).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('4242');
  });

  it('сессия жива, а пользователя уже нет — тоже «не вошёл»', async () => {
    const { controller, service } = build();
    service.me.mockResolvedValue(null);
    await expect(controller.me(req('user_session=tok_1'))).resolves.toEqual({
      loggedIn: false,
    });
  });

  it('действующая сессия отдаёт данные пользователя', async () => {
    const { controller, service } = build();
    await expect(controller.me(req('user_session=tok_1'))).resolves.toEqual({
      loggedIn: true,
      telegramId: '4242',
      firstName: 'Пётр',
      username: 'petr',
    });
    expect(service.resolveToken).toHaveBeenCalledWith('tok_1');
  });
});
