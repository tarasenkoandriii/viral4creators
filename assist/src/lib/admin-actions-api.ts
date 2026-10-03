/**
 * Э8 «Админка: действия» — клиент TMA (ТЗ §5.4–5.7, §5-бис.15 п.14,
 * §5-бис.17 п.10): карточки подтверждения (7a: «Да»/«Нет»/«Проверить»/
 * компенсация), журнал действий с откатом (владелец), мемо АМ-N, секрет
 * подписи изменяющих запросов. Разбор строгий: неизвестное → умолчание;
 * параметров запроса, кроме строк карточки «было → станет», клиент не
 * получает (сервер их не отдаёт).
 */
import type { ApiClient } from '../kit';
import { seg } from './handoff-api';

export type ProposalStatus =
  | 'pending'
  | 'executing'
  | 'done'
  | 'failed'
  | 'unknown'
  | 'rejected'
  | 'expired';

const STATUSES: readonly ProposalStatus[] = [
  'pending',
  'executing',
  'done',
  'failed',
  'unknown',
  'rejected',
  'expired',
];

export interface ProposalField {
  name: string;
  before?: string | string[] | null;
  after: string | string[];
}

export interface Proposal {
  id: string;
  status: ProposalStatus;
  kind: 'write' | 'danger';
  title: string;
  operation: string;
  fields: ProposalField[];
  paramsHash: string;
  unrequested: boolean;
  confirmPhrase: string | null;
  idempotent: boolean;
  undoDeclared: boolean;
  undoAvailable: boolean;
  checkAvailable: boolean;
  dryRun: string;
  dryRunStatus: string | null;
  dryRunNote: string | null;
  amount: number | null;
  errorText: string | null;
  chainStatus: string | null;
  compensationOf: string | null;
  memoStep: number | null;
  createdAt: string;
  /** Журнал владельца: кто предложил. */
  actor: string | null;
}

export interface MemoListItem {
  number: number;
  key: string;
  name: string;
  status: string;
  publishedVersion: number | null;
  draftRevision: number;
}

export interface MemoVersion {
  number: number;
  status: string;
  problems: Array<{ path: string; code: string }>;
  warnings: Array<{ path: string; code: string }>;
  kinds: string[];
}

