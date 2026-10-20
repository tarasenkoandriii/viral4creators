import assert from 'node:assert/strict';
import { qaRunReport } from '../src/lib/qa-run-report';
import { qaAcceptanceStatus, type QaRun } from '../src/lib/qa-runs-api';
const run: QaRun = {
  id: 'run',
  title: '<script>alert(1)</script>',
  revision: 2,
  createdAt: '2026-10-20T00:00:00Z',
  automationProject: 'chromium',
  context: undefined,
  snapshot: [
    {
      caseId: 'case',
      caseKey: 'QA-ONE',
      version: 3,
      payload: {
        title: 'Login',
        purpose: '',
        preconditions: '',
        steps: [{ action: 'Click', expected: 'Done' }],
        type: 'automated',
        priority: 'normal',
        tags: [],
        requirementIds: [],
        archived: false,
      },
    },
  ],
  flakyCaseKeys: ['QA-ONE'],
  latestAttempts: [
    {
      id: 'attempt',
      caseKey: 'QA-ONE',
      attemptNumber: 2,
      status: 'passed',
      comment: '[secret](https://private.invalid)',
      createdAt: '2026-10-20T00:01:00Z',
      createdByMemberId: 'member',
      origin: 'automated',
      project: 'chromium',
      sourceMetadata: {
        runnerStatus: 'failed',
        testSourceSha: null,
        deployedSha: null,
      },
    },
  ],
};
assert.equal(qaAcceptanceStatus(run.latestAttempts[0]), 'blocked');
const report = qaRunReport('site', run);
assert.ok(report.includes('Приёмка не подтверждена'));
assert.ok(report.includes('Результат для приёмки: Заблокирован'));
assert.ok(report.includes('Исходный результат: Пройден'));
assert.ok(report.includes('SHA деплоя: не подтверждён'));
assert.ok(!report.includes('<script>'));
assert.ok(!report.includes('[secret]('));
assert.ok(
  report.includes('QA-ONE') &&
    report.includes('v3') &&
    report.includes('attempt')
);
assert.ok(!report.includes('createdByMemberId'));
run.latestAttempts[0].sourceMetadata!.runnerStatus = 'passed';
assert.ok(qaRunReport('site', run).includes('Все выбранные кейсы пройдены'));
run.latestAttempts = [];
assert.ok(qaRunReport('site', run).includes('Не выполнен: 1'));
console.log(
  'QA report: blocked runner, provenance, escaping, passed and notRun verified'
);
