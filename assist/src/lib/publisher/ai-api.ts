/**
 * AI Publisher (P-G1) — AI-операции P-B2 (контракт `contracts/ai-api.ts`,
 * `AI_ROUTES`; §11.1 «AI-операции асинхронны», §12).
 *
 * Старт: `POST …` → 200 `{callId, status:'ok', call}` или 202
 * `{callId, status:'running', call:null}`; экран опрашивает
 * `GET ai/calls/:callId` клиентом с таймаутом 65 с до финального статуса.
 * Выключенные генераторы (ДТ-2) — 409 `PUB_AI_DISABLED`: экран показывает
 * ручной путь. Результат AI — только предложение: запись делает человек
 * отдельной мутацией со ссылкой `aiCallId` (§12.5).
 */

import type { PublisherHttp, Query } from './common-api';
import { seg } from './common-api';
import {
  arr,
  bool,
  int,
  iso,
  isoOrNull,
  itemsOf,
  listPage,
  minorOrNull,
  obj,
  oneOf,
  str,
  strOrNull,
  type ListPage,
} from './decode';
import {
  AI_CALL_STATUSES,
  AI_COST_STATUSES,
  AI_EVAL_STATUSES,
  AI_TASK_STATUSES,
  GENERATOR_IDS,
  type AiCallStatus,
  type AiCostStatus,
  type AiTaskStatus,
  type GeneratorId,
} from './states';

export interface AiCallView {
  callId: string;
  generator: GeneratorId;
  status: AiCallStatus;
  taskId: string;
  attemptNo: number;
  output: unknown | null;
  findings: Array<{ code: string; text: string; severity?: string }>;
  errorCode: string | null;
  costStatus: AiCostStatus;
  /** Микродоллары строкой; `null` — неизвестна (не ноль). */
  costMicroUsd: string | null;
  requestedAt: string;
  finishedAt: string | null;
  contextFactIds: string[];
  contextSourceIds: string[];
}

export interface AiStartResponse {
  callId: string;
  status: AiCallStatus;
  call: AiCallView | null;
}

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
  remaining: number;
  status: AiTaskStatus;
  extraApprovalId: string | null;
  revision: number;
  updatedAt: string;
}

export interface AiConfigView {
  id: string;
  provider: string;
  model: string;
  configHash: string;
  evalStatus: (typeof AI_EVAL_STATUSES)[number];
  evalRunId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  basis: string | null;
  coveredGenerators: string[];
  evalSetVersion: string;
  createdAt: string;
  runs: Array<{
    id: string;
    mode: 'fake' | 'live';
    startedAt: string;
    finishedAt: string | null;
  }>;
}

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
    evalStatus: (typeof AI_EVAL_STATUSES)[number];
  } | null;
}

/** Финальный ли статус вызова (опрос прекращается). */
export function isFinalCall(status: AiCallStatus): boolean {
  return status !== 'running';
}

export function decodeCall(v: unknown): AiCallView {
  const o = obj(v, 'aiCall');
  return {
    callId: str(o.callId),
    generator: oneOf(o.generator, GENERATOR_IDS, 'aiCall.generator'),
    status: oneOf(o.status, AI_CALL_STATUSES, 'aiCall.status'),
    taskId: str(o.taskId),
    attemptNo: int(o.attemptNo),
    output: o.output ?? null,
    findings: arr(o.findings ?? [], (x) => {
      const f = obj(x, 'finding');
      const out: { code: string; text: string; severity?: string } = {
        code: str(f.code),
        text: str(f.text),
      };
      if (typeof f.severity === 'string') out.severity = f.severity;
      return out;
    }),
    errorCode: strOrNull(o.errorCode),
    costStatus: oneOf(o.costStatus, AI_COST_STATUSES, 'aiCall.costStatus'),
    costMicroUsd: minorOrNull(o.costMicroUsd, 'aiCall.cost'),
    requestedAt: iso(o.requestedAt),
    finishedAt: isoOrNull(o.finishedAt),
    contextFactIds: arr(o.contextFactIds ?? [], (x) => str(x)),
    contextSourceIds: arr(o.contextSourceIds ?? [], (x) => str(x)),
  };
}

export function decodeStart(v: unknown): AiStartResponse {
  const o = obj(v, 'aiStart');
  return {
    callId: str(o.callId),
    status: oneOf(o.status, AI_CALL_STATUSES, 'aiStart.status'),
    call: o.call === null || o.call === undefined ? null : decodeCall(o.call),
  };
}

