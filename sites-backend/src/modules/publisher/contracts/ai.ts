/**
 * AI Publisher — интерфейс AI-шлюза (контракт P-A1, проектный документ
 * §12.1–12.2, §6.7; реализация — P-B2, `publisher/ai/ai-gateway.service.ts`).
 *
 * Принципы: AI предлагает, человек решает — шлюз не пишет в предметные
 * таблицы, у генераторов нет инструментов; флаг прогона набора 30 задач
 * (`evalRun`) — только у CLI (`ai/eval/run.ts`), HTTP его не получает.
 *
 * Только типы и константы (без Nest и базы).
 */
import type { AccountMembership } from '../../site-core/account/roles';
import type { ProductCtx } from './common';
import type { FieldIssue } from './errors';
import type { AiCallStatus, AiCostStatus } from './states';

/** Десять генераторов (= `pub_generators()` миграций; 10-й — P-R M2). */
export const GENERATOR_IDS = [
  'pub.helper.answer',
  'pub.brief.draft',
  'pub.qa.review',
  'pub.adaptation.make',
  'pub.questions.cluster',
  'pub.draft.write',
  'pub.claims.extract',
  'pub.distribution.plan',
  'pub.venues.compare',
  /** P-R M2 (§M2.3): черновики Reddit, 5 шаблонов, 2–3 варианта за вызов. */
  'pub.reddit.draft',
] as const;
export type GeneratorId = (typeof GENERATOR_IDS)[number];

/**
 * Допуск P0 (решение координатора по аудиту P1-4, ДТ-2, Р-PUB-31): рабочая
 * генерация — только четыре генератора схем, покрытых набором 30 задач, и
 * только совместно в одной оценённой конфигурации. Остальные пять
 * реализуются, но выключены (`disabled`, `PUB_AI_DISABLED`).
 */
export const P0_ENABLED_GENERATORS = [
  'pub.helper.answer',
  'pub.brief.draft',
  'pub.qa.review',
  'pub.adaptation.make',
] as const satisfies readonly GeneratorId[];

export function isEnabledInP0(g: GeneratorId): boolean {
  return (P0_ENABLED_GENERATORS as readonly string[]).includes(g);
}

/**
 * Версии набора задач (§6.7) и генераторы, которые каждая покрывает
 * (`coveredGenerators`, версии инструкций, параметры вызова — `configHash`).
 * P-R M2, Р-RD-64 (аудит M2 S2-5): набор P0 `2.2` (30 задач, четыре
 * генератора) — текущий набор допуска P0, его конфигурация и hash не
 * зависят от Reddit; набор `2.3` (+12 задач Reddit AI-31…AI-42 и
 * `pub.reddit.draft`) существует отдельно и применяется только явным
 * решением владельца — новой конфигурацией и привязкой с `evalSetVersion
 * = '2.3'` (CLI `--set=2.3`).
 */
export const EVAL_SET_VERSIONS = ['2.2', '2.3'] as const;
export type EvalSetVersion = (typeof EVAL_SET_VERSIONS)[number];

export const EVAL_SET_GENERATORS: Readonly<
  Record<EvalSetVersion, readonly GeneratorId[]>
> = {
  '2.2': P0_ENABLED_GENERATORS,
  '2.3': [...P0_ENABLED_GENERATORS, 'pub.reddit.draft'],
};

export function isEvalSetVersion(v: string): v is EvalSetVersion {
  return (EVAL_SET_VERSIONS as readonly string[]).includes(v);
}

/** Генераторы, покрытые хоть одним набором (режим eval шлюза, гейт `ai_use`). */
export const EVAL_COVERED_GENERATORS = EVAL_SET_GENERATORS['2.3'];

export function isEvalCovered(g: string): boolean {
  return (EVAL_COVERED_GENERATORS as readonly string[]).includes(g);
}

