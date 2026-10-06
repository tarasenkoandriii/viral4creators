/**
 * «Голос → Мемо → Из обучалки» (Э6-тер (к), ТЗ §5-бис.17 п.6): клиент
 * `/assist/sites/:id/memo-tutorials*` (сервер —
 * `assist-site-voice-control/cabinet/memo-from-tutorial.*`). Разбор строгий:
 * мусор — умолчания; черновик мемо — тем же `parseMemoDetail`, что раздел.
 */
import { ApiError, type ApiClient } from '../kit';
import { parseMemoDetail, type MemoDetail, type MemoStatus } from './memo-api';
import { arr, obj, text } from './widget-api';

export interface MemoTutorialItem {
  draftId: string;
  title: string;
  requiresLogin: boolean;
  /** Мемо, уже сделанное из этой обучалки. */
  memo: { number: number; status: MemoStatus } | null;
}

export interface MemoTutorialList {
  items: MemoTutorialItem[];
  configured: boolean;
}

export interface MemoFromTutorialResult {
  memo: MemoDetail;
  unresolved: number[];
  slotsOverflow: number;
  droppedLogin: number;
  requiresLogin: boolean;
}

/** Машинные коды раздела (сервер — `MemoTutorialErrorCode`). */
export const MEMO_TUTORIAL_ERROR_CODES = [
  'MEMO_TUTORIAL_NOT_FOUND',
  'MEMO_TUTORIAL_EXISTS',
  'MEMO_TUTORIAL_NOT_ELIGIBLE',
  'MEMO_TUTORIAL_UNAVAILABLE',
] as const;
export type MemoTutorialErrorCode = (typeof MEMO_TUTORIAL_ERROR_CODES)[number];

export function memoTutorialErrorCode(
  e: unknown
): MemoTutorialErrorCode | null {
  return e instanceof ApiError &&
    (MEMO_TUTORIAL_ERROR_CODES as readonly string[]).includes(e.code)
    ? (e.code as MemoTutorialErrorCode)
    : null;
}

export interface MemoTutorialApi {
  list(siteId: string): Promise<MemoTutorialList>;
  create(siteId: string, draftId: string): Promise<MemoFromTutorialResult>;
}

const SEG = /^[A-Za-z0-9_-]{1,64}$/;
function seg(id: string): string {
  if (!SEG.test(id)) throw new Error('bad id');
  return id;
}
const int = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
const STATUSES: readonly MemoStatus[] = [
  'draft',
  'checking',
  'published',
  'held',
  'needs_review',
  'disabled',
  'removed',
];

export function parseMemoTutorialList(v: unknown): MemoTutorialList {
  const o = obj(v);
  return {
    configured: o.configured === true,
    items: arr(o.items)
      .map(obj)
      .filter((x) => typeof x.draftId === 'string' && SEG.test(x.draftId))
      .map((x) => {
        const m = obj(x.memo);
        const memo =
          int(m.number) > 0 &&
          (STATUSES as readonly unknown[]).includes(m.status)
            ? { number: int(m.number), status: m.status as MemoStatus }
            : null;
        return {
          draftId: x.draftId as string,
          title: text(x.title).slice(0, 200),
          requiresLogin: x.requiresLogin !== false,
          memo,
        };
      })
      .slice(0, 200),
  };
}

export function parseMemoFromTutorial(v: unknown): MemoFromTutorialResult {
  const o = obj(v);
  const memo = parseMemoDetail(o.memo);
  if (!memo) throw new Error('bad memo');
  const r = obj(o.report);
  return {
    memo,
    unresolved: arr(r.unresolved)
      .map(int)
      .filter((n) => n > 0)
      .slice(0, 30),
    slotsOverflow: int(r.slotsOverflow),
    droppedLogin: int(obj(r.dropped).login),
    requiresLogin: r.requiresLogin === true,
  };
}

export function createMemoTutorialApi(client: ApiClient): MemoTutorialApi {
  const base = (id: string) => `/assist/sites/${seg(id)}/memo-tutorials`;
  return {
    list: async (id) =>
      parseMemoTutorialList(await client.request('GET', base(id))),
    create: async (id, draftId) =>
      parseMemoFromTutorial(
        await client.request('POST', `${base(id)}/${seg(draftId)}`)
      ),
  };
}
