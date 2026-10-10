import { AsyncLocalStorage } from 'node:async_hooks';
type Context = {
  source: string;
  actorRole: string;
  actorId: string | null;
  accountId: string | null;
  siteId: string | null;
};
export const sonioxContext = new AsyncLocalStorage<Context>();
export function sonioxRequestContext(req: {
  route?: { path?: string };
  userId?: string;
  identity?: { telegramId?: bigint };
  telegramUserId?: string;
  headers?: Record<string, string | string[] | undefined>;
  accountId?: string;
  params?: Record<string, string>;
}): Context {
  const source = String(req.route?.path ?? 'http').slice(0, 180);
  const actorRole = /internal\/admin|^\/api\/admin|^\/admin/.test(source)
    ? 'operator'
    : /cron|worker/.test(source)
      ? 'cron'
      : /^\/assist(?:\/|$)|admin/.test(source)
        ? 'administrator'
        : 'client';
  const id = (v: unknown) =>
    typeof v === 'string' || typeof v === 'bigint'
      ? String(v).slice(0, 100)
      : null;
  return {
    source,
    actorRole,
    actorId: id(
      req.userId ??
        req.identity?.telegramId ??
        req.telegramUserId ??
        (/internal\/admin/.test(source)
          ? req.headers?.['x-admin-actor']
          : null),
    ),
    accountId: id(req.accountId ?? req.params?.accountId),
    siteId: id(req.params?.siteId),
  };
}

/** Enrich only from a site/session already resolved by the service, never from a public body. */
export function sonioxScope(scope: Partial<Context>): void {
  const current = sonioxContext.getStore();
  if (current) Object.assign(current, scope);
}
