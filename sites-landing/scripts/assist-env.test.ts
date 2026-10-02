/**
 * Связь лендинга с продуктом (Л2–Л3, `lib/assist-env.ts` + `next.config.js`):
 *  1. Две копии правил (конфиг на JS и TS-модуль) дают одно и то же на
 *     одних и тех же env: адреса — только https-origin (http://localhost —
 *     только стенд вне Vercel), ключ `pk_live_` (на Vercel `pk_test_` —
 *     ошибка), бот — `…bot`, события on/off.
 *  2. `next build` с негодным значением падает (конфиг в фазе сборки).
 *  3. Умолчания адресов — временные домены `doc/DEPLOYMENT.md` §6.0 из
 *     `brand.ts`; адреса и имена виджета в компонентах литералом не пишутся.
 *  4. Публичные имена виджета (`/v1/loader.js`, `V4CAssist`, якорь) —
 *     зеркало `widget/src/shared/brand.ts`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ASSIST_DEFAULTS, WIDGET_NAMES } from '../src/brand';
import { draftsEndpoint, eventsEndpoint, loaderUrl, readAssistEnv } from '../src/lib/assist-env';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextConfig = require('../next.config.js') as ((phase: string) => { env?: Record<string, string> }) & {
  validateAssistEnv: (env: Record<string, string | undefined>, d: Record<string, string>) => Record<string, string>;
  assistDefaults: () => Record<string, string>;
};
const ROOT = path.resolve(__dirname, '..');

assert.deepEqual(nextConfig.assistDefaults(), { ...ASSIST_DEFAULTS }, 'next.config читает умолчания из brand.ts');
assert.equal(ASSIST_DEFAULTS.widgetOrigin, 'https://assist-w.viral4creators.app');
assert.equal(ASSIST_DEFAULTS.apiOrigin, 'https://assist-api.viral4creators.app');

type Case = [Record<string, string>, Partial<{ widgetOrigin: string; apiOrigin: string; widgetPk: string | null; botUsername: string | null; eventsEnabled: boolean }> | null];
const cases: Case[] = [
  [{}, { widgetOrigin: ASSIST_DEFAULTS.widgetOrigin, apiOrigin: ASSIST_DEFAULTS.apiOrigin, widgetPk: null, botUsername: null, eventsEnabled: true }],
  [{ ASSIST_WIDGET_ORIGIN: 'https://W.Example.com/' }, { widgetOrigin: 'https://w.example.com' }],
  [{ ASSIST_WIDGET_ORIGIN: 'http://w.example.com' }, null],
  [{ ASSIST_WIDGET_ORIGIN: 'https://w.example.com/v1' }, null],
  [{ ASSIST_WIDGET_ORIGIN: 'https://w.example.com:8443' }, null],
  [{ ASSIST_WIDGET_ORIGIN: 'https://user:pw@w.example.com' }, null],
  [{ ASSIST_WIDGET_ORIGIN: 'w.example.com' }, null],
  [{ ASSIST_API_ORIGIN: 'http://localhost:3011' }, { apiOrigin: 'http://localhost:3011' }],
  [{ ASSIST_API_ORIGIN: 'http://127.0.0.1:3011' }, { apiOrigin: 'http://127.0.0.1:3011' }],
  [{ ASSIST_API_ORIGIN: 'http://localhost:3011', VERCEL: '1' }, null],
  [{ ASSIST_API_ORIGIN: 'http://10.0.0.1:3011' }, null],
  [{ ASSIST_WIDGET_PK: 'pk_live_abcdefgh12' }, { widgetPk: 'pk_live_abcdefgh12' }],
  [{ ASSIST_WIDGET_PK: 'pk_test_abcdefgh12' }, { widgetPk: 'pk_test_abcdefgh12' }],
  [{ ASSIST_WIDGET_PK: 'pk_test_abcdefgh12', VERCEL: '1' }, null],
  [{ ASSIST_WIDGET_PK: 'pk_live_short' }, null],
  [{ ASSIST_WIDGET_PK: 'sk_live_abcdefgh12' }, null],
  [{ ASSIST_WIDGET_PK: 'pk_live_abc"><script>' }, null],
  [{ ASSIST_BOT_USERNAME: '@assist_helper_bot' }, { botUsername: 'assist_helper_bot' }],
  [{ ASSIST_BOT_USERNAME: 'AssistBot' }, { botUsername: 'AssistBot' }],
  [{ ASSIST_BOT_USERNAME: 'assist_helper' }, null],
  [{ ASSIST_BOT_USERNAME: 'a b_bot' }, null],
  [{ ASSIST_LANDING_EVENTS: 'off' }, { eventsEnabled: false }],
  [{ ASSIST_LANDING_EVENTS: 'ON' }, { eventsEnabled: true }],
  [{ ASSIST_LANDING_EVENTS: 'maybe' }, null],
];
for (const [env, expected] of cases) {
  const where = JSON.stringify(env);
  if (expected === null) {
    assert.throws(() => readAssistEnv(env), Error, `assist-env.ts: ${where} должен падать`);
    assert.throws(() => nextConfig.validateAssistEnv(env, { ...ASSIST_DEFAULTS }), Error, `next.config.js: ${where} должен падать`);
    continue;
  }
  const ts = readAssistEnv(env);
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(ts[k as keyof typeof ts], v, `${where}: ${k}`);
  const js = nextConfig.validateAssistEnv(env, { ...ASSIST_DEFAULTS });
  // Вторая копия впекает то же самое (пустая строка = «не задано»).
  assert.deepEqual(readAssistEnv({ ...js, VERCEL: env.VERCEL }), ts, `${where}: копии разошлись`);
}

// next build: негодное значение — ошибка сборки.
{
  const saved = { ...process.env };
  try {
    process.env.ASSIST_WIDGET_PK = 'pk_live_<script>';
    assert.throws(() => nextConfig('phase-production-build'), /ASSIST_WIDGET_PK/);
    delete process.env.ASSIST_WIDGET_PK;
    process.env.ASSIST_API_ORIGIN = 'http://api.example.com';
    assert.throws(() => nextConfig('phase-production-build'), /ASSIST_API_ORIGIN/);
    delete process.env.ASSIST_API_ORIGIN;
    process.env.ASSIST_BOT_USERNAME = 'assist_bot';
    const cfg = nextConfig('phase-production-build');
    assert.equal(cfg.env?.ASSIST_BOT_USERNAME, 'assist_bot');
    assert.equal(cfg.env?.ASSIST_WIDGET_ORIGIN, ASSIST_DEFAULTS.widgetOrigin);
    assert.equal(cfg.env?.ASSIST_WIDGET_PK, '');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const env = readAssistEnv({ ASSIST_WIDGET_PK: 'pk_live_abcdefgh12' });
assert.equal(loaderUrl(env), 'https://assist-w.viral4creators.app/v1/loader.js');
assert.equal(eventsEndpoint(env), 'https://assist-api.viral4creators.app/public/landing/event');
assert.equal(eventsEndpoint(readAssistEnv({ ASSIST_LANDING_EVENTS: 'off' })), null);
assert.equal(draftsEndpoint(env), 'https://assist-api.viral4creators.app/public/widget-drafts');

// Имена виджета — зеркало widget/src/shared/brand.ts.
const widgetBrand = path.join(ROOT, '..', 'widget', 'src', 'shared', 'brand.ts');
assert.ok(fs.existsSync(widgetBrand), 'нет widget/src/shared/brand.ts');
const wb = fs.readFileSync(widgetBrand, 'utf8');
const constOf = (name: string) => new RegExp(`export const ${name} = '([^']+)'`).exec(wb)?.[1];
assert.equal(constOf('WIDGET_LOADER_PATH'), WIDGET_NAMES.loaderPath, 'путь загрузчика');
assert.equal(constOf('WIDGET_GLOBAL'), WIDGET_NAMES.global, 'глобал V4CAssist');
assert.equal(constOf('WIDGET_ANCHOR'), WIDGET_NAMES.anchor, 'якорь своей кнопки');

// Ни адресов продукта, ни имён виджета литералом в src/ (кроме brand.ts).
const offenders: string[] = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|json)$/.test(e.name) && !p.endsWith(path.join('src', 'brand.ts'))) {
      const text = fs.readFileSync(p, 'utf8');
      for (const lit of ['viral4creators.app', 'assist-w.', 'assist-api.', "'V4CAssist'", '/v1/loader.js', 't.me/', '#v4c-assist']) {
        if (text.includes(lit) && !(lit === 't.me/' && p.endsWith('widget-draft.ts'))) offenders.push(`${path.relative(ROOT, p)}: «${lit}»`);
      }
    }
  }
};
walk(path.join(ROOT, 'src'));
assert.deepEqual(offenders, [], `адреса/имена литералом вне brand.ts:\n${offenders.join('\n')}`);

console.log(`ok   связь с продуктом: ${cases.length} случаев env × 2 копии правил, сборка падает на негодном ключе/адресе, умолчания — временные домены §6.0, имена виджета = widget/src/shared/brand.ts, литералов адресов в src/ нет`);
