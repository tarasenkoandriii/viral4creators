#!/usr/bin/env node
/**
 * Бюджет JS первой загрузки (ТЗ §9): ≤ 110 КБ gzip на статических
 * страницах (без нашего виджета — его ещё нет).
 *
 * Считаем сами, а не берём число из вывода `next build`: нужен gzip
 * ровно того, что браузер грузит при первом заходе на маршрут, —
 * `rootMainFiles` (рантайм Next + React) ∪ чанки корневого layout ∪
 * чанки layout'ов-предков ∪ чанк страницы (`app-build-manifest.json`).
 * `polyfills` (nomodule) современные браузеры не грузят — не в счёт.
 * Ленивые чанки (`web-vitals` после гидратации) — тоже не в счёт: они не
 * часть первой загрузки, и это проверяется отдельно — его модуль не должен
 * оказаться в начальных чанках.
 *
 * «Пустая страница» (§9: «ПРОВЕРИТЬ на пустой странице в Л0») —
 * `rootMainFiles` + корневой layout: столько весит маршрут без единого
 * своего клиентского компонента.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NEXT = path.join(ROOT, '.next');
const BUDGET_KB = Number(process.env.FIRST_LOAD_BUDGET_KB ?? 110);
const app = JSON.parse(fs.readFileSync(path.join(NEXT, 'app-build-manifest.json'), 'utf8')).pages;
const build = JSON.parse(fs.readFileSync(path.join(NEXT, 'build-manifest.json'), 'utf8'));

const cache = new Map();
const gz = (rel) => {
  if (!cache.has(rel)) cache.set(rel, zlib.gzipSync(fs.readFileSync(path.join(NEXT, rel)), { level: 9 }).length);
  return cache.get(rel);
};
const kb = (bytes) => (bytes / 1024).toFixed(1);

function filesFor(pageKey) {
  const parts = pageKey.replace(/\/page$/, '').split('/').filter(Boolean);
  const layouts = ['/layout'];
  for (let i = 1; i <= parts.length; i++) layouts.push(`/${parts.slice(0, i).join('/')}/layout`);
  const set = new Set(build.rootMainFiles);
  for (const key of [...layouts, pageKey]) for (const f of app[key] ?? []) if (f.endsWith('.js')) set.add(f);
  return [...set];
}

const baselineFiles = new Set([...build.rootMainFiles, ...(app['/layout'] ?? []).filter((f) => f.endsWith('.js'))]);
const baseline = [...baselineFiles].reduce((s, f) => s + gz(f), 0);

const rows = [];
let failed = false;
for (const key of Object.keys(app).filter((k) => k.endsWith('/page')).sort()) {
  const files = filesFor(key);
  const total = files.reduce((s, f) => s + gz(f), 0);
  const over = total > BUDGET_KB * 1024;
  failed ||= over;
  rows.push(`${over ? 'FAIL' : 'ok  '} ${kb(total).padStart(6)} КБ  ${key}`);
  // web-vitals не должен попасть в первую загрузку.
  for (const f of files) {
    if (/largest-contentful-paint/.test(fs.readFileSync(path.join(NEXT, f), 'utf8'))) {
      failed = true;
      rows.push(`FAIL web-vitals в начальном чанке ${f} (${key})`);
    }
  }
}
console.log(rows.join('\n'));
console.log(`пустая страница (рантайм Next + React + корневой layout): ${kb(baseline)} КБ gzip; бюджет ${BUDGET_KB} КБ (≈ базовая + ${kb(BUDGET_KB * 1024 - baseline)} КБ)`);
if (failed) {
  console.error(`FAIL бюджет JS первой загрузки ${BUDGET_KB} КБ gzip превышен`);
  process.exit(1);
}
console.log(`ok   JS первой загрузки: все маршруты ≤ ${BUDGET_KB} КБ gzip`);
