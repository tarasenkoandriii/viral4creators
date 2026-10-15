/**
 * AI Publisher — контракт маршрутов AI (пакет P-B2, проектный документ
 * §11.3 «P-B1 — контент; P-B2 — AI», строки с пометкой «AI»; §11.1
 * «AI-операции асинхронны»), заполненный по `_template.ts`. Тест
 * `ai-api.spec.ts` сверяет список с контроллером (`ai/ai.controller.ts`).
 *
 * Старт AI-операции (`POST …` с пометкой AI): тело — `opKey` (UUID v4,
 * повтор с тем же ключом → тот же `callId`; тот же ключ с другим запросом
 * — 409 `PUB_IDEMPOTENCY_REUSED`). Ответ:
 *  - 200 `{callId, status:'ok', call}` — модель ответила за 25 с;
 *  - 202 `{callId, status:'running', call:null}` — экран опрашивает
 *    `GET …/ai/calls/:callId` (клиент кита с таймаутом 65 с);
 *  - ошибки (тело ошибки несёт `details.callId`, если вызов записан):
 *    409 `PUB_AI_DISABLED` (пять генераторов вне набора — ручной путь),
 *    409 `PUB_AI_NOT_EVALUATED {missing}` / `PUB_GATE_CLOSED {gate:'ai_use',
 *    missing}`, 409 `PUB_AI_UNPRICED`, 409 `PUB_AI_BUDGET {reason:
 *    'month_not_open'|'cap_exhausted'}` (месяц AI не открыт / потолок
 *    исчерпан; Р-RD-ADM-15), 409
 *    `PUB_AI_LIMIT {taskId}` (без записи вызова), 422
 *    `PUB_AI_SCHEMA_INVALID` (после повтора; задача `needs_human`), 503
 *    `PUB_AI_UNAVAILABLE` (таймаут/недоступность — ручной путь доступен),
 *    409 `PUB_SOURCE_NOT_ALLOWED {sourceIds}` (явный источник не
 *    `allowed`/не `public` для публичного режима).
 *
 * Результат AI — только предложение (`call.output`): запись в предметные
 * таблицы делает человек отдельной мутацией со ссылкой `aiCallId`.
 */
import { route } from './_template';
import type { AiCallView, GeneratorId } from './ai';
import type { MutationBody } from './common';
import type { AiCallStatus, AiCostStatus, AiTaskStatus } from './states';

// ── Старт AI-операций ────────────────────────────────────────────────────

export interface AiStartResponse {
  callId: string;
  status: AiCallStatus;
  /** Готовый вид (модель ответила за время ожидания маршрута), иначе null. */
  call: AiCallView | null;
}

export interface HelperAnswerBody extends MutationBody {
  question: string;
  /** Без списка — все `allowed` источники режима (фактический — в вызове). */
  sourceIds?: string[];
  /** `public` — только `visibility=public` источники и активный оффер. */
  audience?: 'internal' | 'public';
}
export interface BriefDraftBody extends MutationBody {
  questionId: string;
  /** Без списка — разрешённые источники вопроса (`pub_question_sources`). */
  sourceIds?: string[];
  notes?: string;
}
export type QaReviewBody = MutationBody;
export interface AdaptationDraftBody extends MutationBody {
  format: 'post' | 'cards' | 'checklist' | 'video_script';
  /** Пожелания редактора (длина, канал, подача). */
  request?: string;
  /** Без списка — разрешённые источники согласованной версии статьи. */
  sourceIds?: string[];
}
export interface QuestionsClusterBody extends MutationBody {
  questionIds: string[];
}
export type DraftWriteBody = MutationBody;
export interface ClaimsExtractBody extends MutationBody {
  versionId: string;
}

// ── Журнал, задачи ───────────────────────────────────────────────────────

export interface AiCallListItem {
  callId: string;
  generator: GeneratorId;
  status: AiCallStatus;
  taskId: string;
  attemptNo: number;
  objectRef: string;
  requestedBy: string;
  requestedAt: string;
  finishedAt: string | null;
  costStatus: AiCostStatus;
  costMicroUsd: string | null;
  model: string;
  instructionVersion: string;
  errorCode: string | null;
}

export interface AiTaskView {
  id: string;
  generator: GeneratorId;
  objectType: string;
  objectId: string;
  generationsUsed: number;
  extraAllowance: number;
  /** Сколько генераций ещё можно без решения редактора. */
  remaining: number;
  status: AiTaskStatus;
  extraApprovalId: string | null;
  revision: number;
  updatedAt: string;
}

