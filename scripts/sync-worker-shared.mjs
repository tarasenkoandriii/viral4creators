#!/usr/bin/env node
/**
 * Чистые модули монорепо → browser-worker/src/shared/** («копия с проверкой»,
 * тот же приём, что scripts/sync-relay-shared.mjs и sync-sites-shared.mjs).
 *
 * Зачем: браузерный воркер (Э-С Ш3) — отдельный Docker build context
 * (собирается с root = browser-worker на изолированном VPS), файлы вне папки
 * ему не видны. А ему нужны ОДНИ И ТЕ ЖЕ, что у бэкендов:
 *  - фильтр исходящего трафика браузера и список служебных адресов (Ш0) —
 *    два разных списка однажды разошлись бы молча;
 *  - подпись внутреннего API (Ш1) — расхождение формата невозможно по
 *    построению, если обе стороны подписывают одним кодом;
 *  - протокол очереди и конверт секретов (Ш3) — источник в sites-backend;
 *  - стоп-лист опасных кликов: категории обучалки (`danger-words`) и
 *    словарь действий голосового управления (`assist-ui-core/action-words`)
 *    — воркер не нажмёт то, что помощник считает «никогда».
 *
 *   node scripts/sync-worker-shared.mjs          # записать копии
 *   node scripts/sync-worker-shared.mjs --check  # только сверить (CI, make ci-worker)
 *
 * Копии КОММИТЯТСЯ. Править — только источник, затем запуск без флага.
 * `rewrite` — замена относительных импортов источника на импорт соседней
 * копии (action-words берёт danger-words из ../../shared).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = 'browser-worker/src/shared';

/** Источник → имя копии в SHARED. Только чистые модули (Node + друг друга). */
const ENTRIES = [
  { from: 'backend/src/common/external-url-guard.ts', to: 'external-url-guard.ts' },
  { from: 'backend/src/common/egress-filter-proxy.ts', to: 'egress-filter-proxy.ts' },
  { from: 'backend/src/common/sites-internal-signature.ts', to: 'sites-internal-signature.ts' },
  { from: 'backend/src/modules/client-site-tutorial/danger-words.ts', to: 'danger-words.ts' },
  { from: 'sites-backend/src/modules/assist-ui-core/normalize.ts', to: 'normalize.ts' },
  {
    from: 'sites-backend/src/modules/assist-ui-core/action-words.ts',
    to: 'action-words.ts',
    rewrite: [["'../../shared/danger-words'", "'./danger-words'"]],
  },
  { from: 'sites-backend/src/modules/browser-jobs/protocol.ts', to: 'browser-job-protocol.ts' },
  { from: 'sites-backend/src/modules/browser-jobs/worker-seal.ts', to: 'worker-seal.ts' },
];

const CHECK = process.argv.includes('--check');

function header(from) {
  return [
    '// СГЕНЕРИРОВАНО scripts/sync-worker-shared.mjs — не править.',
    `// Источник: ${from}. Правка — в источнике, затем`,
    '// `node scripts/sync-worker-shared.mjs`; CI сверяет копию флагом --check.',
    '',
    '',
  ].join('\n');
}

function body(entry) {
  let src = fs.readFileSync(path.join(ROOT, entry.from), 'utf8');
  for (const [a, b] of entry.rewrite ?? []) {
    if (!src.includes(a)) {
      throw new Error(`${entry.from}: нет импорта ${a} для замены — обновите ENTRIES`);
    }
    src = src.split(a).join(b);
  }
  return src;
}

/** Относительные импорты копии обязаны вести в другие копии. */
function purityProblems() {
  const problems = [];
  const names = new Set(ENTRIES.map((e) => e.to.replace(/\.ts$/, '')));
  for (const entry of ENTRIES) {
    const src = body(entry);
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      if (!spec.startsWith('./') || !names.has(spec.slice(2))) {
        problems.push(`${entry.from}: импорт «${spec}» ведёт за пределы копируемого набора`);
      }
    }
    if (/@prisma\/client|@nestjs\//.test(src)) {
      problems.push(`${entry.from}: модуль не чистый (Prisma/Nest)`);
    }
  }
  return problems;
}

function main() {
  const problems = purityProblems();
  if (problems.length) {
    console.error('sync-worker-shared: копия не была бы самодостаточной:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const expected = new Map(
    ENTRIES.map((e) => [`${SHARED}/${e.to}`, header(e.from) + body(e)]),
  );
  const sharedAbs = path.join(ROOT, SHARED);
  const present = fs.existsSync(sharedAbs)
    ? fs.readdirSync(sharedAbs).map((n) => `${SHARED}/${n}`)
    : [];
  const stale = present.filter((p) => !expected.has(p));
  const diff = [...expected].filter(([p, text]) => {
    const abs = path.join(ROOT, p);
    return !fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== text;
  });
  if (CHECK) {
    if (diff.length || stale.length) {
      console.error('sync-worker-shared: копии расходятся с источниками:');
      for (const [p] of diff) console.error(`  - ${p} (устарела или нет)`);
      for (const p of stale) console.error(`  - ${p} (лишняя: источника нет)`);
      console.error('Запустите: node scripts/sync-worker-shared.mjs');
      process.exit(1);
    }
    console.log(`ok   sync-worker-shared: копии совпадают (${expected.size} файлов)`);
    return;
  }
  fs.mkdirSync(sharedAbs, { recursive: true });
  for (const p of stale) fs.rmSync(path.join(ROOT, p));
  for (const [p, text] of expected) fs.writeFileSync(path.join(ROOT, p), text);
  console.log(`sync-worker-shared: записано ${expected.size} файлов, удалено лишних ${stale.length}`);
}

main();
