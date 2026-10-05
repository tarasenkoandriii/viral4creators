/**
 * Кабинет голосового управления «Админкой» Э6-бис (б) (ТЗ §5-бис.2,
 * §5-бис.13, §3.8; решения Р-Э6б-1…12) — повтор типов
 * `sites-backend/src/modules/assist-admin-voice/api-types.ts` (сверку держит
 * scripts/admin-voice-api.test.ts) и клиент
 * `/assist/sites/:id/admin-mode/voice-control` (+ `…/test-token`, `…/tests`).
 * Разбор строгий: неизвестное значение — умолчание, а не «что пришло».
 */
import type { ApiClient } from '../kit';
import { seg } from './handoff-api';
import {
  VOICE_CONTROL_STATES,
  type VoiceControlRules,
  type VoiceControlState,
  type WizardResult,
} from './voice-control-api';
import { arr, count, obj, oneOf, str, strs, text } from './widget-api';

/** Редакция экрана рисков «Админки» (ADMIN_VC_RISKS_VERSION сервера). */
export const ADMIN_VC_RISKS_VERSION = 'admin-risks-1';

/** Почему отчёт мастера не годится для `on` (reportUsable сервера). */
export const ADMIN_VC_PROBLEMS = [
  'none',
  'failed',
  'partial_ack',
  'expired',
  'loader_changed',
  'markup_changed',
  'older_than_state',
] as const;
export type AdminVcProblem = (typeof ADMIN_VC_PROBLEMS)[number];

export const ADMIN_VC_ERROR_CODES = [
  'ADMIN_VC_INVALID',
  'ADMIN_VC_PLAN_REQUIRED',
  'ADMIN_VC_MODE_REQUIRED',
  'ADMIN_VC_VOICE_REQUIRED',
  'ADMIN_VC_RISKS_REQUIRED',
  'ADMIN_VC_SITE_NAME',
  'ADMIN_VC_TEST_REQUIRED',
  'ADMIN_VC_HOST_REQUIRED',
  'ADMIN_VC_TEST_NOT_FOUND',
  'ADMIN_VC_OFF',
  'ADMIN_VC_NOT_FOUND',
  'ADMIN_VC_EXPIRED',
  'ADMIN_VC_CONFLICT',
  'ADMIN_VC_CHANGED',
  'ADMIN_VC_BAD_REQUEST',
  'ADMIN_VC_LIMIT',
  'ADMIN_VC_UPSTREAM',
  'ADMIN_VC_TOO_LARGE',
  'ADMIN_VC_AUDIO_INVALID',
  'ADMIN_VC_NOT_HEARD',
] as const;
export type AdminVcErrorCode = (typeof ADMIN_VC_ERROR_CODES)[number];

export interface AdminVoiceHostView {
  id: string;
  host: string;
  verified: boolean;
  /** Отмечен владельцем «тестовый» (staging): на нём мастер проверяет и сохранение. */
  test: boolean;
}

export interface AdminVoiceTestSummary {
  id: string;
  host: string;
  testHost: boolean;
  createdAt: string;
  reportedAt: string | null;
  result: WizardResult | null;
  validUntil: string | null;
  attempts: number;
  problem: AdminVcProblem | null;
  partialAck: boolean;
}

export interface AdminVoiceMetrics {
  plans: number;
  done: number;
  manual: number;
  failed: number;
  stopped: number;
  violations: number;
  expectMisses: number;
}

export interface AdminVoiceSettingsView {
  siteId: string;
  siteName: string;
  state: VoiceControlState;
  stateAt: string | null;
  stateBy: string | null;
  stateReason: string | null;
  rules: VoiceControlRules;
  risksVersion: string;
  risksAccepted: boolean;
  enabledBy: string | null;
  planAllows: boolean;
  adminModeOk: boolean;
  voiceAvailable: boolean;
  platformOn: boolean;
  hosts: AdminVoiceHostView[];
  report: AdminVoiceTestSummary | null;
  onProblem: AdminVcProblem | null;
  metrics: AdminVoiceMetrics;
}

export interface AdminVoiceSettingsPatch {
  state?: VoiceControlState;
  rules?: VoiceControlRules;
  risksVersion?: string;
  siteName?: string;
  partialAck?: boolean;
  testHostIds?: string[];
}

export interface AdminVoiceTestTokenView {
  testId: string;
  url: string;
  expiresAt: string;
  testHost: boolean;
}

export interface AdminVoiceReportView {
  page: string;
  host: string;
  testHost: boolean;
  result: WizardResult;
  items: Array<{ step: number; level: 'ok' | 'warn' | 'fail'; code: string }>;
  attempts: number;
  submitsBlocked: number;
  forbidden: Array<{
    kind: string;
    command: string;
    blocked: boolean;
    api: string | null;
  }>;
  dangerButtons: Array<{ text: string; kind: string }>;
  save: { done: boolean; fields: number } | null;
}

export interface AdminVoiceTestDetail extends AdminVoiceTestSummary {
  report: AdminVoiceReportView | null;
}

const RESULTS = ['pass', 'partial', 'fail'] as const;
const LEVELS = ['ok', 'warn', 'fail'] as const;
const iso = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
const bool = (v: unknown) => v === true;
const pick = <T extends string>(list: readonly T[], v: unknown): T | null =>
  (list as readonly unknown[]).includes(v) ? (v as T) : null;

