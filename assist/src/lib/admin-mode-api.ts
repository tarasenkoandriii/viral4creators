/**
 * Клиент режима «Админка» (Э7, ТЗ §3.8, §5): режим и секрет подписи JWT,
 * коннекторы OpenAPI и операции, журнал вызовов, очередь «Обучение
 * (сотрудники)», статистика, обход за логином и чат сотрудника в TMA (7a).
 * Разбор строгий: неизвестное значение — умолчание, а не «что пришло».
 * Секретов в ответах нет по построению сервера (только «••••хвост»);
 * секрет подписи JWT приходит ОДИН раз — из ответа выпуска.
 */
import type { ApiClient } from '../kit';
import { type Proposal, parseProposal } from './admin-actions-api';
import { seg } from './handoff-api';
import { createAdminVoiceApi, type AdminVoiceApi } from './admin-voice-api';

export const ADMIN_MODE_TABS = [
  'settings',
  'connectors',
  'log',
  'memos',
  'learning',
  'stats',
  // Э6-бис (б): голосовое управление «Админкой».
  'voice',
] as const;
export type AdminModeTab = (typeof ADMIN_MODE_TABS)[number];
export const isAdminModeTab = (v: string): v is AdminModeTab =>
  (ADMIN_MODE_TABS as readonly string[]).includes(v);

export type AdminAccess = 'tma' | 'script' | 'both';
export type OperationKind = 'read' | 'write' | 'danger';

export interface AdminModeView {
  siteId: string;
  enabled: boolean;
  access: AdminAccess;
  siteVerified: boolean;
  planAllows: boolean;
  hosts: Array<{ id: string; host: string; status: string; verified: boolean }>;
  adminHostIds: string[];
  identitySecret: { set: boolean; setAt: string | null };
  instructions: string | null;
  roleMap: Record<string, string>;
  tmaEmployeeRole: string | null;
  statsPerEmployee: boolean;
  /** Э8: тариф Pro — «Админка: действия». */
  planAllowsActions: boolean;
  actionsDailyCap: number;
  notifyDanger: boolean;
  /** Р-З9-17: тестовый ключ ходит в коннекторы (умолчание — нет). */
  testKeyConnectors: boolean;
  snippet: { origin: string; tag: string; csp: string } | null;
}

export interface OperationParamView {
  name: string;
  in: 'path' | 'query' | 'body';
  required: boolean;
  type: string;
}

/** Э8: `x-assist-compensation` / `x-assist-preview`. */
export interface LinkedOperationView {
  operationId: string;
  params: Record<string, string>;
}

export interface OperationView {
  id: string;
  operationId: string;
  method: string;
  path: string;
  summary: string | null;
  autoKind: OperationKind;
  kind: OperationKind;
  kindReason: string | null;
  enabled: boolean;
  roles: string[];
  dailyLimit: number | null;
  unsupported: boolean;
  params: OperationParamView[];
  // Э8
  idempotent: boolean;
  compensation: LinkedOperationView | null;
  preview: LinkedOperationView | null;
  dryRunParam: string | null;
  amountParam: string | null;
  autoAmountParam: string | null;
  maxAmount: number | null;
  dailyAmountCap: number | null;
  confirmWord: string | null;
}

export interface ConnectorView {
  id: string;
  name: string;
  baseUrl: string;
  allowedHosts: string[];
  hostVerified: boolean;
  saasAcknowledged: boolean;
  specTitle: string | null;
  authKind: string;
  secret: { set: boolean; tail: string | null; setAt: string | null };
  status: string;
  lastCallAt: string | null;
  signing: { set: boolean; setAt: string | null };
  /** Р-З9-14: ПД в данных API скрыты от модели. */
  maskPd: boolean;
  operations: OperationView[];
}

export interface ActionLogRow {
  id: string;
  at: string;
  actor: string;
  actorRole: string | null;
  channel: string;
  operation: string;
  outcome: string;
  httpStatus: number | null;
  durationMs: number | null;
  request: { method?: string; path?: string; query?: Record<string, string> };
}

