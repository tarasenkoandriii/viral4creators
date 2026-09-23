#!/usr/bin/env node
/**
 * Сверка чисел в документах с реальностью (ТЗ §27, этап 33).
 *
 * Проблема, ради которой это написано: в `doc/` рассыпаны конкретные
 * числа — сколько тестов, сколько миграций, сколько таблиц, сколько
 * unit-скриптов у фронтенда. Они разъезжались с кодом на этапах 25, 28 и
 * 30, каждый раз обнаруживались вручную и правились задним числом.
 * Документ, в котором числа врут, хуже документа без чисел: по нему
 * принимают решения.
 *
 * Что здесь НЕ проверяется: смысл. Скрипт не знает, правильно ли описан
 * §26 — он знает только, что число тестов в документе должно быть равно тому, сколько
 * их на самом деле.
 *
 * Считаем дёшево: количество папок миграций, `@@map` в схеме, файлы
 * спеков и `scripts/*.test.ts`. Число самих тестов берётся из отчёта
 * jest (см. ниже) — статически его честно не посчитать. Числа
 * приблизительными быть не могут: либо совпадают, либо нет.
 *
 * Запуск: `node scripts/check-docs.mjs` (и в CI, .github/workflows/ci.yml).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── Реальность ─────────────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
    } else out.push(full);
  }
  return out;
}

const specFiles = walk(path.join(ROOT, 'backend/src')).filter((f) =>
  f.endsWith('.spec.ts'),
);

/**
 * Число ТЕСТОВ статически посчитать нельзя честно: `it.each` и тесты в
 * циклах разворачиваются в рантайме, и «примерно столько» в отчёте о
 * покрытии хуже, чем ничего. Поэтому берём его из отчёта самого jest,
 * если он есть рядом (в CI бэкенд-джоба пишет его перед этой проверкой):
 *
 *   npx jest --ci --json --outputFile=jest-results.json
 *
 * Нет отчёта — проверка честно пропускается с пояснением, а не
 * притворяется, что всё сошлось. Наборы — это файлы спеков, их видно и
 * без запуска.
 */
function jestReport() {
  const file = path.join(ROOT, 'backend/jest-results.json');
  if (!fs.existsSync(file)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      tests: json.numTotalTests,
      suites: json.numTotalTestSuites,
    };
  } catch {
    return null;
  }
}

const report = jestReport();

const migrationsDir = path.join(ROOT, 'backend/prisma/migrations');
const migrationCount = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory()).length;