export function decodeCallItem(v: unknown): AiCallListItem {
  const o = obj(v, 'aiCallItem');
  return {
    callId: str(o.callId),
    generator: oneOf(o.generator, GENERATOR_IDS, 'aiCallItem.generator'),
    status: oneOf(o.status, AI_CALL_STATUSES, 'aiCallItem.status'),
    taskId: str(o.taskId),
    attemptNo: int(o.attemptNo),
    objectRef: str(o.objectRef),
    requestedBy: str(o.requestedBy),
    requestedAt: iso(o.requestedAt),
    finishedAt: isoOrNull(o.finishedAt),
    costStatus: oneOf(o.costStatus, AI_COST_STATUSES, 'aiCallItem.costStatus'),
    costMicroUsd: minorOrNull(o.costMicroUsd, 'aiCallItem.cost'),
    model: str(o.model),
    instructionVersion: str(o.instructionVersion),
    errorCode: strOrNull(o.errorCode),
  };
}

export function decodeTask(v: unknown): AiTaskView {
  const o = obj(v, 'aiTask');
  return {
    id: str(o.id),
    generator: oneOf(o.generator, GENERATOR_IDS, 'aiTask.generator'),
    objectType: str(o.objectType),
    objectId: str(o.objectId),
    generationsUsed: int(o.generationsUsed),
    extraAllowance: int(o.extraAllowance),
    remaining: int(o.remaining),
    status: oneOf(o.status, AI_TASK_STATUSES, 'aiTask.status'),
    extraApprovalId: strOrNull(o.extraApprovalId),
    revision: int(o.revision),
    updatedAt: iso(o.updatedAt),
  };
}

export function decodeConfig(v: unknown): AiConfigView {
  const o = obj(v, 'aiConfig');
  return {
    id: str(o.id),
    provider: str(o.provider),
    model: str(o.model),
    configHash: str(o.configHash),
    evalStatus: oneOf(o.evalStatus, AI_EVAL_STATUSES, 'aiConfig.evalStatus'),
    evalRunId: strOrNull(o.evalRunId),
    decidedBy: strOrNull(o.decidedBy),
    decidedAt: isoOrNull(o.decidedAt),
    basis: strOrNull(o.basis),
    coveredGenerators: arr(o.coveredGenerators, (x) => str(x)),
    evalSetVersion: str(o.evalSetVersion),
    createdAt: iso(o.createdAt),
    runs: arr(o.runs ?? [], (x) => {
      const r = obj(x, 'run');
      return {
        id: str(r.id),
        mode: oneOf(r.mode, ['fake', 'live'] as const),
        startedAt: iso(r.startedAt),
        finishedAt: isoOrNull(r.finishedAt),
      };
    }),
  };
}

export function decodeBinding(v: unknown): AiBindingView {
  const o = obj(v, 'aiBinding');
  const c = o.config === null || o.config === undefined ? null : obj(o.config);
  return {
    id: str(o.id),
    configId: str(o.configId),
    boundBy: str(o.boundBy),
    boundAt: iso(o.boundAt),
    basis: str(o.basis),
    unboundAt: isoOrNull(o.unboundAt),
    unboundBy: strOrNull(o.unboundBy),
    active: bool(o.active),
    config: c
      ? {
          configHash: str(c.configHash),
          provider: str(c.provider),
          model: str(c.model),
          evalStatus: oneOf(c.evalStatus, AI_EVAL_STATUSES),
        }
      : null,
  };
}

// ── Набор 30 задач (только `kind=eval`) ───────────────────────────────────

export interface EvalRunSummary {
  id: string;
  configId: string;
  mode: 'fake' | 'live';
  startedAt: string;
  finishedAt: string | null;
  totals: Record<string, unknown> | null;
}

export interface EvalResultView {
  id: string;
  taskCode: string;
  schema: string;
  input: unknown;
  allowedSourceIds: string[];
  firstAnswer: unknown;
  firstAnswerRaw: string | null;
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
  costMicroUsd: string | null;
  costStatus: string;
  createdAt: string;
}

export interface EvalProtocolView {
  evalSetVersion: string;
  totals: Record<string, unknown>;
  tasks: Array<{
    code: string;
    group: string;
    schema: string;
    generator: string;
    mode: string;
    results: EvalResultView[];
  }>;
}

const boolOrNull = (v: unknown) =>
  v === null || v === undefined ? null : bool(v, 'bool?');

export function decodeEvalRun(v: unknown): EvalRunSummary {
  const o = obj(v, 'evalRun');
  return {
    id: str(o.id),
    configId: str(o.configId),
    mode: oneOf(o.mode, ['fake', 'live'] as const, 'evalRun.mode'),
    startedAt: iso(o.startedAt),
    finishedAt: isoOrNull(o.finishedAt),
    totals: o.totals === null || o.totals === undefined ? null : obj(o.totals),
  };
}