export interface AdminLearningItem {
  id: string;
  kind: string;
  status: string;
  question: string;
  answer: string | null;
  proposedAnswer: string | null;
  clusterSize: number;
  createdAt: string;
}

export interface AdminStats {
  days: number;
  conversations: number;
  questions: number;
  refusedShare: number;
  thumbsDown: number;
  learningNew: number;
  topQuestions: Array<{ sample: string; count: number }>;
  tools: Array<{ operation: string; ok: number; failed: number }>;
  byRole: Array<{ role: string; conversations: number; questions: number }>;
  byEmployee: Array<{ employee: string; questions: number }> | null;
  /** Э8-хвост (6): действия и метрики монитора §5-бис.15 п.12. */
  actions: AdminActionStatsView;
}

/** Блок «Действия» статистики (заход 9): доли — 0..1 или null. */
export interface AdminActionStatsView {
  proposed: number;
  confirmed: number;
  rejected: number;
  expired: number;
  yesShare: number | null;
  done: number;
  failed: number;
  unknown: number;
  unknownShare: number | null;
  unrequested: number;
  chainsWithTraces: number;
  compensations: {
    proposed: number;
    confirmed: number;
    done: number;
    failed: number;
    unknown: number;
    successRate: number | null;
    alert: boolean;
  };
  byOperation: Array<{
    operation: string;
    proposed: number;
    confirmed: number;
    done: number;
    unknown: number;
  }>;
}

export interface PrivateCrawlView {
  enabled: boolean;
  hostId: string | null;
  testAccountId: string | null;
  startPath: string;
  hosts: Array<{ id: string; host: string }>;
  testAccounts: Array<{
    id: string;
    label: string;
    hostIds: string[];
    /** Э-С Ш3: учётке разрешён продукт «Помощник: обход Админки». */
    adminCrawl: boolean;
  }>;
  jobs: Array<{
    id: string;
    status: string;
    createdAt: string;
    note: string | null;
  }>;
  /** Э-С Ш3: `ready` — браузерный воркер подключён, `waiting_sh3` — нет. */
  worker: 'waiting_sh3' | 'ready';
}

export interface AdminChatMessage {
  id: string;
  role: 'employee' | 'assistant';
  text: string;
  answerPath: string | null;
  rating: number | null;
  tools: Array<{ operation: string; outcome: string }>;
  /** Э8: карточка подтверждения при сообщении. */
  proposalId: string | null;
}

