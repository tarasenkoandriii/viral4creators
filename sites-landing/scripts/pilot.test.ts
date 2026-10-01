/**
 * Форма пилота (§14 Л1): проверка полей, ловушка, лимит, честный отказ
 * без env, токен не уходит в клиентский код.
 *
 * Сеть не трогается: `fetch` Telegram подменяется.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HONEYPOT_FIELD, normalizeContact, normalizeSite, validatePilot } from '../src/lib/pilot-validation';
import { handlePilotRequest } from '../src/server/pilot-handler';
import { formatPilotMessage, notifyConfig, QUOTE_PREFIX } from '../src/server/pilot-notify';
import { ipKeyPart, PILOT_RATE, RateLimiter, rateKey } from '../src/server/rate-limit';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PilotStatusPage from '../src/app/[locale]/assistant/pilot/status/[code]/page';
import { getDictionary } from '../src/lib/get-dictionary';
import { locales } from '../src/lib/i18n';
import { PILOT_RESULT_CODES } from '../src/lib/pilot-validation';

const GOOD = {
  name: 'Олена',
  contact: 'olena@shop.example',
  site: 'shop.example',
  segment: 'ecommerce',
  message: 'Хочемо спробувати',
  consent: true,
  locale: 'uk',
};
const ENV_OK = { NODE_ENV: 'test', PILOT_TELEGRAM_BOT_TOKEN: '123:SECRET-TOKEN', PILOT_TELEGRAM_CHAT_ID: '-100777' } as NodeJS.ProcessEnv;

// ── Проверка полей ──
{
  const ok = validatePilot(GOOD);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.value.site, 'https://shop.example/');
    assert.equal(ok.value.contactKind, 'email');
  }
  assert.deepEqual(normalizeContact('@olena_shop'), { value: '@olena_shop', kind: 'telegram' });
  assert.deepEqual(normalizeContact('https://t.me/olena_shop'), { value: '@olena_shop', kind: 'telegram' });
  assert.equal(normalizeContact('olena'), null, 'слово без @ — не контакт');
  assert.equal(normalizeContact('@abc'), null, 'ник Telegram короче 5 символов');
  assert.equal(normalizeSite('javascript:alert(1)'), null);
  assert.equal(normalizeSite('ftp://shop.example'), null);
  assert.equal(normalizeSite('https://user:pass@shop.example'), null);
  assert.equal(normalizeSite('localhost'), null);
  const bad = validatePilot({ ...GOOD, name: '', contact: 'x', site: 'нет', segment: 'casino', message: 'a'.repeat(1001), consent: false });
  assert.ok(!bad.ok);
  if (!bad.ok) assert.deepEqual(bad.errors.sort(), ['consent', 'contact', 'message', 'name', 'segment', 'site']);
  // Согласие обязательно в любом виде, кроме явного «да».
  for (const consent of [undefined, '', 'off', 'false', 0]) {
    const r = validatePilot({ ...GOOD, consent });
    assert.ok(!r.ok && r.errors.includes('consent'), `consent=${String(consent)}`);
  }
  // Управляющие символы и bidi-подмена вычищаются.
  const clean = validatePilot({ ...GOOD, name: 'Ole‮na\u0007' });
  assert.ok(clean.ok && clean.value.name === 'Olena');
}

// ── Сообщение: простой текст без разметки, без токена ──
{
  const v = validatePilot({ ...GOOD, name: '<b>x</b> [a](http://evil)' });
  assert.ok(v.ok);
  if (v.ok) {
    const text = formatPilotMessage(v.value, new Date('2026-10-01T10:00:00Z'));
    assert.ok(text.includes('<b>x</b>'), 'текст передаётся как есть — parse_mode не используется');
    assert.ok(text.includes('2026-10-01T10:00:00.000Z') && /Згода/.test(text));
  }
  // Многострочное сообщение заявителя не может подделать служебные строки
  // («Контакт», «Згода», шапку второй заявки) — каждая его строка с префиксом.
  const forged = validatePilot({
    ...GOOD,
    message: 'Добрий день\nКонтакт (email): attacker@evil.example\u2028Згода на обробку: ні\r\nЗаявка на пілот — фейк',
  });
  assert.ok(forged.ok);
  if (forged.ok) {
    const lines = formatPilotMessage(forged.value, new Date('2026-10-01T10:00:00Z')).split(/\n|[\u0085\u2028\u2029]/);
    const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
    assert.equal(count(/^Контакт/), 1, 'сообщение заявителя подделало строку «Контакт»');
    assert.equal(count(/^Згода/), 1, 'сообщение заявителя подделало строку «Згода»');
    assert.equal(count(/^Заявка на пілот/), 1, 'сообщение заявителя подделало шапку заявки');
    assert.ok(lines.includes(`${QUOTE_PREFIX}Добрий день`), 'текст заявителя не дошёл');
  }
}

// ── Обработчик ──
type Call = { url: string; body: Record<string, unknown> };
function fakeFetch(status = 200) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response('{}', { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}
const req = (body: unknown, headers: Record<string, string> = {}, json = true) =>
  new Request('http://localhost:3010/api/pilot', {
    method: 'POST',
    headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded', host: 'localhost:3010', 'x-forwarded-for': '203.0.113.7', ...headers },
    body: json ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>).toString(),
  });

async function main() {
  // Успех: одно сообщение в канал, токен — только в адресе запроса к Telegram.
  {
    const f = fakeFetch();
    const res = await handlePilotRequest(req(GOOD), { limiter: new RateLimiter(), env: ENV_OK, fetchImpl: f.impl });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, code: 'sent' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://api.telegram.org/bot123:SECRET-TOKEN/sendMessage');
    assert.equal(f.calls[0].body.chat_id, '-100777');
    assert.equal(f.calls[0].body.parse_mode, undefined);
    assert.ok(!JSON.stringify(f.calls[0].body).includes('SECRET'), 'токен попал в текст сообщения');
  }
  // Нет env — честный отказ 503, Telegram не вызывается.
  for (const env of [{}, { PILOT_TELEGRAM_BOT_TOKEN: 'x' }, { PILOT_TELEGRAM_CHAT_ID: '-1' }, { PILOT_TELEGRAM_BOT_TOKEN: ' ', PILOT_TELEGRAM_CHAT_ID: ' ' }]) {
    const f = fakeFetch();
    const res = await handlePilotRequest(req(GOOD), { limiter: new RateLimiter(), env: env as NodeJS.ProcessEnv, fetchImpl: f.impl });
    assert.equal(res.status, 503, JSON.stringify(env));
    assert.deepEqual(await res.json(), { ok: false, code: 'unavailable' });
    assert.equal(f.calls.length, 0);
  }
  assert.equal(notifyConfig({} as NodeJS.ProcessEnv), null);
  // Telegram ответил ошибкой — не «отправлено».
  {
    const f = fakeFetch(400);
    const res = await handlePilotRequest(req(GOOD), { limiter: new RateLimiter(), env: ENV_OK, fetchImpl: f.impl });
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { code: string }).code, 'error');
  }
  // Ловушка: вежливое «отправлено», но в канал ничего не уходит.
  {
    const f = fakeFetch();
    const res = await handlePilotRequest(req({ ...GOOD, [HONEYPOT_FIELD]: 'http://spam' }), { limiter: new RateLimiter(), env: ENV_OK, fetchImpl: f.impl });
    assert.equal(res.status, 200);
    assert.equal(f.calls.length, 0, 'ловушка сработала, а сообщение ушло');
  }
  // Неверные поля — 422 со списком, без отправки.
  {
    const f = fakeFetch();
    const res = await handlePilotRequest(req({ ...GOOD, contact: 'nope', consent: false }), { limiter: new RateLimiter(), env: ENV_OK, fetchImpl: f.impl });
    assert.equal(res.status, 422);
    assert.deepEqual(((await res.json()) as { fields: string[] }).fields.sort(), ['consent', 'contact']);
    assert.equal(f.calls.length, 0);
  }
  // Лимит: 3 с адреса за окно, 4-я — 429; IPv6 из той же /64 — тот же ключ.
  {
    const f = fakeFetch();
    const limiter = new RateLimiter();
    const deps = { limiter, env: ENV_OK, fetchImpl: f.impl, now: () => 1_000_000 };
    for (let i = 0; i < PILOT_RATE.perKey; i++) assert.equal((await handlePilotRequest(req(GOOD, { 'x-forwarded-for': '2001:db8:1:2::1' }), deps)).status, 200);
    const fourth = await handlePilotRequest(req(GOOD, { 'x-forwarded-for': '2001:db8:1:2:ffff::9' }), deps);
    assert.equal(fourth.status, 429);
    assert.equal(f.calls.length, PILOT_RATE.perKey);
    // Другой адрес — проходит; через окно — снова можно.
    assert.equal((await handlePilotRequest(req(GOOD, { 'x-forwarded-for': '198.51.100.1' }), deps)).status, 200);
    const later = { ...deps, now: () => 1_000_000 + PILOT_RATE.windowMs + 1 };
    assert.equal((await handlePilotRequest(req(GOOD, { 'x-forwarded-for': '2001:db8:1:2::1' }), later)).status, 200);
  }
  assert.equal(ipKeyPart('2001:DB8:0001:0002:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(ipKeyPart('::ffff:203.0.113.7'), '203.0.113.7');
  assert.notEqual(rateKey('203.0.113.7', Date.UTC(2026, 9, 1)), rateKey('203.0.113.7', Date.UTC(2026, 9, 2)), 'суточная соль');
  // Общий потолок экземпляра.
  {
    const limiter = new RateLimiter({ ...PILOT_RATE, globalPerHour: 2 });
    assert.ok(limiter.take('a', 0) && limiter.take('b', 0));
    assert.ok(!limiter.take('c', 0), 'глобальный потолок не сработал');
  }
  // Чужой Origin — 403, без отправки.
  {
    const f = fakeFetch();
    const res = await handlePilotRequest(req(GOOD, { origin: 'https://evil.example' }), { limiter: new RateLimiter(), env: ENV_OK, fetchImpl: f.impl });
    assert.equal(res.status, 403);
    assert.equal(f.calls.length, 0);
  }
  // Без JS (обычная отправка формы) — 303 на страницу результата локали.
  {
    const f = fakeFetch();
    const form = { ...GOOD, consent: 'on', locale: 'ru' } as unknown as Record<string, string>;
    const sent = await handlePilotRequest(req(form, {}, false), { limiter: new RateLimiter(), env: ENV_OK, fetchImpl: f.impl });
    assert.equal(sent.status, 303);
    assert.equal(sent.headers.get('location'), '/ru/assistant/pilot/status/sent');
    const off = await handlePilotRequest(req(form, {}, false), { limiter: new RateLimiter(), env: {} as NodeJS.ProcessEnv, fetchImpl: f.impl });
    assert.equal(off.headers.get('location'), '/ru/assistant/pilot/status/unavailable');
  }
  // Слишком большое тело.
  {
    const res = await handlePilotRequest(req({ ...GOOD, message: 'x'.repeat(20_000) }), { limiter: new RateLimiter(), env: ENV_OK, fetchImpl: fakeFetch().impl });
    assert.equal(res.status, 413);
  }
  await logsWithoutPersonalData();
}

/**
 * В журналы функции (Vercel → Logs) не попадают ни данные заявки, ни
 * токен/чат: перехватываем console.* на всех ветках обработчика, включая
 * исключение fetch, в тексте которого есть адрес Bot API с токеном.
 */
