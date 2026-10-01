/**
 * Абсолютный адрес лендинга — для canonical, hreflang, sitemap, OG и
 * JSON-LD (ТЗ §0, §8.1).
 *
 * Порт `landing/src/lib/site-origin.ts` с обратным решением: там при
 * незаданном/локальном адресе ссылки молча становились относительными,
 * здесь — ошибка. Прод-сборку останавливает уже `next.config.js` (тот же
 * набор правил, сверяет `scripts/seo.test.ts`); эта функция —
 * второй замок на случай, если кто-то соберёт в обход конфига, и
 * единственная точка, откуда страницы берут origin.
 *
 * В `next dev` (NODE_ENV !== 'production') без `SITE_URL` — локальный
 * адрес dev-сервера: абсолютные ссылки на localhost в разработке никого
 * не уводят.
 */
export const DEV_SITE_URL = 'http://localhost:3010';

export function validateSiteUrl(raw: string | undefined, opts: { production?: boolean } = {}): string {
  if (!raw || !raw.trim()) {
    throw new Error('SITE_URL не задан: абсолютный адрес сайта обязателен (canonical/hreflang/sitemap).');
  }
  let url: URL;
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
    throw new Error(`SITE_URL — только origin (https://домен): «${raw}»`);
  }
  if (opts.production && host.endsWith('.invalid')) {
    throw new Error(`SITE_URL — заглушка «${raw}» в продакшен-деплое Vercel.`);
  }
  return `https://${host}`;
}

export function siteUrl(env?: NodeJS.ProcessEnv): string {
  // Литералы `process.env.X` — не через переменную: `next.config.js`
  // впекает проверенный `SITE_URL` в сборку (`env`), и подстановка Next
  // работает только по буквальному `process.env.SITE_URL`. Поэтому
  // статическим страницам на рантайме переменная уже не нужна.
  const raw = env ? env.SITE_URL : process.env.SITE_URL;
  const nodeEnv = env ? env.NODE_ENV : process.env.NODE_ENV;
  const vercelEnv = env ? env.VERCEL_ENV : process.env.VERCEL_ENV;
  if (!raw && nodeEnv !== 'production') return DEV_SITE_URL;
  return validateSiteUrl(raw, { production: vercelEnv === 'production' });
}
