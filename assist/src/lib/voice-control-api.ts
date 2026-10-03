/**
 * Кабинет голосового управления «Сайтом» Э6-бис (а) (ТЗ §5-бис.2,
 * §5-бис.8, §5-бис.11) — повтор типов
 * `sites-backend/src/modules/assist-site-voice-control/api-types.ts` и
 * `assist-ui-core/types.ts` (сверку держит scripts/voice-control-api.test.ts)
 * и клиент `/assist/sites/:id/voice-control/site`. Разбор строгий.
 */
import { ApiError, type ApiClient } from '../kit';
import { arr, obj, text } from './widget-api';

export const VOICE_CONTROL_STATES = ['off', 'test', 'on', 'degraded'] as const;
export type VoiceControlState = (typeof VOICE_CONTROL_STATES)[number];

export const VOICE_CONTROL_OFF_REASONS = [
  'platform_off',
  'voice_off',
  'state_off',
  'rules_invalid',
] as const;
export type VoiceControlOffReason = (typeof VOICE_CONTROL_OFF_REASONS)[number];

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

export interface VoiceControlSettingsView {
  siteId: string;
  state: VoiceControlState;
  rules: VoiceControlRules;
  available: boolean;
  reason: VoiceControlOffReason | null;
  risksVersion: string;
}

export const VOICE_CONTROL_CABINET_ERROR_CODES = [
  'VOICE_CONTROL_INVALID',
  'VOICE_CONTROL_PLAN_REQUIRED',
  'VOICE_CONTROL_VOICE_REQUIRED',
  'VOICE_CONTROL_RISKS_REQUIRED',
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

export function parseVoiceControlSettings(
  v: unknown
): VoiceControlSettingsView {
  const o = obj(v);
  const r = obj(o.rules);
  const steps = r.maxSteps;
  return {
    siteId: text(o.siteId),
    state: (VOICE_CONTROL_STATES as readonly unknown[]).includes(o.state)
      ? (o.state as VoiceControlState)
      : 'off',
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
    reason: (VOICE_CONTROL_OFF_REASONS as readonly unknown[]).includes(o.reason)
      ? (o.reason as VoiceControlOffReason)
      : null,
    risksVersion:
      typeof o.risksVersion === 'string' &&
      /^[a-z0-9-]{1,40}$/.test(o.risksVersion)
        ? o.risksVersion
        : '',
  };
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
      state: 'off' | 'on';
      rules: VoiceControlRules;
      risksVersion?: string;
    }
  ): Promise<VoiceControlSettingsView>;
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
  };
}
