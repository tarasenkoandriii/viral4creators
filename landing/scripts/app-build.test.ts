/**
 * `<meta name="app-build">` на `/qa/*` (`src/lib/app-build.ts`,
 * `src/app/qa/layout.tsx`) — версия витрины для `captureBuild` роликов
 * демо обучающего лендинга.
 *
 *  1. правило версии — как у мини-аппа (`frontend/app-build-meta.ts`);
 *  2. layout `/qa/*` отдаёт его через `metadata.other`, страницы `/qa/*`
 *     своё `other` не задают (иначе слияние Next стёрло бы тег);
 *  3. шов с раннером: он читает именно `meta[name=app-build]` и `content`.
 *
 * Сам тег в HTML проверяет `next build` (статическая `/qa/site-sandbox`).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  APP_BUILD_DEV,
  appBuildMetaOther,
  appBuildVersion,
} from '../src/lib/app-build';

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 1. Версия ──
const SHA = '0123456789abcdef0123456789abcdef01234567';
assert.equal(appBuildVersion({ VERCEL_GIT_COMMIT_SHA: SHA }), '0123456');
assert.equal(
  appBuildVersion({ VERCEL_GIT_COMMIT_SHA: ` ${SHA.toUpperCase()} ` }),
  '0123456',
);
for (const bad of [
  undefined,
  '',
  'undefined',
  'abc12',
  'main',
  'zzzzzzz',
  `${SHA}0`,
]) {
  assert.equal(
    appBuildVersion({ VERCEL_GIT_COMMIT_SHA: bad }),
    APP_BUILD_DEV,
    String(bad),
  );
}
{
  const saved = process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    process.env.VERCEL_GIT_COMMIT_SHA = SHA;
    assert.deepEqual(appBuildMetaOther(), { 'app-build': '0123456' });
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    assert.deepEqual(appBuildMetaOther(), { 'app-build': 'dev' });
  } finally {
    if (saved === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = saved;
  }
}
// Правило совпадает с мини-аппом: та же длина и тот же образец коммита.
{
  const frontend = read('../frontend/app-build-meta.ts');
  assert.match(frontend, /APP_BUILD_SHA_LENGTH = 7;/);
  assert.match(frontend, /\/\^\[0-9a-f\]\{7,40\}\$\/i/);
  assert.match(frontend, /APP_BUILD_DEV = 'dev';/);
}

// ── 2. Layout /qa/* ──
{
  const layout = read('src/app/qa/layout.tsx');
  assert.match(
    layout,
    /export const metadata: Metadata = \{\s*other: appBuildMetaOther\(\),\s*\};/,
  );
  for (const page of [
    'src/app/qa/demo-shop/page.tsx',
    'src/app/qa/site-sandbox/page.tsx',
  ]) {
    assert.ok(
      !/\bother\s*:/.test(read(page)),
      `${page}: своё other стёрло бы app-build`,
    );
  }
}

// ── 3. Шов с раннером ──
{
  const runner = read(
    '../backend/src/modules/tutorial-runner/tutorial-scenario-runner.service.ts',
  );
  assert.match(
    runner,
    /querySelector\('meta\[name=app-build\]'\)/,
    'шов ослеп: раннер читает другой тег',
  );
  assert.match(runner, /getAttribute\('content'\)/);
  assert.match(
    runner,
    /`landing:\$\{build\}`/,
    'версия витрины пишется с приставкой landing:',
  );
}

console.log('app-build: ok');
