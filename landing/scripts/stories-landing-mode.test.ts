/**
 * Story‑Tales: режим лендинга `STORY_TALES_LANDING` (Р-ST3-6, 20.10.2026).
 *
 *  1. Разбор: по умолчанию и на неизвестном значении — `closed`; тот же
 *     разбор в `next.config.js` (CommonJS-копия) — и значение, которое он
 *     передаёт в `env` (вклеивается в страницу и middleware при сборке).
 *  2. `next.config.js` `headers()`: `X-Robots-Tag` — только в `closed`,
 *     в `pilot`/`public` нет; `Referrer-Policy: no-referrer` — всегда.
 *  3. middleware в `pilot`: поддомен открыт (rewrite корня локали, 308 со
 *     `/<locale>/stories`, корень → локаль), главный домен уводит на
 *     поддомен, OG-карточки, медиа, статика, robots/sitemap поддомена
 *     проходят дальше — и КАЖДЫЙ ответ с no-referrer; соседи не
 *     задеты. Matcher — тот же, что применяет Next.
 *  4. middleware в `public`: то же, без `X-Robots-Tag`.
 *  5. Карта сайта и `robots.txt` поддомена: пусто в `closed`, в открытых режимах
 *     — страница на локаль и строка `Sitemap:`.
 *
 * `closed` — `stories-closed.test.ts` и `stories-noindex.test.ts`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { config, middleware } from '../src/middleware';
import { STORIES_HOST, STORIES_REFERRER_POLICY, STORIES_ROBOTS, STORIES_SITE_URL } from '../src/lib/stories-host';
import { GREETING_HOST } from '../src/lib/greeting-host';
import { TUTORIAL_HOST } from '../src/lib/tutorial-host';
import { locales } from '../src/lib/i18n';
import {
  isStoriesIndexable,
  isStoriesOpen,
  parseStoriesLandingMode,
  storiesLandingMode,
  storiesRobotsSitemaps,
  storiesSitemapUrls,
  type StoriesLandingMode,
} from '../src/lib/stories/landing-mode';

type Matcher = { regexp: string; has?: unknown; missing?: unknown };
const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info') as {
  getMiddlewareMatchers: (m: unknown, cfg: { basePath?: string; i18n?: unknown }) => Matcher[];
};
const { getMiddlewareRouteMatcher } = require('next/dist/shared/lib/router/utils/middleware-route-matcher') as {
  getMiddlewareRouteMatcher: (
    m: Matcher[],
  ) => (pathname: string, req: { headers: Record<string, string> }, query: Record<string, string>) => boolean;
};
const reaches = getMiddlewareRouteMatcher(getMiddlewareMatchers(config.matcher, { basePath: '', i18n: undefined }));

const MAIN = 'welcome.viral4creators.app';
const ORIGINAL = process.env.STORY_TALES_LANDING;
let passed = 0;
async function it(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log('  ✓', name);
}
function withMode<T>(raw: string | undefined, fn: () => T): T {
  if (raw === undefined) delete process.env.STORY_TALES_LANDING;
  else process.env.STORY_TALES_LANDING = raw;
  try {
    return fn();
  } finally {
    if (ORIGINAL === undefined) delete process.env.STORY_TALES_LANDING;
    else process.env.STORY_TALES_LANDING = ORIGINAL;
  }
}
function serve(host: string, pathname: string) {
  if (!reaches(pathname, { headers: { host } }, {})) return null;
  return middleware(new NextRequest(`https://${host.split(':')[0]}${pathname}`, { headers: { host } }));
}

type HeaderRule = { source: string; has?: Array<{ type: string; value?: string }>; headers: Array<{ key: string; value: string }> };
function loadNextConfig(raw: string | undefined) {
  return withMode(raw, () => {
    const file = require.resolve('../next.config.js', { paths: [path.join(__dirname)] });
    delete require.cache[file];
    return require(file) as { env: Record<string, string>; headers: () => Promise<HeaderRule[]> };
  });
}

async function main() {
  await it('разбор: по умолчанию и на неизвестном значении — closed', () => {
    assert.equal(parseStoriesLandingMode(undefined), 'closed');
    assert.equal(parseStoriesLandingMode(''), 'closed');
    assert.equal(parseStoriesLandingMode('open'), 'closed');
    assert.equal(parseStoriesLandingMode('owner'), 'closed');
    assert.equal(parseStoriesLandingMode(' Pilot '), 'pilot');
    assert.equal(parseStoriesLandingMode('PUBLIC'), 'public');
    assert.equal(withMode(undefined, storiesLandingMode), 'closed');
    assert.equal(withMode('pilot', storiesLandingMode), 'pilot');
    assert.deepEqual(
      (['closed', 'pilot', 'public'] as const).map((m) => [isStoriesOpen(m), isStoriesIndexable(m)]),
      [
        [false, false],
        [true, true],
        [true, true],
      ],
    );
  });

  await it('next.config.js: тот же разбор, env для сборки и заголовки по режиму', async () => {
    for (const raw of [undefined, '', 'pilot', ' Public ', 'bogus', 'closed']) {
      const cfg = loadNextConfig(raw);
      const mode = parseStoriesLandingMode(raw);
      assert.equal(cfg.env.STORY_TALES_LANDING, mode, `next.config env при «${raw}»`);
      const rules = await cfg.headers();
      assert.ok(rules.length >= 5, 'правила заголовков Story‑Tales пропали');
      for (const rule of rules) {
        const robots = rule.headers.find((h) => h.key === 'X-Robots-Tag');
        const referrer = rule.headers.find((h) => h.key === 'Referrer-Policy');
        assert.equal(referrer?.value, STORIES_REFERRER_POLICY, `${rule.source} (${mode}): Referrer-Policy`);
        if (mode !== 'closed') assert.equal(robots, undefined, `${rule.source}: noindex в public`);
        else assert.equal(robots?.value, STORIES_ROBOTS, `${rule.source} (${mode}): X-Robots-Tag`);
      }
    }
    loadNextConfig(ORIGINAL);
  });

  for (const mode of ['pilot', 'public'] as const satisfies readonly StoriesLandingMode[]) {
    const robots = null;
    const assertStories = (res: Response | null, label: string) => {
      assert.ok(res, `${label}: мимо middleware`);
      assert.notEqual(res.status, 404, `${label}: 404 в ${mode}`);
      assert.equal(res.headers.get('X-Robots-Tag'), robots, `${label}: X-Robots-Tag в ${mode}`);
      assert.equal(res.headers.get('Referrer-Policy'), STORIES_REFERRER_POLICY, `${label}: Referrer-Policy`);
      return res;
    };
    await it(`${mode}: поддомен и /<locale>/stories открыты`, () =>
      withMode(mode, () => {
        for (const l of locales) {
          const page = assertStories(serve(STORIES_HOST, `/${l}`), `${STORIES_HOST}/${l}`);
          assert.equal(page.headers.get('x-middleware-rewrite'), `${STORIES_SITE_URL}/${l}/stories`);
          const explicit = assertStories(serve(STORIES_HOST, `/${l}/stories`), `${STORIES_HOST}/${l}/stories`);
          assert.equal(explicit.status, 308);
          assert.equal(explicit.headers.get('location'), `${STORIES_SITE_URL}/${l}`);
          const fromMain = assertStories(serve(MAIN, `/${l}/stories`), `${MAIN}/${l}/stories`);
          assert.equal(fromMain.status, 308);
          assert.equal(fromMain.headers.get('location'), `${STORIES_SITE_URL}/${l}`);
          const port = assertStories(serve(`${STORIES_HOST}:3003`, `/${l}`), `${STORIES_HOST}:3003/${l}`);
          assert.equal(port.headers.get('x-middleware-rewrite'), `https://${STORIES_HOST}/${l}/stories`);
        }
        const root = assertStories(serve(STORIES_HOST, '/'), `${STORIES_HOST}/`);
        assert.equal(root.status, 307);
        // Язык корня — общий выбор лендинга (`visitorLocale`, 3abd2188):
        // без cookie, Accept-Language и страны — английский.
        assert.equal(root.headers.get('location'), `${STORIES_SITE_URL}/en`);
      }));
    await it(`${mode}: OG-карточки, медиа, статика и robots/sitemap поддомена проходят дальше`, () =>
      withMode(mode, () => {
        for (const l of locales) {
          for (const host of [MAIN, GREETING_HOST, TUTORIAL_HOST, STORIES_HOST]) {
            const res = assertStories(serve(host, `/og/stories-${l}.jpg`), `${host}/og/stories-${l}.jpg`);
            assert.equal(res.headers.get('x-middleware-next'), '1', `${host}/og/stories-${l}.jpg: не «дальше»`);
            assert.equal(res.headers.get('location'), null);
          }
        }
        for (const p of ['/_next/static/chunks/main.js', '/robots.txt', '/sitemap.xml', '/stories-media/demo.mp4', '/legal/offer', '/favicon.ico']) {
          const res = assertStories(serve(STORIES_HOST, p), `${STORIES_HOST}${p}`);
          assert.equal(res.headers.get('x-middleware-next'), '1', `${STORIES_HOST}${p}: не «дальше»`);
        }
        const media = assertStories(serve(MAIN, '/stories-media/demo.mp4'), `${MAIN}/stories-media/demo.mp4`);
        assert.equal(media.headers.get('x-middleware-next'), '1');
      }));
    await it(`${mode}: соседи и главный домен не задеты`, () =>
      withMode(mode, () => {
        const greet = serve(GREETING_HOST, '/ru');
        assert.equal(greet?.headers.get('x-middleware-rewrite'), `https://${GREETING_HOST}/ru/greetings`);
        assert.equal(greet?.headers.get('X-Robots-Tag'), null);
        assert.equal(greet?.headers.get('Referrer-Policy'), null);
        const ru = serve(MAIN, '/ru');
        assert.equal(ru?.status, 200);
        assert.equal(ru?.headers.get('X-Robots-Tag'), null);
        assert.equal(ru?.headers.get('Referrer-Policy'), null);
        for (const p of ['/og/main-ru.jpg', '/legal/offer', '/robots.txt', '/sitemap.xml']) {
          assert.equal(serve(MAIN, p), null, `${MAIN}${p}: middleware задел чужой путь`);
        }
        assert.equal(serve(MAIN, '/ru/storiesx')?.headers.get('X-Robots-Tag'), null);
      }));
  }

  await it('карта сайта и robots.txt: closed пуст, pilot/public содержат локали', () => {
    assert.deepEqual(storiesSitemapUrls('closed', locales), []);
    assert.deepEqual(storiesSitemapUrls('pilot', locales), locales.map((l) => `${STORIES_SITE_URL}/${l}`));
    assert.deepEqual(
      storiesSitemapUrls('public', locales),
      locales.map((l) => `${STORIES_SITE_URL}/${l}`),
    );
    assert.deepEqual(storiesRobotsSitemaps('closed'), []);
    assert.deepEqual(storiesRobotsSitemaps('pilot'), [`${STORIES_SITE_URL}/sitemap.xml`]);
    assert.deepEqual(storiesRobotsSitemaps('public'), [`${STORIES_SITE_URL}/sitemap.xml`]);
  });

  console.log(`stories-landing-mode: ${passed} проверок пройдено`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