export function decodeEvalResult(v: unknown): EvalResultView {
  const o = obj(v, 'evalResult');
  const codeText = (x: unknown) => {
    const c = obj(x);
    return { code: str(c.code), text: str(c.text) };
  };
  return {
    id: str(o.id),
    taskCode: str(o.taskCode),
    schema: str(o.schema),
    input: o.input ?? null,
    allowedSourceIds: arr(o.allowedSourceIds ?? [], (x) => str(x)),
    firstAnswer: o.firstAnswer ?? null,
    firstAnswerRaw: strOrNull(o.firstAnswerRaw),
    autoHardFail: arr(o.autoHardFail ?? [], codeText),
    autoFlags: arr(o.autoFlags ?? [], (x) => {
      const f = obj(x);
      return { id: str(f.id), code: str(f.code), text: str(f.text) };
    }),
    flagResolutions: arr(o.flagResolutions ?? [], (x) => {
      const f = obj(x);
      return {
        flagId: str(f.flagId),
        resolution: oneOf(f.resolution, ['confirmed', 'dismissed'] as const),
        explanation: str(f.explanation),
        by: str(f.by),
        at: str(f.at),
      };
    }),
    criticalPass: boolOrNull(o.criticalPass),
    usefulnessPass: boolOrNull(o.usefulnessPass),
    explanation: strOrNull(o.explanation),
    reviewerMemberId: strOrNull(o.reviewerMemberId),
    costMicroUsd: minorOrNull(o.costMicroUsd, 'evalResult.cost'),
    costStatus: str(o.costStatus),
    createdAt: iso(o.createdAt),
  };
}

export function decodeProtocol(v: unknown): EvalProtocolView {
  const o = obj(v, 'protocol');
  return {
    evalSetVersion: str(o.evalSetVersion),
    totals: o.totals === null || o.totals === undefined ? {} : obj(o.totals),
    tasks: arr(o.tasks, (x) => {
      const t = obj(x, 'protocol.task');
      return {
        code: str(t.code),
        group: str(t.group),
        schema: str(t.schema),
        generator: str(t.generator),
        mode: str(t.mode),
        results: arr(t.results, decodeEvalResult),
      };
    }),
  };
}

/** Последнее решение по каждому флагу (решения — append-only). */
export function latestFlagResolutions(
  r: Pick<EvalResultView, 'flagResolutions'>
): Map<string, EvalResultView['flagResolutions'][number]> {
  const m = new Map<string, EvalResultView['flagResolutions'][number]>();
  for (const f of r.flagResolutions) m.set(f.flagId, f);
  return m;
}

// ── Выход генераторов (схемы §12.2) — только то, что экран показывает ─────

export interface BriefDraftOutput {
  question: string;
  audience: string | null;
  source_ids: string[];
  original_contribution: string | null;
  short_answer: string;
  structure: string[];
  format: 'instruction' | 'case_review' | 'choice_guide';
  cta: { text: string; intent_fit_note: string };
  channels: string[];
  limitations: string[];
  unresolved_questions: string[];
}

export function decodeBriefDraft(v: unknown): BriefDraftOutput {
  const o = obj(v, 'briefDraft');
  const cta = obj(o.cta, 'briefDraft.cta');
  const s = (x: unknown) => str(x);
  return {
    question: str(o.question),
    audience: strOrNull(o.audience),
    source_ids: arr(o.source_ids, s),
    original_contribution: strOrNull(o.original_contribution),
    short_answer: str(o.short_answer),
    structure: arr(o.structure, s),
    format: oneOf(o.format, [
      'instruction',
      'case_review',
      'choice_guide',
    ] as const),
    cta: { text: str(cta.text), intent_fit_note: str(cta.intent_fit_note) },
    channels: arr(o.channels, s),
    limitations: arr(o.limitations, s),
    unresolved_questions: arr(o.unresolved_questions, s),
  };
}

export interface HelperAnswerOutput {
  answer: string;
  used_source_ids: string[];
  unknowns: string[];
  next_action: string;
}
export function decodeHelperAnswer(v: unknown): HelperAnswerOutput {
  const o = obj(v, 'helperAnswer');
  const s = (x: unknown) => str(x);
  return {
    answer: str(o.answer),
    used_source_ids: arr(o.used_source_ids, s),
    unknowns: arr(o.unknowns, s),
    next_action: str(o.next_action),
  };
}