// Таблицы — по `@@map("...")` в схеме: именно они превращаются в таблицы
// Postgres, а `model` без map даёт другое имя.
const schema = read('backend/prisma/schema.prisma');
const tableCount = (schema.match(/@@map\("/g) ?? []).length;

const unitScriptCount = fs
  .readdirSync(path.join(ROOT, 'frontend/scripts'))
  .filter((f) => f.endsWith('.test.ts')).length;

// Этап 53 (В-6.18): число маршрутов в README — декораторы HTTP-методов в
// контроллерах и число файлов *.controller.ts.
const controllerFiles = walk(path.join(ROOT, 'backend/src')).filter((f) =>
  f.endsWith('.controller.ts'),
);
const routeCount = controllerFiles.reduce(
  (n, f) =>
    n +
    (fs.readFileSync(f, 'utf8').match(/^\s*@(Get|Post|Patch|Put|Delete)\(/gm) ?? [])
      .length,
  0,
);

const actual = {
  tests: report?.tests ?? null,
  suites: report?.suites ?? specFiles.length,
  migrations: migrationCount,
  tables: tableCount,
  unitScripts: unitScriptCount,
  routes: routeCount,
  controllers: controllerFiles.length,
};

// ── Что документы утверждают ───────────────────────────────────────────
//
// Каждая проверка — это «в файле X есть строка, где рядом стоят число и
// слово». Ищем ровно те формулировки, которые в документах и написаны;
// если фразу переписали, проверка честно упадёт и заставит обновить и
// её тоже — это дешевле, чем регулярка, которая молча ничего не находит.

const CHECKS = [
  {
    file: 'doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md',
    label: 'тесты (итоговая сверка)',
    // Только в разделе «Итоговая сверка»: выше по файлу те же формулировки
    // стоят в блоках прошлых этапов и должны остаться историей.
    section: '## Итоговая сверка',
    re: /\*\*(\d+) тест(?:а|ов)? \/ (\d+) набор(?:а|ов)?\*\*/,
    expect: [actual.tests, actual.suites],
    needsJest: true,
  },
  {
    file: 'doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md',
    label: 'миграции и таблицы (итоговая сверка)',
    section: '## Итоговая сверка',
    re: /все \*\*(\d+)\*\* миграци[ийя]+ подряд на чистом Postgres 16\s*\n?\s*\(\*\*(\d+)\*\* таблиц/,
    expect: [actual.migrations, actual.tables],
  },
  {
    file: 'doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md',
    label: 'unit-скрипты фронтенда',
    section: '## Итоговая сверка',
    re: /\*\*(\d+)\*\*\s*\n?\s*unit-скрипт(?:ов|а)?/,
    expect: [actual.unitScripts],
  },
  {
    file: 'doc/ACCEPTANCE-CHECKLIST.md',
    label: 'тесты (шапка чеклиста)',
    re: /backend — (\d+)\s*\n?jest-тест(?:а|ов)? \/ (\d+) набор(?:а|ов)?/,
    expect: [actual.tests, actual.suites],
    // Найдено попутно на этапе 57: у этой проверки, в отличие от точно
    // такой же по смыслу пары в README.md и doc/CI.md чуть ниже, не было
    // `needsJest` — без backend/jest-results.json она не пропускалась, а
    // молча ПАДАЛА (actual.tests===null никогда не равно числу в
    // документе), то есть в песочнице (где Prisma-клиент не генерируется
    // и полный прогон jest недостоверен) `check-docs.mjs` был обречён
    // красным по этому единственному пункту при любом честном числе тестов
    // в документе.
    needsJest: true,
  },
  {
    file: 'doc/ACCEPTANCE-CHECKLIST.md',
    label: 'миграции и таблицы (шапка чеклиста)',
    re: /все (\d+)\s*\n?миграци[ий] применяются подряд к чистому Postgres 16 \((\d+) таблиц/,
    expect: [actual.migrations, actual.tables],
  },
  {
    file: 'doc/ACCEPTANCE-CHECKLIST.md',
    label: 'unit-скрипты (шапка чеклиста)',
    re: /(\d+) unit-скрипт(?:ов|а)?/,
    expect: [actual.unitScripts],
  },
  // README и CI.md добавлены на этапе 43 (Б-5.1): оба годами держали
  // «442 tests» и «11 unit scripts» — числа этапа 33. Они не проверялись
  // ровно потому, что этого списка не касались, а не потому, что там
  // чисел нет.
  {
    file: 'README.md',
    label: 'тесты (README)',
    re: /types, lint, (\d+)\s*\ntests/,
    expect: [actual.tests],
    needsJest: true,
  },
  // Этап 49 (В-6.7): CI.md был в списке, но проверялся только числом
  // unit-скриптов — и держал «919 тестов, 20 миграций» при зелёном прогоне.
  {
    file: 'doc/CI.md',
    label: 'тесты (шапка CI.md)',
    re: /тогда 442 теста \(сейчас (\d+)\)/,
    expect: [actual.tests],
    needsJest: true,
  },
  {
    file: 'doc/CI.md',
    label: 'миграции (шапка CI.md)',
    re: /написанных вручную \(сейчас (\d+)\)/,
    expect: [actual.migrations],
  },
  {
    file: 'README.md',
    label: 'маршруты и контроллеры (README)',
    re: /\((\d+) routes in (\d+) controller files/,
    expect: [actual.routes, actual.controllers],
  },
  {
    file: 'README.md',
    label: 'unit-скрипты (README)',
    re: /frontend \(types, lint, (\d+) unit\s*\nscripts/,
    expect: [actual.unitScripts],
  },
  {
    file: 'doc/CI.md',
    label: 'unit-скрипты (таблица джоб)',
    re: /(\d+) unit-скрипт(?:ов|а)? `npx tsx/,
    expect: [actual.unitScripts],
  },
  // Пятый аудит, Д-6.2: doc/TELEGRAM-ADMIN.md называл конкретное число
  // миграций «на этапе N», отставшее на 10-15 этапов, и не проверялся
  // этим скриптом вовсе — тот же повторяющийся класс, что третий раунд
  // предсказывал (В-6.17). Текст переписан без привязки к номеру этапа
  // (см. сам файл) — эти две проверки закрывают не только сегодняшнее
  // число, но и сам класс дефекта.
  {
    file: 'doc/TELEGRAM-ADMIN.md',
    label: 'миграции (ограничение песочницы, абзац про ручное написание)',
    re: /\(сейчас (\d+) миграци[ийя]+, актуальное\s*\n?\s*число/,
    expect: [actual.migrations],
  },
  {
    file: 'doc/TELEGRAM-ADMIN.md',
    label: 'миграции (ограничение песочницы, абзац про применение к Postgres)',
    re: /все\s*\n?\s*миграции \(сейчас (\d+)\) были по-настоящему применены/,
    expect: [actual.migrations],
  },
];

// ── Прогон ─────────────────────────────────────────────────────────────

let failed = 0;
console.log('Реальность:', JSON.stringify(actual));

for (const check of CHECKS) {
  if (check.needsJest && report === null) {
    console.log(
      `skip ${check.file} — ${check.label}: нет backend/jest-results.json; ` +
        `запустите тесты с --json --outputFile=jest-results.json, чтобы проверить и это число`,
    );
    continue;
  }
  let content = read(check.file);
  if (check.section) {
    const at = content.indexOf(check.section);
    if (at === -1) {
      failed++;
      console.log(`FAIL ${check.file}: раздел «${check.section}» не найден`);
      continue;
    }
    content = content.slice(at);
  }
  const m = content.match(check.re);
  if (!m) {
    failed++;
    console.log(
      `FAIL ${check.file} — ${check.label}: формулировку не нашли. ` +
        `Либо её переписали (тогда поправьте регулярку в scripts/check-docs.mjs), ` +
        `либо число из документа пропало.`,
    );
    continue;
  }
  const got = m.slice(1).map(Number);
  const ok =
    got.length === check.expect.length &&
    got.every((v, i) => v === check.expect[i]);
  if (!ok) {
    failed++;
    console.log(
      `FAIL ${check.file} — ${check.label}: в документе ${got.join(' / ')}, ` +
        `на самом деле ${check.expect.join(' / ')}`,
    );
  } else {
    console.log(`ok   ${check.file} — ${check.label}: ${got.join(' / ')}`);
  }
}

// ── Переменные окружения: код против документов (этап 53, В-6.17) ────
//
// Самый повторяющийся вид дефекта за три аудита — «переменная есть в коде,
// нет в документе» (Б-5.4–Б-5.6, В-6.6, В-6.14). Он полностью механический:
// список `process.env.*` и `import.meta.env.*` из кода против
// `doc/DEPLOYMENT.md` и `.env.docker.example`. Переменная считается
// описанной, если названа в любом из двух; служебные (NODE_ENV, PORT и
// т. п.) и динамические префиксы (`AI_PRICE_*`, `DAILY_SPEND_LIMIT_USD_*`)
// проверяются по префиксу.

const ENV_SKIP = new Set(['NODE_ENV', 'CI', 'VERCEL', 'VERCEL_ENV', 'TZ']);
const ENV_PREFIX_OK = ['AI_PRICE_', 'DAILY_SPEND_LIMIT_USD_'];

function envVarsInCode() {
  const files = [
    ...walk(path.join(ROOT, 'backend/src')),
    ...walk(path.join(ROOT, 'admin/src')),
    ...walk(path.join(ROOT, 'landing/src')),
    ...walk(path.join(ROOT, 'frontend/src')),
  ].filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.spec.ts'));
  const found = new Set();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]+)/g)) {
      found.add(m[1]);
    }
    // `env.X` в модулях, которые получают process.env параметром
    // (env-settings.ts, spend-limits.ts, csrf.ts, blob-url.ts).
    if (/\benv: NodeJS\.ProcessEnv|\(env\)|env = process\.env/.test(text)) {
      for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]{3,})\b/g)) found.add(m[1]);
    }
  }
  return [...found].filter((v) => !ENV_SKIP.has(v)).sort();
}

const envDocs = read('doc/DEPLOYMENT.md') + '\n' + read('.env.docker.example');
const undocumented = envVarsInCode().filter(
  (v) =>
    !ENV_PREFIX_OK.some((p) => v.startsWith(p)) &&
    !new RegExp(`(^|[^A-Z0-9_])${v}([^A-Z0-9_]|$)`).test(envDocs),
);
if (undocumented.length > 0) {
  failed++;
  console.log(
    `FAIL переменные окружения: код читает, документы молчат — ${undocumented.join(', ')}. ` +
      `Опишите в doc/DEPLOYMENT.md (прод) или .env.docker.example (стенд).`,
  );
} else {
  console.log(`ok   переменные окружения: все ${envVarsInCode().length} описаны в DEPLOYMENT.md или .env.docker.example`);
}

// ── Симметрия локалей `landing/src/dictionaries/*.json` (аудит трёх
// последних ТЗ, doc/LANDING-HOW-IT-WORKS-VISUAL-SPEC.md §8 — «дёшево и
// предотвращает будущий молчаливый разъезд локалей») ────────────────────
//
// JSON-модули типизируют строковые значения как `string`, а не литералы —
// `tsc`/`next build` НЕ ловят перекос набора необязательных полей
// (`badge`/`highlight`) между локалями (проверено эмпирически при
// подготовке этой проверки: `tsc --noEmit` проходит даже когда одна
// локаль по ошибке несёт `badge` не на том шаге). Раз тип-система не
// страхует — страхует этот скрипт: ровно 10 элементов в `steps.items` у
// каждой локали (этап 92 добавил десятый шаг — раздел «Постпродакшн»,
// TMA-навигация выросла с 3 до 4 вкладок), одинаковый набор ключей на
// каждой позиции (сверка с `ru.json` как эталоном) и каждое
// `badge`-значение — один из ключей `steps.badges`.

const DICT_LOCALES = ['ru', 'uk', 'en', 'de', 'es'];

function loadDict(locale) {
  return JSON.parse(read(`landing/src/dictionaries/${locale}.json`));
}

function checkStepsSymmetry() {
  const dicts = Object.fromEntries(DICT_LOCALES.map((l) => [l, loadDict(l)]));
  const reference = dicts.ru.steps.items;
  const badgeKeys = new Set(Object.keys(dicts.ru.steps.badges));
  const problems = [];

  if (reference.length !== 10) {
    problems.push(`ru.json: steps.items содержит ${reference.length}, а не 10 элементов`);
  }

  for (const locale of DICT_LOCALES) {
    const items = dicts[locale].steps.items;
    if (items.length !== reference.length) {
      problems.push(`${locale}.json: steps.items содержит ${items.length}, а не ${reference.length} (как ru.json)`);
      continue;
    }
    items.forEach((item, i) => {
      const gotKeys = Object.keys(item).sort().join(',');
      const wantKeys = Object.keys(reference[i]).sort().join(',');
      if (gotKeys !== wantKeys) {
        problems.push(
          `${locale}.json: steps.items[${i}] (шаг ${i + 1}) — набор полей «${gotKeys}», ` +
            `а в ru.json «${wantKeys}»`,
        );
      }
      if (item.badge !== undefined && !badgeKeys.has(item.badge)) {
        problems.push(
          `${locale}.json: steps.items[${i}] (шаг ${i + 1}) — badge «${item.badge}» ` +
            `не входит в steps.badges (${[...badgeKeys].join('/')})`,
        );
      }
    });
  }

  if (problems.length > 0) {
    failed++;
    console.log(`FAIL симметрия steps.items по локалям (landing/src/dictionaries):`);
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log(`ok   симметрия steps.items по локалям: 10 шагов × 5 локалей, поля и бейджи совпадают`);
  }
}

checkStepsSymmetry();

// ── Швы советника в мастере («Тонкая красная линия», аудит волн A–C) ──
//
// Три места, где переименование НЕ ломает ни типы, ни линт, ни тесты, а
// ломает продукт молча, потому что стороны шва живут в разных приложениях
// и не видят друг друга:
//
//  1. Идентификаторы шагов. Их рисует степпер мини-аппа и по ним же
//     советник выбирает карточку знаний, проверяет кнопки `goto-step` и
//     складывает частоты. Переименовали на одной стороне — подсказки на
//     этом шаге молча исчезли, кнопки перестали рисоваться, а телеметрия
//     разъехалась на два шага, которые выглядят как один.
//  2. Ключи пунктов готовности. Сервер отдаёт `key`, подпись даёт
//     словарь мини-аппа: разошлись — человек видит машинный ключ вместо
//     подписи.
//  3. Слаги документов для кнопки «открыть документ». Сервер разрешает
//     их по списку файлов `doc/legal/*.md`, клиент рисует по своему
//     отображению: появился третий документ — сервер его пропустит, а
//     кнопка молча не нарисуется.

function idsFrom(source, pattern) {
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

function checkGuideSeams() {
  const problems = [];

  // 1. Шаги обучалки: степпер (frontend) ↔ карточки советника (backend).
  const stepperIds = idsFrom(
    read('frontend/src/lib/client-site-steps.ts'),
    /CLIENT_SITE_STEP_IDS = \[([^\]]+)\]/g,
  )[0];
  const stepper = stepperIds
    ? [...stepperIds.matchAll(/'([a-zA-Z0-9_-]+)'/g)].map((m) => m[1])
    : [];
  const cards = idsFrom(
    read('backend/src/modules/wizard-guide/hint-scenarios.ts'),
    /stepId: '([a-zA-Z0-9_-]+)'/g,
  );
  if (stepper.length === 0) {
    problems.push('не нашли CLIENT_SITE_STEP_IDS во frontend/src/lib/client-site-steps.ts');
  } else if (stepper.join(',') !== cards.join(',')) {
    problems.push(
      `шаги обучалки разошлись: степпер «${stepper.join(', ')}», ` +
        `карточки советника «${cards.join(', ')}»`,
    );
  }

  // 2. Пункты готовности: сервер отдаёт key, словарь даёт подпись.
  const readinessKeys = idsFrom(
    read('backend/src/common/wizard-readiness.ts'),
    /key: '([a-zA-Z0-9_-]+)'/g,
  );
  const dictItems = Object.keys(
    JSON.parse(read('frontend/src/dictionaries/ru.json')).wizardReadiness.items,
  );
  const missingLabels = readinessKeys.filter((k) => !dictItems.includes(k));
  const orphanLabels = dictItems.filter((k) => !readinessKeys.includes(k));
  if (missingLabels.length > 0) {
    problems.push(
      `у пунктов готовности нет подписи в словаре: ${missingLabels.join(', ')}`,
    );
  }
  if (orphanLabels.length > 0) {
    problems.push(
      `в словаре есть подписи для несуществующих пунктов готовности: ${orphanLabels.join(', ')}`,
    );
  }

  // 3. Слаги документов: белый список сервера ↔ отображение клиента.
  const serverSlugs = idsFrom(
    read('backend/src/modules/wizard-guide/hint-actions.ts'),
    /HINT_DOC_SLUGS: readonly string\[\] = \[([^\]]+)\]/g,
  )[0];
  const server = serverSlugs
    ? [...serverSlugs.matchAll(/'([a-zA-Z0-9_-]+)'/g)].map((m) => m[1])
    : [];
  const clientBlock = /DOC_KEYS: Record<string, [^>]+> = \{([^}]+)\}/.exec(
    read('frontend/src/components/HintLine.tsx'),
  );
  const client = clientBlock
    ? [...clientBlock[1].matchAll(/'?([a-zA-Z0-9_-]+)'?\s*:/g)].map((m) => m[1])
    : [];
  if (server.length === 0 || client.length === 0) {
    problems.push('не нашли белый список слагов документов на одной из сторон');
  } else if ([...server].sort().join(',') !== [...client].sort().join(',')) {
    problems.push(
      `слаги документов разошлись: сервер «${server.join(', ')}», ` +
        `клиент «${client.join(', ')}»`,
    );
  }

  if (problems.length > 0) {
    failed++;
    console.log('FAIL швы советника в мастере:');
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log(
      `ok   швы советника: шаги (${stepper.join('/')}), пункты готовности ` +
        `(${readinessKeys.length}) и слаги документов (${server.length}) сходятся`,
    );
  }
}

checkGuideSeams();

if (failed) {
  console.error(
    `\n${failed} расхождени(е/я) между документами и кодом. ` +
      `Поправьте числа в документах — они там не для красоты, по ним принимают решения.`,
  );
  process.exit(1);
}
console.log('\ncheck-docs: числа в документах совпадают с реальностью');
