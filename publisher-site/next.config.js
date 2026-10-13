// @ts-check
const { PHASE_PRODUCTION_BUILD } = require('next/constants');

/**
 * Конфиг сборки publisher-site (проектный документ §13.1, §13.3, §13.7).
 *
 * 1. `SITE_URL` — абсолютный https-origin сборки: без него (или с
 *    http://, localhost, путём) `next build` ПАДАЕТ — canonical, sitemap и
 *    JSON-LD строятся только от него (как sites-landing). Те же правила —
 *    `src/lib/site-url.ts`; совпадение держит `scripts/env.test.ts`.
 * 2. Связь с API: `PUBLISHER_API_ORIGIN` (https-origin sites-backend;
 *    http://localhost — только стенд вне Vercel) и `PUBLISHER_PUBLIC_KEY`
 *    (`pp_…`) — обязательны для сборки: страницы берут контент и
 *    site-config из API, выдумывать их нечем.
 * 3. Индексация — два ключа (§13.3): `PUBLISHER_INDEXING=on` (только
 *    production-окружение Vercel; превью — всегда noindex) И
 *    `site-config.indexable` для хоста `SITE_URL`. Иначе — заголовок
 *    `X-Robots-Tag: noindex, nofollow` на ВСЕХ ответах. Флаг вычисляется
 *    при сборке (`headers()` пишется в routes-manifest): middleware без
 *    запроса к API его не знает. Открытие/закрытие гейта — пересборка
 *    (meta robots страниц обновляет и ревалидация).
 *
 * Проверенные значения впекаются в сборку (`env`): рантайм и ISR не
 * разойдутся со сборкой. Секреты (`PUBLISHER_REVALIDATE_SECRET`,
 * `PUBLISHER_OWNERSHIP_TOKEN`) НЕ впекаются — их читают route handlers в
 * рантайме. Клиентский код ни одну из переменных не читает: ключ и адрес
 * API форма и трекер получают серверными пропсами (`check-built`
 * проверяет, что в `.next/static` их нет).
 */

/**
 * @param {string | undefined} raw
 * @param {{ production?: boolean }} [opts]
 * @returns {string} origin без завершающего `/`
 */
function validateSiteUrl(raw, opts = {}) {
  if (!raw || !raw.trim()) {
    throw new Error(
      'SITE_URL не задан: сборка publisher-site без абсолютного адреса сайта запрещена ' +
        '(canonical/sitemap). Задайте SITE_URL=https://<домен> (см. publisher-site/.env.example).',
    );
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`SITE_URL не URL: «${raw}»`);
  }
  if (url.protocol !== 'https:') throw new Error(`SITE_URL должен быть https://, получено «${raw}»`);
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')) {
    throw new Error(`SITE_URL указывает на локальную машину: «${raw}»`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.port) {
    throw new Error(`SITE_URL — только origin (https://домен), без пути, порта и параметров: «${raw}»`);
  }
  if (opts.production && host.endsWith('.invalid')) {
    throw new Error(`SITE_URL — заглушка «${raw}» в продакшен-деплое Vercel.`);
  }
  return `https://${host}`;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const PUBLIC_KEY_RE = /^pp_[A-Za-z0-9]{24}$/;

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ PUBLISHER_API_ORIGIN: string, PUBLISHER_PUBLIC_KEY: string, PUBLISHER_INDEXING: string }}
 */
function validatePublisherEnv(env) {
  const onVercel = Boolean(env.VERCEL);
  const rawApi = (env.PUBLISHER_API_ORIGIN ?? '').trim();
  if (!rawApi) {
    throw new Error(
      'PUBLISHER_API_ORIGIN не задан: страницы собираются из публичного API (https-origin sites-backend).',
    );
  }
  let url;
  try {
    url = new URL(rawApi);
  } catch {
    throw new Error(`PUBLISHER_API_ORIGIN не URL: «${rawApi}»`);
  }
  const host = url.hostname.toLowerCase();
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    throw new Error(`PUBLISHER_API_ORIGIN — только origin, без пути и параметров: «${rawApi}»`);
  }
  let api;
  if (url.protocol === 'https:' && !url.port && !LOCAL_HOSTS.has(host)) api = `https://${host}`;
  else if (LOCAL_HOSTS.has(host) && !onVercel && (url.protocol === 'http:' || url.protocol === 'https:')) {
    api = `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`;
  } else {
    throw new Error(
      `PUBLISHER_API_ORIGIN должен быть https://домен без порта (http://localhost — только для стенда вне Vercel): «${rawApi}»`,
    );
  }
  const key = (env.PUBLISHER_PUBLIC_KEY ?? '').trim();
  if (!PUBLIC_KEY_RE.test(key)) {
    throw new Error('PUBLISHER_PUBLIC_KEY — публичный ключ продукта `pp_` + 24 символа (кабинет → продукт → ключ).');
  }
  const indexing = (env.PUBLISHER_INDEXING ?? '').trim().toLowerCase();
  if (indexing && indexing !== 'on' && indexing !== 'off') {
    throw new Error(`PUBLISHER_INDEXING — on|off, получено «${env.PUBLISHER_INDEXING}»`);
  }
  // Превью-деплои Vercel — всегда noindex, даже если переменную скопировали.
  const preview = Boolean(env.VERCEL_ENV) && env.VERCEL_ENV !== 'production';
  return {
    PUBLISHER_API_ORIGIN: api,
    PUBLISHER_PUBLIC_KEY: key,
    PUBLISHER_INDEXING: indexing === 'on' && !preview ? 'on' : '',
  };
}

