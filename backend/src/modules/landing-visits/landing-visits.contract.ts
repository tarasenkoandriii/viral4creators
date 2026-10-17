import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
export const LANDINGS = [
  'main',
  'greeting',
  'tutorial',
  'assistant',
  'publisher',
] as const;
export const VISIT_LOCALES = ['ru', 'uk', 'en', 'de', 'es'] as const;
const ORIGINS: Record<string, readonly string[]> = {
  'https://welcome.viral4creators.app': ['main', 'greeting', 'tutorial'],
  'https://wellcome.viral4creators.app': ['main', 'greeting', 'tutorial'],
  'https://viral-landing-seven.vercel.app': ['main', 'greeting', 'tutorial'],
  'https://greeting.viral4creators.app': ['greeting'],
  'https://tutorial.viral4creators.app': ['tutorial'],
  'https://assist.viral4creators.app': ['assistant'],
  'https://ai-publisher.org': ['publisher'],
  'https://www.ai-publisher.org': ['publisher'],
};
export function visitOriginAllowed(
  origin: string | undefined,
  landing: string,
) {
  return !!origin && !!ORIGINS[origin]?.includes(landing);
}
export function visitHash(
  ip: string,
  enabled: boolean,
  secret: string | undefined,
): string | null {
  if (!enabled || !secret || secret.length < 32 || !isIP(ip)) return null;
  // Canonicalize IPv6 (otherwise equivalent written addresses count twice).
  const normalized = isIP(ip) === 6 ? new URL(`http://[${ip}]`).hostname : ip;
  return createHmac('sha256', secret)
    .update('landing-visitor:v1:' + normalized)
    .digest('hex');
}
