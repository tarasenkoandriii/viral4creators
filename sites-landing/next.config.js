// @ts-check
const { PHASE_PRODUCTION_BUILD } = require('next/constants');

/**
 * Проверка `SITE_URL` до сборки (ТЗ лендинга §0, §8.1, §14 Л0).
 *
 * В `landing/` при незаданном `SITE_URL` `alternates.ts` молча переходил
 * на относительные hreflang, а дефолт `http://localhost:3003` однажды
 * увёл редирект на машину посетителя. Здесь это не фолбэк, а ошибка
 * СБОРКИ: canonical, hreflang, sitemap, OG и JSON-LD строятся только от
 * абсолютного публичного адреса.
 *
 * Те же правила — в `src/lib/site-url.ts` (рантайм); совпадение
 * держит `scripts/seo.test.ts`. Две копии — потому что этот файл
 * читается Node без TypeScript.
 *
 * @param {string | undefined} raw
 * @param {{ production?: boolean }} [opts]
 * @returns {string} нормализованный origin без завершающего `/`
 */
function validateSiteUrl(raw, opts = {}) {
  if (!raw || !raw.trim()) {
    throw new Error(
      'SITE_URL не задан: прод-сборка sites-landing без абсолютного адреса сайта запрещена ' +
        '(canonical/hreflang/sitemap). Задайте SITE_URL=https://<домен> (см. sites-landing/.env.example).',
    );
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`SITE_URL не URL: «${raw}»`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`SITE_URL должен быть https://, получено «${raw}»`);
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')) {
    throw new Error(`SITE_URL указывает на локальную машину: «${raw}»`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.port) {
    throw new Error(`SITE_URL — только origin (https://домен), без пути, порта и параметров: «${raw}»`);
  }
  if (opts.production && host.endsWith('.invalid')) {
    throw new Error(
      `SITE_URL — заглушка «${raw}» в продакшен-деплое Vercel. Решите В-1 (домен) и задайте настоящий адрес.`,
    );
  }
  return `https://${host}`;
}

/**
 * Связь с продуктом (Л2–Л3) — зеркало `src/lib/assist-env.ts` (совпадение
 * держит `scripts/assist-env.test.ts`). Умолчания адресов — временные
 * домены `src/brand.ts` (`ASSIST_DEFAULTS`); читаем их из исходника, чтобы
 * не держать третью копию строк.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** @param {string} raw @param {string} name @param {{ onVercel: boolean }} opts */
function validateAssistOrigin(raw, name, opts) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${name} не URL: «${raw}»`);
  }
  const host = url.hostname.toLowerCase();
  const local = LOCAL_HOSTS.has(host);
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} — только origin (https://домен), без пути и параметров: «${raw}»`);
  }
  if (url.protocol === 'https:' && !url.port && !local) return `https://${host}`;
  if (local && !opts.onVercel && (url.protocol === 'http:' || url.protocol === 'https:')) {
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`;
  }
  throw new Error(`${name} должен быть https://домен без порта (http://localhost — только для стенда вне Vercel): «${raw}»`);
}

