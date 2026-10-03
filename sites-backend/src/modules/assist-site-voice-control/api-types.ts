/**
 * Протокол голосового управления «Сайтом» (Э6-бис (а)) — стык сервера с
 * iframe-чатом (`widget/src/chat/ui-plan.ts`, `widget/src/shared/ui-plan.ts`)
 * и TMA (`assist/src/lib/voice-control-api.ts` повторяет типы кабинета).
 * Менять — вместе с ними.
 */
import type {
  UiPlanNote,
  UiPlanStatus,
  UiPlanStep,
  UiStepResult,
  VoiceControlRules,
  VoiceControlState,
} from '../assist-ui-core/types';
import type { VoiceControlOffReason } from './voice-control-config';

export type { VoiceControlRules, VoiceControlState, VoiceControlOffReason };

/** GET /widget/v1/config → `voiceControl` (только когда режим есть). */
export interface WidgetVoiceControlConfig {
  mode: 'on' | 'degraded';
  /** Запрещённые селекторы и зоны — загрузчик выкидывает их из снимка. */
  denySelectors: string[];
  allowSelectors: string[];
  maxSteps: number;
}

/** POST /widget/v1/ui-plan — тело. */
export interface UiPlanRequest {
  /** Текст команды: распознанный (с билетом голоса) или набранный в iframe. */
  text: string;
  source: 'voice' | 'typed';
  voiceTicket?: string | null;
  conversationId?: string | null;
  lang?: 'uk' | 'ru' | 'en' | null;
  /** Снимок интерактивных элементов (assist-ui-core/snapshot.ts). */
  snapshot: unknown;
}

/** Состояние шага в сохранённом плане. */
export type UiStepState = 'pending' | UiStepResult;

export interface UiPlanStepView extends UiPlanStep {
  state: UiStepState;
}

/** Ответ маршрутов плана. */
export interface UiPlanView {
  /** `not_command` — это вопрос, а не команда: iframe отправит его в чат. */
  kind: 'plan' | 'not_command';
  planId: string | null;
  conversationId: string | null;
  status: UiPlanStatus | null;
  steps: UiPlanStepView[];
  currentStep: number;
  notes: UiPlanNote[];
  needsConfirm: boolean;
  /** Отпечаток шагов, которые показаны в карточке (подтверждение сверяет его). */
  stepsHash: string | null;
  confirmBefore: string | null;
  expiresAt: string | null;
}

/** POST /widget/v1/ui-plan/:id/confirm */
export interface UiPlanConfirmRequest {
  by: 'button' | 'voice';
  stepsHash: string;
  /** Для `voice`: распознанное «да» и его билет голоса. */
  text?: string;
  voiceTicket?: string;
}

/** POST /widget/v1/ui-plan/:id/step */
export interface UiPlanStepReport {
  index: number;
  result: UiStepResult;
  reason?: string | null;
  durationMs?: number | null;
  /** Страница, где шаг исполнен (без query). */
  url?: string | null;
}

/** POST /widget/v1/ui-plan/:id/stop */
export interface UiPlanStopRequest {
  by: 'button' | 'esc' | 'click' | 'voice' | 'close';
}

/** POST /widget/v1/ui-plan/:id/resume — новый снимок после перехода. */
export interface UiPlanResumeRequest {
  snapshot: unknown;
}

/** Кабинет: GET /assist/sites/:id/voice-control/site */
export interface VoiceControlSettingsView {
  siteId: string;
  state: VoiceControlState;
  rules: VoiceControlRules;
  /** Голос сайта включён и тариф позволяет — можно включать режим. */
  available: boolean;
  /** Почему режим сейчас не работает у посетителей (null — работает). */
  reason: VoiceControlOffReason | null;
  /** Версия текста рисков (§5-бис.8), которую видит владелец. */
  risksVersion: string;
}

/** Кабинет: PATCH /assist/sites/:id/voice-control/site */
export interface VoiceControlSettingsPatch {
  state: 'off' | 'on';
  rules?: unknown;
  /** Владелец видел экран рисков этой версии (обязательно для `on`). */
  risksVersion?: string;
}

export const VOICE_CONTROL_CABINET_ERROR_CODES = [
  'VOICE_CONTROL_INVALID',
  'VOICE_CONTROL_PLAN_REQUIRED',
  'VOICE_CONTROL_VOICE_REQUIRED',
  'VOICE_CONTROL_RISKS_REQUIRED',
] as const;
export type VoiceControlCabinetErrorCode =
  (typeof VOICE_CONTROL_CABINET_ERROR_CODES)[number];

/**
 * Версия текста рисков (§5-бис.8) — меняется вместе с текстом в TMA
 * (`assist/src/i18n/*` → `voiceControl.risks`); сверку держит
 * `assist/scripts/voice-control-api.test.ts`.
 */
export const VOICE_CONTROL_RISKS_VERSION = 'site-risks-1';
