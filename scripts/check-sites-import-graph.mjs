#!/usr/bin/env node
/**
 * Правило графа зависимостей sites-backend (ТЗ помощника §4.3-бис, слой 2
 * изоляции «Сайт»/«Админка», К-9; §4.2 ред. 1.4; приёмка Э0: «CI падает на
 * импорте assist-admin-* из assist-site-*»).
 *
 * Слой 2 ловит ошибку разработчика «вызвал не тот репозиторий»: код
 * режима «Сайт» физически не может дотянуться до знаний «Админки», потому
 * что не может их импортировать. Роль БД (слой 3) ловит то, что прошло
 * мимо, — но падение сборки дешевле и раньше, чем отказ Postgres в проде.
 *
 * Правила (модуль = папка `sites-backend/src/modules/<имя>/`):
 *  1. «Сайт» ↛ «Админка»: `assist-site-*`, `assist-widget`,
 *     `assist-analytics`, `assist-voice-map`, `site-crawl` не импортируют
 *     `assist-admin-*` (§4.3-бис, §4.2 1.4, У-9).
 *  2. «Админка» ↛ «Сайт»: `assist-admin-*` не импортируют модули режима
 *     «Сайт» из п.1, кроме общего с QA `site-crawl` — «Админка» по Р-19
 *     индексирует те же публичные страницы (таблица §5-кватер «Код»;
 *     §4-бис.8 «и наоборот»).
 *  3. `assist-ui-core` — нейтральный, без доступа к БД: не импортирует ни
 *     `assist-site-*`, ни `assist-admin-*` (§5-бис.3 п.3, У-19).
 *  4. `src/shared/**` (копии чистых модулей backend/) не импортирует
 *     `src/modules/**`: иначе «чистая» копия тянула бы за собой продукт.
 *
 * Учитываются все виды ссылок: `import … from`, `export … from`,
 * `import '…'`, `import(…)`, `require(…)`, `jest.mock(…)`; пути —
 * относительные и от `baseUrl` (`src/…`). Тесты (*.spec.ts) проверяются
 * тоже: спек «Сайта», импортирующий «Админку», — та же дыра в слое.
 *
 *   node scripts/check-sites-import-graph.mjs              # проверить sites-backend/src
 *   node scripts/check-sites-import-graph.mjs --self-test  # самотест на фикстурах
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SITE_MODE = [
  /^assist-site-/,
  /^assist-widget$/,
  /^assist-analytics$/,
  /^assist-voice-map$/,
  /^site-crawl$/,
];
const ADMIN_MODE = [/^assist-admin-/];
const UI_CORE = [/^assist-ui-core$/];

const matches = (name, patterns) =>
  name !== null && patterns.some((re) => re.test(name));

/** Правила: кто (from) не может импортировать кого (to). */
export const RULES = [
  {
    id: 'site↛admin',
    why: '§4.3-бис слой 2: код режима «Сайт» не импортирует «Админку»',
    from: (m) => matches(m, SITE_MODE),
    to: (m) => matches(m, ADMIN_MODE),
  },
  {
    id: 'admin↛site',
    why: '§5-кватер/§4-бис.8: «Админка» не импортирует модули «Сайта» (site-crawl — общий, можно)',
    from: (m) => matches(m, ADMIN_MODE),
    to: (m) => matches(m, SITE_MODE) && m !== 'site-crawl',
  },
  {
    id: 'ui-core-neutral',
    why: '§5-бис.3 п.3: assist-ui-core не импортирует ни «Сайт», ни «Админку»',
    from: (m) => matches(m, UI_CORE),
    to: (m) => matches(m, [/^assist-site-/, ...ADMIN_MODE]),
  },
];

const SOURCE_RE = /\.(ts|tsx|js|mjs|cjs)$/;

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (SOURCE_RE.test(e.name) && !e.name.endsWith('.d.ts'))
      out.push(full);
  }
  return out;
}

/** Комментарии вырезаются: пример импорта в комментарии — не импорт. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Все спецификаторы модулей в исходнике. */
export function importSpecifiers(source) {
  const src = stripComments(source);
  const specs = [];
  const re =
    /(?:^|[^\w$.])(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w$.])import\s*['"]([^'"]+)['"]|(?:^|[^\w$.])(?:require|import|jest\.mock|jest\.requireActual|jest\.doMock)\(\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) specs.push(m[1] ?? m[2] ?? m[3]);
  return specs;
}