function parseRules(v: unknown): VoiceControlRules {
  const o = obj(v);
  const list = (x: unknown) => strs(x).slice(0, 30);
  const max = count(o.maxSteps);
  return {
    schema: 1,
    allowPaths: list(o.allowPaths),
    allowSelectors: list(o.allowSelectors),
    denySelectors: list(o.denySelectors),
    denyPaths: list(o.denyPaths),
    denyWords: list(o.denyWords),
    confirmFill: o.confirmFill !== false,
    maxSteps: max >= 1 && max <= 15 ? max : 10,
  };
}

export function parseAdminVoiceTest(v: unknown): AdminVoiceTestSummary {
  const o = obj(v);
  return {
    id: text(o.id),
    host: text(o.host),
    testHost: bool(o.testHost),
    createdAt: iso(o.createdAt) ?? '',
    reportedAt: iso(o.reportedAt),
    result: pick(RESULTS, o.result),
    validUntil: iso(o.validUntil),
    attempts: count(o.attempts),
    problem: pick(ADMIN_VC_PROBLEMS, o.problem),
    partialAck: bool(o.partialAck),
  };
}

function parseReport(v: unknown): AdminVoiceReportView | null {
  if (!v || typeof v !== 'object') return null;
  const o = obj(v);
  const result = pick(RESULTS, o.result);
  if (!result) return null;
  const save = o.save && typeof o.save === 'object' ? obj(o.save) : null;
  return {
    page: text(o.page),
    host: text(o.host),
    testHost: bool(o.testHost),
    result,
    items: arr(o.items)
      .map(obj)
      .map((x) => ({
        step: count(x.step),
        level: oneOf(LEVELS, x.level, 'warn'),
        code: /^[a-z_]{1,40}$/.test(text(x.code)) ? text(x.code) : 'ok',
      }))
      .slice(0, 40),
    attempts: count(o.attempts),
    submitsBlocked: count(o.submitsBlocked),
    forbidden: arr(o.forbidden)
      .map(obj)
      .map((x) => ({
        kind: text(x.kind).slice(0, 30),
        command: text(x.command).slice(0, 200),
        blocked: bool(x.blocked),
        api: str(x.api),
      }))
      .slice(0, 30),
    dangerButtons: arr(o.dangerButtons)
      .map(obj)
      .map((x) => ({
        text: text(x.text).slice(0, 80),
        kind: text(x.kind).slice(0, 30),
      }))
      .slice(0, 30),
    save: save ? { done: bool(save.done), fields: count(save.fields) } : null,
  };
}

export function parseAdminVoiceSettings(v: unknown): AdminVoiceSettingsView {
  const o = obj(v);
  const m = obj(o.metrics);
  return {
    siteId: text(o.siteId),
    siteName: text(o.siteName),
    state: oneOf(VOICE_CONTROL_STATES, o.state, 'off'),
    stateAt: iso(o.stateAt),
    stateBy: str(o.stateBy),
    stateReason: str(o.stateReason),
    rules: parseRules(o.rules),
    risksVersion: text(o.risksVersion),
    risksAccepted: bool(o.risksAccepted),
    enabledBy: str(o.enabledBy),
    planAllows: bool(o.planAllows),
    adminModeOk: bool(o.adminModeOk),
    voiceAvailable: bool(o.voiceAvailable),
    platformOn: bool(o.platformOn),
    hosts: arr(o.hosts)
      .map(obj)
      .map((h) => ({
        id: text(h.id),
        host: text(h.host),
        verified: bool(h.verified),
        test: bool(h.test),
      }))
      .filter((h) => h.id && h.host),
    report: o.report ? parseAdminVoiceTest(o.report) : null,
    onProblem: pick(ADMIN_VC_PROBLEMS, o.onProblem),
    metrics: {
      plans: count(m.plans),
      done: count(m.done),
      manual: count(m.manual),
      failed: count(m.failed),
      stopped: count(m.stopped),
      violations: count(m.violations),
      expectMisses: count(m.expectMisses),
    },
  };
}

export interface AdminVoiceApi {
  get(siteId: string): Promise<AdminVoiceSettingsView>;
  patch(
    siteId: string,
    body: AdminVoiceSettingsPatch
  ): Promise<AdminVoiceSettingsView>;
  testToken(
    siteId: string,
    body: { hostId?: string; path?: string }
  ): Promise<AdminVoiceTestTokenView>;
  tests(siteId: string): Promise<AdminVoiceTestSummary[]>;
  test(siteId: string, testId: string): Promise<AdminVoiceTestDetail>;
}

export function createAdminVoiceApi(client: ApiClient): AdminVoiceApi {
  const base = (s: string) =>
    `/assist/sites/${seg(s)}/admin-mode/voice-control`;
  return {
    get: async (s) =>
      parseAdminVoiceSettings(await client.request('GET', base(s))),
    patch: async (s, b) =>
      parseAdminVoiceSettings(await client.request('PATCH', base(s), b)),
    testToken: async (s, b) => {
      const o = obj(await client.request('POST', `${base(s)}/test-token`, b));
      const url = text(o.url);
      return {
        testId: text(o.testId),
        // Ссылка — только https (её откроет владелец у себя в админке).
        url: /^https:\/\//.test(url) ? url : '',
        expiresAt: iso(o.expiresAt) ?? '',
        testHost: bool(o.testHost),
      };
    },
    tests: async (s) =>
      arr(await client.request('GET', `${base(s)}/tests`)).map(
        parseAdminVoiceTest
      ),
    test: async (s, tid) => {
      const v = await client.request('GET', `${base(s)}/tests/${seg(tid)}`);
      return { ...parseAdminVoiceTest(v), report: parseReport(obj(v).report) };
    },
  };
}
