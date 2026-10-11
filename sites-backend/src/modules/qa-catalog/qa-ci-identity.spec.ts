import { generateKeyPairSync, sign } from 'node:crypto';
import { QaCiIdentity, QA_CI_AUDIENCE, QA_CI_ISSUER } from './qa-ci-identity';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'test',
  alg: 'RS256',
  use: 'sig',
};
const trust = {
  repository: 'owner/repo',
  repositoryId: '123',
  ownerId: '456',
  workflow: '.github/workflows/qa.yml',
};
const claims = {
  iss: QA_CI_ISSUER,
  aud: QA_CI_AUDIENCE,
  sub: 'repo:owner/repo:ref:refs/heads/main',
  repository: trust.repository,
  repository_id: '123',
  repository_owner_id: '456',
  ref: 'refs/heads/main',
  workflow_ref: 'owner/repo/.github/workflows/qa.yml@refs/heads/main',
  event_name: 'schedule',
  runner_environment: 'github-hosted',
  exp: 1300,
  nbf: 990,
  iat: 1000,
  run_id: '1234',
  run_attempt: '1',
  sha: 'a'.repeat(40),
};
function token(changes = {}, headerChanges = {}) {
  const encode = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString('base64url');
  const body = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'test', ...headerChanges })}.${encode({ ...claims, ...changes })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), pair.privateKey).toString('base64url')}`;
}
test('verifies RSA signature, pinned trust, and caches keys', async () => {
  const fetchKeys = jest.fn().mockResolvedValue([key]);
  const identity = new QaCiIdentity(fetchKeys);
  await expect(identity.authenticate(token(), trust, 1100)).resolves.toEqual({
    runId: '1234',
    runAttempt: '1',
    sha: claims.sha,
  });
  await expect(
    identity.authenticate(
      token({ sub: 'repo:owner@456/repo@123:ref:refs/heads/main' }),
      trust,
      1101,
    ),
  ).resolves.toBeDefined();
  expect(fetchKeys).toHaveBeenCalledTimes(1);
});
test.each([
  { aud: 'wrong' },
  { iss: 'https://evil.test' },
  { repository_id: '999' },
  { repository_owner_id: '999' },
  { repository: 'fork/repo' },
  { ref: 'refs/heads/feature' },
  { event_name: 'pull_request' },
  { event_name: 'dynamic' },
  { sub: 'repo:owner/repo:pull_request' },
  { workflow_ref: 'owner/repo/.github/workflows/other.yml@refs/heads/main' },
  { exp: 1099 },
  { nbf: 1200 },
  { iat: 1200 },
  { exp: 2000 },
  { sha: 'bad' },
  { run_id: '../evil' },
  { run_attempt: '0' },
  { runner_environment: 'self-hosted' },
  { exp: '1300' },
])('rejects claim mutation %j', async (changes) => {
  await expect(
    new QaCiIdentity(async () => [key]).authenticate(
      token(changes),
      trust,
      1100,
    ),
  ).rejects.toThrow('CI identity rejected');
});
test('rejects alg confusion, unknown keys, and tampered signatures', async () => {
  const identity = new QaCiIdentity(async () => [key]);
  await expect(
    identity.authenticate(token({}, { alg: 'HS256' }), trust, 1100),
  ).rejects.toThrow();
  await expect(
    identity.authenticate(token({}, { kid: 'unknown' }), trust, 1100),
  ).rejects.toThrow();
  const parts = token().split('.');
  parts[1] = Buffer.from(
    JSON.stringify({ ...claims, repository_id: '999' }),
  ).toString('base64url');
  await expect(
    identity.authenticate(parts.join('.'), trust, 1100),
  ).rejects.toThrow();
});
test('key fetch failures deny access', async () => {
  await expect(
    new QaCiIdentity(async () => {
      throw new Error('offline');
    }).authenticate(token(), trust, 1100),
  ).rejects.toThrow('CI identity rejected');
});
