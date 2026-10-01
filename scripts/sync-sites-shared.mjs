#!/usr/bin/env node
/**
 * Чистые модули backend/ → sites-backend/src/shared/** («копия с
 * проверкой», решение координатора Э0, п.3).
 *
 * Почему копия, а не пакет: npm workspaces в репозитории нет, а Vercel
 * собирает sites-backend с root = sites-backend и не видит файлов вне его.
 * Поэтому копии КОММИТЯТСЯ, а расхождение копии с источником ловит
 * `--check` (CI-джоба sites-backend и `make ci-sites`).
 *
 * Копируются только ЧИСТЫЕ модули: без `@prisma/client`, без сервисов
 * Nest, без относительных импортов за пределы копируемого набора.
 * Нечистые (`rate-limit`, `cron-job-lock`, `ai-usage`, `notify`)
 * sites-backend пишет свои. Скрипт проверяет это сам: копия, которая
 * тянет за собой что-то из backend/, падает здесь, а не на сборке Vercel.
 *
 *   node scripts/sync-sites-shared.mjs          # записать копии
 *   node scripts/sync-sites-shared.mjs --check  # только сверить (CI)
 *
 * Как добавить свой модуль (агенты B/C/D и дальше): одна строка в ENTRIES.
 *   { from: 'backend/src/common/x.ts', to: 'x.ts' }           — файл;
 *   { fromDir: 'backend/src/common/x', toDir: 'x' }            — папка целиком
 *                                                               (рекурсивно).
 * `to`/`toDir` — относительно sites-backend/src/shared. Спек источника
 * имеет смысл копировать рядом: тогда копия проверяется тем же тестом.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = 'sites-backend/src/shared';

/** Список копий. Порядок не важен; дубли `to` запрещены. */
const ENTRIES = [
  // SSRF-защита: проверка файла/меты владения (QA §5.1) и обход (Э1).
  { from: 'backend/src/common/external-url-guard.ts', to: 'external-url-guard.ts' },
  { from: 'backend/src/common/external-url-guard.spec.ts', to: 'external-url-guard.spec.ts' },
  // Сравнение Origin со списком CORS, включая `*.vercel.app` (main.ts).
  { from: 'backend/src/common/cors-origin-match.ts', to: 'cors-origin-match.ts' },
  // Диагностика сбоя связи с Postgres без утечки пароля (PrismaService).
  { from: 'backend/src/prisma/db-error.ts', to: 'db-error.ts' },
  { from: 'backend/src/prisma/db-error.spec.ts', to: 'db-error.spec.ts' },
  // Ядро консультанта (Э0-D): стрим, разделитель, разбор действий, пост-фильтр,
  // ip-hash, таймауты — общее для лендинга и виджета помощника.
  { fromDir: 'backend/src/common/assist-chat-core', toDir: 'assist-chat-core' },
  // Э0-C: HMAC-проверка initData (алгоритм Telegram, токен — параметром) и
  // правило dev-входа «ALLOW_DEV_AUTH=true И не production» — гвард двух ботов.
  {
    from: 'backend/src/modules/telegram-auth/telegram-init-data.util.ts',
    to: 'telegram-init-data.util.ts',
  },
  {
    from: 'backend/src/modules/telegram-auth/telegram-init-data.util.spec.ts',
    to: 'telegram-init-data.util.spec.ts',
  },
  { from: 'backend/src/modules/admin-auth/dev-login.ts', to: 'dev-login.ts' },
  // Э0-W: веб-кабинет — подпись Telegram Login Widget (SHA256(token) как ключ,
  // в отличие от initData) и разбор заголовка Cookie; оба чистые, источник —
  // вход главной админки (backend/src/modules/admin-auth).
  {
    from: 'backend/src/modules/admin-auth/telegram-login-widget.util.ts',
    to: 'telegram-login-widget.util.ts',
  },
  {
    from: 'backend/src/modules/admin-auth/telegram-login-widget.util.spec.ts',
    to: 'telegram-login-widget.util.spec.ts',
  },
  { from: 'backend/src/modules/admin-auth/cookie.util.ts', to: 'cookie.util.ts' },
  // Э1 (знания): ключ и клиент Gemini (эмбеддинги gemini-embedding-001,
  // ответы песочницы), модель по умолчанию и прайс для записи в
  // site_ai_usage. Чистые: SDK провайдера и ничего из backend.
  // `token-crypto` — пока не нужен (секреты «Админки» — Э7, Э4).
  { from: 'backend/src/common/gemini-client.ts', to: 'gemini-client.ts' },
  { from: 'backend/src/common/gemini-client.spec.ts', to: 'gemini-client.spec.ts' },
  { from: 'backend/src/common/gemini-model.ts', to: 'gemini-model.ts' },
  { from: 'backend/src/common/ai-pricing.ts', to: 'ai-pricing.ts' },
  { from: 'backend/src/common/ai-pricing.spec.ts', to: 'ai-pricing.spec.ts' },
];

/** Импорты, которых в общем коде быть не может (см. шапку). */
const FORBIDDEN_IMPORTS = [/^@prisma\/client(\/|$)/, /^\.prisma(\/|$)/];

