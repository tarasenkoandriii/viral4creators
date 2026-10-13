#!/usr/bin/env node
/**
 * Бюджет JS первой загрузки (проектный документ §13.6): ≤ 118 КБ gzip на
 * страницах контента и ≤ 130 КБ на `/contact` (форма — клиентский остров).
 * Метод подсчёта — тот же, что `sites-landing/scripts/built/first-load-js.mjs`:
 * gzip-9 ровно того, что браузер грузит при первом заходе на маршрут —
 * `rootMainFiles` (рантайм Next + React) ∪ чанки корневого layout ∪ чанки
 * layout'ов-предков ∪ чанк страницы (`app-build-manifest.json`).
 *
 * Плюс бюджет трекера (§13.1: `Track.tsx` ≤ 2 КБ): собственный чанк
 * корневого layout (`app/layout-*.js` — трекер и его модули атрибуции и
 * отправки; общие чанки рантайма и `next/link` в него не входят).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NEXT = path.join(ROOT, '.next');
const BUDGET_KB = Number(process.env.FIRST_LOAD_BUDGET_KB ?? 118);
const ROUTE_BUDGET_KB = { '/contact/page': Number(process.env.CONTACT_PAGE_BUDGET_KB ?? 130) };
const TRACK_BUDGET_B = Number(process.env.TRACK_BUDGET_BYTES ?? 2048);
/** Маршруты, которые обязаны быть в сборке (иначе бюджет «прошёл» по пустому месту). */
const REQUIRED = ['/page', '/materials/page', '/materials/[slug]/page', '/contact/page', '/privacy/page'];

const app = JSON.parse(fs.readFileSync(path.join(NEXT, 'app-build-manifest.json'), 'utf8')).pages;
const build = JSON.parse(fs.readFileSync(path.join(NEXT, 'build-manifest.json'), 'utf8'));
const cache = new Map();
const gz = (rel) => {
  if (!cache.has(rel)) cache.set(rel, zlib.gzipSync(fs.readFileSync(path.join(NEXT, rel)), { level: 9 }).length);
  return cache.get(rel);
};
const kb = (bytes) => (bytes / 1024).toFixed(1);

function filesFor(pageKey) {
  const parts = pageKey
    .replace(/\/page$/, '')
    .split('/')
    .filter(Boolean);
  const layouts = ['/layout'];
  for (let i = 1; i <= parts.length; i++) layouts.push(`/${parts.slice(0, i).join('/')}/layout`);
  const set = new Set(build.rootMainFiles);
  for (const key of [...layouts, pageKey]) for (const f of app[key] ?? []) if (f.endsWith('.js')) set.add(f);
  return [...set];
}

const rows = [];
let failed = false;
for (const key of Object.keys(app)
  .filter((k) => k.endsWith('/page'))
  .sort()) {
  const total = filesFor(key).reduce((s, f) => s + gz(f), 0);
  const budget = ROUTE_BUDGET_KB[key] ?? BUDGET_KB;
  const over = total > budget * 1024;
  failed ||= over;
  rows.push(
    `${over ? 'FAIL' : 'ok  '} ${kb(total).padStart(6)} КБ  ${key}${budget !== BUDGET_KB ? ` (бюджет ${budget})` : ''}`,
  );
}
const missing = REQUIRED.filter((k) => !app[k]);
if (missing.length) {
  failed = true;
  rows.push(`FAIL нет маршрутов в сборке: ${missing.join(', ')}`);
}
const layoutOwn = (app['/layout'] ?? []).filter((f) => /static\/chunks\/app\/layout-[^/]+\.js$/.test(f));
const track = layoutOwn.reduce((s, f) => s + gz(f), 0);
if (!layoutOwn.length || track > TRACK_BUDGET_B) {
  failed = true;
  rows.push(`FAIL трекер (свой чанк layout): ${track} Б > ${TRACK_BUDGET_B} Б или чанк не найден`);
} else
  rows.push(`ok   ${String(track).padStart(6)} Б  трекер (свой чанк корневого layout, бюджет ${TRACK_BUDGET_B} Б)`);
const baseline = [
  ...new Set([...build.rootMainFiles, ...(app['/layout'] ?? []).filter((f) => f.endsWith('.js'))]),
].reduce((s, f) => s + gz(f), 0);
console.log(rows.join('\n'));
console.log(`пустая страница (рантайм Next + React + корневой layout): ${kb(baseline)} КБ gzip`);
if (failed) {
  console.error(
    `FAIL бюджет JS: контент ≤ ${BUDGET_KB} КБ, /contact ≤ ${ROUTE_BUDGET_KB['/contact/page']} КБ gzip, трекер ≤ ${TRACK_BUDGET_B} Б`,
  );
  process.exit(1);
}
console.log(
  `ok   JS первой загрузки: страницы контента ≤ ${BUDGET_KB} КБ gzip, /contact ≤ ${ROUTE_BUDGET_KB['/contact/page']} КБ, трекер ${track} Б ≤ ${TRACK_BUDGET_B} Б`,
);
