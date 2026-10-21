import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QaFindingRecheck } from '../src/components/QaFindingRecheck';
import type { FindingRecheck } from '../src/lib/qa-findings-api';
const base: FindingRecheck = {
  runId: 'run2',
  caseKey: 'SBX-TUTORIAL',
  caseVersion: 1,
  attemptId: 'attempt2',
  project: 'desktop',
  reportHash: 'a'.repeat(64),
  status: 'passed',
  recordedStatus: 'passed',
  runnerStatus: 'passed',
  checkedAt: '2026-10-21T12:00:00Z',
  testSourceSha: 'b'.repeat(40),
  deployedSha: null,
  requiresReview: true,
};
const render = (recheck?: FindingRecheck | null) =>
  renderToStaticMarkup(createElement(QaFindingRecheck, { recheck }));
assert.ok(render(null).includes('Это не подтверждает исправление'));
const passed = render(base);
assert.ok(passed.includes('исправление ещё должен подтвердить человек'));
assert.ok(passed.includes(base.reportHash));
assert.ok(passed.includes('SHA деплоя: не подтверждён'));
assert.ok(passed.includes('Статус и ревизия замечания не изменены'));
assert.ok(!passed.includes('<button'));
assert.ok(
  render({ ...base, status: 'blocked', runnerStatus: 'failed' }).includes(
    'успешная приёмка не подтверждена'
  )
);
assert.ok(
  render({ ...base, status: 'failed', recordedStatus: 'failed' }).includes(
    'снова завершился ошибкой'
  )
);
assert.ok(
  render({ ...base, status: 'skipped', recordedStatus: 'skipped' }).includes(
    'исправление не проверено'
  )
);
assert.ok(
  !render({ ...base, project: '<script>alert(1)</script>' }).includes(
    '<script>'
  )
);
console.log('QA recheck rendering passed');
