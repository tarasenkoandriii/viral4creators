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
  { name: 'chat', files: ['dist/v1/chat.js', 'dist/v1/chat.css'], maxGzip: 60 * KB },
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

const loader = fs.readFileSync(path.join(ROOT, 'dist/v1/loader.js'), 'utf8');
for (const re of LOADER_SINKS) {
  if (re.test(loader)) {
    ok = false;
    console.error(`загрузчик: найден запрещённый приёмник ${re} (§4.12)`);
  }
}
process.exit(ok ? 0 : 1);
