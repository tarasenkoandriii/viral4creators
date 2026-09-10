/**
 * Константы лендинга, НЕ зависящие от языка — ссылки и идентификаторы.
 *
 * Этап 55: весь текстовый контент (заголовки, описания фич, шагов,
 * тарифов, дорожной карты, FAQ) переехал в dictionaries/{ru,uk,en,de,es}.json
 * — по одному файлу на язык, читаются через lib/get-dictionary.ts. Здесь
 * остаётся только то, что от локали не зависит: URL демо-видео, ссылка на
 * репозиторий и на TMA. Как и раньше — никаких придуманных цифр, отзывов
 * или характеристик, которых нет в самом приложении (см. README.md).
 */

export const TMA_URL = process.env.NEXT_PUBLIC_TMA_URL ?? 'http://localhost:5173';

/** youtu.be/Ylw-e1AayGE — реальная демо-ссылка из README.md. */
export const DEMO_YOUTUBE_ID = 'Ylw-e1AayGE';
export const DEMO_YOUTUBE_URL = `https://youtu.be/${DEMO_YOUTUBE_ID}`;
export const DEMO_YOUTUBE_EMBED_URL = `https://www.youtube-nocookie.com/embed/${DEMO_YOUTUBE_ID}`;

export const GITHUB_REPO_URL = 'https://github.com/IuriiD/viral4creators';
export const SPEC_KIT_URL = 'https://github.com/github/spec-kit';

/**
 * Этап 58 (TODO §II.5): абсолютный адрес самого лендинга. До блога он
 * нигде не требовался — весь контент был на относительных путях внутри
 * одного домена. `sitemap.xml`/`sitemap-news.xml` обязаны содержать
 * абсолютные `<loc>` по спецификации, RSS — абсолютные `<link>`/`guid`,
 * JSON-LD (`NewsArticle`/`BreadcrumbList`) — абсолютные `url`/`item`.
 * Без реального значения в проде sitemap будет ссылаться сам на себя по
 * localhost — переменная обязательна к заданию при деплое, дефолт годится
 * только для dev-стенда (см. doc/DEPLOYMENT.md §4).
 */
export const SITE_URL = (process.env.SITE_URL ?? 'http://localhost:3003').replace(/\/+$/, '');

/** Имя бренда для RSS-каналов и sitemap-news — то же, что в шапке (Header.tsx). */
export const SITE_NAME = 'viral4creators';