export interface AdminChatState {
  messages: AdminChatMessage[];
  tools: boolean;
  /** Э8: карточки за 8 ч (восстановление после перезагрузки, §4-бис.5). */
  proposals: Proposal[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' ? v : null;
const strs = (v: unknown): string[] =>
  arr(v).filter((x): x is string => typeof x === 'string');
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const n0 = (v: unknown): number => numOrNull(v) ?? 0;
const kind = (v: unknown): OperationKind =>
  v === 'write' || v === 'danger' ? v : 'read';

const share = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n !== null && n >= 0 && n <= 1 ? n : null;
};

/** Разбор блока «Действия» (строго: доля вне 0..1 — null). */
export function parseActionStats(v: unknown): AdminActionStatsView {
  const o = obj(v);
  const c = obj(o.compensations);
  return {
    proposed: n0(o.proposed),
    confirmed: n0(o.confirmed),
    rejected: n0(o.rejected),
    expired: n0(o.expired),
    yesShare: share(o.yesShare),
    done: n0(o.done),
    failed: n0(o.failed),
    unknown: n0(o.unknown),
    unknownShare: share(o.unknownShare),
    unrequested: n0(o.unrequested),
    chainsWithTraces: n0(o.chainsWithTraces),
    compensations: {
      proposed: n0(c.proposed),
      confirmed: n0(c.confirmed),
      done: n0(c.done),
      failed: n0(c.failed),
      unknown: n0(c.unknown),
      successRate: share(c.successRate),
      alert: c.alert === true,
    },
    byOperation: arr(o.byOperation)
      .map((x) => {
        const r = obj(x);
        return {
          operation: str(r.operation),
          proposed: n0(r.proposed),
          confirmed: n0(r.confirmed),
          done: n0(r.done),
          unknown: n0(r.unknown),
        };
      })
      .filter((r) => r.operation)
      .slice(0, 20),
  };
}

/** `?lang=` для текстов карточек с сервера (аудит Э8 (5)). */
const LANG_Q = /^(uk|ru|en)$/;
const langQ = (lang?: string) =>
  lang && LANG_Q.test(lang) ? `?lang=${lang}` : '';

export function parseAdminMode(v: unknown): AdminModeView {
  const o = obj(v);
  const sec = obj(o.identitySecret);
  const sn = obj(o.snippet);
  const rm: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj(o.roleMap))) {
    if (typeof val === 'string') rm[k] = val;
  }
  return {
    siteId: str(o.siteId),
    enabled: o.enabled === true,
    access: o.access === 'script' || o.access === 'both' ? o.access : 'tma',
    siteVerified: o.siteVerified === true,
    planAllows: o.planAllows === true,
    hosts: arr(o.hosts).map((h) => {
      const x = obj(h);
      return {
        id: str(x.id),
        host: str(x.host),
        status: str(x.status),
        verified: x.verified === true,
      };
    }),
    adminHostIds: strs(o.adminHostIds),
    identitySecret: { set: sec.set === true, setAt: strOrNull(sec.setAt) },
    instructions: strOrNull(o.instructions),
    roleMap: rm,
    tmaEmployeeRole: strOrNull(o.tmaEmployeeRole),
    statsPerEmployee: o.statsPerEmployee === true,
    planAllowsActions: o.planAllowsActions === true,
    actionsDailyCap: numOrNull(o.actionsDailyCap) ?? 100,
    notifyDanger: o.notifyDanger !== false,
    testKeyConnectors: o.testKeyConnectors === true,
    snippet:
      typeof sn.tag === 'string'
        ? { origin: str(sn.origin), tag: str(sn.tag), csp: str(sn.csp) }
        : null,
  };
}

function parseLink(v: unknown): LinkedOperationView | null {
  const o = obj(v);
  if (typeof o.operationId !== 'string') return null;
  const params: Record<string, string> = {};
  for (const [k, x] of Object.entries(obj(o.params))) {
    if (typeof x === 'string') params[k] = x;
  }
  return { operationId: o.operationId, params };
}

export function parseOperation(v: unknown): OperationView {
  const o = obj(v);
  return {
    id: str(o.id),
    operationId: str(o.operationId),
    method: str(o.method),
    path: str(o.path),
    summary: strOrNull(o.summary),
    autoKind: kind(o.autoKind),
    kind: kind(o.kind),
    kindReason: strOrNull(o.kindReason),
    enabled: o.enabled === true,
    roles: strs(o.roles),
    dailyLimit: numOrNull(o.dailyLimit),
    unsupported: o.unsupported === true,
    params: arr(o.params).map((p) => {
      const x = obj(p);
      return {
        name: str(x.name),
        in: x.in === 'query' ? 'query' : x.in === 'body' ? 'body' : 'path',
        required: x.required === true,
        type: str(x.type),
      };
    }),
    idempotent: o.idempotent === true,
    compensation: parseLink(o.compensation),
    preview: parseLink(o.preview),
    dryRunParam: strOrNull(o.dryRunParam),
    amountParam: strOrNull(o.amountParam),
    autoAmountParam: strOrNull(o.autoAmountParam),
    maxAmount: numOrNull(o.maxAmount),
    dailyAmountCap: numOrNull(o.dailyAmountCap),
    confirmWord: strOrNull(o.confirmWord),
  };
}

