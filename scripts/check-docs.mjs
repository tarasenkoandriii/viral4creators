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

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── Реальность ─────────────────────────────────────────────────────────

/**
 * Убирает из исходника комментарии, оставляя код.
 *
 * Нужен швам, которые ищут в коде имя (константы, поля) и обязаны не
 * путать его с упоминанием в комментарии. Построчная фильтрация «не
 * начинается с // или *» ошибалась в обе стороны сразу (найдено
 * аудитом этапа A): считала кодом блок `/* … *\/` без ведущих звёздочек
 * и хвостовой комментарий на строке кода, а код после `/* … *\/` в
 * одной строке, наоборот, не видела. Поэтому — маленький автомат по
 * символам, знающий про строковые литералы: `//` внутри 'https://…'
 * не начинает комментария.
 *
 * Переводы строк сохраняются: швы разбирают результат построчно.
 */
/**
 * Может ли `/` в этой позиции начинать regex-литерал.
 *
 * Смотрит на последний значащий символ уже разобранного текста:
 * после значения (`)`, `]`, идентификатор, число, строка) слэш —
 * это деление, в остальных позициях — начало литерала. Грубо, но
 * для нашей задачи (снять комментарии, не поломав regex) достаточно:
 * ошибка возможна только на `)` перед regex, чего в JS не бывает
 * без `if (…) /re/.test(...)`, а это не пишут.
 */
function startsRegex(before) {
  const prev = before.replace(/\s+$/, "").slice(-1);
  if (prev === "") return true;
  return !/[A-Za-z0-9_$)\]'"`]/.test(prev);
}

function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    // Regex-литерал. Без него автомат ошибался в ОБЕ стороны
    // (находка сквозного аудита A+B+C): `/["']+$/` открывал
    // фиктивную строку, и все `//`-комментарии дальше по файлу
    // переставали сниматься (ложное срабатывание швов), а regex,
    // кончающийся на `\//` — например `/^https?:\/\//` — съедался
    // как начало комментария вместе с остатком строки (ложное
    // молчание). Оба случая воспроизведены на настоящих файлах
    // репозитория.
    //
    // Отличить деление от начала regex по предыдущему значащему
    // символу — тот же приём, что у всех простых сканеров JS: после
    // значения (`)`, `]`, идентификатор, число) слэш делит, в
    // остальных позициях начинает литерал.
    if (c === "/" && next !== "/" && next !== "*" && startsRegex(out)) {
      out += c;
      i++;
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === "\\") {
          out += ch + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) {
          out += ch;
          i++;
          break;
        } else if (ch === "\n") {
          // Незакрытый literal — значит это было деление; выходим,
          // не съедая перевод строки.
          break;
        }
        out += ch;
        i++;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        // Переводы строк внутри блока сохраняем, иначе строки кода
        // по обе стороны комментария склеятся в одну.
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, out);
    } else out.push(full);
  }
  return out;
}

const specFiles = walk(path.join(ROOT, "backend/src")).filter((f) =>
  f.endsWith(".spec.ts"),
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
  const file = path.join(ROOT, "backend/jest-results.json");
  if (!fs.existsSync(file)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      tests: json.numTotalTests,
      suites: json.numTotalTestSuites,
    };
  } catch {
    return null;
  }
}

const report = jestReport();

const migrationsDir = path.join(ROOT, "backend/prisma/migrations");
const migrationCount = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory()).length;

// Таблицы — по `@@map("...")` в схеме: именно они превращаются в таблицы
// Postgres, а `model` без map даёт другое имя.
const schema = read("backend/prisma/schema.prisma");
const tableCount = (schema.match(/@@map\("/g) ?? []).length;

const unitScriptCount = fs
  .readdirSync(path.join(ROOT, "frontend/scripts"))
  .filter((f) => f.endsWith(".test.ts")).length;

// Этап 53 (В-6.18): число маршрутов в README — декораторы HTTP-методов в
// контроллерах и число файлов *.controller.ts.
const controllerFiles = walk(path.join(ROOT, "backend/src")).filter((f) =>
  f.endsWith(".controller.ts"),
);
const routeCount = controllerFiles.reduce(
  (n, f) =>
    n +
    (
      fs
        .readFileSync(f, "utf8")
        .match(/^\s*@(Get|Post|Patch|Put|Delete)\(/gm) ?? []
    ).length,
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
    file: "doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md",
    label: "тесты (итоговая сверка)",
    // Только в разделе «Итоговая сверка»: выше по файлу те же формулировки
    // стоят в блоках прошлых этапов и должны остаться историей.
    section: "## Итоговая сверка",
    re: /\*\*(\d+) тест(?:а|ов)? \/ (\d+) набор(?:а|ов)?\*\*/,
    expect: [actual.tests, actual.suites],
    needsJest: true,
  },
  {
    file: "doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md",
    label: "миграции и таблицы (итоговая сверка)",
    section: "## Итоговая сверка",
    // `ю` в окончании — для чисел, кончающихся на единицу: «все 101
    // миграцию». Без неё проверка молча перестаёт находить формулировку
    // ровно на каждой сто первой миграции.
    re: /все \*\*(\d+)\*\* миграци[ийяю]+ подряд на чистом Postgres 16\s*\n?\s*\(\*\*(\d+)\*\* таблиц/,
    expect: [actual.migrations, actual.tables],
  },
  {
    file: "doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md",
    label: "unit-скрипты фронтенда",
    section: "## Итоговая сверка",
    re: /\*\*(\d+)\*\*\s*\n?\s*unit-скрипт(?:ов|а)?/,
    expect: [actual.unitScripts],
  },
  {
    file: "doc/ACCEPTANCE-CHECKLIST.md",
    label: "тесты (шапка чеклиста)",
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
    file: "doc/ACCEPTANCE-CHECKLIST.md",
    label: "миграции и таблицы (шапка чеклиста)",
    re: /все (\d+)\s*\n?миграци[ий] применяются подряд к чистому Postgres 16 \((\d+) таблиц/,
    expect: [actual.migrations, actual.tables],
  },
  {
    file: "doc/ACCEPTANCE-CHECKLIST.md",
    label: "unit-скрипты (шапка чеклиста)",
    re: /(\d+) unit-скрипт(?:ов|а)?/,
    expect: [actual.unitScripts],
  },
  // README и CI.md добавлены на этапе 43 (Б-5.1): оба годами держали
  // «442 tests» и «11 unit scripts» — числа этапа 33. Они не проверялись
  // ровно потому, что этого списка не касались, а не потому, что там
  // чисел нет.
  {
    file: "README.md",
    label: "тесты (README)",
    re: /types, lint, (\d+)\s*\ntests/,
    expect: [actual.tests],
    needsJest: true,
  },
  // Этап 49 (В-6.7): CI.md был в списке, но проверялся только числом
  // unit-скриптов — и держал «919 тестов, 20 миграций» при зелёном прогоне.
  {
    file: "doc/CI.md",
    label: "тесты (шапка CI.md)",
    re: /тогда 442 теста \(сейчас (\d+)\)/,
    expect: [actual.tests],
    needsJest: true,
  },
  {
    file: "doc/CI.md",
    label: "миграции (шапка CI.md)",
    re: /написанных вручную \(сейчас (\d+)\)/,
    expect: [actual.migrations],
  },
  {
    file: "README.md",
    label: "маршруты и контроллеры (README)",
    re: /\((\d+) routes in (\d+) controller files/,
    expect: [actual.routes, actual.controllers],
  },
  {
    file: "README.md",
    label: "unit-скрипты (README)",
    re: /frontend \(types, lint, (\d+) unit\s*\nscripts/,
    expect: [actual.unitScripts],
  },
  {
    file: "doc/CI.md",
    label: "unit-скрипты (таблица джоб)",
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
    file: "doc/TELEGRAM-ADMIN.md",
    label: "миграции (ограничение песочницы, абзац про ручное написание)",
    re: /\(сейчас (\d+) миграци[ийя]+, актуальное\s*\n?\s*число/,
    expect: [actual.migrations],
  },
  {
    file: "doc/TELEGRAM-ADMIN.md",
    label: "миграции (ограничение песочницы, абзац про применение к Postgres)",
    re: /все\s*\n?\s*миграции \(сейчас (\d+)\) были по-настоящему применены/,
    expect: [actual.migrations],
  },
];

// ── Прогон ─────────────────────────────────────────────────────────────

let failed = 0;
console.log("Реальность:", JSON.stringify(actual));

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
      `FAIL ${check.file} — ${check.label}: в документе ${got.join(" / ")}, ` +
        `на самом деле ${check.expect.join(" / ")}`,
    );
  } else {
    console.log(`ok   ${check.file} — ${check.label}: ${got.join(" / ")}`);
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

const ENV_SKIP = new Set(["NODE_ENV", "CI", "VERCEL", "VERCEL_ENV", "TZ"]);
const ENV_PREFIX_OK = ["AI_PRICE_", "DAILY_SPEND_LIMIT_USD_"];

function envVarsInCode() {
  const files = [
    ...walk(path.join(ROOT, "backend/src")),
    ...walk(path.join(ROOT, "admin/src")),
    ...walk(path.join(ROOT, "landing/src")),
    ...walk(path.join(ROOT, "frontend/src")),
  ].filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".spec.ts"));
  const found = new Set();
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(
      /(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]+)/g,
    )) {
      found.add(m[1]);
    }
    // `env.X` в модулях, которые получают process.env параметром
    // (env-settings.ts, spend-limits.ts, csrf.ts, blob-url.ts).
    if (/\benv: NodeJS\.ProcessEnv|\(env\)|env = process\.env/.test(text)) {
      for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]{3,})\b/g))
        found.add(m[1]);
    }
  }
  return [...found].filter((v) => !ENV_SKIP.has(v)).sort();
}

