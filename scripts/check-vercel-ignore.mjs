#!/usr/bin/env node
/**
 * Деплой только изменённых Vercel-проектов (scripts/vercel-ignore-build.sh).
 *
 * 1. У каждого Vercel-проекта монорепо в vercel.json стоит `ignoreCommand`
 *    ровно с теми путями, что читает его сборка. Новый проект без него
 *    снова деплоился бы на каждый коммит — проверка это ловит.
 * 2. Самотест скрипта на временном git-репозитории: пропуск только когда
 *    достоверная база есть (прошлый деплой либо remote default для первого
 *    preview) и в путях проекта ничего не поменялось; во всех неясных
 *    случаях — сборка.
 *
 * Запуск: node scripts/check-vercel-ignore.mjs (входит в `make ci-docs`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  // Сайт AI Publisher (P-F): копия правил формы — в самом пакете (src/shared).
  'publisher-site': ['.'],
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
const remote = mkdtempSync(path.join(tmpdir(), 'vercel-ignore-origin-'));
const shallow = mkdtempSync(path.join(tmpdir(), 'vercel-ignore-shallow-'));
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
const runWith = (cwdRel, base, overrides, ...paths) => {
  const env = { ...process.env };
  for (const key of ['VERCEL_GIT_PREVIOUS_SHA', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_REF', 'VERCEL_FORCE_BUILD']) delete env[key];
  Object.assign(env, overrides);
  if (base !== undefined) env.VERCEL_GIT_PREVIOUS_SHA = base;
  return spawnSync('bash', [SCRIPT, ...paths], { cwd: path.join(repo, cwdRel), env, encoding: 'utf8' }).status;
};
const run = (cwdRel, base, ...paths) => runWith(cwdRel, base, {}, ...paths);
let cases = 0;
const expect = (name, got, want) => {
  cases++;
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

  // A first preview has no prior successful deployment. Use the actual remote
  // default branch tree only when the current branch is known and different.
  execFileSync('git', ['init', '--bare', '-q', remote]);
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git('branch', '-M', 'main');
  git('remote', 'add', 'origin', remote);
  git('push', '-qu', 'origin', 'main');
  git('checkout', '-qb', 'feature/first-preview');
  const preview = { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'feature/first-preview' };
  expect('first preview: same project tree', runWith('app', undefined, preview, '.'), 0);
  expect('first preview: explicit force', runWith('app', undefined, { ...preview, VERCEL_FORCE_BUILD: '1' }, '.'), 1);
  expect('production never uses preview fallback', runWith('app', undefined, { ...preview, VERCEL_ENV: 'production' }, '.'), 1);
  expect('preview of default branch still builds', runWith('app', undefined, { ...preview, VERCEL_GIT_COMMIT_REF: 'main' }, '.'), 1);
  expect('unknown current branch still builds', runWith('app', undefined, { VERCEL_ENV: 'preview' }, '.'), 1);
  expect('invalid previous deployment is not replaced', runWith('app', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', preview, '.'), 1);
  put('other/b.txt', '3');
  commit('preview unrelated change');
  expect('first preview: unrelated change skipped', runWith('app', undefined, preview, '.'), 0);
  expect('first preview: changed project builds', runWith('other', undefined, preview, '.'), 1);
  put('dict/d.txt', '3');
  commit('preview dependency');
  expect('first preview: declared dependency builds', runWith('app', undefined, preview, '.', '../dict'), 1);
  put('app/a.txt', '3');
  commit('preview own change');
  expect('first preview: own change builds', runWith('app', undefined, preview, '.'), 1);
  expect('previous successful SHA still takes precedence', runWith('app', c1, preview, '.'), 1);

  // Remote main advances after earlier checks: do not use a stale local ref.
  git('checkout', '-q', 'main');
  put('app/a.txt', '3');
  commit('main advances');
  git('push', '-q', 'origin', 'main');
  git('checkout', '-q', 'feature/first-preview');
  expect('first preview: latest remote tree', runWith('app', undefined, preview, '.'), 0);
  git('push', '-q', 'origin', 'feature/first-preview');
  execFileSync('git', ['clone', '-q', '--depth=1', '--branch', 'feature/first-preview', pathToFileURL(remote).href, shallow]);
  const shallowEnv = { ...process.env, ...preview };
  delete shallowEnv.VERCEL_GIT_PREVIOUS_SHA;
  delete shallowEnv.VERCEL_FORCE_BUILD;
  const shallowRun = (...paths) => spawnSync('bash', [SCRIPT, ...paths], {
    cwd: path.join(shallow, 'app'), env: shallowEnv, encoding: 'utf8',
  }).status;
  expect('shallow first preview: matching tree skipped', shallowRun('.'), 0);
  expect('shallow first preview: dependency builds', shallowRun('.', '../dict'), 1);
  git('remote', 'set-url', 'origin', path.join(remote, 'unavailable'));
  expect('first preview: unavailable origin builds', runWith('app', undefined, preview, '.'), 1);

} finally {
  rmSync(repo, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
  rmSync(shallow, { recursive: true, force: true });
}

if (failed) {
  console.error(`check-vercel-ignore: ${failed} ошибок`);
  process.exit(1);
}
console.log(`ok   check-vercel-ignore: проектов с ignoreCommand — ${checked}, самотест скрипта — ${cases} случаев`);