export interface MemoView extends MemoListItem {
  draft: Record<string, unknown>;
  versions: MemoVersion[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' ? v : null;
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function value(v: unknown): string | string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : str(v);
}

export function parseProposal(v: unknown): Proposal {
  const o = obj(v);
  const memo = obj(o.memo);
  return {
    id: str(o.id),
    status: (STATUSES as readonly unknown[]).includes(o.status)
      ? (o.status as ProposalStatus)
      : 'expired',
    kind: o.kind === 'danger' ? 'danger' : 'write',
    title: str(o.title),
    operation: str(o.operation),
    fields: arr(o.fields).map((f) => {
      const x = obj(f);
      const out: ProposalField = { name: str(x.name), after: value(x.after) };
      if ('before' in x)
        out.before = x.before === null ? null : value(x.before);
      return out;
    }),
    paramsHash: /^[0-9a-f]{64}$/.test(str(o.paramsHash))
      ? str(o.paramsHash)
      : '',
    unrequested: o.unrequested === true,
    confirmPhrase: strOrNull(o.confirmPhrase),
    idempotent: o.idempotent === true,
    undoDeclared: o.undoDeclared === true,
    undoAvailable: o.undoAvailable === true,
    checkAvailable: o.checkAvailable === true,
    dryRun: str(o.dryRun) || 'none',
    dryRunStatus: strOrNull(o.dryRunStatus),
    dryRunNote: strOrNull(o.dryRunNote),
    amount: numOrNull(o.amount),
    errorText: strOrNull(o.errorText),
    chainStatus: strOrNull(o.chainStatus),
    compensationOf: strOrNull(o.compensationOf),
    memoStep: numOrNull(memo.step),
    createdAt: str(o.createdAt),
    actor: strOrNull(o.actor),
  };
}

function parseMemoItem(v: unknown): MemoListItem {
  const o = obj(v);
  return {
    number: numOrNull(o.number) ?? 0,
    key: str(o.key),
    name: str(o.name),
    status: str(o.status),
    publishedVersion: numOrNull(o.publishedVersion),
    draftRevision: numOrNull(o.draftRevision) ?? 0,
  };
}

const issues = (v: unknown) =>
  arr(v).map((i) => ({ path: str(obj(i).path), code: str(obj(i).code) }));

export function parseMemo(v: unknown): MemoView {
  const o = obj(v);
  return {
    ...parseMemoItem(o),
    draft: obj(o.draft),
    versions: arr(o.versions).map((x) => {
      const r = obj(x);
      const g = obj(r.gateReport);
      return {
        number: numOrNull(r.number) ?? 0,
        status: str(r.status),
        problems: issues(g.problems),
        warnings: issues(g.warnings),
        kinds: arr(g.kinds).map(str),
      };
    }),
  };
}

export interface ConfirmBody {
  paramsHash: string;
  phrase?: string;
  acknowledgeRisk?: boolean;
}

export interface AdminActionsApi {
  // 7a: карточки сотрудника/владельца в TMA
  confirm(
    siteId: string,
    pid: string,
    body: ConfirmBody,
    lang: string
  ): Promise<{ proposal: Proposal; text: string; next: Proposal | null }>;
  reject(siteId: string, pid: string, lang: string): Promise<Proposal>;
  check(
    siteId: string,
    pid: string
  ): Promise<{
    available: boolean;
    fields: Array<{ name: string; now: string | string[] | null }>;
  }>;
  compensate(siteId: string, pid: string): Promise<Proposal | null>;
  // журнал владельца
  list(siteId: string, review: boolean): Promise<Proposal[]>;
  rollback(
    siteId: string,
    pid: string
  ): Promise<{ proposal: Proposal | null; text: string }>;
  verify(siteId: string): Promise<{ ok: boolean; brokenAt: number | null }>;
  signingSecret(siteId: string, cn: string): Promise<{ secret: string }>;
  // мемо АМ-N
  memos(siteId: string): Promise<{
    limit: number;
    used: number;
    memos: MemoListItem[];
  }>;
  createMemo(siteId: string, draft: Obj): Promise<MemoView>;
  memo(siteId: string, n: number): Promise<MemoView>;
  saveDraft(
    siteId: string,
    n: number,
    expectedRevision: number,
    draft: Obj
  ): Promise<MemoView>;
  buildVersion(
    siteId: string,
    n: number
  ): Promise<{ version: number; status: string }>;
  publish(siteId: string, n: number, v: number): Promise<MemoView>;
  setEnabled(siteId: string, n: number, on: boolean): Promise<MemoView>;
  removeMemo(siteId: string, n: number): Promise<void>;
}

const LANG = /^(uk|ru|en)$/;

export function createAdminActionsApi(client: ApiClient): AdminActionsApi {
  const base = (s: string) => `/assist/sites/${seg(s)}`;
  const n0 = (n: number) => {
    if (!Number.isInteger(n) || n < 1) throw new Error('bad memo number');
    return n;
  };
  const lq = (lang: string) => (LANG.test(lang) ? `?lang=${lang}` : '');
  return {
    confirm: async (s, pid, body, lang) => {
      const o = obj(
        await client.request(
          'POST',
          `${base(s)}/admin-chat/proposals/${seg(pid)}/confirm${lq(lang)}`,
          body
        )
      );
      return {
        proposal: parseProposal(o.proposal),
        text: str(o.text),
        next: o.next ? parseProposal(o.next) : null,
      };
    },
    reject: async (s, pid, lang) =>
      parseProposal(
        obj(
          await client.request(
            'POST',
            `${base(s)}/admin-chat/proposals/${seg(pid)}/reject${lq(lang)}`
          )
        ).proposal
      ),
    check: async (s, pid) => {
      const o = obj(
        await client.request(
          'POST',
          `${base(s)}/admin-chat/proposals/${seg(pid)}/check`
        )
      );
      return {
        available: o.available === true,
        fields: arr(o.fields).map((f) => ({
          name: str(obj(f).name),
          now: obj(f).now === null ? null : value(obj(f).now),
        })),
      };
    },
    compensate: async (s, pid) => {
      const o = obj(
        await client.request(
          'POST',
          `${base(s)}/admin-chat/proposals/${seg(pid)}/compensate`
        )
      );
      return o.proposal ? parseProposal(o.proposal) : null;
    },
    list: async (s, review) =>
      arr(
        await client.request(
          'GET',
          `${base(s)}/action-log/proposals${review ? '?chain=review' : ''}`
        )
      ).map(parseProposal),
    rollback: async (s, pid) => {
      const o = obj(
        await client.request(
          'POST',
          `${base(s)}/action-log/${seg(pid)}/rollback`
        )
      );
      return {
        proposal: o.proposal ? parseProposal(o.proposal) : null,
        text: str(o.text),
      };
    },
    verify: async (s) => {
      const o = obj(
        await client.request('GET', `${base(s)}/action-log/verify`)
      );
      return { ok: o.ok === true, brokenAt: numOrNull(o.brokenAt) };
    },
    signingSecret: async (s, cn) => ({
      secret: str(
        obj(
          await client.request(
            'POST',
            `${base(s)}/connectors/${seg(cn)}/signing-secret`
          )
        ).secret
      ),
    }),
    memos: async (s) => {
      const o = obj(await client.request('GET', `${base(s)}/admin-mode/memos`));
      return {
        limit: numOrNull(o.limit) ?? 0,
        used: numOrNull(o.used) ?? 0,
        memos: arr(o.memos).map(parseMemoItem),
      };
    },
    createMemo: async (s, draft) =>
      parseMemo(
        await client.request('POST', `${base(s)}/admin-mode/memos`, { draft })
      ),
    memo: async (s, n) =>
      parseMemo(
        await client.request('GET', `${base(s)}/admin-mode/memos/${n0(n)}`)
      ),
    saveDraft: async (s, n, expectedRevision, draft) =>
      parseMemo(
        await client.request(
          'PATCH',
          `${base(s)}/admin-mode/memos/${n0(n)}/draft`,
          { expectedRevision, draft }
        )
      ),
    buildVersion: async (s, n) => {
      const o = obj(
        await client.request(
          'POST',
          `${base(s)}/admin-mode/memos/${n0(n)}/versions`
        )
      );
      return { version: numOrNull(o.version) ?? 0, status: str(o.status) };
    },
    publish: async (s, n, v) =>
      parseMemo(
        await client.request(
          'POST',
          `${base(s)}/admin-mode/memos/${n0(n)}/versions/${n0(v)}/publish`
        )
      ),
    setEnabled: async (s, n, on) =>
      parseMemo(
        await client.request(
          'POST',
          `${base(s)}/admin-mode/memos/${n0(n)}/${on ? 'enable' : 'disable'}`
        )
      ),
    removeMemo: async (s, n) => {
      await client.request('DELETE', `${base(s)}/admin-mode/memos/${n0(n)}`);
    },
  };
}
