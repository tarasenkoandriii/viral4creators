/**
 * Кабинет голосового управления «Сайтом» Э6-бис (а)+(г) (ТЗ §5-бис.2,
 * §5-бис.8, §5-бис.11, §5-бис.13–14; решения владельца 03.10.2026 п.1–2) —
 * повтор типов `sites-backend/src/modules/assist-site-voice-control/api-types.ts`,
 * `assist-ui-core/types.ts` и `wizard.ts` (сверку держит
 * scripts/voice-control-api.test.ts) и клиент
 * `/assist/sites/:id/voice-control/site` (+ мастер `…/test-token`, `…/tests`).
 * Разбор строгий.
 */
import { ApiError, type ApiClient } from '../kit';
import { createMemoApi, type MemoApi } from './memo-api';
import {
  createMemoTutorialApi,
  type MemoTutorialApi,
} from './memo-tutorial-api';
import {
  createMemoTemplatesApi,
  type MemoTemplatesApi,
} from './memo-templates-api';
import { createVoiceMapApi, type VoiceMapApi } from './voice-map-api';
import { arr, obj, text } from './widget-api';

export const VOICE_CONTROL_STATES = ['off', 'test', 'on', 'degraded'] as const;
export type VoiceControlState = (typeof VOICE_CONTROL_STATES)[number];

export const VOICE_CONTROL_OFF_REASONS = [
  'platform_off',
  'voice_off',
  'state_off',
  'state_test',
  'rules_invalid',
] as const;
export type VoiceControlOffReason = (typeof VOICE_CONTROL_OFF_REASONS)[number];

/** Почему отчёт мастера не годится для `on` (assist-ui-core/wizard.ts ReportProblem). */
export const REPORT_PROBLEMS = [
  'none',
  'failed',
  'partial_ack',
  'expired',
  'loader_changed',
  'markup_changed',
  'older_than_state',
] as const;
export type ReportProblem = (typeof REPORT_PROBLEMS)[number];

export type WizardResult = 'pass' | 'partial' | 'fail';

/** Пункты отчёта мастера (WizardItemCode сервера). */
export const WIZARD_ITEM_CODES = [
  'ok',
  'widget_missing',
  'chunks_blocked',
  'csp_violations',
  'tt_violations',
  'mic_policy_denied',
  'mic_owner_problem',
  'dry_low',
  'safe_low',
  'safe_none',
  'forbidden_leak',
  'suspicious_unreviewed',
  'unnamed_elements',
  'closed_shadow',
  'ext_iframes',
  'duplicates',
] as const;
export type WizardItemCode = (typeof WIZARD_ITEM_CODES)[number];

/** Коды монитора Т-4 в журнале (monitor-rules.ts MonitorCode + переход/откат). */
export const MONITOR_CODES = [
  'done_low',
  'self_high',
  'not_found_high',
  'stoplist_live',
  'violation',
  'transition_expired',
  // Э6-бис (д): возврат полей не удаётся — «разметка отмены устарела».
  'undo_low',
] as const;

export interface VoiceControlRules {
  schema: 1;
  allowPaths: string[];
  allowSelectors: string[];
  denySelectors: string[];
  denyPaths: string[];
  denyWords: string[];
  confirmFill: boolean;
  maxSteps: number;
}

export interface VoiceTestSummary {
  id: string;
  kind: 'wizard' | 'autotest';
  host: string;
  createdAt: string;
  reportedAt: string | null;
  result: WizardResult | null;
  validUntil: string | null;
  release: string | null;
  partialAck: boolean;
  problem: ReportProblem | null;
}

export interface WizardReportView {
  page: string;
  result: WizardResult;
  items: Array<{
    step: number;
    level: 'ok' | 'warn' | 'fail';
    code: WizardItemCode;
  }>;
  never: Array<{ text: string; reason: string }>;
  denySuggestions: string[];
  forbidden: Array<{
    kind: string;
    command: string;
    blocked: boolean;
    candidates: number;
  }>;
  fragment: string;
  markup: { total: number; withId: number; unnamed: number };
}

