#!/usr/bin/env node
/**
 * site-tma-kit/src/** → <приложение>/src/kit/** («копия со сверкой»,
 * контракт Э0 п.3).
 *
 * Почему копия, а не импорт `../site-tma-kit` через alias Vite/tsconfig:
 * 1. Vercel-проект собирается с root = `assist/` — файлы вне root в сборку
 *    могут не попасть (зависит от настройки проекта, и проверить это из
 *    репозитория нельзя);
 * 2. даже когда попадают, `import 'react'` из файла вне `assist/` ищет
 *    `node_modules` вверх от `site-tma-kit/` — там их нет (workspaces в
 *    репо нет), и сборка падает или тянет второй React.
 * Копия коммитится, `--check` в CI падает при расхождении — правка мимо
 * источника не проходит.
 *
 *   node scripts/sync-site-tma-kit.mjs          # записать копии
 *   node scripts/sync-site-tma-kit.mjs --check  # только сверить (CI)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'site-tma-kit/src');
// QA-TMA добавится сюда второй строкой.
const TARGETS = [join(root, 'assist/src/kit')];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function header(rel) {
  return (
    `/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. ` +
    `Источник: site-tma-kit/src/${rel} */\n`
  );
}

const check = process.argv.includes('--check');
const sources = walk(SOURCE).filter((f) => /\.(ts|tsx)$/.test(f));
if (sources.length === 0) {
  console.error('site-tma-kit/src пуст или не найден');
  process.exit(1);
}

const problems = [];
for (const target of TARGETS) {
  const expected = new Map(
    sources.map((f) => {
      const rel = relative(SOURCE, f).split('\\').join('/');
      return [rel, header(rel) + readFileSync(f, 'utf8')];
    })
  );
  const actual = walk(target).map((f) =>
    relative(target, f).split('\\').join('/')
  );
  const shownTarget = relative(root, target);

  for (const rel of actual) {
    if (!expected.has(rel)) {
      if (check) problems.push(`${shownTarget}/${rel}: лишний файл`);
      else rmSync(join(target, rel));
    }
  }
  for (const [rel, content] of expected) {
    const dest = join(target, rel);
    const cur = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    if (cur === content) continue;
    if (check) {
      problems.push(
        `${shownTarget}/${rel}: ${cur === null ? 'нет копии' : 'расходится с источником'}`
      );
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
  }
}

if (problems.length) {
  console.error(
    'site-tma-kit: копии расходятся с источником —\n  ' +
      problems.join('\n  ') +
      '\nПравьте site-tma-kit/src и запустите node scripts/sync-site-tma-kit.mjs'
  );
  process.exit(1);
}
console.log(
  check
    ? `site-tma-kit: копии совпадают (${sources.length} файлов)`
    : `site-tma-kit: записано ${sources.length} файлов`
);