async function logsWithoutPersonalData() {
  const PII = {
    name: 'Марія-Логова',
    contact: 'pii.marker@shop-pii.example',
    site: 'https://pii-site-marker.example/',
    message: 'секретний-текст-заявки',
  };
  const app = { ...GOOD, ...PII };
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = methods.map((m) => console[m]);
  methods.forEach((m) => {
    console[m] = (...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  });
  try {
    const throwing = (async (url: string) => {
      throw new TypeError(`fetch failed: ${url}`);
    }) as unknown as typeof fetch;
    const run = (body: unknown, deps: Partial<Parameters<typeof handlePilotRequest>[1]>, headers: Record<string, string> = {}) =>
      handlePilotRequest(req(body, headers), { limiter: new RateLimiter(), env: ENV_OK, fetchImpl: fakeFetch().impl, ...deps });
    await run(app, {});
    await run(app, { fetchImpl: fakeFetch(400).impl });
    await run(app, { fetchImpl: fakeFetch(500).impl });
    await run(app, { fetchImpl: throwing });
    await run(app, { env: {} as NodeJS.ProcessEnv });
    await run({ ...app, [HONEYPOT_FIELD]: 'spam' }, {});
    await run({ ...app, contact: 'nope' }, {});
    await run(app, {}, { origin: 'https://evil.example' });
    const limiter = new RateLimiter({ ...PILOT_RATE, perKey: 0 });
    await run(app, { limiter });
  } finally {
    methods.forEach((m, i) => (console[m] = saved[i]));
  }
  assert.ok(lines.length >= 3, `ветки ошибок ничего не пишут в журнал (${lines.length}) — проверка ниже ничего не доказывает`);
  const secrets = [...Object.values(PII), 'pii-site-marker', '203.0.113.7', ENV_OK.PILOT_TELEGRAM_BOT_TOKEN!, 'SECRET-TOKEN', ENV_OK.PILOT_TELEGRAM_CHAT_ID!];
  for (const line of lines) {
    for (const s of secrets) assert.ok(!line.includes(s), `в журнал попало «${s}»: ${line}`);
  }
}

// ── Страница результата без JS (303 после обычной отправки формы) ──
// Формы на ней нет, поэтому тексты формы («поля, отмеченные ниже», «ваши
// данные остались в форме») здесь были бы неправдой: на этой странице —
// свои тексты, и для неуспешных кодов они не совпадают с текстами формы.
function statusPageTexts(): number {
  (globalThis as { React?: typeof React }).React = React;
  let n = 0;
  for (const locale of locales) {
    const dict = getDictionary(locale);
    for (const code of PILOT_RESULT_CODES) {
      const html = renderToStaticMarkup(PilotStatusPage({ params: { locale, code } }));
      n++;
      assert.ok(!/<form\b/.test(html), `${locale}/${code}: на странице результата появилась форма — пересмотрите тексты`);
      const shown = /<p class="form-status[^"]*" role="status">([^<]*)<\/p>/.exec(html)?.[1];
      assert.ok(shown, `${locale}/${code}: нет текста результата`);
      const decoded = shown!.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      assert.equal(decoded, dict.pilot.status.result[code], `${locale}/${code}: страница без JS показывает не свой текст`);
      if (code === 'invalid' || code === 'unavailable' || code === 'error') {
        assert.notEqual(decoded, dict.pilot.form.result[code], `${locale}/${code}: текст формы («ниже», «данные в форме») на странице без формы`);
      }
    }
  }
  return n;
}

