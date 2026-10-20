/**
 * Story‑Tales: запрет индексации и маршрутизация поддомена
 * (ТЗ `doc/STORY-TALES-LANDING-SPEC.md` §12, ST-LPL-10; Р-STL-5/6/7).
 *
 *  1. `next.config.js` `headers()`: `X-Robots-Tag: noindex, nofollow,
 *     noarchive` и `Referrer-Policy: no-referrer` — на всём поддомене
 *     (`has: host`), на `/<locale>/stories` (и под ним) главного домена и
 *     на `/stories-media/*` любого хоста; значения — те же, что в
 *     `lib/stories-host.ts`; правила не задевают соседние страницы.
 *  2. `middleware.ts` (тем же приёмом, что в проде: настоящий
 *     `NextRequest`): поддомен `/<locale>` → rewrite в
 *     `/<locale>/stories`; `/<locale>/stories` на поддомене → 308 в
 *     `/<locale>`; на главном домене → 308 на поддомен; корень → локаль;
 *     КАЖДЫЙ такой ответ несёт оба заголовка. Поздравления и обучалка —
 *     без изменений и без noindex.
 *  3. Карты сайта: поддомен — пустая карта, главный домен — без
 *     `stories`; `robots.txt` поддомена НЕ закрывает обход (робот должен
 *     прочитать noindex) и не объявляет карту.
 *
 * Серверные ответы собранного сайта (`next build` + `next start`, curl с
 * `Host:`) проверены вручную — команды в doc/DEPLOYMENT.md, §4.1.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { middleware } from '../src/middleware';
import {
  STORIES_HOST,
  STORIES_REFERRER_POLICY,
  STORIES_ROBOTS,
  STORIES_SITE_URL,
  isStoriesHost,
  isStoriesPath,
} from '../src/lib/stories-host';
import { GREETING_HOST } from '../src/lib/greeting-host';
import { locales } from '../src/lib/i18n';

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

type HeaderRule = {
  source: string;
  has?: Array<{ type: string; value?: string }>;
  headers: Array<{ key: string; value: string }>;
};

/**
 * Сопоставление правила Next с путём — упрощённо, ровно для форм,
 * которые встречаются в конфиге: `/:path*`, `/:locale(a|b)/x`,
 * `/:locale(a|b)/x/:path*`, `/x/:path*`.
 */
function ruleMatches(rule: HeaderRule, host: string, pathname: string): boolean {
  for (const cond of rule.has ?? []) {
    if (cond.type !== 'host') return false;
    if (!new RegExp(`^${cond.value}$`).test(host.split(':')[0])) return false;
  }
  const re = rule.source
    .replace(/\./g, '\\.')
    .replace(/\/:path\*$/, '(?:/.*)?')
    .replace(/:\w+\(([^)]+)\)/g, '($1)');
  return new RegExp(`^${re}$`).test(pathname);
}

