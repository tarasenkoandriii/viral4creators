import { randomBytes } from 'crypto';
import {
  CdpCookie,
  CookieJarTooLargeError,
  MAX_COOKIE_JAR_BYTES,
  decryptCookieJar,
  encryptCookieJar,
  parseCookieJar,
  restoreCookieJar,
  serializeCookieJar,
  toSettableCookie,
} from './cookie-jar';

/**
 * §5.1 ТЗ клиентской обучалки держится на этом примитиве целиком:
 * браузер закрывается после КАЖДОГО шага визарда, и состояние
 * авторизации переезжает в следующий шаг только через cookie jar. Обе
 * тонкости CDP, проверяемые ниже, ломают ровно сессионные куки логина —
 * и ломают молча: CDP отвечает успехом, кука просто не появляется.
 */

const SESSION_COOKIE: CdpCookie = {
  name: 'sid',
  value: 'abc123',
  domain: 'shop.example.com',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
  expires: -1,
};

describe('toSettableCookie — тонкости CDP', () => {
  it('сессионная кука уходит БЕЗ поля expires, а не с -1', () => {
    const settable = toSettableCookie(SESSION_COOKIE);
    // Именно здесь ломалось бы самое ценное: -1 CDP принимает как
    // «истекла в 1969», и кука логина исчезает сразу же.
    expect('expires' in settable).toBe(false);
    expect(settable).toMatchObject({
      name: 'sid',
      domain: 'shop.example.com',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });
  });

  it('кука с реальным сроком жизни его сохраняет', () => {
    const settable = toSettableCookie({
      ...SESSION_COOKIE,
      expires: 4_102_444_800,
    });
    expect(settable.expires).toBe(4_102_444_800);
  });

  it('SameSite=None без Secure теряет ТОЛЬКО атрибут, а не саму куку', () => {
    const settable = toSettableCookie({
      ...SESSION_COOKIE,
      secure: false,
      sameSite: 'None',
    });
    expect(settable.sameSite).toBeUndefined();
    expect(settable.name).toBe('sid');
  });

  it('SameSite=None вместе с Secure остаётся как есть', () => {
    const settable = toSettableCookie({
      ...SESSION_COOKIE,
      secure: true,
      sameSite: 'None',
    });
    expect(settable.sameSite).toBe('None');
  });
});

describe('parseCookieJar — вход недоверенный', () => {
  it('нормализует корректный jar', () => {
    const { cookies, dropped } = parseCookieJar([SESSION_COOKIE]);
    expect(dropped).toBe(0);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].path).toBe('/');
  });

  it('отбрасывает кривые записи поштучно, не роняя весь jar', () => {
    const { cookies, dropped } = parseCookieJar([
      SESSION_COOKIE,
      null,
      'строка',
      { name: '', value: 'x', domain: 'a.example' },
      { name: 'ok', value: 'x', domain: '' },
      { name: 'ok', value: 42, domain: 'a.example' },
    ]);
    expect(cookies).toHaveLength(1);
    expect(dropped).toBe(5);
  });

  it('пустое значение куки — легально (так её гасят на стороне сайта)', () => {
    const { cookies } = parseCookieJar([{ ...SESSION_COOKIE, value: '' }]);
    expect(cookies).toHaveLength(1);
  });

  it('уже просроченные куки отбрасываются', () => {
    const now = new Date('2026-09-16T12:00:00Z');
    const { cookies, dropped } = parseCookieJar(
      [
        { ...SESSION_COOKIE, name: 'old', expires: 1_600_000_000 },
        { ...SESSION_COOKIE, name: 'live' },
      ],
      now,
    );
    expect(cookies.map((c) => c.name)).toEqual(['live']);
    expect(dropped).toBe(1);
  });

  it('не массив — пустой jar, а не исключение', () => {
    expect(parseCookieJar(null)).toEqual({ cookies: [], dropped: 1 });
    expect(parseCookieJar({ cookies: [] })).toEqual({
      cookies: [],
      dropped: 1,
    });
  });

  it('подставляет умолчания для отсутствующих необязательных полей', () => {
    const { cookies } = parseCookieJar([
      { name: 'a', value: 'b', domain: 'c.example' },
    ]);
    expect(cookies[0]).toMatchObject({
      path: '/',
      secure: false,
      httpOnly: false,
      expires: -1,
    });
    expect(cookies[0].sameSite).toBeUndefined();
  });

  it('неизвестное значение sameSite отбрасывается, кука остаётся', () => {
    const { cookies } = parseCookieJar([
      { ...SESSION_COOKIE, sameSite: 'Whatever' },
    ]);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].sameSite).toBeUndefined();
  });
});

