/** Short-lived authorization for the existing VPS relay; never a voice/action ticket.
 * Caller must authorize access and settle the existing SiteBudget BEFORE signing.
 */
import { createHmac } from 'crypto';
export const STREAM_SECONDS = 30;
export function streamSettings(env: NodeJS.ProcessEnv): {
  url: string;
  secret: string;
  chargeMicroUsd: number;
} | null {
  if (env.ASSIST_STREAM_ENABLED !== 'true') return null;
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
