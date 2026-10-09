#!/usr/bin/env node
/**
 * Бюджет JS первой загрузки лендинга `landing/` (Ш5 (14)) — по образцу
 * `sites-landing/scripts/built/first-load-js.mjs` (`budget:js`). Запуск —
 * после `next build`: `npm run budget:js` (CI, джоба landing; `make ci`).
 *
 * Зачем. Виджет ИИ-помощника платформы (`NEXT_PUBLIC_ASSIST_WIDGET`)
 * обещает не трогать первую отрисовку: загрузчик — после `load` + idle,
 * чат — по клику. Обещание без числа в CI не держится: любой «удобный»
 * импорт в общий layout или на главную тихо утяжеляет каждую страницу.
 * Здесь — потолки маршрутов с запасом ≈ 10 % к замеру (07.10.2026;
 * пересняты 09.10.2026 после Next 15 + React 19, заход 12), превышение —
 * громкий отказ (код 1) с разбором по чанкам.
 *
 * Считаем сами, а не берём число из вывода `next build` (как sites-landing):
 * gzip ровно того, что браузер грузит при первом заходе на маршрут, —
 * `rootMainFiles` (рантайм Next + React) ∪ чанки корневого layout ∪ чанки
 * layout'ов-предков ∪ чанк страницы (`app-build-manifest.json`).
 * `polyfills` (nomodule) современные браузеры не грузят — не в счёт.
 * Ленивые чанки (`next/dynamic`, загрузчик виджета) — тоже: не первая
 * загрузка. Новый маршрут без своей строки в `ROUTE_BUDGET_KB` получает
 * общий потолок `DEFAULT_BUDGET_KB`.
 *
 * Сборка `NEXT_PUBLIC_ASSIST_WIDGET=platform` — `npm run budget:js --
 * --platform` (CI, джоба landing — второй прогон): поверх потолков ниже —
 * `PLATFORM_ROUTE_BUDGET_KB`. Флаг, а не та же переменная окружения: режим
 * задаёт сборка, а не запуск скрипта, и переменная, оставшаяся в shell,
 * тихо подменила бы потолки. Флаг на сборке `legacy` — громкий отказ
 * (how-it-works там тяжелее платформенного потолка).
 *
 * Переопределение (разовая проверка, не способ «пройти CI»):
 * `FIRST_LOAD_BUDGET_KB` — общий потолок, `FIRST_LOAD_BUDGET_SCALE` —
 * множитель всех потолков (проверка запаса: при `0.9` сборка на
 * 09.10.2026 не проходит — запас не больше ≈ 10 %).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = process.env.FIRST_LOAD_NEXT_DIR
  ? path.resolve(process.env.FIRST_LOAD_NEXT_DIR)
  : path.join(ROOT, '.next');

const SCALE = Number(process.env.FIRST_LOAD_BUDGET_SCALE ?? 1);
/**
 * Общий потолок маршрута без своей строки (КБ gzip): самый тяжёлый из
 * таких на замере — `/qa/demo-shop` 111.5 КБ (на Next 14 — 96.6).
 */
const DEFAULT_BUDGET_KB = Number(process.env.FIRST_LOAD_BUDGET_KB ?? 123);
/**
 * Потолки маршрутов, КБ gzip уровня 9: замер этого скрипта (в скобках) +
 * ≈ 10 %. Замер 09.10.2026 (заход 12) — после перехода на Next 15.5 +
 * React 19: общая часть (рантайм Next + React + корневой layout) выросла
 * 85.5 → 100.5 КБ, маршруты — на 9–15 КБ; свои чанки страниц — те же.
 * Прежние замеры (Next 14, 07–08.10.2026) — вторым числом. Таблица
 * `next build` показывает на 1–3 КБ больше (другой уровень сжатия).
 */
