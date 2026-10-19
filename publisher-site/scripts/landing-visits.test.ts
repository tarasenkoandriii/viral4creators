/**
 * Счётчик «Посещения лендингов» платформы (§13.5; внутренний аудит
 * 19.10.2026: IA-AB-03 = IA-C-01 = Н-D1-2, решения Р-IA-FXA-1…3).
 *
 * Исходный сценарий дефекта: каждый просмотр ai-publisher.org слал
 * `POST https://backend-iota-ruddy-57.vercel.app/api/public/landing-visits`
 * без учёта согласия и режима, адрес — в коде и CSP. Здесь проверяются все
 * ветки решения: нет env → канала нет (и нет в CSP), нет согласия → нет,
 * `closed`/`test` → нет, `live` + согласие → да; правила адреса совпадают с
 * `next.config.js`; тело — без cookie, referrer и идентификаторов
 * посетителя; адрес нигде не зашит в исходники.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ConsentState, ProductMode } from '../src/lib/api-types';
import { PUBLISHER_BRAND } from '../src/brand';
import {
  LANDING_VISITS_LANDING,
  LANDING_VISITS_LOCALE,
  landingVisitsTarget,
  landingVisitsUrlOf,
  sendLandingVisit,
} from '../src/lib/landing-visits';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cfg = require(path.join(__dirname, '..', 'next.config.js')) as {
  validateLandingVisitsUrl: (env: Record<string, string | undefined>) => string;
  contentSecurityPolicy: (api: string, visits?: string) => string;
};
const ROOT = path.join(__dirname, '..');
const URL_PROD = 'https://backend-iota-ruddy-57.vercel.app/api/public/landing-visits';
let n = 0;
const outcome = (f: () => string) => {
  try {
    return f();
  } catch {
    return 'THROW';
  }
};

// 1. Адрес из окружения: правила TS ≡ next.config.js, без значения — канал выключен.
const envCases: Array<[Record<string, string | undefined>, string]> = [
  [{}, ''],
  [{ PUBLISHER_LANDING_VISITS_URL: '' }, ''],
  [{ PUBLISHER_LANDING_VISITS_URL: '   ' }, ''],
  [{ PUBLISHER_LANDING_VISITS_URL: URL_PROD }, URL_PROD],
  [{ PUBLISHER_LANDING_VISITS_URL: ` ${URL_PROD} ` }, URL_PROD],
  [{ PUBLISHER_LANDING_VISITS_URL: URL_PROD, VERCEL: '1', VERCEL_ENV: 'production' }, URL_PROD],
  [{ PUBLISHER_LANDING_VISITS_URL: URL_PROD, VERCEL: '1', VERCEL_ENV: 'preview' }, ''],
  [{ PUBLISHER_LANDING_VISITS_URL: URL_PROD, VERCEL: '1', VERCEL_ENV: 'development' }, ''],
  [
    { PUBLISHER_LANDING_VISITS_URL: 'https://Backend.Example.org/api/public/landing-visits' },
    'https://backend.example.org/api/public/landing-visits',
  ],
  [
    { PUBLISHER_LANDING_VISITS_URL: 'http://localhost:3000/api/public/landing-visits' },
    'http://localhost:3000/api/public/landing-visits',
  ],
  [{ PUBLISHER_LANDING_VISITS_URL: 'http://localhost:3000/api/public/landing-visits', VERCEL: '1' }, 'THROW'],
  [{ PUBLISHER_LANDING_VISITS_URL: 'http://backend.example.org/api/public/landing-visits' }, 'THROW'],
  [{ PUBLISHER_LANDING_VISITS_URL: 'https://backend.example.org' }, 'THROW'],
  [{ PUBLISHER_LANDING_VISITS_URL: 'https://backend.example.org/' }, 'THROW'],
  [{ PUBLISHER_LANDING_VISITS_URL: 'https://backend.example.org:8443/x' }, 'THROW'],
  [{ PUBLISHER_LANDING_VISITS_URL: 'https://backend.example.org/x?k=1' }, 'THROW'],
  [{ PUBLISHER_LANDING_VISITS_URL: 'https://backend.example.org/x#h' }, 'THROW'],
  [{ PUBLISHER_LANDING_VISITS_URL: 'https://u:p@backend.example.org/x' }, 'THROW'],
  [{ PUBLISHER_LANDING_VISITS_URL: 'не url' }, 'THROW'],
];
for (const [env, want] of envCases) {
  n += 2;
  const ts = outcome(() => landingVisitsUrlOf(env));
  assert.equal(ts, want, `landingVisitsUrlOf ${JSON.stringify(env)}`);
  assert.equal(
    outcome(() => cfg.validateLandingVisitsUrl(env)),
    ts,
    `next.config ≡ src ${JSON.stringify(env)}`,
  );
}

// 2. Решение по site-config: только live и только при согласии (granted | not_required).
const modes: ProductMode[] = ['closed', 'test', 'live'];
const consents: ConsentState[] = ['granted', 'denied', 'unknown', 'not_required'];
for (const mode of modes)
  for (const consentState of consents) {
    n++;
    const want = mode === 'live' && (consentState === 'granted' || consentState === 'not_required') ? URL_PROD : null;
    assert.equal(landingVisitsTarget(URL_PROD, { mode, consentState }), want, `${mode}/${consentState}`);
  }
// Нет env — выключен при любом конфиге (в т. ч. live + granted).
for (const mode of modes)
  for (const consentState of consents) {
    n++;
    assert.equal(landingVisitsTarget('', { mode, consentState }), null, `нет env: ${mode}/${consentState}`);
  }

// 3. CSP: без адреса — ровно свой origin и API; с адресом — плюс его origin (не путь).
const connectOf = (csp: string) =>
  csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('connect-src '));
assert.equal(
  connectOf(cfg.contentSecurityPolicy('https://api.example.org')),
  "connect-src 'self' https://api.example.org",
);
assert.equal(
  connectOf(cfg.contentSecurityPolicy('https://api.example.org', '')),
  "connect-src 'self' https://api.example.org",
);
assert.equal(
  connectOf(cfg.contentSecurityPolicy('https://api.example.org', URL_PROD)),
  "connect-src 'self' https://api.example.org https://backend-iota-ruddy-57.vercel.app",
);
assert.equal(
  connectOf(cfg.contentSecurityPolicy('https://api.example.org', 'https://api.example.org/visits')),
  "connect-src 'self' https://api.example.org",
  'тот же origin не дублируется',
);
n += 4;

// 4. Запрос: POST JSON {eventId, landing, locale}; без cookie, referrer, URL, query и ID посетителя.
const calls: Array<{ url: string; init: RequestInit }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: string, i: RequestInit) => (
  calls.push({ url: String(u), init: i }),
  new Response(null)
)) as typeof fetch;
sendLandingVisit(URL_PROD);
sendLandingVisit(URL_PROD);
assert.equal(calls.length, 2);
const [{ url, init }] = calls;
assert.equal(url, URL_PROD);
assert.equal(init.method, 'POST');
assert.equal(init.credentials, 'omit', 'без cookie');
assert.equal(init.referrerPolicy, 'no-referrer', 'без referrer');
assert.equal(init.keepalive, true);
assert.deepEqual(init.headers, { 'content-type': 'application/json' });
const body = JSON.parse(String(init.body)) as Record<string, string>;
assert.deepEqual(Object.keys(body).sort(), ['eventId', 'landing', 'locale'], 'только eventId, landing, locale');
assert.deepEqual({ landing: body.landing, locale: body.locale }, { landing: LANDING_VISITS_LANDING, locale: 'uk' });
assert.match(
  body.eventId,
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  'eventId — случайный UUID',
);
const second = JSON.parse(String(calls[1].init.body)) as Record<string, string>;
assert.notEqual(second.eventId, body.eventId, 'eventId не постоянен — не идентификатор посетителя');
n += 11;
assert.equal(LANDING_VISITS_LOCALE, PUBLISHER_BRAND.lang, 'язык счётчика = язык сайта');
n++;
// Сбой сети не всплывает (страница не падает).
let rejected = false;
globalThis.fetch = (() => ((rejected = true), Promise.reject(new Error('net')))) as typeof fetch;
sendLandingVisit(URL_PROD);
assert.equal(rejected, true);
globalThis.fetch = realFetch;
n++;

// 5. Исходники: адрес нигде не зашит; layout решает через landingVisitsTarget; клиент шлёт только при адресе.
const walk = (d: string): string[] =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'next.config.js')]) {
  n++;
  assert.ok(
    !/backend-iota-ruddy-57|https?:\/\/[^\s'"`]*landing-visits/.test(fs.readFileSync(f, 'utf8')),
    `адрес зашит в ${f}`,
  );
}
const layout = fs.readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8');
assert.match(layout, /landingVisitsTarget\(env\.landingVisitsUrl, cfg\)/, 'layout: решение по env + site-config');
assert.doesNotMatch(layout, /VERCEL_ENV/, 'layout: включение не по VERCEL_ENV');
const track = fs.readFileSync(path.join(ROOT, 'src/components/Track.tsx'), 'utf8');
assert.match(track, /if \(visitsEndpoint\) sendLandingVisit\(visitsEndpoint\)/, 'Track: только при адресе от сервера');
assert.equal((track.match(/sendLandingVisit\(/g) ?? []).length, 1, 'Track: один вызов');
// `src/components/LandingVisits.tsx` — копия компонента landing ради теста паритета трёх копий
// (`landing/scripts/landing-visits.test.ts`); в сайте Publisher её никто не импортирует (в бандл не попадает).
for (const f of walk(path.join(ROOT, 'src')))
  assert.doesNotMatch(
    fs.readFileSync(f, 'utf8'),
    /from ['"][^'"]*LandingVisits['"]/,
    `импорт копии LandingVisits в ${f}`,
  );
n += 5;

console.log(`ok   landing-visits: ${n} проверок (env ≡ next.config, live + согласие, CSP, тело без ID/cookie)`);
