/**
 * Ш5 (14): бюджет JS первой загрузки (`scripts/first-load-js.mjs`) на
 * искусственной сборке — что он считает ровно первую загрузку маршрута
 * (рантайм + layout'ы-предки + страница, без polyfills и ленивых чанков),
 * громко падает при превышении и при отсутствии обязательного маршрута.
 * Сборка лендинга для этого не нужна: манифесты и чанки — во временной
 * папке (`FIRST_LOAD_NEXT_DIR`), чанки — несжимаемые байты известной длины.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'first-load-js.mjs');
const KB = 1024;

function fakeBuild(sizesKb: Record<string, number>, pages: Record<string, string[]>, rootMain: string[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'v4c-budget-'));
  for (const [file, kb] of Object.entries(sizesKb)) {
    const full = path.join(dir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, randomBytes(Math.round(kb * KB)));
  }
  writeFileSync(path.join(dir, 'app-build-manifest.json'), JSON.stringify({ pages }));
  writeFileSync(
    path.join(dir, 'build-manifest.json'),
    JSON.stringify({ rootMainFiles: rootMain, polyfillFiles: ['static/chunks/polyfills.js'] }),
  );
  return dir;
}

function run(dir: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, FIRST_LOAD_NEXT_DIR: dir, ...env },
    encoding: 'utf8',
  });
}

const base = {
  // Рантайм с запасом под Next 15 + React 19 (общая часть ≈ 100 КБ).
  'static/chunks/main.js': 75,
  'static/chunks/polyfills.js': 500, // nomodule — не в счёт
  'static/chunks/app/layout.js': 20,
  'static/chunks/app/[locale]/layout.js': 5,
  'static/chunks/app/[locale]/page.js': 10,
  'static/chunks/app/[locale]/how-it-works/page.js': 10,
  'static/chunks/app/[locale]/site-tutorial/page.js': 5,
  'static/chunks/lazy-widget.js': 400, // ленивый — ни в одном списке маршрута
};
const pages = {
  '/layout': ['static/chunks/app/layout.js', 'static/css/app.css'],
  '/[locale]/layout': ['static/chunks/app/[locale]/layout.js'],
  '/[locale]/page': ['static/chunks/app/[locale]/page.js'],
  '/[locale]/how-it-works/page': ['static/chunks/app/[locale]/how-it-works/page.js'],
  '/[locale]/site-tutorial/page': ['static/chunks/app/[locale]/site-tutorial/page.js'],
};
const root = ['static/chunks/main.js'];

// 75 + 20 + 5 + 10 ≈ 110 КБ на главной (+ накладные gzip) — в бюджете 126.
const ok = fakeBuild(base, pages, root);
try {
  const r = run(ok);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok\s+11\d\.\d КБ \/ 126 КБ\s+\/\[locale\]\/page/);
  // polyfills (500) и ленивый чанк (400) в счёт не вошли.
  assert.doesNotMatch(r.stdout, /[3-9]\d\d\.\d КБ/);
  // Тот же замер с потолками × 0.8 — громкий отказ с разбором по чанкам.
  const tight = run(ok, { FIRST_LOAD_BUDGET_SCALE: '0.8' });
  assert.equal(tight.status, 1);
  assert.match(tight.stderr, /FAIL бюджет JS первой загрузки лендинга превышен/);
  assert.match(tight.stderr, /static\/chunks\/app\/\[locale\]\/page\.js/);
  // `--platform` (сборка NEXT_PUBLIC_ASSIST_WIDGET=platform): у how-it-works
  // свой потолок 115 вместо 128, остальные — как были.
  const plat = spawnSync(process.execPath, [script, '--platform'], {
    env: { ...process.env, FIRST_LOAD_NEXT_DIR: ok },
    encoding: 'utf8',
  });
  assert.equal(plat.status, 0, plat.stdout + plat.stderr);
  assert.match(plat.stdout, /ok\s+11\d\.\d КБ \/ 115 КБ\s+\/\[locale\]\/how-it-works\/page/);
  assert.match(plat.stdout, /\/ 126 КБ\s+\/\[locale\]\/page/);
  assert.match(plat.stdout, /\(сборка platform\)/);
} finally {
  rmSync(ok, { recursive: true, force: true });
}

// Главная потяжелела на 30 КБ (импорт в страницу) — отказ именно её.
const heavy = fakeBuild({ ...base, 'static/chunks/app/[locale]/page.js': 40 }, pages, root);
try {
  const r = run(heavy);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL\s+14\d\.\d КБ \/ 126 КБ\s+\/\[locale\]\/page/);
  assert.match(r.stdout, /ok\s+\d+\.\d КБ \/ 128 КБ\s+\/\[locale\]\/how-it-works\/page/);
} finally {
  rmSync(heavy, { recursive: true, force: true });
}

// Тяжёлое в общем layout локали — падают все маршруты под ним.
const layoutHeavy = fakeBuild({ ...base, 'static/chunks/app/[locale]/layout.js': 40 }, pages, root);
try {
  const r = run(layoutHeavy);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL.*\/\[locale\]\/site-tutorial\/page/);
} finally {
  rmSync(layoutHeavy, { recursive: true, force: true });
}

// Новый маршрут без своей строки — общий потолок 123.
const extra = fakeBuild(
  { ...base, 'static/chunks/app/new/page.js': 30 },
  { ...pages, '/new/page': ['static/chunks/app/new/page.js'] },
  root,
);
try {
  const r = run(extra);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL\s+\d+\.\d КБ \/ 123 КБ\s+\/new\/page/);
} finally {
  rmSync(extra, { recursive: true, force: true });
}

// Обязательного маршрута нет (переименовали) — не «всё зелёное», а отказ.
const { ['/[locale]/how-it-works/page']: _gone, ...without } = pages;
const missing = fakeBuild(base, without, root);
try {
  const r = run(missing);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /маршрута с бюджетом нет в сборке: \/\[locale\]\/how-it-works\/page/);
} finally {
  rmSync(missing, { recursive: true, force: true });
}

// Нет сборки вовсе — понятный отказ.
const empty = mkdtempSync(path.join(os.tmpdir(), 'v4c-budget-'));
try {
  const r = run(empty);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /сначала `next build`/);
} finally {
  rmSync(empty, { recursive: true, force: true });
}

console.log('first-load-budget: первая загрузка без polyfills и ленивых чанков, отказ по маршруту/layout/новому маршруту, обязательные маршруты, потолки --platform');