/** Операция `site-ai` генератора (`pub.brief.draft` → `pub-brief-draft`). */
export function aiOperationOf(g: GeneratorId): string {
  return g.replace(/\./g, '-');
}

/** Версия правил контекста P0 (§12.3). */
export const CONTEXT_RULES_VERSION = 'ctx@1';
/**
 * Версия набора задач текущей конфигурации P0 (§6.7): `2.2`, 30 задач.
 * Набор `2.3` (Reddit) — `EVAL_SET_GENERATORS`, только решением владельца.
 */
export const EVAL_SET_VERSION: EvalSetVersion = '2.2';
/** Набор с задачами Reddit (P-R M2). */
export const REDDIT_EVAL_SET_VERSION: EvalSetVersion = '2.3';

/** Строгая схема ответа (schema-lite, `core/schema-lite.ts`). */
export interface AiSchema<O> {
  validate(value: unknown, path?: string): FieldIssue[];
  readonly __type?: O;
}

/** Фрагмент источника в контексте (недоверенные данные, §12.3). */
export interface AiContextSource {
  id: string;
  title: string | null;
  fragment: string;
  visibility: 'public' | 'private';
  /** `detectInjection`: фрагмент похож на инструкцию (не удаляется). */
  injectionFlag: string | null;
}

export interface AiContext {
  rulesVersion: typeof CONTEXT_RULES_VERSION;
  audience: 'internal' | 'public';
  sources: AiContextSource[];
  /** Активные факты бренда (id, ключ, значение) и запрещённые обещания. */
  facts: Array<{
    id: string;
    factKey: string;
    kind: string;
    value: unknown;
    version: number;
  }>;
  offer: {
    id: string;
    version: number;
    title: string;
    text: string;
    priceNote: string | null;
  } | null;
}

export interface PostCheckFinding {
  code: string;
  severity: 'critical' | 'warning';
  text: string;
}

export interface GeneratorSpec<I, O> {
  id: GeneratorId;
  /** `pub.brief.draft@1` — версия текста инструкции (§12.4). */
  instructionVersion: string;
  contextRulesVersion: typeof CONTEXT_RULES_VERSION;
  schema: AiSchema<O>;
  buildPrompt(input: I, ctx: AiContext): { system: string; user: string };
  /** Числа против фактов, запрещённые обещания, `used_source_ids ⊆ ctx`. */
  postCheck?(out: O, ctx: AiContext): PostCheckFinding[];
  maxOutputTokens: number;
  /** P0: только четыре генератора (`P0_ENABLED_GENERATORS`). */
  enabledInP0: boolean;
}

export interface AiCallView {
  callId: string;
  generator: GeneratorId;
  status: AiCallStatus;
  taskId: string;
  attemptNo: number;
  output: unknown | null;
  findings: PostCheckFinding[];
  errorCode: string | null;
  costStatus: AiCostStatus;
  /** Стоимость в микродолларах строкой; null — неизвестна (не ноль). */
  costMicroUsd: string | null;
  requestedAt: string;
  finishedAt: string | null;
  /** id фактов бренда, попавших в контекст (§12.3) — экран предлагает связать. */
  contextFactIds: string[];
  contextSourceIds: string[];
}

export interface AiStartInput<I> {
  product: ProductCtx;
  member: AccountMembership;
  spec: GeneratorSpec<I, unknown>;
  opKey: string;
  objectType: string;
  objectId: string;
  input: I;
  sourceIds?: string[];
}

/**
 * Шлюз (§12.1): две короткие транзакции, вызов модели — между ними.
 * `await` получает продукт (сверх §12.1, Р-PUB-A1-7): вызов читается через
 * `SitesDb.forAccount`, без кабинета id вызова не разрешается.
 */
export interface AiGateway {
  start<I>(
    p: AiStartInput<I>,
  ): Promise<{ callId: string; status: AiCallStatus }>;
  await(
    product: ProductCtx,
    callId: string,
    maxWaitMs: number,
  ): Promise<AiCallView>;
}
