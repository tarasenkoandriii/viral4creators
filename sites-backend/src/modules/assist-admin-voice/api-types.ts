/**
 * Формы API голосового управления «Админкой» (Э6-бис (б)) — кабинет TMA
 * (`assist/src/lib/admin-voice-api.ts` повторяет, сверка — его скрипт) и
 * iframe `wa.` (`widget/src/admin-vc/`).
 */
import type {
  ChainStatus,
  UiPlanNote,
  UiPlanStatus,
  UiPlanStep,
  UiUndo,
  VoiceControlRules,
  VoiceControlState,
} from '../assist-ui-core/types';
import type { WizardItem, WizardResult } from '../assist-ui-core/wizard';
import type { AdminField, AdminProbeResult } from './admin-voice-rules';

// ── кабинет ────────────────────────────────────────────────────────────────

export interface AdminVoiceHostView {
  id: string;
  host: string;
  verified: boolean;
  /** Отмечен владельцем «тестовый» (staging). */
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
  /** Попыток исполнить шаг на цели «никогда» (регистратор). */
  attempts: number;
  /** Годен ли для `on` сейчас; иначе — почему. */
  problem: string | null;
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
  /** Текущая редакция рисков и принята ли она. */
  risksVersion: string;
  risksAccepted: boolean;
  enabledBy: string | null;
  /** Условия включения. */
  planAllows: boolean;
  adminModeOk: boolean;
  voiceAvailable: boolean;
  platformOn: boolean;
  hosts: AdminVoiceHostView[];
  report: AdminVoiceTestSummary | null;
  /** Почему `on` сейчас нельзя (null — можно). */
  onProblem: string | null;
  metrics: AdminVoiceMetrics;
}

export interface AdminVoiceSettingsPatch {
  state?: VoiceControlState;
  rules?: unknown;
  risksVersion?: string;
  /** Ввод названия сайта при включении (§5-бис.2). */
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

export interface AdminVoiceReport {
  v: 1;
  lang: 'uk' | 'ru' | 'en';
  host: string;
  page: string;
  testHost: boolean;
  result: WizardResult;
  items: WizardItem[];
  /** Попыток по запрещённым целям (регистратор загрузчика + сервер). */
  attempts: number;
  /** Отправок форм на рабочем хосте (должно быть 0). */
  submitsBlocked: number;
  forbidden: AdminProbeResult[];
  dangerButtons: Array<{ ref: string; text: string; kind: string }>;
  dry: Array<{ planId: string; command: string; steps: number; ok: number }>;
  safe: Array<{
    planId: string;
    command: string;
    done: boolean;
    status: string;
  }>;
  /** «Сохранить» на тестовом хосте: план и исход (только testHost). */
  save: { planId: string; done: boolean; fields: number } | null;
  suspicious: Array<{
    key: string;
    why: string;
    label: string;
    selector: string;
  }>;
  reviewed: Record<string, 'deny' | 'safe'>;
}

export interface AdminVoiceTestDetail extends AdminVoiceTestSummary {
  report: AdminVoiceReport | null;
}

// ── iframe `wa.` ──────────────────────────────────────────────────────────

/** Конфиг голосового управления для iframe (после сессии сотрудника). */
export interface AdminVoiceConfigView {
  /** null — выключено (или нет сессии мастера при `test`). */
  mode: 'on' | 'degraded' | null;
  state: VoiceControlState;
  denySelectors: string[];
  allowSelectors: string[];
  maxSteps: number;
  /** Микрофон доступен (тариф, платформа, провайдер). */
  voice: boolean;
  /** Редакция текста согласия «натискати за вас» (на сессию, Р-Э6б-12). */
  consentVersion: string;
}

export interface AdminPlanStepView extends UiPlanStep {
  state: string;
  fx?: boolean;
}

export interface AdminPlanView {
  /** plan; not_command — это вопрос (в чат); api — изменение уходит в
   *  предложение API (команду — в чат); memo — мемо без шагов на странице. */
  kind: 'plan' | 'not_command' | 'api' | 'memo';
  planId: string | null;
  status: UiPlanStatus | null;
  steps: AdminPlanStepView[];
  currentStep: number;
  notes: UiPlanNote[];
  needsConfirm: boolean;
  stepsHash: string | null;
  confirmBefore: string | null;
  expiresAt: string | null;
  marks?: Array<UiUndo | 'manual'>;
  pnr?: number | null;
  pnrConfirm?: boolean;
  /** Перечень изменяемых полей карточки (§5-бис.5 «Админка»). */
  fields?: AdminField[];
  chainStatus?: ChainStatus | null;
  /** Операция API, куда ушла команда (`kind: api`), — для текста. */
  api?: { key: string | null } | null;
  /** «Через API операции нет» — кликами такое никогда. */
  apiMissing?: boolean;
  /** Мемо АМ-N: номер, имя; итог/следующий отрезок после плана. */
  memo?: {
    number: number;
    name: string;
    text: string | null;
    proposalId: string | null;
    /** Следующий отрезок шагов на странице — iframe просит новый план. */
    nextUi: boolean;
  } | null;
}

export interface AdminUndoView {
  planId: string;
  fields: Array<{ i: number; text: string }>;
  refused: 'after_pnr' | 'nothing' | 'unknown' | 'expired' | 'degraded' | null;
  chainStatus: ChainStatus | null;
}
