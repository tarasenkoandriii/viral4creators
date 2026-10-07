import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TELEGRAM_LOGIN_WIDGET_SRC } from '../src/kit/web-auth';

// Заголовки безопасности веб-кабинета (TODO I-М «Сквозной аудит
// 06.10.2026»): без CSP и `frame-ancestors` кабинет встраивался в чужую
// страницу (кликджекинг с поддоменов, куда cookie сессии уходит при
// `SameSite=Lax`). Политика живёт в `assist/vercel.json`; здесь — что она
// есть, что ключевые директивы на месте и что всё, что страница реально
// грузит (index.html, виджет входа, rewrite API), ею разрешено.

interface VercelHeaders {
  rewrites?: { source: string; destination: string }[];
  headers?: { source: string; headers: { key: string; value: string }[] }[];
}

const vercel = JSON.parse(
  readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')
) as VercelHeaders;
const indexHtml = readFileSync(
  new URL('../index.html', import.meta.url),
  'utf8'
);

const found = (vercel.headers ?? []).find((r) => r.source === '/(.*)');
if (!found) throw new Error('vercel.json: нет правила headers для "/(.*)"');
const rule = found;
const header = (name: string): string => {
  const h = rule.headers.filter(
    (x) => x.key.toLowerCase() === name.toLowerCase()
  );
  assert.equal(h.length, 1, `заголовок ${name} — ровно один`);
  return h[0].value;
};

assert.equal(header('X-Content-Type-Options'), 'nosniff');
assert.ok(
  ['strict-origin-when-cross-origin', 'strict-origin', 'no-referrer'].includes(
    header('Referrer-Policy')
  ),
  'Referrer-Policy — без полного адреса наружу'
);

// ── разбор CSP ───────────────────────────────────────────────────────
const csp = new Map<string, string[]>();
for (const part of header('Content-Security-Policy').split(';')) {
  const [name, ...sources] = part.trim().split(/\s+/);
  if (!name) continue;
  assert.ok(!csp.has(name), `CSP: директива ${name} повторена`);
  csp.set(name.toLowerCase(), sources);
}
const dir = (name: string): string[] => {
  const v = csp.get(name);
  if (!v) throw new Error(`CSP: нет директивы ${name}`);
  return v;
};
/** Разрешает ли список источников адрес (хост, `*.`-маска, путь-префикс). */
function allows(sources: string[], raw: string): boolean {
  const u = new URL(raw);
  return sources.some((s) => {
    if (s.startsWith("'")) return false;
    const m = /^(https?):\/\/(\*\.)?([^/]+)(\/.*)?$/.exec(s);
    if (!m) return false;
    if (`${m[1]}:` !== u.protocol) return false;
    const host = m[3].toLowerCase();
    const hostOk = m[2] ? u.hostname.endsWith(`.${host}`) : u.hostname === host;
    if (!hostOk) return false;
    const p = m[4];
    if (!p) return true;
    return p.endsWith('/') ? u.pathname.startsWith(p) : u.pathname === p;
  });
}

// Главное — от кликджекинга: только свой origin и Telegram Web.
assert.deepEqual(dir('frame-ancestors'), [
  "'self'",
  'https://web.telegram.org',
]);
assert.deepEqual(dir('default-src'), ["'self'"]);
assert.deepEqual(dir('object-src'), ["'none'"]);
assert.deepEqual(dir('base-uri'), ["'self'"]);

// Скрипты: без inline/eval и без «любой https».
const script = dir('script-src');
assert.ok(script.includes("'self'"));
for (const bad of [
  "'unsafe-inline'",
  "'unsafe-eval'",
  '*',
  'https:',
  'http:',
  'data:',
  'blob:',
]) {
  assert.ok(!script.includes(bad), `script-src не содержит ${bad}`);
}
for (const d of ['connect-src', 'frame-src', 'img-src', 'media-src']) {
  for (const bad of ['*', 'https:', 'http:']) {
    assert.ok(!dir(d).includes(bad), `${d} не содержит ${bad}`);
  }
}