export function parseConnector(v: unknown): ConnectorView {
  const o = obj(v);
  const s = obj(o.secret);
  return {
    id: str(o.id),
    name: str(o.name),
    baseUrl: str(o.baseUrl),
    allowedHosts: strs(o.allowedHosts),
    hostVerified: o.hostVerified === true,
    saasAcknowledged: o.saasAcknowledged === true,
    specTitle: strOrNull(o.specTitle),
    authKind: str(o.authKind) || 'none',
    secret: {
      set: s.set === true,
      tail: strOrNull(s.tail),
      setAt: strOrNull(s.setAt),
    },
    status: str(o.status),
    lastCallAt: strOrNull(o.lastCallAt),
    signing: {
      set: obj(o.signing).set === true,
      setAt: strOrNull(obj(o.signing).setAt),
    },
    maskPd: o.maskPd === true,
    operations: arr(o.operations).map(parseOperation),
  };
}

export function parseChatMessage(v: unknown): AdminChatMessage {
  const o = obj(v);
  return {
    id: str(o.id),
    role: o.role === 'employee' ? 'employee' : 'assistant',
    text: str(o.text),
    answerPath: strOrNull(o.answerPath),
    rating: o.rating === 1 || o.rating === -1 ? o.rating : null,
    tools: arr(o.tools).map((t) => {
      const x = obj(t);
      return { operation: str(x.operation), outcome: str(x.outcome) };
    }),
    proposalId: strOrNull(o.proposalId),
  };
}

export interface AdminModeApi {
  get(siteId: string): Promise<AdminModeView>;
  patch(
    siteId: string,
    body: Partial<{
      enabled: boolean;
      access: AdminAccess;
      adminHostIds: string[];
      instructions: string | null;
      roleMap: Record<string, string>;
      tmaEmployeeRole: string | null;
      statsPerEmployee: boolean;
      actionsDailyCap: number;
      notifyDanger: boolean;
      testKeyConnectors: boolean;
    }>
  ): Promise<AdminModeView>;
  /**
   * Перевыпуск секрета подписи JWT (Р-З9-18): `expectedSetAt` — выпуск,
   * который видит экран (null — секрета не было); параллельный перевыпуск
   * из другого окна — 409 `ADMIN_SECRET_CHANGED`, экран перечитывается.
   */
  issueIdentitySecret(
    siteId: string,
    expectedSetAt?: string | null
  ): Promise<{ secret: string; aud: string }>;
  connectors(siteId: string): Promise<ConnectorView[]>;
  createConnector(
    siteId: string,
    body: {
      name: string;
      specUrl?: string;
      specText?: string;
      baseUrl?: string;
      saasAcknowledged?: boolean;
    }
  ): Promise<ConnectorView>;
  deleteConnector(siteId: string, cn: string): Promise<void>;
  /** Р-З9-14: флаги коннектора (маскирование ПД до модели). */
  patchConnector(
    siteId: string,
    cn: string,
    body: { maskPd: boolean }
  ): Promise<ConnectorView>;
  patchOperation(
    siteId: string,
    cn: string,
    op: string,
    body: Partial<{
      enabled: boolean;
      kind: OperationKind;
      roles: string[];
      dailyLimit: number | null;
      // Э8
      idempotent: boolean;
      compensation: LinkedOperationView | null;
      preview: LinkedOperationView | null;
      dryRunParam: string | null;
      amountParam: string | null;
      maxAmount: number | null;
      dailyAmountCap: number | null;
      confirmWord: string | null;
    }>
  ): Promise<OperationView>;
  putSecret(
    siteId: string,
    cn: string,
    body: {
      authKind: 'bearer' | 'basic' | 'header';
      headerName?: string;
      secret: string;
    }
  ): Promise<ConnectorView>;
  actionLog(siteId: string): Promise<ActionLogRow[]>;
  learning(siteId: string): Promise<AdminLearningItem[]>;
  acceptLearning(siteId: string, itemId: string, answer: string): Promise<void>;
  rejectLearning(siteId: string, itemId: string): Promise<void>;
  stats(siteId: string, days: 7 | 30): Promise<AdminStats>;
  privateCrawl(siteId: string): Promise<PrivateCrawlView>;
  putPrivateCrawl(
    siteId: string,
    body: {
      enabled: boolean;
      hostId?: string;
      testAccountId?: string;
      startPath?: string;
    }
  ): Promise<PrivateCrawlView>;
  runPrivateCrawl(siteId: string): Promise<{ status: string }>;
  chatState(siteId: string, lang?: string): Promise<AdminChatState>;
  chatAsk(
    siteId: string,
    text: string,
    clientRequestId: string
  ): Promise<{ messages: AdminChatMessage[]; proposal: Proposal | null }>;
  chatFeedback(
    siteId: string,
    mid: string,
    rating: 1 | -1,
    correction?: string
  ): Promise<void>;
  /** Э6-бис (б): голосовое управление «Админкой» (вкладка «Голос»). */
  voice: AdminVoiceApi;
}

