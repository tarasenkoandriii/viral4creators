import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = mkdtempSync(join(tmpdir(), 'migration-policy-'));
try {
  writeFileSync(join(dir, 'prisma'), '#!/bin/sh\necho "migration invoked: $*"\nexit "${TEST_MIGRATION_EXIT:-0}"\n', { mode: 0o755 });
  const run = (target, fail = '0') => {
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEST_MIGRATION_EXIT: fail };
    delete env.VERCEL_ENV;
    if (target) env.VERCEL_ENV = target;
    return spawnSync(process.execPath, ['scripts/build-prisma-migrations.mjs'], { env, encoding: 'utf8' });
  };
  const preview = run('preview', '7');
  assert.equal(preview.status, 0);
  assert.doesNotMatch(preview.stdout, /migration invoked/);
  for (const target of ['production', undefined]) {
    const ok = run(target);
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /migration invoked: migrate deploy/);
    assert.equal(run(target, '7').status, 7);
  }
  console.log('Migration build policy: preview isolated; production/local migrate and fail closed');
} finally { rmSync(dir, { recursive: true, force: true }); }