export interface QaReviewOutput {
  object_version: string;
  claims: Array<{
    statement: string;
    type: string;
    risk: string;
    source_ids: string[];
    supported: 'yes' | 'no' | 'unknown';
  }>;
  blockers: Array<{ code: string; text: string; claim_index: number | null }>;
  unresolved_questions: string[];
  recommendation: string;
}
export function decodeQaReview(v: unknown): QaReviewOutput {
  const o = obj(v, 'qaReview');
  const s = (x: unknown) => str(x);
  return {
    object_version: str(o.object_version),
    claims: arr(o.claims, (x) => {
      const c = obj(x);
      return {
        statement: str(c.statement),
        type: str(c.type),
        risk: str(c.risk),
        source_ids: arr(c.source_ids, s),
        supported: oneOf(c.supported, ['yes', 'no', 'unknown'] as const),
      };
    }),
    blockers: arr(o.blockers, (x) => {
      const b = obj(x);
      return {
        code: str(b.code),
        text: str(b.text),
        claim_index:
          b.claim_index === null || b.claim_index === undefined
            ? null
            : int(b.claim_index),
      };
    }),
    unresolved_questions: arr(o.unresolved_questions, s),
    recommendation: str(o.recommendation),
  };
}

export interface AdaptationOutput {
  parent_version: string;
  format: 'post' | 'cards' | 'checklist' | 'video_script';
  title: string;
  body: string | null;
  cards: Array<{ title: string; text: string }> | null;
  scenes: Array<{ visual: string; voice: string; caption: string }> | null;
  is_script: boolean;
  cta: string;
  used_source_ids: string[];
  preserved_caveats: string[];
  unresolved_questions: string[];
}
export function decodeAdaptation(v: unknown): AdaptationOutput {
  const o = obj(v, 'adaptation');
  const s = (x: unknown) => str(x);
  return {
    parent_version: str(o.parent_version),
    format: oneOf(o.format, [
      'post',
      'cards',
      'checklist',
      'video_script',
    ] as const),
    title: str(o.title),
    body: strOrNull(o.body),
    cards:
      o.cards === null || o.cards === undefined
        ? null
        : arr(o.cards, (x) => {
            const c = obj(x);
            return { title: str(c.title), text: str(c.text) };
          }),
    scenes:
      o.scenes === null || o.scenes === undefined
        ? null
        : arr(o.scenes, (x) => {
            const c = obj(x);
            return {
              visual: str(c.visual),
              voice: str(c.voice),
              caption: str(c.caption),
            };
          }),
    is_script: bool(o.is_script),
    cta: str(o.cta),
    used_source_ids: arr(o.used_source_ids, s),
    preserved_caveats: arr(o.preserved_caveats, s),
    unresolved_questions: arr(o.unresolved_questions, s),
  };
}

// ── Клиент ───────────────────────────────────────────────────────────────

// Тела мутаций — зеркало `*Body` contracts/ai-api.ts без `opKey`.
export type HelperAnswerIn = {
  question: string;
  sourceIds?: string[];
  audience?: 'internal' | 'public';
};
export type BriefDraftIn = {
  questionId: string;
  sourceIds?: string[];
  notes?: string;
};
export type AdaptationDraftIn = {
  format: 'post' | 'cards' | 'checklist' | 'video_script';
  request?: string;
  sourceIds?: string[];
};
export type ConfigDecisionIn = {
  evalStatus: 'passed' | 'failed' | 'blocked';
  evalRunId?: string;
  basis: string;
};

/**
 * `http` — обычный клиент (журнал, задачи); `aiHttp` — с таймаутом 65 с
 * (старт и опрос вызова).
 */