function parseCrawl(v: unknown): PrivateCrawlView {
  const o = obj(v);
  return {
    enabled: o.enabled === true,
    hostId: strOrNull(o.hostId),
    testAccountId: strOrNull(o.testAccountId),
    startPath: str(o.startPath) || '/',
    hosts: arr(o.hosts).map((h) => ({
      id: str(obj(h).id),
      host: str(obj(h).host),
    })),
    testAccounts: arr(o.testAccounts).map((a) => {
      const x = obj(a);
      return {
        id: str(x.id),
        label: str(x.label),
        hostIds: strs(x.hostIds),
        adminCrawl: x.adminCrawl === true,
      };
    }),
    jobs: arr(o.jobs).map((j) => {
      const x = obj(j);
      return {
        id: str(x.id),
        status: str(x.status),
        createdAt: str(x.createdAt),
        note: strOrNull(x.note),
      };
    }),
    worker: o.worker === 'ready' ? 'ready' : 'waiting_sh3',
  };
}

export function createAdminModeApi(client: ApiClient): AdminModeApi {
  const base = (s: string) => `/assist/sites/${seg(s)}`;
  const opSeg = (op: string) => {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(op))
      throw new Error('bad operation id');
    return op;
  };
  return {
    get: async (s) =>
      parseAdminMode(await client.request('GET', `${base(s)}/admin-mode`)),
    patch: async (s, b) =>
      parseAdminMode(await client.request('PATCH', `${base(s)}/admin-mode`, b)),
    issueIdentitySecret: async (s, expectedSetAt) => {
      const o = obj(
        await client.request(
          'POST',
          `${base(s)}/admin-mode/identity-secret`,
          expectedSetAt === undefined ? undefined : { expectedSetAt }
        )
      );
      return { secret: str(o.secret), aud: str(o.aud) };
    },
    connectors: async (s) =>
      arr(await client.request('GET', `${base(s)}/connectors`)).map(
        parseConnector
      ),
    createConnector: async (s, b) =>
      parseConnector(await client.request('POST', `${base(s)}/connectors`, b)),
    patchConnector: async (s, cn, b) =>
      parseConnector(
        await client.request('PATCH', `${base(s)}/connectors/${seg(cn)}`, b)
      ),
    deleteConnector: async (s, cn) => {
      await client.request('DELETE', `${base(s)}/connectors/${seg(cn)}`);
    },
    patchOperation: async (s, cn, op, b) =>
      parseOperation(
        await client.request(
          'PATCH',
          `${base(s)}/connectors/${seg(cn)}/operations/${opSeg(op)}`,
          b
        )
      ),
    putSecret: async (s, cn, b) =>
      parseConnector(
        await client.request(
          'PUT',
          `${base(s)}/connectors/${seg(cn)}/secret`,
          b
        )
      ),
    actionLog: async (s) =>
      arr(await client.request('GET', `${base(s)}/action-log`)).map((r) => {
        const o = obj(r);
        const q = obj(o.request);
        return {
          id: str(o.id),
          at: str(o.at),
          actor: str(o.actor),
          actorRole: strOrNull(o.actorRole),
          channel: str(o.channel),
          operation: str(o.operation),
          outcome: str(o.outcome),
          httpStatus: numOrNull(o.httpStatus),
          durationMs: numOrNull(o.durationMs),
          request: {
            method: str(q.method),
            path: str(q.path),
            query: Object.fromEntries(
              Object.entries(obj(q.query)).filter(
                ([, v]) => typeof v === 'string'
              )
            ) as Record<string, string>,
          },
        };
      }),
    learning: async (s) =>
      arr(await client.request('GET', `${base(s)}/learning/admin/queue`)).map(
        (r) => {
          const o = obj(r);
          return {
            id: str(o.id),
            kind: str(o.kind),
            status: str(o.status),
            question: str(o.question),
            answer: strOrNull(o.answer),
            proposedAnswer: strOrNull(o.proposedAnswer),
            clusterSize: n0(o.clusterSize) || 1,
            createdAt: str(o.createdAt),
          };
        }
      ),
    acceptLearning: async (s, id, answer) => {
      await client.request(
        'POST',
        `${base(s)}/learning/admin/queue/${seg(id)}/accept`,
        {
          answer,
        }
      );
    },
    rejectLearning: async (s, id) => {
      await client.request(
        'POST',
        `${base(s)}/learning/admin/queue/${seg(id)}/reject`
      );
    },
    stats: async (s, days) => {
      const o = obj(
        await client.request('GET', `${base(s)}/admin-mode/stats?days=${days}`)
      );
      return {
        days: n0(o.days),
        conversations: n0(o.conversations),
        questions: n0(o.questions),
        refusedShare: n0(o.refusedShare),
        thumbsDown: n0(o.thumbsDown),
        learningNew: n0(o.learningNew),
        topQuestions: arr(o.topQuestions).map((t) => ({
          sample: str(obj(t).sample),
          count: n0(obj(t).count),
        })),
        tools: arr(o.tools).map((t) => ({
          operation: str(obj(t).operation),
          ok: n0(obj(t).ok),
          failed: n0(obj(t).failed),
        })),
        byRole: arr(o.byRole).map((t) => ({
          role: str(obj(t).role),
          conversations: n0(obj(t).conversations),
          questions: n0(obj(t).questions),
        })),
        byEmployee: Array.isArray(o.byEmployee)
          ? o.byEmployee.map((t) => ({
              employee: str(obj(t).employee),
              questions: n0(obj(t).questions),
            }))
          : null,
        actions: parseActionStats(o.actions),
      };
    },
    privateCrawl: async (s) =>
      parseCrawl(
        await client.request('GET', `${base(s)}/admin-mode/private-crawl`)
      ),
    putPrivateCrawl: async (s, b) =>
      parseCrawl(
        await client.request('PUT', `${base(s)}/admin-mode/private-crawl`, b)
      ),
    runPrivateCrawl: async (s) => {
      const o = obj(
        await client.request('POST', `${base(s)}/admin-mode/private-crawl/run`)
      );
      return { status: str(o.status) };
    },
    chatState: async (s, lang) => {
      const o = obj(
        await client.request('GET', `${base(s)}/admin-chat/state${langQ(lang)}`)
      );
      return {
        messages: arr(o.messages).map(parseChatMessage),
        tools: obj(o.employee).tools === true,
        proposals: arr(o.proposals).map(parseProposal),
      };
    },
    chatAsk: async (s, text, clientRequestId) => {
      const o = obj(
        await client.request('POST', `${base(s)}/admin-chat`, {
          text,
          clientRequestId,
        })
      );
      const ans = obj(o.answer);
      return {
        messages: [parseChatMessage(o.question), parseChatMessage(ans)],
        proposal: ans.proposal ? parseProposal(ans.proposal) : null,
      };
    },
    chatFeedback: async (s, mid, rating, correction) => {
      await client.request(
        'POST',
        `${base(s)}/admin-chat/messages/${seg(mid)}/feedback`,
        correction ? { rating, correction } : { rating }
      );
    },
    voice: createAdminVoiceApi(client),
  };
}
