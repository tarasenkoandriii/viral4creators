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