export interface VoiceTestDetail extends VoiceTestSummary {
  report: WizardReportView | null;
}

export interface VoiceMetrics {
  plans: number;
  done: number;
  self: number;
  notFound: number;
  stoplistLive: number;
  cancelled: number;
  wrong: number;
  violations: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** (д) Цепочки: со следами после сбоя, «Вернуть» принято, возвраты полей. */
  chainsBroken: number;
  chainsWithTraces: number;
  undoAccepted: number;
  undoAttempts: number;
  undoDone: number;
  pnrUnknown: number;
}

export interface VoiceControlSettingsView {
  siteId: string;
  state: VoiceControlState;
  rules: VoiceControlRules;
  available: boolean;
  reason: VoiceControlOffReason | null;
  risksVersion: string;
  /** (д) Р-67: включено по прежней редакции рисков — баннер без перевода в `test`. */
  risksBanner: boolean;
  stateBy: string | null;
  stateAt: string | null;
  stateReason: string | null;
  checkDeadline: string | null;
  lastTest: VoiceTestSummary | null;
  plansPerDay: number;
  monitor: {
    windowHours: number;
    metrics: VoiceMetrics;
    incidents: Array<{ kind: string; code: string; createdAt: string }>;
  } | null;
}

export const VOICE_CONTROL_CABINET_ERROR_CODES = [
  'VOICE_CONTROL_INVALID',
  'VOICE_CONTROL_PLAN_REQUIRED',
  'VOICE_CONTROL_VOICE_REQUIRED',
  'VOICE_CONTROL_RISKS_REQUIRED',
  'VOICE_CONTROL_TEST_REQUIRED',
  'VOICE_CONTROL_HOST_REQUIRED',
  'VOICE_CONTROL_TEST_NOT_FOUND',
  // (е) мемо
  'MEMO_NOT_FOUND',
  'MEMO_INVALID',
  'MEMO_CONFLICT',
  'MEMO_LIMIT',
  'MEMO_KEY_LOCKED',
  'MEMO_NAME_TAKEN',
  'MEMO_RISK_LOWERING_FORBIDDEN',
  'MEMO_GATES',
  'MEMO_CHECK_REQUIRED',
  'MEMO_PHRASE_CONFLICT',
  'MEMO_PLAN_NOT_ELIGIBLE',
] as const;
export type VoiceControlCabinetErrorCode =
  (typeof VOICE_CONTROL_CABINET_ERROR_CODES)[number];

/** Лимиты правил — как RULE_LIMITS сервера. */
export const RULE_LIMITS = { listItems: 30, item: 200, maxSteps: 15 } as const;

const strings = (v: unknown): string[] =>
  arr(v)
    .filter(
      (x): x is string => typeof x === 'string' && x.length <= RULE_LIMITS.item
    )
    .slice(0, RULE_LIMITS.listItems);

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null =>
  (list as readonly unknown[]).includes(v) ? (v as T) : null;
const iso = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
const code = (v: unknown): string | null =>
  typeof v === 'string' && /^[a-z0-9_:.-]{1,60}$/.test(v) ? v : null;
const RESULTS: readonly WizardResult[] = ['pass', 'partial', 'fail'];

export function defaultRules(): VoiceControlRules {
  return {
    schema: 1,
    allowPaths: [],
    allowSelectors: [],
    denySelectors: [],
    denyPaths: [],
    denyWords: [],
    confirmFill: false,
    maxSteps: 6,
  };
}

export function parseTestSummary(v: unknown): VoiceTestSummary | null {
  const o = obj(v);
  const id = text(o.id);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return {
    id,
    kind: o.kind === 'autotest' ? 'autotest' : 'wizard',
    host: text(o.host).slice(0, 255),
    createdAt: iso(o.createdAt) ?? '',
    reportedAt: iso(o.reportedAt),
    result: oneOf(RESULTS, o.result),
    validUntil: iso(o.validUntil),
    release: code(o.release),
    partialAck: o.partialAck === true,
    problem: oneOf(REPORT_PROBLEMS, o.problem),
  };
}

