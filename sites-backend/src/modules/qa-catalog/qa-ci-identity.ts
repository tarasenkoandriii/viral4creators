import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
export const QA_CI_ISSUER = 'https://token.actions.githubusercontent.com';
export const QA_CI_AUDIENCE = 'viral4creators:qa-report';
export type QaCiTrust = {
  repository: string;
  repositoryId: string;
  ownerId: string;
  workflow: string;
};
const denied = () =>
  new UnauthorizedException({
    code: 'QA_CI_UNAUTHORIZED',
    message: 'CI identity rejected.',
  });
type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
/** Fixed issuer only: untrusted JWT headers never select a remote key URL. */
export class QaCiIdentity {
  private keys: Jwk[] = [];
  private expires = 0;
  private loading?: Promise<void>;
  constructor(
    private readonly fetchKeys: () => Promise<Jwk[]> = async () => {
      const res = await fetch(`${QA_CI_ISSUER}/.well-known/jwks`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!res.ok) throw denied();
      const body = await res.text();
      if (body.length > 128 * 1024) throw denied();
      const parsed = JSON.parse(body) as { keys?: Jwk[] };
      if (!Array.isArray(parsed.keys) || parsed.keys.length > 100)
        throw denied();
      return parsed.keys;
    },
  ) {}
  async authenticate(
    token: string,
    trust: QaCiTrust,
    now = Math.floor(Date.now() / 1000),
  ) {
    try {
      if (token.length > 16384) throw denied();
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
        throw denied();
      const header = JSON.parse(
        Buffer.from(parts[0], 'base64url').toString(),
      ) as Record<string, unknown>;
      if (
        header.alg !== 'RS256' ||
        header.typ !== 'JWT' ||
        typeof header.kid !== 'string' ||
        header.kid.length > 200
      )
        throw denied();
      if (this.expires <= now) {
        this.loading ??= this.fetchKeys()
          .then((keys) => {
            this.keys = keys;
            this.expires = now + 300;
          })
          .finally(() => {
            this.loading = undefined;
          });
        await this.loading;
      }
      const key = this.keys.find(
        (k) =>
          k.kid === header.kid &&
          k.kty === 'RSA' &&
          k.alg === 'RS256' &&
          k.use === 'sig',
      );
      if (
        !key ||
        !verify(
          'RSA-SHA256',
          Buffer.from(`${parts[0]}.${parts[1]}`),
          createPublicKey({ key, format: 'jwk' }),
          Buffer.from(parts[2], 'base64url'),
        )
      )
        throw denied();
      const c = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString(),
      ) as Record<string, unknown>;
      const legacy = `repo:${trust.repository}:ref:refs/heads/main`;
      const [owner, repo] = trust.repository.split('/');
      const immutable = `repo:${owner}@${trust.ownerId}/${repo}@${trust.repositoryId}:ref:refs/heads/main`;
      if (
        c.iss !== QA_CI_ISSUER ||
        c.aud !== QA_CI_AUDIENCE ||
        ![legacy, immutable].includes(String(c.sub)) ||
        c.repository !== trust.repository ||
        c.repository_id !== trust.repositoryId ||
        c.repository_owner_id !== trust.ownerId ||
        c.ref !== 'refs/heads/main' ||
        c.workflow_ref !==
          `${trust.repository}/${trust.workflow}@refs/heads/main` ||
        !['schedule', 'workflow_dispatch'].includes(String(c.event_name)) ||
        c.runner_environment !== 'github-hosted' ||
        !Number.isSafeInteger(c.exp) ||
        !Number.isSafeInteger(c.nbf) ||
        !Number.isSafeInteger(c.iat) ||
        (c.exp as number) <= now ||
        (c.nbf as number) > now + 30 ||
        (c.iat as number) > now + 30 ||
        (c.exp as number) - (c.iat as number) > 600 ||
        (c.iat as number) < now - 600 ||
        typeof c.run_id !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(c.run_id) ||
        typeof c.run_attempt !== 'string' ||
        !/^[1-9][0-9]{0,5}$/.test(c.run_attempt) ||
        typeof c.sha !== 'string' ||
        !/^[a-f0-9]{40}$/.test(c.sha)
      )
        throw denied();
      return { runId: c.run_id, runAttempt: c.run_attempt, sha: c.sha };
    } catch {
      throw denied();
    }
  }
}
