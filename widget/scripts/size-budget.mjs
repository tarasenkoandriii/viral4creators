#!/usr/bin/env node
/**
 * Размерный бюджет виджета в CI (ТЗ §4.12: «бюджет проверяется в CI»;
 * приёмка Э2 п.1): загрузчик ≤ 12 КБ gzip, чат (js + css) ≤ 60 КБ gzip.
 * Свой скрипт вместо `size-limit` (тот же замер gzip, без 30 зависимостей).
 *
 * Плюс проверка собранного ЗАГРУЗЧИКА на HTML-приёмники и eval (§4.12,
 * аудит 1.2): линт ловит исходники, а здесь — то, что могло прийти из
 * сборки/зависимостей.
 *
 *   npm run build && npm run size
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = 1024;

export const BUDGETS = [
  { name: 'loader', files: ['dist/v1/loader.js'], maxGzip: 12 * KB },
  {
    name: 'chat',
    files: ['dist/v1/chat.js', 'dist/v1/chat.css'],
    maxGzip: 60 * KB,
  },
  // Э3: режим выбора цели (только владельцу по `?v4c_goal=`, §5-тер.1).
  { name: 'picker', files: ['dist/v1/picker.js'], maxGzip: 10 * KB },
  // Э3 (интеграция): вовлечение и цели — ленивый чанк загрузчика (после
  // load + простоя или при первом взаимодействии, только при целях/триггерах).
  { name: 'engage', files: ['dist/v1/engage.js'], maxGzip: 8 * KB },
  // Э5: голос — ленивый чанк iframe-чата (запись, детектор речи, плеер);
  // грузится, только когда голос включён в конфиге сайта.
  { name: 'voice', files: ['dist/v1/voice.js'], maxGzip: 4 * KB },
  // Э6: «показать на экране» — ленивый чанк загрузчика, только по клику
  // посетителя на «Показать на странице» (исполняется в origin заказчика).
  { name: 'highlight', files: ['dist/v1/highlight.js'], maxGzip: 3 * KB },
];

export const LOADER_SINKS = [
  /\.innerHTML\s*=/,
  /\.outerHTML\s*=/,
  /insertAdjacentHTML\s*\(/,
  /document\.write(ln)?\s*\(/,
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /createContextualFragment\s*\(/,
];

function gzipSize(buf) {
  return zlib.gzipSync(buf, { level: 9 }).length;
}

let ok = true;
for (const b of BUDGETS) {
  let total = 0;
  for (const f of b.files) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) {
      console.error(`size-budget: нет ${f} — сначала npm run build`);
      process.exit(1);
    }
    total += gzipSize(fs.readFileSync(abs));
  }
  const line = `${b.name}: ${(total / KB).toFixed(2)} КБ gzip (бюджет ${b.maxGzip / KB} КБ)`;
  if (total > b.maxGzip) {
    ok = false;
    console.error(`ПРЕВЫШЕН ${line}`);
  } else {
    console.log(`ok   ${line}`);
  }
}

// Загрузчик и режим выбора цели исполняются в origin заказчика.
for (const [label, file] of [
  ['загрузчик', 'dist/v1/loader.js'],
  ['режим выбора цели', 'dist/v1/picker.js'],
  ['чанк вовлечения и целей', 'dist/v1/engage.js'],
  // Э5: чанк голоса живёт в iframe, но HTML-приёмников и eval в нём тоже
  // нет и не будет (Trusted Types iframe — 'none').
  ['чанк голоса', 'dist/v1/voice.js'],
  // Э6: подсветка — в origin заказчика, как загрузчик.
  ['чанк подсветки', 'dist/v1/highlight.js'],
]) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const re of LOADER_SINKS) {
    if (re.test(code)) {
      ok = false;
      console.error(`${label}: найден запрещённый приёмник ${re} (§4.12)`);
    }
  }
}
process.exit(ok ? 0 : 1);
