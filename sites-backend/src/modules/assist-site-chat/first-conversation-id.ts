import { createHash } from 'crypto';

/** Stable, opaque first-request identity scoped to the authenticated tenant and visitor. */
export function firstConversationId(
  accountId: string,
  siteId: string,
  visitorId: string,
  clientRequestId: string,
): string {
  return (
    'c' +
    createHash('sha256')
      .update(JSON.stringify([accountId, siteId, visitorId, clientRequestId]))
      .digest('hex')
      .slice(0, 40)
  );
}