describe('restoreCookieJar', () => {
  it('отдаёт куки в page.setCookie отдельными аргументами', async () => {
    const page = { setCookie: jest.fn().mockResolvedValue(undefined) };
    const second: CdpCookie = {
      ...SESSION_COOKIE,
      name: 'sso',
      domain: 'accounts.google.com',
    };

    const result = await restoreCookieJar(page, [SESSION_COOKIE, second]);

    expect(result).toEqual({ restored: 2 });
    expect(page.setCookie).toHaveBeenCalledTimes(1);
    const args = page.setCookie.mock.calls[0];
    expect(args).toHaveLength(2);
    // Куки СТОРОННЕГО домена тоже восстанавливаются — §7.4.5 ТЗ требует
    // весь jar, иначе SSO-вход разваливается на следующем шаге.
    expect(args[1]).toMatchObject({ domain: 'accounts.google.com' });
  });

  it('пустой jar — не вызов setCookie вовсе (первый шаг визарда)', async () => {
    const page = { setCookie: jest.fn().mockResolvedValue(undefined) };
    await expect(restoreCookieJar(page, [])).resolves.toEqual({ restored: 0 });
    expect(page.setCookie).not.toHaveBeenCalled();
  });
});

describe('сериализация и шифрование', () => {
  const key = randomBytes(32).toString('base64');

  it('шифрование → расшифровка возвращает тот же jar', () => {
    const encrypted = encryptCookieJar([SESSION_COOKIE], key);
    expect(encrypted).not.toContain('abc123');
    const { cookies, dropped } = decryptCookieJar(encrypted, key);
    expect(dropped).toBe(0);
    expect(cookies).toEqual([SESSION_COOKIE]);
  });

  it('jar сверх потолка — явная ошибка, а не обрезание', () => {
    const fat: CdpCookie[] = [
      { ...SESSION_COOKIE, value: 'x'.repeat(MAX_COOKIE_JAR_BYTES) },
    ];
    expect(() => serializeCookieJar(fat)).toThrow(CookieJarTooLargeError);
    expect(() => encryptCookieJar(fat, key)).toThrow(CookieJarTooLargeError);
  });

  it('подменённая запись не расшифровывается тихо (AES-GCM аутентифицирован)', () => {
    const encrypted = encryptCookieJar([SESSION_COOKIE], key);
    const otherKey = randomBytes(32).toString('base64');
    // Чужой ключ — ровно тот случай, ради которого куки вообще шифруют:
    // утечка строки из БД не должна означать выдачу доступа. Молча
    // отдать мусор вместо кук нельзя, и это гарантирует token-crypto.
    expect(() => decryptCookieJar(encrypted, otherKey)).toThrow();
  });

  it('валидная расшифровка с не-JSON внутри — пустой jar', () => {
    // Строку шифруем в обход сериализатора, как будто её записала более
    // старая версия кода.
    const encrypted = encryptCookieJarRaw('не json', key);
    expect(decryptCookieJar(encrypted, key)).toEqual({
      cookies: [],
      dropped: 1,
    });
  });
});

/** Помощник теста: шифрует произвольную строку тем же способом, что и
 * модуль, — чтобы смоделировать запись, сделанную другой версией кода. */
function encryptCookieJarRaw(plain: string, key: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { encryptToken } = require('./token-crypto') as {
    encryptToken: (p: string, k: string) => string;
  };
  return encryptToken(plain, key);
}
