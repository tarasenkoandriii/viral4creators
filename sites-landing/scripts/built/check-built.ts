/**
 * Проверка СОБРАННОГО сайта (`next build`) — сквозные критерии приёмки
 * §14 по HTML, который увидят поисковик и посетитель:
 *
 *  1. Каждая индексируемая страница × локаль: `<html lang>`, один `<h1>`,
 *     canonical = свой абсолютный адрес, hreflang на все локали +
 *     `x-default` → `/en/…` (абсолютные), `og:image` (файл есть),
 *     `twitter:card` и `twitter:title` своей страницы, `robots: index`.
 *  2. Реестр утверждений по HTML: hidden нет, soon — с меткой и без ссылок.
 *  3. Служебные страницы (результат формы, юр-черновики, 404) — `noindex`.
 *  4. Секреты формы не в клиентском бандле: ни имени переменной, ни её
 *     значения (CI собирает с токеном-приманкой в env) в `.next/static`.
 *  5. Таблицы — с `<caption>` и `th[scope]` (урок Ф-7).
 *  6. JSON-LD разбирается и не содержит цен/оферт и рейтингов (§8.3, С0).
 *  7. Л2–Л3: тега загрузчика виджета в HTML нет ни на одной странице (он
 *     вставляется после load/idle); живой блок и панель «покрутите виджет»
 *     на `/assistant` — ровно тогда, когда сборка знает ключ виджета
 *     (`ASSIST_WIDGET_PK`); ссылок в Telegram (`t.me`, `startapp`) в HTML
 *     нет; конфигуратор `/assistant/widget` собран, адреса продукта в
 *     клиентском коде — те, что заданы env (а не литералы).
 *  8. Л4–Л5: `/try` — форма песочницы и `sandbox` live, без deeplink до
 *     запуска; документация — только uk/en (ru — не страница сайта), код
 *     вставки и CSP в ней — для origin виджета из env; страница бота — с
 *     формой opt-out без JS; служебные страницы результата opt-out —
 *     `noindex`; поле адреса в hero ведёт в песочницу GET-формой.
 *
 * Запуск: `npm run check:built` после `next build` с тем же `SITE_URL`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CLAIMS } from '../../src/lib/claims';
import { getDictionary } from '../../src/lib/get-dictionary';
import { locales } from '../../src/lib/i18n';
import { PAGES } from '../../src/lib/pages';
import { cspLines, embedTag } from '../../src/lib/install';
import { attr, claimViolations, elementsWith, headTags, jsonLdViolations } from '../lib/html';
import { readAssistEnv } from '../../src/lib/assist-env';
import { WIDGET_NAMES } from '../../src/brand';

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, '.next', 'server', 'app');
assert.ok(fs.existsSync(APP), 'нет .next/server/app — сначала `next build`');
const origin = process.env.SITE_URL?.replace(/\/$/, '');
assert.ok(origin, 'задайте SITE_URL тот же, что при сборке');

const problems: string[] = [];
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8');
const linkHref = (html: string, rel: string, hreflang?: string) =>
  headTags(html, 'link').find((t) => attr(t, 'rel') === rel && (hreflang === undefined || attr(t, 'hrefLang') === hreflang)) ?? null;
const meta = (html: string, key: string) => {
  const t = headTags(html, 'meta').find((m) => attr(m, 'property') === key || attr(m, 'name') === key);
  return t ? attr(t, 'content') : null;
};
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

let pages = 0;
for (const page of PAGES) {
  for (const locale of page.locales ?? locales) {
    const rel = `${locale}${page.path}.html`;
    const where = `/${locale}${page.path}`;
    if (!fs.existsSync(path.join(APP, rel))) {
      problems.push(`${where}: нет собранного HTML (${rel})`);
      continue;
    }
    const html = read(rel);
    pages++;
    const url = `${origin}/${locale}${page.path}`;
    // Next 15 вписывает после DOCTYPE комментарий с id сборки (`<!--…-->`).
    if (!new RegExp(`^<!DOCTYPE html>(?:<!--[^>]*-->)?<html lang="${locale}"`).test(html)) problems.push(`${where}: <html lang> не ${locale}`);
    const h1 = (html.match(/<h1\b/g) ?? []).length;
    if (h1 !== 1) problems.push(`${where}: h1 — ${h1}`);
    const canonical = linkHref(html, 'canonical');
    if (!canonical || attr(canonical, 'href') !== url) problems.push(`${where}: canonical ${canonical}`);
    for (const l of locales) {
      const t = linkHref(html, 'alternate', l);
      const exists = (page.locales ?? locales).includes(l);
      if (exists && (!t || attr(t, 'href') !== `${origin}/${l}${page.path}`)) problems.push(`${where}: hreflang ${l} — ${t}`);
      if (!exists && t) problems.push(`${where}: hreflang ${l} на несуществующую версию`);
    }
    const xd = linkHref(html, 'alternate', 'x-default');
    if (!xd || attr(xd, 'href') !== `${origin}/en${page.path}`) problems.push(`${where}: x-default — ${xd}`);
    const ogImage = meta(html, 'og:image');
    const ogKey = page.og ?? page.key;
    const expectedImage = `${origin}/og/${ogKey}-${locale}.jpg`;
    if (ogImage !== expectedImage) problems.push(`${where}: og:image ${ogImage}`);
    if (!fs.existsSync(path.join(ROOT, 'public', 'og', `${ogKey}-${locale}.jpg`))) problems.push(`${where}: нет файла OG`);
    if (meta(html, 'og:url') !== url) problems.push(`${where}: og:url ${meta(html, 'og:url')}`);
    if (meta(html, 'twitter:card') !== 'summary_large_image') problems.push(`${where}: twitter:card`);
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    if (!title || decode(meta(html, 'twitter:title') ?? '') !== decode(title)) problems.push(`${where}: twitter:title не своей страницы`);
    if (meta(html, 'robots') !== 'index, follow') problems.push(`${where}: robots ${meta(html, 'robots')}`);
    problems.push(...claimViolations(html, CLAIMS, getDictionary(locale).common.soon, where));
    problems.push(...jsonLdViolations(html, where));
    if (!html.includes('application/ld+json')) problems.push(`${where}: нет JSON-LD (Organization/WebSite из layout)`);
    for (const table of elementsWith(html, /^<table\b/)) {
      if (!/<caption\b/.test(table.outer)) problems.push(`${where}: таблица без caption`);
      const th = table.outer.match(/<th\b[^>]*>/g) ?? [];
      if (th.some((t) => !/\sscope="(col|row)"/.test(t))) problems.push(`${where}: th без scope`);
    }
    // Код в <pre>/<code> — примеры (шаблонные строки JS `${t}`), не плейсхолдеры словаря.
    if (/\{[a-zA-Z]+\}/.test(html.replace(/<script[\s\S]*?<\/script>|<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>/g, ''))) problems.push(`${where}: неподставленный плейсхолдер`);
    if (/%%[A-Za-z]+%%/.test(html)) problems.push(`${where}: неподставленный плейсхолдер документации`);
  }
}

// 3. noindex на служебных
const noindexFiles = [
  ...locales.flatMap((l) => ['sent', 'unavailable'].map((c) => `${l}/assistant/pilot/status/${c}.html`)),
  ...locales.flatMap((l) => ['sent', 'invalid', 'limited', 'unavailable', 'error'].map((c) => `${l}/assistant/bot/status/${c}.html`)),
  'legal/privacy.html',
  'legal/terms.html',
  'legal/cookies.html',
  '_not-found.html',
];
for (const rel of noindexFiles) {
  if (!fs.existsSync(path.join(APP, rel))) {
    problems.push(`${rel}: не собран`);
    continue;
  }
  const r = meta(read(rel), 'robots') ?? '';
  if (!r.includes('noindex')) problems.push(`${rel}: нет noindex (${r})`);
}

// 4. Секреты не в клиентском бандле
const STATIC = path.join(ROOT, '.next', 'static');
const files: string[] = [];
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(STATIC);
const token = process.env.PILOT_TELEGRAM_BOT_TOKEN;
const chat = process.env.PILOT_TELEGRAM_CHAT_ID;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  if (text.includes('PILOT_TELEGRAM')) problems.push(`${path.relative(ROOT, f)}: имя секрета в клиентском бандле`);
  if (token && text.includes(token)) problems.push(`${path.relative(ROOT, f)}: ЗНАЧЕНИЕ токена бота в клиентском бандле`);
  if (chat && chat.length > 4 && text.includes(chat)) problems.push(`${path.relative(ROOT, f)}: chat id в клиентском бандле`);
  if (text.includes('api.telegram.org')) problems.push(`${path.relative(ROOT, f)}: адрес Bot API в клиентском бандле`);
}
// И в HTML страниц (RSC-данные) тоже.
for (const l of locales) {
  const html = read(`${l}/assistant/pilot.html`);
  if (token && html.includes(token)) problems.push(`/${l}/assistant/pilot: токен в HTML`);
}

// 7. Живой виджет и конфигуратор (Л2–Л3).
const assist = readAssistEnv(process.env);
const htmlFiles: string[] = [];
const walkHtml = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkHtml(p);
    else if (e.name.endsWith('.html')) htmlFiles.push(p);
  }
};
walkHtml(APP);
const loaderRe = new RegExp(`<script\\b[^>]*\\ssrc="[^"]*${WIDGET_NAMES.loaderPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`);
for (const f of htmlFiles) {
  const html = fs.readFileSync(f, 'utf8');
  const rel = path.relative(APP, f);
  if (loaderRe.test(html) || /<script\b[^>]*\sdata-site=/.test(html)) problems.push(`${rel}: тег загрузчика виджета в HTML (должен вставляться после load/idle)`);
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, '');
  if (/t\.me\/|startapp=/.test(visible)) problems.push(`${rel}: ссылка в Telegram в статическом HTML`);
}
for (const l of locales) {
  const html = read(`${l}/assistant.html`);
  const hasLive = html.includes('data-claim="live-widget"') && html.includes('data-testid="playground"');
  if (assist.widgetPk && !hasLive) problems.push(`/${l}/assistant: ключ виджета задан, а живого блока нет`);
  if (!assist.widgetPk && (hasLive || html.includes('data-testid="playground"'))) problems.push(`/${l}/assistant: живой блок без ключа виджета`);
  if (!assist.widgetPk && !html.includes('data-claim="demo-recording"')) problems.push(`/${l}/assistant: без ключа нет места под запись`);
  const w = read(`${l}/assistant/widget.html`);
  if (!w.includes('data-testid="cfg-stage"') || !w.includes('data-claim="configurator"')) problems.push(`/${l}/assistant/widget: нет конфигуратора`);
  if (assist.widgetPk && !w.includes(`${assist.widgetOrigin}${WIDGET_NAMES.loaderPath}`)) problems.push(`/${l}/assistant/widget: адрес загрузчика не из env`);
}
// 8. Л4–Л5.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
for (const l of locales) {
  const t = read(`${l}/assistant/try.html`);
  if (!t.includes('data-claim="sandbox" data-claim-status="live"') || !t.includes('id="sb-url"')) problems.push(`/${l}/assistant/try: нет формы песочницы`);
  if (!t.includes('data-claim="sandbox-screenshot" data-claim-status="soon"')) problems.push(`/${l}/assistant/try: скриншот должен быть «скоро» (воркера QA нет)`);
  const a = read(`${l}/assistant.html`);
  const tryForms = elementsWith(a, /^<form\b[^>]*class="try-form"/).filter((f) => attr(f.open, 'method') === 'get' && attr(f.open, 'action') === `/${l}/assistant/try`);
  if (tryForms.length !== 2 || tryForms.some((f) => !/<input\b[^>]*name="url"/.test(f.outer))) problems.push(`/${l}/assistant: поле адреса в hero и финале → /try`);
  const b = read(`${l}/assistant/bot.html`);
  if (!elementsWith(b, /^<form\b/).some((f) => attr(f.open, 'method') === 'post' && attr(f.open, 'action') === '/api/opt-out')) problems.push(`/${l}/assistant/bot: нет формы opt-out без JS`);
}
for (const l of ['uk', 'en']) {
  const d = read(`${l}/docs/assistant.html`);
  if (!d.includes(esc(embedTag(assist.widgetOrigin)))) problems.push(`/${l}/docs/assistant: код вставки не для origin виджета из env`);
  const c = read(`${l}/docs/assistant/csp.html`);
  if (!c.includes(esc(cspLines(assist.widgetOrigin)))) problems.push(`/${l}/docs/assistant/csp: директивы CSP не для origin из env`);
}
for (const rel of ['ru/docs/assistant.html', 'ru/docs/assistant/js-api.html']) {
  if (fs.existsSync(path.join(APP, rel)) && !(meta(read(rel), 'robots') ?? '').includes('noindex')) problems.push(`${rel}: документации на ru нет — страница должна быть 404/noindex`);
}
{
  const bundle = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  // Адреса продукта приходят пропсами из сборки, в клиентском JS их нет литералами.
  if (bundle.includes('assist-w.viral4creators.app') && assist.widgetOrigin !== 'https://assist-w.viral4creators.app') problems.push('клиентский бандл: адрес виджета литералом, мимо env');
}

assert.deepEqual(problems, [], `собранный сайт:\n${problems.join('\n')}`);
console.log(
  `ok   собранный сайт: ${pages} страниц × локалей — lang, один h1, canonical, hreflang+x-default, OG/Twitter, реестр утверждений, таблицы, JSON-LD без цен/оферт; ` +
    `noindex у ${noindexFiles.length} служебных; ${files.length} клиентских файлов без секретов${token ? ' (с приманкой токена)' : ' (БЕЗ приманки: PILOT_TELEGRAM_BOT_TOKEN не задан)'}; ` +
      `${htmlFiles.length} HTML без тега загрузчика и ссылок в Telegram; живой виджет ${assist.widgetPk ? 'есть (ключ задан)' : 'не подключён (нет ключа) — блок «запись»'}; конфигуратор собран; песочница, страница бота с opt-out, документация uk/en с кодом для origin из env`,
);