// Всё внешнее из index.html разрешено своей директивой.
for (const m of indexHtml.matchAll(/<script[^>]*\ssrc="(https:[^"]+)"/g)) {
  assert.ok(
    allows(script, m[1]),
    `script-src не пускает ${m[1]} из index.html`
  );
}
for (const m of indexHtml.matchAll(
  /<link[^>]*href="(https:[^"]+)"[^>]*rel="stylesheet"|<link[^>]*rel="stylesheet"[^>]*href="(https:[^"]+)"/g
)) {
  const href = m[1] ?? m[2];
  assert.ok(allows(dir('style-src'), href), `style-src не пускает ${href}`);
}
if (indexHtml.includes('fonts.googleapis.com')) {
  assert.ok(
    allows(dir('font-src'), 'https://fonts.gstatic.com/s/sora/v1/x.woff2'),
    'font-src — файлы шрифтов Google'
  );
}

// Вход виджетом Telegram: скрипт с telegram.org и iframe oauth.telegram.org.
assert.ok(
  allows(script, TELEGRAM_LOGIN_WIDGET_SRC),
  'script-src — виджет входа'
);
assert.ok(
  allows(dir('frame-src'), 'https://oauth.telegram.org/embed/bot'),
  'frame-src — окно входа oauth.telegram.org'
);

// API: rewrite /api → sites-backend (same-origin) и прямой адрес.
const apiRewrite = (vercel.rewrites ?? []).find((r) =>
  r.source.startsWith('/api')
);
if (!apiRewrite) throw new Error('vercel.json: нет rewrite /api');
const apiOrigin = new URL(apiRewrite.destination.replace(/\$\d+/g, '')).origin;
assert.ok(dir('connect-src').includes("'self'"), "connect-src — 'self' (/api)");
assert.ok(
  allows(dir('connect-src'), `${apiOrigin}/sites/auth/me`),
  `connect-src — ${apiOrigin}`
);

// Загрузка документа знаний: клиентский put Vercel Blob (lib/blob-upload.ts).
assert.ok(
  allows(dir('connect-src'), 'https://vercel.com/api/blob/?pathname=a.pdf') &&
    allows(dir('connect-src'), 'https://vercel.com/api/blob/mpu'),
  'connect-src — API Vercel Blob'
);
assert.ok(
  !allows(dir('connect-src'), 'https://vercel.com/account'),
  'connect-src — только путь API Blob, не весь vercel.com'
);

// Предпросмотр виджета (WidgetPreview): about:blank-iframe наследует CSP,
// в нём <style> и НАСТОЯЩИЙ загрузчик с origin виджета (поддомен).
const widget = 'https://assist-w.viral4creators.app';
assert.ok(
  dir('style-src').includes("'unsafe-inline'"),
  'style-src — <style> макета'
);
assert.ok(
  allows(script, `${widget}/v1/loader.js`),
  'script-src — загрузчик виджета'
);
assert.ok(
  allows(dir('frame-src'), `${widget}/w/v1/frame`),
  'frame-src — iframe чата'
);
assert.ok(
  allows(dir('connect-src'), `${widget}/widget/v1/config`),
  'connect-src — API виджета'
);
assert.ok(
  allows(dir('img-src'), `${widget}/widget/v1/asset/x`),
  'img-src — логотип/аватар'
);
assert.ok(
  dir('img-src').includes('blob:'),
  'img-src — blob: (размер логотипа)'
);
assert.ok(
  dir('media-src').includes('blob:'),
  'media-src — blob: (проба голоса)'
);

// Отрицательная проба самого разборщика: чужое не проходит.
assert.ok(!allows(script, 'https://evil.example.com/x.js'));
assert.ok(!allows(script, 'https://viral4creators.app.evil.example/x.js'));

console.log(
  'ok   security-headers: CSP/frame-ancestors/nosniff/Referrer-Policy'
);
