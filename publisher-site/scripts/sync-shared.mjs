#!/usr/bin/env node
/**
 * Копии чистых модулей sites-backend → `publisher-site/src/shared/`
 * («копия с проверкой», как scripts/sync-sites-shared.mjs).
 *
 * Зачем копия: у Vercel-проекта сайта Root Directory = `publisher-site`
 * (ignoreCommand смотрит только `.`), код бэкенда в сборку не тянется. А
 * правила формы ОБЯЗАНЫ быть одними у сайта и сервера (проектный документ
 * §13.1, §16.8; `contracts/lead-validation.ts` — «ОДНИ правила для сервера и
 * сайта»). Поэтому файл копируется байт-в-байт (плюс шапка), а `--check`
 * (в `npm test`, джоба CI `publisher-site`) падает при расхождении; правка
 * источника запускает джобу (правило `publisher_site` в scripts/ci-changes.mjs
 * покрывает `sites-backend/src/modules/publisher/contracts/`).
 *
 * Копируется только САМОДОСТАТОЧНЫЙ модуль: без импортов вообще — скрипт
 * проверяет это сам.
 *
 *   node scripts/sync-shared.mjs          # записать копии
 *   node scripts/sync-shared.mjs --check  # только сверить
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(SITE, '..');

export const ENTRIES = [
  {
    from: 'sites-backend/src/modules/publisher/contracts/lead-validation.ts',
    to: 'src/shared/lead-validation.ts',
  },
];

export function headerFor(from) {
  return (
    '/* СГЕНЕРИРОВАНО publisher-site/scripts/sync-shared.mjs — не править.\n' +
    ` * Источник: ${from}. Правка — в источнике, затем\n` +
    ' * `node scripts/sync-shared.mjs` (из publisher-site); CI сверяет копию --check. */\n'
  );
}

export function render(from, source) {
  if (/^\s*import[\s{*]|^\s*export\s+(?:\*|\{[^}]*\})\s*from\s|\brequire\(|\bimport\(/m.test(source)) {
    throw new Error(`${from}: модуль с импортами копировать нельзя — копия обязана быть самодостаточной`);
  }
  return headerFor(from) + source;
}

const CHECK = process.argv.includes('--check');
let bad = 0;
for (const e of ENTRIES) {
  const src = path.join(REPO, e.from);
  const dst = path.join(SITE, e.to);
  if (!fs.existsSync(src)) {
    console.error(`FAIL нет источника ${e.from}`);
    bad++;
    continue;
  }
  const want = render(e.from, fs.readFileSync(src, 'utf8'));
  const have = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
  if (have === want) continue;
  if (CHECK) {
    console.error(`FAIL ${e.to} расходится с ${e.from} — выполните \`node scripts/sync-shared.mjs\``);
    bad++;
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, want);
    console.log(`записано ${e.to}`);
  }
}
if (bad) process.exit(1);
console.log(`ok   sync-shared${CHECK ? ' --check' : ''}: копий ${ENTRIES.length}, совпадают с источником`);