/** @param {Record<string, string | undefined>} env @param {Record<string, string>} defaults */
function validateAssistEnv(env, defaults) {
  const onVercel = env.VERCEL === '1';
  /** @param {string | undefined} v */
  const pick = (v) => (v && v.trim() ? v : null);
  const out = {
    ASSIST_WIDGET_ORIGIN: validateAssistOrigin(pick(env.ASSIST_WIDGET_ORIGIN) ?? defaults.widgetOrigin, 'ASSIST_WIDGET_ORIGIN', { onVercel }),
    ASSIST_API_ORIGIN: validateAssistOrigin(pick(env.ASSIST_API_ORIGIN) ?? defaults.apiOrigin, 'ASSIST_API_ORIGIN', { onVercel }),
    ASSIST_WIDGET_PK: '',
    ASSIST_BOT_USERNAME: '',
    ASSIST_LANDING_EVENTS: '',
  };
  const pk = pick(env.ASSIST_WIDGET_PK);
  if (pk) {
    const m = /^pk_(live|test)_[A-Za-z0-9_-]{8,64}$/.exec(pk.trim());
    if (!m) throw new Error(`ASSIST_WIDGET_PK — не публичный ключ виджета (pk_live_…): «${pk}»`);
    if (m[1] === 'test' && onVercel) throw new Error('ASSIST_WIDGET_PK: pk_test_ работает только на localhost — на Vercel нужен pk_live_');
    out.ASSIST_WIDGET_PK = pk.trim();
  }
  const bot = pick(env.ASSIST_BOT_USERNAME);
  if (bot) {
    const name = bot.trim().replace(/^@/, '');
    if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) || !/bot$/i.test(name)) {
      throw new Error(`ASSIST_BOT_USERNAME — не имя бота Telegram (…bot): «${bot}»`);
    }
    out.ASSIST_BOT_USERNAME = name;
  }
  const events = (env.ASSIST_LANDING_EVENTS ?? '').trim().toLowerCase();
  if (events && events !== 'on' && events !== 'off') {
    throw new Error(`ASSIST_LANDING_EVENTS — on|off, получено «${env.ASSIST_LANDING_EVENTS}»`);
  }
  out.ASSIST_LANDING_EVENTS = events;
  return out;
}

function assistDefaults() {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'src/brand.ts'), 'utf8');
  const widgetOrigin = /widgetOrigin: '([^']+)'/.exec(src)?.[1];
  const apiOrigin = /apiOrigin: '([^']+)'/.exec(src)?.[1];
  if (!widgetOrigin || !apiOrigin) throw new Error('next.config: не нашлось ASSIST_DEFAULTS в src/brand.ts');
  return { widgetOrigin, apiOrigin };
}

/**
 * Проверка — только у `next build`. `next lint` тоже грузит конфиг в фазе
 * PHASE_PRODUCTION_BUILD, но адрес сайта ему не нужен, и требовать
 * SITE_URL у линтера значило бы приучить ставить заглушку «чтобы
 * прошло». Второй замок — `siteUrl()` в рантайме: при сборке в обход
 * `next build` страница с canonical упадёт на пререндере.
 *
 * @param {string} phase
 * @param {readonly string[]} argv
 */
function isNextBuild(phase, argv = process.argv) {
  return phase === PHASE_PRODUCTION_BUILD && argv.slice(2).includes('build');
}

/** @type {(phase: string) => import('next').NextConfig} */
module.exports = (phase) => {
  /** @type {Record<string, string>} */
  const env = {};
  if (isNextBuild(phase)) {
    // Без SITE_URL (или с негодным) `next build` падает здесь.
    validateSiteUrl(process.env.SITE_URL, { production: process.env.VERCEL_ENV === 'production' });
  }
  if (phase === PHASE_PRODUCTION_BUILD && process.env.SITE_URL) {
    // Проверенный адрес впекается в сборку: рантайму (и статике, и
    // route handlers) переменная уже не нужна, и canonical не может
    // разойтись между сборкой и запуском. Без `isNextBuild`: компиляцию
    // Next ведёт в отдельном процессе-воркере с другим argv, а env у
    // воркера тот же.
    env.SITE_URL = validateSiteUrl(process.env.SITE_URL, { production: process.env.VERCEL_ENV === 'production' });
  }
  if (phase === PHASE_PRODUCTION_BUILD) {
    // Связь с продуктом (Л2–Л3): негодный адрес/ключ/бот — ошибка сборки,
    // не молчаливый фолбэк. Впекаются всегда (пустая строка = «не задано»),
    // чтобы рантайм и клиентский код видели ровно проверенное.
    Object.assign(env, validateAssistEnv(process.env, assistDefaults()));
  }
  return {
    env,
    reactStrictMode: true,
    poweredByHeader: false,
    async headers() {
      return [
        {
          source: '/:path*',
          headers: [
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
            { key: 'X-Frame-Options', value: 'DENY' },
          ],
        },
      ];
    },
  };
};

module.exports.validateSiteUrl = validateSiteUrl;
module.exports.isNextBuild = isNextBuild;
module.exports.validateAssistEnv = validateAssistEnv;
module.exports.assistDefaults = assistDefaults;
