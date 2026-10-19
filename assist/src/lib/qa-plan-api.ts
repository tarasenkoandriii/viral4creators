import { ApiError, type ApiClient } from '../kit';
import { payload as casePayload } from './qa-catalog-api';
import type { QaSnapshot } from './qa-runs-api';
export interface QaEnvironment {
  name: string;
  browser: string;
  device: string;
  theme: 'light' | 'dark' | 'system';
  locale: string;
  viewport: string;
}
export interface QaPlanBody {
  title: string;
  suite: string;
  description: string;
  caseIds: string[];
  environments: QaEnvironment[];
  assigneeMemberId: string | null;
  archived: boolean;
}
export interface QaPlanHead {
  id: string;
  planKey: string;
  title: string;
  currentVersion: number;
  archived: boolean;
}
export interface QaPlan extends QaPlanHead {
  payload: QaPlanBody & { snapshot: QaSnapshot[] };
}
function bad(): never {
  throw new ApiError(
    'QA_PLAN_RESPONSE_INVALID',
    'Не удалось прочитать план QA.',
    502
  );
}
function obj(v: unknown) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad();
  return v as Record<string, unknown>;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : bad();
}
function num(v: unknown): number {
  return Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : bad();
}
function bool(v: unknown): boolean {
  return typeof v === 'boolean' ? v : bad();
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : bad();
}
function head(v: unknown): QaPlanHead {
  const o = obj(v);
  return {
    id: str(o.id),
    planKey: str(o.planKey),
    title: str(o.title),
    currentVersion: num(o.currentVersion),
    archived: bool(o.archived),
  };
}
export function decodePlanPayload(v: unknown): QaPlan['payload'] {
  const o = obj(v);
  return {
    title: str(o.title),
    suite: str(o.suite),
    description: str(o.description),
    caseIds: arr(o.caseIds).map(str),
    assigneeMemberId:
      o.assigneeMemberId === null ? null : str(o.assigneeMemberId),
    archived: bool(o.archived),
    environments: arr(o.environments).map((v) => {
      const e = obj(v);
      if (!['light', 'dark', 'system'].includes(str(e.theme))) return bad();
      return {
        name: str(e.name),
        browser: str(e.browser),
        device: str(e.device),
        theme: e.theme as QaEnvironment['theme'],
        locale: str(e.locale),
        viewport: str(e.viewport),
      };
    }),
    snapshot: arr(o.snapshot).map((v) => {
      const c = obj(v);
      return {
        caseId: str(c.caseId),
        caseKey: str(c.caseKey),
        version: num(c.version),
        payload: casePayload(c.payload),
      };
    }),
  };
}
export function createQaPlansApi(client: ApiClient) {
  const base = (site: string) => `/qa/sites/${encodeURIComponent(site)}/plans`,
    item = (site: string, id: string) =>
      `${base(site)}/${encodeURIComponent(id)}`;
  return {
    list: async (site: string, before?: string) => {
      const o = obj(
        await client.request(
          'GET',
          base(site) + (before ? `?before=${encodeURIComponent(before)}` : '')
        )
      );
      return {
        items: arr(o.items).map(head),
        nextBeforeId: o.nextBeforeId === null ? null : str(o.nextBeforeId),
      };
    },
    get: async (site: string, id: string): Promise<QaPlan> => {
      const o = obj(await client.request('GET', item(site, id)));
      return { ...head(o), payload: decodePlanPayload(o.payload) };
    },
    create: async (site: string, planKey: string, payload: QaPlanBody) =>
      head(await client.request('POST', base(site), { planKey, payload })),
    replace: async (
      site: string,
      id: string,
      expectedVersion: number,
      payload: QaPlanBody
    ) => {
      const o = obj(
        await client.request('PUT', item(site, id), {
          expectedVersion,
          payload,
        })
      );
      return { id: str(o.id), currentVersion: num(o.currentVersion) };
    },
    history: async (site: string, id: string, before?: number) => {
      const o = obj(
        await client.request(
          'GET',
          item(site, id) + '/history' + (before ? `?before=${before}` : '')
        )
      );
      return {
        items: arr(o.items).map((v) => {
          const r = obj(v);
          return {
            version: num(r.version),
            payload: decodePlanPayload(r.payload),
            createdAt: str(r.createdAt),
          };
        }),
        nextBeforeVersion:
          o.nextBeforeVersion === null ? null : num(o.nextBeforeVersion),
      };
    },
    start: async (
      site: string,
      id: string,
      expectedVersion: number,
      environmentIndex: number,
      requestId: string
    ) => {
      const o = obj(
        await client.request('POST', item(site, id) + '/runs', {
          expectedVersion,
          environmentIndex,
          requestId,
        })
      );
      return {
        id: str(o.id),
        title: str(o.title),
        revision: num(o.revision),
        createdAt: str(o.createdAt),
      };
    },
  };
}
