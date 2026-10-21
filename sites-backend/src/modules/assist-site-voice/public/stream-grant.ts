/** Short-lived authorization for the existing VPS relay; never a voice/action ticket.
 * Caller must authorize access and settle the existing SiteBudget BEFORE signing.
 */
import { createHmac, createHash, timingSafeEqual } from 'crypto';
export const STREAM_SECONDS = 30;
export function streamSettings(
  env: NodeJS.ProcessEnv,
  siteId?: string,
): {
  url: string;
  secret: string;
  chargeMicroUsd: number;
} | null {
  if (env.ASSIST_STREAM_ENABLED !== 'true') return null;
  // Optional canary scope: an empty or unknown site always fails closed.
  const sites = env.ASSIST_STREAM_SITE_IDS;
  if (
    sites !== undefined &&
    (!siteId ||
      !sites
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .includes(siteId))
  )
    return null;
  const secret = env.LIVE_LOGIN_RELAY_SECRET?.trim();
  const rate = Number(env.ASSIST_STREAM_MICRO_USD_PER_MINUTE);
  try {
    const url = new URL(env.LIVE_LOGIN_RELAY_URL ?? '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !secret ||
      !Number.isSafeInteger(rate) ||
      rate <= 0 ||
      rate > 1_000_000
    )
      return null;
    return {
      url: url.origin,
      secret,
      // Full 30-second wall duration, round up with 2x safety margin.
      // No refund for ambiguous disconnects; these are budget units, not a user invoice.
      chargeMicroUsd: Math.ceil(((rate * STREAM_SECONDS) / 60) * 2),
    };
  } catch {
    return null;
  }
}
export function signStreamGrant(
  secret: string,
  p: {
    boot: string;
    id: string;
    expires: number;
    seconds: number;
    siteId?: string;
    visitorId?: string;
  },
): { grant: string; signature: string } {
  const grant = Buffer.from(JSON.stringify(p)).toString('base64url');
  return {
    grant,
    signature: createHmac('sha256', secret)
      .update(`soniox-stream-v1:${grant}`)
      .digest('base64url'),
  };
}

/** Authenticated relay result, scoped to the original visitor/site grant. */
export function readStreamFinal(
  secret: string,
  p: {
    grant: string;
    receipt: string;
    signature: string;
  },
  siteId: string,
  visitorId: string,
  now: number,
): {
  id: string;
  expires: number;
  tokens: import('../../../shared/soniox-stt-core').SonioxToken[];
} | null {
  try {
    if (
      typeof p.grant !== 'string' ||
      typeof p.receipt !== 'string' ||
      typeof p.signature !== 'string' ||
      p.grant.length > 2048 ||
      p.receipt.length > 100_000
    )
      return null;
    const expected = createHmac('sha256', secret)
      .update(`soniox-final-v1:${p.receipt}`)
      .digest('base64url');
    if (
      Buffer.byteLength(expected) !== Buffer.byteLength(p.signature) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(p.signature))
    )
      return null;
    const grant = JSON.parse(Buffer.from(p.grant, 'base64url').toString());
    const result = JSON.parse(Buffer.from(p.receipt, 'base64url').toString());
    if (
      grant.siteId !== siteId ||
      grant.visitorId !== visitorId ||
      typeof grant.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(grant.id) ||
      !Number.isSafeInteger(grant.expires) ||
      result.grantHash !== createHash('sha256').update(p.grant).digest('hex') ||
      result.expires !== grant.expires + 60_000 ||
      result.expires <= now ||
      result.expires > now + 95_000 ||
      !Array.isArray(result.tokens) ||
      result.tokens.length > 1024 ||
      result.tokens.some(
        (t: { text?: unknown; is_final?: unknown }) =>
          !t || typeof t.text !== 'string' || t.is_final !== true,
      ) ||
      result.tokens.reduce(
        (n: number, t: { text: string }) => n + t.text.length,
        0,
      ) > 4000
    )
      return null;
    return { id: grant.id, expires: grant.expires, tokens: result.tokens };
  } catch {
    return null;
  }
}
