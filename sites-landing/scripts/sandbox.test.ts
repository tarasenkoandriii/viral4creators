/**
 * Песочница по URL (Л4, §6) — модель `src/lib/sandbox.ts`:
 *
 *  1. Предпроверка адреса — форма серверного `checkUrl` (§6.3, приёмка Л4:
 *     IP-литерал, `http:`, порт ≠ 443, `user:pass@` — отказ; ввод без схемы
 *     — https).
 *  2. Строгий разбор ответов: конверт, коды отказа → что показать
 *     (рубильник/потолок — «оставьте заявку», не ошибка; 4-я песочница —
 *     «откройте в Telegram», веб-входа нет).
 *  3. Безопасный рендер ответа (§6.2): только текст, `[S#]` — лишь номера
 *     из источников; ссылкой источник становится, только если это `https:`
 *     на хост песочницы (чужой хост, `http:`, `javascript:`, `data:`,
 *     логин, порт — текст без ссылки).
 *  4. Перенос в TMA: `startapp=sb_<id>` разбирает НАСТОЯЩИЙ `parseStartParam`
 *     из `site-tma-kit` (у payload есть читатель — урок Б-1).
 *  5. Сессия вкладки: битая/чужая/старше 24 ч — отбрасывается.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SANDBOX_ID_RE,
  SANDBOX_PUBLIC_LIMITS,
  answerSegments,
  parseAnswer,
  parseCreated,
  parseEnvelope,
  parseSession,
  parseView,
  precheckUrl,
  problemOf,
  safeSourceHref,
  safeThemeColor,
  serializeSession,
  sourceLabel,
  tmaSandboxLink,
  type SandboxView,
} from '../src/lib/sandbox';

// ── 1. Предпроверка адреса ──
const ok = (raw: string, url: string) => {
  const r = precheckUrl(raw);
  assert.ok(r.ok, `«${raw}» должен пройти: ${JSON.stringify(r)}`);
  assert.equal(r.url, url, raw);
};
const bad = (raw: string, problem: string) => {
  const r = precheckUrl(raw);
  assert.ok(!r.ok && r.problem === problem, `«${raw}» → ${problem}, получено ${JSON.stringify(r)}`);
};
ok('shop.example.com', 'https://shop.example.com/');
ok('  https://Shop.Example.com/catalog?utm=1  ', 'https://shop.example.com/catalog');
ok('https://shop.example.com:443/', 'https://shop.example.com/');
ok('пример.укр', 'https://xn--e1afmkfd.xn--j1amh/');
bad('', 'empty');
bad('   ', 'empty');
bad('http://shop.example.com', 'scheme');
bad('ftp://shop.example.com', 'scheme');
bad('javascript:alert(1)', 'scheme');
bad('data:text/html,x', 'scheme');
bad('shop.example.com:8443', 'port');
bad('https://shop.example.com:8080/', 'port');
bad('https://user:pass@shop.example.com/', 'credentials');
bad('https://user@shop.example.com/', 'credentials');
bad('https://169.254.169.254/latest/meta-data', 'ip');
bad('127.0.0.1', 'ip');
bad('https://[::1]/', 'ip');
bad('https://[::ffff:169.254.169.254]/', 'ip');
bad('https://2130706433/', 'ip');
bad('https://0x7f000001/', 'ip');
bad('localhost', 'host');
bad('https://intranet/', 'host');
bad('https://printer.local/', 'host');
bad('https://db.internal/', 'host');
bad('https://example.invalid/', 'host');
bad('https://x.onion/', 'host');
bad(`https://a.example/${'x'.repeat(2100)}`, 'too-long');

// ── 2. Разбор ответов ──
assert.equal(problemOf('SANDBOX_DISABLED', 503), 'unavailable');
assert.equal(problemOf('SANDBOX_BUDGET', 503), 'unavailable', 'потолок денег — «оставьте заявку», не ошибка (§6.3)');
assert.equal(problemOf('SANDBOX_LIMIT_IP', 429), 'limit-ip');
assert.equal(problemOf('SANDBOX_LIMIT_DOMAIN', 429), 'limit-domain');
assert.equal(problemOf('URL_REJECTED', 400), 'rejected');
assert.equal(problemOf('OPTED_OUT', 403), 'opted-out');
assert.equal(problemOf('BLOCKED_CATEGORY', 403), 'blocked');
assert.equal(problemOf('SANDBOX_NOT_FOUND', 404), 'gone');
assert.equal(problemOf('SANDBOX_EXPIRED', 410), 'gone');
assert.equal(problemOf('SANDBOX_QUESTIONS_EXHAUSTED', 429), 'exhausted');
assert.equal(problemOf(null, 503), 'unavailable');
assert.equal(problemOf('__proto__', 500), 'unexpected', 'код из прототипа — не «известный»');
assert.equal(problemOf('toString', 500), 'unexpected');
assert.equal(problemOf(null, 500), 'unexpected');

const created = { id: 'AbCdEfGhIjKlMnOpQrStUv', sandboxKey: 'k'.repeat(32), status: 'queued' };
assert.deepEqual(parseEnvelope(200, { success: true, data: created }, parseCreated), { ok: true, data: created });
assert.deepEqual(parseEnvelope(200, { success: true, data: { ...created, id: '../x' } }, parseCreated), { ok: false, problem: 'unexpected', code: null });
assert.deepEqual(parseEnvelope(200, { success: true, data: { ...created, status: 'pwned' } }, parseCreated), { ok: false, problem: 'unexpected', code: null });
assert.deepEqual(parseEnvelope(503, { success: false, error: { code: 'SANDBOX_BUDGET', message: '…' } }, parseCreated), { ok: false, problem: 'unavailable', code: 'SANDBOX_BUDGET' });
assert.deepEqual(parseEnvelope(500, 'oops', parseCreated), { ok: false, problem: 'unexpected', code: null });
assert.deepEqual(parseEnvelope(201, { success: false }, parseCreated), { ok: false, problem: 'unexpected', code: null });

const view: SandboxView = {
  id: created.id,
  kind: 'public',
  status: 'ready',
  statusReason: null,
  url: 'https://shop.example.com/',
  host: 'shop.example.com',
  title: 'Магазин',
  lang: 'uk',
  themeColor: '#0f766e',
  progress: { sitemap: true, found: 12, read: 8, titles: ['Головна', 'Доставка'] },
  pagesRead: 8,
  pagesLimit: SANDBOX_PUBLIC_LIMITS.pages,
  questions: 1,
  questionsLimit: SANDBOX_PUBLIC_LIMITS.questions,
  suggestedQuestions: ['Як доставка?', 'Скільки коштує?', 'Чи є гарантія?'],
  messages: [{ role: 'assistant', text: 'Так [S1].', sources: [{ n: 1, url: 'https://shop.example.com/d', title: 'Доставка' }], createdAt: '2026-10-02T10:00:00.000Z' }],
  expiresAt: '2026-10-03T10:00:00.000Z',
  answersFrom: 'sandbox',
};
assert.deepEqual(parseView(view), view);
assert.equal(parseView({ ...view, messages: [{ ...view.messages[0], role: 'system' }] }), null, 'чужая роль сообщения');
assert.equal(parseView({ ...view, progress: { ...view.progress, read: -1 } }), null);
assert.equal(parseView({ ...view, pagesRead: '8' }), null);
assert.equal(parseView({ ...view, messages: [{ ...view.messages[0], sources: [{ n: 1, url: 5, title: null }] }] }), null);
assert.equal(parseView({ ...view, suggestedQuestions: ['a', 'b', 'c', 'd', 5] })!.suggestedQuestions.length, 3, 'не больше 3 вопросов-кнопок');
assert.deepEqual(parseAnswer({ answer: 'x', sources: [], refused: true, questionsLeft: 3 }), { answer: 'x', sources: [], refused: true, questionsLeft: 3 });
assert.equal(parseAnswer({ answer: 'x', sources: [], refused: 'no', questionsLeft: 3 }), null);
assert.equal(parseAnswer({ answer: 'x', sources: [], refused: false, questionsLeft: -1 }), null);

// ── 3. Безопасный рендер ──
const host = 'shop.example.com';
assert.equal(safeSourceHref('https://shop.example.com/delivery?x=1#a', host), 'https://shop.example.com/delivery?x=1#a');
assert.equal(safeSourceHref('https://SHOP.example.com/d', host), 'https://shop.example.com/d');
for (const evil of [
  'https://evil.example/phish',
  'https://shop.example.com.evil.example/',
  'https://evil.example/@shop.example.com',
  'http://shop.example.com/d',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'https://user:pw@shop.example.com/',
  'https://shop.example.com:8443/',
  '//shop.example.com/x',
  '/relative',
  'https://www.shop.example.com/',
  '',
  null,
]) {
  assert.equal(safeSourceHref(evil as string | null, host), null, `ссылка не должна стать кликабельной: ${evil}`);
}
const hostile = 'Дивіться [тут](https://evil.example) <img src=x onerror=alert(1)> javascript:alert(1) [S1] [S9] [S2]';
const segs = answerSegments(hostile, [
  { n: 1, url: 'https://shop.example.com/a', title: 'A' },
  { n: 2, url: 'https://evil.example/', title: 'B' },
]);
assert.deepEqual(
  segs.map((s) => (s.kind === 'ref' ? `#${s.n}` : s.text)),
  ['Дивіться [тут](https://evil.example) <img src=x onerror=alert(1)> javascript:alert(1) ', '#1', ' [S9] ', '#2'],
  'текст — буквами, маркер без источника — тоже буквами',
);
assert.deepEqual(answerSegments('', []), []);
assert.equal(sourceLabel({ n: 3, url: 'https://shop.example.com/a/b', title: null }), 'shop.example.com/a/b');
assert.equal(sourceLabel({ n: 3, url: null, title: '  ' }), '#3');
assert.equal(safeThemeColor('#0f766e'), '#0F766E');
assert.equal(safeThemeColor('#abc'), '#AABBCC');
for (const c of ['red', 'url(javascript:1)', '#12345', '#1234567', 'expression(x)', '', null]) assert.equal(safeThemeColor(c as string | null), null, `цвет ${c}`);

// ── 4. Перенос в TMA: читатель payload — site-tma-kit ──
async function main() {
  const kit = (await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'site-tma-kit', 'src', 'start-param.ts')).href)) as {
    parseStartParam: (raw: string) => { kind: string; value: string } | null;
    START_PREFIXES: Record<string, string>;
  };
  const link = tmaSandboxLink('assist_stand_bot', created.id);
  assert.equal(link, `https://t.me/assist_stand_bot?startapp=sb_${created.id}`);
  const start = new URL(link).searchParams.get('startapp')!;
  assert.deepEqual(kit.parseStartParam(start), { kind: 'sb', value: created.id }, 'TMA не узнает payload песочницы');
  // Самый длинный id, который пропускает наш формат, — всё ещё читается TMA.
  const longest = 'a'.repeat(60);
  assert.ok(SANDBOX_ID_RE.test(longest) && !SANDBOX_ID_RE.test('a'.repeat(61)) && !SANDBOX_ID_RE.test('a'.repeat(15)));
  assert.deepEqual(kit.parseStartParam(new URL(tmaSandboxLink('b_bot', longest)).searchParams.get('startapp')!), { kind: 'sb', value: longest });
  assert.throws(() => tmaSandboxLink('b_bot', 'bad id'), /негодный id/);
  assert.throws(() => tmaSandboxLink('b_bot', 'a'.repeat(61)), /негодный id/);

  // ── 5. Сессия вкладки ──
  const now = Date.parse('2026-10-02T12:00:00Z');
  const s = { id: created.id, key: created.sandboxKey, createdAt: now - 3600_000 };
  assert.deepEqual(parseSession(serializeSession(s), now), s);
  assert.equal(parseSession(serializeSession({ ...s, createdAt: now - 25 * 3600_000 }), now), null, 'старше 24 ч');
  assert.equal(parseSession(serializeSession({ ...s, createdAt: now + 60_000 }), now), null, 'из будущего');
  assert.equal(parseSession('{"id":"x","key":"y","createdAt":1}', now), null);
  assert.equal(parseSession('не json', now), null);
  assert.equal(parseSession(null, now), null);

  console.log('ok   песочница: предпроверка адреса (IP-литералы, http, порт, логин, внутренние имена), строгий разбор ответов и кодов, безопасный рендер (ссылки только https на хост песочницы), sb_ читает site-tma-kit, сессия вкладки ≤ 24 ч');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