/** `POST …/ai/tasks/:id/accept` — принятый результат (вызов этой задачи, `ok`). */
export interface AcceptTaskBody extends MutationBody {
  callId: string;
}

export interface ExtraGenerationBody extends MutationBody {
  reason: string;
}

// ── Конфигурации и набор 30 задач (только `kind=eval`) ───────────────────

export interface EvalRunSummary {
  id: string;
  configId: string;
  mode: 'fake' | 'live';
  startedAt: string;
  finishedAt: string | null;
  /** Сводка прогона (`eval/protocol.ts` `Totals`), null — не завершён. */
  totals: Record<string, unknown> | null;
}

export interface AiConfigView {
  id: string;
  provider: string;
  model: string;
  configHash: string;
  contextRulesVersion: string;
  schemaSetVersion: string;
  instructionVersions: Record<string, string>;
  coveredGenerators: string[];
  evalSetVersion: string;
  evalStatus: 'not_run' | 'passed' | 'failed' | 'blocked';
  evalRunId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  basis: string | null;
  createdAt: string;
  runs: EvalRunSummary[];
}

export interface ConfigDecisionBody extends MutationBody {
  evalStatus: 'passed' | 'failed' | 'blocked';
  /** Для `passed` — обязателен: живой прогон ЭТОЙ конфигурации с порогом. */
  evalRunId?: string;
  basis: string;
}

export interface FlagResolutionBody extends MutationBody {
  resolution: 'confirmed' | 'dismissed';
  explanation: string;
}

export interface ResultReviewBody extends MutationBody {
  criticalPass: boolean;
  usefulnessPass: boolean;
  explanation: string;
}

/** Строка результата задачи (протокол; первый ответ неизменен). */
export interface EvalResultView {
  id: string;
  taskCode: string;
  schema: string;
  input: unknown;
  allowedSourceIds: string[];
  firstAnswer: unknown;
  firstAnswerRaw: string | null;
  claimSources: unknown;
  autoHardFail: Array<{ code: string; text: string }>;
  autoFlags: Array<{ id: string; code: string; text: string }>;
  flagResolutions: Array<{
    flagId: string;
    resolution: 'confirmed' | 'dismissed';
    explanation: string;
    by: string;
    at: string;
  }>;
  criticalPass: boolean | null;
  usefulnessPass: boolean | null;
  explanation: string | null;
  reviewerMemberId: string | null;
  secondReviewerMemberId: string | null;
  costMicroUsd: string | null;
  costStatus: string;
  retryOfResultId: string | null;
  createdAt: string;
}

/** Протокол прогона (`?format=json`); `?format=md` — тот же протокол текстом. */
export interface EvalProtocolView {
  evalSetVersion: string;
  run: Record<string, unknown>;
  totals: Record<string, unknown>;
  tasks: Array<{
    code: string;
    group: string;
    schema: string;
    generator: string;
    mode: string;
    instructionVersion: string | null;
    results: EvalResultView[];
  }>;
}

// ── Привязки рабочего продукта ───────────────────────────────────────────

export interface AiBindingView {
  id: string;
  configId: string;
  boundBy: string;
  boundAt: string;
  basis: string;
  unboundAt: string | null;
  unboundBy: string | null;
  active: boolean;
  config: {
    configHash: string;
    provider: string;
    model: string;
    evalStatus: AiConfigView['evalStatus'];
  } | null;
}

export interface AiBindingsResponse {
  items: AiBindingView[];
  /** Конфигурации `passed` кабинета (eval-продукты) — к чему можно привязать. */
  available: AiConfigView[];
}

export interface BindBody extends MutationBody {
  configId: string;
  basis: string;
}
export interface UnbindBody extends MutationBody {
  reason: string;
}

const P = '/publisher/products/:pid';

