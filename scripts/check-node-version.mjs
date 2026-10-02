#!/usr/bin/env node
/**
 * Версия Node — в ОДНОМ месте: `.nvmrc` в корне (doc/CI-RECOMMENDATIONS-
 * 2026-10-01.md, п.1). Так CI гоняет тот же мажор, на котором Vercel
 * собирает прод (он читает `engines.node`).
 *
 * Проверяет:
 *  1. `.nvmrc` есть и это мажор (`24`);
 *  2. в `.github/**` нет `node-version:` с числом или выражением — только
 *     `node-version-file: '.nvmrc'` (строки-комментарии не в счёт);
 *  3. у каждого пакета с `engines.node` мажор совпадает с `.nvmrc`.
 * И самотест: настоящая строка находится, та же строка в комментарии — нет
 * (первая версия такой проверки у соседнего проекта была grep-ом и
 * срабатывала на комментарии, цитирующем старое значение).
 *
 * Чего не видит: Node у Vercel-проектов задаётся в панели (Settings →
 * Build and Deployment → Node.js Version) — менять руками у всех проектов
 * вместе с `.nvmrc` (doc/DEPLOYMENT.md, «Версия Node»).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Строки `node-version:` (не `node-version-file:`) вне комментариев. */
export function literalNodeVersions(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const code = line.replace(/\s+#.*$/, '');
    if (/(^|[\s{,-])node-version\s*:/.test(code)) out.push(i + 1);
  });
  return out;
}

function walk(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (/\.ya?ml$/.test(name)) files.push(p);
  }
  return files;
}

let failed = 0;
const fail = (m) => {
  failed++;
  console.error(`FAIL ${m}`);
};

// Самотест детектора.
const probes = [
  ['          node-version: 20', 1],
  ["          node-version: ${{ env.NODE_VERSION }}", 1],
  ["      - uses: actions/setup-node@v4\n        with: { node-version: '24' }", 1],
  ['        # раньше было node-version: 20', 0],
  ["          node-version-file: '.nvmrc'", 0],
  ["          node-version-file: '.nvmrc' # не node-version: 20", 0],
];
for (const [text, want] of probes) {
  const got = literalNodeVersions(text).length;
  if (got !== want) fail(`самотест: ${JSON.stringify(text)} — найдено ${got}, ожидалось ${want}`);
}

// 1. .nvmrc
const nvmrcPath = path.join(ROOT, '.nvmrc');
const major = existsSync(nvmrcPath) ? readFileSync(nvmrcPath, 'utf8').trim() : '';
if (!/^\d+$/.test(major)) fail(`.nvmrc: нужен мажор Node числом (сейчас ${JSON.stringify(major)})`);

// 2. .github
const ymls = walk(path.join(ROOT, '.github'));
for (const f of ymls) {
  for (const line of literalNodeVersions(readFileSync(f, 'utf8'))) {
    fail(`${path.relative(ROOT, f)}:${line}: node-version: — используйте node-version-file: '.nvmrc'`);
  }
}

// 3. engines.node
let engines = 0;
for (const name of readdirSync(ROOT)) {
  const pkg = path.join(ROOT, name, 'package.json');
  if (!existsSync(pkg)) continue;
  const node = JSON.parse(readFileSync(pkg, 'utf8')).engines?.node;
  if (!node) continue;
  engines++;
  const m = /^(?:\^|~|>=)?\s*(\d+)/.exec(node);
  if (!m || m[1] !== major) fail(`${name}/package.json: engines.node = ${node}, а .nvmrc = ${major}`);
}

if (failed) {
  console.error(`check-node-version: ${failed} ошибок`);
  process.exit(1);
}
console.log(`ok   check-node-version: Node ${major} (.nvmrc), workflow-файлов ${ymls.length}, пакетов с engines.node ${engines}, самотест — ${probes.length} проб`);