const CHECK = process.argv.includes('--check');

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** ENTRIES → плоский список пар «источник → копия» (пути от корня). */
function expand(entries) {
  const pairs = [];
  for (const e of entries) {
    if (e.from && e.to) {
      pairs.push({ from: e.from, to: `${SHARED}/${e.to}` });
    } else if (e.fromDir && e.toDir) {
      const base = path.join(ROOT, e.fromDir);
      if (!fs.existsSync(base)) {
        throw new Error(`нет папки-источника ${e.fromDir}`);
      }
      for (const file of walk(base)) {
        const sub = path.relative(base, file).split(path.sep).join('/');
        pairs.push({ from: `${e.fromDir}/${sub}`, to: `${SHARED}/${e.toDir}/${sub}` });
      }
    } else {
      throw new Error(`запись ENTRIES без from/to или fromDir/toDir: ${JSON.stringify(e)}`);
    }
  }
  const seen = new Set();
  for (const p of pairs) {
    if (seen.has(p.to)) throw new Error(`две записи пишут в ${p.to}`);
    seen.add(p.to);
  }
  return pairs;
}

function headerFor(from, file) {
  const text =
    `СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.\n` +
    `Источник: ${from}. Правка — в источнике, затем\n` +
    '`node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.';
  if (/\.(ts|js|mjs|cjs)$/.test(file)) {
    return text
      .split('\n')
      .map((l) => `// ${l}`)
      .join('\n')
      .concat('\n\n');
  }
  if (/\.json$/.test(file)) return ''; // в JSON комментарию места нет
  return text
    .split('\n')
    .map((l) => `# ${l}`)
    .join('\n')
    .concat('\n\n');
}

/** Все спецификаторы импорта/require в исходнике. */
function importSpecifiers(source) {
  const specs = [];
  const re =
    /(?:^|[^\w$.])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w$.])import\s*['"]([^'"]+)['"]|(?:^|[^\w$.])(?:require|import|jest\.mock|jest\.requireActual)\(\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(re)) specs.push(m[1] ?? m[2] ?? m[3]);
  return specs;
}

/**
 * Копия обязана быть самодостаточной: относительный импорт должен попадать
 * в другой копируемый файл, а запрещённые пакеты — отсутствовать.
 */
function purityProblems(pairs) {
  const problems = [];
  const sources = new Set(pairs.map((p) => p.from));
  for (const { from } of pairs) {
    if (!/\.(ts|js)$/.test(from)) continue;
    const src = fs.readFileSync(path.join(ROOT, from), 'utf8');
    for (const spec of importSpecifiers(src)) {
      if (FORBIDDEN_IMPORTS.some((re) => re.test(spec))) {
        problems.push(`${from}: импорт «${spec}» — модуль не чистый`);
        continue;
      }
      if (!spec.startsWith('.')) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
      const candidates = [base, `${base}.ts`, `${base}.js`, `${base}/index.ts`];
      if (!candidates.some((c) => sources.has(c))) {
        problems.push(
          `${from}: импорт «${spec}» ведёт за пределы копируемого набора — ` +
            'добавьте и его в ENTRIES (если он чистый) или не копируйте модуль',
        );
      }
    }
  }
  return problems;
}

function main() {
  const pairs = expand(ENTRIES);
  const problems = purityProblems(pairs);
  if (problems.length) {
    console.error('sync-sites-shared: копия не была бы самодостаточной:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const expected = new Map();
  for (const { from, to } of pairs) {
    const abs = path.join(ROOT, from);
    if (!fs.existsSync(abs)) throw new Error(`нет файла-источника ${from}`);
    expected.set(to, headerFor(from, to) + fs.readFileSync(abs, 'utf8'));
  }

  const sharedAbs = path.join(ROOT, SHARED);
  const existing = fs.existsSync(sharedAbs) ? walk(sharedAbs).map(rel) : [];
  // Всё в shared/ принадлежит скрипту: лишний файл — это копия, у которой
  // убрали запись из ENTRIES, и она молча разойдётся с источником.
  const orphans = existing.filter((f) => !expected.has(f));

  if (CHECK) {
    const stale = [];
    for (const [to, content] of expected) {
      const abs = path.join(ROOT, to);
      if (!fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== content) stale.push(to);
    }
    if (stale.length || orphans.length) {
      for (const f of stale) console.error(`  расходится с источником: ${f}`);
      for (const f of orphans) console.error(`  нет в ENTRIES (лишняя копия): ${f}`);
      console.error('Запустите `node scripts/sync-sites-shared.mjs` и закоммитьте результат.');
      process.exit(1);
    }
    console.log(`ok   sync-sites-shared: ${expected.size} копий совпадают с источниками`);
    return;
  }

  for (const [to, content] of expected) {
    const abs = path.join(ROOT, to);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== content) {
      fs.writeFileSync(abs, content);
      console.log(`записан ${to}`);
    }
  }
  for (const f of orphans) {
    fs.rmSync(path.join(ROOT, f));
    console.log(`удалён ${f} (нет в ENTRIES)`);
  }
  console.log(`sync-sites-shared: ${expected.size} копий актуальны`);
}

main();
