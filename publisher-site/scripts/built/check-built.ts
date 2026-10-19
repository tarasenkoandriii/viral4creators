/**
 * Проверка СОБРАННОГО сайта (проектный документ §13.6, AT-CORE-01): что
 * увидят поисковик и посетитель.
 *
 *  1. Каждая страница (`/`, `/materials`, `/contact`, `/privacy`, все
 *     опубликованные материалы из API): `<html lang="uk">`, один `<h1>`,
 *     title/description, canonical = `SITE_URL + путь` (абсолютный),
 *     robots по режиму, внутренние ссылки без `utm_`, JSON-LD без цен,
 *     оферт и рейтингов, сторонних скриптов нет.
 *  2. Материалы: `<meta name="pub-version">` = `versionHash` API, основной
 *     текст — в HTML (без JS), CTA после текста.
 *  3. Режим индексации: `--expect-noindex` — `X-Robots-Tag: noindex,
 *     nofollow` и `<meta robots noindex>` везде, robots.txt без `Disallow` и
 *     без `Sitemap`; `--expect-indexable` — заголовка нет, `index, follow`,
 *     в robots.txt — `Sitemap`.
 *  4. sitemap.xml: `/`, `/materials`, опубликованные материалы с
 *     `lastmod = updatedAt`; снятых нет. 404 — noindex; снятый (HTTP-режим)
 *     — 410.
 *  5. CSP: `default-src 'self'`, `connect-src` — ровно сайт, API и (только
 *     при заданном `PUBLISHER_LANDING_VISITS_URL`) origin счётчика посещений
 *     лендингов; без фреймов/плагинов. Без переменной адреса счётчика нет и
 *     в HTML (канал выключен, §13.5, Р-IA-FXA-1).
 *  6. Секреты: в `.next/static` нет имён `PUBLISHER_*` и значений ключа,
 *     секрета ревалидации и токена владения (CI собирает с приманками); в
 *     HTML нет секретов.
 *
 * Источник: по умолчанию — файлы `.next` (HTML пререндера,
 * `routes-manifest.json` для заголовков); `--base-url <url>` — живой сайт
 * по HTTP (повтор на публичном адресе после переноса, ТЗ §28).
 *
 * Запуск: `npm run check:built -- --expect-noindex` после `next build` с теми
 * же `SITE_URL`/`PUBLISHER_*` и при доступном API (стенд в CI).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { landingVisitsUrlOf } from '../../src/lib/landing-visits';

const ROOT = path.join(__dirname, '..', '..');
const NEXT = path.join(ROOT, '.next');
const APP = path.join(NEXT, 'server', 'app');
const args = process.argv.slice(2);
const argOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = argOf('--base-url')?.replace(/\/$/, '');
const expectIndexable = args.includes('--expect-indexable');
const expectNoindex = args.includes('--expect-noindex');
assert.ok(expectIndexable !== expectNoindex, 'укажите ровно один режим: --expect-noindex или --expect-indexable');
const origin = process.env.SITE_URL?.replace(/\/$/, '');
assert.ok(origin, 'задайте SITE_URL тот же, что при сборке');
const api = process.env.PUBLISHER_API_ORIGIN?.replace(/\/$/, '');
const key = process.env.PUBLISHER_PUBLIC_KEY;
assert.ok(api && key, 'задайте PUBLISHER_API_ORIGIN и PUBLISHER_PUBLIC_KEY (список материалов и hash версий)');
if (!BASE) assert.ok(fs.existsSync(APP), 'нет .next/server/app — сначала `next build`');
/** Счётчик посещений лендингов (§13.5): адрес или `''` — тот же env, что при сборке. */
const visitsUrl = landingVisitsUrlOf(process.env);
const connectSrc = [
  "'self'",
  api,
  ...(visitsUrl && new URL(visitsUrl).origin !== api ? [new URL(visitsUrl).origin] : []),
];

