/**
 * Мемо «Сайта» в TMA (Э6-бис (е), ТЗ §5-бис.17 п.12, п.14; решения
 * владельца Р-68…Р-72) — повтор типов
 * `sites-backend/src/modules/assist-site-voice-control/api-types.ts`
 * (`Memo*`) и `assist-ui-core/memo.ts` (сверку держит
 * scripts/voice-control-api.test.ts) и клиент `/assist/sites/:id/memos*`.
 * Разбор строгий: мусор — умолчания. Номер `М-N` виден только в кабинете
 * (посетителю — никогда, В-70).
 */
import { ApiError, type AccountMember, type ApiClient } from '../kit';
import { arr, obj, text } from './widget-api';
import { canManageWidget } from './widget-view';

/**
 * Мемо правят только владелец и менеджер Помічника (сервер — 403 остальным,
 * как голосовая карта, В-49): оператору раздел «Голос → Мемо» показывает
 * плашку «редактирует владелец/менеджер» вместо ошибки — без списка и без
 * кнопок правки (запрос не уходит); 403 сервера (роль сменили) — так же.
 */
export function memoReadOnly(me: AccountMember, error: unknown): boolean {
  return (
    !canManageWidget(me) || (error instanceof ApiError && error.status === 403)
  );
}

export const MEMO_STATUSES = [
  'draft',
  'checking',
  'published',
  'held',
  'needs_review',
  'disabled',
  'removed',
] as const;
export type MemoStatus = (typeof MEMO_STATUSES)[number];

export const MEMO_VERSION_STATUSES = [
  'building',
  'checking',
  'published',
  'held',
  'discarded',
] as const;
export type MemoVersionStatus = (typeof MEMO_VERSION_STATUSES)[number];

/** Коды ворот кода (assist-ui-core/memo.ts MemoGateCode). */
export const MEMO_GATE_CODES = [
  'no_name',
  'no_steps',
  'too_many_steps',
  'too_many_slots',
  'no_target',
  'never_step',
  'two_pnr',
  'effect_after_pnr',
  'value_not_slot',
  'unknown_slot',
  'const_forbidden',
  'const_in_pii',
  'no_goal',
  'goal_slot',
  'risk_lowering_forbidden',
  'text',
  'phrase_conflict',
  'undeclared_compensation',
] as const;
export type MemoGateCode = (typeof MEMO_GATE_CODES)[number];

export type MemoLang = 'uk' | 'ru' | 'en';
export const MEMO_LANGS: readonly MemoLang[] = ['uk', 'ru', 'en'];

export interface MemoStepView {
  page: string;
  action: string;
  target: {
    text: string;
    role: string | null;
    assistId: string | null;
    /** Ключ цели голосовой карты (причина `voice_map` — найти шаг). */
    mapKey: string | null;
  } | null;
  value: { slot: string } | { const: string } | null;
}

export interface MemoDraftView {
  names: Partial<Record<MemoLang, string>>;
  triggers: Partial<Record<MemoLang, string[]>>;
  suggested: Partial<Record<MemoLang, string[]>>;
  goal: {
    text: Partial<Record<MemoLang, string>>;
    expect: Array<{
      kind: string;
      path?: string;
      text?: string;
      slot?: string;
      /** (Э6-тер (к)) «Счётчик ±N» / «поле = слот»: цель условия. */
      target?: { assistId: string | null; text: string };
      delta?: number;
    }>;
  };
  slots: Array<{ name: string; kind: string; pii: boolean; options: string[] }>;
  steps: MemoStepView[];
  view: 'any' | 'desktop' | 'mobile';
  /** Сырой черновик — для операции `set` (сервер разбирает строго). */
  raw: Record<string, unknown>;
}

export interface MemoSummary {
  number: number;
  key: string;
  status: MemoStatus;
  name: string | null;
  view: 'any' | 'desktop' | 'mobile';
  listed: boolean;
  origin: string;
  publishedVersion: number | null;
  staleViews: string[];
  runs30: number;
  reached30: number;
  lastRunAt: string | null;
  reviewCode: string | null;
  /** Шаг причины `needs_review` (с 0) — монитор сбоев/подмены. */
  reviewStep: number | null;
  /** Цель карты причины `voice_map`. */
  reviewKey: string | null;
  /**
   * Опубликовано, но сверх лимита тарифа (после понижения): посетителям не
   * исполняется — бейдж «сверх тарифа».
   */
  overPlan: boolean;
}

