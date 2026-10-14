import assert from 'node:assert/strict';
import { createQaStandsApi } from '../src/lib/qa-stands-api';
import type { ApiClient } from '../src/kit';
const calls: unknown[][] = [];
const api = createQaStandsApi({
  request: async (...args: unknown[]) => {
    calls.push(args);
    return { status: 200, data: { items: [] }, revision: 1 };
  },
} as unknown as ApiClient);
await api.command('site', 'stand', {
  method: 'GET',
  role: 'admin',
  entityId: 'orders',
  query: 'a&b',
  scenario: 'empty',
  values: ['discarded'],
});
assert.deepEqual(calls[0], [
  'GET',
  '/qa/sites/site/stands/stand/mock?entity=orders&q=a%26b&scenario=empty',
]);
await api.command('site', 'stand', {
  method: 'POST',
  role: 'editor',
  values: ['saved'],
});
assert.deepEqual(calls[1], [
  'POST',
  '/qa/sites/site/stands/stand/mock',
  { method: 'POST', role: 'editor', values: ['saved'] },
]);
console.log(
  'Stand read uses GET without mutation fields; writes retain protected POST'
);