export function parseTestDetail(v: unknown): VoiceTestDetail | null {
  const s = parseTestSummary(v);
  if (!s) return null;
  const r = obj(obj(v).report);
  const result = oneOf(RESULTS, r.result);
  const m = obj(r.markup);
  return {
    ...s,
    report: result
      ? {
          page: text(r.page).slice(0, 300),
          result,
          items: arr(r.items)
            .map(obj)
            .map((x) => ({
              step: Math.min(7, Math.round(num(x.step))),
              level: (x.level === 'fail' || x.level === 'warn'
                ? x.level
                : 'ok') as 'ok' | 'warn' | 'fail',
              code: oneOf(WIZARD_ITEM_CODES, x.code) ?? 'ok',
            })),
          never: arr(r.never)
            .map(obj)
            .map((x) => ({
              text: text(x.text).slice(0, 80),
              reason: code(x.reason) ?? '',
            }))
            .slice(0, 50),
          denySuggestions: strings(r.denySuggestions),
          forbidden: arr(r.forbidden)
            .map(obj)
            .map((x) => ({
              kind: code(x.kind) ?? '',
              command: text(x.command).slice(0, 120),
              blocked: x.blocked === true,
              candidates: num(x.candidates),
            })),
          fragment: text(r.fragment).slice(0, 6000),
          markup: {
            total: num(m.total),
            withId: num(m.withId),
            unnamed: arr(m.unnamed).length,
          },
        }
      : null,
  };
}

function parseMetrics(v: unknown): VoiceMetrics {
  const o = obj(v);
  const ms = (x: unknown) =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
  return {
    plans: num(o.plans),
    done: num(o.done),
    self: num(o.self),
    notFound: num(o.notFound),
    stoplistLive: num(o.stoplistLive),
    cancelled: num(o.cancelled),
    wrong: num(o.wrong),
    violations: num(o.violations),
    latencyP50Ms: ms(o.latencyP50Ms),
    latencyP95Ms: ms(o.latencyP95Ms),
    chainsBroken: Math.round(num(o.chainsBroken)),
    chainsWithTraces: Math.round(num(o.chainsWithTraces)),
    undoAccepted: Math.round(num(o.undoAccepted)),
    undoAttempts: Math.round(num(o.undoAttempts)),
    undoDone: Math.round(num(o.undoDone)),
    pnrUnknown: Math.round(num(o.pnrUnknown)),
  };
}

export function parseVoiceControlSettings(
  v: unknown
): VoiceControlSettingsView {
  const o = obj(v);
  const r = obj(o.rules);
  const steps = r.maxSteps;
  const mon = o.monitor ? obj(o.monitor) : null;
  return {
    siteId: text(o.siteId),
    state: oneOf(VOICE_CONTROL_STATES, o.state) ?? 'off',
    rules: {
      schema: 1,
      allowPaths: strings(r.allowPaths),
      allowSelectors: strings(r.allowSelectors),
      denySelectors: strings(r.denySelectors),
      denyPaths: strings(r.denyPaths),
      denyWords: strings(r.denyWords),
      confirmFill: r.confirmFill === true,
      maxSteps:
        typeof steps === 'number' &&
        Number.isInteger(steps) &&
        steps >= 1 &&
        steps <= RULE_LIMITS.maxSteps
          ? steps
          : 6,
    },
    available: o.available === true,
    reason: oneOf(VOICE_CONTROL_OFF_REASONS, o.reason),
    risksVersion:
      typeof o.risksVersion === 'string' &&
      /^[a-z0-9-]{1,40}$/.test(o.risksVersion)
        ? o.risksVersion
        : '',
    risksBanner: o.risksBanner === true,
    stateBy: code(o.stateBy),
    stateAt: iso(o.stateAt),
    stateReason: code(o.stateReason),
    checkDeadline: iso(o.checkDeadline),
    lastTest: o.lastTest ? parseTestSummary(o.lastTest) : null,
    plansPerDay: Math.round(num(o.plansPerDay)),
    monitor: mon
      ? {
          windowHours: num(mon.windowHours) || 24,
          metrics: parseMetrics(mon.metrics),
          incidents: arr(mon.incidents)
            .map(obj)
            .map((i) => ({
              kind: code(i.kind) ?? '',
              code: code(i.code) ?? '',
              createdAt: iso(i.createdAt) ?? '',
            }))
            .slice(0, 10),
        }
      : null,
  };
}