export interface MemoVersionView {
  number: number;
  status: MemoVersionStatus;
  gateOk: boolean | null;
  gateProblems: Array<{ code: MemoGateCode; path: string }>;
  undo: string[];
  risk: string[];
  check: 'pass' | 'partial' | 'fail' | null;
  rollbackOf: number | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface MemoDetail extends MemoSummary {
  draft: MemoDraftView;
  draftRevision: number;
  gates: {
    ok: boolean;
    problems: Array<{ code: MemoGateCode; path: string }>;
    undo: string[];
    risk: string[];
  };
  versions: MemoVersionView[];
}

export interface MemoList {
  items: MemoSummary[];
  used: number;
  limit: number;
  candidates: number;
}

export interface MemoSuggestion {
  planId: string;
  page: string;
  steps: Array<{ kind: string; text: string }>;
  visitors: number;
  phrases: string[];
}

export interface MemoStats {
  windowDays: number;
  runs: number;
  reached: number;
  notReached: number;
  unknown: number;
  direct: number;
  lite: number;
  pinMismatch: number;
  self: number;
  cancelled: number;
  failuresByStep: Record<string, number>;
}

export type MemoOp =
  | {
      op: 'set';
      field:
        | 'names'
        | 'triggers'
        | 'goal'
        | 'slots'
        | 'steps'
        | 'view'
        | 'suggested';
      value: unknown;
    }
  | { op: 'acceptSuggested'; lang: MemoLang; phrase: string }
  | { op: 'removeStep'; index: number }
  | { op: 'moveStep'; from: number; to: number }
  | { op: 'listed'; value: boolean }
  | { op: 'key'; value: string };

/**
 * Элемент карты интерфейса Ш4 страницы шага (`GET …/memos/:n/elements`):
 * подпись (маска ПД), действие, которое получит шаг, пометки. Отпечаток
 * строит сервер — TMA шлёт только `uiElementId`.
 */
export interface MemoElement {
  uiElementId: string;
  path: string;
  viewport: 'any' | 'desktop' | 'mobile';
  label: string;
  tag: string;
  role: string | null;
  action: string;
  stability: 'strong' | 'medium' | 'fragile' | null;
  stale: boolean;
}

export interface MemoElements {
  page: string;
  view: 'any' | 'desktop' | 'mobile';
  items: MemoElement[];
}

/** Причины отсева фраз модели (сервер `PhraseDropCode`). */
export const MEMO_PHRASE_DROPS = [
  'text',
  'service_word',
  'own',
  'duplicate',
  'phrase_conflict',
  'name_taken',
  'overflow',
] as const;
export type MemoPhraseDrop = (typeof MEMO_PHRASE_DROPS)[number];

export interface MemoPhraseSuggestResult {
  memo: MemoDetail | null;
  langs: MemoLang[];
  kept: Partial<Record<MemoLang, number>>;
  dropped: Partial<Record<MemoPhraseDrop, number>>;
}

/**
 * «Открыть в редакторе» из карточки мемо: `focus=memo-<номер>-<шаг с 1>`
 * (формат панели редактора). Шаг — причины `needs_review` (монитор — шаг с
 * 0, +1; карта — шаг с этой целью), иначе первый. Страница — страница шага,
 * если это путь, а не маска (маску браузер не откроет).
 */
export function memoEditorFocus(
  d: Pick<
    MemoDetail,
    'number' | 'status' | 'reviewStep' | 'reviewKey' | 'draft'
  >
): { focus: string; path?: string } {
  let step = 0;
  if (d.status === 'needs_review') {
    if (
      d.reviewStep !== null &&
      d.reviewStep >= 0 &&
      d.reviewStep < Math.max(1, d.draft.steps.length)
    )
      step = d.reviewStep;
    else if (d.reviewKey) {
      const i = d.draft.steps.findIndex(
        (s) => s.target?.mapKey === d.reviewKey
      );
      if (i >= 0) step = i;
    }
  }
  const page = d.draft.steps[step]?.page ?? '';
  const path =
    /^\/[A-Za-z0-9\-._~%!$&'()+,;=:@/]*$/.test(page) && page.length <= 300
      ? page
      : undefined;
  return {
    focus: `memo-${d.number}-${Math.min(step + 1, 99)}`,
    ...(path ? { path } : {}),
  };
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const iso = (v: unknown): string | null =>
  typeof v === 'string' && !isNaN(Date.parse(v)) ? v : null;
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null =>
  (list as readonly unknown[]).includes(v) ? (v as T) : null;
const strs = (v: unknown, max = 120): string[] =>
  arr(v)
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.slice(0, max));
const langMap = (v: unknown): Partial<Record<MemoLang, string>> => {
  const o = obj(v);
  const out: Partial<Record<MemoLang, string>> = {};
  for (const l of MEMO_LANGS)
    if (typeof o[l] === 'string') out[l] = (o[l] as string).slice(0, 160);
  return out;
};
const langLists = (v: unknown): Partial<Record<MemoLang, string[]>> => {
  const o = obj(v);
  const out: Partial<Record<MemoLang, string[]>> = {};
  for (const l of MEMO_LANGS)
    if (Array.isArray(o[l])) out[l] = strs(o[l], 60).slice(0, 10);
  return out;
};
const viewOf = (v: unknown): 'any' | 'desktop' | 'mobile' =>
  v === 'desktop' || v === 'mobile' ? v : 'any';
const problems = (v: unknown) =>
  arr(v)
    .map(obj)
    .map((p) => ({ code: oneOf(MEMO_GATE_CODES, p.code), path: text(p.path) }))
    .filter((p): p is { code: MemoGateCode; path: string } => !!p.code);

/**
 * Условия цели при сохранении карточки: адрес и текст — из полей формы;
 * остальные (слот, Э6-тер (к) «счётчик ±N», «поле = слот») здесь не
 * правятся и сохраняются как были (иначе «Сохранить» стёрло бы их).
 */
export function goalExpectForSave(
  prev: MemoDraftView['goal']['expect'],
  url: string,
  appear: string
): MemoDraftView['goal']['expect'] {
  return [
    ...(url.trim() ? [{ kind: 'url', path: url.trim() }] : []),
    ...(appear.trim() ? [{ kind: 'text', text: appear.trim() }] : []),
    ...prev.filter((g) => g.kind !== 'url' && g.kind !== 'text'),
  ];
}

export function parseMemoSummary(v: unknown): MemoSummary | null {
  const o = obj(v);
  const status = oneOf(MEMO_STATUSES, o.status);
  if (typeof o.number !== 'number' || !status) return null;
  const rr = obj(o.reviewReason);
  return {
    number: o.number,
    key: text(o.key),
    status,
    name: typeof o.name === 'string' ? o.name.slice(0, 60) : null,
    view: viewOf(o.view),
    listed: o.listed !== false,
    origin: text(o.origin),
    publishedVersion:
      typeof o.publishedVersion === 'number' ? o.publishedVersion : null,
    staleViews: strs(o.staleViews, 10),
    runs30: num(o.runs30),
    reached30: num(o.reached30),
    lastRunAt: iso(o.lastRunAt),
    reviewCode: typeof rr.code === 'string' ? rr.code.slice(0, 30) : null,
    reviewStep:
      typeof rr.step === 'number' &&
      Number.isInteger(rr.step) &&
      rr.step >= 0 &&
      rr.step < 100
        ? rr.step
        : null,
    reviewKey:
      typeof rr.key === 'string' && /^[a-z0-9-]{1,40}$/.test(rr.key)
        ? rr.key
        : null,
    overPlan: o.overPlan === true,
  };
}

function parseDraft(v: unknown): MemoDraftView {
  const o = obj(v);
  const goal = obj(o.goal);
  return {
    names: langMap(o.names),
    triggers: langLists(o.triggers),
    suggested: langLists(o.suggested),
    goal: {
      text: langMap(goal.text),
      expect: arr(goal.expect)
        .map(obj)
        .map((g) => ({
          kind: text(g.kind),
          ...(typeof g.path === 'string' ? { path: g.path } : {}),
          ...(typeof g.text === 'string' ? { text: g.text } : {}),
          ...(typeof g.slot === 'string' ? { slot: g.slot } : {}),
          ...(g.target && typeof g.target === 'object'
            ? {
                target: {
                  assistId:
                    typeof obj(g.target).assistId === 'string'
                      ? (obj(g.target).assistId as string).slice(0, 64)
                      : null,
                  text: text(obj(g.target).text).slice(0, 60),
                },
              }
            : {}),
          ...(typeof g.delta === 'number' && Number.isInteger(g.delta)
            ? { delta: g.delta }
            : {}),
        }))
        .slice(0, 3),
    },
    slots: arr(o.slots)
      .map(obj)
      .map((s) => ({
        name: text(s.name),
        kind: text(s.kind),
        pii: s.pii === true,
        options: arr(s.options)
          .map(obj)
          .map((x) => text(x.value))
          .filter(Boolean),
      }))
      .slice(0, 5),
    steps: arr(o.steps)
      .map(obj)
      .map((s) => {
        const t = s.target ? obj(obj(s.target).pin) : null;
        const val = s.value ? obj(s.value) : null;
        return {
          page: text(s.page),
          action: text(s.action),
          target: t
            ? {
                text: text(t.text),
                role: typeof t.role === 'string' ? t.role : null,
                assistId: typeof t.assistId === 'string' ? t.assistId : null,
                mapKey:
                  typeof obj(s.target).mapKey === 'string'
                    ? (obj(s.target).mapKey as string).slice(0, 40)
                    : null,
              }
            : null,
          value: val
            ? typeof val.slot === 'string'
              ? { slot: val.slot }
              : typeof val.const === 'string'
                ? { const: val.const }
                : null
            : null,
        };
      })
      .slice(0, 20),
    view: viewOf(o.view),
    raw: o,
  };
}

function parseVersion(v: unknown): MemoVersionView | null {
  const o = obj(v);
  const status = oneOf(MEMO_VERSION_STATUSES, o.status);
  if (typeof o.number !== 'number' || !status) return null;
  const g = o.gateReport ? obj(o.gateReport) : null;
  const c = o.checkReport ? obj(o.checkReport) : null;
  return {
    number: o.number,
    status,
    gateOk: g ? g.ok === true : null,
    gateProblems: g ? problems(g.problems) : [],
    undo: g ? strs(obj(g.computed).undo, 10) : [],
    risk: g ? strs(obj(g.computed).risk, 10) : [],
    check: c ? oneOf(['pass', 'partial', 'fail'] as const, c.result) : null,
    rollbackOf: typeof o.rollbackOf === 'number' ? o.rollbackOf : null,
    createdAt: iso(o.createdAt) ?? '',
    publishedAt: iso(o.publishedAt),
  };
}

export function parseMemoDetail(v: unknown): MemoDetail | null {
  const s = parseMemoSummary(v);
  if (!s) return null;
  const o = obj(v);
  const g = obj(o.gates);
  return {
    ...s,
    draft: parseDraft(o.draft),
    draftRevision: num(o.draftRevision),
    gates: {
      ok: g.ok === true,
      problems: problems(g.problems),
      undo: strs(obj(g.computed).undo, 10),
      risk: strs(obj(g.computed).risk, 10),
    },
    versions: arr(o.versions)
      .map(parseVersion)
      .filter((x): x is MemoVersionView => !!x),
  };
}

export function parseMemoList(v: unknown): MemoList {
  const o = obj(v);
  return {
    items: arr(o.items)
      .map(parseMemoSummary)
      .filter((x): x is MemoSummary => !!x),
    used: num(o.used),
    limit: num(o.limit),
    candidates: num(o.candidates),
  };
}

const ELEMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseMemoElements(v: unknown): MemoElements {
  const o = obj(v);
  return {
    page: text(o.page).slice(0, 300),
    view: viewOf(o.view),
    items: arr(o.items)
      .map(obj)
      .filter(
        (e) =>
          typeof e.uiElementId === 'string' && ELEMENT_ID.test(e.uiElementId)
      )
      .map((e) => ({
        uiElementId: e.uiElementId as string,
        path: text(e.path).slice(0, 300),
        viewport: viewOf(e.viewport),
        label: text(e.label).slice(0, 80),
        tag: text(e.tag).slice(0, 10),
        role: typeof e.role === 'string' ? e.role.slice(0, 20) : null,
        action: text(e.action).slice(0, 10),
        stability: oneOf(['strong', 'medium', 'fragile'] as const, e.stability),
        stale: e.stale === true,
      }))
      .slice(0, 150),
  };
}

export function parsePhraseSuggest(v: unknown): MemoPhraseSuggestResult {
  const o = obj(v);
  const r = obj(o.report);
  const kept = obj(r.kept);
  const dropped = obj(r.dropped);
  return {
    memo: parseMemoDetail(o.memo),
    langs: arr(r.langs).filter((l): l is MemoLang =>
      (MEMO_LANGS as readonly unknown[]).includes(l)
    ),
    kept: Object.fromEntries(
      MEMO_LANGS.filter((l) => typeof kept[l] === 'number').map((l) => [
        l,
        num(kept[l]),
      ])
    ),
    dropped: Object.fromEntries(
      MEMO_PHRASE_DROPS.filter((c) => typeof dropped[c] === 'number').map(
        (c) => [c, num(dropped[c])]
      )
    ),
  };
}

export interface MemoApi {
  list(siteId: string): Promise<MemoList>;
  create(
    siteId: string,
    body: { name: string; lang: MemoLang; key?: string }
  ): Promise<MemoDetail | null>;
  get(siteId: string, n: number): Promise<MemoDetail | null>;
  patch(
    siteId: string,
    n: number,
    expectedRevision: number,
    ops: MemoOp[]
  ): Promise<MemoDetail | null>;
  build(siteId: string, n: number): Promise<MemoDetail | null>;
  checkToken(
    siteId: string,
    n: number
  ): Promise<{ url: string; version: number }>;
  publish(siteId: string, n: number, v: number): Promise<MemoDetail | null>;
  discard(siteId: string, n: number, v: number): Promise<MemoDetail | null>;
  rollback(siteId: string, n: number, v: number): Promise<MemoDetail | null>;
  disable(siteId: string, n: number): Promise<MemoDetail | null>;
  enable(siteId: string, n: number): Promise<MemoDetail | null>;
  remove(siteId: string, n: number): Promise<void>;
  stats(siteId: string, n: number, days: 7 | 30): Promise<MemoStats>;
  suggestions(siteId: string): Promise<MemoSuggestion[]>;
  fromSuggestion(siteId: string, planId: string): Promise<MemoDetail | null>;
  /** Элементы Ш4 страницы шага (`step` с 0) или страницы `page`. */
  elements(
    siteId: string,
    n: number,
    q: { step?: number; page?: string }
  ): Promise<MemoElements>;
  /** «Добавить шаг» / «заменить цель» выбором элемента Ш4. */
  applyElement(
    siteId: string,
    n: number,
    body: {
      expectedRevision: number;
      uiElementId: string;
      mode: 'add' | 'replace';
      index?: number;
      page?: string;
    }
  ): Promise<MemoDetail | null>;
  /** 3–5 фраз запуска на язык сайта — в «Запропоновано» (бюджет обучения). */
  suggestPhrases(
    siteId: string,
    n: number,
    expectedRevision: number
  ): Promise<MemoPhraseSuggestResult>;
}

const SEG = /^[A-Za-z0-9_-]{1,64}$/;
function seg(id: string): string {
  if (!SEG.test(id)) throw new Error('bad id');
  return id;
}
function n(x: number): string {
  if (!Number.isInteger(x) || x < 1) throw new Error('bad number');
  return String(x);
}

export function createMemoApi(client: ApiClient): MemoApi {
  const base = (id: string) => `/assist/sites/${seg(id)}`;
  const m = (id: string, x: number) => `${base(id)}/memos/${n(x)}`;
  return {
    list: async (id) =>
      parseMemoList(await client.request('GET', `${base(id)}/memos`)),
    create: async (id, body) =>
      parseMemoDetail(await client.request('POST', `${base(id)}/memos`, body)),
    get: async (id, x) =>
      parseMemoDetail(await client.request('GET', m(id, x))),
    patch: async (id, x, expectedRevision, ops) =>
      parseMemoDetail(
        await client.request('PATCH', `${m(id, x)}/draft`, {
          expectedRevision,
          ops,
        })
      ),
    build: async (id, x) =>
      parseMemoDetail(await client.request('POST', `${m(id, x)}/versions`)),
    checkToken: async (id, x) => {
      const o = obj(
        await client.request('POST', `${m(id, x)}/check-token`, {})
      );
      const url = text(o.url);
      if (!/^https:\/\//.test(url)) throw new Error('bad url');
      return { url, version: num(o.version) };
    },
    publish: async (id, x, v) =>
      parseMemoDetail(
        await client.request('POST', `${m(id, x)}/versions/${n(v)}/publish`)
      ),
    discard: async (id, x, v) =>
      parseMemoDetail(
        await client.request('POST', `${m(id, x)}/versions/${n(v)}/discard`)
      ),
    rollback: async (id, x, v) =>
      parseMemoDetail(
        await client.request('POST', `${m(id, x)}/versions/${n(v)}/rollback`)
      ),
    disable: async (id, x) =>
      parseMemoDetail(await client.request('POST', `${m(id, x)}/disable`)),
    enable: async (id, x) =>
      parseMemoDetail(await client.request('POST', `${m(id, x)}/enable`)),
    remove: async (id, x) => {
      await client.request('DELETE', m(id, x));
    },
    stats: async (id, x, days) => {
      const o = obj(
        await client.request('GET', `${m(id, x)}/stats?days=${days}`)
      );
      const fb = obj(o.failuresByStep);
      return {
        windowDays: num(o.windowDays),
        runs: num(o.runs),
        reached: num(o.reached),
        notReached: num(o.notReached),
        unknown: num(o.unknown),
        direct: num(o.direct),
        lite: num(o.lite),
        pinMismatch: num(o.pinMismatch),
        self: num(o.self),
        cancelled: num(o.cancelled),
        failuresByStep: Object.fromEntries(
          Object.entries(fb)
            .filter(([k, v]) => /^\d{1,2}$/.test(k) && typeof v === 'number')
            .map(([k, v]) => [k, v as number])
        ),
      };
    },
    suggestions: async (id) =>
      arr(
        obj(await client.request('GET', `${base(id)}/memo-suggestions`)).items
      )
        .map(obj)
        .filter(
          (s) => typeof s.planId === 'string' && SEG.test(s.planId as string)
        )
        .map((s) => ({
          planId: s.planId as string,
          page: text(s.page),
          steps: arr(s.steps)
            .map(obj)
            .map((x) => ({ kind: text(x.kind), text: text(x.text) }))
            .slice(0, 15),
          visitors: num(s.visitors),
          phrases: strs(s.phrases, 120).slice(0, 5),
        })),
    elements: async (id, x, q) => {
      const p = new URLSearchParams();
      if (q.step !== undefined && Number.isInteger(q.step) && q.step >= 0)
        p.set('step', String(q.step));
      else if (q.page) p.set('page', q.page.slice(0, 300));
      const qs = p.toString();
      return parseMemoElements(
        await client.request('GET', `${m(id, x)}/elements${qs ? `?${qs}` : ''}`)
      );
    },
    applyElement: async (id, x, body) => {
      if (!ELEMENT_ID.test(body.uiElementId)) throw new Error('bad id');
      return parseMemoDetail(
        await client.request('POST', `${m(id, x)}/steps/element`, body)
      );
    },
    suggestPhrases: async (id, x, expectedRevision) =>
      parsePhraseSuggest(
        await client.request('POST', `${m(id, x)}/suggest-phrases`, {
          expectedRevision,
        })
      ),
    fromSuggestion: async (id, planId) =>
      parseMemoDetail(
        await client.request(
          'POST',
          `${base(id)}/memo-suggestions/${seg(planId)}`
        )
      ),
  };
}
