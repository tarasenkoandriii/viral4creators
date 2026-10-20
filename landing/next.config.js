/**
 * Story‑Tales: запрет индексации на уровне HTTP (ТЗ
 * `doc/STORY-TALES-LANDING-SPEC.md` §12, Р-STL-5) — для HTML поддомена,
 * для `/<locale>/stories` главного домена (он отвечает 308-м на поддомен,
 * в том числе с хвостовым слэшем), для будущих медиа `/stories-media/*` и
 * OG-карточек `/og/stories-<locale>.jpg` из `public/` на любом хосте (их
 * middleware не видит вовсе).
 *
 * Значения — копия `STORIES_ROBOTS` / `STORIES_REFERRER_POLICY` из
 * `src/lib/stories-host.ts` (TS отсюда не импортировать: конфиг —
 * CommonJS и читается до сборки). Равенство и сами правила держит
 * `scripts/stories-noindex.test.ts`; ответы собранного сайта проверены
 * curl'ом (см. doc/DEPLOYMENT.md, раздел про поддомен Story‑Tales).
 *
 * Хост — та же переменная `NEXT_PUBLIC_STORIES_HOST`, что у middleware;
 * условие `has: host` Next сравнивает с именем хоста без порта, целиком,
 * как регулярное выражение — поэтому точки экранированы.
 *
 * Режим лендинга — `STORY_TALES_LANDING` (`closed` | `pilot` | `public`,
 * Р-ST3-6; разбор — копия `parseStoriesLandingMode` из
 * `src/lib/stories/landing-mode.ts`, неизвестное значение = `closed`).
 * Он передаётся в `env`, и Next вклеивает его литералом и в страницу, и в
 * middleware: одна сборка — один режим, `next start` с другим окружением
 * его не меняет. В `public` `X-Robots-Tag` здесь не ставится (страница
 * индексируется), `Referrer-Policy` остаётся во всех режимах.
 */
const STORIES_HOST = process.env.NEXT_PUBLIC_STORIES_HOST ?? 'story-tales.viral4creators.app';
const STORIES_ROBOTS = 'noindex, nofollow, noarchive';
const STORIES_REFERRER_POLICY = 'no-referrer';
const LOCALES = 'ru|uk|en|de|es';
const STORIES_LANDING_MODES = ['closed', 'pilot', 'public'];
const storiesLandingRaw = String(process.env.STORY_TALES_LANDING ?? '').trim().toLowerCase();
const STORY_TALES_LANDING = STORIES_LANDING_MODES.includes(storiesLandingRaw) ? storiesLandingRaw : 'closed';

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const storiesHeaders = [
  ...(STORY_TALES_LANDING === 'public' ? [] : [{ key: 'X-Robots-Tag', value: STORIES_ROBOTS }]),
  { key: 'Referrer-Policy', value: STORIES_REFERRER_POLICY },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: { STORY_TALES_LANDING },
  async headers() {
    return [
      // Весь поддомен: страница, её 308 (`/<locale>/stories`, хвостовой
      // слэш), robots.txt/sitemap.xml поддомена и медиа на нём.
      {
        source: '/:path*',
        has: [{ type: 'host', value: escapeRegExp(STORIES_HOST) }],
        headers: storiesHeaders,
      },
      // Главный домен: `/<locale>/stories` и всё под ним (308 на поддомен).
      { source: `/:locale(${LOCALES})/stories`, headers: storiesHeaders },
      { source: `/:locale(${LOCALES})/stories/:path*`, headers: storiesHeaders },
      // Медиа — на любом хосте (Р-STL-6: только отсюда, не с Blob).
      { source: '/stories-media/:path*', headers: storiesHeaders },
      // OG-карточки Story‑Tales — тот же файл доступен и с главного
      // домена, и с соседних поддоменов (находка S3-6 аудита 16.10).
      { source: `/og/stories-:locale(${LOCALES}).jpg`, headers: storiesHeaders },
    ];
  },
};

module.exports = nextConfig;
