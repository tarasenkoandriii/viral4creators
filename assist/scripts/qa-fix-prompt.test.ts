import assert from 'node:assert/strict';
import { qaFixPrompt } from '../src/lib/qa-fix-prompt';
import { emptyQaCase } from '../src/lib/qa-editor';
import type { QaAttempt } from '../src/lib/qa-runs-api';
const snapshot = {
  caseId: 'case',
  caseKey: 'LOGIN',
  version: 3,
  payload: { ...emptyQaCase(), title: 'Login' },
};
const attempt: QaAttempt = {
  id: 'a',
  caseKey: 'LOGIN',
  attemptNumber: 1,
  status: 'failed',
  comment: 'Rejected valid login',
  createdAt: '2026-10-11',
  createdByMemberId: 'member',
  origin: 'manual',
  project: null,
  sourceMetadata: null,
};
assert.equal(qaFixPrompt(snapshot, undefined), null);
assert.equal(qaFixPrompt(snapshot, { ...attempt, caseKey: 'OTHER' }), null);
for (const status of ['passed', 'blocked', 'skipped'] as const)
  assert.equal(qaFixPrompt(snapshot, { ...attempt, status }), null);
const draft = qaFixPrompt(snapshot, attempt)!;
assert.ok(draft.includes('версия кейса 3'));
assert.ok(draft.includes('SHA развёрнутого приложения: не установлен'));
assert.ok(draft.includes('Rejected valid login'));
console.log('QA failure prompt eligibility and provenance passed');
