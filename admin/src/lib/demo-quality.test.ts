// Помощники проверки качества демо. В admin/ нет тест-раннера — запуск
// (из admin/):
//   npx --prefix ../sites-landing tsx src/lib/demo-quality.test.ts
import assert from 'node:assert/strict';
import {
  categoryLabel,
  checkResultLabel,
  enqueueMessage,
  formatCost,
  formatTimecode,
  freshnessLabel,
  qualityBadge,
  sortIssues,
} from './demo-quality';
import type { DemoQualityCheck, DemoQualityIssue } from './types';

const check = (over: Partial<DemoQualityCheck> = {}): DemoQualityCheck => ({
  id: 'c1',
  assetId: 'a1',
  versionId: null,
  trigger: 'assembly',
  status: 'complete',
  phase: 'analyze',
  verdict: 'ok',
  attempts: 0,
  nextAttemptAt: null,
  error: null,
  report: null,
  preflight: null,
  costMicroUsd: 1234,
  unpriced: false,
  modelId: 'gemini-3.6-flash',
  rubricVersion: 'demo-quality-v1',
  reusedFromId: null,
  durationMs: 10_000,
  theme: 'dark',
  locale: 'ru',
  captureBuild: null,
  captureMode: null,
  createdAt: '2026-10-06T10:00:00.000Z',
  checkedAt: null,
  ...over,
});

// Бейдж: нет записи — «не проверен ИИ», а не ok.
assert.deepEqual(qualityBadge(null), { label: 'не проверен ИИ', tone: 'muted' });
assert.deepEqual(qualityBadge(check()), { label: 'ok', tone: 'ok' });
assert.deepEqual(qualityBadge(check({ verdict: 'warn' })), { label: 'warn', tone: 'warning' });
assert.deepEqual(qualityBadge(check({ verdict: 'fail' })), { label: 'fail', tone: 'critical' });
assert.deepEqual(qualityBadge(check({ status: 'error', verdict: null })), { label: 'сбой проверки', tone: 'critical' });
assert.equal(qualityBadge(check({ status: 'pending', phase: 'upload', verdict: null })).label, 'в очереди');
assert.equal(qualityBadge(check({ status: 'pending', phase: 'wait', verdict: null })).label, 'проверяется');
assert.equal(qualityBadge(check({ status: 'pending', attempts: 2, verdict: null })).label, 'повтор (2/3)');
assert.equal(qualityBadge(check({ status: 'running', verdict: null })).label, 'проверяется');

// Таймкод.
assert.equal(formatTimecode(0), '0:00.0');
assert.equal(formatTimecode(4_250), '0:04.2');
assert.equal(formatTimecode(65_900), '1:05.9');
assert.equal(formatTimecode(-1), '0:00.0');

// Порядок замечаний.
const issue = (startMs: number, severity: DemoQualityIssue['severity']): DemoQualityIssue => ({
  category: 'artifact',
  severity,
  startMs,
  endMs: startMs,
  explanation: 'x',
  confidence: 1,
  source: 'model',
});
assert.deepEqual(
  sortIssues([issue(5000, 'minor'), issue(1000, 'minor'), issue(1000, 'critical')]).map((i) => [i.startMs, i.severity]),
  [
    [1000, 'critical'],
    [1000, 'minor'],
    [5000, 'minor'],
  ],
);

// Подписи.
assert.equal(categoryLabel('pii'), 'ПД в кадре');
assert.equal(categoryLabel('new_one'), 'new_one');
assert.equal(checkResultLabel('mismatch'), 'НЕ совпадает');
assert.match(freshnessLabel('stale_candidate'), /устарело/);
assert.equal(formatCost(check()), '$0.0012');
assert.equal(formatCost(check({ unpriced: true })), 'цена модели неизвестна');
assert.equal(formatCost(check({ costMicroUsd: null })), '—');

// Сообщение после «Проверить».
assert.match(enqueueMessage({ check: check(), created: true, reason: null }), /в очередь/);
assert.match(enqueueMessage({ check: check(), created: false, reason: 'already-checked' }), /не оплачивается/);
assert.match(enqueueMessage({ check: check(), created: false, reason: 'already-queued' }), /уже в очереди/);
assert.match(enqueueMessage({ check: check(), created: false, reason: 'retry' }), /заново/);

console.log('demo-quality.test.ts: ok');
