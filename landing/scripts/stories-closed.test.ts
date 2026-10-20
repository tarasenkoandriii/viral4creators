/**
 * Story‑Tales — закрытая разработка на лендинге (аудит 2, 20.10.2026,
 * ST2-U-04/05/06): проверяется СТАТУС, а не только заголовки, и с тем же
 * matcher, что применяет Next (`getMiddlewareMatchers` +
 * `getMiddlewareRouteMatcher` из самого `next`): путь, мимо которого
 * matcher пропускает middleware, отдаётся Next напрямую (статика — 200).
 *
 *  - ST2-U-04: `/og/stories-<locale>.jpg` — 404 + noindex на ЛЮБОМ хосте
 *    (раньше matcher исключал пути с точкой → 200 image/jpeg).
 *  - ST2-U-05: на хосте Story‑Tales 404 + noindex для ВСЕГО: `/legal/*`,
 *    `/qa/*`, robots.txt, sitemap.xml, статика, `_next` (раньше 200).
 *  - ST2-U-06: `/<locale>/stories/` — в middleware тоже 404 (если запрос
 *    до него дошёл; встроенный 308 хвостового слэша Next делает раньше
 *    middleware — см. отчёт, проверка на `next start`).
 *  - Чужие пути не задеты: `/og/main-ru.jpg`, `/legal/offer`, robots на
 *    главном домене middleware не видит, `/ru` — как прежде.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { config, middleware } from '../src/middleware';
import { STORIES_HOST, STORIES_REFERRER_POLICY, STORIES_ROBOTS } from '../src/lib/stories-host';
import { GREETING_HOST } from '../src/lib/greeting-host';
import { TUTORIAL_HOST } from '../src/lib/tutorial-host';
import { locales } from '../src/lib/i18n';

// Режим лендинга `closed` — по умолчанию; переменная из окружения запуска
// не должна подменить проверку (pilot/public — stories-landing-mode.test.ts).
delete process.env.STORY_TALES_LANDING;

type Matcher = { regexp: string; has?: unknown; missing?: unknown };
const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info') as {
  getMiddlewareMatchers: (m: unknown, cfg: { basePath?: string; i18n?: unknown }) => Matcher[];
};
const { getMiddlewareRouteMatcher } = require('next/dist/shared/lib/router/utils/middleware-route-matcher') as {
  getMiddlewareRouteMatcher: (
    m: Matcher[],
  ) => (pathname: string, req: { headers: Record<string, string> }, query: Record<string, string>) => boolean;
};

const ROOT = path.join(__dirname, '..');
const NEXT_CONFIG = { basePath: '', i18n: undefined };
const reaches = getMiddlewareRouteMatcher(getMiddlewareMatchers(config.matcher, NEXT_CONFIG));
const reachesByLocaleRule = getMiddlewareRouteMatcher(getMiddlewareMatchers([config.matcher[0]], NEXT_CONFIG));

function serve(host: string, pathname: string) {
  if (!reaches(pathname, { headers: { host } }, {})) return null;
  return middleware(new NextRequest(`https://${host.split(':')[0]}${pathname}`, { headers: { host } }));
}
function assertClosed(host: string, pathname: string) {
  const res = serve(host, pathname);
  assert.ok(res, `${host}${pathname}: middleware не вызывается — путь отдаётся мимо замка`);
  assert.equal(res.status, 404, `${host}${pathname}: статус`);
  assert.equal(res.headers.get('location'), null, `${host}${pathname}: редирект`);
  assert.equal(res.headers.get('x-middleware-rewrite'), null, `${host}${pathname}: rewrite`);
  assert.equal(res.headers.get('X-Robots-Tag'), STORIES_ROBOTS, `${host}${pathname}: X-Robots-Tag`);
  assert.equal(res.headers.get('Referrer-Policy'), STORIES_REFERRER_POLICY, `${host}${pathname}: Referrer-Policy`);
}

const MAIN = 'welcome.viral4creators.app';
let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

it('ST2-U-04: OG-карточки Story‑Tales — 404 с noindex на любом хосте', () => {
  for (const l of locales) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'og', `stories-${l}.jpg`)), `нет файла stories-${l}.jpg — тест устарел`);
    for (const host of [MAIN, GREETING_HOST, TUTORIAL_HOST, STORIES_HOST, `${MAIN}:3003`, 'localhost:3003']) {
      assertClosed(host, `/og/stories-${l}.jpg`);
    }
  }
  assertClosed(MAIN, '/og/stories-new-card.png');
});

it('ST2-U-05: хост Story‑Tales закрыт целиком, включая исключённые matcher пути', () => {
  const paths = [
    '/',
    '/ru',
    '/ru/stories',
    '/ru/stories/',
    '/ru/blog',
    '/legal/offer',
    '/legal/terms-of-use',
    '/qa/site-sandbox',
    '/robots.txt',
    '/sitemap.xml',
    '/sitemap-news.xml',
    '/feed/news',
    '/video/abc',
    '/r/CODE1',
    '/icon',
    '/favicon.ico',
    '/og/main-ru.jpg',
    '/og/greetings-ru.jpg',
    '/illustrations/hero.jpg',
    '/stories-media/demo.mp4',
    '/_next/static/chunks/main.js',
    '/_next/image',
  ];
  for (const p of paths) {
    assertClosed(STORIES_HOST, p);
    assertClosed(`${STORIES_HOST}:443`, p);
    assertClosed(STORIES_HOST.toUpperCase(), p);
  }
});

it('ST2-U-06: /<locale>/stories/ со слэшем — 404 прямо в middleware', () => {
  for (const l of locales) {
    assertClosed(MAIN, `/${l}/stories/`);
    assertClosed(MAIN, `/${l}/stories`);
    assertClosed(MAIN, `/${l}/stories/anything`);
  }
});

it('чужие пути не задеты: статика и /legal главного домена идут мимо middleware', () => {
  for (const p of ['/og/main-ru.jpg', '/og/greetings-ru.jpg', '/legal/offer', '/robots.txt', '/sitemap.xml', '/_next/static/chunks/main.js', '/qa/site-sandbox']) {
    assert.equal(serve(MAIN, p), null, `${MAIN}${p}: middleware задел чужой путь`);
    assert.equal(serve(GREETING_HOST, p), null, `${GREETING_HOST}${p}`);
  }
  const ru = serve(MAIN, '/ru');
  assert.ok(ru);
  assert.equal(ru.status, 200);
  assert.equal(ru.headers.get('X-Robots-Tag'), null);
  const greet = serve(GREETING_HOST, '/ru');
  assert.equal(greet?.headers.get('x-middleware-rewrite'), `https://${GREETING_HOST}/ru/greetings`);
  const root = serve(MAIN, '/');
  assert.equal(root?.status, 307);
});

it('хост под шаблоном story-tales.*, но не Story‑Tales: пути вне локализации не трогаются', () => {
  const other = 'story-tales.example.com';
  for (const p of ['/og/main-ru.jpg', '/legal/offer', '/robots.txt', '/_next/static/chunks/main.js', '/blog', '/ru', '/']) {
    const res = serve(other, p);
    assert.ok(res, `${other}${p}: шаблон хоста должен пропустить в middleware`);
    assert.notEqual(res.status, 404, `${other}${p}`);
    if (reachesByLocaleRule(p, { headers: { host: other } }, {})) continue;
    // Не попал под локализационную строку matcher — ровно «как без middleware».
    assert.equal(res.headers.get('x-middleware-next'), '1', `${other}${p}: middleware изменил ответ`);
    assert.equal(res.headers.get('location'), null, `${other}${p}: лишний редирект`);
  }
  // Внутри локализации — прежнее поведение (редирект на локаль).
  assert.equal(serve(other, '/blog')?.headers.get('location'), `https://${other}/en/blog`);
});

console.log(`stories-closed: ${passed} проверок пройдено`);
