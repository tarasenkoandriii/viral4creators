/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/sites-api.ts */
/**
 * Маршруты ядра `site-core` — дословно ТЗ помощника §4.16 /
 * `TZ-QA-TMA.md` §4.8 (принимают initData любого из двух ботов).
 *
 * Ответы проходят через `parse*`: сервер пишет параллельно (Э0), и
 * неожиданное поле не должно превращаться в зелёную галочку — разбор
 * статуса строгий (`parseHostStatus`), всё неизвестное — «не подтверждён».
 */

import type { ApiClient } from './api-client';
import { START_PREFIXES } from './start-param';
import {
  assertVerifyToken,
  parseHostStatus,
  parseVerifyMethod,
  type VerifyInstruction,
} from './verification';
import type {
  AccountInfo,
  AccountMember,
  AccountRef,
  AccountRole,
  ForeignAuthorization,
  HostAuthorizations,
  HostCheck,
  Invite,
  ProductRoles,
  RevokeResult,
  Site,
  SiteAccount,
  SiteHost,
  VerifyMethod,
  VerifyResult,
} from './types';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseCheck(v: unknown): HostCheck | null {
  const o = obj(v);
  if (typeof o.ok !== 'boolean') return null;
  return {
    ok: o.ok,
    code: str(o.code) ?? undefined,
    message: str(o.message) ?? undefined,
    at: str(o.at) ?? undefined,
  };
}

export function parseHost(v: unknown): SiteHost {
  const o = obj(v);
  return {
    id: String(o.id ?? ''),
    siteId: String(o.siteId ?? ''),
    scheme: 'https',
    host: String(o.host ?? ''),
    port: typeof o.port === 'number' ? o.port : 443,
    // Неизвестный статус → pending: «не подтверждён» безопаснее ложного «да».
    status: parseHostStatus(o.status) ?? 'pending',
    method: parseVerifyMethod(o.method),
    verifiedAt: str(o.verifiedAt),
    expiresAt: str(o.expiresAt),
    revokedAt: str(o.revokedAt),
    publicPlatform: o.publicPlatform === true,
    lastCheck: parseCheck(o.lastCheck),
    lastRecheckAt: str(o.lastRecheckAt),
    // Строго `true`: блокировка запрещает действия, и «что-то похожее»
    // не должно ни запрещать, ни разрешать молча.
    reverifyBlocked: o.reverifyBlocked === true,
  };
}

export function parseSite(v: unknown): Site {
  const o = obj(v);
  return {
    id: String(o.id ?? ''),
    name: String(o.name ?? ''),
    hosts: arr(o.hosts).map(parseHost),
  };
}

function parseRole(v: unknown): AccountRole {
  // Неизвестная роль — самая узкая: лишние кнопки хуже недостающих.
  return v === 'owner' || v === 'manager' ? v : 'operator';
}

function parseRoles(v: unknown): ProductRoles {
  const o = obj(v);
  const pick = <T extends string>(x: unknown, allowed: T[]): T =>
    allowed.includes(x as T) ? (x as T) : ('none' as T);
  return {
    qa: pick(o.qa, ['admin', 'viewer', 'none']),
    assist: pick(o.assist, ['manager', 'operator', 'none']),
    assistAdmin: pick(o.assistAdmin, ['owner', 'employee', 'none']),
  };
}

function parseMember(v: unknown): AccountMember {
  const o = obj(v);
  return {
    telegramId: String(o.telegramId ?? ''),
    role: parseRole(o.role),
    productRoles: parseRoles(o.productRoles),
  };
}

export function parseAccountInfo(v: unknown): AccountInfo {
  const o = obj(v);
  const a = obj(o.account);
  const account: SiteAccount = {
    id: String(a.id ?? ''),
    type: a.type === 'agency' ? 'agency' : 'owner',
    region: String(a.region ?? 'other'),
    verifyToken: str(a.verifyToken),
  };
  const me = parseMember(o.me);
  const accounts: AccountRef[] = arr(o.accounts)
    .map((x) => obj(x))
    .filter((x) => typeof x.id === 'string' && x.id)
    .map((x) => ({ id: String(x.id), role: parseRole(x.role) }));
  return {
    account,
    me,
    // Нет поля — сервер не показал список (оператор), а не «пусто».
    members: Array.isArray(o.members) ? o.members.map(parseMember) : null,
    accounts: accounts.length ? accounts : [{ id: account.id, role: me.role }],
    created: o.created === true,
  };
}

/** Список сайтов: и голый массив, и `{ sites: [...] }`. */
function parseSites(v: unknown): Site[] {
  const list = Array.isArray(v) ? v : arr(obj(v).sites);
  return list.map(parseSite);
}

function parseVerify(v: unknown): VerifyResult {
  const o = obj(v);
  const host = parseHost(o.host);
  return {
    host,
    ok: o.ok === true && host.status === 'verified',
    code: str(o.code) ?? undefined,
    message: str(o.message) ?? undefined,
  };
}

/**
 * Инструкция сервера (`challenge`). Берётся, только если она целиком
 * правильной формы и для того же способа; иначе `null` — экран построит
 * инструкцию сам из токена (формат зафиксирован в brand.ts).
 */
