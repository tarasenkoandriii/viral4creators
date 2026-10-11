import assert from 'node:assert/strict';
import { ApiError, type ApiClient } from '../src/kit';
import {
  createQaRunsApi,
  decodeQaRun,
  qaRunSummary,
} from '../src/lib/qa-runs-api';
import { parseRoute, routeHref } from '../src/lib/router';
const snapshot = [
  {
    caseId: 'c',
    caseKey: 'QA-LOGIN',
    version: 2,
    payload: {
      title: 'Login',
      purpose: '',
      preconditions: '',
      steps: [{ action: 'Submit', expected: 'Reject' }],
      type: 'manual',
      priority: 'normal',
      tags: [],
      requirementIds: [],
      archived: false,
    },
  },
];
const run = {
  id: 'r',
  title: 'Run',
  revision: 1,
  createdAt: '2026-10-11T00:00:00Z',
  snapshot,
  latestAttempts: [],
  flakyCaseKeys: [],
};
assert.deepEqual(qaRunSummary(decodeQaRun(run)), {
  passed: 0,
  failed: 0,
  blocked: 0,
  skipped: 0,
  notRun: 1,
});
const attempt = {
  id: 'a',
  caseKey: 'QA-LOGIN',
  attemptNumber: 1,
  status: 'blocked',
  comment: 'Device unavailable',
  createdAt: run.createdAt,
  createdByMemberId: 'm',
};
assert.equal(
  qaRunSummary(decodeQaRun({ ...run, latestAttempts: [attempt] })).blocked,
  1
);
for (const v of [
  { ...run, snapshot: [] },
  { ...run, latestAttempts: [attempt, attempt] },
  { ...run, latestAttempts: [{ ...attempt, status: 'success' }] },
  {
    ...run,
    snapshot: [
      {
        ...snapshot[0],
        payload: { ...snapshot[0].payload, type: 'automated' },
      },
    ],
    latestAttempts: [attempt],
  },
]) {
  let rejected = false;
  try {
    decodeQaRun(v);
  } catch {
    rejected = true;
  }
  assert.ok(rejected);
}
let response: unknown = run;
const calls: Array<[string, string, unknown]> = [];
const api = createQaRunsApi({
  request: async <T>(method: string, path: string, body?: unknown) => {
    calls.push([method, path, body]);
    return response as T;
  },
} as ApiClient);
await api.get('site/a', 'run/b');
assert.equal(calls[0][1], '/qa/sites/site%2Fa/runs/run%2Fb');
response = { attempt, revision: 2 };
assert.equal(
  (await api.record('s', 'r', 1, 'QA-LOGIN', 'blocked', 'Device unavailable'))
    .revision,
  2
);
assert.deepEqual(calls[1][2], {
  expectedRevision: 1,
  caseKey: 'QA-LOGIN',
  status: 'blocked',
  comment: 'Device unavailable',
});
let count = 0;
const stale = new ApiError('QA_RUN_CONFLICT', 'Conflict', 409);
const conflict = createQaRunsApi({
  request: async () => {
    count++;
    throw stale;
  },
} as ApiClient);
try {
  await conflict.record('s', 'r', 1, 'QA-LOGIN', 'passed', '');
  throw new Error('Must reject');
} catch (e) {
  assert.equal(e, stale);
}
assert.equal(count, 1);
assert.deepEqual(parseRoute('#/sites/s/qa-runs'), {
  name: 'qa-runs',
  siteId: 's',
});
assert.equal(routeHref({ name: 'qa-runs', siteId: 's' }), '#/sites/s/qa-runs');
console.log(
  'QA runs: snapshots, statuses, malformed responses, conflict no retry, route passed'
);

const autoSnapshot = [
  { ...snapshot[0], payload: { ...snapshot[0].payload, type: 'automated' } },
];
const imported = {
  ...attempt,
  origin: 'automated',
  sourceMetadata: {
    testSourceSha: null,
    deployedSha: null,
    runnerStatus: 'passed',
  },
  project: 'desktop',
  status: 'passed',
};
assert.equal(
  qaRunSummary(
    decodeQaRun({
      ...run,
      snapshot: autoSnapshot,
      automationProject: 'desktop',
      latestAttempts: [imported],
      flakyCaseKeys: ['QA-LOGIN'],
    })
  ).passed,
  1
);
let invalidProject = false;
try {
  decodeQaRun({
    ...run,
    snapshot: autoSnapshot,
    automationProject: 'mobile',
    latestAttempts: [imported],
  });
} catch {
  invalidProject = true;
}
assert.ok(invalidProject);
response = { revision: 3, imported: 2, replayed: false, project: 'desktop' };
await api.importReport('s', 'r', 2, 'desktop', { schemaVersion: 1 });
assert.deepEqual(calls[calls.length - 1][2], {
  expectedRevision: 2,
  project: 'desktop',
  report: { schemaVersion: 1 },
});
