const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deliver } = require('./deliver-report.cjs');
const env = { GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'schedule', GITHUB_SHA: 'a'.repeat(40), ASSIST_API_URL: 'https://example.test', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/identity', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic' };
const report = { metadata: { testSourceSha: env.GITHUB_SHA }, results: [{ project: 'desktop' }, { project: 'mobile' }, { project: 'desktop' }] };
test('obtains one identity and delivers each project separately', async () => {
  const calls = [];
  await deliver({ env, report, fetchImpl: async (url, options) => { calls.push([String(url), options]); return { ok: true, json: async () => ({ value: 'synthetic-jwt' }) }; } });
  assert.equal(calls.length, 3);
  assert.match(calls[0][0], /audience=viral4creators%3Aqa-report/);
  assert.equal(JSON.parse(calls[1][1].body).project, 'desktop');
  assert.equal(JSON.parse(calls[2][1].body).project, 'mobile');
  assert.equal(calls[1][1].redirect, 'error');
});
test('PR and wrong SHA never request credentials', async () => {
  const fetchImpl = async () => { throw new Error('must not fetch'); };
  await assert.rejects(deliver({ env: { ...env, GITHUB_EVENT_NAME: 'pull_request' }, report, fetchImpl }), /trusted/);
  await assert.rejects(deliver({ env, report: { ...report, metadata: { testSourceSha: 'b'.repeat(40) } }, fetchImpl }), /mismatch/);
});
test('API failure remains a failing step', async () => {
  let n = 0;
  await assert.rejects(deliver({ env, report, fetchImpl: async () => ++n === 1 ? { ok: true, json: async () => ({ value: 'synthetic' }) } : { ok: false, status: 403 } }), /403/);
});
