import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
for (const value of ['1', 'true', 'false', '']) {
  test(`env-only deployment force=${JSON.stringify(value)}`, () => {
    const result = spawnSync('bash', ['scripts/vercel-ignore-build.sh', '.'], {
      encoding: 'utf8',
      env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: head, VERCEL_FORCE_BUILD: value },
    });
    assert.equal(result.status, value === '1' || value === 'true' ? 1 : 0);
  });
}