/**
 * Второй ключ индексации — `site-config.indexable` для хоста сборки.
 * Любой сбой — noindex (лишний noindex на сутки дешевле случайной
 * индексации тестовой сборки).
 *
 * @param {{ PUBLISHER_API_ORIGIN: string, PUBLISHER_PUBLIC_KEY: string, PUBLISHER_INDEXING: string }} pub
 * @param {string} siteUrl
 * @returns {Promise<boolean>}
 */
async function buildIndexable(pub, siteUrl) {
  if (pub.PUBLISHER_INDEXING !== 'on') return false;
  try {
    const host = new URL(siteUrl).host;
    const u = `${pub.PUBLISHER_API_ORIGIN}/public/publisher/v1/site-config?key=${encodeURIComponent(pub.PUBLISHER_PUBLIC_KEY)}&host=${encodeURIComponent(host)}`;
    const res = await fetch(u, { headers: { accept: 'application/json' } });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.success === true && body?.data?.indexable === true;
  } catch {
    return false;
  }
}

/**
 * Адрес сборки. `SITE_URL` задан — он. Превью Vercel без `SITE_URL` —
 * постоянный адрес ВЕТКИ (`VERCEL_BRANCH_URL`, не меняется от деплоя к
 * деплою — его можно внести в `test_hosts` тестового продукта); превью
 * всегда noindex. Вне Vercel и в production без `SITE_URL` — ошибка сборки.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
function resolveSiteUrl(env) {
  if (env.SITE_URL && env.SITE_URL.trim()) return env.SITE_URL;
  if (env.VERCEL_ENV === 'preview' && env.VERCEL_BRANCH_URL) return `https://${env.VERCEL_BRANCH_URL}`;
  return env.SITE_URL;
}

/**
 * Content-Security-Policy (аудит S3-2) — минимальная рабочая без nonce:
 * страницы статические (ISR), nonce потребовал бы динамического рендера.
 * Скрипты — только свои (`'unsafe-inline'` — встроенные скрипты гидратации
 * Next), запросы — свои и к API Publisher (форма, события), картинки — свои,
 * https и data:, без плагинов, фреймов и чужих форм.
 *
 * @param {string} apiOrigin
 */
function contentSecurityPolicy(apiOrigin) {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${apiOrigin}`,
    "img-src 'self' https: data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Проверка — только у `next build`: `eslint`/`next lint` грузят конфиг в
 * той же фазе, но адрес сайта им не нужен.
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
  const production = process.env.VERCEL_ENV === 'production';
  if (isNextBuild(phase)) {
    validateSiteUrl(resolveSiteUrl(process.env), { production });
    validatePublisherEnv(process.env);
  }
  /** @type {null | { site: string, pub: ReturnType<typeof validatePublisherEnv> }} */
  let baked = null;
  const site = resolveSiteUrl(process.env);
  if (phase === PHASE_PRODUCTION_BUILD && site && process.env.PUBLISHER_API_ORIGIN) {
    // Без `isNextBuild`: компиляцию Next ведёт воркер с другим argv, env тот же.
    baked = { site: validateSiteUrl(site, { production }), pub: validatePublisherEnv(process.env) };
    env.SITE_URL = baked.site;
    Object.assign(env, baked.pub);
  }
  return {
    env,
    reactStrictMode: true,
    poweredByHeader: false,
    async headers() {
      const indexable = baked ? await buildIndexable(baked.pub, baked.site) : false;
      /** @type {{ key: string, value: string }[]} */
      const common = [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
      ];
      if (!indexable) common.push({ key: 'X-Robots-Tag', value: 'noindex, nofollow' });
      // CSP — у сборки (next dev без неё: HMR требует eval).
      if (baked)
        common.push({ key: 'Content-Security-Policy', value: contentSecurityPolicy(baked.pub.PUBLISHER_API_ORIGIN) });
      return [{ source: '/:path*', headers: common }];
    },
  };
};

module.exports.validateSiteUrl = validateSiteUrl;
module.exports.validatePublisherEnv = validatePublisherEnv;
module.exports.isNextBuild = isNextBuild;
module.exports.buildIndexable = buildIndexable;
module.exports.resolveSiteUrl = resolveSiteUrl;
module.exports.contentSecurityPolicy = contentSecurityPolicy;