const envDocs = read("doc/DEPLOYMENT.md") + "\n" + read(".env.docker.example");
const undocumented = envVarsInCode().filter(
  (v) =>
    !ENV_PREFIX_OK.some((p) => v.startsWith(p)) &&
    !new RegExp(`(^|[^A-Z0-9_])${v}([^A-Z0-9_]|$)`).test(envDocs),
);
if (undocumented.length > 0) {
  failed++;
  console.log(
    `FAIL переменные окружения: код читает, документы молчат — ${undocumented.join(", ")}. ` +
      `Опишите в doc/DEPLOYMENT.md (прод) или .env.docker.example (стенд).`,
  );
} else {
  console.log(
    `ok   переменные окружения: все ${envVarsInCode().length} описаны в DEPLOYMENT.md или .env.docker.example`,
  );
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

const DICT_LOCALES = ["ru", "uk", "en", "de", "es"];

function loadDict(locale) {
  return JSON.parse(read(`landing/src/dictionaries/${locale}.json`));
}

function checkStepsSymmetry() {
  const dicts = Object.fromEntries(DICT_LOCALES.map((l) => [l, loadDict(l)]));
  const reference = dicts.ru.steps.items;
  const badgeKeys = new Set(Object.keys(dicts.ru.steps.badges));
  const problems = [];

  if (reference.length !== 10) {
    problems.push(
      `ru.json: steps.items содержит ${reference.length}, а не 10 элементов`,
    );
  }

  for (const locale of DICT_LOCALES) {
    const items = dicts[locale].steps.items;
    if (items.length !== reference.length) {
      problems.push(
        `${locale}.json: steps.items содержит ${items.length}, а не ${reference.length} (как ru.json)`,
      );
      continue;
    }
    items.forEach((item, i) => {
      const gotKeys = Object.keys(item).sort().join(",");
      const wantKeys = Object.keys(reference[i]).sort().join(",");
      if (gotKeys !== wantKeys) {
        problems.push(
          `${locale}.json: steps.items[${i}] (шаг ${i + 1}) — набор полей «${gotKeys}», ` +
            `а в ru.json «${wantKeys}»`,
        );
      }
      if (item.badge !== undefined && !badgeKeys.has(item.badge)) {
        problems.push(
          `${locale}.json: steps.items[${i}] (шаг ${i + 1}) — badge «${item.badge}» ` +
            `не входит в steps.badges (${[...badgeKeys].join("/")})`,
        );
      }
    });
  }

  if (problems.length > 0) {
    failed++;
    console.log(
      `FAIL симметрия steps.items по локалям (landing/src/dictionaries):`,
    );
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log(
      `ok   симметрия steps.items по локалям: 10 шагов × 5 локалей, поля и бейджи совпадают`,
    );
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
  let sessionPicks = 0;

  // 1. Шаги мастеров: степпер (frontend) ↔ карточки советника (backend).
  //    По одному сравнению на сценарий — общий список ловил бы
  //    расхождение только случайно.
  const cardsSource = read(
    "backend/src/modules/wizard-guide/hint-scenarios.ts",
  );
  const SCENARIOS = [
    {
      scenario: "CLIENT_SITE",
      file: "frontend/src/lib/client-site-steps.ts",
      constant: "CLIENT_SITE_STEP_IDS",
    },
    {
      scenario: "GREETING_VIDEO",
      file: "frontend/src/lib/greeting-steps.ts",
      constant: "GREETING_STEP_IDS",
    },
    {
      scenario: "PRODUCT_VIDEO",
      file: "frontend/src/lib/session-step.ts",
      constant: "STEPPER_IDS",
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
      problems.push(
        `не нашли карточки сценария ${scenario} в hint-scenarios.ts`,
      );
      continue;
    }
    if (stepper.join(",") !== cards.join(",")) {
      problems.push(
        `шаги ${scenario} разошлись: степпер «${stepper.join(", ")}», ` +
          `карточки советника «${cards.join(", ")}»`,
      );
    }
    stepperSummary.push(`${scenario}: ${stepper.length}`);
  }

  // 2. Пункты готовности: сервер отдаёт key, словарь даёт подпись.
  const readinessKeys = idsFrom(
    read("backend/src/common/wizard-readiness.ts"),
    /key: '([a-zA-Z0-9_-]+)'/g,
  );
  const dictItems = Object.keys(
    JSON.parse(read("frontend/src/dictionaries/ru.json")).wizardReadiness.items,
  );
  // Подписи-ЗАМЕНЫ: один и тот же пункт бывает закрыт разной работой, и
  // у второй работы своя подпись. Пункт «откуда берётся сцена» (`key:
  // 'analysis'`) закрывает либо разбор референса, либо выбранный приём
  // (этап 149), и общая подпись про разбор с галочкой рапортовала бы о
  // работе, которой не было. Список закрытый и живёт здесь, а не
  // послаблением правила: подпись без пункта и подпись-замена —
  // разные вещи, и первая по-прежнему ошибка.
  const OVERRIDE_LABELS = new Set(["sceneTemplate"]);
  const missingLabels = readinessKeys.filter((k) => !dictItems.includes(k));
  const orphanLabels = dictItems.filter(
    (k) => !readinessKeys.includes(k) && !OVERRIDE_LABELS.has(k),
  );
  if (missingLabels.length > 0) {
    problems.push(
      `у пунктов готовности нет подписи в словаре: ${missingLabels.join(", ")}`,
    );
  }
  if (orphanLabels.length > 0) {
    problems.push(
      `в словаре есть подписи для несуществующих пунктов готовности: ${orphanLabels.join(", ")}`,
    );
  }

  // 3. Слаги документов: белый список сервера ↔ отображение клиента.
  const serverSlugs = idsFrom(
    read("backend/src/modules/wizard-guide/hint-actions.ts"),
    /HINT_DOC_SLUGS: readonly string\[\] = \[([^\]]+)\]/g,
  )[0];
  const server = serverSlugs
    ? [...serverSlugs.matchAll(/'([a-zA-Z0-9_-]+)'/g)].map((m) => m[1])
    : [];
  const clientBlock = /DOC_KEYS: Record<string, [^>]+> = \{([^}]+)\}/.exec(
    read("frontend/src/components/HintLine.tsx"),
  );
  const client = clientBlock
    ? [...clientBlock[1].matchAll(/'?([a-zA-Z0-9_-]+)'?\s*:/g)].map((m) => m[1])
    : [];
  if (server.length === 0 || client.length === 0) {
    problems.push("не нашли белый список слагов документов на одной из сторон");
  } else if ([...server].sort().join(",") !== [...client].sort().join(",")) {
    problems.push(
      `слаги документов разошлись: сервер «${server.join(", ")}», ` +
        `клиент «${client.join(", ")}»`,
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
  const greetingWizard = read(
    "frontend/src/features/projects/GreetingVideoWizard.tsx",
  );
  //
  // Оговорка про сводку — не украшение: если `ItemSessionSummary`
  // когда-нибудь начнёт нести сценарий и ролик, дочитывать сессию
  // станет незачем, и проверка обязана это понять сама, а не держать
  // мастер в заложниках. Поэтому оговорка ищется в ТОМ файле, где тип
  // лежит, и её отсутствие — само по себе расхождение: молча
  // «не нашли» значило бы проверять не то, что написано.
  const summaryFields = /interface ItemSessionSummary \{([\s\S]*?)\n\}/.exec(
    read("frontend/src/services/projects-api.ts"),
  );
  if (!summaryFields) {
    problems.push(
      "не нашли `ItemSessionSummary` в projects-api.ts — проверка " +
        "восстановления шага greeting опирается на состав этого типа",
    );
  }
  const summaryHasPrompt = summaryFields
    ? /generationPrompt|generatedVideo/.test(summaryFields[1])
    : false;
  const greetingRestore = summaryHasPrompt
    ? "сводка несёт сценарий"
    : "greeting дочитывает сессию";
  if (
    summaryFields &&
    !summaryHasPrompt &&
    !/getSession\(/.test(greetingWizard)
  ) {
    problems.push(
      "GreetingVideoWizard не дочитывает сессию (`getSession`), а сводка " +
        "сессий не несёт ни сценария, ни ролика — степпер снова покажет " +
        "первый шаг после перезагрузки вкладки (блокер этапа 12)",
    );
  }

  // 5. Стартов рендера три, и у каждого обязана стоять проверка права
  // (этап 132). Шов, а не внимательность: партия по каталогу уже
  // однажды ускользнула от денежной проверки — она идёт в xAI напрямую,
  // минуя `GenerationService.generateVideo()`, и проверку бюджета туда
  // пришлось дописывать отдельно. Второй раз полагаться на то, что
  // новый путь рендера кто-то заметит, незачем.
  const RENDER_STARTS = [
    "backend/src/modules/generation/generation.service.ts",
    "backend/src/modules/greeting-video/greeting-video.service.ts",
    "backend/src/modules/catalog-batch/catalog-batch-worker.service.ts",
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
      `старт рендера без проверки права (assertCanRender): ${startsWithoutCheck.join(", ")}`,
    );
  }
  // Кто зовёт провайдера видео, но стены не требует. Список именной и
  // с причинами — молчаливое исключение по маске рано или поздно
  // накроет настоящий новый старт рендера.
  const RENDER_STARTS_EXEMPT = {
    // Операторские пути: рендер запускает человек из админки, за свои
    // деньги продукта и по своему решению. Стена — про бесплатный тариф
    // пользователя, к оператору она отношения не имеет.
    "backend/src/modules/actors/actors.service.ts":
      "ручной запуск пилота аватара из админки (AdminSessionGuard)",
    "backend/src/modules/virtual-studio/virtual-studio.service.ts":
      'админ-студия, @Controller("admin/virtual-studio")',
    // Тот же батч-клиент Grok, но перевод ТЕКСТА, а не видео.
    "backend/src/modules/blog/blog-translation.service.ts":
      "перевод блога, видео не рендерится",
    // Сами клиенты провайдеров — они и есть вызов, а не его инициатор.
    "backend/src/modules/generation/grok-video.service.ts": "клиент провайдера",
    "backend/src/modules/generation/grok-video-batch.service.ts":
      "клиент провайдера",
    "backend/src/modules/actors/hedra-client.service.ts": "клиент провайдера",
  };
  const unknownStarts = [...walk(path.join(ROOT, "backend/src/modules"))]
    .filter((f) => /\.ts$/.test(f) && !f.endsWith(".spec.ts"))
    .map((f) => ({ f, rel: path.relative(ROOT, f).split(path.sep).join("/") }))
    .filter(({ f, rel }) => {
      if (RENDER_STARTS.includes(rel)) return false;
      if (rel in RENDER_STARTS_EXEMPT) return false;
      const text = fs.readFileSync(f, "utf8");
      return PROVIDER_CALLS.test(text) && !/assertCanRender\s*\(/.test(text);
    })
    .map(({ rel }) => rel);
  if (unknownStarts.length > 0) {
    problems.push(
      `новый старт рендера мимо проверки права: ${unknownStarts.join(", ")} — ` +
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
    "backend/src/modules/render-access/render-completed.service.ts";
  const COMPLETION_CALLS = /\.(markConverted|countFirstGeneration)\s*\(/;
  const directCompletionCalls = [...walk(path.join(ROOT, "backend/src"))]
    .filter((f) => /\.ts$/.test(f) && !f.endsWith(".spec.ts"))
    .map((f) => ({ f, rel: path.relative(ROOT, f).split(path.sep).join("/") }))
    .filter(({ f, rel }) => {
      if (rel === COMPLETION_HUB) return false;
      // Сами объявления методов (`async markConverted(...)`) — не вызовы.
      const text = fs
        .readFileSync(f, "utf8")
        .replace(
          /^\s*(?:async\s+)?(markConverted|countFirstGeneration)\s*\(/gm,
          "",
        );
      return COMPLETION_CALLS.test(text);
    })
    .map(({ rel }) => rel);
  if (directCompletionCalls.length > 0) {
    problems.push(
      `завершение рендера в обход единой точки: ${directCompletionCalls.join(", ")} — ` +
        `позовите RenderCompletedService.onRenderCompleted`,
    );
  }
  // И обратная сторона: точек завершения должно быть ровно столько,
  // сколько их у продукта. Стало меньше — кто-то отключил завершение и
  // не заметил; стало больше — появился новый путь, и его надо внести
  // сюда осознанно, а не обнаружить по недосчитанным приглашениям.
  const COMPLETION_POINTS = [
    "backend/src/modules/generation/generation.service.ts",
    "backend/src/modules/greeting-video/greeting-video.service.ts",
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
    "frontend/src/App.tsx",
    "frontend/src/components/TelegramLoginButton.tsx",
  ];
  const withoutClaim = CLAIM_CALLERS.filter(
    (f) => !/claimStoredReferral\s*\(/.test(read(f)),
  );
  if (withoutClaim.length > 0) {
    problems.push(
      `привязка приглашения не зовётся из ${withoutClaim.join(", ")} — ` +
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
  for (const file of walk(path.join(ROOT, "backend/src"))) {
    if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
    // Комментарии вырезаем, сохраняя переносы, — иначе объяснение
    // запрета в комментарии само срабатывало бы как запрет.
    const text = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
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
      const line = text.slice(0, m.index).split("\n").length;
      annotatedGroupBy.push(
        `${path.relative(ROOT, file).split(path.sep).join("/")}:${line}`,
      );
    }

    const calls = /this\.prisma\.[A-Za-z0-9_.$]+\(/g;
    let m;
    while ((m = calls.exec(text))) {
      let depth = 0;
      let i = m.index + m[0].length - 1;
      for (; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")" && --depth === 0) break;
      }
      const body = text.slice(m.index, i + 1);
      const bad = body.match(WIDENING_CAST);
      if (bad) {
        const line = text
          .slice(0, m.index + body.indexOf(bad[0]))
          .split("\n").length;
        prismaCasts.push(
          `${path.relative(ROOT, file).split(path.sep).join("/")}:${line}`,
        );
      }
      calls.lastIndex = i;
    }
  }
  if (annotatedGroupBy.length > 0) {
    problems.push(
      `тип groupBy аннотацией слева: ${annotatedGroupBy.join(", ")} — ` +
        `перегрузка Prisma выберет не ту сигнатуру и потребует от ` +
        `аргумента быть массивом (prisma/prisma#17297); приведите тип ` +
        `СПРАВА, как в wizard-telemetry.service.ts`,
    );
  }
  if (prismaCasts.length > 0) {
    problems.push(
      `расширяющий каст в аргументе Prisma: ${prismaCasts.join(", ")} — ` +
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
  const mainSource = read("backend/src/main.ts");
  const V1_CONTRACT = [
    ["useGlobalInterceptors(new ResponseInterceptor())", "конверт успеха"],
    ["useGlobalFilters(new HttpExceptionFilter())", "конверт отказа"],
  ];
  for (const [needle, what] of V1_CONTRACT) {
    if (!mainSource.includes(needle)) {
      problems.push(
        `внешний контракт /v1: в main.ts нет «${needle}» (${what}). ` +
          "Форма ответа /v1 описана в doc/API.md и на неё опирается чужой код.",
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
  const v1Source = read("backend/src/modules/api-key/v1.controller.ts");
  const V1_ROUTE = /@(Get|Post|Patch|Delete)\('([^']*)'\)/g;
  const inCode = new Set();
  for (const m of v1Source.matchAll(V1_ROUTE)) {
    // `:jobId` в Nest — это `{jobId}` в OpenAPI.
    const path = m[2].replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    inCode.add(`${m[1].toLowerCase()} /v1/${path}`);
  }
  const spec = JSON.parse(read("doc/openapi-v1.json"));
  const inSpec = new Set();
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      inSpec.add(`${method} ${path}`);
    }
  }
  for (const route of inCode) {
    if (!inSpec.has(route)) {
      problems.push(
        `внешнее API: маршрут ${route} есть в коде, но не описан в doc/openapi-v1.json`,
      );
    }
  }
  for (const route of inSpec) {
    if (!inCode.has(route)) {
      problems.push(
        `внешнее API: ${route} описан в doc/openapi-v1.json, но такого маршрута нет`,
      );
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
  const sessionTypes = read("backend/src/common/types/session.types.ts");
  // До ЗАКРЫВАЮЩЕЙ скобки интерфейса, а не до конца файла: иначе
  // объявление, дописанное после `Session`, попадало бы в разбор и
  // роняло проверку на пустом месте (аудит этапа 149, А-4).
  const sessionStart = sessionTypes.indexOf("export interface Session");
  const sessionEnd = sessionTypes.indexOf("\n}", sessionStart);
  if (sessionStart < 0 || sessionEnd < 0) {
    problems.push(
      "session.types.ts: не нашёлся `export interface Session` — шов на DATA_KEYS проверять нечем",
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
    "sessionId",
    "status",
    "createdAt",
    "lastActivityAt",
    "deletedAt",
    "generationStatus",
    "userId",
    "projectId",
    "productItemId",
    "workLocks",
  ]);
  const dataKeysSource = read("backend/src/common/session.service.ts");
  const keysBlock = dataKeysSource.slice(
    dataKeysSource.indexOf("export const DATA_KEYS"),
  );
  const listed = new Set(
    [
      ...keysBlock
        .slice(0, keysBlock.indexOf("] as const"))
        .matchAll(/'([^']+)'/g),
    ].map((m) => m[1]),
  );
  for (const field of declared) {
    if (REAL_COLUMNS.has(field) || listed.has(field)) continue;
    problems.push(
      `поле сессии «${field}» объявлено в session.types.ts, но его нет в DATA_KEYS — ` +
        "запись через updateSession пройдёт без ошибки и ничего не сохранит",
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
  const moduleFiles = walk(path.join(ROOT, "backend/src")).filter((f) =>
    f.endsWith(".module.ts"),
  );
  for (const full of moduleFiles) {
    const file = path.relative(ROOT, full);
    const src = read(file);
    const decorator = src.match(/@Module\(\{(.*?)\n\}\)/s);
    if (!decorator) continue;
    modulesChecked++;
    const body = decorator[1];
    for (const m of src.matchAll(MODULE_LOCAL_IMPORT)) {
      for (const name of m[1]
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)) {
        if (new RegExp(`\\b${name}\\b`).test(body)) continue;
        problems.push(
          `${file}: «${name}» импортирован из ${m[2]}, но не упомянут в @Module — ` +
            "если его кто-то внедряет, приложение не поднимется",
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
      "backend/src/common/scene-source.ts",
      "сам источник сцены — здесь решение и принимается",
    ],
    [
      "backend/src/common/wizard-readiness.session.ts",
      "перевод сессии в готовность; приём закрывает тот же пункт",
    ],
    [
      "backend/src/modules/prompt/prompt.service.ts",
      "барьер A/B: разбор, который ИДЁТ, для вариантов не годится",
    ],
    [
      "backend/src/modules/ab-test/ab-test.service.ts",
      "источник прогона: разбор из библиотеки либо приём",
    ],
    [
      "backend/src/modules/wizard-guide/wizard-hint.service.ts",
      "факты советника: «откуда сцена» он обязан знать верно",
    ],
  ]);
  const SCENE_SOURCE_GATE =
    /(!\w+\.videoAnalysis\b|videoAnalysis\?\.status|videoAnalysis\.status)/;
  const sceneReaders = [];
  for (const full of walk(path.join(ROOT, "backend/src"))) {
    if (!full.endsWith(".ts") || full.endsWith(".spec.ts")) continue;
    const file = path.relative(ROOT, full);
    // Модуль разбора — его собственное хозяйство; типы и каталог
    // приёмов упоминают поле только в доккомментариях.
    if (
      file.startsWith("backend/src/modules/analysis/") ||
      file.startsWith("backend/src/common/types/") ||
      file === "backend/src/common/scene-templates.ts"
    ) {
      continue;
    }
    // Комментарии не в счёт: `wizard-readiness.ts` только НАЗЫВАЕТ поле
    // в доккомментарии к булеву входу, а решения по нему не принимает —
    // попади он в список, тот перестал бы означать «места, которые
    // решают».
    const src = read(file)
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return (
          !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/**")
        );
      })
      .join("\n");
    if (SCENE_SOURCE_GATE.test(src)) sceneReaders.push(file);
  }
  for (const file of sceneReaders) {
    if (!SCENE_SOURCE_READERS.has(file)) {
      problems.push(
        `${file} решает по \`videoAnalysis\`, но не перечислен среди мест, ` +
          "знающих про приёмы сцены — добавьте его в SCENE_SOURCE_READERS " +
          "в scripts/check-docs.mjs, ответив себе, что этот код делает у " +
          "сессии на приёме",
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
      m[1]
        .replace(/input\./g, "")
        .replace(/\s+/g, " ")
        .trim(),
    );
  };
  const envKeySides = [
    "frontend/src/lib/environment.ts",
    "backend/src/common/environment.ts",
  ].map((file) => ({ file, parts: envKeyParts(file) }));
  for (const side of envKeySides) {
    if (!side.parts?.length) {
      problems.push(
        `${side.file}: не нашёлся \`export function envKey\` с \`.join(':')\` ` +
          "— шов на состав ключа группировки проверять нечем",
      );
    }
  }
  const [envFront, envBack] = envKeySides;
  let envKeyLen = 0;
  if (envFront.parts?.length && envBack.parts?.length) {
    envKeyLen = envFront.parts.length;
    if (envFront.parts.join(" | ") !== envBack.parts.join(" | ")) {
      problems.push(
        "состав ключа группировки находок разошёлся: " +
          `клиент [${envFront.parts.join(", ")}] ≠ ` +
          `сервер [${envBack.parts.join(", ")}] — группы тикетов ` +
          "рассыплются молча, поправьте обе копии разом",
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
    ...(envFields("frontend/src/lib/environment.ts", "RawEnvironment") ?? []),
    ...(envFields("frontend/src/lib/environment.ts", "Environment") ?? []),
  ]);
  const backFields = envFields(
    "backend/src/common/environment.ts",
    "Environment",
  );
  let envFieldCount = 0;
  if (!frontFields.size || !backFields?.size) {
    problems.push(
      "не нашлись интерфейсы окружения (`RawEnvironment`/`Environment`) " +
        "— шов на состав снимка проверять нечем",
    );
  } else {
    envFieldCount = backFields.size;
    const missing = [...backFields].filter((f) => !frontFields.has(f));
    if (missing.length) {
      problems.push(
        `сервер разбирает поля окружения, которых клиент не шлёт: ` +
          `${missing.join(", ")} — снимок приедет наполовину пустым, ` +
          "и сказано об этом нигде не будет",
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
    "backend/src/modules/telegram-bot/tester-tickets.service.ts",
    // Этап 158: ответ оператора из админки. Шов поймал этот файл сам,
    // ровно в том виде, ради которого заводился — новое место, которое
    // начало писать тестировщику.
    "backend/src/modules/admin-panel/admin-test-tickets.service.ts",
  ]);
  const callers = walk(path.join(ROOT, "backend/src"))
    .filter((f) => !f.endsWith(".spec.ts"))
    .map((f) => path.relative(ROOT, f))
    // Точка обязательна: так находятся ВЫЗОВЫ, а не объявление метода
    // в самом `telegram-notify.service.ts`.
    .filter((f) => /\.dmWithId\(/.test(read(f)));
  for (const file of callers) {
    if (!REPLY_SENDERS.has(file)) {
      problems.push(
        `${file} шлёт сообщение тестировщику через \`dmWithId\`, но не ` +
          "перечислен среди мест, записывающих `botMessageIds` — добавьте " +
          "его в REPLY_SENDERS в scripts/check-docs.mjs, ответив себе, " +
          "найдёт ли ответ на это сообщение свой тикет",
      );
    } else if (!/botMessageIds/.test(read(file))) {
      problems.push(
        `${file} зовёт \`dmWithId\`, но \`botMessageIds\` не пишет — ответ ` +
          "тестировщика на это сообщение ляжет в очередь новой находкой",
      );
    }
  }
  for (const file of REPLY_SENDERS) {
    if (!callers.includes(file)) {
      problems.push(
        `${file} перечислен среди шлющих тестировщику, но \`dmWithId\` ` +
          "больше не зовёт",
      );
    }
  }

  // 15. Копия таблицы маршрутов в бэкенде не должна отставать от
  //     фронтенда.
  //
  //     `backend/.../tutorial-runner/route-templates.ts` держит ОСОЗНАННУЮ
  //     копию имён маршрутов из `frontend/src/lib/router.ts` — кросс-
  //     импорта между пакетами в проекте нет нигде, и её доккомментарий
  //     честно просит «поправить руками при изменении маршрутов».
  //
  //     Просьба не сработала ни разу. К 26.09.2026 во фронтенде было 26
  //     имён, в копии 21: отстали `site-tutorial`, `greeting-video`,
  //     `testing`, `api-keys`, `invite`. Обнаружилось случайно, когда
  //     понадобилось снять кадры мастера обучалки для лендинга, — то
  //     есть копия была сломана месяцами и молчала.
  //
  //     Шов читает оба файла текстом (не импортом: пакеты остаются
  //     несвязанными) и сверяет множества имён в обе стороны. Отставание
  //     копии он ловит сразу; удалённый во фронтенде маршрут, оставшийся
  //     в копии, — тоже.
  const routerSrc = read("frontend/src/lib/router.ts");
  const builderSrc = read(
    "backend/src/modules/tutorial-runner/route-templates.ts",
  );
  const frontRoutes = new Set(
    [...routerSrc.matchAll(/\{\s*name:\s*'([a-z-]+)'/g)].map((m) => m[1]),
  );
  const buildersBlock =
    builderSrc.match(/const ROUTE_BUILDERS[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ??
    "";
  const backRoutes = new Set(
    [...buildersBlock.matchAll(/^ {2}'?([a-z-]+)'?:/gm)].map((m) => m[1]),
  );
  if (frontRoutes.size === 0 || backRoutes.size === 0) {
    problems.push(
      "не удалось разобрать таблицы маршрутов — проверьте регулярки шва 15 " +
        "в scripts/check-docs.mjs (сам шов сломан, а не код)",
    );
  }
  for (const name of frontRoutes) {
    if (!backRoutes.has(name)) {
      problems.push(
        `маршрут «${name}» есть во frontend/src/lib/router.ts, но копия в ` +
          "backend/.../tutorial-runner/route-templates.ts о нём не знает — " +
          "резолвер сценариев ответит «не найдено» на существующий экран",
      );
    }
  }
  //
  //     Исключение — ПСЕВДОНИМЫ исполнителя (`SEEDED_SESSION_ROUTES`,
  //     находка второго боевого прогона 29.09.2026). `generate-ready`
  //     ведёт на тот же `/generate`, что и `generate`: во фронтенде
  //     второго имени нет и быть не должно. Отличается не путь, а то,
  //     что исполнитель подсевает в `localStorage` ДО загрузки — и
  //     именно это тут и проверяется, потому что псевдоним без подсева
  //     снова молча откроет пустой мастер, а сценарий упадёт через 15
  //     секунд на селекторе вместо причины.
  //     С 29.09.2026 это Map: имя маршрута → поле контекста, из
  //     которого берётся сессия для подсева. Множества стало мало,
  //     потому что подсеянных маршрутов три, а ключ в `localStorage`
  //     один: подсунуть не ту сессию — значит снять не тот экран, и
  //     сценарий при этом ПРОЙДЁТ.
  const seededBlock =
    builderSrc.match(
      /SEEDED_SESSION_ROUTES[^=]*=\s*new Map\(\[([\s\S]*?)\]\)/,
    )?.[1] ?? "";
  const seededPairs = [
    ...seededBlock.matchAll(/\['([a-z-]+)',\s*'([A-Za-z]+)'/g),
  ].map((m) => [m[1], m[2]]);
  const seededRoutes = new Set(seededPairs.map(([name]) => name));
  const seededFields = new Set(seededPairs.map(([, field]) => field));
  if (seededFields.size !== seededPairs.length) {
    problems.push(
      "два маршрута с подсевом берут сессию из ОДНОГО поля контекста — " +
        "это два имени одного экрана, и модель не сможет выбрать верное",
    );
  }
  for (const [, field] of seededPairs) {
    if (!new RegExp(`\\b${field}\\?: string`).test(builderSrc)) {
      problems.push(
        `SEEDED_SESSION_ROUTES ссылается на поле «${field}», которого нет в ` +
          "FixtureRouteContext — подсев молча возьмёт пустую строку",
      );
    }
  }
  if (seededRoutes.size === 0) {
    problems.push(
      "не удалось разобрать SEEDED_SESSION_ROUTES в route-templates.ts — " +
        "шов 15 ослеп на псевдонимы исполнителя",
    );
  }
  const scenarioRunnerSrc = read(
    "backend/src/modules/tutorial-runner/tutorial-scenario-runner.service.ts",
  );
  /**
   * Второй способ завести имя маршрута, которого нет во фронтенде:
   * псевдоним по СОСТОЯНИЮ ПРОЕКТА (`PROJECT_STATE_ROUTES`). У
   * поздравления состояние экрана задаёт адрес, а не сессия в
   * браузере, поэтому подсевать нечего — но объяснить имя всё равно
   * обязательно, иначе опечатка в `ROUTE_DESCRIPTIONS` останется
   * незамеченной до первого ночного прогона.
   */
  const stateRoutes = new Map(
    [
      ...(
        /PROJECT_STATE_ROUTES[^=]*=[^[]*\[([\s\S]*?)\]\);/.exec(
          builderSrc,
        )?.[1] ?? ""
      ).matchAll(/\['([a-z0-9-]+)',\s*'([A-Za-z]+)'\]/g),
    ].map((m) => [m[1], m[2]]),
  );
  if (stateRoutes.size === 0) {
    problems.push(
      "не удалось разобрать PROJECT_STATE_ROUTES в route-templates.ts — " +
        "шов ослеп на псевдонимы по состоянию проекта",
    );
  }
  if (new Set(stateRoutes.values()).size !== stateRoutes.size) {
    problems.push(
      "два маршрута по состоянию проекта берут проект из ОДНОГО поля " +
        "контекста — это два имени одного экрана, и модель не сможет " +
        "выбрать верное",
    );
  }
  for (const [, field] of stateRoutes) {
    if (!new RegExp(`\\b${field}\\?: string`).test(builderSrc)) {
      problems.push(
        `PROJECT_STATE_ROUTES ссылается на поле «${field}», которого нет в ` +
          "FixtureRouteContext — маршрут молча отказал бы «нет данных»",
      );
    }
  }
  /**
   * Что предложено модели, то и принимается обратно (29.09.2026).
   *
   * Список тем для кнопки «посмотреть ролик» живёт в ДВУХ местах
   * одного файла: он уходит в промпт (`buildHintInstruction`) и им же
   * проверяется ответ (`parseHintActions`). Разойтись они могут молча
   * и в обе стороны: предложенная, но не принимаемая тема — это
   * кнопка, которую модель предложила, а сервис выбросил (совет без
   * обещанной кнопки); принимаемая, но не предложенная — приглашение
   * выдумать значение.
   *
   * И сам список обязан браться из КАТАЛОГА (`greetingTopicKeys`), а
   * не быть выписанным рядом: выписанный отстанет от каталога и
   * предложит тему, которой нет, — кнопка поведёт в 404.
   */
  const hintSrc = stripComments(
    read("backend/src/modules/wizard-guide/wizard-hint.service.ts"),
  );
  if (!/greetingTopicKeys\(/.test(hintSrc)) {
    problems.push(
      "wizard-hint.service.ts не берёт темы обучалок из " +
        "`greetingTopicKeys` — список, выписанный рядом, отстанет от " +
        "каталога и предложит тему, которой нет",
    );
  }
  const offered = /buildHintInstruction\(\{[\s\S]*?\n {4}\}\);/.exec(
    hintSrc,
  )?.[0];
  const accepted = /parseHintActions\([\s\S]*?\n {6}\);/.exec(hintSrc)?.[0];
  if (!offered || !accepted) {
    problems.push(
      "wizard-hint.service.ts: не нашлись вызовы buildHintInstruction/" +
        "parseHintActions — шов на белый список тем ослеп (поправьте шов, " +
        "а не код)",
    );
  } else {
    const inOffer = /\btopics\b/.test(offered);
    const inAccept = /\btopics\b/.test(accepted);
    if (inOffer !== inAccept) {
      problems.push(
        `темы обучалок ${inOffer ? "предлагаются модели, но не принимаются обратно" : "принимаются, но не предлагаются"} — ` +
          "белый список обязан быть одним и тем же с обеих сторон",
      );
    }
    if (!inOffer) {
      problems.push(
        "кнопка «посмотреть ролик» не предлагается модели вовсе — " +
          "совет не сможет показать ролик",
      );
    }
  }

  /**
   * Каждая карточка поздравления знает свою тему справки (29.09.2026).
   *
   * Кнопка (i) стоит на ВСЕХ девяти карточках, тем пять. Списков,
   * которые обязаны сходиться, здесь три: карточки на экране (атрибуты
   * `data-qa="greeting-*-card"`), каталог хуков бэкенда и резолвер
   * `GREETING_CARD_TOPIC` во фронтенде.
   *
   * Разойтись они могут молча и в обе стороны: новая карточка без
   * темы оставит человека без кнопки помощи ровно там, где он её
   * нажмёт, а тема, указывающая на исчезнувшую карточку, отправит
   * справку в никуда. Ни то ни другое не падает — просто справка
   * оказывается не про то, что на экране.
   */
  const cardHooks = [
    ...read("backend/src/modules/tutorial-scenario/qa-hooks.ts").matchAll(
      /^ {2}'(greeting-[a-z-]+-card)':/gm,
    ),
  ].map((m) => m[1]);
  const topicOf = new Map(
    [
      ...(
        /GREETING_CARD_TOPIC: Readonly<Record<string, GreetingHelpTopic>> =\s*\{([\s\S]*?)\};/.exec(
          read("frontend/src/lib/greeting-help.ts"),
        )?.[1] ?? ""
      ).matchAll(/'([a-z-]+)':\s*'([a-z-]+)'/g),
    ].map((m) => [m[1], m[2]]),
  );
  if (cardHooks.length === 0 || topicOf.size === 0) {
    problems.push(
      `шов справки ослеп: карточек в каталоге ${cardHooks.length}, тем в ` +
        `резолвере ${topicOf.size} (поправьте шов, а не код)`,
    );
  } else {
    for (const hook of cardHooks) {
      if (!topicOf.has(hook)) {
        problems.push(
          `карточка «${hook}» есть в каталоге хуков, но темы справки у ` +
            "неё нет — кнопка (i) на ней покажет пустоту",
        );
      }
    }
    for (const hook of topicOf.keys()) {
      if (!cardHooks.includes(hook)) {
        problems.push(
          `резолвер справки знает карточку «${hook}», которой нет в ` +
            "каталоге хуков — тема указывает в никуда",
        );
      }
    }
    // И каждая тема обязана существовать как тема обучалки: иначе
    // кнопка позовёт `/tutorial-help/<тема>` и получит 404.
    const topicsBuilt = new Set(
      [
        ...read("backend/scripts/build-assistant-knowledge.ts").matchAll(
          /'(greeting-[a-z-]+)',/g,
        ),
      ].map((m) => m[1]),
    );
    for (const topic of new Set(topicOf.values())) {
      if (!topicsBuilt.has(topic)) {
        problems.push(
          `тема справки «${topic}» не собирается сборщиком базы знаний — ` +
            "кнопка (i) получит 404",
        );
      }
    }
  }

  /**
   * Позиция степпера поздравления объявлена на экране, ГДЕ ПО НЕЙ
   * МОЖНО КЛИКНУТЬ (29.09.2026).
   *
   * Нарисованы все четыре позиции на всех трёх экранах; живой кнопку
   * делает `clickable = !active && selectable[i]`. Перепутать «видно»
   * с «кликается» уже стоило мастеру товара восьми сценариев из
   * девяти — сценарий ждал выключенную кнопку тридцать секунд.
   *
   * Правило живёт во фронтенде и там же проверено
   * (`frontend/scripts/greeting-steps.test.ts`, таблица
   * `LIVE_BY_ROUTE`); здесь сверяется КОПИЯ этого правила в каталоге
   * хуков бэкенда — второе место, где оно записано.
   */
  const liveByRoute = new Map();
  const liveTable =
    /LIVE_BY_ROUTE: Record<string, GreetingStepId\[\]> = \{([\s\S]*?)\};/.exec(
      read("frontend/scripts/greeting-steps.test.ts"),
    )?.[1];
  if (!liveTable) {
    problems.push(
      "frontend/scripts/greeting-steps.test.ts: не нашлась таблица " +
        "LIVE_BY_ROUTE — шов на живые позиции степпера поздравления " +
        "проверять нечем (поправьте шов, а не код)",
    );
  } else {
    for (const m of liveTable.matchAll(/'([a-z-]+)':\s*\[([^\]]*)\]/g)) {
      liveByRoute.set(
        m[1],
        [...m[2].matchAll(/'([a-z]+)'/g)].map((x) => x[1]),
      );
    }
    // Каталог читается здесь заново: карта `routeOf` живёт в соседнем
    // шве, и тянуть её через модуль значило бы связать два шва одним
    // состоянием ради экономии трёх строк.
    const hookRoutes = [
      ...read("backend/src/modules/tutorial-scenario/qa-hooks.ts").matchAll(
        /^ {2}'(greeting-step-[a-z-]+)': \{\s*\n\s*route: '([a-z-]+)'/gm,
      ),
    ];
    if (hookRoutes.length === 0) {
      problems.push(
        "в каталоге хуков не нашлось ни одной позиции степпера " +
          "поздравления — шов на живость проверять нечем (поправьте шов, " +
          "а не код)",
      );
    }
    for (const [, hook, route] of hookRoutes) {
      const step = /^greeting-step-(.+)$/.exec(hook)?.[1];
      if (!step) continue;
      const live = liveByRoute.get(route);
      if (!live) {
        problems.push(
          `каталог отправляет «${hook}» на «${route}», которого нет в ` +
            "LIVE_BY_ROUTE — экран не описан, и живость позиции никем не " +
            "проверена",
        );
      } else if (!live.includes(step)) {
        problems.push(
          `каталог отправляет «${hook}» на «${route}», где эта позиция ` +
            `степпера ВЫКЛЮЧЕНА (живые там: ${live.join(", ") || "нет"}) — ` +
            "сценарий будет ждать её тридцать секунд и упадёт",
        );
      }
    }
  }

  for (const name of backRoutes) {
    if (frontRoutes.has(name)) continue;
    if (seededRoutes.has(name)) continue;
    if (stateRoutes.has(name)) continue;
    problems.push(
      `маршрут «${name}» перечислен в route-templates.ts, но во ` +
        "frontend/src/lib/router.ts такого имени нет и ни в " +
        "SEEDED_SESSION_ROUTES, ни в PROJECT_STATE_ROUTES он не " +
        "объявлен — копия отстала в другую сторону",
    );
  }
  for (const name of seededRoutes) {
    if (!backRoutes.has(name)) {
      problems.push(
        `«${name}» объявлен псевдонимом с подсевом сессии, но резолвера ` +
          "в ROUTE_BUILDERS у него нет — сценарий с таким goto упадёт " +
          "«не знаю такой маршрут»",
      );
    }
    if (!new RegExp(`\\b${name}\\b`).test(stripComments(builderSrc))) {
      problems.push(
        `«${name}» не описан в ROUTE_DESCRIPTIONS — модель о нём не ` +
          "узнает и продолжит писать goto на чистый мастер",
      );
    }
  }
  // Псевдоним без подсева бесполезен и опасен: маршрут разрешится, а
  // экран откроется не тот. Проверяем, что исполнитель ЧИТАЕТ список и
  // кладёт ключ сессии.
  if (seededRoutes.size > 0) {
    // Импорты отрезаны намеренно: мутация «подставить литерал вместо
    // константы» оставляет имя в строке `import`, и шов, ищущий имя по
    // всему файлу, её переживает (проверено мутациями S1/S2). Смотрим
    // на ВЫЗОВ, а не на упоминание.
    const runnerBody = stripComments(scenarioRunnerSrc).replace(
      /^import[\s\S]*?from '[^']+';$/gm,
      "",
    );
    // `.get(`, а не `.has(`: с тремя маршрутами важно не «просит ли
    // сценарий подсев», а КАКУЮ из трёх сессий он просит. Проверка на
    // `.has(` пережила бы возврат к одной сессии на все маршруты —
    // то есть к молча снятому не тому экрану.
    if (
      !/\bSEEDED_SESSION_ROUTES\.get\(/.test(runnerBody) ||
      !/\bSPA_SESSION_STORAGE_KEY\b/.test(runnerBody)
    ) {
      problems.push(
        "tutorial-scenario-runner.service.ts не читает SEEDED_SESSION_ROUTES " +
          "или не кладёт SPA_SESSION_STORAGE_KEY — псевдоним маршрута " +
          "разрешится, но мастер откроется пустым, как до 29.09.2026",
      );
    }
  }
  /*
   * Каждый отбор сессии для мастера ТОВАРКИ обязан стоять внутри
   * рекламных проектов (шестой боевой прогон 29.09.2026).
   *
   * Резолверы ищут сессии «по содержанию» — одобренный промпт, готовый
   * рендер, — и это осознанно: так они работают и для фикстуры,
   * донастроенной руками. Но признак по содержанию перестаёт различать
   * ровно в тот день, когда в данных появляется новый ВИД сущности:
   * `fixture-tutorial-greeting-ready-session` описывалась запросом
   * «промпт собран, ролика нет» так же верно, как рекламная, оказалась
   * свежее — и мастер товарки восстановил чужую сессию.
   *
   * Рамка на товар в этом же методе стояла с самого начала, на сессии
   * — нет. Забыть её снова можно так же поштучно, поэтому шов считает
   * ВСЕ отборы сессии, а не проверяет наличие хоть одного.
   */
  {
    const RUNNER =
      "backend/src/modules/tutorial-runner/tutorial-scenario-runner.service.ts";
    const src = stripComments(read(RUNNER));
    const picks = [
      ...src.matchAll(
        /prisma\.session\.findFirst\(\{\s*where:\s*\{([\s\S]*?)\n {8}\},/g,
      ),
    ];
    // Сравнение с сырым счётом, а не `picks.length === 0`: рефактор,
    // после которого шов видит два запроса из трёх, — это шов, молча
    // проверяющий меньше, чем обещает строка `ok`. Ноль тоже ловится
    // этим же сравнением.
    const rawPicks = (src.match(/prisma\.session\.findFirst\(/g) ?? []).length;
    if (picks.length !== rawPicks) {
      problems.push(
        `${RUNNER}: отборов сессии ${rawPicks}, разобрано ${picks.length} — ` +
          "шов ослеп на остальные, поправьте шов, а не код",
      );
    }
    const unframed = picks.filter(
      (m) => !/project:\s*\{\s*type:\s*\{\s*in:\s*AD_TYPES/.test(m[1]),
    ).length;
    if (unframed > 0) {
      problems.push(
        `${RUNNER}: отборов сессии без рамки project.type: ${unframed} из ` +
          `${picks.length} — такой запрос выберет сессию поздравления, и ` +
          "мастер товарки откроется на чужом экране",
      );
    }
    sessionPicks = picks.length;
  }

  // Три операции, которые тратят деньги ночью, и суточный потолок над
  // ними (сквозной аудит обучалки 29.09.2026).
  //
  // Список в `tutorial-budget.ts` должен совпадать с тем, что реально
  // пишет `aiUsage.record({ operation: … })` в подсистеме. Разойдись
  // они — и потолок молча перестанет видеть часть расхода: он не
  // упадёт и не пожалуется, просто пропустит трату. Это ровно тот тип
  // отказа, ради которого предохранитель и ставили.
  const budgetSrc = stripComments(
    read("backend/src/modules/tutorial-runner/tutorial-budget.ts"),
  );
  const budgetOps = new Set(
    [
      ...(
        budgetSrc.match(
          /TUTORIAL_PAID_OPERATIONS[^=]*=\s*\[([\s\S]*?)\]/,
        )?.[1] ?? ""
      ).matchAll(/'([a-z-]+)'/g),
    ].map((m) => m[1]),
  );
  const recordedOps = new Set();
  for (const rel of [
    "backend/src/modules/tutorial-runner/tutorial-scenario-runner.service.ts",
    "backend/src/modules/tutorial-scenario/tutorial-scenario-generator.service.ts",
  ]) {
    for (const m of stripComments(read(rel)).matchAll(
      /operation:\s*'(tutorial-[a-z-]+)'/g,
    )) {
      recordedOps.add(m[1]);
    }
  }
  if (budgetOps.size === 0 || recordedOps.size === 0) {
    problems.push(
      "не удалось разобрать операции расхода обучалки — шов суточного " +
        "потолка ослеп (проверьте регулярки в scripts/check-docs.mjs)",
    );
  }
  for (const op of recordedOps) {
    if (!budgetOps.has(op)) {
      problems.push(
        `операция «${op}» пишет расход обучалки, но в TUTORIAL_PAID_OPERATIONS ` +
          "её нет — суточный потолок не увидит эту трату и пропустит её молча",
      );
    }
  }
  for (const op of budgetOps) {
    if (!recordedOps.has(op)) {
      problems.push(
        `операция «${op}» объявлена платной для потолка, но расход по ней ` +
          "никто не пишет — список отстал от кода",
      );
    }
  }
  // Потолок обязан проверяться ПЕРЕД каждой из трёх трат, а не только
  // на входе в прогон: синтез тридцати дорожек внутри одного сценария
  // — это тридцать трат, и остановиться надо на той, которая
  // перевалила.
  const budgetCallers = [
    "backend/src/modules/tutorial-runner/tutorial-scenario-runner.service.ts",
    "backend/src/modules/tutorial-scenario/tutorial-scenario-generator.service.ts",
  ];
  let budgetChecks = 0;
  for (const rel of budgetCallers) {
    const body = stripComments(read(rel));
    const n = [...body.matchAll(/budgetExhausted\(/g)].length;
    if (n === 0) {
      problems.push(
        `${rel}: не проверяет суточный потолок расхода обучалки — ` +
          "ночная работа снова сможет тратить без ограничения",
      );
    }
    budgetChecks += n;
  }

  // Хук, который «нажимается только после того, как шаг пройден», на  // Хук, который «нажимается только после того, как шаг пройден», на
  // ЧИСТОМ мастере не нажимается никогда. До 29.09.2026 все пять
  // позиций степпера сидели там — и сценарии ждали выключенную кнопку.
  const hooksSrc = stripComments(
    read("backend/src/modules/tutorial-scenario/qa-hooks.ts"),
  );
  const freshRoute =
    /FRESH_WIZARD_ROUTE = '([a-z-]+)'/.exec(stripComments(builderSrc))?.[1] ??
    "";
  let visitedOnlyHooks = 0;
  for (const m of hooksSrc.matchAll(
    /'([a-z0-9-]+)':\s*\{\s*route:\s*'([a-z-]+)',[\s\S]*?\n {2}\}/g,
  )) {
    const [, hook, route] = m;
    if (!/clickOnlyWhenVisited:\s*true/.test(m[0])) continue;
    visitedOnlyHooks++;
    if (freshRoute && route === freshRoute) {
      problems.push(
        `хук «${hook}» помечен clickOnlyWhenVisited, но живёт на чистом ` +
          `маршруте «${freshRoute}» — там шаг не пройден никогда, и клик ` +
          "по нему будет ждать выключенную кнопку до таймаута",
      );
    }
  }
  if (visitedOnlyHooks === 0) {
    problems.push(
      "не нашёл ни одного хука clickOnlyWhenVisited в qa-hooks.ts — шов " +
        "15-бис ослеп (проверьте регулярку в scripts/check-docs.mjs)",
    );
  }

  // 16. OG-карточки лендинга обучалок не должны отставать от словарей.
  //
  //     `scripts/og-tutorial-cards.mjs` запекает в картинку заголовок и
  //     бейдж первого экрана. Картинка статична и коммитится: поменяли
  //     заголовок в словаре, скрипт перезапустить забыли — и превью
  //     ссылки тихо показывает прошлогодний текст. Увидеть это на самой
  //     странице нельзя никак, только переслав ссылку.
  //
  //     Генератор пишет отпечаток строк рядом с собой; шов пересчитывает
  //     его из словарей и сверяет. Разошлось — перезапустить генератор.
  const lockPath = "scripts/assets/og-tutorial-cards.lock.json";
  const ogLock = JSON.parse(read(lockPath));
  let ogChecked = 0;
  for (const locale of ["ru", "uk", "en", "de", "es"]) {
    const hero = JSON.parse(read(`landing/src/dictionaries/${locale}.json`))
      .siteTutorialLanding.hero;
    const actual = createHash("sha256")
      .update(`${hero.title}\n${hero.badge}`)
      .digest("hex")
      .slice(0, 16);
    if (ogLock[locale] !== actual) {
      problems.push(
        `OG-карточка tutorial-${locale}.jpg нарисована по старому тексту ` +
          "первого экрана — перезапустите `node scripts/og-tutorial-cards.mjs` " +
          "и закоммитьте картинки вместе с " +
          lockPath,
      );
    }
    ogChecked += 1;
  }

  // 17. Настоящие кадры секции «Как это выглядит»: список, файлы и
  //     бюджет должны сходиться.
  //
  //     `landing/src/lib/tutorial-frames.ts` держит список локалей, для
  //     которых сняты все четыре кадра. От него зависит и картинка, и
  //     текст оговорки под заголовком. Ошибиться можно двумя способами,
  //     и оба тихие: объявить локаль, не положив файлы (страница отдаст
  //     404 вместо кадра, а оговорка уже скажет «настоящие кадры»), или
  //     положить файлы, забыв дописать локаль (файлы лежат мёртвым
  //     грузом, страница по-прежнему показывает схемы).
  //
  //     Текстовую сторону проверяет `landing/scripts/tutorial-frames.test.ts`.
  const framesSrc = read("landing/src/lib/tutorial-frames.ts");
  const shotLocales = new Set(
    (
      framesSrc.match(
        /REAL_FRAME_LOCALES: readonly Locale\[\] = \[([^\]]*)\]/,
      )?.[1] ?? ""
    )
      .split(",")
      .map((x) => x.trim().replace(/^'|'$/g, ""))
      .filter(Boolean),
  );
  if (!/REAL_FRAME_LOCALES: readonly Locale\[\] = \[/.test(framesSrc)) {
    // Тот же приём, что у шва 15: молчащий шов хуже отсутствующего.
    // Без этой проверки переименованная константа означала бы «локалей
    // не объявлено», и при отсутствии файлов всё выглядело бы зелёным.
    problems.push(
      "не удалось разобрать REAL_FRAME_LOCALES в landing/src/lib/tutorial-frames.ts " +
        "— поправьте регулярку шва 17 в scripts/check-docs.mjs (сломан шов, а не код)",
    );
  }

  // Потолок ширины снимка живёт в двух местах: в CSS (`max-width` у
  // `.frame-card-shot .frame-shot`) и в TS (`SHOT_CSS_WIDTH`, из него
  // строится `sizes`). Разойдутся — `sizes` начнёт врать браузеру, и
  // он будет брать картинку крупнее нужного. Ровно это аудит и поймал.
  const cssCap = read("landing/src/app/globals.css").match(
    /\.frame-card-shot \.frame-shot \{[^}]*max-width:\s*(\d+)px/,
  )?.[1];
  const tsCap = framesSrc.match(/SHOT_CSS_WIDTH = (\d+)/)?.[1];
  if (!cssCap || !tsCap) {
    problems.push(
      "не нашли потолок ширины снимка в CSS или в tutorial-frames.ts — " +
        "поправьте регулярки шва 17",
    );
  } else if (cssCap !== tsCap) {
    problems.push(
      `потолок ширины снимка разошёлся: CSS ${cssCap}px, SHOT_CSS_WIDTH ${tsCap}px — ` +
        "`sizes` наврёт браузеру, и он возьмёт вариант не того размера",
    );
  }

  const shotDir = "landing/public/illustrations";
  // Номера — ровно 1..4, а не любая цифра. Прежняя регулярка (`\d`)
  // принимала `-0` и `-5`: набор `ru-0..ru-3` давал счёт 4, шов
  // проходил, а страница просила `-4` и получала 404 на проде
  // (находка аудита 27.09.2026). Поэтому дальше сверяется МНОЖЕСТВО
  // номеров, а не их количество.
  const shotFiles = fs
    .readdirSync(path.join(ROOT, shotDir))
    .filter((f) => /^tutorial-shot-[a-z]{2}-[1-4]\.avif$/.test(f));
  const strayShots = fs
    .readdirSync(path.join(ROOT, shotDir))
    .filter(
      (f) =>
        /^tutorial-shot-/.test(f) &&
        !/^tutorial-shot-[a-z]{2}-[1-4]\.avif$/.test(f),
    );
  for (const file of strayShots) {
    problems.push(
      `${shotDir}/${file}: имя не похоже на кадр мастера — ожидается ` +
        "tutorial-shot-<локаль>-<1..4>.avif; страница такой файл не ищет",
    );
  }
  const SHOT_MAX_BYTES = 120 * 1024;
  const onDisk = new Map();
  for (const file of shotFiles) {
    const locale = file.split("-")[2];
    onDisk.set(locale, (onDisk.get(locale) ?? 0) + 1);

    const bytes = fs.statSync(path.join(ROOT, shotDir, file)).size;
    if (bytes > SHOT_MAX_BYTES) {
      problems.push(
        `${shotDir}/${file} весит ${Math.round(bytes / 1024)} КБ при бюджете ` +
          `${SHOT_MAX_BYTES / 1024} КБ — уменьшайте зону обрезки, а не качество`,
      );
    }
  }
  for (const locale of shotLocales) {
    const have = onDisk.get(locale) ?? 0;
    // Проверять «четыре файла, но номера не те» незачем: имена
    // уникальны, значит четыре валидных имени одной локали — это ровно
    // 1..4. Неверный номер отсекается выше, по имени файла.
    if (have !== 4) {
      problems.push(
        `локаль «${locale}» объявлена в REAL_FRAME_LOCALES, но кадров на диске ${have} из 4 — ` +
          "страница пообещает настоящие кадры и отдаст 404",
      );
    }
  }
  for (const [locale, count] of onDisk) {
    if (!shotLocales.has(locale)) {
      problems.push(
        `в ${shotDir} лежат кадры локали «${locale}» (${count} шт.), но её нет в ` +
          "REAL_FRAME_LOCALES — страница их не показывает",
      );
    }
  }

  // 16-бис. OG-карточки страницы поздравлений — тот же приём, что шов 16:
  //     `scripts/og-greetings-cards.mjs` запекает заголовок и бейдж
  //     первого экрана `greetingsLanding.hero` и пишет отпечаток рядом.
  //     Поменяли текст — перезапустите генератор (этап H ТЗ Greeting 2.0).
  const greetOgLockPath = "scripts/assets/og-greetings-cards.lock.json";
  const greetOgLock = JSON.parse(read(greetOgLockPath));
  for (const locale of ["ru", "uk", "en", "de", "es"]) {
    const hero = JSON.parse(read(`landing/src/dictionaries/${locale}.json`))
      .greetingsLanding.hero;
    const actual = createHash("sha256")
      .update(`${hero.title}\n${hero.badge ?? ""}`)
      .digest("hex")
      .slice(0, 16);
    if (greetOgLock[locale] !== actual) {
      problems.push(
        `OG-карточка greetings-${locale}.jpg нарисована по старому тексту ` +
          "первого экрана — перезапустите `node scripts/og-greetings-cards.mjs` " +
          "и закоммитьте картинки вместе с " +
          greetOgLockPath,
      );
    }
  }

  // 17-бис. Кадры страницы поздравлений: список локалей в
  //     `landing/src/lib/greeting-frames.ts` ↔ файлы `greet-shot-*` на
  //     диске ↔ бюджеты. Те же две тихие ошибки, что в шве 17 (объявили
  //     локаль без файлов — 404 и ложная оговорка; положили файлы без
  //     локали — мёртвый груз), плюс бюджет схем волны 1 (§5.3 ТЗ Greeting
  //     2.0: hero ≤90 КБ, кадр ≤120 КБ). Текстовую сторону и правила
  //     рисования держит `landing/scripts/greeting-frames.test.ts`.
  const greetFramesSrc = read("landing/src/lib/greeting-frames.ts");
  const greetListMatch = greetFramesSrc.match(
    /GREETING_REAL_FRAME_LOCALES: readonly Locale\[\] = \[([^\]]*)\]/,
  );
  if (!greetListMatch) {
    problems.push(
      "не удалось разобрать GREETING_REAL_FRAME_LOCALES в landing/src/lib/greeting-frames.ts " +
        "— поправьте регулярку шва 17-бис в scripts/check-docs.mjs (сломан шов, а не код)",
    );
  }
  const greetShotLocales = new Set(
    (greetListMatch?.[1] ?? "")
      .split(",")
      .map((x) => x.trim().replace(/^'|'$/g, ""))
      .filter(Boolean),
  );
  const greetDirFiles = fs.readdirSync(path.join(ROOT, shotDir));
  const greetShotRe = /^greet-shot-[a-z]{2}-[1-4]\.avif$/;
  const greetOnDisk = new Map();
  for (const file of greetDirFiles) {
    if (!/^greet-shot-/.test(file)) continue;
    if (!greetShotRe.test(file)) {
      problems.push(
        `${shotDir}/${file}: имя не похоже на кадр мастера поздравлений — ` +
          "ожидается greet-shot-<локаль>-<1..4>.avif; страница такой файл не ищет",
      );
      continue;
    }
    const locale = file.split("-")[2];
    greetOnDisk.set(locale, (greetOnDisk.get(locale) ?? 0) + 1);
    const bytes = fs.statSync(path.join(ROOT, shotDir, file)).size;
    if (bytes > SHOT_MAX_BYTES) {
      problems.push(
        `${shotDir}/${file} весит ${Math.round(bytes / 1024)} КБ при бюджете ` +
          `${SHOT_MAX_BYTES / 1024} КБ`,
      );
    }
  }
  for (const locale of greetShotLocales) {
    const have = greetOnDisk.get(locale) ?? 0;
    if (have !== 4) {
      problems.push(
        `локаль «${locale}» объявлена в GREETING_REAL_FRAME_LOCALES, но кадров на диске ` +
          `${have} из 4 — страница пообещает настоящие кадры и отдаст 404`,
      );
    }
  }
  for (const [locale, count] of greetOnDisk) {
    if (!greetShotLocales.has(locale)) {
      problems.push(
        `в ${shotDir} лежат кадры поздравлений локали «${locale}» (${count} шт.), но её нет в ` +
          "GREETING_REAL_FRAME_LOCALES — страница их не показывает",
      );
    }
  }
  for (const [file, max] of [
    ["greet-hero.svg", 90 * 1024],
    ["greet-frame-1.svg", 120 * 1024],
    ["greet-frame-2.svg", 120 * 1024],
    ["greet-frame-3.svg", 120 * 1024],
    ["greet-frame-4.svg", 120 * 1024],
  ]) {
    const full = path.join(ROOT, shotDir, file);
    if (!fs.existsSync(full)) {
      problems.push(`${shotDir}/${file} нет — страница поздравлений отдаст 404 вместо схемы`);
    } else if (fs.statSync(full).size > max) {
      problems.push(
        `${shotDir}/${file} весит ${Math.round(fs.statSync(full).size / 1024)} КБ ` +
          `при бюджете ${max / 1024} КБ`,
      );
    }
  }

  // ── Длительность ролика обучалки считается ОДИН раз, в плане ──────
  //
  // Этап A ТЗ `docs-tz/TZ-Tutorial-Video-Voiced.md`. До него писатель
  // умножал `frameCount × SECONDS_PER_FRAME` у себя, за три модуля от
  // места, где строится ffmpeg-команда. Пока все кадры были одной
  // длины, это сходилось; с этапа B длины разные — вторая формула
  // разошлась бы МОЛЧА, а число читает человек («Длительность — около
  // N с»). Ни типы, ни тесты такого не ловят: поле необязательное, и
  // неверное число выглядит как верное.
  //
  // Шов держит ровно одно: константу видит только модуль плана, а
  // писатели берут готовое `plan.durationMs`.
  // Писателей ищем САМИ, а не по списку в этой строке: третий
  // писатель появится на этапе B (озвучка) и на этапе G (`xfade`), и
  // захардкоженный список молча пропустил бы его мимо шва.
  const assetWriters = walk(path.join(ROOT, "backend/src"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))
    .map((f) => path.relative(ROOT, f))
    .map((rel) => ({ rel, code: stripComments(read(rel)) }))
    .filter(({ code }) =>
      /tutorialVideoAsset\.(create|update|updateMany|upsert)\(/.test(code),
    );
  let durationWrites = 0;
  for (const { rel, code } of assetWriters) {
    // Любое упоминание `durationMs` в КОДЕ писателя обязано быть
    // канонической записью. Прежняя редакция шва требовала ровно
    // однострочную форму с хвостовой запятой — и `durationMs,` через
    // локальную переменную, и перенос строки проносили самодельную
    // формулу мимо (находка аудита этапа A).
    for (const line of code.split("\n")) {
      if (!/\bdurationMs\b/.test(line)) continue;
      durationWrites++;
      if (line.trim() !== "durationMs: plan.durationMs,") {
        problems.push(
          `${rel}: «${line.trim()}» — длительность пишется не как ` +
            "plan.durationMs; вторая формула расходится с командой молча " +
            "(этап A)",
        );
      }
    }
  }
  // Число записей проверяется, а не только печатается: если запись
  // пропадёт целиком, шов обязан это заметить, а не отрапортовать
  // «все из плана» про пустое множество. Два писателя — сценарный
  // прогон и обучалка по сайту заказчика; станет больше — строку
  // ниже поправит тот, кто добавит третьего, и заодно перечитает шов.
  const DURATION_WRITES_EXPECTED = 2;
  if (durationWrites < DURATION_WRITES_EXPECTED) {
    problems.push(
      `длительность ролика обучалки пишут ${durationWrites} мест из ` +
        `${DURATION_WRITES_EXPECTED} — запись пропала, и «Длительность — ` +
        "около N с» исчезнет с экрана мастера (этап A)",
    );
  }
  // ── Статусы сборки: админка знает ровно те строки, что пишет
  //    бэкенд ─────────────────────────────────────────────────────
  //
  // `assemblyStatus` — обычная строка в БД, без enum на уровне Prisma,
  // и API отдаёт её как есть, без маппинга. Значит связь бэкенда с
  // админкой держится на договорённости, которую ничто не проверяло:
  // до аудита этапа A админка объявляла 'submitted' и 'completed'
  // (бэкенд их не писал НИКОГДА), а настоящие 'preparing' и
  // 'complete' в её типе отсутствовали — готовый ролик показывался
  // жёлтым бейджем с сырым английским словом. Ни типы, ни тесты
  // такого не ловят: обе стороны внутри себя последовательны.
  const backendStatuses = new Set(
    [...walk(path.join(ROOT, "backend/src"))]
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))
      .flatMap((f) => [
        ...stripComments(read(path.relative(ROOT, f))).matchAll(
          /assemblyStatus: '([a-z]+)'/g,
        ),
      ])
      .map((m) => m[1]),
  );
  const adminStatusDecl =
    /export type TutorialVideoAssemblyStatus =\s*([^;]+);/.exec(
      stripComments(read("admin/src/lib/types.ts")),
    );
  if (!adminStatusDecl) {
    problems.push(
      "admin/src/lib/types.ts: не нашёл объявление TutorialVideoAssemblyStatus — " +
        "шов сверки статусов сборки ослеп, поправьте регулярку вместе с типом",
    );
  } else {
    const adminStatuses = new Set(
      [...adminStatusDecl[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]),
    );
    // Схему сверяем тоже: доккомментарий `assemblyStatus` перечислял
    // три значения из четырёх и не знал про `preparing` — шов ловил
    // расхождение бэкенда с админкой и не смотрел туда, откуда оба
    // берут смысл (находка сквозного аудита A+B+C).
    const schemaStatusDoc =
      /Состояние асинхронной сборки[\s\S]*?'failed'/.exec(
        read("backend/prisma/schema.prisma"),
      )?.[0] ?? "";
    for (const value of backendStatuses) {
      if (!schemaStatusDoc.includes(`'${value}'`)) {
        problems.push(
          `schema.prisma: статус сборки «${value}» бэкенд пишет, а доккомментарий ` +
            "assemblyStatus о нём молчит",
        );
      }
    }
    const onlyBackend = [...backendStatuses].filter(
      (v) => !adminStatuses.has(v),
    );
    const onlyAdmin = [...adminStatuses].filter((v) => !backendStatuses.has(v));
    if (onlyBackend.length > 0) {
      problems.push(
        `статусы сборки ${onlyBackend.map((v) => `«${v}»`).join(", ")} бэкенд пишет, ` +
          "а админка о них не знает — оператор увидит сырое английское слово",
      );
    }
    if (onlyAdmin.length > 0) {
      problems.push(
        `статусы сборки ${onlyAdmin.map((v) => `«${v}»`).join(", ")} админка объявляет, ` +
          "а бэкенд их не пишет — мёртвая ветка в подписи и в цвете бейджа",
      );
    }
  }

  // ── Транзитные файлы обучалки живут под ОДНИМ убираемым
  //    префиксом ───────────────────────────────────────────────────
  //
  // Кадры, mp3 озвучки (этап B) и `.ass`-подписи (этап E) — всё это
  // временные входы для внешнего ffmpeg-api, которые надо убрать
  // после сборки. Подметальщик ТРАНЗИТОВ в проекте ровно один и
  // метёт ОДИН префикс — `scenarioFramePrefix(assetId)` (§4.3 ТЗ
  // `docs-tz/TZ-Tutorial-Video-Voiced.md`). Файл, залитый мимо него,
  // не убирает никто и никогда: это не ошибка, которая где-то
  // всплывёт, а счёт за хранение, растущий тихо.
  //
  // Исключение одно и осознанное: готовое видео (`tutorial-videos/`)
  // — оно не транзит, а результат, и живёт до удаления актива. Его
  // убирает второй подметальщик, `sweepOldAssets`, и по другому
  // правилу: не «после сборки», а «когда роль этой строки в паре
  // (шаг, локаль) заняла более свежая».
  //
  // Второе исключение — кеш озвучки (`voiceoverCachePathname`): он
  // ОБЯЗАН пережить сборку, иначе следующей ночью за ту же фразу
  // заплатят заново. Ямы он не заводит: вытесняет себя сам, под
  // ключом (локаль, шаг) всегда ровно один файл.
  const ALLOWED_UPLOAD_PREFIXES = [
    "scenarioFramePrefix(",
    "tutorial-videos/",
    "voiceoverCachePathname(",
  ];
  // Число заливок проверяется, а не только печатается. Обход шва
  // тривиален — положить `uploadBuffer` в переменную, — и тогда
  // счётчик просто уменьшится, а вердикт останется `ok`. Ровно эту
  // дыру аудит этапа A закрыл у соседнего шва, а здесь она появилась
  // заново (найдено аудитом этапа B).
  // Четыре: кадры, кеш озвучки, готовое видео и `.ass` с подписями
  // (этап E). Запись этапа B предсказывала, что `.ass` попадёт под
  // этот шов «ничего не читая», — так и вышло: путь строится от
  // `scenarioFramePrefix`, и шов заметил только новое число.
  const TRANSIT_UPLOADS_EXPECTED = 4;
  let transitUploads = 0;
  for (const file of walk(
    path.join(ROOT, "backend/src/modules/tutorial-runner"),
  )) {
    if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
    const rel = path.relative(ROOT, file);
    const code = stripComments(read(rel));
    for (const m of code.matchAll(/uploadBuffer\(\s*([^,]+),/g)) {
      const target = m[1].trim();
      transitUploads++;
      if (ALLOWED_UPLOAD_PREFIXES.some((p) => target.includes(p))) continue;
      problems.push(
        `${rel}: uploadBuffer(${target}) льёт мимо префикса актива — ` +
          "уборка идёт только по нему, файл останется в Blob навсегда (§4.3 ТЗ)",
      );
    }
  }

  if (transitUploads !== TRANSIT_UPLOADS_EXPECTED) {
    problems.push(
      `заливок в обучалке ${transitUploads}, а шов сторожит ` +
        `${TRANSIT_UPLOADS_EXPECTED}: заливку либо добавили, либо увели от шва ` +
        "(например, положив uploadBuffer в переменную) — проверьте, под каким " +
        "префиксом она пишет, и поправьте число здесь",
    );
  }

  // ── Режимы движения обучалки: бэкенд = админка ───────────────────
  //
  // Этап G ТЗ `docs-tz/TZ-Tutorial-Video-Voiced.md`. Режим уходит из
  // `<select>` витрины строкой и принимается DTO по списку
  // `SLIDESHOW_MOTIONS`. Типы приложений друг друга не видят: админка
  // объявила бы `'zoom'`, DTO его отверг бы с 400, и оператор получил
  // бы «не удалось сохранить» ровно в тот момент, когда откатывает
  // движение (уровень «4-бис»). Сверяются три места: список на
  // бэкенде, тип в админке и значения пунктов выпадающего списка.
  const motionSrc = stripComments(
    read("backend/src/modules/tutorial-runner/tutorial-video-assembly.ts"),
  );
  const motionList = /SLIDESHOW_MOTIONS\s*=\s*\[([^\]]*)\]/.exec(motionSrc);
  const backendMotions = motionList
    ? [...motionList[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    : [];
  const adminTypeMatch = /export type TutorialMotion\s*=\s*([^;]+);/.exec(
    read("admin/src/lib/types.ts"),
  );
  const adminMotions = adminTypeMatch
    ? [...adminTypeMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    : [];
  const settingsPage = read("admin/src/app/settings/page.tsx");
  const motionSelect = /aria-label="Движение в ролике"[\s\S]*?<\/select>/.exec(
    settingsPage,
  );
  const optionMotions = motionSelect
    ? [...motionSelect[0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])
    : [];
  if (backendMotions.length === 0) {
    problems.push("не нашли SLIDESHOW_MOTIONS в tutorial-video-assembly.ts");
  } else {
    const want = backendMotions.join(",");
    if (adminMotions.join(",") !== want) {
      problems.push(
        `режимы движения разошлись: бэкенд «${want}», тип админки «${adminMotions.join(",")}»`,
      );
    }
    if (optionMotions.join(",") !== want) {
      problems.push(
        `режимы движения разошлись: бэкенд «${want}», пункты витрины «${optionMotions.join(",")}» — ` +
          "лишний пункт DTO отвергнет, недостающий нельзя выбрать",
      );
    }
  }

  // ── Расход обучалки пишется СВОИМИ операциями ─────────────────────
  //
  // Этап F ТЗ `docs-tz/TZ-Tutorial-Video-Voiced.md`: синтез обучалки
  // с этапа B писался общей `voiceover` и в отчёте складывался с
  // озвучкой роликов пользователей — вопрос «сколько стоит обучалка за
  // ночь» из отчёта было не достать. Теперь у каждой траты обучалки
  // своя строка с приставкой `tutorial-`. Типы этого не сторожат:
  // `voiceover` — законный `AiOperation`, и новая запись с ним
  // скомпилируется, пройдёт линт и тесты, а в отчёте молча растворится.
  //
  // Операция обязана быть ЛИТЕРАЛОМ прямо в вызове: переменная на её
  // месте ослепила бы шов — тот же обход, что у заливок выше.
  // Число вызовов сверяется: `record`, уведённый в обёртку, иначе
  // просто выпал бы из подсчёта, а вердикт остался бы `ok`.
  //
  // Три модуля, а не один: генератор сценариев, ночной исполнитель и
  // обучалка по сайту заказчика тратят каждый своё, и отчёт обязан
  // различать это по строкам. `recordGemini` — тот же вход в журнал,
  // что `record`, и под шов попадает так же.
  const TUTORIAL_USAGE_DIRS = [
    "backend/src/modules/tutorial-runner",
    "backend/src/modules/tutorial-scenario",
    "backend/src/modules/client-site-tutorial",
  ];
  // синтез + сборка (ночной прогон), генерация сценария, сборка
  // обучалки по сайту заказчика
  const TUTORIAL_USAGE_RECORDS_EXPECTED = 4;
  let tutorialUsageRecords = 0;
  const tutorialOps = new Set();
  const tutorialFiles = TUTORIAL_USAGE_DIRS.flatMap((dir) =>
    walk(path.join(ROOT, dir)),
  );
  for (const file of tutorialFiles) {
    if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
    const rel = path.relative(ROOT, file);
    const code = stripComments(read(rel));
    for (const m of code.matchAll(/\.record(?:Gemini|OpenAi)?\(/g)) {
      // Тело вызова — до парной скобки: объект расхода многострочный,
      // и регэксп «до ближайшей `)`» обрезал бы его на первом же
      // вложенном вызове.
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < code.length; end++) {
        if (code[end] === "(") depth++;
        else if (code[end] === ")" && --depth === 0) break;
      }
      const call = code.slice(m.index, end + 1);
      tutorialUsageRecords++;
      const op = /\boperation:\s*'([^']*)'/.exec(call);
      if (!op) {
        problems.push(
          `${rel}: запись расхода без литерала operation — шов не видит, ` +
            "какой строкой отчёта она пишется (этап F)",
        );
        continue;
      }
      tutorialOps.add(op[1]);
      if (!op[1].startsWith("tutorial-")) {
        problems.push(
          `${rel}: расход обучалки пишется операцией «${op[1]}» — в отчёте он ` +
            "растворится в расходе пользователей; заведите свою строку " +
            "tutorial-* в common/ai-pricing.ts (этап F)",
        );
      }
    }
  }
  if (tutorialUsageRecords !== TUTORIAL_USAGE_RECORDS_EXPECTED) {
    problems.push(
      `записей расхода в обучалке ${tutorialUsageRecords}, а шов сторожит ` +
        `${TUTORIAL_USAGE_RECORDS_EXPECTED}: запись либо добавили, либо увели ` +
        "в обёртку — проверьте её операцию и поправьте число здесь",
    );
  }

  // ── Готовое видео обучалки: один префикс на три места ────────────
  //
  // Файл заливается под `tutorial-videos/{subjectKey}/{id}.mp4`
  // (`tutorial-scenario-runner.service.ts`), а читают этот путь ОБРАТНО
  // из `blobUrl` двое, и оба через `pathnameFromBlobUrl(url,
  // 'tutorial-videos/')`:
  //
  //  - публикация (`publication.service.ts`) — заявка ссылается прямо
  //    на этот mp4, своей копии она намеренно не делает;
  //  - подметальщик устаревших роликов (`sweepOldAssets`) — по этому
  //    же пути он файл и удаляет.
  //
  // Разъехавшись, они молчат по-разному и оба скверно: публикация
  // начнёт отказывать с «не под ожидаемым префиксом», а подметальщик
  // просто перестанет находить путь — и удалит СТРОКУ, оставив файл
  // в Blob навсегда, то есть ровно ту яму, ради которой заводился.
  // Ни один тест этого не поймает: каждый из трёх модулей проверяется
  // своим набором, а строка литерала в каждом своя.
  const VIDEO_PREFIX_SITES = [
    [
      "backend/src/modules/tutorial-runner/tutorial-scenario-runner.service.ts",
      2,
    ],
    ["backend/src/modules/publication/publication.service.ts", 1],
  ];
  let videoPrefixUses = 0;
  for (const [rel, expected] of VIDEO_PREFIX_SITES) {
    const code = stripComments(read(rel));
    const found = [...code.matchAll(/['"`]tutorial-videos\//g)].length;
    videoPrefixUses += found;
    if (found !== expected) {
      problems.push(
        `${rel}: упоминаний префикса 'tutorial-videos/' ${found}, а шов ждёт ` +
          `${expected} — либо префикс увели в переменную/переименовали, либо ` +
          "появилось третье место; сверьте заливку, публикацию и подметальщика " +
          "(иначе подметальщик удалит строку, а файл останется навсегда)",
      );
    }
  }

  // ── Уникальность пары и `upsert` держатся друг за друга ───────────
  //
  // Этап C ТЗ `docs-tz/TZ-Tutorial-Video-Voiced.md`. До него генератор
  // делал `create` каждый суточный прогон: строки копились, а
  // исполнитель брал их ВСЕ и снимал по ролику на каждую. Починка —
  // из двух половин, и ни одна не работает без второй: `upsert` без
  // ограничения продолжит плодить строки (и молча — никто не
  // упадёт), а ограничение без `upsert` уронит генерацию на второй
  // же ночи, целиком, на первом же шаге. Шов держит их вместе.
  const SCHEMA_UNIQUE = /@@unique\(\[subjectKey, locale\]\)/;
  const GENERATOR =
    "backend/src/modules/tutorial-scenario/tutorial-scenario-generator.service.ts";
  // `stripComments`, а не сырой текст: закомментированное
  // `@@unique` — самый естественный способ временно снять
  // ограничение в Prisma-схеме, и шов рапортовал бы «уникальна: да»
  // (находка аудита этапа C; тот же класс, что аудит A чинил у
  // соседнего шва).
  const pairUnique = SCHEMA_UNIQUE.test(
    stripComments(read("backend/prisma/schema.prisma")),
  );
  const generatorCode = stripComments(read(GENERATOR));
  // Адресация по составному ключу — и есть «пишем по паре». Проверять
  // именно `upsert()` было нельзя: после правки аудита этапа C
  // генератор сперва читает строку (чтобы не затереть правку
  // человека и не унаследовать одобрение), а пишет `create`/`update`
  // — по тому же ключу, но другим вызовом.
  const writesByPair = /subjectKey_locale/.test(generatorCode);
  if (pairUnique && !writesByPair) {
    problems.push(
      `${GENERATOR}: ограничение на пару в схеме есть, а генератор не адресует ` +
        "строки по subjectKey_locale — повторная генерация не обновит свою же " +
        "строку, а упадёт на ограничении (этап C)",
    );
  }
  if (!pairUnique && writesByPair) {
    problems.push(
      "schema.prisma: пропало @@unique([subjectKey, locale]), а генератор всё ещё " +
        "адресует строки по этой паре — Prisma отвергнет такой where (этап C)",
    );
  }
  // Обе половины сняты разом — это откат этапа C целиком, и молчать
  // о нём нельзя: без ограничения и без записи по паре генератор
  // снова начнёт плодить строки, а исполнитель — снимать по ролику
  // на каждую (находка аудита этапа C: раньше шов такое пропускал и
  // при этом печатал «уникальна… : нет» в УСПЕШНОЙ строке).
  if (!pairUnique && !writesByPair) {
    problems.push(
      "пара (subjectKey, locale) больше не уникальна и не адресуется по ключу — " +
        "это откат этапа C: строки снова начнут копиться, а исполнитель " +
        "снимать по ролику на каждую",
    );
  }

  // ── Ключи localStorage: бэкенд = фронтенд ────────────────────────
  //
  // Перед загрузкой SPA два прогона в headless-браузере подкладывают
  // выбор человека — снимки мастера и сценарии обучалки. Ключи там
  // КОПИЯ значений фронтенда (у бэкенда нет зависимости на его код,
  // тот же довод, что у `SUPPORTED_LOCALES`), и опечатка в копии не
  // ломает ничего заметного: страница откроется в умолчаниях, снимок
  // подпишется не тем языком, а сценарий чужой локали упадёт на
  // `assertText` «с виду непонятно почему». До правки аудита этапа C
  // литерал был написан дважды руками и не проверялся ничем.
  //
  // Третий ключ (`sessionId`) добавлен вторым боевым прогоном
  // 29.09.2026 и стоит дороже двух первых: мастер подхватывает сессию
  // ТОЛЬКО из него (URL с идентификатором сессии у мастера нет), и
  // опечатка тут не «откроет умолчания», а тихо заведёт новую пустую
  // сессию — сценарий шага 3–9 упадёт на `waitFor` через 15 секунд,
  // назвав селектор вместо причины. Во фронтенде он написан литералом
  // прямо в `useWorkflow.ts`, а не именованной константой, поэтому
  // сверяется своим выражением, а не общим `STORAGE_KEY = '…'`.
  const SPA_KEYS = [
    ["SPA_LOCALE_STORAGE_KEY", "frontend/src/lib/i18n.ts"],
    ["SPA_THEME_STORAGE_KEY", "frontend/src/lib/theme.ts"],
    [
      "SPA_SESSION_STORAGE_KEY",
      "frontend/src/hooks/useWorkflow.ts",
      /localStorage\.getItem\('([^']+)'\)/,
    ],
  ];
  const backendKeys = stripComments(
    read("backend/src/common/spa-storage-keys.ts"),
  );
  let spaKeysChecked = 0;
  for (const [constName, frontFile, frontPattern] of SPA_KEYS) {
    const back = new RegExp(`${constName} = '([^']+)'`).exec(backendKeys)?.[1];
    const front = (frontPattern ?? /STORAGE_KEY = '([^']+)'/).exec(
      stripComments(read(frontFile)),
    )?.[1];
    if (!back || !front) {
      problems.push(
        `не нашёл ключ ${constName} в backend/src/common/spa-storage-keys.ts или ` +
          `STORAGE_KEY в ${frontFile} — шов сверки ключей localStorage ослеп`,
      );
      continue;
    }
    spaKeysChecked++;
    if (back !== front) {
      problems.push(
        `${constName} = «${back}», а ${frontFile} пишет «${front}» — прогон ` +
          (constName === "SPA_SESSION_STORAGE_KEY"
            ? "откроет мастер на НОВОЙ пустой сессии вместо пройденной, и " +
              "сценарий упадёт на waitFor через 15с, назвав селектор вместо причины"
            : "подложит локаль/тему мимо продукта, и отказ будет тихим"),
      );
    }
  }
  // Второй копии литерала быть не должно: константа одна на бэкенд.
  for (const file of walk(path.join(ROOT, "backend/src"))) {
    if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
    const rel = path.relative(ROOT, file);
    if (rel === "backend/src/common/spa-storage-keys.ts") continue;
    const src = stripComments(read(rel));
    if (/'v4c_(locale|theme)'/.test(src)) {
      problems.push(
        `${rel}: литерал ключа localStorage мимо spa-storage-keys.ts — ` +
          "вторая копия разойдётся с фронтендом молча",
      );
    }
    // `'sessionId'` — слишком частая строка, чтобы запрещать её во всём
    // бэкенде (это имя поля в десятке DTO). Ловим только соседство с
    // `localStorage`: другого повода написать её рядом нет.
    if (/localStorage[\s\S]{0,200}?'sessionId'/.test(src)) {
      problems.push(
        `${rel}: ключ сессии написан литералом рядом с localStorage мимо ` +
          "spa-storage-keys.ts — вторая копия разойдётся с useWorkflow.ts молча",
      );
    }
  }

  const ASSEMBLY_MODULE =
    "backend/src/modules/tutorial-runner/tutorial-video-assembly.ts";
  const secondsPerFrameUsers = walk(path.join(ROOT, "backend/src"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))
    .map((f) => path.relative(ROOT, f))
    .filter((rel) => rel !== ASSEMBLY_MODULE)
    .filter((rel) => /\bSECONDS_PER_FRAME\b/.test(stripComments(read(rel))));
  for (const rel of secondsPerFrameUsers) {
    problems.push(
      `${rel} использует SECONDS_PER_FRAME — длительность кадра знает только ` +
        "модуль плана, остальные берут plan.durationMs (этап A)",
    );
  }

  // ── Выход ffmpeg-команды пишется ТОЛЬКО плейсхолдером ──────────
  //
  // Хостед-сервис подставляет путь вместо `{{имя}}` и забирает готовый
  // файл ОТТУДА. Команда, где выход написан голым именем, валидна,
  // локально даёт правильный mp4 — и на сервисе кончается ответом
  // «1 output upload(s) failed: expected output was not created»:
  // ffmpeg положил файл себе, забирать нечего.
  //
  // Именно так сборка обучалки не собрала НИ ОДНОГО ролика с самого
  // этапа A и до боевого прогона 29.09.2026. Читать это по коду было
  // нечем: все остальные строители команд (`postprod.ts`, `reframe.ts`,
  // `watermark.ts`, `poster-frame.ts`) писали плейсхолдер с первого дня,
  // а один — нет, и никакой тип этого не связывал.
  //
  // Правило: в строителе команд имя выхода встречается ТОЛЬКО внутри
  // `{{…}}`. Ищем обратное — `${outputName}` без фигурных скобок.
  const commandBuilders = [
    "backend/src/common/postprod.ts",
    "backend/src/common/reframe.ts",
    "backend/src/common/watermark.ts",
    "backend/src/common/poster-frame.ts",
    "backend/src/modules/tutorial-runner/tutorial-video-assembly.ts",
  ];
  let placeholderOutputs = 0;
  for (const rel of commandBuilders) {
    const src = stripComments(read(rel));
    if (!/\{\{\$\{outputName\}\}\}/.test(src)) {
      problems.push(
        `${rel}: выход ffmpeg-команды не написан плейсхолдером ` +
          "`{{${outputName}}}` — сервис заберёт файл не оттуда, куда его " +
          "положит ffmpeg, и ответит «expected output was not created»",
      );
      continue;
    }
    // Голое `${outputName}` в шаблонной строке рядом с флагами вывода
    // — то самое написание, которое ломало сборку.
    if (/[^{]\$\{outputName\}[^}]/.test(src)) {
      problems.push(
        `${rel}: имя выхода встречается и БЕЗ плейсхолдера — ` +
          "команда запишет файл мимо того пути, откуда сервис его заберёт",
      );
      continue;
    }
    placeholderOutputs++;
  }

  // ── Таймкоды подписей и длина ролика — из одной функции ─────────
  //
  // §5 ТЗ: «таймкоды берутся из того же массива длительностей, что и
  // кадры, — один источник, не два». Второй расчёт разошёлся бы с
  // первым не сразу, а к концу ролика: кадр держится ближайшее ЦЕЛОЕ
  // число кадров при 30 fps, округление идёт посегментно, и ошибка
  // накапливается. Подпись к десятому кадру висела бы над девятым — и
  // это тот сорт поломки, который никто не заметит, пока не станет
  // смотреть ролик целиком.
  //
  // Поэтому перевод секунд в сетку кадров живёт ровно в модуле плана.
  // Всё, что умеет умножать на `OUTPUT_FPS`, обязано быть там же.
  const FPS_MATH_HOME =
    "backend/src/modules/tutorial-runner/tutorial-video-assembly.ts";
  for (const file of walk(path.join(ROOT, "backend/src"))) {
    if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
    const rel = path.relative(ROOT, file);
    if (rel === FPS_MATH_HOME) continue;
    if (/\bOUTPUT_FPS\b/.test(stripComments(read(rel)))) {
      problems.push(
        `${rel} считает по OUTPUT_FPS — сетку кадров знает только модуль ` +
          "плана, остальные берут frameSpansSeconds/plan.durationMs (§5 ТЗ)",
      );
    }
  }
  const captionsSrc = stripComments(
    read("backend/src/modules/tutorial-runner/tutorial-captions.ts"),
  );
  // Проверяются ОБА конца: что функция ввезена именно из модуля
  // плана и что она действительно ВЫЗВАНА. Одного упоминания имени
  // мало — локальная заглушка с тем же именем прошла бы (находка
  // мутации шва).
  const importsSpans =
    /import\s*\{[^}]*\bframeSpansSeconds\b[^}]*\}\s*from\s*['"]\.\/tutorial-video-assembly['"]/.test(
      captionsSrc,
    );
  if (!importsSpans || !/\bframeSpansSeconds\(/.test(captionsSrc)) {
    problems.push(
      "tutorial-captions.ts не зовёт frameSpansSeconds из модуля плана — " +
        "таймкоды подписей обязаны браться из той же сетки, что и " +
        "длительность ролика (§5 ТЗ)",
    );
  }

  // ── Плашка в `.ass` действительно рисуется ───────────────────────
  //
  // `BorderStyle=3` САМОГО ПО СЕБЕ мало: libass строит коробку по
  // `OutlineColour` с полем `Outline`, и ноль там означает «коробки
  // нет вовсе», а `BackColour` при этом стиле уходит на тень. Пара
  // «цвет в BackColour, Outline: 0» выглядит правдоподобно и не
  // рисует ничего — белый текст остаётся белым текстом на светлом
  // кадре.
  //
  // Так было написано в карточках поздравления полтора этапа, и тест
  // рядом дефект пропускал, потому что проверял только `BorderStyle`.
  // Вскрылось отрисовкой при этапе E. Список файлов, выпускающих
  // `.ass`, пинуется целиком: четвёртый обязан прийти сюда и
  // прочитать, обо что споткнулись двое первых.
  const ASS_AUTHORS = [
    "backend/src/common/greeting-cards.ts",
    "backend/src/modules/tutorial-runner/tutorial-captions.ts",
  ];
  let assStyles = 0;
  for (const file of walk(path.join(ROOT, "backend/src"))) {
    if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
    const rel = path.relative(ROOT, file);
    const code = stripComments(read(rel));
    const styles = [...code.matchAll(/`Style: [^`]*`/g)].map((m) => m[0]);
    if (styles.length === 0) continue;
    if (!ASS_AUTHORS.includes(rel)) {
      problems.push(
        `${rel} выпускает строки Style: для .ass, а шов о нём не знает — ` +
          "проверьте, что плашка рисуется (BorderStyle=3 требует ненулевого " +
          "Outline, и цвет её берётся из OutlineColour, а не BackColour)",
      );
      continue;
    }
    for (const style of styles) {
      assStyles++;
      // Поля стиля: 15-е — BorderStyle, 16-е — Outline. Считаем по
      // запятым внутри шаблона.
      const fields = style
        .replace(/^`Style: /, "")
        .replace(/`$/, "")
        .split(",");
      if (fields[15] !== "3") continue;
      const outline = fields[16];
      // ЧИСЛО, а не интерполяция. Первая редакция шва сравнивала с
      // «0» и на `${BOX_PADDING}` молчала — то есть слепла ровно на
      // файле, ради которого писалась (находка аудита этапа E):
      // константу можно было обнулить, не потревожив шов.
      if (!/^\d+(\.\d+)?$/.test(outline)) {
        problems.push(
          `${rel}: поле Outline стиля задано выражением «${outline}», а не ` +
            "числом — шов не может проверить, что плашка вообще рисуется; " +
            "впишите число прямо в строку стиля",
        );
        continue;
      }
      if (Number(outline) === 0) {
        problems.push(
          `${rel}: стиль с BorderStyle=3 и Outline=0 — плашка НЕ нарисуется, ` +
            "libass без ненулевой обводки коробку не строит",
        );
      }
      if (/^&H(FF|ff)/.test(fields[5] ?? "")) {
        problems.push(
          `${rel}: цвет плашки (OutlineColour) полностью прозрачен — ` +
            "при BorderStyle=3 коробку красит именно он, а не BackColour",
        );
      }
    }
  }

  // ── Три решения вокруг сценария не путаются ──────────────────────
  //
  // Их ровно три, и схема их старательно разводит: `approved` —
  // «можно тратить деньги на платные шаги», `narrationReviewedAt` —
  // «текст, который произнесёт диктор, человек прочитал»,
  // `TutorialVideoAsset.reviewed` — «готовый ролик можно показывать
  // людям». Писателей у второго должно быть ровно столько, сколько
  // перечислено ниже, и каждый обязан ответить на вопрос «а не надо
  // ли здесь ещё и снять отметку».
  //
  // Число, а не список имён: имя метода переживёт переименование, а
  // счётчик — нет, и это правильно. Тот, кто заводит четвёртого
  // писателя, обязан прийти сюда и объяснить себе, почему.
  const NARRATION_REVIEW_WRITERS = new Map([
    // Ставит и снимает отметку — сама кнопка в админке.
    [
      "backend/src/modules/tutorial-scenario/tutorial-scenario-admin.service.ts",
      2,
    ],
    // Снимает при перезаписи шагов генератором (только когда шаги
    // изменились: иначе крон снимал бы её каждую ночь).
    [
      "backend/src/modules/tutorial-scenario/tutorial-scenario-generator.service.ts",
      1,
    ],
  ]);
  let narrationReviewWrites = 0;
  for (const file of walk(path.join(ROOT, "backend/src"))) {
    if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
    const rel = path.relative(ROOT, file);
    const code = stripComments(read(rel));
    // По `narrationReviewedBy`, а НЕ по `...At`: второе встречается
    // ещё и в `select`, и в приведении типа строки — это чтения, а
    // шов считает записи. Имя автора отметки пишут только там, где её
    // ставят или снимают.
    const hits = [...code.matchAll(/narrationReviewedBy:/g)].length;
    const expected = NARRATION_REVIEW_WRITERS.get(rel);
    // Ноль пропускается только у файлов, которых шов и не ждал.
    // У ожидаемого писателя ноль — это «перестал снимать отметку», и
    // молчать об этом нельзя: первая редакция шва выходила из цикла
    // раньше проверки и пропускала ровно такую правку.
    if (hits === 0 && expected === undefined) continue;
    narrationReviewWrites += hits;
    if (expected === undefined) {
      problems.push(
        `${rel} пишет narrationReviewedBy, а шов о нём не знает — ` +
          "решений вокруг сценария три (деньги, вычитка, показ), и новый " +
          "писатель обязан сказать, какое из них он меняет",
      );
    } else if (hits !== expected) {
      problems.push(
        `${rel}: записей narrationReviewedBy ${hits}, шов ждёт ${expected} — ` +
          "проверьте, снимается ли отметка там, где переписывается текст",
      );
    }
  }

  // ── Потолок длины реплики — одно число на валидатор и промпт ─────
  //
  // Разойдясь, они дают худший из возможных исходов и делают это
  // молча: модель послушно пишет 240 символов, разбор их выкидывает,
  // кадр остаётся немым, и никто ни на что не жалуется. Поэтому
  // промпт обязан подставлять константу, а не печатать число.
  const NARRATION_LIMIT_FILES = [
    "backend/src/modules/tutorial-scenario/scenario-steps.ts",
    "backend/src/modules/tutorial-scenario/tutorial-scenario-prompt.ts",
  ];
  for (const rel of NARRATION_LIMIT_FILES) {
    const code = stripComments(read(rel));
    if (!/\bMAX_NARRATION_LENGTH\b/.test(code)) {
      problems.push(
        `${rel} не ссылается на MAX_NARRATION_LENGTH — потолок длины реплики ` +
          "обязан быть один на валидатор и промпт (§3-бис.2/§3-бис.3)",
      );
    }
    if (/(?<![\w.])220(?![\w.])/.test(code)) {
      problems.push(
        `${rel} содержит число 220 — потолок реплики берётся из ` +
          "MAX_NARRATION_LENGTH, иначе промпт и валидатор разойдутся молча",
      );
    }
  }

  // ── Реплики читаются по одному правилу на бэкенде и в админке ────
  //
  // Импортировать бэкендовый `narrationOf` админка не может, поэтому
  // копия там неизбежна — но копия, которая разошлась, хуже
  // отсутствия. Расходиться ей есть где: у `triggerPaidOperation`
  // реплики не бывает (служебный маркер), и забыв про это, карточка
  // показала бы оператору реплику, которой в ролике не прозвучит.
  const NARRATION_READERS = [
    [
      "backend/src/modules/tutorial-scenario/scenario-steps.types.ts",
      "narrationOf",
    ],
    ["admin/src/app/tutorial-scenarios/page.tsx", "narrationsOf"],
  ];
  for (const [rel, fnName] of NARRATION_READERS) {
    const whole = stripComments(read(rel));
    // Тело именно ЭТОЙ функции, а не весь файл: `.trim()` в файле
    // найдётся всегда, и проверка «есть ли он где-нибудь» ничего не
    // сторожит — первая редакция шва так и пропускала снятый trim.
    const start = whole.indexOf(`function ${fnName}(`);
    if (start < 0) {
      problems.push(
        `${rel}: не нашлась функция ${fnName} — шов на чтение реплики ` +
          "проверять нечем (поправьте шов, а не код)",
      );
      continue;
    }
    // `{` В КОНЦЕ СТРОКИ — то есть открывающая тело, а не скобка
    // возвращаемого типа (`: { stepNumber: number }[] {`). Первая
    // редакция брала первую попавшуюся и разбирала как «тело» кусок
    // типа — шов при этом ругался на исправный код.
    const open = whole.indexOf("{\n", start);
    let depth = 0;
    let end = open;
    for (; end < whole.length; end++) {
      if (whole[end] === "{") depth++;
      else if (whole[end] === "}" && --depth === 0) break;
    }
    const code = whole.slice(open, end + 1);
    if (!code.includes("triggerPaidOperation")) {
      problems.push(
        `${rel}: чтение реплики не отводит triggerPaidOperation — у него ` +
          "реплики не бывает, а кадр есть (§3-бис.2)",
      );
    }
    if (!/\.trim\(\)/.test(code)) {
      problems.push(
        `${rel}: реплика читается без trim — «   » и отсутствие поля обязаны ` +
          "значить одно и то же, иначе появится третье состояние",
      );
    }
  }

  /**
   * Шов «порядок строгости регистров — один на три файла» (этап B ТЗ
   * Greeting 2.0).
   *
   * `GREETING_REGISTERS` — не просто список значений, а ПОРЯДОК: вся
   * защита «Особого повода» стоит на том, что сигнал может поднять
   * регистр по этому списку и не может опустить (`stricterRegister`
   * сравнивает `indexOf`). Тот же набор живёт ещё в двух местах, куда
   * TypeScript не смотрит: enum в схеме Prisma и `CREATE TYPE` в
   * миграции.
   *
   * Разойтись они могут молча и в опасную сторону. Значение, которое
   * есть в базе и нет в списке, даёт `indexOf === -1`, то есть «мягче
   * всех»: соболезнование прошло бы как праздник. А `REGISTER_POLICY`
   * по такому ключу — `undefined`, и проверка перед рендером падает
   * пятисоткой у самых денег.
   */
  const registerLists = [];
  const schemaEnum = /enum GreetingRegister \{([^}]*)\}/.exec(
    read("backend/prisma/schema.prisma"),
  );
  if (!schemaEnum) {
    problems.push(
      "backend/prisma/schema.prisma: не нашёлся enum GreetingRegister — " +
        "шов на порядок строгости проверять нечем (поправьте шов, а не код)",
    );
  } else {
    registerLists.push([
      "схема Prisma",
      (schemaEnum[1].match(/^\s*([A-Z_]+)/gm) ?? []).map((v) => v.trim()),
    ]);
  }
  const typesArray =
    /GREETING_REGISTERS: readonly GreetingRegister\[\] = \[([^\]]*)\]/.exec(
      read("backend/src/common/types/greeting.types.ts"),
    );
  if (!typesArray) {
    problems.push(
      "backend/src/common/types/greeting.types.ts: не нашёлся массив " +
        "GREETING_REGISTERS — шов на порядок строгости проверять нечем " +
        "(поправьте шов, а не код)",
    );
  } else {
    registerLists.push([
      "types/greeting.types.ts",
      [...typesArray[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]),
    ]);
  }
  const registerMigration = fs
    .readdirSync(migrationsDir)
    .filter((n) => n.endsWith("_greeting_occasion_register"))
    .map((n) => path.join(migrationsDir, n, "migration.sql"))
    .find((f) => fs.existsSync(f));
  if (!registerMigration) {
    problems.push(
      "backend/prisma/migrations: не нашлась миграция *_greeting_occasion_register " +
        "— шов на порядок строгости проверять нечем (поправьте шов, а не код)",
    );
  } else {
    const createType =
      /CREATE TYPE "GreetingRegister" AS ENUM \(([^)]*)\)/.exec(
        fs.readFileSync(registerMigration, "utf8"),
      );
    if (!createType) {
      problems.push(
        `${path.relative(ROOT, registerMigration)}: не нашёлся CREATE TYPE ` +
          '"GreetingRegister" — шов на порядок строгости проверять нечем ' +
          "(поправьте шов, а не код)",
      );
    } else {
      registerLists.push([
        "миграция",
        [...createType[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]),
      ]);
    }
  }
  // Сверяются именно СПИСКИ, а не множества: порядок и есть смысл.
  const registerCount = registerLists[0]?.[1].length ?? 0;
  for (const [where, list] of registerLists.slice(1)) {
    if (list.join(",") !== registerLists[0][1].join(",")) {
      problems.push(
        `порядок строгости регистров разошёлся: ${registerLists[0][0]} — ` +
          `[${registerLists[0][1].join(", ")}], ${where} — [${list.join(", ")}]`,
      );
    }
  }
  if (registerCount === 0) {
    problems.push(
      "список регистров пуст — шов на порядок строгости ничего не сверил",
    );
  }

  /**
   * Шов «группы поводов на лендинге = регистры каталога» (этап H ТЗ
   * Greeting 2.0, §5.2 п.4 и §8.4).
   *
   * Страница поздравлений делит поводы на «Праздники / Без праздника /
   * Деликатные» по регистру, и подпись группы обещает то, что делает
   * политика регистра (шутки, наклейки, праздничная музыка). Регистры на
   * лендинге — копия: пакет не может импортировать бэкенд. Копия, которую
   * никто не сверяет, отстаёт молча — и страница обещает «без шуток» над
   * поводом, где сервер их разрешает. Подробную сверку (обещания групп ↔
   * `REGISTER_POLICY`, тоны) делает `landing/scripts/greeting-occasions.test.ts`;
   * здесь — узкая проверка из корня, чтобы расхождение ловилось и там,
   * где тесты лендинга не гоняют.
   */
  {
    const specs =
      /export const GREETING_OCCASION_SPECS[\s\S]*?> = \{([\s\S]*?)\n\};/.exec(
        read("backend/src/common/greeting-occasions.ts"),
      )?.[1] ?? "";
    const backendReg = new Map(
      [...specs.matchAll(/^ {2}([A-Z_]+): \{[\s\S]*?register: '([A-Z_]+)'/gm)].map(
        (m) => [m[1], m[2]],
      ),
    );
    const copyBody =
      /GREETING_OCCASION_REGISTER = \{([\s\S]*?)\} as const/.exec(
        read("landing/src/lib/greeting-occasions.ts"),
      )?.[1] ?? "";
    const landingReg = new Map(
      [...copyBody.matchAll(/^ {2}([A-Z_]+): '([A-Z_]+)',/gm)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    if (backendReg.size === 0 || landingReg.size === 0) {
      // Молчащий шов хуже отсутствующего: пустой разбор — «всё совпало».
      problems.push(
        "шов групп поводов не разобрал каталог бэкенда или копию лендинга " +
          "(landing/src/lib/greeting-occasions.ts) — поправьте регулярки шва, а не код",
      );
    }
    for (const [code, reg] of backendReg) {
      if (landingReg.get(code) !== reg) {
        problems.push(
          `повод ${code}: в каталоге бэкенда регистр ${reg}, на лендинге ` +
            `${landingReg.get(code) ?? "нет"} — группа на странице обещает не то`,
        );
      }
    }
    for (const code of landingReg.keys()) {
      if (!backendReg.has(code)) {
        problems.push(
          `повод ${code} есть на лендинге (greeting-occasions.ts), но не в каталоге бэкенда`,
        );
      }
    }
  }

  if (problems.length > 0) {
    failed++;
    console.log("FAIL швы советника в мастере:");
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log(
      `ok   швы советника: шаги (${stepperSummary.join(", ")}), пункты ` +
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
        `мест, пишущих тестировщику по тикету: ${callers.length}; ` +
        `имён маршрутов TMA (фронтенд = копия в бэкенде): ${frontRoutes.size}; ` +
        `псевдонимов маршрута с подсевом сессии: ${seededRoutes.size}; ` +
        `псевдонимов по состоянию проекта: ${stateRoutes.size}; отборов сессии ` +
        `мастера товарки, все внутри рекламных проектов: ${sessionPicks}; ` +
        `белый список тем советника: один с обеих сторон; ` +
        `карточек поздравления со своей темой справки: ${cardHooks.length} ` +
        `на ${new Set(topicOf.values()).size} тем; ` +
        `живых позиций степпера поздравления: ${[...liveByRoute.values()].flat().length} ` +
        `на ${liveByRoute.size} экранах; ` +
        `хуков «только после прохода», ни одного на чистом мастере: ${visitedOnlyHooks}; ` +
        `платных операций обучалки под суточным потолком: ${budgetOps.size} ` +
        `(проверок потолка в коде: ${budgetChecks}); ` +
        `OG-карточек обучалки сверено со словарём: ${ogChecked}; ` +
        `локалей с настоящими кадрами мастера: ${shotLocales.size} (файлов ${shotFiles.length}); ` +
        `мест, пишущих длительность ролика обучалки: ${durationWrites} ` +
        `из ${assetWriters.length} писателей актива (все из плана); ` +
        `статусов сборки (бэкенд = админка): ${backendStatuses.size}; ` +
        `заливок обучалки под убираемым префиксом: ${transitUploads}; ` +
        `режимов движения (бэкенд = тип админки = витрина): ${backendMotions.length}; ` +
        `записей расхода обучалки под своими операциями: ${tutorialUsageRecords} ` +
        `(${[...tutorialOps].sort().join(", ")}); ` +
        `мест, знающих префикс готового видео: ${videoPrefixUses}; ` +
        `пара (шаг, локаль) уникальна и пишется по ключу: да; ` +
        `ключей localStorage сверено с фронтендом: ${spaKeysChecked}; ` +
        `мест, пишущих отметку о вычитке реплик: ${narrationReviewWrites}; ` +
        `потолок реплики и правило её чтения — по одному на всех: да; ` +
        `стилей .ass с проверенной плашкой: ${assStyles}; ` +
        `сетку кадров знает только модуль плана: да; ` +
        `строителей ffmpeg-команд с выходом через плейсхолдер: ${placeholderOutputs} из ${commandBuilders.length}; ` +
        `порядок строгости регистров (схема = типы = миграция): ${registerCount} ` +
        `в ${registerLists.length} местах`,
    );
  }
}

/**
 * Шов «отказ, который читает человек» — заведён сквозным аудитом
 * (27.09.2026, находка Д-5).
 *
 * Фронтенд показывает пользователю ТЕКСТ отказа с сервера как есть:
 * `errorMessage()` в `frontend/src/services/projects-api.ts` берёт
 * `error.message` из конверта и только при его отсутствии подставляет
 * свой переведённый текст. То есть каждая английская строка в
 * пользовательском (не админском) модуле — это английская строка в
 * русском интерфейсе, а `${projectId}` в ней — внутренний UUID на
 * экране у человека, по которому он ничего сделать не может.
 *
 * Проверяются только модули, куда ходит TMA. Админские файлы
 * (`*-admin.*`) исключены сознательно: оператору идентификатор строки
 * как раз нужен, а язык админки — русский по построению.
 */
function checkUserFacingErrorSeams() {
  const DIRS = [
    "backend/src/modules/client-site-tutorial",
    "backend/src/modules/postprod",
    "backend/src/modules/tutorial-runner",
  ];
  const EXCEPTIONS =
    /new (NotFoundException|BadRequestException|ForbiddenException|ConflictException)\(\s*((`[^`]*`)|('[^']*')|("[^"]*")|([A-Z][A-Z0-9_]*))/g;
  // Подстановка именно идентификатора — `${id}`, `${projectId}`,
  // `${sessionId}`, `${draftId}`. Числа лимитов, селекторы и текст
  // чужой ошибки — это содержательные подстановки, они остаются.
  const ID_SUBST = /\$\{[^}]*\b[Ii]d\b[^}]*\}|\$\{\s*id\s*\}|\$\{[^}]*Id\s*\}/;

  // Общие тексты (`backend/src/common/user-facing-errors.ts`) — такой
  // же законный аргумент, как литерал: это те же русские строки, просто
  // названные один раз на все сорок с лишним мест. Имена собираются из
  // самого файла, а не перечисляются здесь: список, который надо
  // помнить руками, — ровно то, от чего этот шов и заводился.
  const sharedSrc = read("backend/src/common/user-facing-errors.ts");
  const shared = new Set();
  const problems = [];
  for (const m of sharedSrc.matchAll(
    /export const ([A-Z][A-Z0-9_]*) = '([^']*)'/g,
  )) {
    shared.add(m[1]);
    // Проверяется КАЖДЫЙ экспорт, а не только русские. Собирать
    // «только те, что с кириллицей» — дыра, которую нашла мутация:
    // английский текст просто выпадал бы из набора, и молча.
    if (!/[а-яА-ЯёЁ]/.test(m[2])) {
      problems.push(
        `backend/src/common/user-facing-errors.ts: ${m[1]} = '${m[2]}' — ` +
          "общий текст отказа без единой русской буквы; его читает " +
          "пользователь в русском интерфейсе",
      );
    }
    if (ID_SUBST.test(m[2]) || m[2].includes("${")) {
      problems.push(
        `backend/src/common/user-facing-errors.ts: ${m[1]} подставляет ` +
          "что-то внутрь текста — общий отказ обязан быть постоянной строкой",
      );
    }
  }
  if (shared.size === 0) {
    problems.push(
      "backend/src/common/user-facing-errors.ts: ни одной константы — " +
        "либо файл переписали, либо шов больше ничего не стережёт",
    );
  }

  let checked = 0;
  let viaShared = 0;
  for (const dir of DIRS) {
    const files = walk(path.join(ROOT, dir)).filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".spec.ts") &&
        !/-admin\.|\/admin-/.test(f),
    );
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(EXCEPTIONS)) {
        checked++;
        const msg = m[2];
        if (/^[A-Z][A-Z0-9_]*$/.test(msg)) {
          if (shared.has(msg)) {
            viaShared++;
            continue;
          }
          problems.push(
            `${rel}: отказ собран из константы ${msg}, которой нет среди ` +
              "русских текстов в backend/src/common/user-facing-errors.ts",
          );
          continue;
        }
        if (!/[а-яА-ЯёЁ]/.test(msg)) {
          problems.push(
            `${rel}: отказ без единой русской буквы — ${msg}; ` +
              "его прочитает пользователь, а не только лог",
          );
        }
        if (ID_SUBST.test(msg)) {
          problems.push(
            `${rel}: в тексте отказа подставляется идентификатор — ${msg}; ` +
              "человеку он ничего не говорит, а наружу светить его незачем",
          );
        }
      }
    }
  }

  // Две самые частые семьи закрыты целиком по всему бэкенду (аудит
  // 27.09.2026, находка Д-5), поэтому они проверяются не только в трёх
  // каталогах выше: вернуть `Session ${id} not found` в любом
  // пользовательском модуле теперь нельзя.
  const OLD_FAMILIES =
    /new \w+Exception\(\s*(`(Session|Project) \$\{[^}]*\} not found`|'Session not found')/g;
  let families = 0;
  for (const file of walk(path.join(ROOT, "backend/src")).filter(
    (f) =>
      f.endsWith(".ts") &&
      !f.endsWith(".spec.ts") &&
      !/-admin\.|\/admin-|\/admin-panel\//.test(f),
  )) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(OLD_FAMILIES)) {
      families++;
      problems.push(
        `${path.relative(ROOT, file)}: вернулся английский отказ с ` +
          `идентификатором — ${m[1]}; текст берётся из ` +
          "backend/src/common/user-facing-errors.ts",
      );
    }
  }

  if (problems.length > 0) {
    failed++;
    console.log("FAIL тексты отказов, которые видит пользователь:");
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log(
      `ok   тексты отказов пользовательских модулей: проверено ${checked} ` +
        `(из них ${viaShared} через общие константы), все по-русски и без ` +
        `внутренних идентификаторов; английских «… not found» с ` +
        `идентификатором по бэкенду: ${families}`,
    );
  }
}

/**
 * Шов «хуки data-qa» — этап I ТЗ docs-tz/TZ-Tutorial-Video-Voiced.md.
 *
 * Сценарии обучалки кликают только по хукам из каталога бэкенда
 * (`tutorial-scenario/qa-hooks.ts`): его перечисляет промпт генератора,
 * по нему же валидатор отвергает всё остальное. Каталог — копия
 * атрибутов фронтенда (пакеты без кросс-импорта, тот же довод, что у
 * `route-templates.ts`). До этапа копия расходилась с продуктом
 * полностью: промпт звал писать `[data-qa="..."]`, а нужных хуков во
 * фронтенде не было ни одного, и ни один ролик не собирался.
 *
 * Держит в обе стороны:
 *  - каждый ключ каталога есть во `frontend/src` буквально —
 *    `data-qa="ключ"` или `'ключ'` (таблицы хуков степперов и вкладок);
 *  - каждый `data-qa="…"` фронтенда либо в каталоге, либо в коротком
 *    списке «не для сценариев» с причиной — иначе новый хук видит
 *    только тот, кто его поставил, а модель о нём не узнает;
 *  - промпт берёт список из каталога, а не пишет его сам.
 */
function checkQaHookSeams() {
  const problems = [];
  const CATALOG = "backend/src/modules/tutorial-scenario/qa-hooks.ts";
  const catalogSrc = stripComments(read(CATALOG));
  const keys = [...catalogSrc.matchAll(/^ {2}'([a-z0-9-]+)': \{/gm)].map(
    (m) => m[1],
  );
  if (keys.length === 0) {
    problems.push(`${CATALOG}: не нашёл ни одного ключа — шов ослеп`);
  }
  // Хуки, которые сценариям обучалки не предлагаются намеренно.
  const NOT_FOR_SCENARIOS = new Map([
    [
      "client-site-explore",
      "мастер обучалки по сайту заказчика: съёмочные шаги лендинга, не шаги обучалки мастера",
    ],
    // Лист справки — это то, что ПОКАЗЫВАЕТ обучалку, а не то, что она
    // снимает. Сценарий, открывающий справку, снял бы ролик про ролик.
    [
      "tutorial-help-play",
      "кнопка «посмотреть ролик» в листе справки: обучалка её не снимает — она из неё и состоит",
    ],
    [
      "tutorial-help-video",
      "сам проигрыватель в листе справки, по той же причине",
    ],
  ]);

  const frontFiles = walk(path.join(ROOT, "frontend/src")).filter((f) =>
    /\.tsx?$/.test(f),
  );
  const corpus = frontFiles
    .map((f) => stripComments(fs.readFileSync(f, "utf8")))
    .join("\n");
  for (const key of keys) {
    if (!corpus.includes(`data-qa="${key}"`) && !corpus.includes(`'${key}'`)) {
      problems.push(
        `хук «${key}» есть в каталоге, но во frontend/src его нет — модель ` +
          "напишет селектор, которого нет на экране, и сценарий упадёт ночью",
      );
    }
  }
  const catalog = new Set(keys);
  const inFront = new Set(
    [...corpus.matchAll(/data-qa="([a-z0-9-]+)"/g)].map((m) => m[1]),
  );
  for (const key of inFront) {
    if (!catalog.has(key) && !NOT_FOR_SCENARIOS.has(key)) {
      problems.push(
        `frontend/src ставит data-qa="${key}", а в ${CATALOG} его нет — ` +
          "допишите в каталог или в NOT_FOR_SCENARIOS этого шва с причиной",
      );
    }
  }
  /**
   * Достижимость: маршрут в каталоге против НАСТОЯЩИХ условий
   * отрисовки (разбор 29.09.2026).
   *
   * Каталог до этого дня объявлял все двадцать девять хуков мастера
   * живущими на `generate-ready`, и десять из них там не появлялись
   * никогда: карточку релевантности и кнопку «Сгенерировать промпт»
   * прячет написанный промпт, всю форму запуска рендера — готовый
   * ролик. Утверждение было машинно-читаемым (из каталога берут
   * промпт и валидатор), поэтому ошибка тиражировалась в каждый
   * сгенерированный сценарий, а падала как «waitFor 15000ms
   * exceeded» — причина, по которой её пять прогонов подряд
   * объясняли не тем.
   *
   * Шов идёт от ЭКРАНА, а не от каталога: находит блок под условием
   * «ролика ещё нет», выбирает из него все `data-qa` и требует, чтобы
   * каталог отправлял ровно их на `generate-ready-to-render`. Уедет
   * условие во фронтенде — шов покажет расхождение до прогона, а не
   * после.
   */
  const WIZARD = "frontend/src/features/generation/GenerationWizard.tsx";
  const wizardSrc = stripComments(read(WIZARD));
  const routeOf = new Map(
    [
      ...catalogSrc.matchAll(
        /^ {2}'([a-z0-9-]+)': \{\s*\n\s*route: '([a-z-]+)'/gm,
      ),
    ].map((m) => [m[1], m[2]]),
  );

  /** Кусок JSX под условием: от места совпадения до баланса скобок. */
  const guardedRegion = (marker) => {
    const at = wizardSrc.indexOf(marker);
    if (at < 0) return null;
    const open = wizardSrc.indexOf("(", at);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < wizardSrc.length; i += 1) {
      if (wizardSrc[i] === "(") depth += 1;
      else if (wizardSrc[i] === ")") {
        depth -= 1;
        if (depth === 0) return wizardSrc.slice(open, i + 1);
      }
    }
    return null;
  };

  const LAUNCH_GUARD = "generatedVideo?.status !== 'complete'";
  const launchCard = guardedRegion(LAUNCH_GUARD);
  if (!launchCard) {
    problems.push(
      `${WIZARD}: не нашёл блок под условием «${LAUNCH_GUARD}» — шов ` +
        "достижимости ослеп, а каталог снова может обещать экраны, " +
        "которых нет",
    );
  } else {
    // Разметкой И компонентами. `AspectRatioPicker` и
    // `ReferenceSlotsPanel` держат свои `data-qa` у себя, в карточке
    // стоит только вызов, — и первая версия этого шва честно на них
    // и споткнулась, объявив оба хука «в карточке нет». Считать это
    // ошибкой каталога было бы неверно: в карточке они есть, просто
    // через один уровень.
    const hooksOfComponent = (name) => {
      const file = frontFiles.find((f) => path.basename(f) === `${name}.tsx`);
      if (!file) return [];
      return [
        ...stripComments(fs.readFileSync(file, "utf8")).matchAll(
          /data-qa="([a-z0-9-]+)"/g,
        ),
      ].map((m) => m[1]);
    };
    const inCard = new Set(
      [...launchCard.matchAll(/data-qa="([a-z0-9-]+)"/g)].map((m) => m[1]),
    );
    for (const m of launchCard.matchAll(/<([A-Z][A-Za-z0-9]*)/g)) {
      for (const hook of hooksOfComponent(m[1])) inCard.add(hook);
    }
    for (const hook of inCard) {
      const route = routeOf.get(hook);
      if (!route) continue;
      if (route !== "generate-ready-to-render") {
        problems.push(
          `хук «${hook}» стоит внутри карточки запуска рендера (её прячет ` +
            `готовый ролик), но каталог отправляет его на «${route}» — ` +
            "сценарий будет ждать его на экране, где его не бывает",
        );
      }
    }
    for (const [hook, route] of routeOf) {
      if (route !== "generate-ready-to-render") continue;
      if (!inCard.has(hook)) {
        problems.push(
          `каталог отправляет «${hook}» на generate-ready-to-render, но в ` +
            "карточке запуска рендера его нет — либо хук переехал, либо " +
            "маршрут выбран наугад",
        );
      }
    }
  }

  // Вторая группа — компонентами, а не разметкой: `RelevancePanel`
  // держит три своих хука внутри себя, поэтому проверяется МЕСТО ЕЁ
  // ВЫЗОВА и кнопка генерации промпта рядом.
  const PROMPT_GUARD = "!prompt && !onTemplate";
  const beforePrompt = guardedRegion(PROMPT_GUARD);
  if (!beforePrompt || !/<RelevancePanel/.test(beforePrompt)) {
    problems.push(
      `${WIZARD}: карточка релевантности больше не стоит под условием ` +
        `«${PROMPT_GUARD}» — значит правило «её прячет написанный промпт» ` +
        "устарело, и маршрут generate-prompt-pending надо пересмотреть",
    );
  }
  for (const hook of [
    "relevance-panel",
    "relevance-check",
    "prompt-generate",
  ]) {
    if (routeOf.get(hook) !== "generate-prompt-pending") {
      problems.push(
        `хук «${hook}» виден только пока промпт не написан, но каталог ` +
          `отправляет его на «${routeOf.get(hook) ?? "—"}»`,
      );
    }
  }

  /**
   * Формат съёмки — один владелец на всех (29.09.2026).
   *
   * Съёмщиков кадров у продукта четыре, и до этого дня размер 390×844
   * был записан в двух местах литералом, а плотность — в трёх, причём
   * в четвёртом её не было вовсе. Намерение «пусть у всех будет
   * одинаково» держал доккомментарий («те же 390×844, что у
   * ui-snapshot-runner»), а не код: геометрия совпадала, плотность
   * разошлась, и кадры обучалки по сайту заказчика приходили на холст
   * 720 растянутыми почти вдвое. В CI это видно не было — только в
   * готовом ролике, глазами.
   *
   * Шов идёт от ВЫЗОВА `setViewport`, а не от списка файлов: новый
   * съёмщик добавляется одной строкой, и список файлов устарел бы
   * молча. Каждый вызов обязан брать размер из `CAPTURE_VIEWPORT`.
   *
   * Плотность проверяется мягче — «литеральной двойки рядом нет»:
   * `ui-snapshot-runner` берёт её из параметра прогона осознанно
   * (отпечатки сравниваются на плотности 1, двойка допустима только с
   * `unmasked`), а `chromium-page-explorer` не задаёт её вовсе и
   * объясняет почему.
   */
  const shooters = [];
  for (const file of walk(path.join(ROOT, "backend/src")).filter(
    (f) => /\.ts$/.test(f) && !/\.spec\.ts$/.test(f),
  )) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    const calls = [...src.matchAll(/\.setViewport\(([\s\S]{0,160}?)\)/g)];
    for (const call of calls) {
      // Объявление в интерфейсе-двойнике puppeteer — не съёмка.
      if (/^v:/.test(call[1].trim())) continue;
      shooters.push({
        file: path.relative(ROOT, file),
        arg: call[1],
        src,
      });
    }
  }
  if (shooters.length === 0) {
    problems.push(
      "не нашёл ни одного вызова setViewport в backend/src — шов формата " +
        "съёмки ослеп",
    );
  }
  for (const shooter of shooters) {
    const usesViewport =
      /CAPTURE_VIEWPORT/.test(shooter.arg) ||
      // Через локальную переменную — тогда она обязана быть присвоена
      // из общего владельца в том же файле.
      /=\s*CAPTURE_VIEWPORT\b/.test(shooter.src);
    if (!usesViewport) {
      problems.push(
        `${shooter.file}: setViewport не берёт размер из CAPTURE_VIEWPORT — ` +
          "съёмщики продукта обязаны давать один размер кадра, иначе " +
          "`concat` слайд-шоу получает разнокалиберные кадры",
      );
    }
  }
  // Плотность числом — ГДЕ УГОДНО в исходниках, а не только в
  // аргументе `setViewport`. Первая версия этого шва смотрела только
  // туда и пережила мутацию: `tutorial-frames-capture.service.ts`
  // задаёт плотность не съёмкой, а ПАРАМЕТРОМ чужого прогона
  // (`this.runner.run({ deviceScaleFactor: 2 })`), то есть литерал
  // жил у вызывающего. Тот же промах, что у швов S1/S2 и у первой
  // проверки таймаута сборки: искал имя там, где его удобно искать, а
  // не там, где принимается решение.
  //
  // Строки сообщений не считаются: `stripComments` их оставляет, а
  // текст «deviceScaleFactor: 2 допустим только с unmasked» в
  // `ui-snapshot-admin.controller.ts` — объяснение оператору, не
  // настройка.
  for (const file of walk(path.join(ROOT, "backend/src")).filter(
    (f) => /\.ts$/.test(f) && !/\.spec\.ts$/.test(f),
  )) {
    const src = stripComments(fs.readFileSync(file, "utf8")).replace(
      /(['"`])(?:\\.|(?!\1)[\s\S])*\1/g,
      "''",
    );
    if (!/deviceScaleFactor:\s*\d/.test(src)) continue;
    problems.push(
      `${path.relative(ROOT, file)}: плотность съёмки задана числом — она ` +
        "выводится из холста (CAPTURE_DEVICE_SCALE_FACTOR), и литерал " +
        "однажды разойдётся с ним молча",
    );
  }
  // И сама плотность обязана остаться ПРОИЗВОДНОЙ от холста.
  const assemblySrc = stripComments(
    read("backend/src/modules/tutorial-runner/tutorial-video-assembly.ts"),
  );
  if (
    !/CAPTURE_DEVICE_SCALE_FACTOR = Math\.ceil\(\s*CANVAS\.width \/ CAPTURE_VIEWPORT\.width/.test(
      assemblySrc,
    )
  ) {
    problems.push(
      "CAPTURE_DEVICE_SCALE_FACTOR перестал выводиться из CANVAS — число " +
        "вместо выражения переживёт смену холста и оставит кадры " +
        "растянутыми",
    );
  }

  /**
   * У префикса `tutorial-video-frames/` несколько владельцев, и метла
   * обязана знать ВСЕХ (аудит собственных правок 29.09.2026).
   *
   * Общий префикс — осознанное решение продукта: дальше по конвейеру
   * оба вида кадров собирает один и тот же внешний ffmpeg-api. Но
   * `orphanSweepPlan` считает сиротой владельца, которого нет в базе,
   * а «база» для этой области — это перечень таблиц в одной ветке
   * `cron-jobs.service.ts`. Первая редакция знала только
   * `tutorialVideoAsset` и сносила кадры ЖИВЫХ черновиков обучалки по
   * сайту заказчика — молча, через несколько ночей после создания.
   *
   * Шов считает ПРОИЗВОДИТЕЛЕЙ путей под этим префиксом и требует
   * столько же таблиц в ветке метлы. Третий потребитель добавится —
   * CI покажет расхождение до того, как метла до него доберётся.
   */
  // Владелец — это ВИД ключа, а не место в коде: `draftId` из двух
  // разных файлов — один владелец, а не два. Первая редакция этого шва
  // считала пары «файл:переменная» и получала три при двух владельцах —
  // и совпадала с тремя `findMany`, выхваченными из чужой ветки
  // тернарника. Два неверных счёта дали зелёный результат; это хуже,
  // чем красный, потому что не заставляет посмотреть.
  const frameOwners = new Set();
  for (const file of walk(path.join(ROOT, "backend/src")).filter(
    (f) => /\.ts$/.test(f) && !/\.spec\.ts$/.test(f),
  )) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    for (const m of src.matchAll(/`tutorial-video-frames\/\$\{(\w+)\}\//g)) {
      frameOwners.add(m[1]);
    }
  }
  const sweepSrc = stripComments(
    read("backend/src/modules/cron/cron-jobs.service.ts"),
  );
  // Ровно ПОСЛЕДНЯЯ ветка тернарника — та, что резолвит владельцев
  // этой области. Брать от первого упоминания строки значило бы
  // прихватить соседние ветки и посчитать чужие таблицы своими.
  const framesFn =
    /private async liveFrameOwners[\s\S]*?\n  \}/.exec(sweepSrc)?.[0] ?? "";
  const sweepTables = new Set(
    [...framesFn.matchAll(/this\.prisma\.(\w+)\.findMany/g)].map((m) => m[1]),
  );
  if (frameOwners.size === 0 || sweepTables.size === 0) {
    problems.push(
      "шов владельцев префикса tutorial-video-frames/ ослеп: владельцев " +
        `${frameOwners.size}, таблиц ${sweepTables.size}`,
    );
  } else if (sweepTables.size < frameOwners.size) {
    problems.push(
      `под префиксом tutorial-video-frames/ пишут ${frameOwners.size} вида ` +
        `владельцев (${[...frameOwners].join(", ")}), а метла спрашивает ` +
        `${sweepTables.size} таблиц(ы) (${[...sweepTables].join(", ")}) — ` +
        "владелец, о котором она не знает, считается сиротой, и его кадры " +
        "будут удалены",
    );
  }

  /**
   * Полигон для разведчика чужих сайтов и его каталог (29.09.2026).
   *
   * У обучалки по сайту заказчика нет оракула: сайт чужой, список
   * элементов закрыть нельзя, и «нашёл три поля» — это много или мало,
   * сказать нечем. Полигон возвращает оракул тем, что его DOM наш.
   *
   * Но оракул стоит ровно столько, сколько стоит его соответствие
   * странице: каталог, отставший от разметки, превращает проверку
   * разведки в проверку двух копий одного вранья. Поэтому шов держит
   * их в обе стороны — как `qa-hooks` держит каталог мастера.
   */
  const SANDBOX_PAGE = "landing/src/app/qa/site-sandbox/SandboxClient.tsx";
  const sandboxSrc = stripComments(read(SANDBOX_PAGE));
  const sandboxCatalogSrc = stripComments(
    read("backend/src/modules/client-site-tutorial/sandbox-catalog.ts"),
  );
  const inPage = new Set(
    [...sandboxSrc.matchAll(/data-qa="([a-z0-9-]+)"/g)].map((m) => m[1]),
  );
  const inCatalog = new Set(
    [...sandboxCatalogSrc.matchAll(/hook: '([a-z0-9-]+)'/g)].map((m) => m[1]),
  );
  if (inPage.size === 0 || inCatalog.size === 0) {
    problems.push(
      `шов полигона ослеп: на странице ${inPage.size} элементов, в ` +
        `каталоге ${inCatalog.size}`,
    );
  }
  for (const hook of inPage) {
    if (!inCatalog.has(hook)) {
      problems.push(
        `элемент «${hook}» есть на полигоне, но не в каталоге — значит ` +
          "оракул разведки его не ждёт, и потерянный элемент останется " +
          "незамеченным",
      );
    }
  }
  for (const hook of inCatalog) {
    if (!inPage.has(hook)) {
      problems.push(
        `каталог полигона ждёт «${hook}», а на странице его нет — ` +
          "проверка разведки провалится не потому, что разведка плоха",
      );
    }
  }
  // Путь полигона — копия литерала, как и остальные копии в проекте.
  const sandboxPath =
    /SANDBOX_PATH = '([^']+)'/.exec(sandboxCatalogSrc)?.[1] ?? "";
  if (
    !sandboxPath ||
    !fs.existsSync(path.join(ROOT, `landing/src/app${sandboxPath}/page.tsx`))
  ) {
    problems.push(
      `SANDBOX_PATH = «${sandboxPath}» не соответствует ни одному ` +
        "маршруту лендинга — черновик полигона открылся бы на 404",
    );
  }
  // И полигон обязан быть закрыт от обхода: страница служебная, с
  // формой входа и кнопкой «Удалить аккаунт».
  const robotsSrc = stripComments(read("landing/src/app/robots.ts"));
  if (!/'\/qa\/'/.test(robotsSrc)) {
    problems.push(
      "landing/src/app/robots.ts не закрывает /qa/ — полигон с формой " +
        "входа попал бы в выдачу",
    );
  }

  /**
   * Дойдёт ли до полигона ЗАПРОС. Проверять существование файла
   * страницы мало — это и подвело: файл лежал на месте, каталог и
   * страница сходились, `Disallow: /qa/` стоял, а `/qa/site-sandbox`
   * с первого дня отвечал 404. Middleware лендинга дописывает префикс
   * локали всем путям, кроме перечисленных в `matcher`, и путь уезжал
   * на `/ru/qa/site-sandbox`, которого нет: страница живёт вне
   * сегмента `[locale]` — и правильно живёт, переводить полигон
   * незачем. Нашлось это только тогда, когда страницу впервые открыли.
   */
  const middlewareSrc = read("landing/src/middleware.ts");
  const matcher = /matcher:\s*\[\s*'([^']+)'/.exec(middlewareSrc)?.[1] ?? "";
  if (!matcher) {
    problems.push(
      "landing/src/middleware.ts: не нашёлся matcher — шов на " +
        "достижимость полигона проверять нечем (поправьте шов, а не код)",
    );
  } else {
    // Первый сегмент пути (`qa` у `/qa/site-sandbox`) обязан быть в
    // списке исключений — и со слэшем, как `r/`: голое `qa` совпало бы
    // с началом любого пути на «qa».
    const head = sandboxPath.replace(/^\//, "").split("/")[0];
    if (!matcher.includes(`${head}/`)) {
      problems.push(
        `middleware лендинга не исключает «${head}/» из локаль-редиректа ` +
          `— запрос к ${sandboxPath} уедет на /<локаль>${sandboxPath} и ` +
          "получит 404, как это было до 29.09.2026",
      );
    }
  }

  /**
   * Пол оседания разведчика — ВЫШЕ задержки ленивого блока полигона.
   *
   * Ленивый блок для того на полигоне и живёт: он изображает
   * содержимое, которое приходит не из сети, а по таймеру, и которого
   * поэтому не дождётся никакое ожидание сети. Замер 29.09.2026:
   * блок появлялся на 1000-й мс, `networkidle2` отпускал на 990-й — и
   * попадёт блок в кадр или нет, решали десять миллисекунд. Пол сделал
   * это правилом; если пол опустится ниже задержки (или задержку
   * поднимут выше пола), полигон перестанет проверять оседание,
   * оставшись с виду прежним.
   */
  const pageDelay = Number(
    /SANDBOX_LATE_BLOCK_MS = (\d+)/.exec(
      read(`landing/src/app${sandboxPath}/SandboxClient.tsx`),
    )?.[1],
  );
  const catalogDelay = Number(
    /SANDBOX_LATE_BLOCK_MS = (\d+)/.exec(sandboxCatalogSrc)?.[1],
  );
  const settleFloor = Number(
    /SETTLE_FLOOR_MS = ([\d_]+)/
      .exec(
        read(
          "backend/src/modules/client-site-tutorial/chromium-page-explorer.ts",
        ),
      )?.[1]
      ?.replace(/_/g, ""),
  );
  if (!pageDelay || !catalogDelay || !settleFloor) {
    problems.push(
      "не нашлись SANDBOX_LATE_BLOCK_MS (страница/каталог) или " +
        "SETTLE_FLOOR_MS — шов на оседание проверять нечем (поправьте " +
        "шов, а не код)",
    );
  } else {
    if (pageDelay !== catalogDelay) {
      problems.push(
        `задержка ленивого блока разошлась: на странице ${pageDelay} мс, ` +
          `в каталоге ${catalogDelay} мс`,
      );
    }
    if (settleFloor <= pageDelay) {
      problems.push(
        `пол оседания разведчика (${settleFloor} мс) не выше задержки ` +
          `ленивого блока полигона (${pageDelay} мс) — полигон перестал ` +
          "проверять то, ради чего в нём этот блок",
      );
    }
  }

  const promptSrc = stripComments(
    read("backend/src/modules/tutorial-scenario/tutorial-scenario-prompt.ts"),
  );
  if (!/\bQA_HOOKS\b/.test(promptSrc) || !/\bknownQaHook\b/.test(promptSrc)) {
    problems.push(
      "tutorial-scenario-prompt.ts не берёт селекторы из QA_HOOKS или не " +
        "проверяет их knownQaHook — промпт и валидатор разойдутся с каталогом",
    );
  }

  /*
   * Пометка «элемента может не быть» обязана называть настоящую
   * переменную окружения (четвёртый боевой прогон 29.09.2026).
   *
   * `absentWhen` — строка, и строка едет в промпт как причина. Значит
   * она стареет молча: переименовали переменную в `configuration.ts`
   * — и каталог продолжает уверенно называть несуществующую. Оператор
   * идёт заводить `PIXABAY_API_KEY`, которого код уже не читает, и не
   * понимает, почему карточка не появилась.
   *
   * Поэтому: каждое имя в ВЕРХНЕМ РЕГИСТРЕ внутри `absentWhen` должно
   * читаться в `configuration.ts` как `process.env.ИМЯ`. Это же
   * требование заодно держит саму пометку конкретной: «стенд не
   * настроен» без имени переменной шов не пропустит.
   */
  const CONFIG = "backend/src/config/configuration.ts";
  const configSrc = read(CONFIG);
  const rawMarks = (catalogSrc.match(/^ {4}absentWhen: \{/gm) ?? []).length;
  const marks = [
    ...catalogSrc.matchAll(
      /^ {2}'([a-z0-9-]+)': \{(?:(?!^ {2}')[\s\S])*?absentWhen: \{([\s\S]*?)\n {4}\},/gm,
    ),
  ];
  if (marks.length !== rawMarks) {
    problems.push(
      `${CATALOG}: пометок absentWhen ${rawMarks}, разобрано ${marks.length} — ` +
        "шов ослеп на остальные, поправьте шов, а не код",
    );
  }
  const envNames = [];
  for (const [, key, body] of marks) {
    const env = /\benv: '([^']+)'/.exec(body);
    const why = /\bwhy:\s*\n?\s*'([^']+)'/.exec(body);
    if (!why || why[1].length < 30) {
      problems.push(
        `${CATALOG}: «${key}» помечен absentWhen, но причина пуста или ` +
          "коротка — она едет в промпт, и по ней модель решает, обходить " +
          "элемент или торговаться",
      );
    }
    if (!env) continue;
    envNames.push(env[1]);
    if (!configSrc.includes(`process.env.${env[1]}`)) {
      problems.push(
        `${CATALOG}: «${key}» ссылается на ${env[1]}, но ${CONFIG} такой ` +
          "переменной не читает — пометка устарела вместе с кодом",
      );
    }
    if (!why || !why[1].includes(env[1])) {
      problems.push(
        `${CATALOG}: «${key}» объявил env ${env[1]}, но причина его не ` +
          "называет — оператор прочтёт в промпте «стенд не настроен» и не " +
          "поймёт, что заводить",
      );
    }
  }

  if (problems.length > 0) {
    failed++;
    console.log("FAIL хуки data-qa для сценариев обучалки:");
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log(
      `ok   хуки data-qa: ${keys.length} в каталоге, все найдены во ` +
        `frontend/src; атрибутов data-qa во фронтенде: ${inFront.size} ` +
        `(вне каталога намеренно: ${NOT_FOR_SCENARIOS.size}); промпт и ` +
        "валидатор берут каталог; достижимость сверена с условиями " +
        `отрисовки: ${[...routeOf.values()].filter((r) => r.startsWith("generate")).length} хуков мастера ` +
        `на ${new Set([...routeOf.values()].filter((r) => r.startsWith("generate"))).size} экранах; ` +
        `съёмщиков кадров: ${shooters.length}, все берут формат из одного ` +
        `места; владельцев префикса кадров: ${frameOwners.size}, метла знает ` +
        `${sweepTables.size} таблиц(ы); элементов полигона: ${inPage.size}, ` +
        "каталог и страница сходятся; полигон достижим мимо локаль-" +
        `редиректа, пол оседания ${settleFloor} мс выше ленивого блока ` +
        `${pageDelay} мс; условных хуков: ${marks.length}, из них от настройки ` +
        `стенда ${envNames.length} (${envNames.join(", ") || "—"}), живые`,
    );
  }
}

checkUserFacingErrorSeams();

checkQaHookSeams();

checkGuideSeams();

/**
 * Шов «голос не остаётся у провайдера» — Условия, пункт 3.4, редакция
 * 2026-09-29.
 *
 * Условия теперь ОБЕЩАЮТ пользователю: аудиозапись голосового ввода «не
 * передаётся на хранение ИИ-провайдеру». Верно это по построению одной
 * строки: `voice-transcription.service.ts` отдаёт звук Gemini как
 * `inlineData` — внутри запроса, файлом у провайдера он не ложится. Files
 * API Gemini (`files.upload`, ссылка `fileData`/`fileUri`) хранит файл у
 * Google до двух суток; одна «оптимизация» под длинные записи — и
 * юридический текст молча становится неправдой.
 *
 * Поэтому: в модуле голоса есть `inlineData` и нет ни одного пути к
 * Files API. Правка, которой это понадобится, обязана сначала сменить
 * Условия — шов напоминает ровно об этом.
 */
function checkVoiceRetentionSeam() {
  const problems = [];
  const DIR = "backend/src/modules/voice";
  const files = fs
    .readdirSync(path.join(ROOT, DIR))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"));
  let inline = 0;
  for (const f of files) {
    const src = stripComments(read(`${DIR}/${f}`));
    if (/\binlineData\b/.test(src)) inline++;
    const hit = src.match(/\bfiles\.upload\b|\bfileData\b|\bfileUri\b/);
    if (hit) {
      problems.push(
        `${DIR}/${f}: «${hit[0]}» — запись ляжет файлом у ИИ-провайдера, а ` +
          "Условия (3.4, редакция 2026-09-29) обещают обратное. Сначала " +
          "Условия, потом код",
      );
    }
  }
  if (inline === 0) {
    problems.push(
      `${DIR}: не нашёл ни одного inlineData — либо голос ушёл другим путём ` +
        "(и обещание Условий не проверено), либо шов ослеп: поправьте шов",
    );
  }
  // Soniox хранит загруженный файл и транскрипт, пока их не удалят
  // (решение владельца 29.09.2026 — Soniox вариантом распознавания).
  // Обещание Условий держится только уборкой в `finally`: файл, где
  // звук уходит к Soniox, обязан удалять И транскрипцию, И файл, и
  // делать это в `finally`, а не только в ветке успеха.
  let sonioxUploaders = 0;
  let blobCleaners = 0;
  let uploadIssuers = 0;
  // Тело блока по открывающей скобке. Все блоки `finally` файла, а не
  // первый (аудит 29.09.2026), и с раскрытием вызовов `this.метод(` —
  // уборка, вынесенная в свой метод, должна засчитываться, а вынесенная
  // ЗА блок — нет.
  const blockAt = (src, openIdx) => {
    let depth = 0;
    for (let k = openIdx; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}" && --depth === 0)
        return src.slice(openIdx + 1, k);
    }
    return "";
  };
  const methodBody = (src, name) => {
    const m = new RegExp(
      `\\b(?:private |public |protected )?async ${name}\\s*\\(`,
    ).exec(src);
    if (!m) return "";
    const sig = src.slice(m.index);
    const close = sig.search(/\)\s*(?::[^{]*)?\{/);
    return close < 0 ? "" : blockAt(src, m.index + sig.indexOf("{", close));
  };
  const finallyBodies = (src) => {
    const out = [];
    for (const m of src.matchAll(/\bfinally\s*\{/g)) {
      let body = blockAt(src, m.index + m[0].length - 1);
      for (const call of body.matchAll(/\bthis\.(\w+)\(/g)) {
        body += "\n" + methodBody(src, call[1]);
      }
      out.push(body);
    }
    return out;
  };
  for (const f of files) {
    const src = stripComments(read(`${DIR}/${f}`));
    const fins = finallyBodies(src);

    // Blob — «у Сервиса» половина обещания 3.4: удаление в `finally` и
    // с `await` (без него на Vercel оно может не выполниться).
    if (/\bdeleteBlob\(/.test(src)) {
      blobCleaners++;
      if (/\bvoid\s+this\.blobService\.deleteBlob\(/.test(src)) {
        problems.push(
          `${DIR}/${f}: удаление записи из Blob без await — на Vercel после ответа оно может не выполниться`,
        );
      }
      if (
        !fins.some((b) => /\bawait\s+this\.blobService\.deleteBlob\(/.test(b))
      ) {
        problems.push(
          `${DIR}/${f}: удаление записи из Blob не стоит в finally — отказ по лимиту или исключение оставят файл у Сервиса`,
        );
      }
      // Строка учёта выданной ссылки (финальный аудит ветки K,
      // 30.09.2026) снимается там же, где удаляется файл: иначе крон
      // `voice-uploads-sweep` час спустя «удалял» бы уже удалённое, а
      // главное — забытая строка значит, что учёт и удаление разошлись.
      if (
        !fins.some((b) => /\bawait\s+this\.voiceUploads\.forget\(/.test(b))
      ) {
        problems.push(
          `${DIR}/${f}: запись удаляется, но строка учёта (voiceUploads.forget) не снимается в том же finally`,
        );
      }
    }

    // Каждая выданная ссылка на запись учитывается ДО выдачи: без строки
    // `VoiceUpload` необработанную запись удалит только суточная метла,
    // а она до голосовых файлов на объёме не доходит.
    if (/\bblobService\.createUploadUrl\(/.test(src)) {
      uploadIssuers++;
      const issue = src.search(/\bblobService\.createUploadUrl\(/);
      const remember = src.search(/\bawait\s+this\.voiceUploads\.remember\(/);
      if (remember < 0 || remember > issue) {
        problems.push(
          `${DIR}/${f}: ссылка на загрузку записи выдаётся без учёта (voiceUploads.remember до createUploadUrl) — крон voice-uploads-sweep её не увидит`,
        );
      }
    }

    if (!/SONIOX_API_BASE/.test(src) || !/['"`]\/files['"`]/.test(src))
      continue;
    sonioxUploaders++;
    const cleaned =
      fins.some(
        (b) =>
          /\/transcriptions\/\$\{/.test(b) &&
          /\/files\/\$\{/.test(b) &&
          !/^\s*return\b/m.test(b.split("\n")[0] ?? ""),
      ) && /method:\s*['"]DELETE['"]/.test(src);
    if (!cleaned) {
      problems.push(
        `${DIR}/${f}: звук уходит к Soniox, но удаление транскрипции и файла ` +
          "не стоит в finally — запись останется у провайдера, а Условия " +
          "(3.4) обещают обратное",
      );
    }
  }
  const terms = read("doc/legal/terms-of-use.md").replace(/\s+/g, " ");
  // Обещание пункта 3.4 после сквозного аудита голоса 29.09.2026:
  // у Сервиса запись удаляется сразу; у провайдера не хранится как файл
  // (Soniox удаляет по запросу, Gemini получает внутри запроса). Прежняя
  // формулировка «удаляется и у ИИ-провайдера» была неверна для Gemini:
  // Google по умолчанию логирует запросы для выявления злоупотреблений.
  for (const phrase of [
    "удаляется у Сервиса сразу после расшифровки",
    "не сохраняется как файл",
  ]) {
    if (!terms.includes(phrase)) {
      problems.push(
        `doc/legal/terms-of-use.md: обещания «${phrase}» больше нет — шов ` +
          "сторожит пустоту, снимите его вместе с обещанием",
      );
    }
  }
  if (problems.length > 0) {
    failed++;
    console.log("FAIL голос не остаётся у провайдера:");
    for (const x of problems) console.log(`  - ${x}`);
  } else {
    console.log(
      `ok   голос не остаётся у провайдера: файлов модуля голоса ${files.length}, ` +
        `звук внутри запроса в ${inline}, путей к Files API 0, отправок в ` +
        `Soniox ${sonioxUploaders}, все с уборкой в finally; удалений из ` +
        `Blob ${blobCleaners}, все в finally и с await и со снятием строки ` +
        `учёта; выдач ссылок на запись ${uploadIssuers}, все с учётом до ` +
        "выдачи (крон voice-uploads-sweep) — обещание " +
        "пункта 3.4 Условий держится кодом",
    );
  }
}

checkVoiceRetentionSeam();

/**
 * Шов «субподрядчики в коде = субподрядчики в Условиях» (29.09.2026).
 *
 * Находка при добавлении Soniox: `doc/TODO.md` II.10 от 27.09.2026
 * записывал Replicate, Resemble AI и ElevenLabs как ДОБАВЛЕННЫЕ в пункт
 * 7.8 Условий и 2.3 оферты — а в текстах документов их не было ни в
 * одном коммите. Правка потерялась по дороге, запись о ней осталась, и
 * два дня документы называли пользователю не всех получателей его
 * материалов. Проверки, которая заметила бы расхождение, не было.
 *
 * Теперь есть: для каждого провайдера — признак в коде (переменная
 * окружения с его ключом) и имя, под которым он обязан стоять в 7.8
 * Условий и 2.3 оферты. Ключ читается кодом — имя обязано быть в обоих.
 */
function checkProcessorsSeam() {
  const problems = [];
  const PROCESSORS = [
    { name: "Soniox", marker: /\bSONIOX_API_KEY\b/ },
    { name: "ElevenLabs", marker: /\bprocess\.env\.VOICE_API_KEY\b/ },
    { name: "Resemble AI", marker: /\bRESEMBLE_API_KEY\b/ },
    { name: "Replicate", marker: /\bREPLICATE_API_TOKEN\b/ },
  ];
  const code = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts"))
        code.push(read(rel));
    }
  };
  walk("backend/src");
  const all = code.join("\n");
  const terms = read("doc/legal/terms-of-use.md").replace(/\s+/g, " ");
  const offer = read("doc/legal/offer.md").replace(/\s+/g, " ");
  const clause = (text, re) => text.match(re)?.[0] ?? "";
  const t78 = clause(
    terms,
    /7\.8\. \*\*Трансграничная передача\.\*\*.*?(?= 7\.9\.)/,
  );
  const o23 = clause(offer, /2\.3\. Отдельные функции Сервиса.*?(?= ## 3\.)/);
  if (!t78 || !o23) {
    problems.push(
      "не нашёл пункт 7.8 Условий или 2.3 оферты — шов ослеп, поправьте шов, а не документы",
    );
  }
  let used = 0;
  for (const p of PROCESSORS) {
    if (!p.marker.test(all)) continue;
    used++;
    if (t78 && !t78.includes(p.name)) {
      problems.push(
        `код обращается к ${p.name}, а пункт 7.8 Условий его не называет`,
      );
    }
    if (o23 && !o23.includes(p.name)) {
      problems.push(
        `код обращается к ${p.name}, а пункт 2.3 оферты его не называет`,
      );
    }
  }
  if (problems.length > 0) {
    failed++;
    console.log("FAIL субподрядчики в коде и в документах:");
    for (const x of problems) console.log(`  - ${x}`);
  } else {
    console.log(
      `ok   субподрядчики: провайдеров речи и звука в коде ${used}, все названы ` +
        "в пункте 7.8 Условий и 2.3 оферты",
    );
  }
}

checkProcessorsSeam();

/**
 * Шов «тоны по поводу — только с сервера» — Greeting 2.0, этап D
 * (`docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §3.1, §3.5; Т-18).
 *
 * До этапа D фронтенд держал свою копию таблицы тонов по поводу
 * (`allowedTonesFor` / `GREETING_TONE_OVERRIDES` в `types/project.ts`).
 * Две копии одного правила уже расходились (Г-11, лимит длины повода), а
 * у тонов цена расхождения — шутливая пилюля, доступная в соболезновании,
 * и отказ 400 уже после нажатия. Копию убрали: интерфейс решает всё по
 * `GET /greeting/policy` через `frontend/src/lib/greeting-policy.ts`.
 *
 * Шов держит это в двух местах:
 *  а) во `frontend/src` не появляется копия таблицы снова — ни под
 *     прежними именами, ни в виде `Record<GreetingOccasion, GreetingTone[]>`
 *     под новым (имя сменить легко, форму таблицы — нет);
 *  б) поля `GreetingRegisterRules` фронтенда совпадают с полями элемента
 *     `GreetingPolicyView.registers` бэкенда. Типы по сети не сверяются
 *     никем: сервер добавит поле — интерфейс его не увидит, уберёт —
 *     интерфейс прочтёт `undefined` как «запрещено» или «разрешено»
 *     наугад. Сверяем по тексту, как остальные швы.
 */
function checkGreetingPolicyCopySeam() {
  const problems = [];
  const FRONT_LIB = "frontend/src/lib/greeting-policy.ts";
  const BACK_LIB = "backend/src/common/greeting-policy.ts";

  // а) Копии таблицы. Комментарии снимаем: библиотека политики сама
  // объясняет в шапке, что `allowedTonesFor` удалён, — это не копия.
  const COPY_NAMES = [
    "GREETING_TONE_OVERRIDES",
    "allowedTonesFor",
    "defaultToneFor",
    "EVERYDAY_TONES",
  ];
  const nameRe = new RegExp(`\\b(?:${COPY_NAMES.join("|")})\\b`);
  // Форма таблицы «повод → тоны» под любым именем.
  const shapeRe =
    /Record<\s*GreetingOccasion\s*,\s*(?:readonly\s+)?(?:GreetingTone\s*\[\s*\]|(?:Readonly)?Array<\s*GreetingTone\s*>)/;
  const frontFiles = walk(path.join(ROOT, "frontend/src")).filter((f) =>
    /\.(ts|tsx)$/.test(f),
  );
  for (const f of frontFiles) {
    const rel = path.relative(ROOT, f);
    const src = stripComments(fs.readFileSync(f, "utf8"));
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      const hit = line.match(nameRe);
      if (hit) {
        problems.push(
          `${rel}:${i + 1}: «${hit[0]}» — копия таблицы тонов по поводу ` +
            "(Т-18). Тоны решаются по GET /greeting/policy через " +
            `${FRONT_LIB}, а не своей копией`,
        );
      }
    });
    const shape = src.match(shapeRe);
    if (shape) {
      const line = src.slice(0, shape.index).split("\n").length;
      problems.push(
        `${rel}:${line}: «${shape[0].replace(/\s+/g, " ")}» — таблица ` +
          "«повод → тоны» во фронтенде, копия серверной под новым именем (Т-18)",
      );
    }
  }
  if (frontFiles.length < 50) {
    problems.push(
      `frontend/src: нашёл всего ${frontFiles.length} файлов .ts/.tsx — ` +
        "обход ослеп, поправьте шов",
    );
  }

  // б) Поля правил регистра. Тело блока — по парным скобкам.
  const bodyAfter = (src, re) => {
    const m = re.exec(src);
    if (!m) return null;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let k = open; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}" && --depth === 0) return src.slice(open + 1, k);
    }
    return null;
  };
  // Поля только верхнего уровня: вложенные `{ … }` вырезаем, чтобы поле
  // вложенного объекта не засчиталось полем правил.
  const fieldsOf = (body) => {
    let flat = body;
    let prev;
    do {
      prev = flat;
      flat = flat.replace(/\{[^{}]*\}/g, "");
    } while (flat !== prev);
    return [...flat.matchAll(/^\s*(?:readonly\s+)?(\w+)\??\s*:/gm)].map(
      (m) => m[1],
    );
  };
  const front = bodyAfter(
    stripComments(read(FRONT_LIB)),
    /export\s+interface\s+GreetingRegisterRules\s*\{/,
  );
  const back = bodyAfter(
    bodyAfter(
      stripComments(read(BACK_LIB)),
      /export\s+interface\s+GreetingPolicyView\s*\{/,
    ) ?? "",
    /\bregisters\s*:\s*Array<\s*\{/,
  );
  const frontFields = front ? fieldsOf(front) : [];
  const backFields = back ? fieldsOf(back) : [];
  // Защита от слепоты: в правилах регистра сейчас семь полей, и меньше
  // пяти значит, что регулярка перестала находить интерфейс, а не что
  // правил стало мало.
  if (!front || frontFields.length < 5) {
    problems.push(
      `${FRONT_LIB}: не нашёл interface GreetingRegisterRules или в нём ` +
        `меньше 5 полей (${frontFields.length}) — шов ослеп, поправьте шов`,
    );
  }
  if (!back || backFields.length < 5) {
    problems.push(
      `${BACK_LIB}: не нашёл GreetingPolicyView.registers: Array<{ … }> ` +
        `или в нём меньше 5 полей (${backFields.length}) — шов ослеп, ` +
        "поправьте шов вместе с типом",
    );
  }
  if (front && back) {
    const onlyBack = backFields.filter((x) => !frontFields.includes(x));
    const onlyFront = frontFields.filter((x) => !backFields.includes(x));
    if (onlyBack.length > 0) {
      problems.push(
        `сервер отдаёт в правилах регистра ${onlyBack.join(", ")}, а ` +
          `GreetingRegisterRules в ${FRONT_LIB} их не знает — интерфейс ` +
          "не увидит правило",
      );
    }
    if (onlyFront.length > 0) {
      problems.push(
        `GreetingRegisterRules в ${FRONT_LIB} ждёт ${onlyFront.join(", ")}, ` +
          `а GreetingPolicyView.registers в ${BACK_LIB} их не отдаёт — ` +
          "интерфейс прочтёт undefined",
      );
    }
  }

  if (problems.length > 0) {
    failed++;
    console.log("FAIL тоны по поводу — только с сервера (Т-18):");
    for (const x of problems) console.log(`  - ${x}`);
  } else {
    console.log(
      `ok   тоны по поводу — только с сервера: файлов frontend/src ` +
        `${frontFiles.length}, копий таблицы 0; полей правил регистра ` +
        `${frontFields.length} — одни и те же у фронтенда и сервера`,
    );
  }
}

checkGreetingPolicyCopySeam();

if (failed) {
  console.error(
    `\n${failed} расхождени(е/я) между документами и кодом. ` +
      `Поправьте числа в документах — они там не для красоты, по ним принимают решения.`,
  );
  process.exit(1);
}
console.log("\ncheck-docs: числа в документах совпадают с реальностью");
