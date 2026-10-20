import assert from 'node:assert/strict';
import {
  qaFindingReport,
  loadQaFindingReport,
} from '../src/lib/qa-finding-report';
import type { Finding } from '../src/lib/qa-findings-api';
const payload = {
  title: 'Login',
  category: 'layout' as const,
  severity: 'P2' as const,
  status: 'needs_confirmation' as const,
  url: 'https://example.com/',
  context: '390x844',
  steps: 'Open',
  expected: 'Visible',
  actual: 'Overlap',
  impact: 'Cannot click',
  evidence: [],
  deployedSha: null,
  observedAt: '2026-10-10T00:00:00Z',
  verification: null,
};
const f: Finding = {
  id: 'finding',
  title: 'Login',
  severity: 'P2',
  status: 'needs_confirmation',
  revision: 2,
  createdAt: payload.observedAt,
  updatedAt: payload.observedAt,
  payload,
};

const privateFinding = {
  ...f,
  payload: {
    ...f.payload,
    title: '<script>x</script>',
    evidence: ['https://private.example/?secret=token'],
  },
};
const report = qaFindingReport('site', privateFinding, []);
assert.ok(report.includes('ревизия: 2'));
assert.ok(report.includes('Повторная проверка не записана'));
assert.ok(!report.includes('https://private.example'));
assert.ok(!report.includes('<script>'));
const artifact = {
  id: 'png',
  findingRevision: 1,
  sha256: 'a'.repeat(64),
  bytes: 74,
  contentType: 'image/png' as const,
  expiresAt: 'expiry',
  createdAt: 'date',
};
assert.ok(qaFindingReport('site', f, [artifact]).includes(artifact.sha256));
assert.ok(
  qaFindingReport('site', f, [artifact]).includes('ревизия замечания 1')
);
assert.ok(
  qaFindingReport(
    'site',
    {
      ...f,
      payload: {
        ...f.payload,
        verification: {
          steps: 'Retry',
          result: 'Works',
          checkedAt: 'now',
          deployedSha: null,
        },
      },
    },
    []
  ).includes('Результат: Works')
);
const calls: string[] = [];
const api = {
  get: async () => {
    calls.push('get');
    return f;
  },
  artifacts: async () => {
    calls.push('artifacts');
    return [];
  },
};
assert.equal(
  (await loadQaFindingReport(api, 'site', 'finding')).report,
  qaFindingReport('site', f, [])
);
assert.deepEqual(calls, ['get', 'artifacts', 'get']);
let reads = 0;
await assert.rejects(
  loadQaFindingReport(
    { ...api, get: async () => ({ ...f, revision: ++reads }) },
    'site',
    'finding'
  )
);
await assert.rejects(
  loadQaFindingReport(
    {
      ...api,
      artifacts: async () => {
        throw new Error('offline');
      },
    },
    'site',
    'finding'
  )
);
console.log(
  'QA finding report: privacy, revision consistency, verification and read-only export passed'
);