export const AI_ROUTES = {
  helperAnswer: route<HelperAnswerBody, AiStartResponse>({
    method: 'POST',
    path: `${P}/helper/answer`,
    action: 'ai.helper',
    mutation: true,
    status: 202,
  }),
  briefDraft: route<BriefDraftBody, AiStartResponse>({
    method: 'POST',
    path: `${P}/briefs/draft`,
    action: 'ai.generate',
    mutation: true,
    status: 202,
  }),
  qaReview: route<QaReviewBody, AiStartResponse>({
    method: 'POST',
    path: `${P}/versions/:vid/qa-checks/ai-review`,
    action: 'ai.generate',
    mutation: true,
    status: 202,
  }),
  adaptationDraft: route<AdaptationDraftBody, AiStartResponse>({
    method: 'POST',
    path: `${P}/contents/:cid/adaptations/draft`,
    action: 'ai.generate',
    mutation: true,
    status: 202,
  }),
  questionsCluster: route<QuestionsClusterBody, AiStartResponse>({
    method: 'POST',
    path: `${P}/questions/cluster`,
    action: 'ai.generate',
    mutation: true,
    status: 202,
  }),
  draftWrite: route<DraftWriteBody, AiStartResponse>({
    method: 'POST',
    path: `${P}/contents/:cid/versions/draft`,
    action: 'ai.generate',
    mutation: true,
    status: 202,
  }),
  claimsExtract: route<ClaimsExtractBody, AiStartResponse>({
    method: 'POST',
    path: `${P}/claims/extract`,
    action: 'ai.generate',
    mutation: true,
    status: 202,
  }),
  listCalls: route<
    void,
    { items: AiCallListItem[]; nextBefore: string | null }
  >({
    method: 'GET',
    path: `${P}/ai/calls`,
    action: ['ai.generate', 'ai.helper'],
    mutation: false,
    status: 200,
  }),
  getCall: route<void, AiCallView>({
    method: 'GET',
    path: `${P}/ai/calls/:callId`,
    action: ['ai.generate', 'ai.helper'],
    mutation: false,
    status: 200,
  }),
  getTask: route<void, AiTaskView>({
    method: 'GET',
    path: `${P}/ai/tasks/:id`,
    action: ['ai.generate', 'ai.helper'],
    mutation: false,
    status: 200,
  }),
  extra: route<ExtraGenerationBody, AiTaskView>({
    method: 'POST',
    path: `${P}/ai/tasks/:id/extra`,
    action: 'ai.extra',
    mutation: true,
    status: 200,
  }),
  /** Результат вызова принят человеком: задача `open → done` (интеграция Z-1). */
  acceptTask: route<AcceptTaskBody, AiTaskView>({
    method: 'POST',
    path: `${P}/ai/tasks/:id/accept`,
    action: 'ai.generate',
    mutation: true,
    status: 200,
  }),
  configs: route<void, { items: AiConfigView[] }>({
    method: 'GET',
    path: `${P}/ai/configs`,
    action: 'ai.eval.review',
    mutation: false,
    status: 200,
  }),
  configDecision: route<ConfigDecisionBody, AiConfigView>({
    method: 'POST',
    path: `${P}/ai/configs/:id/decision`,
    action: 'ai.bind',
    mutation: true,
    status: 200,
  }),
  evalRuns: route<void, { items: EvalRunSummary[] }>({
    method: 'GET',
    path: `${P}/ai/eval-runs`,
    action: 'ai.eval.review',
    mutation: false,
    status: 200,
  }),
  evalRun: route<void, EvalProtocolView>({
    method: 'GET',
    path: `${P}/ai/eval-runs/:id`,
    action: 'ai.eval.review',
    mutation: false,
    status: 200,
  }),
  resolveFlag: route<FlagResolutionBody, EvalResultView>({
    method: 'POST',
    path: `${P}/ai/eval-runs/:id/results/:rid/flags/:fid`,
    action: 'ai.eval.review',
    mutation: true,
    status: 200,
  }),
  reviewResult: route<ResultReviewBody, EvalResultView>({
    method: 'POST',
    path: `${P}/ai/eval-runs/:id/results/:rid/review`,
    action: 'ai.eval.review',
    mutation: true,
    status: 200,
  }),
  protocol: route<void, EvalProtocolView | string>({
    method: 'GET',
    path: `${P}/ai/eval-runs/:id/protocol`,
    action: 'ai.eval.review',
    mutation: false,
    status: 200,
  }),
  bindings: route<void, AiBindingsResponse>({
    method: 'GET',
    path: `${P}/ai/bindings`,
    action: 'ai.bind',
    mutation: false,
    status: 200,
  }),
  bind: route<BindBody, AiBindingView>({
    method: 'POST',
    path: `${P}/ai/bindings`,
    action: 'ai.bind',
    mutation: true,
    status: 201,
  }),
  unbind: route<UnbindBody, AiBindingView>({
    method: 'POST',
    path: `${P}/ai/bindings/:id/unbind`,
    action: 'ai.bind',
    mutation: true,
    status: 200,
  }),
} as const;
