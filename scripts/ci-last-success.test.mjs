import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastSuccessfulSha } from './ci-last-success.mjs';
const env = { GITHUB_REPOSITORY: 'owner/private', GITHUB_REF_NAME: 'feature/a&b', GH_TOKEN: 'test-token' };
test('private lookup authenticates, encodes branch and bounds request lifetime', async () => {
  const sha = 'a'.repeat(40);
  assert.equal(await lastSuccessfulSha(env, async (url, options) => {
    assert.match(url, /branch=feature%2Fa%26b&/);
    assert.equal(options.headers.authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ workflow_runs: [{ head_sha: sha }] }) };
  }), sha);
});
test('a stalled API lookup actually stops on the deadline', { timeout: 12000 }, async () => {
  // Keep the event loop alive: AbortSignal.timeout itself uses an unref timer.
  const keepAlive = setTimeout(() => {}, 11000);
  try {
    assert.equal(await lastSuccessfulSha(env, async (_url, { signal }) => {
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }), null);
  } finally {
    clearTimeout(keepAlive);
  }
});
test('missing credentials never make an anonymous request', async () => {
  assert.equal(await lastSuccessfulSha({}, () => assert.fail('unexpected request')), null);
});
test('API denial, cancellation, malformed JSON and invalid SHA force full CI', async () => {
  for (const fetcher of [
    async () => ({ ok: false }),
    async () => { throw new Error('aborted'); },
    async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }),
    async () => ({ ok: true, json: async () => ({ workflow_runs: [{ head_sha: 'invalid' }] }) }),
    async () => ({ ok: true, json: async () => null }),
  ]) assert.equal(await lastSuccessfulSha(env, fetcher), null);
});
