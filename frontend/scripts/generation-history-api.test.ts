import assert from 'node:assert/strict';
import { parseGenerationHistoryPage } from '../src/lib/generation-history-contract';
const item = {
  id: 'attempt',
  sessionId: 'session',
  status: 'complete',
  createdAt: '2026-11-01T12:00:00Z',
  resolution: '720p',
  userId: 'private',
  signedUrl: 'private',
  prompt: 'private',
};
const page = parseGenerationHistoryPage({ items: [item], nextCursor: null });
assert.deepEqual(Object.keys(page.items[0]).sort(), [
  'createdAt',
  'id',
  'resolution',
  'sessionId',
  'status',
]);
assert.equal(JSON.stringify(page).includes('private'), false);
assert.equal(
  parseGenerationHistoryPage({
    items: [{ ...item, status: 'future-status' }],
    nextCursor: null,
  }).items[0].status,
  'unknown'
);
assert.equal(
  parseGenerationHistoryPage({
    items: [{ ...item, resolution: '<script>' }],
    nextCursor: null,
  }).items[0].resolution,
  null
);
for (const value of [
  null,
  {},
  { items: [null], nextCursor: null },
  { items: [{ ...item, createdAt: 'invalid' }], nextCursor: null },
  { items: [], nextCursor: [] },
]) {
  assert.throws(() => parseGenerationHistoryPage(value));
}
console.log(
  'PASS history API validates response, drops private fields, handles unknown statuses and invalid dates'
);
