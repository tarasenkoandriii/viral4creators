import assert from 'node:assert/strict';
import { ApiError, type ApiClient } from '../src/kit';
import {
  createQaCatalogApi,
  isQaCaseConflict,
  type QaCasePayload,
} from '../src/lib/qa-catalog-api';
const value: QaCasePayload = {
  title: 'Login',
  purpose: '',
  preconditions: '',
  steps: [{ action: 'Submit', expected: 'Reject' }],
  type: 'manual',
  priority: 'normal',
  tags: [],
  requirementIds: [],
  archived: false,
};
const head = {
  id: 'case',
  caseKey: 'QA-LOGIN',
  title: 'Login',
  currentVersion: 1,
  archived: false,
};
const revision = {
  id: 'rev',
  caseId: 'case',
  version: 1,
  payload: value,
  createdAt: '2026-10-11T00:00:00Z',
  createdByMemberId: 'member',
};
const calls: Array<[string, string, unknown]> = [];
let response: unknown;
const api = createQaCatalogApi({
  request: async <T>(method: string, path: string, body?: unknown) => {
    calls.push([method, path, body]);
    return response as T;
  },
} as ApiClient);
response = { items: [head], nextAfterKey: 'QA-LOGIN' };
assert.equal((await api.list('site/a', 'QA-001')).items[0].currentVersion, 1);
assert.equal(
  calls[calls.length - 1]?.[1],
  '/qa/sites/site%2Fa/cases?after=QA-001'
);
response = { ...head, revision };
assert.equal(
  (await api.get('site', 'case')).revision.payload.steps[0].expected,
  'Reject'
);
response = { ...head, revision: { ...revision, version: 2 } };
await rejected(api.get('site', 'case'), isMalformed);
response = { ...head, currentVersion: 0 };
await rejected(api.create('site', 'QA-LOGIN', value), isMalformed);
response = { items: [revision], nextBeforeVersion: 1 };
assert.equal((await api.history('site', 'case', 2)).nextBeforeVersion, 1);
assert.equal(
  calls[calls.length - 1]?.[1],
  '/qa/sites/site/cases/case/history?before=2'
);
response = { id: 'case', caseKey: 'QA-LOGIN', currentVersion: 2 };
await api.replace('site', 'case', 1, value);
assert.deepEqual(calls[calls.length - 1], [
  'PUT',
  '/qa/sites/site/cases/case',
  { expectedVersion: 1, payload: value },
]);
const failure = new ApiError('QA_CASE_CONFLICT', 'Refresh', 409);
let requests = 0;
const conflictApi = createQaCatalogApi({
  request: async () => {
    requests++;
    throw failure;
  },
} as ApiClient);
await rejected(
  conflictApi.replace('site', 'case', 1, value),
  (e: unknown) => e === failure
);
assert.equal(requests, 1);
assert.equal(isQaCaseConflict(failure), true);
function isMalformed(e: unknown) {
  return e instanceof ApiError && e.code === 'QA_RESPONSE_INVALID';
}
console.log(
  'QA catalog client: routing, snapshots, pagination, malformed responses and single conflict request passed'
);

async function rejected(
  promise: Promise<unknown>,
  predicate: (error: unknown) => boolean
) {
  let caught = false;
  try {
    await promise;
  } catch (error) {
    caught = true;
    assert.ok(predicate(error));
  }
  assert.ok(caught, 'Expected request rejection');
}
