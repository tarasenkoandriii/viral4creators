#!/usr/bin/env node
/**
 * Чистая логика раздела «Reddit» кабинета assist → admin/src/lib/reddit-shared/**
 * («копия с проверкой», как scripts/sync-sites-shared.mjs; пакет P-R-ADM,
 * Р-RD-ADM: вкладка «Reddit» Админки работает с теми же данными, что
 * кабинет, и НЕ переписывает его логику).
 *
 * Что копируется: декодеры ответов (`reddit-api`, `reddit-studio-api`,
 * `content-api` …), чистые функции экранов (`reddit-view`,
 * `reddit-studio-view`: нормализация, «только изменённые поля», CAS-
 * перебазирование, предпросмотр markdown, WARN-подтверждения, ошибки
 * словами), словари `publisher-*` и из кита — только конверт ошибки
 * (`envelope`), копирование в буфер (`clipboard`) и тип языка (`i18n` +
 * словари кита, ради `Locale`).
 * Клиент кита (`api-client`, `telegram`), React-хуки и экраны — нет:
 * Админка ходит своим fetch-слоем через backend (`/admin/reddit/*`).
 *
 * Почему копия: admin/ — отдельный Vercel-проект (root = admin/), файлы
 * вне него сборке не видны, а у assist другой React. Копии КОММИТЯТСЯ,
 * расхождение ловит `--check` (CI: джоба next-apps для admin и
 * `make ci-admin`). Править — только источник, затем запуск без флага.
 *
 *   node scripts/sync-admin-reddit-shared.mjs          # записать копии
 *   node scripts/sync-admin-reddit-shared.mjs --check  # только сверить (CI)
 *
 * Копия обязана быть самодостаточной: относительный импорт источника,
 * разрешённый от места КОПИИ, должен попадать в другую копию, а внешних
 * пакетов (react, @/…) нет вовсе — скрипт проверяет это сам.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = 'admin/src/lib/reddit-shared';

const PUB = 'assist/src/lib/publisher';
const I18N = 'assist/src/i18n';
const KIT = 'site-tma-kit/src';

/**
 * Источник → копия (`to` — от SHARED, структура assist сохранена, чтобы
 * относительные импорты работали без переписывания). Экспортируется: по
 * нему scripts/ci-changes.mjs запускает джобу admin на правку источника.
 */
export const ENTRIES = [
  // Кит: ApiError конверта и тип `Locale` (i18n тянет словари кита).
  { from: `${KIT}/envelope.ts`, to: 'kit/envelope.ts' },
  { from: `${KIT}/i18n.ts`, to: 'kit/i18n.ts' },
  { from: `${KIT}/brand.ts`, to: 'kit/brand.ts' },
  { from: `${KIT}/dictionaries/ru.ts`, to: 'kit/dictionaries/ru.ts' },
  { from: `${KIT}/dictionaries/uk.ts`, to: 'kit/dictionaries/uk.ts' },
  { from: `${KIT}/dictionaries/en.ts`, to: 'kit/dictionaries/en.ts' },
  // «Копировать утверждённый текст»: Clipboard API и запасной путь.
  { from: `${KIT}/clipboard.ts`, to: 'kit/clipboard.ts' },
  // Словари: Админка — только ru, но `reddit-view` выбирает словарь по
  // языку и импортирует все три.
  { from: `${I18N}/publisher-ru.ts`, to: 'i18n/publisher-ru.ts' },
  { from: `${I18N}/publisher-content-ru.ts`, to: 'i18n/publisher-content-ru.ts' },
  { from: `${I18N}/publisher-reddit-ru.ts`, to: 'i18n/publisher-reddit-ru.ts' },
  { from: `${I18N}/publisher-reddit-uk.ts`, to: 'i18n/publisher-reddit-uk.ts' },
  { from: `${I18N}/publisher-reddit-en.ts`, to: 'i18n/publisher-reddit-en.ts' },
  // Чистые модули Publisher (без React и клиента кита).
  ...[
    'common-pure',
    'decode',
    'ops-decode',
    'states',
    'permissions',
    'view',
    'errors',
    'core-api',
    'ai-api',
    'calendar-api',
    // Снятие отметки о публикации (`publicationTransitionBody`).
    'channels-view',
    // Факты бренда и ручные источники (значение факта, тело источника).
    'brand-view',
    'content-api',
    'reddit-api',
    'reddit-studio-api',
    'reddit-view',
    'reddit-studio-view',
  ].map((m) => ({ from: `${PUB}/${m}.ts`, to: `lib/publisher/${m}.ts` })),
];