async function main() {
  // ── 1. next.config.js ────────────────────────────────────────────────
  const config = require('../next.config.js') as { headers: () => Promise<HeaderRule[]> };
  const rules = await config.headers();
  const headersFor = (host: string, pathname: string) => {
    const out = new Map<string, string>();
    for (const rule of rules) {
      if (ruleMatches(rule, host, pathname)) for (const h of rule.headers) out.set(h.key, h.value);
    }
    return out;
  };
  for (const rule of rules) {
    for (const h of rule.headers) {
      if (h.key === 'X-Robots-Tag') assert.equal(h.value, STORIES_ROBOTS, 'next.config.js ≠ STORIES_ROBOTS');
      if (h.key === 'Referrer-Policy') assert.equal(h.value, STORIES_REFERRER_POLICY, 'next.config.js ≠ STORIES_REFERRER_POLICY');
    }
  }
  assert.equal(STORIES_ROBOTS, 'noindex, nofollow, noarchive');
  assert.equal(STORIES_REFERRER_POLICY, 'no-referrer');
  const MAIN = 'welcome.viral4creators.app';
  const must = [
    [STORIES_HOST, '/ru'],
    [STORIES_HOST, '/uk/'],
    [`${STORIES_HOST}:443`, '/en'],
    [STORIES_HOST, '/de/stories'],
    [STORIES_HOST, '/es/stories/'],
    [STORIES_HOST, '/'],
    [STORIES_HOST, '/robots.txt'],
    [STORIES_HOST, '/sitemap.xml'],
    [STORIES_HOST, '/stories-media/demo.mp4'],
    [MAIN, '/stories-media/demo.mp4'],
    [MAIN, '/stories-media/sub/poster.jpg'],
    // Находка S3-6: OG-карточки на любом хосте.
    ...locales.flatMap((l) => [
      [MAIN, `/og/stories-${l}.jpg`],
      [GREETING_HOST, `/og/stories-${l}.jpg`],
      [STORIES_HOST, `/og/stories-${l}.jpg`],
    ]),
    ...locales.flatMap((l) => [
      [MAIN, `/${l}/stories`],
      [MAIN, `/${l}/stories/`],
    ]),
  ] as const;
  for (const [host, pathname] of must) {
    const h = headersFor(host, pathname);
    assert.equal(h.get('X-Robots-Tag'), STORIES_ROBOTS, `${host}${pathname}: нет X-Robots-Tag`);
    assert.equal(h.get('Referrer-Policy'), STORIES_REFERRER_POLICY, `${host}${pathname}: нет Referrer-Policy`);
  }
  const mustNot = [
    [MAIN, '/ru'],
    [MAIN, '/ru/greetings'],
    [MAIN, '/ru/blog/stories'],
    [MAIN, '/ru/storiesx'],
    [MAIN, '/fr/stories'],
    [MAIN, '/legal/offer'],
    [MAIN, '/og/main-ru.jpg'],
    [MAIN, '/og/greetings-ru.jpg'],
    [MAIN, '/og/stories-fr.jpg'],
    [MAIN, '/og/stories-ruxjpg'],
    [GREETING_HOST, '/ru'],
    [`x${STORIES_HOST}`, '/ru'],
    [STORIES_HOST.replace(/\./g, 'x'), '/ru'],
  ] as const;
  for (const [host, pathname] of mustNot) {
    assert.equal(headersFor(host, pathname).size, 0, `${host}${pathname}: noindex задел чужую страницу`);
  }

  // ── 2. middleware ────────────────────────────────────────────────────
  const call = (url: string, host = new URL(url).host) => middleware(new NextRequest(url, { headers: { host } }));
  const assertStories = (res: Response, label: string) => {
    assert.equal(res.headers.get('X-Robots-Tag'), STORIES_ROBOTS, `${label}: X-Robots-Tag`);
    assert.equal(res.headers.get('Referrer-Policy'), STORIES_REFERRER_POLICY, `${label}: Referrer-Policy`);
  };
  // Closed development: neither localized routes nor media redirect publicly.
  for (const l of locales) {
    for (const url of [`${STORIES_SITE_URL}/${l}`, `${STORIES_SITE_URL}/${l}/stories`, `https://${MAIN}/${l}/stories`]) {
      const response = call(url);
      assert.equal(response.status, 404, url);
      assert.equal(response.headers.get('location'), null);
      assert.equal(response.headers.get('x-middleware-rewrite'), null);
      assertStories(response, url);
    }
  }
  const root = call(`${STORIES_SITE_URL}/`);
  assert.equal(root.status, 404);
  assertStories(root, 'closed root');
  assert.equal(call(`https://${MAIN}/stories-media/demo.mp4`).status, 404);
  assertStories(call(`${STORIES_SITE_URL}/ru/blog`), 'closed subdomain');
  assertStories(call(`http://${STORIES_HOST}:3003/ru`, `${STORIES_HOST}:3003`), 'port');
  // Соседи — как были, без noindex.
  const greet = call(`https://${GREETING_HOST}/ru`);
  assert.equal(greet.headers.get('x-middleware-rewrite'), `https://${GREETING_HOST}/ru/greetings`);
  assert.equal(greet.headers.get('X-Robots-Tag'), null, 'noindex задел поздравления');
  const greetMain = call(`https://${MAIN}/ru/greetings`);
  assert.equal(greetMain.status, 308);
  assert.equal(greetMain.headers.get('X-Robots-Tag'), null);
  assert.equal(call(`https://${MAIN}/ru`).headers.get('X-Robots-Tag'), null, 'noindex задел главную');

  assert.ok(isStoriesHost(`${STORIES_HOST.toUpperCase()}:3003`));
  assert.equal(isStoriesHost(null), false);
  assert.ok(isStoriesPath('/ru/stories', locales));
  assert.ok(isStoriesPath('/ru/stories/', locales));
  assert.ok(isStoriesPath('/stories-media/a.mp4', locales));
  assert.equal(isStoriesPath('/ru/storiesx', locales), false);
  assert.equal(isStoriesPath('/fr/stories', locales), false);

  // Первая (локализационная) строка matcher по-прежнему исключает пути с
  // точкой; медиа, OG-карточки и весь хост Story‑Tales попадают в
  // middleware отдельными строками (404 — `stories-closed.test.ts`), а
  // правило next.config.js остаётся вторым замком заголовков (п. 1).
  assert.match(read('src/middleware.ts'), /\.\*\\\\\.\.\*/, 'matcher перестал исключать пути с точкой — перепроверить медиа');

  // ── 3. sitemap / robots ──────────────────────────────────────────────
  const sitemap = read('src/app/sitemap.ts');
  assert.match(sitemap, /if \(isStoriesHost\(host\)\) \{\s*return \[\];\s*\}/, 'sitemap.ts: у поддомена Story‑Tales должна быть пустая карта');
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code(sitemap), /['"`/]stories['"`/]|STORIES_SITE_URL|storiesPageUrl/, 'sitemap.ts: Story‑Tales попала в карту сайта');
  assert.doesNotMatch(code(read('src/app/sitemap-news.xml/route.ts')), /stories/i, 'sitemap-news: Story‑Tales');
  const robots = code(read('src/app/robots.ts'));
  const branch = /if \(isStoriesHost\(host\)\) \{([\s\S]*?)\n  \}/.exec(robots)?.[1] ?? '';
  assert.ok(branch, 'robots.ts: нет ветки поддомена Story‑Tales');
  assert.doesNotMatch(branch, /sitemap/, 'robots.ts: поддомен Story‑Tales объявляет карту сайта');
  assert.match(branch, /allow: '\/'/, 'robots.ts: обход поддомена закрыт — робот не прочитает noindex');
  const disallowed = /DISALLOWED_PATHS = \[([^\]]*)\]/.exec(robots)?.[1] ?? '';
  assert.doesNotMatch(disallowed, /'\/'|stories/, 'robots.txt запрещает обход Story‑Tales: robots не увидит noindex');

  console.log('stories-noindex: заголовки next.config/middleware, закрытый доступ 404 для поддомена, маршрутов и медиа, sitemap и robots проверены');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