/**
 * Путь файла (от src) → «зона»: имя модуля, 'shared' или null (прочее:
 * prisma, common, config…).
 */
function zoneOf(relFromSrc, isTarget = false) {
  const parts = relFromSrc.split('/');
  if (parts[0] === 'modules' && parts.length >= 2) {
    // Файл-исходник прямо в modules/ (без папки модуля) — не модуль. А цель
    // `modules/<имя>` — это index модуля (`import … from '../assist-admin-chat'`).
    if (parts.length >= 3 || isTarget) {
      return { kind: 'module', name: parts[1].replace(SOURCE_RE, '') };
    }
    return { kind: 'other' };
  }
  if (parts[0] === 'shared') return { kind: 'shared' };
  return { kind: 'other' };
}

/** Спецификатор → путь цели от src (или null, если это пакет). */
function resolveTarget(fileRelFromSrc, spec) {
  if (spec.startsWith('.')) {
    const joined = path.posix.normalize(
      path.posix.join(path.posix.dirname(fileRelFromSrc), spec),
    );
    return joined.startsWith('..') ? null : joined;
  }
  // `baseUrl: "./"` в tsconfig — `src/modules/...` тоже валидный путь.
  if (spec.startsWith('src/')) return spec.slice(4);
  return null;
}

/**
 * Нарушения графа в дереве `srcDir` (это `sites-backend/src` или папка
 * фикстур самотеста той же формы).
 */
export function findViolations(srcDir) {
  const violations = [];
  for (const abs of walk(srcDir)) {
    const rel = path.relative(srcDir, abs).split(path.sep).join('/');
    const fromZone = zoneOf(rel);
    if (fromZone.kind === 'other') continue;
    const source = fs.readFileSync(abs, 'utf8');
    for (const spec of importSpecifiers(source)) {
      const target = resolveTarget(rel, spec);
      if (target === null) continue;
      const toZone = zoneOf(target, true);
      if (fromZone.kind === 'shared') {
        if (
          toZone.kind === 'module' ||
          target === 'modules' ||
          target.startsWith('modules/')
        ) {
          violations.push({
            file: rel,
            spec,
            rule: 'shared↛modules',
            why: 'src/shared — копии чистых модулей, они не зависят от модулей продукта',
          });
        }
        continue;
      }
      if (toZone.kind !== 'module' || toZone.name === fromZone.name) continue;
      for (const rule of RULES) {
        if (rule.from(fromZone.name) && rule.to(toZone.name)) {
          violations.push({ file: rel, spec, rule: rule.id, why: rule.why });
        }
      }
    }
  }
  return violations;
}

function report(violations, label) {
  if (violations.length === 0) {
    console.log(`ok   check-sites-import-graph: ${label} — нарушений нет`);
    return true;
  }
  console.error(
    `check-sites-import-graph: ${label} — нарушения правила графа зависимостей:`,
  );
  for (const v of violations) {
    console.error(`  - ${v.file}: «${v.spec}» [${v.rule}] ${v.why}`);
  }
  return false;
}