export function createAiApi(
  http: PublisherHttp,
  aiHttp: PublisherHttp,
  pid: string
) {
  const P = `products/${seg(pid)}`;
  const start = async (
    path: string,
    b: Record<string, unknown>,
    opKey?: string
  ) => decodeStart(await aiHttp.send('POST', `${P}/${path}`, b, opKey));
  return {
    helperAnswer: (b: HelperAnswerIn, opKey?: string) =>
      start('helper/answer', b, opKey),
    briefDraft: (b: BriefDraftIn, opKey?: string) =>
      start('briefs/draft', b, opKey),
    qaReview: (vid: string, opKey?: string) =>
      start(`versions/${seg(vid)}/qa-checks/ai-review`, {}, opKey),
    adaptationDraft: (cid: string, b: AdaptationDraftIn, opKey?: string) =>
      start(`contents/${seg(cid)}/adaptations/draft`, b, opKey),
    questionsCluster: (questionIds: string[], opKey?: string) =>
      start('questions/cluster', { questionIds }, opKey),
    draftWrite: (cid: string, opKey?: string) =>
      start(`contents/${seg(cid)}/versions/draft`, {}, opKey),
    claimsExtract: (versionId: string, opKey?: string) =>
      start('claims/extract', { versionId }, opKey),
    call: async (callId: string) =>
      decodeCall(await aiHttp.get(`${P}/ai/calls/${seg(callId)}`)),
    calls: async (q: Query = {}): Promise<ListPage<AiCallListItem>> =>
      listPage(await http.get(`${P}/ai/calls`, q), decodeCallItem),
    task: async (id: string) =>
      decodeTask(await http.get(`${P}/ai/tasks/${seg(id)}`)),
    extra: async (id: string, reason: string, opKey?: string) =>
      decodeTask(
        await http.send(
          'POST',
          `${P}/ai/tasks/${seg(id)}/extra`,
          { reason },
          opKey
        )
      ),
    accept: async (taskId: string, callId: string, opKey?: string) =>
      decodeTask(
        await http.send(
          'POST',
          `${P}/ai/tasks/${seg(taskId)}/accept`,
          { callId },
          opKey
        )
      ),
    configs: async () =>
      itemsOf(await http.get(`${P}/ai/configs`), decodeConfig),
    configDecision: async (id: string, b: ConfigDecisionIn, opKey?: string) =>
      decodeConfig(
        await http.send('POST', `${P}/ai/configs/${seg(id)}/decision`, b, opKey)
      ),
    evalRuns: async () =>
      itemsOf(await http.get(`${P}/ai/eval-runs`), decodeEvalRun),
    evalRun: async (id: string) =>
      decodeProtocol(await http.get(`${P}/ai/eval-runs/${seg(id)}`)),
    protocolMd: (id: string) =>
      http.markdown(`${P}/ai/eval-runs/${seg(id)}/protocol`),
    resolveFlag: async (
      runId: string,
      rid: string,
      fid: string,
      b: { resolution: 'confirmed' | 'dismissed'; explanation: string },
      opKey?: string
    ) =>
      decodeEvalResult(
        await http.send(
          'POST',
          `${P}/ai/eval-runs/${seg(runId)}/results/${seg(rid)}/flags/${seg(fid)}`,
          b,
          opKey
        )
      ),
    reviewResult: async (
      runId: string,
      rid: string,
      b: {
        criticalPass: boolean;
        usefulnessPass: boolean;
        explanation: string;
      },
      opKey?: string
    ) =>
      decodeEvalResult(
        await http.send(
          'POST',
          `${P}/ai/eval-runs/${seg(runId)}/results/${seg(rid)}/review`,
          b,
          opKey
        )
      ),
    bindings: async () => {
      const o = obj(await http.get(`${P}/ai/bindings`), 'bindings');
      return {
        items: arr(o.items, decodeBinding),
        available: arr(o.available, decodeConfig),
      };
    },
    bind: async (configId: string, basis: string, opKey?: string) =>
      decodeBinding(
        await http.send('POST', `${P}/ai/bindings`, { configId, basis }, opKey)
      ),
    unbind: async (id: string, reason: string, opKey?: string) =>
      decodeBinding(
        await http.send(
          'POST',
          `${P}/ai/bindings/${seg(id)}/unbind`,
          { reason },
          opKey
        )
      ),
  };
}
export type PubAiApi = ReturnType<typeof createAiApi>;

/**
 * Опрос вызова до финального статуса (§11.1): каждые `intervalMs`, не
 * дольше `maxMs`; `onTick` — для индикатора. Возвращает последний вид
 * (может остаться `running` — экран честно скажет «ещё идёт»).
 */
/** Предел опроса AI-вызова по умолчанию (рекомендация P-B2). */
export const POLL_MAX_MS = 180_000;

export async function pollCall(
  api: Pick<PubAiApi, 'call'>,
  callId: string,
  opts: {
    intervalMs?: number;
    maxMs?: number;
    sleep?: (ms: number) => Promise<void>;
    cancelled?: () => boolean;
  } = {}
): Promise<AiCallView> {
  const interval = opts.intervalMs ?? 2000;
  // 202 приходит через ≤ 25 с, задание `ai-calls-run` берёт вызов в
  // ближайшую минуту и исполняет до 40 с — худший случай ≈ 100 с после 202
  // (P-B2 9.3): ждём до 180 с, дальше — «ещё выполняется» с повтором.
  const max = opts.maxMs ?? POLL_MAX_MS;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let waited = 0;
  let last = await api.call(callId);
  while (!isFinalCall(last.status) && waited < max && !opts.cancelled?.()) {
    await sleep(interval);
    waited += interval;
    last = await api.call(callId);
  }
  return last;
}
