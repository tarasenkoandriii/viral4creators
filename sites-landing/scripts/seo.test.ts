/**
 * SEO-оболочка (§0, §8.1, §14 Л0):
 *  1. `SITE_URL`: прод-сборка без него падает (`next.config.js` в фазе
 *     `next build`), `next lint` — нет; правила двух копий проверки
 *     (конфиг и `lib/site-url.ts`) совпадают; рантайм без адреса в
 *     production — ошибка, а не относительные ссылки.
 *  2. `localeAlternates`: canonical + hreflang на все локали + `x-default`
 *     → `/en/…`, всё абсолютное.
 *  3. Метаданные каждой страницы × локали: title/description, canonical,
 *     hreflang, OG + Twitter одной парой, картинка существует в public/og.
 *  4. sitemap: каждая страница × локаль, абсолютные адреса, hreflang с
 *     `x-default`, `lastModified` — дата из реестра, не дата сборки;
 *     robots: sitemap абсолютным адресом.
 *  5. Выбор языка для корня: `Accept-Language` с q-весами.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.SITE_URL = 'https://assist.example.com';

import { localeAlternates } from '../src/lib/alternates';
import { localeFromAcceptLanguage, locales } from '../src/lib/i18n';
import { PAGES, pageMetadata, pageLocales, type DocsKey } from '../src/lib/pages';
import { loadDoc } from '../src/lib/docs';
import { siteUrl, validateSiteUrl } from '../src/lib/site-url';
import sitemap from '../src/app/sitemap';
import robots from '../src/app/robots';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextConfig = require('../next.config.js') as ((phase: string) => { env?: Record<string, string> }) & {
  validateSiteUrl: (raw: string | undefined, opts?: { production?: boolean }) => string;
  isNextBuild: (phase: string, argv?: readonly string[]) => boolean;
};
const BUILD = 'phase-production-build';
const ORIGIN = 'https://assist.example.com';

// ── 1. SITE_URL ──
const cases: Array<[string | undefined, boolean, string | null]> = [
  [undefined, false, null],
  ['', false, null],
  ['   ', false, null],
  ['assist.example.com', false, null],
  ['http://assist.example.com', false, null],
  ['https://localhost', false, null],
  ['https://127.0.0.1', false, null],
  ['https://app.localhost', false, null],
  ['https://assist.example.com/uk', false, null],
  ['https://assist.example.com?a=1', false, null],
  ['https://assist.example.com:8443', false, null],
  ['https://example.invalid', true, null],
  ['https://example.invalid', false, 'https://example.invalid'],
  ['https://Assist.Example.com/', false, 'https://assist.example.com'],
  ['https://assist.example.com', true, 'https://assist.example.com'],
];
for (const [raw, production, expected] of cases) {
  for (const [name, fn] of [
    ['next.config.js', nextConfig.validateSiteUrl],
    ['lib/site-url.ts', validateSiteUrl],
  ] as const) {
    if (expected === null) assert.throws(() => fn(raw, { production }), Error, `${name}: «${raw}» (prod=${production}) должен падать`);
    else assert.equal(fn(raw, { production }), expected, `${name}: «${raw}»`);
  }
}
const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
};
const savedArgv = process.argv;
try {
  process.argv = ['node', 'next', 'build'];
  withEnv({ SITE_URL: undefined, VERCEL_ENV: undefined }, () => {
    assert.throws(() => nextConfig(BUILD), /SITE_URL не задан/, '`next build` без SITE_URL обязан падать');
  });
  withEnv({ SITE_URL: 'https://example.invalid', VERCEL_ENV: 'production' }, () => {
    assert.throws(() => nextConfig(BUILD), /заглушка/, 'прод-деплой с доменом-заглушкой обязан падать');
  });
  withEnv({ SITE_URL: 'https://assist.example.com/', VERCEL_ENV: undefined }, () => {
    assert.equal(nextConfig(BUILD).env?.SITE_URL, ORIGIN, 'проверенный адрес впекается в сборку');
  });
  process.argv = ['node', 'next', 'lint'];
  withEnv({ SITE_URL: undefined }, () => {
    assert.doesNotThrow(() => nextConfig(BUILD), '`next lint` не должен требовать SITE_URL');
  });
} finally {
  process.argv = savedArgv;
}
assert.ok(nextConfig.isNextBuild(BUILD, ['node', 'next', 'build']));
assert.ok(!nextConfig.isNextBuild('phase-development-server', ['node', 'next', 'build']));
assert.throws(() => siteUrl({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), /SITE_URL/, 'рантайм production без адреса');
assert.equal(siteUrl({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), 'http://localhost:3010');
assert.equal(siteUrl(), ORIGIN);

// ── 2. alternates ──
const alt = localeAlternates('/assistant/pricing', 'ru');
assert.equal(alt.canonical, `${ORIGIN}/ru/assistant/pricing`);
assert.deepEqual(alt.languages, {
  uk: `${ORIGIN}/uk/assistant/pricing`,
  en: `${ORIGIN}/en/assistant/pricing`,
  ru: `${ORIGIN}/ru/assistant/pricing`,
  'x-default': `${ORIGIN}/en/assistant/pricing`,
});
assert.equal((localeAlternates('', 'uk').languages as Record<string, string>)['x-default'], `${ORIGIN}/en`);
assert.throws(() => localeAlternates('', 'uk', { env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv }), /SITE_URL/);

// ── 3. Метаданные страниц ──
const OG_DIR = path.join(__dirname, '..', 'public', 'og');
let metaCount = 0;
const metaOf = (key: (typeof PAGES)[number]['key'], locale: (typeof locales)[number]) => {
  // Документация берёт title/description из своего Markdown (uk/en).
  if (key.startsWith('docs')) {
    const doc = loadDoc(key as DocsKey, locale, { env: { widgetOrigin: 'https://w.example.com', apiOrigin: 'https://api.example.com' } });
    return pageMetadata(key, locale, { title: doc.title, description: doc.description });
  }
  return pageMetadata(key, locale);
};
for (const page of PAGES) {
  for (const locale of pageLocales(page.key)) {
    const m = metaOf(page.key, locale);
    const where = `${page.key}/${locale}`;
    const url = `${ORIGIN}/${locale}${page.path}`;
    assert.ok(typeof m.title === 'string' && m.title.length > 10 && !m.title.includes('{'), `${where}: title`);
    assert.ok(typeof m.description === 'string' && m.description.length > 50 && m.description.length <= 200, `${where}: description ${m.description?.length}`);
    assert.equal(m.alternates?.canonical, url, `${where}: canonical`);
    const langs = m.alternates?.languages as Record<string, string>;
    assert.deepEqual(Object.keys(langs).sort(), [...pageLocales(page.key), 'x-default'].sort(), `${where}: hreflang`);
    assert.equal(langs['x-default'], `${ORIGIN}/en${page.path}`, `${where}: x-default → en`);
    for (const href of Object.values(langs)) assert.ok(href.startsWith(`${ORIGIN}/`), `${where}: относительный hreflang ${href}`);
    const og = m.openGraph as { url: string; images: Array<{ url: string; width: number; height: number }>; locale: string };
    const tw = m.twitter as { card: string; images: Array<{ url: string }>; title: string };
    assert.equal(og.url, url);
    assert.equal(tw.card, 'summary_large_image');
    assert.equal(tw.title, m.title, `${where}: twitter:title не свой`);
    const ogKey = page.og ?? page.key;
    assert.equal(og.images[0].url, `${ORIGIN}/og/${ogKey}-${locale}.jpg`);
    assert.equal(tw.images[0].url, og.images[0].url);
    assert.ok(fs.existsSync(path.join(OG_DIR, `${ogKey}-${locale}.jpg`)), `${where}: нет OG-картинки — npm run og`);
    metaCount++;
  }
}
// Заголовки уникальны в пределах локали.
for (const locale of locales) {
  const titles = PAGES.filter((p) => pageLocales(p.key).includes(locale)).map((p) => metaOf(p.key, locale).title);
  assert.equal(new Set(titles).size, titles.length, `дубли title на ${locale}`);
}

// ── 4. sitemap и robots ──
const sm = sitemap();
assert.equal(sm.length, PAGES.reduce((n, p) => n + pageLocales(p.key).length, 0));
const urls = new Set(sm.map((e) => e.url));
assert.equal(urls.size, sm.length, 'дубли в sitemap');
for (const e of sm) {
  assert.ok(e.url.startsWith(`${ORIGIN}/`), e.url);
  const page = PAGES.find((p) => pageLocales(p.key).some((l) => e.url === `${ORIGIN}/${l}${p.path}`));
  assert.ok(page, `в sitemap адрес вне реестра: ${e.url}`);
  assert.equal(e.lastModified, page.updated, `${e.url}: lastModified не из реестра`);
  const langs = e.alternates?.languages as Record<string, string>;
  assert.equal(langs['x-default'], `${ORIGIN}/en${page.path}`);
  assert.equal(Object.keys(langs).length, pageLocales(page.key).length + 1);
}
assert.ok(![...urls].some((u) => u.includes('/ru/docs/')), 'документации на ru нет — и в sitemap её быть не должно');
for (const bad of ['/legal/', '/pilot/status/', '/bot/status/', '/api/']) assert.ok(![...urls].some((u) => u.includes(bad)), `в sitemap служебный ${bad}`);
for (const p of PAGES) assert.match(p.updated, /^\d{4}-\d{2}-\d{2}$/);
const rb = robots();
assert.equal(rb.sitemap, `${ORIGIN}/sitemap.xml`);

// ── 5. Accept-Language ──
assert.equal(localeFromAcceptLanguage('uk-UA,uk;q=0.9,en;q=0.8'), 'uk');
assert.equal(localeFromAcceptLanguage('de-DE,de;q=0.9,ru;q=0.5,en;q=0.7'), 'en');
assert.equal(localeFromAcceptLanguage('ru;q=0.3,uk;q=0.6'), 'uk');
assert.equal(localeFromAcceptLanguage('pl'), 'en');
assert.equal(localeFromAcceptLanguage(''), 'en');
assert.equal(localeFromAcceptLanguage('uk;q=0'), 'en');

console.log(`ok   SEO: SITE_URL (${cases.length} случаев × 2 копии, build падает, lint — нет), alternates, метаданные ${metaCount} страниц × локалей с OG-файлами, sitemap ${sm.length} адресов, robots, Accept-Language`);