/**
 * Самотест: фикстуры-нарушители и «чистые» во временной папке. Без него
 * проверка, которая сейчас проходит потому, что модулей помощника ещё нет,
 * могла бы проходить и потому, что она сломана.
 */
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sites-graph-'));
  const write = (rel, content) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  // Каждая фикстура-нарушитель — ровно одно нарушение своего правила.
  const bad = [
    [
      'modules/assist-site-chat/a.ts',
      `import { X } from '../assist-admin-knowledge/repo';`,
      'site↛admin',
    ],
    [
      'modules/assist-site-knowledge/deep/b.ts',
      `import type { Y } from '../../assist-admin-chat';`,
      'site↛admin',
    ],
    [
      'modules/assist-widget/c.ts',
      `export * from 'src/modules/assist-admin-knowledge/x';`,
      'site↛admin',
    ],
    [
      'modules/assist-analytics/d.ts',
      `const m = require('../assist-admin-analytics/y');`,
      'site↛admin',
    ],
    [
      'modules/assist-voice-map/e.ts',
      `const m = await import('../assist-admin-voice-map/z');`,
      'site↛admin',
    ],
    [
      'modules/site-crawl/f.ts',
      `import '../assist-admin-crawl/side-effect';`,
      'site↛admin',
    ],
    [
      'modules/assist-site-chat/g.spec.ts',
      `jest.mock('../assist-admin-chat/svc');`,
      'site↛admin',
    ],
    [
      'modules/assist-admin-chat/h.ts',
      `import {\n  Z,\n} from '../assist-site-knowledge/repo';`,
      'admin↛site',
    ],
    [
      'modules/assist-admin-knowledge/i.ts',
      `import { W } from '../assist-widget/w';`,
      'admin↛site',
    ],
    [
      'modules/assist-ui-core/j.ts',
      `import { V } from '../assist-site-chat/v';`,
      'ui-core-neutral',
    ],
    [
      'modules/assist-ui-core/k.ts',
      `import { V } from '../assist-admin-chat/v';`,
      'ui-core-neutral',
    ],
    [
      'shared/l.ts',
      `import { G } from '../modules/telegram-auth/guard';`,
      'shared↛modules',
    ],
    [
      'shared/sub/m.ts',
      `export { H } from 'src/modules/site-core/h';`,
      'shared↛modules',
    ],
  ];
  // Разрешённое: своё внутри модуля, общий код, site-crawl из «Админки»,
  // пакеты, импорт в комментарии, «Админка» → «Админка».
  const good = [
    [
      'modules/assist-site-chat/ok1.ts',
      `import { A } from './local';\nimport { B } from '../assist-site-knowledge/repo';\nimport { C } from '../../shared/assist-chat-core';\nimport { D } from '../site-core/x';\nimport { Injectable } from '@nestjs/common';`,
    ],
    [
      'modules/assist-site-chat/ok2.ts',
      `// import { X } from '../assist-admin-knowledge/repo';\n/* require('../assist-admin-chat') */\nexport const s = "../assist-admin-x";`,
    ],
    [
      'modules/assist-admin-knowledge/ok3.ts',
      `import { P } from '../site-crawl/pages';\nimport { Q } from '../assist-admin-chat/q';\nimport { R } from '../../prisma/sites-db.service';`,
    ],
    [
      'modules/assist-ui-core/ok4.ts',
      `import { S } from '../../shared/assist-chat-core';`,
    ],
    [
      'shared/ok5.ts',
      `import { createHmac } from 'crypto';\nimport { T } from './ok6';`,
    ],
    [
      'prisma/ok7.ts',
      `import { U } from '../modules/assist-admin-knowledge/u';`,
    ],
  ];

  let ok = true;
  try {
    for (const [rel, src] of good) write(rel, src);
    const clean = findViolations(dir);
    if (clean.length !== 0) {
      ok = false;
      console.error('САМОТЕСТ: разрешённые импорты сочтены нарушениями:');
      for (const v of clean)
        console.error(`  - ${v.file}: «${v.spec}» [${v.rule}]`);
    }
    for (const [rel, src] of bad) write(rel, src);
    const found = findViolations(dir);
    for (const [rel, , rule] of bad) {
      const hits = found.filter((v) => v.file === rel);
      if (hits.length !== 1 || hits[0].rule !== rule) {
        ok = false;
        console.error(
          `САМОТЕСТ: ${rel} — ожидалось одно нарушение [${rule}], найдено: ${
            hits.map((h) => h.rule).join(', ') || 'ничего'
          }`,
        );
      }
    }
    if (found.length !== bad.length) {
      ok = false;
      console.error(
        `САМОТЕСТ: нарушений ${found.length}, ожидалось ${bad.length}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!ok) {
    console.error(
      'check-sites-import-graph: самотест провален — проверке нельзя верить',
    );
    return false;
  }
  console.log(
    `ok   check-sites-import-graph: самотест — ${bad.length} нарушителей пойманы, ${good.length} чистых пропущены`,
  );
  return true;
}

function main() {
  if (process.argv.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1);
  }
  const src = path.join(ROOT, 'sites-backend', 'src');
  if (!fs.existsSync(src)) {
    console.error(
      `check-sites-import-graph: нет папки ${path.relative(ROOT, src)}`,
    );
    process.exit(1);
  }
  process.exit(report(findViolations(src), 'sites-backend/src') ? 0 : 1);
}

main();