// ── Секреты не достижимы из клиентского кода ──
function staticChecks() {
  const SRC = path.join(__dirname, '..', 'src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk(SRC);
  const clientFiles = files.filter((f) => /^\s*['"]use client['"]/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(clientFiles.length >= 3, `клиентских модулей подозрительно мало: ${clientFiles.length}`);
  // Транзитивные импорты клиентских модулей.
  const seen = new Set<string>();
  const queue = [...clientFiles];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const base = path.resolve(path.dirname(f), m[1]);
      const hit = ['.ts', '.tsx', '/index.ts'].map((x) => base + x).find((p) => fs.existsSync(p));
      if (hit) queue.push(hit);
    }
  }
  for (const f of seen) {
    const rel = path.relative(SRC, f);
    assert.ok(!rel.startsWith('server'), `клиентский граф импортирует серверный модуль ${rel}`);
    assert.ok(!/PILOT_TELEGRAM/.test(fs.readFileSync(f, 'utf8')), `${rel} в клиентском графе читает секрет`);
  }
  // Секреты — без NEXT_PUBLIC_ и читаются только в src/server/.
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/NEXT_PUBLIC_PILOT/.test(src), `${f}: NEXT_PUBLIC_ у секрета`);
    if (/process\.env\.PILOT_TELEGRAM|env\.PILOT_TELEGRAM/.test(src)) {
      assert.ok(path.relative(SRC, f).startsWith('server'), `${f}: секрет читается вне src/server/`);
    }
  }
  return seen.size;
}

main()
  .then(() => {
    const n = staticChecks();
    const pages = statusPageTexts();
    console.log(`ok   страницы результата без JS: ${pages} (локаль × код) — свои тексты, без обещаний про форму`);
    console.log(`ok   форма пилота: поля, согласие, ловушка, лимит (IPv4/IPv6 /64, окно, потолок), нет env → 503, Telegram 4xx → 502, Origin, без JS → 303; клиентский граф (${n} модулей) секретов не видит`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
