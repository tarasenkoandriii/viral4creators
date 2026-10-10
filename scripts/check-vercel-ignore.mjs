#!/usr/bin/env node
/**
 * Деплой только изменённых Vercel-проектов (scripts/vercel-ignore-build.sh).
 *
 * 1. У каждого Vercel-проекта монорепо в vercel.json стоит `ignoreCommand`
 *    ровно с теми путями, что читает его сборка. Новый проект без него
 *    снова деплоился бы на каждый коммит — проверка это ловит.
 * 2. Самотест скрипта на временном git-репозитории: пропуск только когда
 *    база есть и в путях проекта ничего не поменялось; во всех неясных
 *    случаях — сборка.
 *
 * Запуск: node scripts/check-vercel-ignore.mjs (входит в `make ci-docs`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'vercel-ignore-build.sh');

/**
 * Vercel-проекты (Root Directory) и пути, от которых зависит их сборка,
 * относительно Root Directory. backend: `prebuild` собирает базу знаний
 * консультанта и строки мастера из словарей landing/ и frontend/
 * (backend/scripts/build-assistant-knowledge.ts, build-wizard-ui-strings.ts).
 * Остальные пакеты собираются только из своей папки (копии общих модулей
 * лежат внутри пакета: sites-backend/src/shared, assist/src/kit).
 */
const PROJECTS = {
  backend: ['.', '../landing/src/dictionaries', '../frontend/src/dictionaries', '../scripts/build-prisma-migrations.mjs'],
  frontend: ['.'],
  admin: ['.'],
  landing: ['.'],
  marketplace: ['.'],
  'sites-backend': ['.', '../scripts/build-prisma-migrations.mjs'],
  assist: ['.'],
  'sites-landing': ['.'],
  widget: ['.'],
};

const expected = (paths) => `bash ../scripts/vercel-ignore-build.sh ${paths.join(' ')}`;

let failed = 0;
const fail = (msg) => {
  failed++;
  console.error(`FAIL ${msg}`);
};

// ── 1. ignoreCommand у каждого проекта ─────────────────────────────────
let checked = 0;
for (const [dir, paths] of Object.entries(PROJECTS)) {
  if (!existsSync(path.join(ROOT, dir, 'package.json'))) continue; // пакета ещё нет
  const file = path.join(ROOT, dir, 'vercel.json');
  if (!existsSync(file)) {
    fail(`${dir}/vercel.json нет — Vercel будет деплоить проект на каждый коммит`);
    continue;
  }
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  if (cfg.ignoreCommand !== expected(paths)) {
    fail(`${dir}/vercel.json: ignoreCommand = ${JSON.stringify(cfg.ignoreCommand)}, нужно ${JSON.stringify(expected(paths))}`);
  }
  for (const p of paths) {
    if (!existsSync(path.resolve(ROOT, dir, p))) fail(`${dir}: путь ${p} не существует`);
  }
  checked++;
}

// Зависимости backend от словарей — те же, что читают его скрипты сборки.
for (const [pkg, src] of [
  ['landing', 'backend/scripts/build-assistant-knowledge.ts'],
  ['frontend', 'backend/scripts/build-assistant-knowledge.ts'],
]) {
  const text = readFileSync(path.join(ROOT, src), 'utf8');
  if (text.includes(`'${pkg}'`) && !PROJECTS.backend.includes(`../${pkg}/src/dictionaries`)) {
    fail(`${src} читает ${pkg}/, а ignoreCommand backend этого не видит`);
  }
}

// ── 2. Самотест скрипта ────────────────────────────────────────────────
const repo = mkdtempSync(path.join(tmpdir(), 'vercel-ignore-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const put = (rel, text) => {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), text);
};
const commit = (msg) => {
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
  return git('rev-parse', 'HEAD');
};
const run = (cwdRel, base, ...paths) => {
  const env = { ...process.env };
  delete env.VERCEL_GIT_PREVIOUS_SHA;
  if (base !== undefined) env.VERCEL_GIT_PREVIOUS_SHA = base;
  return spawnSync('bash', [SCRIPT, ...paths], { cwd: path.join(repo, cwdRel), env, encoding: 'utf8' }).status;
};
const expect = (name, got, want) => {
  if (got !== want) fail(`самотест «${name}»: код ${got}, ожидался ${want} (0 — пропуск, 1 — сборка)`);
};

try {
  git('init', '-q');
  put('app/a.txt', '1');
  put('other/b.txt', '1');
  put('dict/d.txt', '1');
  const c1 = commit('c1');

  expect('нет прошлого деплоя', run('app', undefined, '.'), 1);
  expect('пустые пути', run('app', c1), 1);
  expect('ничего не менялось', run('app', c1, '.'), 0);

  put('other/b.txt', '2');
  commit('чужая папка');
  expect('изменение только в чужой папке', run('app', c1, '.'), 0);
  expect('изменение в чужой папке — для её проекта', run('other', c1, '.'), 1);

  put('dict/d.txt', '2');
  commit('зависимость');
  expect('изменение в зависимости', run('app', c1, '.', '../dict'), 1);
  expect('та же зависимость не объявлена', run('app', c1, '.'), 0);

  put('app/a.txt', '2');
  const c4 = commit('свой проект');
  expect('изменение в своей папке', run('app', c1, '.'), 1);
  expect('несколько коммитов: своё изменение не в последнем', run('other', c1, '.'), 1);
  expect('база = HEAD', run('app', c4, '.'), 0);
  expect('неизвестная база', run('app', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', '.'), 1);
} finally {
  rmSync(repo, { recursive: true, force: true });
}

if (failed) {
  console.error(`check-vercel-ignore: ${failed} ошибок`);
  process.exit(1);
}
console.log(`ok   check-vercel-ignore: проектов с ignoreCommand — ${checked}, самотест скрипта — 11 случаев`);