interface Page {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** Заголовки из routes-manifest (то, что `next start`/Vercel отдадут на путь). */
function manifestHeaders(): Record<string, string> {
  const m = JSON.parse(fs.readFileSync(path.join(NEXT, 'routes-manifest.json'), 'utf8')) as {
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  const out: Record<string, string> = {};
  for (const rule of m.headers)
    if (rule.source === '/:path*') for (const h of rule.headers) out[h.key.toLowerCase()] = h.value;
  return out;
}
const fileOf: Record<string, string> = {
  '/': 'index.html',
  '/robots.txt': 'robots.txt.body',
  '/sitemap.xml': 'sitemap.xml.body',
  '/__404': '_not-found.html',
};

async function get(route: string): Promise<Page> {
  if (BASE) {
    const res = await fetch(BASE + (route === '/__404' ? '/no-such-page-404' : route), { redirect: 'manual' });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, body: await res.text(), headers };
  }
  const rel = fileOf[route] ?? `${route.slice(1)}.html`;
  const file = path.join(APP, rel);
  if (!fs.existsSync(file)) return { status: 404, body: '', headers: {} };
  return { status: route === '/__404' ? 404 : 200, body: fs.readFileSync(file, 'utf8'), headers: manifestHeaders() };
}

const problems: string[] = [];
const tags = (html: string, name: string) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
const attr = (tag: string, a: string) => new RegExp(`\\s${a}="([^"]*)"`, 'i').exec(tag)?.[1] ?? null;
const metaOf = (html: string, name: string) => {
  const t = tags(html, 'meta').find((m) => attr(m, 'name') === name || attr(m, 'property') === name);
  return t ? attr(t, 'content') : null;
};
const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function apiGet<T>(p: string): Promise<{ status: number; data: T }> {
  const res = await fetch(
    `${api}/public/publisher/v1${p}${p.includes('?') ? '&' : '?'}key=${encodeURIComponent(key!)}`,
  );
  const body = (await res.json()) as { data: T };
  return { status: res.status, data: body.data };
}

const LD_FORBIDDEN =
  /^(offers?|price|priceCurrency|priceRange|lowPrice|highPrice|aggregateRating|ratingValue|review|reviewRating|bestRating)$/;
function ldViolations(html: string, where: string) {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      problems.push(`${where}: JSON-LD не разбирается`);
      continue;
    }
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (LD_FORBIDDEN.test(k)) problems.push(`${where}: JSON-LD содержит «${k}» (цены/рейтинги запрещены)`);
          walk(x);
        }
      }
    };
    walk(data);
  }
}