export function parseInstruction(
  v: unknown,
  method: VerifyMethod
): VerifyInstruction | null {
  const o = obj(v);
  if (o.method !== method) return null;
  const s = (k: string) => str(o[k]);
  if (method === 'dns') {
    const name = s('name');
    const value = s('value');
    return name && value && (o.recordType ?? 'TXT') === 'TXT'
      ? { method, recordType: 'TXT', name, value }
      : null;
  }
  if (method === 'file') {
    const url = s('url');
    const content = s('content');
    return url && content ? { method, url, content } : null;
  }
  const pageUrl = s('pageUrl');
  const tag = s('tag');
  return pageUrl && tag ? { method, pageUrl, tag } : null;
}

export interface ChallengeResult {
  token: string | null;
  method: VerifyMethod;
  instruction: VerifyInstruction | null;
}

export function parseChallenge(
  v: unknown,
  method: VerifyMethod
): ChallengeResult {
  const o = obj(v);
  let token = str(o.token);
  if (token) {
    try {
      assertVerifyToken(token);
    } catch {
      token = null; // символы вне формата — не показываем как токен
    }
  }
  return {
    token,
    method,
    instruction: token ? parseInstruction(o.instruction, method) : null,
  };
}

export function parseInvite(v: unknown): Invite {
  const o = obj(v);
  const token = str(o.token);
  if (!token) throw new Error('Сервер не вернул приглашение');
  const startParam = str(o.startParam) ?? `${START_PREFIXES.inv}${token}`;
  return { token, startParam, expiresAt: str(o.expiresAt) };
}

function parseForeign(v: unknown): ForeignAuthorization {
  const o = obj(v);
  return {
    hostId: String(o.hostId ?? ''),
    status: parseHostStatus(o.status) ?? 'pending',
    method: parseVerifyMethod(o.method),
    verifiedAt: str(o.verifiedAt),
    expiresAt: str(o.expiresAt),
    revokedAt: str(o.revokedAt),
    reverifyBlocked: o.reverifyBlocked === true,
  };
}

export function parseAuthorizations(v: unknown): HostAuthorizations {
  const o = obj(v);
  return { host: parseHost(o.host), others: arr(o.others).map(parseForeign) };
}

export function parseRevoke(v: unknown): RevokeResult {
  const o = obj(v);
  const m = obj(o.foreignMarkers);
  return {
    revoked: typeof o.revoked === 'number' ? o.revoked : 0,
    foreignMarkers: {
      dnsName: String(m.dnsName ?? ''),
      dns: arr(m.dns).filter((x): x is string => typeof x === 'string'),
      file: str(m.file),
    },
  };
}

const enc = encodeURIComponent;

export function createSitesApi(client: ApiClient) {
  return {
    account: async () =>
      parseAccountInfo(await client.request('GET', '/sites/account')),
    /** Приглашение (только владелец): роль кабинета + права по продукту. */
    createInvite: async (
      role: 'manager' | 'operator',
      productRoles?: Partial<ProductRoles>
    ) =>
      parseInvite(
        await client.request('POST', '/sites/account/invites', {
          role,
          ...(productRoles ? { productRoles } : {}),
        })
      ),
    /** Принять приглашение; ответ — кабинет, куда человек вошёл. */
    acceptInvite: async (token: string) =>
      parseAccountInfo(
        await client.request('POST', '/sites/account/invites/accept', {
          token,
        })
      ),
    listSites: async () => parseSites(await client.request('GET', '/sites')),
    /** Создать сайт (имя) + первый хост. */
    createSite: async (name: string, url: string) =>
      parseSite(await client.request('POST', '/sites', { name, url })),
    addHost: async (siteId: string, url: string) =>
      parseHost(
        await client.request('POST', `/sites/${enc(siteId)}/hosts`, { url })
      ),
    deleteHost: async (siteId: string, hostId: string) => {
      const r = obj(
        await client.request(
          'DELETE',
          `/sites/${enc(siteId)}/hosts/${enc(hostId)}`
        )
      );
      return { deleted: r.deleted === true };
    },
    suggestHosts: async (siteId: string) => {
      const r = obj(
        await client.request('GET', `/sites/${enc(siteId)}/hosts/suggest`)
      );
      return arr(r.hosts).filter((h): h is string => typeof h === 'string');
    },
    /** Выдать токен/инструкцию: `{ token, method, instruction }`. */
    challenge: async (hostId: string, method: VerifyMethod) =>
      parseChallenge(
        await client.request('POST', `/sites/hosts/${enc(hostId)}/challenge`, {
          method,
        }),
        method
      ),
    verify: async (hostId: string, method: VerifyMethod) =>
      parseVerify(
        await client.request('POST', `/sites/hosts/${enc(hostId)}/verify`, {
          method,
        })
      ),
    verifyAll: async (siteId: string) => {
      const r = obj(
        await client.request('POST', `/sites/${enc(siteId)}/verify-all`)
      );
      return arr(r.results).map(parseVerify);
    },
    authorizations: async (hostId: string) =>
      parseAuthorizations(
        await client.request(
          'GET',
          `/sites/hosts/${enc(hostId)}/authorizations`
        )
      ),
    revokeForeign: async (hostId: string) =>
      parseRevoke(
        await client.request(
          'POST',
          `/sites/hosts/${enc(hostId)}/authorizations/revoke`
        )
      ),
    unblockForeign: async (hostId: string, otherHostId: string) => {
      const r = obj(
        await client.request(
          'POST',
          `/sites/hosts/${enc(hostId)}/authorizations/${enc(otherHostId)}/unblock`
        )
      );
      return { unblocked: r.unblocked === true };
    },
  };
}

export type SitesApi = ReturnType<typeof createSitesApi>;
