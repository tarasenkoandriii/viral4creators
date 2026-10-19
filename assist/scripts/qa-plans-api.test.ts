import assert from 'node:assert/strict';
import type { ApiClient } from '../src/kit';
import { createQaPlansApi, decodePlanPayload } from '../src/lib/qa-plan-api';
const payload = {
  title: 'Regression',
  suite: 'Onboarding',
  description: 'Demo',
  caseIds: ['c'],
  assigneeMemberId: null,
  archived: false,
  environments: [
    {
      name: 'Desktop',
      browser: 'Chromium',
      device: 'Desktop',
      theme: 'dark',
      locale: 'ru',
      viewport: '1280x720',
    },
  ],
  snapshot: [
    {
      caseId: 'c',
      caseKey: 'QA-A',
      version: 1,
      payload: {
        title: 'Case',
        purpose: '',
        preconditions: '',
        steps: [{ action: 'Open', expected: 'Visible' }],
        type: 'manual',
        priority: 'normal',
        tags: [],
        requirementIds: [],
        archived: false,
      },
    },
  ],
};
assert.equal(decodePlanPayload(payload).snapshot[0].version, 1);
assert.throws(() =>
  decodePlanPayload({
    ...payload,
    environments: [{ ...payload.environments[0], theme: 'unknown' }],
  })
);
const calls: Array<[string, string, unknown]> = [];
const api = createQaPlansApi({
  request: async <T>(method: string, path: string, body?: unknown) => {
    calls.push([method, path, body]);
    return {
      id: 'r',
      title: 'Run',
      revision: 1,
      createdAt: '2026-10-19T00:00:00Z',
    } as T;
  },
} as ApiClient);
await api.start('site/a', 'plan/b', 3, 1, 'request-id');
assert.equal(calls[0][1], '/qa/sites/site%2Fa/plans/plan%2Fb/runs');
assert.deepEqual(calls[0][2], {
  expectedVersion: 3,
  environmentIndex: 1,
  requestId: 'request-id',
});
console.log(
  'QA plans: frozen payload, environment validation and explicit version/request identity passed'
);
