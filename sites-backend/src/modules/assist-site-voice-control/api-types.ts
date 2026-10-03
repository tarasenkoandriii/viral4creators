/**
 * Протокол голосового управления «Сайтом» (Э6-бис (а)) — стык сервера с
 * iframe-чатом (`widget/src/chat/ui-plan.ts`, `widget/src/shared/ui-plan.ts`)
 * и TMA (`assist/src/lib/voice-control-api.ts` повторяет типы кабинета).
 * Менять — вместе с ними.
 */
import type { UndoResult } from '../assist-ui-core/chain';
import type {
  MemoComputed,
  MemoContent,
  MemoGateProblem,
  MemoIssue,
  MemoOrigin,
  MemoStatus,
  MemoVersionStatus,
  MemoView,
} from '../assist-ui-core/memo';
import type {
  ChainStatus,
  GoalStatus,
  UiPlanNote,
  UiPlanStatus,
  UiPlanStep,
  UiStepResult,
  UiUndo,
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
  /**
   * (е) У сайта есть опубликованные мемо: iframe шлёт в план и тексты без
   * глагола-команды («запис на консультацію») — сервер сам решит, мемо это
   * или вопрос (имена и фразы мемо в загрузчик и iframe не уходят).
   */
  memos?: boolean;
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
  /** (е) «Повторить ещё раз?» — посетитель подтвердил повтор того же мемо. */
  repeat?: boolean;
}

/** Состояние шага в сохранённом плане. */
export type UiStepState = 'pending' | UiStepResult;

export interface UiPlanStepView extends UiPlanStep {
  state: UiStepState;
  /** (д) Шаг дошёл до `dispatched` — действие могло произойти (след на сайте). */
  fx?: boolean;
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
  /**
   * (д) Пометки предпросмотра по шагам (§5-бис.15 п.5): класс обратимости
   * (↺ local, ⇄ comp, ⚠ irrev — точка невозврата, `manual` — ✋ нажмёте сами).
   */
  marks?: Array<UiUndo | 'manual'>;
  /** (д) Номер шага — точки невозврата; null — нет. */
  pnr?: number | null;
  /** (д) Эта карточка — второе «Да» прямо перед точкой невозврата (Р-60). */
  pnrConfirm?: boolean;
  /** (е) План мемо: имя и описание цели (номер и ключ посетителю не показываются). */
  memo?: { name: string; goal: string } | null;
  /** (е) Карточка «повторить ещё раз?» (то же мемо и слоты в 60 с). */
  repeat?: boolean;
  /** (е) Шаг, с которого идёт проверка цели мемо. */
  goalFrom?: number | null;
  goalStatus?: GoalStatus | null;
  /** (д) Что осталось на сайте (после завершения). */
  chainStatus?: ChainStatus | null;
}

/** (д) POST /widget/v1/ui-plan/:id/undo — «Вернуть»/«Оставить»/«отмени последнее». */
export interface UiUndoRequest {
  /** offer — ответ на «Вернуть как было?»; command — «отмени последнее». */
  by: 'offer' | 'command';
  /** keep — «Оставить» (или 60 с без ответа): статус `kept`, ничего не делаем. */
  decision?: 'undo' | 'keep';
}

export interface UiUndoView {
  planId: string;
  /** Поля, которые загрузчик вернёт из памяти страницы (обратный порядок). */
  fields: Array<{ i: number; text: string }>;
  /** Серверные действия — «уберите сами» (компенсации — Э6-тер (и)). */
  manual: Array<{ i: number; text: string }>;
  chainStatus: ChainStatus | null;
  /** Почему нечего вернуть: после отправки формы, окно истекло, нечего, неизвестно. */
  refused: 'after_pnr' | 'expired' | 'nothing' | 'unknown' | 'degraded' | null;
}

/** (д) POST /widget/v1/ui-plan/:id/undo-report — итог возврата полей у загрузчика. */
export interface UiUndoReport {
  results: Array<{ i: number; result: UndoResult }>;
}

