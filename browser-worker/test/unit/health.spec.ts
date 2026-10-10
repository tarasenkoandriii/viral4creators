import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isHealthy, writeHealth, type HealthState } from '../../src/health';

describe('worker readiness', () => {
  const now = 1_000_000;
  let dir: string;
  let file: string;
  const base: HealthState = {
    t: now,
    running: 0,
    browser: true,
    lastClaimAt: now - 1000,
    lastError: null,
    completed: 0,
    failed: 0,
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'worker-health-'));
    file = join(dir, 'health');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it.each([
    [{}, true],
    [{ lastClaimAt: 0 }, false],
    [{ lastClaimAt: now - 91_000, lastError: 'HTTP_ERROR' }, false],
    [{ browser: false }, false],
    [{ t: now - 61_000 }, false],
    [{ t: now + 1 }, false],
    [{ lastClaimAt: now - 100_000, running: 1 }, true],
    [{ lastClaimAt: now - 100_000, draining: true }, true],
    [{ lastClaimAt: now - 421_000, running: 1 }, false],
    [{ lastError: 'network' }, true],
  ] as Array<[Partial<HealthState>, boolean]>)(
    'state %j is ready=%s',
    (state, ready) => {
      writeHealth(file, { ...base, ...state });
      expect(isHealthy(file, now)).toBe(ready);
    },
  );
});
