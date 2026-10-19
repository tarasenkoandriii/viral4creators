import assert from 'node:assert/strict';
import { ApiError, type ApiClient } from '../src/kit';
import {
  createQaFindingsApi,
  decodeFindingPayload,
  findingFixPrompt,
  type Finding,
} from '../src/lib/qa-findings-api';
import { parseRoute, routeHref } from '../src/lib/router';
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
assert.deepEqual(decodeFindingPayload(payload), payload);
for (const v of [
  null,
  { ...payload, status: ['confirmed'] },
  { ...payload, severity: 'P9' },
  { ...payload, evidence: [{}] },
  { ...payload, deployedSha: 'unknown' },
]) {
  let caught: unknown;
  try {
    decodeFindingPayload(v);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ApiError);
}
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
assert.ok(findingFixPrompt(f)?.includes('ревизия 2'));
assert.ok(findingFixPrompt(f)?.includes('не установлен'));
for (const status of [
  'fixed_verified',
  'accepted_risk',
  'not_reproduced',
] as const)
  assert.equal(
    findingFixPrompt({ ...f, status, payload: { ...payload, status } }),
    null
  );
assert.equal(
  routeHref({ name: 'qa-findings', siteId: 'site' }),
  '#/sites/site/qa-findings'
);
assert.deepEqual(parseRoute('#/sites/site/qa-findings'), {
  name: 'qa-findings',
  siteId: 'site',
});
let calls = 0;
const api = createQaFindingsApi({
  request: async (method: string, path: string, body: unknown) => {
    calls++;
    assert.equal(method, 'PUT');
    assert.equal(path, '/qa/sites/site/findings/finding');
    assert.deepEqual(body, { expectedRevision: 2, payload });
    throw new ApiError('QA_FINDING_CONFLICT', 'Conflict', 409);
  },
} as unknown as ApiClient);
let conflict: unknown;
try {
  await api.replace('site', 'finding', 2, payload);
} catch (e) {
  conflict = e;
}
assert.ok(
  conflict instanceof ApiError && conflict.code === 'QA_FINDING_CONFLICT'
);
assert.equal(calls, 1);
console.log(
  'QA finding contracts, route, prompt eligibility and conflict without retry passed'
);

const source = { runId: 'run', caseKey: 'QA-LOGIN', attemptId: 'attempt' };
assert.deepEqual(decodeFindingPayload({ ...payload, source }).source, source);
assert.ok(
  findingFixPrompt({ ...f, payload: { ...payload, source } })?.includes(
    'попытка attempt'
  )
);