/** Доля в процентах (0 планов — «—»). */
export function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((100 * n) / d)}%` : '—';
}

/** Строки текстового поля → список (пустые — вон). */
export function lines(s: string): string[] {
  return s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function voiceControlErrorCode(
  e: unknown
): VoiceControlCabinetErrorCode | null {
  return e instanceof ApiError &&
    (VOICE_CONTROL_CABINET_ERROR_CODES as readonly string[]).includes(e.code)
    ? (e.code as VoiceControlCabinetErrorCode)
    : null;
}

export interface VoiceControlApi {
  get(siteId: string): Promise<VoiceControlSettingsView>;
  save(
    siteId: string,
    patch: {
      state: VoiceControlState;
      rules: VoiceControlRules;
      risksVersion?: string;
      partialAck?: boolean;
    }
  ): Promise<VoiceControlSettingsView>;
  /** Одноразовая ссылка мастера проверки на подтверждённый хост сайта. */
  testToken(
    siteId: string,
    body: { host?: string; testHost?: boolean }
  ): Promise<{ testId: string; url: string; expiresAt: string }>;
  tests(siteId: string): Promise<VoiceTestSummary[]>;
  test(siteId: string, testId: string): Promise<VoiceTestDetail | null>;
  /** (е) Мемо «Сайта» — раздел «Голос → Мемо». */
  memo: MemoApi;
  /** Э6-тер (к): мемо из шагов одобренной обучалки (блок «Из обучалки»). */
  memoTutorial: MemoTutorialApi;
  /** Э6-тер (к): мемо из шаблона платформы, публикация пакетом. */
  memoTemplates: MemoTemplatesApi;
  /** Э6-тер: голосовая карта — визуальный редактор (ссылка, версии, публикация). */
  voiceMap: VoiceMapApi;
}

const SEG = /^[A-Za-z0-9_-]{1,64}$/;
function seg(id: string): string {
  if (!SEG.test(id)) throw new Error('bad id');
  return id;
}

export function createVoiceControlApi(client: ApiClient): VoiceControlApi {
  const p = (id: string) => `/assist/sites/${seg(id)}/voice-control/site`;
  return {
    get: async (id) =>
      parseVoiceControlSettings(await client.request('GET', p(id))),
    save: async (id, patch) =>
      parseVoiceControlSettings(await client.request('PATCH', p(id), patch)),
    testToken: async (id, body) => {
      const o = obj(await client.request('POST', `${p(id)}/test-token`, body));
      const url = text(o.url);
      if (!/^https:\/\//.test(url)) throw new Error('bad url');
      return {
        testId: text(o.testId),
        url,
        expiresAt: iso(o.expiresAt) ?? '',
      };
    },
    tests: async (id) =>
      arr(obj(await client.request('GET', `${p(id)}/tests`)).items)
        .map(parseTestSummary)
        .filter((x): x is VoiceTestSummary => !!x),
    test: async (id, tid) =>
      parseTestDetail(
        await client.request('GET', `${p(id)}/tests/${seg(tid)}`)
      ),
    memo: createMemoApi(client),
    memoTutorial: createMemoTutorialApi(client),
    memoTemplates: createMemoTemplatesApi(client),
    voiceMap: createVoiceMapApi(client),
  };
}