export const ROUTE_BUDGET_KB = {
  // Главная: виджет помощника (ленивый), демо, EntryActions (114.4; 105.3).
  '/[locale]/page': 126,
  // «Как это работает»: встроенная панель помощника в сетке (116.4; 107.4),
  // а в сборке `platform` без кода чата — 112.2 (103.2), см.
  // components/EmbeddedAssistant.tsx; её потолок — `PLATFORM_ROUTE_BUDGET_KB`.
  '/[locale]/how-it-works/page': 128,
  '/[locale]/greetings/page': 123, // (112.2; 102.4)
  '/[locale]/site-tutorial/page': 120, // (109.2; 94.0)
  '/[locale]/blog/page': 117, // (106.2; 97.2)
  '/[locale]/blog/[slug]/page': 117, // (106.2; 97.2)
  // Служебная страница-переход «Открыть приложение», Ш5 (6) (104.9; 95.2).
  '/[locale]/open/page': 115,
};
/**
 * Потолки сборки `platform` (`--platform`) поверх `ROUTE_BUDGET_KB`. Запас
 * здесь не ≈ 10 %, а меньше разницы режимов: смысл строки — поймать чат
 * `AssistantWidget`, вернувшийся в First Load JS how-it-works (с ним
 * 116,4 КБ, как в legacy), а +10 % к замеру его бы пропустили.
 */
export const PLATFORM_ROUTE_BUDGET_KB = {
  // Без кода чата, см. components/EmbeddedAssistant.tsx (112.2; на Next 14 —
  // 103.2 при потолке 106).
  '/[locale]/how-it-works/page': 115,
};
const PLATFORM = process.argv.slice(2).includes('--platform');
const routeBudget = PLATFORM ? { ...ROUTE_BUDGET_KB, ...PLATFORM_ROUTE_BUDGET_KB } : ROUTE_BUDGET_KB;
/** Маршруты, которые обязаны быть в сборке (иначе бюджет молча не меряет). */
const REQUIRED = ['/[locale]/page', '/[locale]/how-it-works/page', '/[locale]/site-tutorial/page'];

function readJson(file) {
  const full = path.join(NEXT, file);
  if (!fs.existsSync(full)) {
    console.error(`FAIL нет ${full} — сначала \`next build\` (npm run build)`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

const app = readJson('app-build-manifest.json').pages;
const build = readJson('build-manifest.json');

const cache = new Map();
const gz = (rel) => {
  if (!cache.has(rel)) {
    cache.set(rel, zlib.gzipSync(fs.readFileSync(path.join(NEXT, rel)), { level: 9 }).length);
  }
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

const baselineFiles = new Set([
  ...build.rootMainFiles,
  ...(app['/layout'] ?? []).filter((f) => f.endsWith('.js')),
]);
const baseline = [...baselineFiles].reduce((s, f) => s + gz(f), 0);

const rows = [];
const failures = [];
const pages = Object.keys(app).filter((k) => k.endsWith('/page')).sort();
for (const key of pages) {
  const files = filesFor(key);
  const total = files.reduce((s, f) => s + gz(f), 0);
  const budget = (routeBudget[key] ?? DEFAULT_BUDGET_KB) * SCALE;
  const over = total > budget * 1024;
  rows.push(`${over ? 'FAIL' : 'ok  '} ${kb(total).padStart(6)} КБ / ${budget.toFixed(0).padStart(3)} КБ  ${key}`);
  if (over) {
    const own = files
      .filter((f) => !baselineFiles.has(f))
      .map((f) => ({ f, size: gz(f) }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 6)
      .map(({ f, size }) => `       ${kb(size).padStart(6)} КБ  ${f}`);
    failures.push(
      `${key}: ${kb(total)} КБ gzip > ${budget.toFixed(0)} КБ (+${kb(total - budget * 1024)} КБ); крупнейшие свои чанки:\n${own.join('\n')}`,
    );
  }
}
console.log(rows.join('\n'));
console.log(`общая часть (рантайм Next + React + корневой layout): ${kb(baseline)} КБ gzip`);

const missing = REQUIRED.filter((k) => !app[k]);
if (missing.length) {
  console.error(`FAIL маршрута с бюджетом нет в сборке: ${missing.join(', ')}`);
  process.exit(1);
}
if (failures.length) {
  console.error(`\nFAIL бюджет JS первой загрузки лендинга превышен:\n${failures.join('\n')}`);
  console.error(
    '\nЧто делать: тяжёлое — за next/dynamic (как LazyPlatformAssist) или на сервер; поднимать потолок в landing/scripts/first-load-js.mjs — только осознанно, с причиной в комментарии.',
  );
  process.exit(1);
}
console.log(
  `ok   JS первой загрузки лендинга${PLATFORM ? ' (сборка platform)' : ''}: ${pages.length} маршрутов в бюджете`,
);
