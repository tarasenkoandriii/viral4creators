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
import type {
  ForbiddenProbeResult,
  MicStatus,
  NeverItem,
  ReportProblem,
  SuspiciousItem,
  WizardCommand,
  WizardDryRun,
  WizardEnvFacts,
  WizardItem,
  WizardMarkupFacts,
  WizardResult,
  WizardSafeRun,
} from '../assist-ui-core/wizard';
import type { SiteVoiceMetrics } from './monitor-rules';
import type { VoiceControlOffReason } from './voice-control-config';

export type { VoiceControlRules, VoiceControlState, VoiceControlOffReason };

/** GET /widget/v1/config → `voiceControl` (только когда режим есть). */
export interface WidgetVoiceControlConfig {
  /** (г) `on` — исполняет; `degraded` — только подсветка. */
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
  /**
   * (г) Сухой прогон мастера Т-2 — только в тестовой сессии: план строится и
   * проверяется, исполнения нет (цели подсвечиваются в iframe мастера).
   */
  dryRun?: boolean;
  /** (г) Выпуск чанков виджета (канарейка) — из кадра iframe. */
  release?: string | null;
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

// ══ (г) Мастер проверки Т-2: маршруты виджета (тестовая сессия) ══════════

/** POST /widget/v1/voice-test/session — обмен одноразовой ссылки. */
export interface VoiceTestSessionRequest {
  token: string;
}

export interface VoiceTestSessionView {
  /** Сессия — в sessionStorage iframe, заголовок WIDGET_VOICE_TEST_HEADER. */
  session: string;
  testId: string;
  expiresAt: string;
  /** Хост отмечен «тестовым» (staging) — отправка форм с подтверждением. */
  testHost: boolean;
  /** Режим для тестовой сессии (всегда `on`, правила кабинета). */
  voiceControl: WidgetVoiceControlConfig;
}

/** POST /widget/v1/voice-test/:tid/analyze — снимок страницы → команды и запреты. */
export interface VoiceTestAnalyzeRequest {
  snapshot: unknown;
  lang?: 'uk' | 'ru' | 'en' | null;
}

export interface VoiceTestAnalyzeView {
  commands: WizardCommand[];
  forbidden: ForbiddenProbeResult[];
  never: NeverItem[];
}

/** POST /widget/v1/voice-test/:tid/report — итог мастера (вердикт считает сервер). */
export interface VoiceTestReportRequest {
  lang?: 'uk' | 'ru' | 'en' | null;
  /** Снимок проверенной страницы — запреты пересчитываются по нему заново. */
  snapshot: unknown;
  env: unknown;
  mic: unknown;
  markup: unknown;
  /** Список 2 (загрузчик) и решения владельца по нему. */
  suspicious: unknown;
  reviewed: unknown;
  /** Сухой прогон: план и сколько шагов владелец отметил «верно». */
  dry: unknown;
}

/** Отчёт мастера — хранится в assist_site_voice_tests.report. */
export interface WizardReport {
  v: 1;
  lang: 'uk' | 'ru' | 'en';
  page: string;
  host: string;
  testHost: boolean;
  result: WizardResult;
  items: WizardItem[];
  env: WizardEnvFacts;
  mic: MicStatus;
  markup: WizardMarkupFacts;
  never: NeverItem[];
  suspicious: SuspiciousItem[];
  reviewed: Record<string, 'deny' | 'safe'>;
  denySuggestions: string[];
  dry: WizardDryRun[];
  safe: WizardSafeRun[];
  forbidden: ForbiddenProbeResult[];
  fragment: string;
}

export interface VoiceTestReportView {
  testId: string;
  result: WizardResult;
  validUntil: string;
  report: WizardReport;
}

// ══ Кабинет ════════════════════════════════════════════════════════════════

/** Сводка отчёта мастера в кабинете. */
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
  /** Годен ли для `on` сейчас (null — годен; иначе — почему нет). */
  problem: ReportProblem | null;
}

export interface VoiceTestDetail extends VoiceTestSummary {
  report: WizardReport | null;
}

/** Метрики Т-4 за 24 ч (кабинет и платформа). */
export interface VoiceMonitorView {
  windowHours: number;
  metrics: SiteVoiceMetrics;
  incidents: Array<{
    kind: string;
    code: string;
    createdAt: string;
  }>;
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
  /** (г) Кто/когда/почему сменил состояние последний раз. */
  stateBy: string | null;
  stateAt: string | null;
  stateReason: string | null;
  /** (г) Переходный период: до этой даты `on` без отчёта, затем `test`. */
  checkDeadline: string | null;
  /** (г) Последний отчёт мастера (и годен ли он для `on`). */
  lastTest: VoiceTestSummary | null;
  /** (г) Суточный потолок планов сайта (тариф или оверрайд оператора). */
  plansPerDay: number;
  /** (г) Монитор Т-4. */
  monitor: VoiceMonitorView | null;
}

/** Кабинет: PATCH /assist/sites/:id/voice-control/site */
export interface VoiceControlSettingsPatch {
  /** (г) + `test`, `degraded` (владелец сам — «только подсветка»). */
  state: VoiceControlState;
  rules?: unknown;
  /** Владелец видел экран рисков этой версии (обязательно для `test`/`on`). */
  risksVersion?: string;
  /** (г) Отчёт `partial`: «понимаю, часть команд — „нажмите сами“». */
  partialAck?: boolean;
}

/** POST /assist/sites/:id/voice-control/site/test-token */
export interface VoiceTestTokenRequest {
  /** Подтверждённый хост сайта (имя); по умолчанию — первый. */
  host?: string;
  /** Хост — тестовый (staging): там мастер проверит и отправку формы. */
  testHost?: boolean;
}

export interface VoiceTestTokenView {
  testId: string;
  /** Одноразовая ссылка на сайт с `?v4c_voicetest=<токен>`. */
  url: string;
  expiresAt: string;
}

export const VOICE_CONTROL_CABINET_ERROR_CODES = [
  'VOICE_CONTROL_INVALID',
  'VOICE_CONTROL_PLAN_REQUIRED',
  'VOICE_CONTROL_VOICE_REQUIRED',
  'VOICE_CONTROL_RISKS_REQUIRED',
  /** (г) `on` без годного отчёта мастера — 409 (§5-бис.11, решение п.1). */
  'VOICE_CONTROL_TEST_REQUIRED',
  /** (г) Нет подтверждённого хоста для ссылки мастера. */
  'VOICE_CONTROL_HOST_REQUIRED',
  'VOICE_CONTROL_TEST_NOT_FOUND',
] as const;
export type VoiceControlCabinetErrorCode =
  (typeof VOICE_CONTROL_CABINET_ERROR_CODES)[number];

/**
 * Версия текста рисков (§5-бис.8) — меняется вместе с текстом в TMA
 * (`assist/src/i18n/*` → `voiceControl.risks`); сверку держит
 * `assist/scripts/voice-control-api.test.ts`.
 */
export const VOICE_CONTROL_RISKS_VERSION = 'site-risks-1';
