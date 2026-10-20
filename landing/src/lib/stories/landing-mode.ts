import { STORIES_SITE_URL, storiesPageUrl } from '../stories-host';

/**
 * Режим лендинга Story‑Tales — переменная сборки `STORY_TALES_LANDING`
 * (решение Р-ST3-6, проход 3 от 20.10.2026):
 *
 *  - `closed` (по умолчанию) — закрытая разработка: поддомен, страница
 *    `/<locale>/stories`, медиа и OG-карточки отвечают 404 с noindex
 *    (`middleware.ts`, аудит 2 ST2-U-04/05/06);
 *  - `pilot` — платный пилот по приглашению: страница и поддомен открыты,
 *    OG-карточки отдаются, но `noindex` (meta + `X-Robots-Tag`) остаётся и
 *    в картах сайта страницы нет;
 *  - `public` — как `pilot`, но без noindex и со страницами в карте сайта
 *    поддомена. Реализован и покрыт тестами, включается только после
 *    пилота и проверки юристом.
 *
 * Значение вклеивается при сборке: `next.config.js` передаёт его в `env`,
 * и Next подставляет `process.env.STORY_TALES_LANDING` литералом и в
 * страницу, и в middleware (Edge), — смена режима = новый деплой. Здесь
 * переменная читается при КАЖДОМ вызове, а не при загрузке модуля: тесты
 * (`tsx`, без подстановки) переключают режим между проверками.
 *
 * Неизвестное значение — `closed`: опечатка в настройках проекта не
 * должна открыть закрытую страницу. Тот же разбор продублирован в
 * `next.config.js` (CommonJS, TS оттуда не импортировать) — равенство
 * держит `scripts/stories-noindex.test.ts`.
 */

export const STORIES_LANDING_MODES = ['closed', 'pilot', 'public'] as const;
export type StoriesLandingMode = (typeof STORIES_LANDING_MODES)[number];

export function parseStoriesLandingMode(raw: unknown): StoriesLandingMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (STORIES_LANDING_MODES as readonly string[]).includes(value) ? (value as StoriesLandingMode) : 'closed';
}

export function storiesLandingMode(): StoriesLandingMode {
  return parseStoriesLandingMode(process.env.STORY_TALES_LANDING);
}

/** Страница, поддомен, медиа и OG-карточки отдаются (не 404). */
export function isStoriesOpen(mode: StoriesLandingMode): mode is Exclude<StoriesLandingMode, 'closed'> {
  return mode !== 'closed';
}

/** Индексация разрешена: без noindex, страницы в карте сайта поддомена. */
export function isStoriesIndexable(mode: StoriesLandingMode): boolean {
  return mode === 'public';
}

/**
 * Карта сайта ПОДДОМЕНА Story‑Tales: пустая до `public`, в `public` — по
 * странице на локаль (как у соседних поддоменов). На главном домене
 * Story‑Tales нет ни в одном режиме: там `/<locale>/stories` — 308 на
 * поддомен, а редирект в карте сайта — ошибка (`app/sitemap.ts`).
 */
export function storiesSitemapUrls(mode: StoriesLandingMode, locales: readonly string[]): string[] {
  return isStoriesIndexable(mode) ? locales.map(storiesPageUrl) : [];
}

/** Строка `Sitemap:` в `robots.txt` поддомена — только в `public`. */
export function storiesRobotsSitemaps(mode: StoriesLandingMode): string[] {
  return isStoriesIndexable(mode) ? [`${STORIES_SITE_URL}/sitemap.xml`] : [];
}
