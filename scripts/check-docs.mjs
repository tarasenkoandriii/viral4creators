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
    // `ю` в окончании — для чисел, кончающихся на единицу: «все 101
    // миграцию». Без неё проверка молча перестаёт находить формулировку
    // ровно на каждой сто первой миграции.
    re: /все \*\*(\d+)\*\* миграци[ийяю]+ подряд на чистом Postgres 16\s*\n?\s*\(\*\*(\d+)\*\* таблиц/,
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

  // 1. Шаги мастеров: степпер (frontend) ↔ карточки советника (backend).
  //    По одному сравнению на сценарий — общий список ловил бы
  //    расхождение только случайно.
  const cardsSource = read('backend/src/modules/wizard-guide/hint-scenarios.ts');
  const SCENARIOS = [
    {
      scenario: 'CLIENT_SITE',
      file: 'frontend/src/lib/client-site-steps.ts',
      constant: 'CLIENT_SITE_STEP_IDS',
    },
    {
      scenario: 'GREETING_VIDEO',
      file: 'frontend/src/lib/greeting-steps.ts',
      constant: 'GREETING_STEP_IDS',
    },
    {
      scenario: 'PRODUCT_VIDEO',
      file: 'frontend/src/lib/session-step.ts',
      constant: 'STEPPER_IDS',
    },
  ];
  let stepperSummary = [];
  for (const { scenario, file, constant } of SCENARIOS) {
    const block = new RegExp(
      `const ${scenario}: ScenarioHints = \\{([\\s\\S]*?)\\n\\};`,
    ).exec(cardsSource);
    const cards = block
      ? [...block[1].matchAll(/stepId: '([a-zA-Z0-9_-]+)'/g)].map((m) => m[1])
      : [];
    const listMatch = new RegExp(
      `${constant}(?::[^=]*)? = \\[([^\\]]+)\\]`,
    ).exec(read(file));
    const stepper = listMatch
      ? [...listMatch[1].matchAll(/'([a-zA-Z0-9_-]+)'/g)].map((m) => m[1])
      : [];
    if (stepper.length === 0) {
      problems.push(`не нашли ${constant} в ${file}`);
      continue;
    }
    if (cards.length === 0) {
      problems.push(`не нашли карточки сценария ${scenario} в hint-scenarios.ts`);
      continue;
    }
    if (stepper.join(',') !== cards.join(',')) {
      problems.push(
        `шаги ${scenario} разошлись: степпер «${stepper.join(', ')}», ` +
          `карточки советника «${cards.join(', ')}»`,
      );
    }
    stepperSummary.push(`${scenario}: ${stepper.length}`);
  }

  // 2. Пункты готовности: сервер отдаёт key, словарь даёт подпись.
  const readinessKeys = idsFrom(
    read('backend/src/common/wizard-readiness.ts'),
    /key: '([a-zA-Z0-9_-]+)'/g,
  );
  const dictItems = Object.keys(
    JSON.parse(read('frontend/src/dictionaries/ru.json')).wizardReadiness.items,
  );
  // Подписи-ЗАМЕНЫ: один и тот же пункт бывает закрыт разной работой, и
  // у второй работы своя подпись. Пункт «откуда берётся сцена» (`key:
  // 'analysis'`) закрывает либо разбор референса, либо выбранный приём
  // (этап 149), и общая подпись про разбор с галочкой рапортовала бы о
  // работе, которой не было. Список закрытый и живёт здесь, а не
  // послаблением правила: подпись без пункта и подпись-замена —
  // разные вещи, и первая по-прежнему ошибка.
  const OVERRIDE_LABELS = new Set(['sceneTemplate']);
  const missingLabels = readinessKeys.filter((k) => !dictItems.includes(k));
  const orphanLabels = dictItems.filter(
    (k) => !readinessKeys.includes(k) && !OVERRIDE_LABELS.has(k),
  );
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

  // 4. Восстановление шага в greeting: сводка сессий не несёт ни
  // сценария, ни ролика, поэтому мастер обязан дочитать сессию целиком.
  //
  // Проверка текстовая, и это осознанно: настоящий тест здесь был бы
  // тестом React-компонента, а харнеса для них в проекте нет.
  // Правила шагов проверены в `greeting-steps.test.ts` полностью — но
  // ПРОВОДКУ (кто и откуда берёт факты) не проверяет ничто, а именно
  // она была блокером этапа 12: степпер врал после перезагрузки
  // вкладки, потому что `load()` знал только `sessionId`.
  const greetingWizard = read('frontend/src/features/projects/GreetingVideoWizard.tsx');
  //
  // Оговорка про сводку — не украшение: если `ItemSessionSummary`
  // когда-нибудь начнёт нести сценарий и ролик, дочитывать сессию
  // станет незачем, и проверка обязана это понять сама, а не держать
  // мастер в заложниках. Поэтому оговорка ищется в ТОМ файле, где тип
  // лежит, и её отсутствие — само по себе расхождение: молча
  // «не нашли» значило бы проверять не то, что написано.
  const summaryFields = /interface ItemSessionSummary \{([\s\S]*?)\n\}/.exec(
    read('frontend/src/services/projects-api.ts'),
  );
  if (!summaryFields) {
    problems.push(
      'не нашли `ItemSessionSummary` в projects-api.ts — проверка ' +
        'восстановления шага greeting опирается на состав этого типа',
    );
  }
  const summaryHasPrompt = summaryFields
    ? /generationPrompt|generatedVideo/.test(summaryFields[1])
    : false;
  const greetingRestore = summaryHasPrompt
    ? 'сводка несёт сценарий'
    : 'greeting дочитывает сессию';
  if (summaryFields && !summaryHasPrompt && !/getSession\(/.test(greetingWizard)) {
    problems.push(
      'GreetingVideoWizard не дочитывает сессию (`getSession`), а сводка ' +
        'сессий не несёт ни сценария, ни ролика — степпер снова покажет ' +
        'первый шаг после перезагрузки вкладки (блокер этапа 12)',
    );
  }

  // 5. Стартов рендера три, и у каждого обязана стоять проверка права
  // (этап 132). Шов, а не внимательность: партия по каталогу уже
  // однажды ускользнула от денежной проверки — она идёт в xAI напрямую,
  // минуя `GenerationService.generateVideo()`, и проверку бюджета туда
  // пришлось дописывать отдельно. Второй раз полагаться на то, что
  // новый путь рендера кто-то заметит, незачем.
  const RENDER_STARTS = [
    'backend/src/modules/generation/generation.service.ts',
    'backend/src/modules/greeting-video/greeting-video.service.ts',
    'backend/src/modules/catalog-batch/catalog-batch-worker.service.ts',
  ];
  // Кто зовёт провайдера видео напрямую. Спека `grok-video-batch` и
  // `grok-video` — сами клиенты, их этот список не касается.
  const PROVIDER_CALLS =
    /\b(generateVideos|grokVideo\.startGeneration|grokBatch\.submitBatch|hedra\.submit)\s*\(/;
  const startsWithoutCheck = RENDER_STARTS.filter(
    (f) => !/assertCanRender\s*\(/.test(read(f)),
  );
  if (startsWithoutCheck.length > 0) {
    problems.push(
      `старт рендера без проверки права (assertCanRender): ${startsWithoutCheck.join(', ')}`,
    );
  }
  // Кто зовёт провайдера видео, но стены не требует. Список именной и
  // с причинами — молчаливое исключение по маске рано или поздно
  // накроет настоящий новый старт рендера.
  const RENDER_STARTS_EXEMPT = {
    // Операторские пути: рендер запускает человек из админки, за свои
    // деньги продукта и по своему решению. Стена — про бесплатный тариф
    // пользователя, к оператору она отношения не имеет.
    'backend/src/modules/actors/actors.service.ts':
      'ручной запуск пилота аватара из админки (AdminSessionGuard)',
    'backend/src/modules/virtual-studio/virtual-studio.service.ts':
      'админ-студия, @Controller("admin/virtual-studio")',
    // Тот же батч-клиент Grok, но перевод ТЕКСТА, а не видео.
    'backend/src/modules/blog/blog-translation.service.ts':
      'перевод блога, видео не рендерится',
    // Сами клиенты провайдеров — они и есть вызов, а не его инициатор.
    'backend/src/modules/generation/grok-video.service.ts': 'клиент провайдера',
    'backend/src/modules/generation/grok-video-batch.service.ts':
      'клиент провайдера',
    'backend/src/modules/actors/hedra-client.service.ts': 'клиент провайдера',
  };
  const unknownStarts = [...walk(path.join(ROOT, 'backend/src/modules'))]
    .filter((f) => /\.ts$/.test(f) && !f.endsWith('.spec.ts'))
    .map((f) => ({ f, rel: path.relative(ROOT, f).split(path.sep).join('/') }))
    .filter(({ f, rel }) => {
      if (RENDER_STARTS.includes(rel)) return false;
      if (rel in RENDER_STARTS_EXEMPT) return false;
      const text = fs.readFileSync(f, 'utf8');
      return PROVIDER_CALLS.test(text) && !/assertCanRender\s*\(/.test(text);
    })
    .map(({ rel }) => rel);
  if (unknownStarts.length > 0) {
    problems.push(
      `новый старт рендера мимо проверки права: ${unknownStarts.join(', ')} — ` +
        `позовите RenderAccessService.assertCanRender либо внесите в ` +
        `RENDER_STARTS_EXEMPT с причиной`,
    );
  }

  // 6. Завершение рендера — одно место, и оно ровно одно (этап 134).
  // Шов заведён по свежему следу: `markConverted` публичной страницы
  // уже однажды разъехался — он стоял в двух завершениях из четырёх, и
  // ролики, сделанные из поздравления, молча не считались конверсией
  // шеринга. Теперь и она, и засчёт приглашения висят на
  // `RenderCompletedService`, а этот шов сторожит, чтобы их снова не
  // начали звать напрямую из нового места.
  const COMPLETION_HUB =
    'backend/src/modules/render-access/render-completed.service.ts';
  const COMPLETION_CALLS = /\.(markConverted|countFirstGeneration)\s*\(/;
  const directCompletionCalls = [...walk(path.join(ROOT, 'backend/src'))]
    .filter((f) => /\.ts$/.test(f) && !f.endsWith('.spec.ts'))
    .map((f) => ({ f, rel: path.relative(ROOT, f).split(path.sep).join('/') }))
    .filter(({ f, rel }) => {
      if (rel === COMPLETION_HUB) return false;
      // Сами объявления методов (`async markConverted(...)`) — не вызовы.
      const text = fs
        .readFileSync(f, 'utf8')
        .replace(/^\s*(?:async\s+)?(markConverted|countFirstGeneration)\s*\(/gm, '');
      return COMPLETION_CALLS.test(text);
    })
    .map(({ rel }) => rel);
  if (directCompletionCalls.length > 0) {
    problems.push(
      `завершение рендера в обход единой точки: ${directCompletionCalls.join(', ')} — ` +
        `позовите RenderCompletedService.onRenderCompleted`,
    );
  }
  // И обратная сторона: точек завершения должно быть ровно столько,
  // сколько их у продукта. Стало меньше — кто-то отключил завершение и
  // не заметил; стало больше — появился новый путь, и его надо внести
  // сюда осознанно, а не обнаружить по недосчитанным приглашениям.
  const COMPLETION_POINTS = [
    'backend/src/modules/generation/generation.service.ts',
    'backend/src/modules/greeting-video/greeting-video.service.ts',
  ];
  const completionCallCount = COMPLETION_POINTS.reduce(
    (n, f) => n + (read(f).match(/onRenderCompleted\s*\(/g) ?? []).length,
    0,
  );
  if (completionCallCount !== 4) {
    problems.push(
      `завершений рендера ${completionCallCount}, а их четыре ` +
        `(две ветки товарки и две поздравления) — ` +
        `см. RenderCompletedService`,
    );
  }

  // 7. Привязка приглашения зовётся из ДВУХ мест (этап 134, аудит).
  // У продукта два живых варианта, и личность в них появляется в разные
  // моменты: в мини-аппе — с первого кадра, в браузере — только у
  // кнопки «Сгенерировать». Одна попытка (при запуске) в браузере
  // всегда опаздывала: первый ролик человека успевал завершиться
  // раньше, чем привязка происходила, а засчитывает приглашение именно
  // завершение. Потерять это повторно нельзя — тише всего оно ломается
  // именно у пришедших с лендинга.
  const CLAIM_CALLERS = [
    'frontend/src/App.tsx',
    'frontend/src/components/TelegramLoginButton.tsx',
  ];
  const withoutClaim = CLAIM_CALLERS.filter(
    (f) => !/claimStoredReferral\s*\(/.test(read(f)),
  );
  if (withoutClaim.length > 0) {
    problems.push(
      `привязка приглашения не зовётся из ${withoutClaim.join(', ')} — ` +
        `в браузере личность появляется позже запуска, и одной попытки мало`,
    );
  }

  // 8. Расширяющий каст в аргументе Prisma (найдено деплоем этапа 134).
  //
  // Песочница НЕ МОЖЕТ поймать этот класс ошибок: `prisma generate`
  // недоступен по сети, и типы клиента подменены заглушкой `any` (см.
  // test/types/prisma-any). Значит всё, что уезжает в Prisma, здесь не
  // проверяется вовсе, а на Vercel проверяется по-настоящему — и там
  // `FREE_GRANT_REASONS as string[]` в фильтре `in` уронил сборку уже
  // ПОСЛЕ применения миграций.
  //
  // Ловим ровно одну форму, и намеренно узко: каст константы-кортежа к
  // массиву примитивов. Он всегда неверен — расширяет строковые
  // литералы до `string`, а колонка перечисления его не принимает, — и
  // во всём backend/src не встречается больше нигде. Одиночное
  // `x as string` (снять `| null` у обычной колонки) при этом законно и
  // в список не попадает: правило без ложных срабатываний полезнее
  // правила пошире.
  const WIDENING_CAST = /\bas\s+(?:string|number|boolean)\s*\[\s*\]/;
  const prismaCasts = [];
  const annotatedGroupBy = [];
  for (const file of walk(path.join(ROOT, 'backend/src'))) {
    if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
    // Комментарии вырезаем, сохраняя переносы, — иначе объяснение
    // запрета в комментарии само срабатывало бы как запрет.
    const text = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
    // Вторая форма той же слепой зоны, и она уже стоила прод-сборки
    // дважды. У `groupBy` в сгенерированном клиенте перегрузка, которая
    // при ожидаемом типе СЛЕВА выбирает не ту сигнатуру и требует от
    // аргумента быть массивом результата (prisma/prisma#17297). Приём
    // проекта — приведение СПРАВА; аннотация слева компилируется в
    // песочнице (клиент заглушен `any`) и падает на Vercel.
    //
    // `[^=]*?` (а не `[^=;]*`): точка с запятой бывает ВНУТРИ самой
    // аннотации — `{ userId: string; _count: … }`, — и запрет на неё
    // делал правило слепым ровно к той форме, ради которой оно
    // заведено. Ограничителем работает `=`: между `const x:` и
    // присваиванием его быть не может, а чужой оператор без него не
    // обходится.
    const ANNOTATED_GROUP_BY =
      /const\s+\w+\s*:[^=]*?=\s*(?:await\s+)?this\.prisma\.[A-Za-z0-9_.$]+\.groupBy\s*\(/g;
    for (const m of text.matchAll(ANNOTATED_GROUP_BY)) {
      const line = text.slice(0, m.index).split('\n').length;
      annotatedGroupBy.push(
        `${path.relative(ROOT, file).split(path.sep).join('/')}:${line}`,
      );
    }

    const calls = /this\.prisma\.[A-Za-z0-9_.$]+\(/g;
    let m;
    while ((m = calls.exec(text))) {
      let depth = 0;
      let i = m.index + m[0].length - 1;
      for (; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) break;
      }
      const body = text.slice(m.index, i + 1);
      const bad = body.match(WIDENING_CAST);
      if (bad) {
        const line = text.slice(0, m.index + body.indexOf(bad[0])).split('\n')
          .length;
        prismaCasts.push(
          `${path.relative(ROOT, file).split(path.sep).join('/')}:${line}`,
        );
      }
      calls.lastIndex = i;
    }
  }
  if (annotatedGroupBy.length > 0) {
    problems.push(
      `тип groupBy аннотацией слева: ${annotatedGroupBy.join(', ')} — ` +
        `перегрузка Prisma выберет не ту сигнатуру и потребует от ` +
        `аргумента быть массивом (prisma/prisma#17297); приведите тип ` +
        `СПРАВА, как в wizard-telemetry.service.ts`,
    );
  }
  if (prismaCasts.length > 0) {
    problems.push(
      `расширяющий каст в аргументе Prisma: ${prismaCasts.join(', ')} — ` +
        `песочница этого не видит (клиент заглушен), а сборка на Vercel ` +
        `падает; отдайте копию (\`[...CONST]\`), а не каст`,
    );
  }

  // 8. Внешний контракт `/v1` (этап 144, аудит).
  //
  //    Наружу уходит не то, что возвращает метод: успех заворачивает
  //    `ResponseInterceptor` в `{success, data, meta}`, отказ —
  //    `HttpExceptionFilter` в `{error, meta}`. Для внутренних
  //    маршрутов это деталь, для `/v1` — публичный контракт, который
  //    держат две строки в `main.ts`. Снять их «для порядка» можно, не
  //    заметив, что ломаешь чужие интеграции: свои экраны читают ответ
  //    через один общий клиент и переживут, чужой код — нет.
  const mainSource = read('backend/src/main.ts');
  const V1_CONTRACT = [
    ['useGlobalInterceptors(new ResponseInterceptor())', 'конверт успеха'],
    ['useGlobalFilters(new HttpExceptionFilter())', 'конверт отказа'],
  ];
  for (const [needle, what] of V1_CONTRACT) {
    if (!mainSource.includes(needle)) {
      problems.push(
        `внешний контракт /v1: в main.ts нет «${needle}» (${what}). ` +
          'Форма ответа /v1 описана в doc/API.md и на неё опирается чужой код.',
      );
    }
  }

  // 9. Описание внешнего API не расходится с маршрутами (этап 147).
  //
  //    Чужой код опирается на описание так же, как на сами ответы.
  //    Маршрут, добавленный в контроллер и забытый в `openapi-v1.json`,
  //    для интегратора не существует; описанный и удалённый —
  //    существует и не работает. Второе хуже: про первый хотя бы никто
  //    не знает.
  const v1Source = read('backend/src/modules/api-key/v1.controller.ts');
  const V1_ROUTE = /@(Get|Post|Patch|Delete)\('([^']*)'\)/g;
  const inCode = new Set();
  for (const m of v1Source.matchAll(V1_ROUTE)) {
    // `:jobId` в Nest — это `{jobId}` в OpenAPI.
    const path = m[2].replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    inCode.add(`${m[1].toLowerCase()} /v1/${path}`);
  }
  const spec = JSON.parse(read('doc/openapi-v1.json'));
  const inSpec = new Set();
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      inSpec.add(`${method} ${path}`);
    }
  }
  for (const route of inCode) {
    if (!inSpec.has(route)) {
      problems.push(`внешнее API: маршрут ${route} есть в коде, но не описан в doc/openapi-v1.json`);
    }
  }
  for (const route of inSpec) {
    if (!inCode.has(route)) {
      problems.push(`внешнее API: ${route} описан в doc/openapi-v1.json, но такого маршрута нет`);
    }
  }

  // 10. Каждое поле сессии, живущее в JSON, перечислено в `DATA_KEYS`
  //     (этап 149).
  //
  //     `updateSession` собирает правку СТРОГО по этому списку: ключ, в
  //     него не попавший, пишется без единой ошибки и не сохраняется.
  //     Это уже случалось (Б-2.2, `librarySourceKey`): поле объявили,
  //     писали из двух мест, читали всегда `undefined` — и обложек в
  //     библиотеке не бывало вовсе, пока кто-то не заметил. Комментарий
  //     об этом в коде стоит с этапа 39 и не помешал наступить туда же
  //     на этапе 149; шов надёжнее предупреждения.
  const sessionTypes = read('backend/src/common/types/session.types.ts');
  // До ЗАКРЫВАЮЩЕЙ скобки интерфейса, а не до конца файла: иначе
  // объявление, дописанное после `Session`, попадало бы в разбор и
  // роняло проверку на пустом месте (аудит этапа 149, А-4).
  const sessionStart = sessionTypes.indexOf('export interface Session');
  const sessionEnd = sessionTypes.indexOf('\n}', sessionStart);
  if (sessionStart < 0 || sessionEnd < 0) {
    problems.push(
      'session.types.ts: не нашёлся `export interface Session` — шов на DATA_KEYS проверять нечем',
    );
  }
  const sessionBody = sessionTypes.slice(sessionStart, sessionEnd);
  // Поля первого уровня интерфейса: две пробела отступа и `?:` или `:`.
  const declared = new Set(
    [...sessionBody.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\??:/gm)].map(
      (m) => m[1],
    ),
  );
  // Настоящие колонки таблицы и служебные замки — они не в JSON и через
  // `updateSession` не пишутся.
  const REAL_COLUMNS = new Set([
    'sessionId',
    'status',
    'createdAt',
    'lastActivityAt',
    'deletedAt',
    'generationStatus',
    'userId',
    'projectId',
    'productItemId',
    'workLocks',
  ]);
  const dataKeysSource = read('backend/src/common/session.service.ts');
  const keysBlock = dataKeysSource.slice(
    dataKeysSource.indexOf('export const DATA_KEYS'),
  );
  const listed = new Set(
    [...keysBlock.slice(0, keysBlock.indexOf('] as const')).matchAll(/'([^']+)'/g)].map(
      (m) => m[1],
    ),
  );
  for (const field of declared) {
    if (REAL_COLUMNS.has(field) || listed.has(field)) continue;
    problems.push(
      `поле сессии «${field}» объявлено в session.types.ts, но его нет в DATA_KEYS — ` +
        'запись через updateSession пройдёт без ошибки и ничего не сохранит',
    );
  }
  for (const key of listed) {
    if (!declared.has(key)) {
      problems.push(
        `«${key}» перечислен в DATA_KEYS, но такого поля в session.types.ts нет`,
      );
    }
  }

  // 11. Сервис, внедрённый в модуль, в нём же и зарегистрирован (этап
  //     149).
  //
  //     Найдено настоящим дефектом: этап 146 объявил
  //     `ApiWebhookService`, внедрил его в `ApiVideoJobWorker` и в
  //     `providers` не добавил. Nest не смог бы построить воркер — то
  //     есть приложение не поднялось бы ВОВСЕ. Обычные спеки этого не
  //     видят: они конструируют сервисы руками с дублями, минуя
  //     контейнер, и зелены при любой ошибке в модуле. Поймал eslint, и
  //     поймал случайно — импорт оказался неиспользованным; будь он
  //     рядом упомянут в типе, следа бы не осталось, а деплой всё равно
  //     бы упал.
  //
  //     Правило простое и по всему проекту выполняется без исключений:
  //     если модуль импортирует свой же сервис/воркер/гвард, имя обязано
  //     встретиться внутри `@Module({...})`.
  const MODULE_LOCAL_IMPORT =
    /import \{([^}]*)\} from '(\.\/[^']*\.(?:service|worker|guard|controller))'/g;
  let modulesChecked = 0;
  const moduleFiles = walk(path.join(ROOT, 'backend/src')).filter((f) =>
    f.endsWith('.module.ts'),
  );
  for (const full of moduleFiles) {
    const file = path.relative(ROOT, full);
    const src = read(file);
    const decorator = src.match(/@Module\(\{(.*?)\n\}\)/s);
    if (!decorator) continue;
    modulesChecked++;
    const body = decorator[1];
    for (const m of src.matchAll(MODULE_LOCAL_IMPORT)) {
      for (const name of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        if (new RegExp(`\\b${name}\\b`).test(body)) continue;
        problems.push(
          `${file}: «${name}» импортирован из ${m[2]}, но не упомянут в @Module — ` +
            'если его кто-то внедряет, приложение не поднимется',
        );
      }
    }
  }

  // 12. Кто читает `videoAnalysis` как признак «есть ли сцена» (этап
  //     153).
  //
  //     Три раза подряд один класс: ветку приёмов сцены завели (TODO §III
  //     п.11), а места на ДРУГОМ конце конвейера, решающие по
  //     `videoAnalysis`, не прошли. Аудит 150 нашёл `RelevancePanel`
  //     (каждый ролик по приёму начинался с красной ошибки), аудит 152 —
  //     `AbTestService` (ветка была недостижима целиком), а этап 153 —
  //     советника мастера, который советовал дождаться разбора, которого
  //     не будет. Ни один из трёх не был найден чтением кода вокруг
  //     правки: их находили, когда шли по цепочке ЦЕЛИКОМ.
  //
  //     Список закрытый. Новое место, читающее `videoAnalysis` в
  //     условии, обязано добавить себя сюда — и в этот момент его автор
  //     ответит себе на вопрос про приёмы, вместо того чтобы узнать о
  //     нём от пользователя.
  const SCENE_SOURCE_READERS = new Map([
    [
      'backend/src/common/scene-source.ts',
      'сам источник сцены — здесь решение и принимается',
    ],
    [
      'backend/src/common/wizard-readiness.session.ts',
      'перевод сессии в готовность; приём закрывает тот же пункт',
    ],
    [
      'backend/src/modules/prompt/prompt.service.ts',
      'барьер A/B: разбор, который ИДЁТ, для вариантов не годится',
    ],
    [
      'backend/src/modules/ab-test/ab-test.service.ts',
      'источник прогона: разбор из библиотеки либо приём',
    ],
    [
      'backend/src/modules/wizard-guide/wizard-hint.service.ts',
      'факты советника: «откуда сцена» он обязан знать верно',
    ],
  ]);
  const SCENE_SOURCE_GATE =
    /(!\w+\.videoAnalysis\b|videoAnalysis\?\.status|videoAnalysis\.status)/;
  const sceneReaders = [];
  for (const full of walk(path.join(ROOT, 'backend/src'))) {
    if (!full.endsWith('.ts') || full.endsWith('.spec.ts')) continue;
    const file = path.relative(ROOT, full);
    // Модуль разбора — его собственное хозяйство; типы и каталог
    // приёмов упоминают поле только в доккомментариях.
    if (
      file.startsWith('backend/src/modules/analysis/') ||
      file.startsWith('backend/src/common/types/') ||
      file === 'backend/src/common/scene-templates.ts'
    ) {
      continue;
    }
    // Комментарии не в счёт: `wizard-readiness.ts` только НАЗЫВАЕТ поле
    // в доккомментарии к булеву входу, а решения по нему не принимает —
    // попади он в список, тот перестал бы означать «места, которые
    // решают».
    const src = read(file)
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**');
      })
      .join('\n');
    if (SCENE_SOURCE_GATE.test(src)) sceneReaders.push(file);
  }
  for (const file of sceneReaders) {
    if (!SCENE_SOURCE_READERS.has(file)) {
      problems.push(
        `${file} решает по \`videoAnalysis\`, но не перечислен среди мест, ` +
          'знающих про приёмы сцены — добавьте его в SCENE_SOURCE_READERS ' +
          'в scripts/check-docs.mjs, ответив себе, что этот код делает у ' +
          'сессии на приёме',
      );
    }
  }
  for (const file of SCENE_SOURCE_READERS.keys()) {
    if (!sceneReaders.includes(file)) {
      problems.push(
        `${file} перечислен среди читающих \`videoAnalysis\`, но больше не читает`,
      );
    }
  }

  // 13. Ключ группировки находок: клиент ↔ сервер (этап 156).
  //
  //     `envKey` намеренно посчитан в двух местах — сервер не имеет
  //     права верить ключу из браузера тестировщика, — но СОСТАВ ключа
  //     обязан совпадать. Расхождение не ломает ничего громко: групп
  //     просто станет вдвое больше, и выглядеть это будет как разные
  //     баги на разных устройствах. Заметить такое по результату
  //     нельзя, поэтому шов.
  const envKeyParts = (file) => {
    const block = /export function envKey\([\s\S]*?\.join\(':'\);/.exec(
      read(file),
    );
    if (!block) return null;
    return [...block[0].matchAll(/part\(([^)]*)\)/g)].map((m) =>
      m[1].replace(/input\./g, '').replace(/\s+/g, ' ').trim(),
    );
  };
  const envKeySides = [
    'frontend/src/lib/environment.ts',
    'backend/src/common/environment.ts',
  ].map((file) => ({ file, parts: envKeyParts(file) }));
  for (const side of envKeySides) {
    if (!side.parts?.length) {
      problems.push(
        `${side.file}: не нашёлся \`export function envKey\` с \`.join(':')\` ` +
          '— шов на состав ключа группировки проверять нечем',
      );
    }
  }
  const [envFront, envBack] = envKeySides;
  let envKeyLen = 0;
  if (envFront.parts?.length && envBack.parts?.length) {
    envKeyLen = envFront.parts.length;
    if (envFront.parts.join(' | ') !== envBack.parts.join(' | ')) {
      problems.push(
        'состав ключа группировки находок разошёлся: ' +
          `клиент [${envFront.parts.join(', ')}] ≠ ` +
          `сервер [${envBack.parts.join(', ')}] — группы тикетов ` +
          'рассыплются молча, поправьте обе копии разом',
      );
    }
  }

  //     Тот же шов и по СОСТАВУ снимка. Клиент шлёт то, что описано в
  //     его `Environment`, сервер разбирает то, что описано в своём;
  //     переименованное на клиенте поле сервер молча выбросит, и
  //     окружение станет наполовину пустым, ничего об этом не сказав.
  //     Проверяем в одну сторону: серверу нужно подмножество — поля,
  //     которых он не разбирает (`hasTelegram`), у клиента быть могут.
  const envFields = (file, name) => {
    const block = new RegExp(
      `export interface ${name}[^{]*\\{([\\s\\S]*?)\\n\\}`,
    ).exec(read(file));
    if (!block) return null;
    return new Set(
      [...block[1].matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1]),
    );
  };
  const frontFields = new Set([
    ...(envFields('frontend/src/lib/environment.ts', 'RawEnvironment') ?? []),
    ...(envFields('frontend/src/lib/environment.ts', 'Environment') ?? []),
  ]);
  const backFields = envFields('backend/src/common/environment.ts', 'Environment');
  let envFieldCount = 0;
  if (!frontFields.size || !backFields?.size) {
    problems.push(
      'не нашлись интерфейсы окружения (`RawEnvironment`/`Environment`) ' +
        '— шов на состав снимка проверять нечем',
    );
  } else {
    envFieldCount = backFields.size;
    const missing = [...backFields].filter((f) => !frontFields.has(f));
    if (missing.length) {
      problems.push(
        `сервер разбирает поля окружения, которых клиент не шлёт: ` +
          `${missing.join(', ')} — снимок приедет наполовину пустым, ` +
          'и сказано об этом нигде не будет',
      );
    }
  }

  // 14. Наши сообщения тестировщику ↔ их идентификаторы в тикете
  //     (этап 157).
  //
  //     Ответ тестировщика находит свой тикет ТОЛЬКО по
  //     `botMessageIds`: не записали идентификатор отправленного — и
  //     его «да, теперь работает» ляжет в очередь разбора новой
  //     находкой. Сломать это легко и незаметно: достаточно послать
  //     ещё одно сообщение по тикету (ответ оператора, напоминание) и
  //     не дописать одну строку. Поэтому: кто зовёт `dmWithId`, тот в
  //     том же файле пишет `botMessageIds`.
  //
  //     Шов грубый и знает об этом: проверка файловая, и пропущенная
  //     запись В УЖЕ перечисленном файле, где `botMessageIds` есть в
  //     другом месте, мимо него пройдёт. Ловит он другое и главное —
  //     НОВОЕ место, которое начало писать тестировщику и про тикет не
  //     знает; именно так эта связь и рвётся.
  const REPLY_SENDERS = new Set([
    'backend/src/modules/telegram-bot/tester-tickets.service.ts',
    // Этап 158: ответ оператора из админки. Шов поймал этот файл сам,
    // ровно в том виде, ради которого заводился — новое место, которое
    // начало писать тестировщику.
    'backend/src/modules/admin-panel/admin-test-tickets.service.ts',
  ]);
  const callers = walk(path.join(ROOT, 'backend/src'))
    .filter((f) => !f.endsWith('.spec.ts'))
    .map((f) => path.relative(ROOT, f))
    // Точка обязательна: так находятся ВЫЗОВЫ, а не объявление метода
    // в самом `telegram-notify.service.ts`.
    .filter((f) => /\.dmWithId\(/.test(read(f)));
  for (const file of callers) {
    if (!REPLY_SENDERS.has(file)) {
      problems.push(
        `${file} шлёт сообщение тестировщику через \`dmWithId\`, но не ` +
          'перечислен среди мест, записывающих `botMessageIds` — добавьте ' +
          'его в REPLY_SENDERS в scripts/check-docs.mjs, ответив себе, ' +
          'найдёт ли ответ на это сообщение свой тикет',
      );
    } else if (!/botMessageIds/.test(read(file))) {
      problems.push(
        `${file} зовёт \`dmWithId\`, но \`botMessageIds\` не пишет — ответ ` +
          'тестировщика на это сообщение ляжет в очередь новой находкой',
      );
    }
  }
  for (const file of REPLY_SENDERS) {
    if (!callers.includes(file)) {
      problems.push(
        `${file} перечислен среди шлющих тестировщику, но \`dmWithId\` ` +
          'больше не зовёт',
      );
    }
  }

  if (problems.length > 0) {
    failed++;
    console.log('FAIL швы советника в мастере:');
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log(
      `ok   швы советника: шаги (${stepperSummary.join(', ')}), пункты ` +
        `готовности (${readinessKeys.length}), слаги документов ` +
        `(${server.length}) сходятся; ${greetingRestore}; ` +
        `стартов рендера под проверкой права: ${RENDER_STARTS.length}; ` +
        `завершений через единую точку: ${completionCallCount}; ` +
        `мест привязки приглашения: ${CLAIM_CALLERS.length}; ` +
        `слепых мест Prisma (касты, groupBy): 0; ` +
        `конверт внешнего контракта /v1 на месте; ` +
        `маршрутов /v1 описано: ${inSpec.size}; ` +
        `полей сессии в DATA_KEYS: ${listed.size}; ` +
        `модулей с проверенной регистрацией: ${modulesChecked}; ` +
        `мест, решающих по разбору: ${sceneReaders.length}; ` +
        `частей ключа группировки находок (клиент = сервер): ${envKeyLen}; ` +
        `полей окружения, которые сервер ждёт от клиента: ${envFieldCount}; ` +
        `мест, пишущих тестировщику по тикету: ${callers.length}`,
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