const CHECK = process.argv.includes('--check');

const posix = (p) => p.split(path.sep).join('/');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function header(from) {
  return [
    '// СГЕНЕРИРОВАНО scripts/sync-admin-reddit-shared.mjs — не править.',
    `// Источник: ${from}. Правка — в источнике, затем`,
    '// `node scripts/sync-admin-reddit-shared.mjs`; CI сверяет копию флагом --check.',
    '',
    '',
  ].join('\n');
}

/** Все спецификаторы import/export … from и динамических import(). */
function importSpecifiers(source) {
  const specs = [];
  const re =
    /(?:^|[^\w$.])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w$.])import\s*['"]([^'"]+)['"]|(?:^|[^\w$.])(?:require|import)\(\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(re)) specs.push(m[1] ?? m[2] ?? m[3]);
  return specs;
}

function purityProblems() {
  const problems = [];
  const targets = new Set(ENTRIES.map((e) => e.to));
  const seen = new Set();
  for (const { from, to } of ENTRIES) {
    if (seen.has(to)) problems.push(`две записи пишут в ${to}`);
    seen.add(to);
    const abs = path.join(ROOT, from);
    if (!fs.existsSync(abs)) {
      problems.push(`нет файла-источника ${from}`);
      continue;
    }
    const src = fs.readFileSync(abs, 'utf8');
    for (const spec of importSpecifiers(src)) {
      if (!spec.startsWith('.')) {
        problems.push(`${from}: внешний импорт «${spec}» — модуль не чистый для Админки`);
        continue;
      }
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(to), spec));
      if (![`${base}.ts`, `${base}/index.ts`, base].some((c) => targets.has(c))) {
        problems.push(
          `${from}: импорт «${spec}» ведёт за пределы копируемого набора — ` +
            'добавьте его в ENTRIES (если он чистый) или вынесите чистую часть',
        );
      }
    }
  }
  return problems;
}

function main() {
  const problems = purityProblems();
  if (problems.length) {
    console.error('sync-admin-reddit-shared: копия не была бы самодостаточной:');
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
    ? walk(sharedAbs).map((f) => posix(path.relative(ROOT, f)))
    : [];
  // Всё в reddit-shared/ принадлежит скрипту: лишний файл — копия, у
  // которой убрали запись, и она молча разошлась бы с источником.
  const extra = present.filter((f) => !expected.has(f));
  const stale = [...expected].filter(([file, content]) => {
    const abs = path.join(ROOT, file);
    return !fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== content;
  });

  if (CHECK) {
    if (stale.length || extra.length) {
      console.error('sync-admin-reddit-shared: копии в admin/ разошлись с источниками:');
      for (const [f] of stale) console.error(`  - устарела: ${f}`);
      for (const f of extra) console.error(`  - лишняя: ${f}`);
      console.error('Запустите `node scripts/sync-admin-reddit-shared.mjs` и закоммитьте копии.');
      process.exit(1);
    }
    console.log(`ok   sync-admin-reddit-shared: ${expected.size} копий совпадают с источниками`);
    return;
  }

  for (const [file, content] of stale) {
    const abs = path.join(ROOT, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    console.log(`записан ${file}`);
  }
  for (const f of extra) {
    fs.rmSync(path.join(ROOT, f));
    console.log(`удалён ${f} (нет в ENTRIES)`);
  }
  console.log(`sync-admin-reddit-shared: ${expected.size} копий актуальны`);
}

// CLI — только при прямом запуске: `import { ENTRIES }` из ci-changes.mjs
// не должен ни писать копии, ни сверять их.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