/** (е) GET /widget/v1/ui-plan/skills — «Я умею» (В-74): до 5 имён мемо. */
export interface UiSkillsView {
  names: string[];
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

/** (е) Сухой прогон мемо в тестовой сессии мастера (`kind = memo`). */
export interface MemoCheckSessionView {
  /** «М-4» — номер виден только владельцу в тестовой сессии. */
  number: number;
  name: string;
  /** Маски страниц шагов по порядку (что открыть и проверить). */
  pages: string[];
  /** Страница, где проверяется цель (последняя). */
  goalPage: string;
}

/** POST /widget/v1/voice-test/:tid/memo-page — проверка одной страницы. */
export interface MemoCheckPageView {
  path: string;
  /** Подписанный итог страницы — iframe отдаёт его в отчёт (без состояния на сервере). */
  token: string;
  steps: Array<{
    i: number;
    ok: boolean;
    problem:
      'missing' | 'ambiguous' | 'pin_mismatch' | 'risk_up' | 'never' | null;
  }>;
  goal: 'ok' | 'missing' | null;
}

/** POST /widget/v1/voice-test/:tid/memo-report — итог сухого прогона. */
export interface MemoCheckReportRequest {
  tokens: string[];
  lang?: 'uk' | 'ru' | 'en' | null;
}

export interface MemoCheckReport {
  v: 1;
  kind: 'memo';
  memoId: string;
  version: number;
  contentHash: string;
  result: 'pass' | 'partial' | 'fail';
  /** Шаги: проверен на какой странице и как. */
  steps: Array<{
    i: number;
    page: string | null;
    ok: boolean;
    problem: string | null;
  }>;
  goal: 'ok' | 'missing' | 'unchecked';
  /** Фразы, которые прямым путём выбрали ДРУГОЕ мемо (`partial`). */
  phraseConflicts: Array<{ lang: string; phrase: string }>;
}

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
  /** (е) Сухой прогон мемо — вместо мастера страницы. */
  memo?: MemoCheckSessionView | null;
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
  /**
   * (д) Режим включён по прежней редакции рисков (строки про цепочки там
   * нет): баннер «текст рисков обновлён» без перевода в `test` (Р-67).
   */
  risksBanner: boolean;
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

// ══ (е) Кабинет: мемо «Сайта» (ТЗ §5-бис.17 п.12, п.14) ═══════════════════

export interface MemoSummary {
  number: number;
  key: string;
  status: MemoStatus;
  name: string | null;
  view: MemoView;
  listed: boolean;
  origin: MemoOrigin;
  publishedVersion: number | null;
  staleViews: string[];
  /** Успех цели за 30 дней (запусков, дошли до цели). */
  runs30: number;
  reached30: number;
  lastRunAt: string | null;
  reviewReason: unknown;
  updatedAt: string;
}

export interface MemoListView {
  items: MemoSummary[];
  /** «12 из 20» (В-71, Р-69). */
  used: number;
  limit: number;
  /** Кандидатов из боя (В-73) — кнопка «Кандидаты (N)». */
  candidates: number;
}

export interface MemoVersionView {
  number: number;
  status: MemoVersionStatus;
  contentHash: string;
  gateReport: {
    ok: boolean;
    problems: MemoGateProblem[];
    computed: MemoComputed;
  } | null;
  checkReport: MemoCheckReport | null;
  rollbackOf: number | null;
  requestedBy: string;
  publishedBy: string | null;
  createdAt: string;
  publishedAt: string | null;
  content?: MemoContent;
}

export interface MemoDetailView extends MemoSummary {
  draft: MemoContent;
  draftRevision: number;
  /** Ворота черновика сейчас (что не даст опубликовать). */
  gates: { ok: boolean; problems: MemoGateProblem[]; computed: MemoComputed };
  versions: MemoVersionView[];
}

/** POST /assist/sites/:id/memos */
export interface MemoCreateRequest {
  origin?: 'manual';
  name?: string;
  lang?: 'uk' | 'ru' | 'en';
  key?: string;
  draft?: unknown;
}

/** PATCH /assist/sites/:id/memos/:n/draft — операции над черновиком. */
export type MemoDraftOp =
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
  | { op: 'acceptSuggested'; lang: 'uk' | 'ru' | 'en'; phrase: string }
  | { op: 'removeStep'; index: number }
  | { op: 'moveStep'; from: number; to: number }
  | { op: 'listed'; value: boolean }
  | { op: 'key'; value: string };

export interface MemoDraftPatch {
  expectedRevision: number;
  ops: MemoDraftOp[];
}

export interface MemoChangeView {
  revision: number;
  actor: string;
  source: string;
  op: unknown;
  createdAt: string;
}

export interface MemoCheckTokenView {
  testId: string;
  url: string;
  expiresAt: string;
  version: number;
}

export interface MemoStatsView {
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
  chainAfterFailure: Record<string, number>;
}

export interface MemoSuggestionView {
  signature: string;
  planId: string;
  page: string;
  steps: Array<{ kind: string; text: string }>;
  visitors: number;
  phrases: string[];
}

/** Ошибки разбора черновика (path + code) — 422 `MEMO_INVALID`. */
export type MemoValidationErrors = MemoIssue[];

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

/**
 * Версия текста рисков (§5-бис.8) — меняется вместе с текстом в TMA
 * (`assist/src/i18n/*` → `voiceControl.risks`); сверку держит
 * `assist/scripts/voice-control-api.test.ts`.
 */
export const VOICE_CONTROL_RISKS_VERSION = 'site-risks-2';
/**
 * (д) Редакции текста рисков, после которых новая НЕ требует повторного
 * принятия (Р-67, В-69): уже включённые сайты работают, TMA показывает
 * баннер «текст обновлён» (`risksBanner`), новым включениям — текущая.
 */
export const VOICE_CONTROL_RISKS_PREVIOUS: readonly string[] = ['site-risks-1'];
