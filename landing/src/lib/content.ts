/**
 * Константы лендинга, НЕ зависящие от языка — ссылки и идентификаторы.
 *
 * Этап 55: весь текстовый контент (заголовки, описания фич, шагов,
 * тарифов, дорожной карты, FAQ) переехал в dictionaries/{ru,uk,en,de,es}.json
 * — по одному файлу на язык, читаются через lib/get-dictionary.ts. Здесь
 * остаётся только то, что от локали не зависит: URL демо-видео, ссылка на
 * репозиторий, на TMA и на маркетплейс. Как и раньше — никаких придуманных цифр, отзывов
 * или характеристик, которых нет в самом приложении (см. README.md).
 */

export const TMA_URL = process.env.NEXT_PUBLIC_TMA_URL ?? 'http://localhost:5173';

/**
 * Маркетплейс (`marketplace/`) — вторая пользовательская поверхность
 * продукта, развёрнутая отдельным приложением на своём поддомене.
 * Аудит лендинга 2026-09-22: она существует с миграции
 * `20261122090000_marketplace_stage0`, но с лендинга на неё не вело НИ
 * ОДНОЙ ссылки — отдельный домен жил без единой входящей.
 *
 * Адрес в переменной окружения по тому же принципу, что у TMA_URL выше:
 * поддомен может смениться, а дефолт годится для прода (dev-стенд
 * поднимает маркетплейс на 3004 — см. `marketplace/package.json`).
 */
export const MARKETPLACE_URL =
  process.env.NEXT_PUBLIC_MARKETPLACE_URL ?? 'https://market.viral4creators.app';

/** youtu.be/Ylw-e1AayGE — реальная демо-ссылка из README.md. */
export const DEMO_YOUTUBE_ID = 'Ylw-e1AayGE';
export const DEMO_YOUTUBE_URL = `https://youtu.be/${DEMO_YOUTUBE_ID}`;
export const DEMO_YOUTUBE_EMBED_URL = `https://www.youtube-nocookie.com/embed/${DEMO_YOUTUBE_ID}`;

export const GITHUB_REPO_URL = 'https://github.com/IuriiD/viral4creators';
export const SPEC_KIT_URL = 'https://github.com/github/spec-kit';

/**
 * Доп. запрос владельца продукта: реферальная ссылка Claude в футере
 * лендинга — тот же приём и тот же fallback-адрес, что уже в TMA
 * (`frontend/src/App.tsx`/`TermsGate.tsx`, `VITE_CLAUDE_REFERRAL_URL`):
 * ссылка в env, а не зашита в код, чтобы реферальный код можно было
 * сменить без правки исходников. Next.js-эквивалент той же переменной —
 * `NEXT_PUBLIC_` префикс обязателен для значений, читаемых в клиентском
 * бандле (тот же приём, что уже у `NEXT_PUBLIC_TMA_URL` выше).
 */
export const CLAUDE_REFERRAL_URL =
  process.env.NEXT_PUBLIC_CLAUDE_REFERRAL_URL ??
  'https://claude.ai/referral/P7cQCOjbvg?s=android';

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
