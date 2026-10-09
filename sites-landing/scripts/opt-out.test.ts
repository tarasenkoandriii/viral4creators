/**
 * Форма «уберите мой сайт» (Л4, §13) — `server/opt-out.ts`:
 *  1. Домен из ввода: схема/путь/порт/www отбрасываются; IP, «@», без точки — отказ.
 *  2. Поля: контакт — e-mail или @username; согласие обязательно; лимиты длины.
 *  3. Обработчик: чужой Origin, ловушка, лимит, поля, нет env, Telegram не
 *     принял — каждая ветка → 303 на свою страницу результата; ни одна не
 *     «съедает» запрос молча; токен не уходит ни в ответ, ни в лог.
 *  4. Сообщение в канал — простой текст, строки комментария с префиксом
 *     (подделать строку «Домен:» нельзя).
 *  5. Страница бота: форма без клиентского JS (обычный POST), поля — те, что
 *     читает обработчик.
 */
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderPage } from './lib/page';

process.env.SITE_URL = 'https://assist.example.com';

import BotPage from '../src/app/[locale]/assistant/bot/page';
import { OPT_OUT_CODES, OPT_OUT_HONEYPOT, formatOptOutMessage, handleOptOut, normalizeDomain, validateOptOut } from '../src/server/opt-out';
import { RateLimiter } from '../src/server/rate-limit';

(globalThis as { React?: typeof React }).React = React;

// ── 1. Домен ──
const dom: Array<[string, string | null]> = [
  ['shop.example.com', 'shop.example.com'],
  ['https://WWW.Shop.Example.com/path?x#y', 'shop.example.com'],
  ['http://shop.example.com:8080', 'shop.example.com'],
  ['пример.укр', 'xn--e1afmkfd.xn--j1amh'],
  ['192.168.0.1', null],
  ['localhost', null],
  ['user@shop.example.com', null],
  ['', null],
  ['shop..example.com', null],
  ['-bad.example.com', null],
  ['a'.repeat(300) + '.com', null],
];
for (const [raw, want] of dom) assert.equal(normalizeDomain(raw), want, `домен «${raw.slice(0, 40)}»`);

// ── 2. Поля ──
const good = { domain: 'shop.example.com', contact: 'owner@shop.example.com', comment: '', consent: 'on', locale: 'uk' };
assert.deepEqual(validateOptOut(good), { ok: true, value: { domain: 'shop.example.com', contact: 'owner@shop.example.com', comment: '', locale: 'uk' } });
assert.ok(validateOptOut({ ...good, contact: '@shop_owner' }).ok);
for (const bad of [
  { ...good, consent: undefined },
  { ...good, contact: 'не контакт' },
  { ...good, contact: '@ab' },
  { ...good, domain: '10.0.0.1' },
  { ...good, comment: 'x'.repeat(501) },
]) {
  assert.equal(validateOptOut(bad as Record<string, unknown>).ok, false, JSON.stringify(bad).slice(0, 80));
}
assert.equal((validateOptOut({ ...good, locale: 'de' }) as { value: { locale: string } }).value.locale, 'en');

// ── 4. Сообщение ──
const msg = formatOptOutMessage({ domain: 'shop.example.com', contact: '@owner', comment: 'ok\nДомен: evil.example', locale: 'uk' }, new Date('2026-10-02T10:00:00Z'));
assert.equal(msg.split('\n').filter((l) => l.startsWith('Домен:')).length, 1, 'строку «Домен:» подделали комментарием');
assert.ok(msg.includes('│ Домен: evil.example'));

// ── 3. Обработчик ──
const TOKEN = '123456:secret-token-must-not-leak';
const envOk = { PILOT_TELEGRAM_BOT_TOKEN: TOKEN, PILOT_TELEGRAM_CHAT_ID: '-1001' } as unknown as NodeJS.ProcessEnv;
const form = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request('https://assist.example.com/api/opt-out', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'assist.example.com', origin: 'https://assist.example.com', 'x-forwarded-for': '203.0.113.7', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const fields = { domain: 'shop.example.com', contact: 'owner@shop.example.com', consent: 'on', locale: 'ru' };

async function main() {
  const logs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => logs.push(a.join(' '));
  try {
    const calls: Array<{ url: string; body: string }> = [];
    const okFetch = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const deps = (extra: Partial<Parameters<typeof handleOptOut>[1]> = {}) => ({ limiter: new RateLimiter(), env: envOk, fetchImpl: okFetch, ...extra });
    const where = async (r: Promise<Response>) => {
      const res = await r;
      assert.equal(res.status, 303);
      return res.headers.get('location');
    };
    assert.equal(await where(handleOptOut(form(fields), deps())), '/ru/assistant/bot/status/sent');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes(TOKEN) && JSON.parse(calls[0].body).text.includes('shop.example.com'));
    assert.equal(await where(handleOptOut(form(fields, { origin: 'https://evil.example' }), deps())), '/en/assistant/bot/status/error', 'чужой Origin');
    assert.equal(await where(handleOptOut(form({ ...fields, [OPT_OUT_HONEYPOT]: 'bot' }), deps({ fetchImpl: (async () => assert.fail('ловушка отправила')) as unknown as typeof fetch }))), '/ru/assistant/bot/status/sent');
    assert.equal(await where(handleOptOut(form({ ...fields, consent: '' }), deps())), '/ru/assistant/bot/status/invalid');
    assert.equal(await where(handleOptOut(form(fields), deps({ env: {} as unknown as NodeJS.ProcessEnv }))), '/ru/assistant/bot/status/unavailable', 'без env — «НЕ отправлено»');
    assert.equal(await where(handleOptOut(form(fields), deps({ fetchImpl: (async () => new Response('', { status: 401 })) as unknown as typeof fetch }))), '/ru/assistant/bot/status/error');
    assert.equal(await where(handleOptOut(form(fields), deps({ fetchImpl: (async () => { throw new Error(TOKEN); }) as unknown as typeof fetch }))), '/ru/assistant/bot/status/error');
    assert.equal(await where(handleOptOut(form({ ...fields, comment: 'x'.repeat(5000) }), deps())), '/en/assistant/bot/status/error', 'тело больше предела');
    const limiter = new RateLimiter({ perKey: 3, windowMs: 600_000, globalPerHour: 30 });
    const codes: Array<string | null> = [];
    for (let i = 0; i < 4; i++) codes.push(await where(handleOptOut(form(fields), deps({ limiter }))));
    assert.equal(codes[3], '/ru/assistant/bot/status/limited', `лимит: ${codes}`);
    assert.ok(!logs.join('\n').includes(TOKEN), 'токен попал в лог');
    for (const c of codes) assert.ok(OPT_OUT_CODES.some((x) => c?.endsWith(`/${x}`)));
  } finally {
    console.error = origErr;
  }

  // ── 5. Страница бота ──
  const html = await renderPage(BotPage, { locale: 'uk' as const });
  const formHtml = /<form[^>]*data-testid="optout-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
  assert.match(formHtml, /method="post"/);
  assert.match(formHtml, /action="\/api\/opt-out"/);
  for (const name of ['domain', 'contact', 'comment', 'consent', 'locale', OPT_OUT_HONEYPOT]) assert.ok(formHtml.includes(`name="${name}"`), `поле ${name}`);
  assert.ok(html.includes('User-agent: V4C-Assist'), 'на странице нет правила robots.txt для нашего UA');

  console.log(`ok   opt-out: ${dom.length} вариантов домена, поля и согласие, все ветки обработчика → 303 на свою страницу (без env — «НЕ отправлено»), токен не в логе, комментарий не подделывает строки; форма страницы бота без JS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