async function main() {
  const list = (
    await apiGet<Array<{ slug: string; withdrawn: boolean; updatedAt: string | null; publishedAt: string | null }>>(
      '/contents',
    )
  ).data;
  const published = list.filter((c) => !c.withdrawn);
  const withdrawn = list.filter((c) => c.withdrawn);
  assert.ok(published.length > 0, 'в API нет опубликованных материалов — проверять нечего (стенд не запущен?)');

  const pages = ['/', '/materials', '/contact', '/privacy', ...published.map((c) => `/materials/${c.slug}`)];
  for (const route of pages) {
    const p = await get(route);
    if (p.status !== 200 || !p.body) {
      problems.push(`${route}: не собран/не отдаётся (${p.status})`);
      continue;
    }
    const html = p.body;
    if (!/^<!DOCTYPE html>(?:<!--[^>]*-->)?<html lang="uk"/.test(html)) problems.push(`${route}: <html lang> не uk`);
    const h1 = (html.match(/<h1\b/g) ?? []).length;
    if (h1 !== 1) problems.push(`${route}: h1 — ${h1}`);
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
    if (!title?.trim()) problems.push(`${route}: нет title`);
    if (!metaOf(html, 'description')?.trim()) problems.push(`${route}: нет description`);
    const canonical = tags(html, 'link').find((t) => attr(t, 'rel') === 'canonical');
    const want = `${origin}${route}`;
    // Next нормализует canonical корня до origin без «/» — это тот же адрес.
    const href = canonical ? attr(canonical, 'href') : null;
    if (!canonical || (href !== want && !(route === '/' && href === origin)))
      problems.push(`${route}: canonical ${canonical ? attr(canonical, 'href') : 'нет'} ≠ ${want}`);
    const robots = metaOf(html, 'robots');
    if (expectIndexable && robots !== 'index, follow')
      problems.push(`${route}: robots «${robots}», ждали index, follow`);
    if (expectNoindex && !robots?.includes('noindex')) problems.push(`${route}: robots «${robots}», ждали noindex`);
    const xr = p.headers['x-robots-tag'] ?? null;
    if (expectNoindex && xr !== 'noindex, nofollow')
      problems.push(`${route}: X-Robots-Tag «${xr}», ждали noindex, nofollow`);
    if (expectIndexable && xr) problems.push(`${route}: X-Robots-Tag «${xr}» у индексируемой сборки`);
    // Аудит S3-2: CSP — свой origin + API Publisher (+ счётчик посещений, если
    // задан), без фреймов и плагинов. connect-src сверяется ЦЕЛИКОМ (IA-AB-03).
    const csp = p.headers['content-security-policy'] ?? '';
    const connect = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('connect-src '));
    if (connect !== `connect-src ${connectSrc.join(' ')}`)
      problems.push(`${route}: CSP connect-src «${connect}», ждали «connect-src ${connectSrc.join(' ')}»`);
    if (!visitsUrl && /landing-visits/.test(html))
      problems.push(`${route}: адрес счётчика посещений в HTML при невыставленном PUBLISHER_LANDING_VISITS_URL`);
    for (const d of ["object-src 'none'", "frame-ancestors 'none'", "default-src 'self'"]) {
      if (!csp.includes(d)) problems.push(`${route}: CSP без «${d}» (${csp || 'нет заголовка'})`);
    }
    for (const a of tags(html, 'a')) {
      const href = decode(attr(a, 'href') ?? '');
      const internal = href.startsWith('/') || href.startsWith(`${origin}/`) || href === origin;
      if (internal && /[?&]utm_/i.test(href)) problems.push(`${route}: внутренняя ссылка с UTM ${href}`);
      if (/^(javascript|data|vbscript):/i.test(href)) problems.push(`${route}: опасная ссылка ${href}`);
    }
    for (const s of tags(html, 'script')) {
      const src = attr(s, 'src');
      if (src && !src.startsWith('/_next/')) problems.push(`${route}: сторонний скрипт ${src}`);
    }
    ldViolations(html, route);
    if (route === '/' && !/data-cta="/.test(html)) problems.push('/: нет основного CTA');
    if (route.startsWith('/materials/')) {
      const slug = route.split('/').pop()!;
      const r = await apiGet<{ versionHash: string; body: string }>(`/contents/${slug}`);
      const hash = metaOf(html, 'pub-version');
      if (hash !== r.data.versionHash) problems.push(`${route}: pub-version «${hash}» ≠ versionHash API`);
      const firstLine =
        r.data.body
          .split('\n')
          .find((l) => l.trim() && !/^[#>|`-]/.test(l.trim()))
          ?.trim() ?? '';
      const sample = escHtml(firstLine.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '')).slice(0, 60);
      if (sample && !html.includes(sample))
        problems.push(`${route}: основного текста нет в серверном HTML («${sample}»)`);
      const bodyAt = html.indexOf('data-testid="material-body"');
      const ctaAt = html.indexOf('data-cta="material-next"');
      if (bodyAt < 0 || ctaAt < bodyAt) problems.push(`${route}: CTA не после основного текста`);
    }
  }

  // 404 — noindex.
  const nf = await get('/__404');
  if (!nf.body || !(metaOf(nf.body, 'robots') ?? '').includes('noindex')) problems.push('404: нет noindex');
  if (BASE && nf.status !== 404) problems.push(`404: статус ${nf.status}`);
  // Снятые: нет пререндера, нет в sitemap; по HTTP — 410.
  for (const w of withdrawn) {
    if (!BASE && fs.existsSync(path.join(APP, 'materials', `${w.slug}.html`)))
      problems.push(`/materials/${w.slug}: снятый материал пререндерен`);
    if (BASE) {
      const g = await get(`/materials/${w.slug}`);
      if (g.status !== 410) problems.push(`/materials/${w.slug}: снятый — статус ${g.status}, ждали 410`);
    }
  }

  // robots.txt и sitemap.xml.
  const robotsTxt = (await get('/robots.txt')).body;
  if (/disallow/i.test(robotsTxt)) problems.push('robots.txt: есть Disallow (робот не увидит noindex)');
  if (expectNoindex && /sitemap:/i.test(robotsTxt)) problems.push('robots.txt: Sitemap у неиндексируемой сборки');
  if (expectIndexable && !robotsTxt.includes(`Sitemap: ${origin}/sitemap.xml`))
    problems.push('robots.txt: нет Sitemap у индексируемой сборки');
  const sitemap = (await get('/sitemap.xml')).body;
  const locs = [...sitemap.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)].map((m) => ({
    loc: m[1],
    lastmod: m[2] ?? null,
  }));
  for (const u of [`${origin}/`, `${origin}/materials`])
    if (!locs.some((l) => l.loc === u)) problems.push(`sitemap: нет ${u}`);
  for (const c of published) {
    const l = locs.find((x) => x.loc === `${origin}/materials/${c.slug}`);
    if (!l) problems.push(`sitemap: нет материала ${c.slug}`);
    else if ((c.updatedAt ?? c.publishedAt) && l.lastmod !== (c.updatedAt ?? c.publishedAt))
      problems.push(`sitemap: ${c.slug} lastmod ${l.lastmod} ≠ updatedAt ${c.updatedAt}`);
  }
  for (const w of withdrawn)
    if (locs.some((l) => l.loc.endsWith(`/materials/${w.slug}`))) problems.push(`sitemap: снятый ${w.slug}`);
  for (const l of locs)
    if (!l.loc.startsWith(`${origin}/`)) problems.push(`sitemap: не абсолютный адрес сборки ${l.loc}`);

  // Секреты.
  const secrets = (['PUBLISHER_REVALIDATE_SECRET', 'PUBLISHER_OWNERSHIP_TOKEN'] as const)
    .map((k) => process.env[k])
    .filter((v): v is string => Boolean(v && v.length >= 8));
  let staticFiles = 0;
  if (!BASE) {
    const walk = (d: string): string[] =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(path.join(NEXT, 'static'))) {
      staticFiles++;
      const text = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      if (/PUBLISHER_[A-Z_]+/.test(text)) problems.push(`${rel}: имя переменной PUBLISHER_* в клиентском бандле`);
      if (text.includes(key!))
        problems.push(`${rel}: публичный ключ впечён в клиентский код (должен приходить пропсом)`);
      for (const s of secrets) if (text.includes(s)) problems.push(`${rel}: ЗНАЧЕНИЕ секрета в клиентском бандле`);
    }
    for (const f of walk(APP).filter((x) => /\.(html|rsc|body)$/.test(x))) {
      const text = fs.readFileSync(f, 'utf8');
      for (const s of secrets) if (text.includes(s)) problems.push(`${path.relative(ROOT, f)}: секрет в HTML/RSC`);
    }
  }

  assert.deepEqual(problems, [], `собранный сайт:\n${problems.join('\n')}`);
  console.log(
    `ok   собранный сайт (${BASE ?? '.next'}; ${expectIndexable ? 'индексируемая' : 'noindex'}): ${pages.length} страниц — lang uk, один h1, title/description, canonical = SITE_URL+путь, robots и X-Robots-Tag по режиму, внутренние ссылки без UTM, JSON-LD без цен/рейтингов; ` +
      `${published.length} материалов с pub-version = versionHash и текстом в HTML, CTA после текста; 404 noindex; снятых ${withdrawn.length} нет в sitemap${BASE ? ' и они отдают 410' : ''}; robots.txt без Disallow${expectIndexable ? ' с Sitemap' : ' и без Sitemap'}; ` +
      (BASE
        ? 'HTTP-режим'
        : `${staticFiles} клиентских файлов без PUBLISHER_*, ключа и секретов (приманок: ${secrets.length})`),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
