/**
 * Чистые правила веб-кабинета — то, что HTTP-тест проверяет только
 * косвенно: разбор списка источников, Referer как запасной источник,
 * атрибуты cookie, окно лимита, отказы сервиса сессий.
 */

import {
  checkWebAppHeader,
  checkWebOrigin,
  parseWebOrigins,
  readSessionToken,
  requestSourceOrigin,
  sessionCookieOptions,
} from './web-request';
import { LoginRateLimiter, parseWidgetBody } from './web-login';
import { WebSessionService, hashSessionToken } from './web-session.service';
import { MemoryWebSessionStore } from './testing/web-auth.testing';

const ENV = { WEB_CABINET_ORIGINS: 'https://Cab.example/ , https://b.example' };

describe('web-request: барьеры CSRF', () => {
  it('список источников: регистр, хвостовой слэш, пустые элементы', () => {
    expect(
      parseWebOrigins(' https://Cab.example/ ,,https://b.example'),
    ).toEqual(['https://cab.example', 'https://b.example']);
    expect(parseWebOrigins(undefined)).toEqual([]);
  });

  it('safe-методы не проверяются; POST — только из списка', () => {
    expect(checkWebOrigin('GET', { origin: 'https://evil' }, ENV)).toBeNull();
    expect(
      checkWebOrigin('POST', { origin: 'https://cab.example' }, ENV),
    ).toBeNull();
    expect(
      checkWebOrigin('DELETE', { origin: 'https://evil.example' }, ENV)?.code,
    ).toBe('WEB_CSRF_REJECTED');
  });

  it('совпадение — точное: поддомен и другой порт не проходят', () => {
    for (const o of [
      'https://x.cab.example',
      'https://cab.example:8443',
      'http://cab.example',
    ]) {
      expect(checkWebOrigin('POST', { origin: o }, ENV)).not.toBeNull();
    }
  });

  it('Origin: null → берётся Referer', () => {
    expect(
      requestSourceOrigin({
        origin: 'null',
        referer: 'https://cab.example/a?b=1',
      }),
    ).toBe('https://cab.example');
    expect(requestSourceOrigin({ referer: 'не url' })).toBeNull();
  });

  it('пустой список: в production — отказ, вне — пропуск', () => {
    expect(checkWebOrigin('POST', {}, { NODE_ENV: 'production' })?.code).toBe(
      'WEB_CSRF_REJECTED',
    );
    expect(checkWebOrigin('POST', {}, { NODE_ENV: 'development' })).toBeNull();
  });

  it('X-Telegram-App: на POST обязателен, если прислан — только assist', () => {
    expect(checkWebAppHeader('GET', {})).toBeNull();
    expect(checkWebAppHeader('POST', {})?.code).toBe('WEB_CSRF_REJECTED');
    expect(
      checkWebAppHeader('POST', { 'x-telegram-app': ' Assist ' }),
    ).toBeNull();
    expect(checkWebAppHeader('GET', { 'x-telegram-app': 'qa' })?.code).toBe(
      'WEB_APP_MISMATCH',
    );
  });

  it('cookie: читается своя, атрибуты HttpOnly/Lax/Path, Secure снимается только на dev-стенде', () => {
    expect(readSessionToken('a=1; v4c_site_session=tok; b=2')).toBe('tok');
    expect(readSessionToken('a=1')).toBeUndefined();
    expect(sessionCookieOptions({})).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(
      sessionCookieOptions({ ALLOW_DEV_AUTH: 'true', NODE_ENV: 'production' })
        .secure,
    ).toBe(true);
    expect(
      sessionCookieOptions({ ALLOW_DEV_AUTH: 'true', NODE_ENV: 'development' })
        .secure,
    ).toBe(false);
  });
});

describe('web-login: форма тела и лимит', () => {
  const ok = { id: 1, auth_date: 1, hash: 'a'.repeat(64) };

  it('принимает плоский объект строк/чисел', () => {
    expect(parseWidgetBody({ ...ok, username: 'x' })).toMatchObject(ok);
  });

  it.each([
    ['не объект', 'x'],
    ['массив', [ok]],
    ['вложенность', { ...ok, extra: { a: 1 } }],
    ['id ≤ 0', { ...ok, id: 0 }],
    ['id дробный', { ...ok, id: 1.5 }],
    ['hash не hex', { ...ok, hash: 'z'.repeat(64) }],
    ['странное имя поля', { ...ok, 'a-b': 'x' }],
    ['длинное значение', { ...ok, username: 'x'.repeat(600) }],
  ])('отказ: %s', (_name, body) => {
    expect(() => parseWidgetBody(body)).toThrow();
  });

  it('фиксированное окно: limit пропускает, limit+1 — ждать, после окна — снова можно', () => {
    const l = new LoginRateLimiter(2, 1000);
    expect(l.hit('ip', 0)).toBeNull();
    expect(l.hit('ip', 10)).toBeNull();
    expect(l.hit('ip', 20)).toBe(980);
    expect(l.hit('other', 20)).toBeNull();
    expect(l.hit('ip', 1000)).toBeNull();
  });

  it('переполнение ключей не растит память бесконечно', () => {
    const l = new LoginRateLimiter(1, 1000, 3);
    for (let i = 0; i < 10; i++) l.hit(`ip${i}`, 0);
    expect(
      (l as unknown as { hits: Map<string, unknown> }).hits.size,
    ).toBeLessThanOrEqual(3);
  });
});

describe('WebSessionService', () => {
  const input = {
    telegramId: 5n,
    app: 'assist' as const,
    username: null,
    firstName: null,
  };

  it('токен 43 символа base64url, в хранилище — только его SHA-256', async () => {
    const store = new MemoryWebSessionStore();
    const svc = new WebSessionService(store);
    const { token } = await svc.issue(input);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.rows[0].tokenHash).toBe(hashSessionToken(token));
    expect(
      JSON.stringify(store.rows, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    ).not.toContain(token);
  });

  it('сессия другого приложения не принимается', async () => {
    const store = new MemoryWebSessionStore();
    const svc = new WebSessionService(store);
    const { token } = await svc.issue(input);
    expect(await svc.resolve(token, 'qa')).toBeNull();
    expect(await svc.resolve(token, 'assist')).not.toBeNull();
  });

  it('вход чистит просроченные строки', async () => {
    const store = new MemoryWebSessionStore();
    const svc = new WebSessionService(store);
    await svc.issue(input);
    store.rows[0].expiresAt = new Date(Date.now() - 1);
    await svc.issue(input);
    expect(store.rows).toHaveLength(1);
  });

  it('revoke неизвестного/мусорного токена — false, без ошибки', async () => {
    const svc = new WebSessionService(new MemoryWebSessionStore());
    expect(await svc.revoke(undefined)).toBe(false);
    expect(await svc.revoke('x')).toBe(false);
    expect(await svc.revoke('A'.repeat(43))).toBe(false);
  });
});
