import { ApiError, type ApiClient } from '../kit';
export interface QaCasePayload {
  title: string;
  purpose: string;
  preconditions: string;
  steps: Array<{ action: string; expected: string }>;
  type: 'manual' | 'automated';
  priority: 'low' | 'normal' | 'high' | 'critical';
  tags: string[];
  requirementIds: string[];
  archived: boolean;
}
export interface QaCaseHead {
  id: string;
  caseKey: string;
  title: string;
  currentVersion: number;
  archived: boolean;
}
export interface QaCaseRevision {
  id: string;
  caseId: string;
  version: number;
  payload: QaCasePayload;
  createdAt: string;
  createdByMemberId: string;
}
const bad = () =>
  new ApiError(
    'QA_RESPONSE_INVALID',
    'Не удалось прочитать данные теста. Обновите страницу.',
    502
  );
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw bad();
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw bad();
  return value as number;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw bad();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw bad();
  return value;
}
function payload(value: unknown): QaCasePayload {
  const o = object(value);
  if (
    typeof o.type !== 'string' ||
    !['manual', 'automated'].includes(o.type) ||
    typeof o.priority !== 'string' ||
    !['low', 'normal', 'high', 'critical'].includes(o.priority)
  )
    throw bad();
  const steps = list(o.steps).map((value) => {
    const s = object(value);
    return { action: text(s.action), expected: text(s.expected) };
  });
  if (!steps.length) throw bad();
  return {
    title: text(o.title),
    purpose: text(o.purpose),
    preconditions: text(o.preconditions),
    steps,
    type: o.type as QaCasePayload['type'],
    priority: o.priority as QaCasePayload['priority'],
    tags: list(o.tags).map(text),
    requirementIds: list(o.requirementIds).map(text),
    archived: boolean(o.archived),
  };
}
function head(value: unknown): QaCaseHead {
  const o = object(value);
  const result = {
    id: text(o.id),
    caseKey: text(o.caseKey),
    title: text(o.title),
    currentVersion: integer(o.currentVersion),
    archived: boolean(o.archived),
  };
  if (!result.id || !/^[A-Z][A-Z0-9-]{1,63}$/.test(result.caseKey)) throw bad();
  return result;
}
function revision(value: unknown): QaCaseRevision {
  const o = object(value);
  return {
    id: text(o.id),
    caseId: text(o.caseId),
    version: integer(o.version),
    payload: payload(o.payload),
    createdAt: text(o.createdAt),
    createdByMemberId: text(o.createdByMemberId),
  };
}
export function isQaCaseConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'QA_CASE_CONFLICT';
}
export function createQaCatalogApi(client: ApiClient) {
  const base = (site: string) => `/qa/sites/${encodeURIComponent(site)}/cases`;
  const item = (site: string, id: string) =>
    `${base(site)}/${encodeURIComponent(id)}`;
  return {
    async list(site: string, after?: string) {
      const o = object(
        await client.request(
          'GET',
          base(site) + (after ? `?after=${encodeURIComponent(after)}` : '')
        )
      );
      return {
        items: list(o.items).map(head),
        nextAfterKey: o.nextAfterKey === null ? null : text(o.nextAfterKey),
      };
    },
    async get(site: string, id: string) {
      const o = object(await client.request('GET', item(site, id))),
        h = head(o),
        r = revision(o.revision);
      if (r.caseId !== h.id || r.version !== h.currentVersion) throw bad();
      return { ...h, revision: r };
    },
    async history(site: string, id: string, before?: number) {
      const o = object(
        await client.request(
          'GET',
          item(site, id) +
            `/history${before === undefined ? '' : `?before=${integer(before)}`}`
        )
      );
      return {
        items: list(o.items).map(revision),
        nextBeforeVersion:
          o.nextBeforeVersion === null ? null : integer(o.nextBeforeVersion),
      };
    },
    async create(site: string, caseKey: string, value: QaCasePayload) {
      return head(
        await client.request('POST', base(site), { caseKey, payload: value })
      );
    },
    async replace(
      site: string,
      id: string,
      expectedVersion: number,
      value: QaCasePayload
    ) {
      const o = object(
        await client.request('PUT', item(site, id), {
          expectedVersion: integer(expectedVersion),
          payload: value,
        })
      );
      return {
        id: text(o.id),
        caseKey: text(o.caseKey),
        currentVersion: integer(o.currentVersion),
      };
    },
  };
}
