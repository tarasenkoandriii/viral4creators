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
import { attr, claimViolations, elementsWith, headTags, jsonLdViolations } from '../lib/html';

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
  for (const locale of locales) {
    const rel = `${locale}${page.path}.html`;
    const where = `/${locale}${page.path}`;
    if (!fs.existsSync(path.join(APP, rel))) {
      problems.push(`${where}: нет собранного HTML (${rel})`);
      continue;
    }
    const html = read(rel);
    pages++;
    const url = `${origin}/${locale}${page.path}`;
    if (!new RegExp(`^<!DOCTYPE html><html lang="${locale}"`).test(html)) problems.push(`${where}: <html lang> не ${locale}`);
    const h1 = (html.match(/<h1\b/g) ?? []).length;
    if (h1 !== 1) problems.push(`${where}: h1 — ${h1}`);
    const canonical = linkHref(html, 'canonical');
    if (!canonical || attr(canonical, 'href') !== url) problems.push(`${where}: canonical ${canonical}`);
    for (const l of locales) {
      const t = linkHref(html, 'alternate', l);
      if (!t || attr(t, 'href') !== `${origin}/${l}${page.path}`) problems.push(`${where}: hreflang ${l} — ${t}`);
    }
    const xd = linkHref(html, 'alternate', 'x-default');
    if (!xd || attr(xd, 'href') !== `${origin}/en${page.path}`) problems.push(`${where}: x-default — ${xd}`);
    const ogImage = meta(html, 'og:image');
    const expectedImage = `${origin}/og/${page.key}-${locale}.jpg`;
    if (ogImage !== expectedImage) problems.push(`${where}: og:image ${ogImage}`);
    if (!fs.existsSync(path.join(ROOT, 'public', 'og', `${page.key}-${locale}.jpg`))) problems.push(`${where}: нет файла OG`);
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
    if (/\{[a-zA-Z]+\}/.test(html.replace(/<script[\s\S]*?<\/script>/g, ''))) problems.push(`${where}: неподставленный плейсхолдер`);
  }
}

// 3. noindex на служебных
const noindexFiles = [
  ...locales.flatMap((l) => ['sent', 'unavailable'].map((c) => `${l}/assistant/pilot/status/${c}.html`)),
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

assert.deepEqual(problems, [], `собранный сайт:\n${problems.join('\n')}`);
console.log(
  `ok   собранный сайт: ${pages} страниц × локалей — lang, один h1, canonical, hreflang+x-default, OG/Twitter, реестр утверждений, таблицы, JSON-LD без цен/оферт; ` +
    `noindex у ${noindexFiles.length} служебных; ${files.length} клиентских файлов без секретов${token ? ' (с приманкой токена)' : ' (БЕЗ приманки: PILOT_TELEGRAM_BOT_TOKEN не задан)'}`,
);
