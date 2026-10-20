import { createQaPlansApi } from './qa-plan-api';
import { ApiError, type ApiClient } from '../kit';
import { payload, type QaCasePayload } from './qa-catalog-api';
export type QaResult = 'passed' | 'failed' | 'blocked' | 'skipped';
export interface QaAttempt {
  origin: 'manual' | 'automated';
  project: string | null;
  sourceMetadata: {
    testSourceSha: string | null;
    deployedSha: string | null;
    runnerStatus: string;
  } | null;
  id: string;
  caseKey: string;
  attemptNumber: number;
  status: QaResult;
  comment: string;
  createdAt: string;
  createdByMemberId: string;
}
export interface QaRunHead {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
}
export interface QaSnapshot {
  caseId: string;
  caseKey: string;
  version: number;
  payload: QaCasePayload;
}
export interface QaRun extends QaRunHead {
  context?: {
    planKey: string;
    planVersion: number;
    suite: string;
    assigneeMemberId: string | null;
    environment: {
      name: string;
      browser: string;
      device: string;
      theme: string;
      locale: string;
      viewport: string;
    };
  };
  automationProject: string | null;
  snapshot: QaSnapshot[];
  latestAttempts: QaAttempt[];
  flakyCaseKeys: string[];
}
function bad(): never {
  throw new ApiError(
    'QA_RESPONSE_INVALID',
    'Не удалось прочитать запуск QA.',
    502
  );
}
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad();
  return v as Record<string, unknown>;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : bad();
}
function num(v: unknown): number {
  return Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : bad();
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : bad();
}
function head(v: unknown): QaRunHead {
  const o = obj(v);
  return {
    id: str(o.id),
    title: str(o.title),
    revision: num(o.revision),
    createdAt: str(o.createdAt),
  };
}
function attempt(v: unknown): QaAttempt {
  const o = obj(v);
  if (!['passed', 'failed', 'blocked', 'skipped'].includes(str(o.status)))
    return bad();
  const origin = o.origin ?? 'manual';
  if (!['manual', 'automated'].includes(str(origin))) return bad();
  const project =
    o.project === null || o.project === undefined ? null : str(o.project);
  if ((origin === 'automated') !== (project !== null)) return bad();
  const sha = (v: unknown) =>
    v === null
      ? null
      : typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v)
        ? v
        : bad();
  const meta = origin === 'automated' ? obj(o.sourceMetadata) : null;
  const sourceMetadata = meta
    ? {
        testSourceSha: sha(meta.testSourceSha),
        deployedSha: sha(meta.deployedSha),
        runnerStatus: str(meta.runnerStatus),
      }
    : null;
  return {
    sourceMetadata,
    origin: origin as QaAttempt['origin'],
    project,
    id: str(o.id),
    caseKey: str(o.caseKey),
    attemptNumber: num(o.attemptNumber),
    status: o.status as QaResult,
    comment: str(o.comment),
    createdAt: str(o.createdAt),
    createdByMemberId: str(o.createdByMemberId),
  };
}
export function decodeQaRun(v: unknown): QaRun {
  const o = obj(v),
    snapshot = arr(o.snapshot).map((v) => {
      const s = obj(v);
      return {
        caseId: str(s.caseId),
        caseKey: str(s.caseKey),
        version: num(s.version),
        payload: payload(s.payload),
      };
    });
  if (
    !snapshot.length ||
    new Set(snapshot.map((s) => s.caseKey)).size !== snapshot.length
  )
    return bad();
  const latestAttempts = arr(o.latestAttempts).map(attempt);
  if (
    new Set(latestAttempts.map((a) => a.caseKey)).size !==
      latestAttempts.length ||
    latestAttempts.some(
      (a) =>
        !snapshot.some(
          (s) => s.caseKey === a.caseKey && s.payload.type === a.origin
        )
    )
  )
    return bad();
  const flakyCaseKeys = arr(o.flakyCaseKeys).map(str);
  if (
    flakyCaseKeys.some(
      (key) =>
        !latestAttempts.some((a) => a.caseKey === key && a.status === 'passed')
    )
  )
    return bad();
  const automationProject =
    o.automationProject === null || o.automationProject === undefined
      ? null
      : str(o.automationProject);
  if (
    latestAttempts.some(
      (a) => a.origin === 'automated' && a.project !== automationProject
    )
  )
    return bad();
  const context = o.context == null ? null : obj(o.context);
  const environment = context ? obj(context.environment) : null;
  return {
    ...head(o),
    ...(context && environment
      ? {
          context: {
            planKey: str(context.planKey),
            planVersion: num(context.planVersion),
            suite: str(context.suite),
            assigneeMemberId:
              context.assigneeMemberId === null
                ? null
                : str(context.assigneeMemberId),
            environment: {
              name: str(environment.name),
              browser: str(environment.browser),
              device: str(environment.device),
              theme: str(environment.theme),
              locale: str(environment.locale),
              viewport: str(environment.viewport),
            },
          },
        }
      : {}),
    snapshot,
    latestAttempts,
    flakyCaseKeys,
    automationProject,
  };
}
export function qaAcceptanceStatus(a?: QaAttempt): QaResult | 'notRun' {
  return a?.status === 'passed' &&
    a.origin === 'automated' &&
    a.sourceMetadata?.runnerStatus !== 'passed'
    ? 'blocked'
    : (a?.status ?? 'notRun');
}
export function qaRunSummary(run: QaRun) {
  const counts = { passed: 0, failed: 0, blocked: 0, skipped: 0, notRun: 0 };
  for (const s of run.snapshot) {
    const a = run.latestAttempts.find((a) => a.caseKey === s.caseKey);
    const status = qaAcceptanceStatus(a);
    counts[status]++;
  }
  return counts;
}
export function createQaRunsApi(client: ApiClient) {
  const base = (site: string) => `/qa/sites/${encodeURIComponent(site)}/runs`;
  const item = (site: string, id: string) =>
    `${base(site)}/${encodeURIComponent(id)}`;
  const page = <T>(v: unknown, decode: (v: unknown) => T) => {
    const o = obj(v);
    return {
      items: arr(o.items).map(decode),
      nextBeforeId: o.nextBeforeId === null ? null : str(o.nextBeforeId),
    };
  };
  return {
    plans: createQaPlansApi(client),
    list: async (site: string, before?: string) =>
      page(
        await client.request(
          'GET',
          base(site) + (before ? `?before=${encodeURIComponent(before)}` : '')
        ),
        head
      ),
    create: async (site: string, title: string, caseIds: string[]) =>
      head(await client.request('POST', base(site), { title, caseIds })),
    get: async (site: string, id: string) =>
      decodeQaRun(await client.request('GET', item(site, id))),
    history: async (site: string, id: string, before?: string) =>
      page(
        await client.request(
          'GET',
          item(site, id) +
            '/attempts' +
            (before ? `?before=${encodeURIComponent(before)}` : '')
        ),
        attempt
      ),
    importReport: async (
      site: string,
      id: string,
      expectedRevision: number,
      project: string,
      report: unknown
    ) => {
      const o = obj(
        await client.request('POST', item(site, id) + '/reports', {
          expectedRevision,
          project,
          report,
        })
      );
      if (
        !Number.isSafeInteger(o.imported) ||
        (o.imported as number) < 0 ||
        typeof o.replayed !== 'boolean'
      )
        return bad();
      return {
        revision: num(o.revision),
        imported: o.imported as number,
        replayed: o.replayed,
        project: str(o.project),
      };
    },
    record: async (
      site: string,
      id: string,
      expectedRevision: number,
      caseKey: string,
      status: QaResult,
      comment: string
    ) => {
      const o = obj(
        await client.request('POST', item(site, id) + '/attempts', {
          expectedRevision,
          caseKey,
          status,
          comment,
        })
      );
      return { attempt: attempt(o.attempt), revision: num(o.revision) };
    },
  };
}
