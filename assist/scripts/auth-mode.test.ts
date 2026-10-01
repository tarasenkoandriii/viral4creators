import assert from 'node:assert/strict';
import { createApiClient } from '../src/kit/api-client';
import { ApiError } from '../src/kit/envelope';
import { createSitesApi } from '../src/kit/sites-api';
import { buildRequestAuth, detectAuthMode } from '../src/kit/telegram';
import { createWebAuthApi } from '../src/kit/web-auth';

// ── Режим решает только initData ──────────────────────────────────────
const off = { enabled: false };
const dev = { enabled: true, userId: '7' };
assert.equal(detectAuthMode('query_id=1&hash=x', off), 'tma');
assert.equal(detectAuthMode('query_id=1&hash=x', dev), 'tma');
assert.equal(detectAuthMode('', off), 'web'); // WebApp вне Telegram
assert.equal(detectAuthMode(undefined, off), 'web');
assert.equal(detectAuthMode(null, off), 'web');
assert.equal(detectAuthMode('', dev), 'dev');

// ── Заголовки по режиму ───────────────────────────────────────────────
assert.deepEqual(buildRequestAuth('assist', 'web', '', off), {
  headers: { 'X-Telegram-App': 'assist' },
  credentials: 'same-origin',
});
// Веб не шлёт initData, даже если строка где-то осталась.
assert.deepEqual(buildRequestAuth('assist', 'web', 'q=1', dev), {
  headers: { 'X-Telegram-App': 'assist' },
  credentials: 'same-origin',
});
assert.deepEqual(buildRequestAuth('assist', 'tma', 'q=1', dev), {
  headers: { 'X-Telegram-App': 'assist', 'X-Telegram-Init-Data': 'q=1' },
  credentials: 'omit',
});
// TMA без initData — входа нет (дев-заголовок только в режиме dev).
assert.equal(buildRequestAuth('assist', 'tma', '', dev), null);
assert.deepEqual(buildRequestAuth('qa', 'dev', '', dev), {
  headers: { 'X-Telegram-App': 'qa', 'X-Dev-User-Id': '7' },
  credentials: 'omit',
});

// ── Клиент на подменённом fetch ───────────────────────────────────────
type Init = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  credentials?: string;
};
const calls: Array<{ url: string; init: Init }> = [];
let reply = { status: 200, body: '' };
const fakeFetch = (async (url: string, init: Init) => {
  calls.push({ url, init });
  return { status: reply.status, text: async () => reply.body };
}) as unknown as typeof fetch;
const ok = (data: unknown) => ({
  status: 200,
  body: JSON.stringify({ success: true, data }),
});
const fail = (status: number, code: string) => ({
  status,
  body: JSON.stringify({ success: false, error: { code, message: 'x' } }),
});
const last = () => calls[calls.length - 1];

let accountId: string | null = null;
let unauthorized = 0;
const webClient = createApiClient({
  baseUrl: '/api',
  auth: () => buildRequestAuth('assist', 'web', '', off),
  accountId: () => accountId,
  locale: () => 'en',
  onUnauthorized: () => {
    unauthorized++;
  },
  fetchImpl: fakeFetch,
});
const web = createSitesApi(webClient);

reply = ok([]);
await web.listSites();
assert.equal(last().url, '/api/sites'); // same-origin прокси по умолчанию
assert.equal(last().init.credentials, 'same-origin');
assert.equal(last().init.headers['X-Telegram-App'], 'assist');
assert.equal(last().init.headers['X-Telegram-Init-Data'], undefined);
assert.equal(last().init.headers['X-Dev-User-Id'], undefined);
assert.equal(last().init.headers['X-Site-Account'], undefined);
assert.equal(last().init.headers['Accept-Language'], 'en');

// Переключатель кабинета → X-Site-Account.
accountId = 'acc_2';
await web.listSites();
assert.equal(last().init.headers['X-Site-Account'], 'acc_2');
// Мусор в хранилище не уходит заголовком (сервер его всё равно отверг бы).
accountId = 'bad id/../x';
await web.listSites();
assert.equal(last().init.headers['X-Site-Account'], undefined);
accountId = null;

// 401 → приложение возвращает экран входа.
reply = fail(401, 'UNAUTHORIZED');
await web.listSites().catch(() => undefined);
assert.equal(unauthorized, 1);
reply = fail(403, 'ACCOUNT_REQUIRED');
await web.listSites().catch(() => undefined);
assert.equal(unauthorized, 1, '403 — не «сессия истекла»');

// TMA-клиент: initData, без cookie.
const tma = createSitesApi(
  createApiClient({
    baseUrl: 'https://sites.example',
    auth: () => buildRequestAuth('assist', 'tma', 'q=1', off),
    accountId: () => 'acc_1',
    locale: () => 'uk',
    fetchImpl: fakeFetch,
  })
);
reply = ok([]);
await tma.listSites();
assert.equal(last().init.credentials, 'omit');
assert.equal(last().init.headers['X-Telegram-Init-Data'], 'q=1');
assert.equal(last().init.headers['X-Site-Account'], 'acc_1');

// ── Веб-сессия ────────────────────────────────────────────────────────
const auth = createWebAuthApi(webClient);
reply = ok({ telegramId: '42', firstName: 'Ann', username: 'ann' });
assert.deepEqual(await auth.me(), {
  telegramId: '42',
  firstName: 'Ann',
  username: 'ann',
});
assert.equal(last().url, '/api/sites/auth/me');
assert.equal(last().init.method, 'GET');
assert.equal(last().init.credentials, 'same-origin');
reply = fail(401, 'UNAUTHORIZED');
assert.equal(await auth.me(), null);
// Сеть/5xx на /me — не «не вошёл», а ошибка (экран покажет «Повторить»).
reply = { status: 502, body: 'bad gateway' };
let thrown: unknown = null;
try {
  await auth.me();
} catch (e) {
  thrown = e;
}
assert.ok(thrown instanceof ApiError);

// Тело web-login — объект виджета как есть (подпись по его полям).
const widget = {
  id: 42,
  first_name: 'Ann',
  username: 'ann',
  auth_date: 1700000000,
  hash: 'abc',
};
// Ответ — форма контроллера: `{ user, expiresAt }` (не плоский, как /me).
reply = ok({
  user: { telegramId: '42', username: 'ann', firstName: 'Ann' },
  expiresAt: '2026-10-08T00:00:00.000Z',
});
assert.deepEqual(await auth.login(widget), {
  telegramId: '42',
  firstName: 'Ann',
  username: 'ann',
});
assert.equal(last().url, '/api/sites/auth/web-login');
assert.equal(last().init.method, 'POST');
assert.deepEqual(JSON.parse(last().init.body!), widget);
assert.equal(last().init.headers['X-Telegram-App'], 'assist');
assert.equal(last().init.credentials, 'same-origin');

// Выход: и пустой ответ, и «уже не вошёл» — тоже выход.
reply = { status: 200, body: JSON.stringify({ success: true }) };
await auth.logout();
assert.equal(last().url, '/api/sites/auth/logout');
reply = fail(401, 'UNAUTHORIZED');
await auth.logout();
reply = fail(500, 'INTERNAL_SERVER_ERROR');
thrown = null;
try {
  await auth.logout();
} catch (e) {
  thrown = e;
}
assert.ok(thrown instanceof ApiError, '5xx при выходе не глотается');

console.log('auth-mode: ok');
