/**
 * Хост наружу — форма, которую ждёт site-tma-kit (`parseHost` в
 * site-tma-kit/src/sites-api.ts): `{ id, siteId, scheme, host, port,
 * status, method, verifiedAt, expiresAt, revokedAt, publicPlatform,
 * lastCheck }` + служебное `lastRecheckAt`, `reverifyBlocked`.
 *
 * Статус — ДЕЙСТВУЮЩИЙ: `verified` с наступившим `expiresAt` отдаётся как
 * `expired`, не дожидаясь крона (зелёная галочка на истёкшем — ложное
 * обещание, что виджет и обход работают).
 */

import type { SiteHost } from '@prisma/client';
import { HostStatus, VerifyMethod } from '../site-core.constants';
import type { CheckResult } from '../ownership/ownership-checker';

// `type`, а не `interface`: значение пишется в Json-колонку, а Prisma
// принимает только типы с неявной индексной сигнатурой.
export type HostCheckView = {
  ok: boolean;
  code: string;
  message: string;
  at: string;
};

export interface HostView {
  id: string;
  siteId: string;
  scheme: 'https';
  host: string;
  port: number;
  status: HostStatus;
  method: VerifyMethod | null;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastRecheckAt: Date | null;
  publicPlatform: boolean;
  lastCheck: HostCheckView | null;
  /** Подтверждение отозвано другим кабинетом; повтор заблокирован. */
  reverifyBlocked: boolean;
}

export function effectiveStatus(
  row: Pick<SiteHost, 'status' | 'expiresAt'>,
  now: Date,
): HostStatus {
  switch (row.status) {
    case 'verified':
      return row.expiresAt && row.expiresAt.getTime() > now.getTime()
        ? 'verified'
        : 'expired';
    case 'expired':
    case 'revoked':
      return row.status;
    default:
      // Неизвестное значение в базе — никогда не `verified`.
      return 'pending';
  }
}

function parseMethod(v: string | null): VerifyMethod | null {
  return v === 'dns' || v === 'file' || v === 'meta' ? v : null;
}

function parseCheck(v: unknown): HostCheckView | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.ok !== 'boolean') return null;
  return {
    ok: o.ok,
    code: typeof o.code === 'string' ? o.code : '',
    message: typeof o.message === 'string' ? o.message : '',
    at: typeof o.at === 'string' ? o.at : '',
  };
}

/** JSON для колонки `lastCheck`. */
export function checkJson(
  r: Pick<CheckResult, 'ok' | 'code' | 'message'>,
  now: Date,
): HostCheckView {
  return { ok: r.ok, code: r.code, message: r.message, at: now.toISOString() };
}

export function toHostView(row: SiteHost, now: Date): HostView {
  return {
    id: row.id,
    siteId: row.siteId,
    scheme: 'https',
    host: row.host,
    port: row.port,
    status: effectiveStatus(row, now),
    method: parseMethod(row.method),
    verifiedAt: row.verifiedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastRecheckAt: row.lastRecheckAt,
    publicPlatform: row.publicPlatform,
    lastCheck: parseCheck(row.lastCheck),
    reverifyBlocked: row.reverifyBlockedAt !== null,
  };
}
