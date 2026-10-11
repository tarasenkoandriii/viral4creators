'use strict';
const fs = require('node:fs');
async function deliver({ env = process.env, report, fetchImpl = fetch }) {
  if (env.GITHUB_REF !== 'refs/heads/main' || !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) throw new Error('CI delivery requires a trusted main workflow');
  if (report.metadata?.testSourceSha !== env.GITHUB_SHA) throw new Error('Report source mismatch');
  const api = new URL(env.ASSIST_API_URL);
  if (api.protocol !== 'https:' || api.username || api.password || api.pathname !== '/' || api.search || api.hash) throw new Error('Invalid report API origin');
  const oidc = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  // This URL and request credential are provided by GitHub, never by report contents.
  if (oidc.protocol !== 'https:') throw new Error('Invalid identity endpoint');
  oidc.searchParams.set('audience', 'viral4creators:qa-report');
  const tokenResponse = await fetchImpl(oidc, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!tokenResponse.ok) throw new Error('GitHub identity unavailable');
  const { value } = await tokenResponse.json();
  if (typeof value !== 'string' || !value) throw new Error('GitHub identity missing');
  const projects = [...new Set(report.results.map(row => row.project))];
  if (!projects.length) throw new Error('No browser results');
  for (const project of projects) {
    const response = await fetchImpl(new URL('/qa/ci/reports', api), { method: 'POST', headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json' }, body: JSON.stringify({ project, report }), signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok) throw new Error(`QA delivery rejected (${response.status})`);
    console.log(`QA report delivered: ${project}`);
  }
}
module.exports = { deliver };
if (require.main === module) {
  Promise.resolve().then(() => deliver({ report: JSON.parse(fs.readFileSync('test-results/qa-run.json', 'utf8')) })).catch(() => { console.error('QA delivery failed; the report remains in Actions artifacts.'); process.exitCode = 1; });
}
