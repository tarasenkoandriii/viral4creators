/**
 * Поддомен лендинга Story‑Tales — `story-tales.viral4creators.app`.
 *
 * Решение владельца от 16.10.2026 (вечер), заменившее Р-STL-1
 * `doc/STORY-TALES-LANDING-ADAPTED.md`: не `publisher-site/`, а тот же
 * проект `landing/`, ровно по образцу поздравлений (`greeting-host.ts`) и
 * обучалки (`tutorial-host.ts`). Поддомен подключён к тому же деплою
 * Vercel и отдаёт ту же сборку; отличается только тем, что показывает по
 * корню (`middleware.ts`, таблица `SUBDOMAIN_SITES`, slug `stories`).
 *
 * Решение владельца 21.10.2026: открытый лендинг индексируется и в
 * pilot, и в public; closed остаётся 404/noindex. Индексация страницы
 * не меняет серверный доступ STORY_TALES_ACCESS, приёмку или оплату.
 * Canonical/hreflang указывают на поддомен; sitemap содержит только его
 * реальные локализованные страницы, не редиректы с основного домена.
 *
 * Значения заголовков продублированы в `next.config.js` (CommonJS, TS
 * оттуда не импортировать) — равенство держит
 * `scripts/stories-noindex.test.ts`.
 */

export const STORIES_HOST =
  process.env.NEXT_PUBLIC_STORIES_HOST ?? 'story-tales.viral4creators.app';

/** Абсолютный адрес поддомена — для canonical и hreflang. */
export const STORIES_SITE_URL = `https://${STORIES_HOST}`;

/** Путь той же страницы на главном домене (`/<locale>/stories`). */
export const STORIES_SLUG = 'stories';

/**
 * Запрет индексации: и `<meta name="robots">`, и `X-Robots-Tag`.
 * `noarchive` — из продуктового ТЗ (`STORY-TALE-FAMILY-GIFT-SPEC.md` §11):
 * копия семейной страницы в кеше поисковика пережила бы её снятие.
 */
export const STORIES_ROBOTS = 'noindex, nofollow, noarchive';

/**
 * Семейная страница не сообщает чужим сайтам, откуда пришёл переход
 * (Р-STL-7): в будущем у неё будут ссылки с метками, а `Referer` — это
 * полный адрес.
 */
export const STORIES_REFERRER_POLICY = 'no-referrer';

/**
 * Будущие медиа лендинга (Р-STL-6): только статика `public/stories-media/`
 * под тем же noindex-правилом. В v1 папки нет — материалов не одобрено.
 */
export const STORIES_MEDIA_PREFIX = '/stories-media/';

/** Тот же разбор хоста, что у соседних поддоменов: порт отбрасываем. */
export function isStoriesHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return host.split(':')[0].toLowerCase() === STORIES_HOST.toLowerCase();
}

/** Канонический адрес страницы Story‑Tales для данной локали. */
export function storiesPageUrl(locale: string): string {
  return `${STORIES_SITE_URL}/${locale}`;
}

/**
 * Путь главного домена, который относится к Story‑Tales: страница
 * `/<locale>/stories` (с хвостовым слэшем и без) и медиа. Локаль
 * сверяется по списку снаружи — модуль не тянет `i18n.ts`, чтобы
 * оставаться пригодным и для middleware, и для тестов без лишнего.
 */
export function isStoriesPath(pathname: string, locales: readonly string[]): boolean {
  if (pathname.startsWith(STORIES_MEDIA_PREFIX)) return true;
  const m = /^\/([^/]+)\/stories(?:\/.*)?$/.exec(pathname);
  return Boolean(m && locales.includes(m[1]));
}
