#!/usr/bin/env node
/**
 * Чистые модули backend/ → live-login-relay/src/shared/** («копия с
 * проверкой», тот же приём, что scripts/sync-sites-shared.mjs).
 *
 * Зачем: реле — отдельный Docker build context (Dokploy собирает его с
 * root = live-login-relay), файлы вне папки ему не видны. А фильтрующий
 * прокси браузера (Ш0.2, docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md)
 * и список служебных адресов обязаны быть ОДНИМИ И ТЕМИ ЖЕ у обучалки
 * (backend) и у реле: два разных списка однажды разошлись бы молча, и
 * дыра закрылась бы только в одном из двух браузеров.
 *
 *   node scripts/sync-relay-shared.mjs          # записать копии
 *   node scripts/sync-relay-shared.mjs --check  # только сверить (CI, make ci-relay)
 *
 * Копии КОММИТЯТСЯ. Править — только источник в backend/, затем запуск
 * без флага.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = 'live-login-relay/src/shared';

/** Источник → имя копии в SHARED. Только чистые модули (Node + друг друга). */
const ENTRIES = [
  { from: 'backend/src/common/external-url-guard.ts', to: 'external-url-guard.ts' },
  { from: 'backend/src/common/egress-filter-proxy.ts', to: 'egress-filter-proxy.ts' },
];

const CHECK = process.argv.includes('--check');

function header(from) {
  return [
    '// СГЕНЕРИРОВАНО scripts/sync-relay-shared.mjs — не править.',
    `// Источник: ${from}. Правка — в источнике, затем`,
    '// `node scripts/sync-relay-shared.mjs`; CI сверяет копию флагом --check.',
    '',
    '',
  ].join('\n');
}

/** Относительные импорты копии обязаны вести в другие копии. */
function purityProblems() {
  const problems = [];
  const names = new Set(ENTRIES.map((e) => e.to.replace(/\.ts$/, '')));
  for (const { from } of ENTRIES) {
    const src = fs.readFileSync(path.join(ROOT, from), 'utf8');
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      if (!spec.startsWith('./') || !names.has(spec.slice(2))) {
        problems.push(`${from}: импорт «${spec}» ведёт за пределы копируемого набора`);
      }
    }
    if (/@prisma\/client|@nestjs\//.test(src)) {
      problems.push(`${from}: модуль не чистый (Prisma/Nest)`);
    }
  }
  return problems;
}

function main() {
  const problems = purityProblems();
  if (problems.length) {
    console.error('sync-relay-shared: копия не была бы самодостаточной:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const expected = new Map(
    ENTRIES.map(({ from, to }) => [
      `${SHARED}/${to}`,
      header(from) + fs.readFileSync(path.join(ROOT, from), 'utf8'),
    ]),
  );
  const sharedAbs = path.join(ROOT, SHARED);
  const present = fs.existsSync(sharedAbs)
    ? fs.readdirSync(sharedAbs).map((f) => `${SHARED}/${f}`)
    : [];

  const stale = [];
  for (const [file, content] of expected) {
    const abs = path.join(ROOT, file);
    const actual = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (actual !== content) stale.push(file);
  }
  const extra = present.filter((f) => !expected.has(f));

  if (CHECK) {
    if (stale.length || extra.length) {
      console.error('sync-relay-shared: копии в live-login-relay разошлись с backend/:');
      for (const f of stale) console.error(`  - устарела: ${f}`);
      for (const f of extra) console.error(`  - лишняя: ${f}`);
      console.error('Запустите `node scripts/sync-relay-shared.mjs` и закоммитьте копии.');
      process.exit(1);
    }
    console.log(`sync-relay-shared: ${expected.size} копий совпадают с источником`);
    return;
  }

  fs.mkdirSync(sharedAbs, { recursive: true });
  for (const [file, content] of expected) {
    fs.writeFileSync(path.join(ROOT, file), content);
  }
  for (const f of extra) fs.rmSync(path.join(ROOT, f));
  console.log(
    `sync-relay-shared: записано ${expected.size}, удалено лишних ${extra.length}`,
  );
}

main();
