/**
 * Абсолютный адрес сайта — для canonical, sitemap, robots и JSON-LD
 * (проектный документ §13.3). Прод-сборку без него останавливает уже
 * `next.config.js` (те же правила; совпадение — `scripts/env.test.ts`);
 * здесь — второй замок и единственная точка, откуда страницы берут origin.
 *
 * В `next dev` (NODE_ENV !== 'production') без `SITE_URL` — адрес
 * dev-сервера.
 */
export const DEV_SITE_URL = 'http://localhost:3020';

export function validateSiteUrl(raw: string | undefined, opts: { production?: boolean } = {}): string {
  if (!raw || !raw.trim()) {
    throw new Error('SITE_URL не задан: абсолютный адрес сайта обязателен (canonical/sitemap).');
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
  // Литералы `process.env.X`: `next.config.js` впекает проверенный адрес,
  // подстановка Next работает только по буквальному `process.env.SITE_URL`.
  const raw = env ? env.SITE_URL : process.env.SITE_URL;
  const nodeEnv = env ? env.NODE_ENV : process.env.NODE_ENV;
  const vercelEnv = env ? env.VERCEL_ENV : process.env.VERCEL_ENV;
  if (!raw && nodeEnv !== 'production') return DEV_SITE_URL;
  return validateSiteUrl(raw, { production: vercelEnv === 'production' });
}

/** Абсолютный адрес страницы сайта: `SITE_URL + путь`. */
export function absoluteUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${siteUrl()}${p === '/' ? '/' : p}`;
}

/** Хост сборки (`?host=` для site-config). */
export function siteHost(): string {
  return new URL(siteUrl()).host;
}
