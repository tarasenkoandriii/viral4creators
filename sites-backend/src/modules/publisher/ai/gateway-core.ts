/**
 * AI Publisher — ядро AI-шлюза (P-B2, проектный документ §12.1, §11.1
 * «AI-операции асинхронны», §6.7, §7.5; аудит P2-11, P3-13).
 *
 * Порядок вызова:
 *  1. ТРАНЗАКЦИЯ 1 (`openCall`, короткая): вызов по `opKey` (повтор → тот
 *     же `callId`; то же `opKey` с другим запросом — 409); задача
 *     `pub_ai_tasks` (строка задачи блокируется `FOR UPDATE` — параллельные
 *     старты одной задачи сериализуются); генератор выключен в P0 →
 *     `disabled`; гейт `ai_use` → `not_evaluated|unpriced_blocked`; лимит
 *     `2 + extraAllowance` → `PUB_AI_LIMIT`; контекст (§12.3); оценка денег
 *     сверху и условный резерв месяца → `budget_blocked`; генерация
 *     засчитывается в момент создания вызова `running`. Блокирующие
 *     статусы пишутся сразу, без вызова модели (§7.5).
 *  2. ВНЕ транзакции (`runCall`): модель (`json`, `temperature 0.2`) →
 *     `AiUsageRecorder` (операция `pub-<генератор>`, продукт `publisher`)
 *     → JSON → схема + «id только из переданных» (`sourceIdsOutside`,
 *     `inputIssues`) → при ошибке схемы ОДНА повторная попытка (вторая
 *     генерация задачи) с текстом ошибки; вторая неудача — задача
 *     `needs_human` → `postCheck`.
 *  3. ТРАНЗАКЦИЯ 2: итог вызова (токены, `costMicroUsd` или `NULL` +
 *     `costStatus`, `output`, `finishedAt`) — только если вызов всё ещё
 *     `running` (его мог закрыть `ai-calls-reap`); замена резерва фактом.
 *
 * Результат AI в предметные таблицы НЕ пишется: маршрут возвращает
 * предложение, человек создаёт запись отдельной мутацией со ссылкой
 * `aiCallId` (§12.1). Инструментов у генераторов нет.
 *
 * Режим набора 30 задач (`evalRun`) создаёт только `CliEvalGateway`
 * (`ai/eval/cli-gateway.ts`, CLI `run.ts`): HTTP-шлюз (`AiGatewayService`)
 * всегда работает в режиме кабинета — тест на отсутствие маршрута.
 */
import { createHash, randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { estimateCost, rateFor } from '../../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../../shared/gemini-model';
import { geminiOutputCeiling } from '../../site-ai/gemini-output';
import {
  publisherAiUnevaluatedAllowed,
  publisherStandFakeAi,
} from '../../../config/publisher-env';
import {
  TextModelError,
  spentOf,
  type GenerateRequest,
  type GenerateResult,
  type TextModelSpent,
} from '../../site-ai/text-model';
import type { AiUsageRecorder, UsageDb } from '../../site-ai/usage-recorder';
import type { SiteAiOperation } from '../../site-ai/operations';
import {
  aiOperationOf,
  isEvalCovered,
  isEvalSetVersion,
  type AiContext,
  type GeneratorId,
  type PostCheckFinding,
} from '../contracts/ai';
import { sourceIdsOutside } from '../contracts/ai-schemas';
import {
  isAdminActor,
  type GateMissing,
  type ProductCtx,
} from '../contracts/common';
import type { FieldIssue } from '../contracts/errors';
import type { AiCallStatus, AiCostStatus } from '../contracts/states';
import { canonicalJson, sha256Hex } from '../core/content-hash';
import { PubError, isPubError, validationError } from '../core/errors';
import { kyivMonthOf } from '../core/kyiv-time';
import { looksLikeContact } from '../core/pii-guard';
import type { AuditPort, GatePort, ProductRef, PubTx } from '../core/ports';
import {
  MAX_PROMPT_CHARS,
  estimateCallMicroUsd,
  reserveAiMonth,
  settleAiMonth,
} from './ai-budget';
import { buildContext, type ContextRequest } from './context';
import {
  AI_TEMPERATURE,
  SCHEMA_SET_VERSION,
  configHashOf,
  currentConfigSpec,
} from './config';
import { memberAccessIn } from '../core/product-access.service';
import { can, deniedForKind, type PubAccess } from '../core/roles';
import { ADMIN_GENERATORS, adminRedditAccess } from '../core/admin-actor';
import { publisherPlatformSiteId } from '../../../config/publisher-env';
import { maskContacts, maskDeep } from './pii-mask';
import { GENERATORS } from './generators';
import type { PubGeneratorSpec } from './generators/spec';

export const AI_PROVIDER = 'gemini';
/**
 * Полный таймаут модели (задание очереди и CLI): запас до бюджета прохода
 * крона 45 с и `maxDuration` 60 с.
 */
export const MODEL_TIMEOUT_MS = 40_000;
/**
 * Аренда исполнения вызова (аудит S2-1): маршрут исполняет синхронно не
 * дольше 25 с, иначе прерывает модель и оставляет `running`; задание
 * `ai-calls-run` берёт вызов, `updatedAt` которого старше аренды.
 */
export const LEASE_MS = 60_000;
/** Допуск на часы: таймаут не раньше окна минус это — «прервали мы». */
const HANDOFF_SLACK_MS = 50;
/** Маршрут держит запрос до готовности не дольше 25 с (§11.1). */
export const ROUTE_WAIT_MS = 25_000;
/** `running` старше — `timeout` заданием `ai-calls-reap` (§11.1, §15.1). */
export const REAP_AFTER_MS = 10 * 60_000;
/** Генераций на задачу без решения редактора (§6.7, §12.5). */
export const BASE_GENERATIONS = 2;

/** Модель текста (GeminiText или фейк набора). */
export interface AiTextModel {
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/**
 * Режим вызова. `cabinet` — HTTP (гейт `ai_use`, месячный потолок, повтор
 * при ошибке схемы, учёт расходов). `evalRun` — ТОЛЬКО CLI набора 30 задач:
 * гейт и потолок месяца не применяются (продукт `kind=eval`, потолок
 * прогона — `--max-usd`), повтора нет (оценивается ПЕРВЫЙ ответ, AI-eval
 * «повтор не скрывает исходную ошибку»).
 */
export type CallMode =
  | { kind: 'cabinet' }
  | {
      kind: 'eval';
      evalRun: true;
      configId: string;
      provider: string;
      model: string;
      /** Фейк CI: денег нет (`priced`, 0), учёт в `site_ai_usage` не пишется. */
      fake: boolean;
    };

export interface OpenRequest {
  product: ProductCtx;
  /** `member:<id>` или `system:eval`. */
  actor: string;
  spec: PubGeneratorSpec<unknown, unknown>;
  opKey: string;
  objectType: string;
  objectId: string;
  input: unknown;
  context: ContextRequest;
  mode: CallMode;
  now: Date;
}

/**
 * Конверт исполнения: пока вызов `running`, в `output` лежит вход
 * генератора (с маской контактов), режим и снимок источников — задание
 * очереди восстанавливает по нему промпт (аудит S2-1). Финализация
 * заменяет конверт ответом (или `null`).
 */
export interface PendingEnvelope {
  pending: {
    v: 1;
    input: unknown;
    audience: 'internal' | 'public';
    sourceIds: string[];
    /** Повторная попытка при ошибке схемы: текст ошибки модели. */
    note?: string;
    /**
     * Прерванных синхронных попыток (окно маршрута вышло): их расход
     * провайдеру неизвестен — резерв месяца за них не снимается (S1-4).
     */
    aborted?: number;
  };
}

export function isPendingEnvelope(v: unknown): v is PendingEnvelope {
  return (
    !!v &&
    typeof v === 'object' &&
    !!(v as { pending?: unknown }).pending &&
    typeof (v as { pending: { v?: unknown } }).pending === 'object' &&
    (v as { pending: { v?: unknown } }).pending.v === 1
  );
}

/** Всё, что нужно для вызова модели вне транзакции. */
export interface ExecPlan {
  callId: string;
  product: ProductRef & { siteId: string };
  generator: GeneratorId;
  spec: PubGeneratorSpec<unknown, unknown>;
  input: unknown;
  ctx: AiContext;
  prompt: { system: string; user: string };
  provider: string;
  model: string;
  priced: boolean;
  est: bigint;
  month: string;
  taskId: string;
  attemptNo: number;
  opKey: string;
  actor: string;
  purpose: string;
  sourceIds: string[];
  factIds: string[];
  configId: string | null;
  mode: CallMode;
  /** Замен контактов в промпте (журнал вызова). */
  masked: number;
  /** Текст ошибки схемы прошлой попытки (повтор). */
  note?: string;
  /** Прерванных синхронных попыток этого вызова (конверт `aborted`). */
  aborted?: number;
}

export interface OpenResult {
  callId: string;
  status: AiCallStatus;
  taskId: string;
  /** Есть только у `running` (новый вызов) — запускать модель. */
  plan?: ExecPlan;
  /** Недостающее гейта `ai_use` (`not_evaluated`/`unpriced_blocked`). */
  missing?: GateMissing[];
  replayed: boolean;
}

/** id строк AI-слоя (как cuid: `[A-Za-z0-9_-]`, ≤ 64). */
export function aiRowId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/**
 * Производный UUID v4 от `opKey` (повторная попытка при ошибке схемы):
 * детерминирован — повтор финализации не создаёт второй попытки.
 */
export function derivedOpKey(opKey: string, salt: string): string {
  const h = createHash('sha256').update(`${opKey}:${salt}`).digest('hex');
  const v = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Назначение вызова: объект + короткий hash запроса — тот же `opKey` с
 * другим запросом (входом, источниками, режимом) — 409 (§1 п.4).
 */
export function purposeOf(
  objectType: string,
  objectId: string,
  input: unknown,
  context: ContextRequest,
): string {
  const h = sha256Hex(
    canonicalJson({
      input: input ?? null,
      audience: context.audience,
      sourceIds: context.sourceIds ? [...context.sourceIds].sort() : null,
    }),
  ).slice(0, 16);
  return `${objectType}:${objectId}#${h}`;
}

function blockedCost(): { costStatus: AiCostStatus; costMicroUsd: bigint } {
  // Модель не вызывалась — денег нет (известный ноль, не «неизвестно»).
  return { costStatus: 'priced', costMicroUsd: 0n };
}

async function lockTask(
  tx: PubTx,
  product: ProductRef,
  generator: GeneratorId,
  objectType: string,
  objectId: string,
  actor: string,
): Promise<{
  id: string;
  generationsUsed: number;
  extraAllowance: number;
  status: string;
}> {
  await tx.$executeRaw`
    INSERT INTO "sites"."pub_ai_tasks"
      ("id", "accountId", "productId", "generator", "objectType", "objectId", "createdBy")
    VALUES (${aiRowId('ait')}, ${product.accountId}, ${product.id}, ${generator},
            ${objectType}, ${objectId}, ${actor})
    ON CONFLICT ("productId", "generator", "objectType", "objectId") DO NOTHING`;
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      generationsUsed: number;
      extraAllowance: number;
      status: string;
    }>
  >`
    SELECT "id", "generationsUsed", "extraAllowance", "status"
      FROM "sites"."pub_ai_tasks"
     WHERE "productId" = ${product.id} AND "accountId" = ${product.accountId}
       AND "generator" = ${generator} AND "objectType" = ${objectType}
       AND "objectId" = ${objectId}
       FOR UPDATE`;
  if (!rows[0]) throw new PubError('PUB_BUSY');
  return rows[0];
}

async function nextAttempt(tx: PubTx, taskId: string): Promise<number> {
  const last = await tx.pubAiCall.findFirst({
    where: { taskId },
    orderBy: { attemptNo: 'desc' },
    select: { attemptNo: true },
  });
  return (last?.attemptNo ?? 0) + 1;
}

interface CallRowInput {
  id: string;
  product: ProductRef;
  taskId: string;
  attemptNo: number;
  generator: GeneratorId;
  purpose: string;
  configId: string | null;
  instructionVersion: string;
  contextRulesVersion: string;
  sourceIds: string[];
  provider: string;
  model: string;
  opKey: string;
  actor: string;
  status: AiCallStatus;
  now: Date;
  errorCode?: string | null;
  envelope?: PendingEnvelope;
}

async function insertCall(tx: PubTx, r: CallRowInput): Promise<void> {
  const running = r.status === 'running';
  const cost = running
    ? { costStatus: 'unknown' as const, costMicroUsd: null }
    : blockedCost();
  await tx.pubAiCall.create({
    data: {
      id: r.id,
      accountId: r.product.accountId,
      productId: r.product.id,
      taskId: r.taskId,
      attemptNo: r.attemptNo,
      generator: r.generator,
      purpose: r.purpose,
      configId: r.configId,
      instructionVersion: r.instructionVersion,
      contextRulesVersion: r.contextRulesVersion,
      sourceIds: r.sourceIds,
      provider: r.provider,
      model: r.model,
      opKey: r.opKey,
      requestedAt: r.now,
      finishedAt: running ? null : r.now,
      status: r.status,
      costStatus: cost.costStatus,
      costMicroUsd: cost.costMicroUsd,
      output: running && r.envelope ? (r.envelope as object) : undefined,
      errorCode: r.errorCode ?? null,
      requestedBy: r.actor,
      createdBy: r.actor,
    },
  });
}

/** Активная привязка рабочего продукта к конфигурации (§6.7). */
async function boundConfig(
  tx: PubTx,
  productId: string,
): Promise<{
  id: string;
  model: string;
  provider: string;
  configHash: string;
  evalSetVersion: string;
} | null> {
  const b = await tx.pubAiConfigBinding.findFirst({
    where: { productId, unboundAt: null },
    select: { configId: true },
  });
  if (!b) return null;
  // Конфигурация — eval-продукта того же кабинета (составной FK привязки).
  const c = await tx.pubAiConfig.findFirst({
    where: { id: b.configId },
    select: {
      id: true,
      model: true,
      provider: true,
      configHash: true,
      evalSetVersion: true,
    },
  });
  return c ?? null;
}

/**
 * Гейт `ai_use` (§10) через `GatePort` (ядро; `core/gates*` AI-слою
 * импортировать нельзя — правило графа `publisher-ai-no-authority`).
 * `PUBLISHER_AI_ALLOW_UNEVALUATED` (только вне production, Р-PUB-16)
 * снимает пункты «нет оценённой конфигурации», но не «генератор вне
 * набора» и не параметры.
 */
async function aiGateMissing(
  tx: PubTx,
  gates: GatePort,
  product: ProductRef,
  now: Date,
  bound: {
    provider: string;
    model: string;
    configHash: string;
    evalSetVersion: string;
  } | null,
  ai: {
    generator: string;
    model: string;
    instructionVersion: string;
    priced: boolean;
    provider: string;
    contextRulesVersion: string;
    schemaSetVersion: string;
  },
): Promise<GateMissing[]> {
  let missing: GateMissing[] = [];
  try {
    await gates.assertOpen(tx, product, 'ai_use', now, { ai });
  } catch (e) {
    if (!isPubError(e, 'PUB_GATE_CLOSED')) throw e;
    missing = (e.details.missing as GateMissing[] | undefined) ?? [];
  }
  // Предаудит D2-04: hash привязанной конфигурации ≡ hash текущего кода для
  // её провайдера и модели (инструкции, правила, схемы И параметры вызова).
  // P-R M2 (Р-RD-64): hash кода — для версии набора привязанной
  // конфигурации (2.2 — P0; 2.3 — с Reddit, только решением владельца).
  if (
    bound &&
    (!isEvalSetVersion(bound.evalSetVersion) ||
      bound.configHash !==
        configHashOf(
          currentConfigSpec(bound.provider, bound.model, bound.evalSetVersion),
        ))
  ) {
    missing.push({ kind: 'ai_config', key: 'config_hash', detail: 'mismatch' });
  }
  if (publisherAiUnevaluatedAllowed()) {
    missing = missing.filter(
      (m) => m.kind !== 'ai_config' || m.detail === 'not_covered_by_eval_set',
    );
  }
  return missing;
}

function onlyUnpriced(missing: GateMissing[]): boolean {
  return (
    missing.length > 0 &&
    missing.every(
      (m) => m.key === 'ai_unpriced_allowed' && m.detail === 'unpriced_model',
    )
  );
}

/**
 * Точные токены без маски (предаудит D2-02): id источников, фактов и
 * оффера контекста (их повторяют `used_source_ids`) и метка версии
 * адаптации (`slug@vN` — её строит маршрут). Всё прочее — по правилу P-A1.
 */
export function maskKeep(input: unknown, ctx?: AiContext | null): Set<string> {
  const keep = new Set<string>();
  if (ctx) {
    for (const x of ctx.sources) keep.add(x.id);
    for (const f of ctx.facts) keep.add(f.id);
    if (ctx.offer) keep.add(ctx.offer.id);
  }
  const pv = (input as { parentVersion?: unknown } | null)?.parentVersion;
  if (typeof pv === 'string' && pv) keep.add(pv);
  return keep;
}

/**
 * Промпт генератора с маской контактов (аудит S1-3, ТЗ: «в AI контакты не
 * передаются»): ДАННЫЕ — вход генератора (вопрос, тело версии, запрос) и
 * контекст (заголовки и фрагменты источников, факты, оффер) — проходят
 * `maskDeep` (правило P-A1 `PII_RULE`) до сборки промпта; разметка и
 * инструкция — текст кода, их не трогаем (`rules="ctx@1"` — не email).
 * Проверки ответа (id, числа контекста) идут по исходному контексту.
 */
export function preparePrompt(
  spec: PubGeneratorSpec<unknown, unknown>,
  input: unknown,
  ctx: AiContext,
  note?: string,
): { prompt: { system: string; user: string }; masked: number } {
  const opts = { keep: maskKeep(input, ctx) };
  const mi = maskDeep(input, opts);
  const ms = maskDeep(
    ctx.sources.map((x) => ({ title: x.title, fragment: x.fragment })),
    opts,
  );
  const mf = maskDeep(
    ctx.facts.map((f) => f.value),
    opts,
  );
  const mo = maskDeep(
    ctx.offer
      ? {
          title: ctx.offer.title,
          text: ctx.offer.text,
          priceNote: ctx.offer.priceNote,
        }
      : null,
    opts,
  );
  const safeCtx: AiContext = {
    ...ctx,
    sources: ctx.sources.map((x, i) => ({ ...x, ...ms.value[i] })),
    facts: ctx.facts.map((f, i) => ({ ...f, value: mf.value[i] })),
    offer: ctx.offer && mo.value ? { ...ctx.offer, ...mo.value } : ctx.offer,
  };
  const raw = spec.buildPrompt(mi.value, safeCtx);
  const prompt = {
    system: raw.system,
    user: note ? `${raw.user}\n\n${note}` : raw.user,
  };
  if (prompt.system.length + prompt.user.length > MAX_PROMPT_CHARS) {
    throw validationError([{ field: 'input', code: 'context_too_large' }]);
  }
  return {
    prompt,
    masked: mi.masked + ms.masked + mf.masked + mo.masked,
  };
}

/** Повтор `opKey`: тот же вызов или 409, если запрос другой (§1 п.4). */
export async function existingByOpKey(
  tx: PubTx,
  productId: string,
  opKey: string,
  check: { generator: string; purpose: string; actor: string },
): Promise<OpenResult | null> {
  const existing = await tx.pubAiCall.findFirst({
    where: { productId, opKey },
    select: {
      id: true,
      status: true,
      taskId: true,
      generator: true,
      purpose: true,
      requestedBy: true,
    },
  });
  if (!existing) return null;
  if (
    existing.generator !== check.generator ||
    existing.purpose !== check.purpose ||
    existing.requestedBy !== check.actor
  ) {
    throw new PubError('PUB_IDEMPOTENCY_REUSED');
  }
  return {
    callId: existing.id,
    status: existing.status as AiCallStatus,
    taskId: existing.taskId,
    replayed: true,
  };
}

/**
 * Транзакция 1. Ошибки входа (контекст, лимит, `opKey`) — исключение без
 * записи; блокирующие статусы — строка вызова и результат без `plan`.
 */
export async function openCall(
  tx: PubTx,
  req: OpenRequest,
  deps: { gates: GatePort; audit: AuditPort },
): Promise<OpenResult> {
  const { product, spec, mode } = req;
  const ref: ProductRef = { id: product.id, accountId: product.accountId };
  const generator = spec.id;
  if (GENERATORS[generator]?.instructionVersion !== spec.instructionVersion) {
    throw new Error(`openCall: генератор ${generator} не из реестра`);
  }
  const purpose = purposeOf(
    req.objectType,
    req.objectId,
    req.input,
    req.context,
  );
  const check = { generator, purpose, actor: req.actor };
  const before = await existingByOpKey(tx, product.id, req.opKey, check);
  if (before) return before;
  const task = await lockTask(
    tx,
    ref,
    generator,
    req.objectType,
    req.objectId,
    req.actor,
  );
  // Аудит S2-6: параллельный повтор `opKey` ждал строку задачи — первый
  // запрос уже записал вызов: вернуть его, а не упасть на уникальности.
  const raced = await existingByOpKey(tx, product.id, req.opKey, check);
  if (raced) return raced;
  const attemptNo = await nextAttempt(tx, task.id);
  const callId = aiRowId('aic');
  const bound =
    mode.kind === 'cabinet' ? await boundConfig(tx, product.id) : null;
  const model = mode.kind === 'eval' ? mode.model : GEMINI_MODEL;
  // Cabinet follows the project model. Immutable evaluations remain attached
  // to their original model: the existing model-mismatch gate rejects an old
  // binding until the selected model has its own approved evaluation.
  // Провайдер — тот, кого шлюз кабинета вызывает на самом деле (Gemini), а
  // не строка конфигурации: расхождение закрывает гейт (аудит S2-5).
  const provider = mode.kind === 'eval' ? mode.provider : AI_PROVIDER;
  const configId = mode.kind === 'eval' ? mode.configId : (bound?.id ?? null);
  const fake = mode.kind === 'eval' && mode.fake;
  const estimate = fake
    ? { priced: true, estMicroUsd: 0n }
    : estimateCallMicroUsd(model, spec.maxOutputTokens);
  const base: Omit<CallRowInput, 'status'> = {
    id: callId,
    product: ref,
    taskId: task.id,
    attemptNo,
    generator,
    purpose,
    configId,
    instructionVersion: spec.instructionVersion,
    contextRulesVersion: spec.contextRulesVersion,
    sourceIds: [],
    provider,
    model,
    opKey: req.opKey,
    actor: req.actor,
    now: req.now,
  };
  const blocked = async (
    status: AiCallStatus,
    errorCode: string,
    missing?: GateMissing[],
  ): Promise<OpenResult> => {
    await insertCall(tx, { ...base, status, errorCode });
    await deps.audit.write(tx, {
      accountId: product.accountId,
      productId: product.id,
      actor: req.actor,
      objectType: 'ai_call',
      objectId: callId,
      action: 'create',
      toStatus: status,
      meta: { generator, taskId: task.id, errorCode },
    });
    return { callId, status, taskId: task.id, missing, replayed: false };
  };

  // Выключенный генератор (ДТ-2, Р-PUB-31): ручной путь, модель не зовём.
  // Исключение — прогон набора задач (CLI) для генератора, который набор
  // покрывает, но который ещё не включён (P-R M2, Р-RD-17): его допуск и
  // проверяет этот прогон (`pub.reddit.draft`, набор 2.3).
  // Стенд E2E (Р-RD-73): fake-провайдер AI включает `pub.reddit.draft`
  // (только стенд — правило Р-PUB-Z2-21, иначе флаг игнорируется).
  if (
    !spec.enabledInP0 &&
    !(mode.kind === 'eval' && isEvalCovered(generator)) &&
    !(generator === 'pub.reddit.draft' && publisherStandFakeAi().enabled)
  )
    return blocked('disabled', 'PUB_AI_DISABLED');

  // Аудит S3-5: генерация — только по открытой задаче (принятая `done` и
  // `needs_human` без решения редактора — нет).
  if (task.status !== 'open') {
    throw new PubError('PUB_TRANSITION_INVALID', {
      machine: 'ai_task',
      from: task.status,
      to: 'generate',
      allowed: [],
      taskId: task.id,
    });
  }

  if (mode.kind === 'cabinet') {
    const missing = await aiGateMissing(tx, deps.gates, ref, req.now, bound, {
      generator,
      model,
      instructionVersion: spec.instructionVersion,
      priced: estimate.priced,
      provider,
      contextRulesVersion: spec.contextRulesVersion,
      schemaSetVersion: SCHEMA_SET_VERSION,
    });
    if (missing.length) {
      return onlyUnpriced(missing)
        ? blocked('unpriced_blocked', 'PUB_AI_UNPRICED', missing)
        : blocked('not_evaluated', 'PUB_AI_NOT_EVALUATED', missing);
    }
  }

  if (task.generationsUsed >= BASE_GENERATIONS + task.extraAllowance) {
    throw new PubError('PUB_AI_LIMIT', {
      taskId: task.id,
      generationsUsed: task.generationsUsed,
      extraAllowance: task.extraAllowance,
    });
  }

  const built = await buildContext(tx, product.id, req.context);
  const { prompt, masked } = preparePrompt(spec, req.input, built.ctx);

  const month = kyivMonthOf(req.now);
  if (mode.kind === 'cabinet') {
    const r = await reserveAiMonth(tx, ref, month, estimate.estMicroUsd);
    if (!r.ok) return blocked('budget_blocked', `PUB_AI_BUDGET:${r.reason}`);
  }

  await tx.pubAiTask.updateMany({
    where: { id: task.id },
    data: { generationsUsed: { increment: 1 }, revision: { increment: 1 } },
  });
  await insertCall(tx, {
    ...base,
    sourceIds: built.sourceIds,
    status: 'running',
    envelope: {
      pending: {
        v: 1,
        input: maskDeep(req.input, { keep: maskKeep(req.input, built.ctx) })
          .value,
        audience: req.context.audience,
        sourceIds: built.sourceIds,
      },
    },
  });
  await deps.audit.write(tx, {
    accountId: product.accountId,
    productId: product.id,
    actor: req.actor,
    objectType: 'ai_call',
    objectId: callId,
    action: 'create',
    toStatus: 'running',
    meta: {
      generator,
      taskId: task.id,
      attemptNo,
      factIds: built.factIds,
      sourceCount: built.sourceIds.length,
      piiMasked: masked,
      // Предаудит D2-04: параметры вызова — в журнал вызова.
      params: {
        temperature: AI_TEMPERATURE,
        maxOutputTokens: spec.maxOutputTokens,
        thinkingHeadroom:
          geminiOutputCeiling(spec.maxOutputTokens) - spec.maxOutputTokens,
        thinkingBudget: 'provider_default',
      },
    },
  });
  return {
    callId,
    status: 'running',
    taskId: task.id,
    replayed: false,
    plan: {
      callId,
      product: {
        id: product.id,
        accountId: product.accountId,
        siteId: product.siteId,
      },
      generator,
      spec,
      input: req.input,
      ctx: built.ctx,
      prompt,
      provider,
      model,
      priced: estimate.priced,
      est: estimate.estMicroUsd,
      month,
      taskId: task.id,
      attemptNo,
      opKey: req.opKey,
      actor: req.actor,
      purpose,
      sourceIds: built.sourceIds,
      factIds: built.factIds,
      configId,
      mode,
      masked,
    },
  };
}

/** Разбор ответа модели: JSON → схема → id только из переданных. */
export function validateOutput(
  spec: PubGeneratorSpec<unknown, unknown>,
  text: string,
  ctx: AiContext,
  input: unknown,
): { parsed: unknown; ok: boolean; issues: FieldIssue[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      parsed: undefined,
      ok: false,
      issues: [{ field: '$', code: 'json' }],
    };
  }
  const issues = spec.schema.validate(parsed);
  if (issues.length === 0) {
    const outside = sourceIdsOutside(
      parsed,
      ctx.sources.map((s) => s.id),
    );
    if (outside.length) {
      issues.push({ field: 'used_source_ids', code: 'outside_context' });
    }
    if (spec.inputIssues) issues.push(...spec.inputIssues(parsed, input));
  }
  return { parsed, ok: issues.length === 0, issues };
}

export interface AttemptOutcome {
  callId: string;
  status: AiCallStatus;
  rawText: string | null;
  parsed: unknown;
  output: unknown | null;
  issues: FieldIssue[];
  findings: PostCheckFinding[];
  costStatus: AiCostStatus;
  costMicroUsd: bigint | null;
  spent: TextModelSpent | null;
}

export interface RunDeps {
  model: AiTextModel;
  usage: AiUsageRecorder;
  /** Клиент кабинета для `site_ai_usage` (SitesDb.forAccount). */
  usageDb: (accountId: string) => UsageDb;
  /** Короткая транзакция кабинета (вторая транзакция шлюза). */
  transaction: <T>(
    accountId: string,
    fn: (tx: PubTx) => Promise<T>,
  ) => Promise<T>;
  audit: AuditPort;
}

function costOf(
  plan: ExecPlan,
  spent: TextModelSpent | null,
  recorded: { costMicroUsd: number; unpriced: boolean } | null,
): { costStatus: AiCostStatus; costMicroUsd: bigint | null } {
  if (plan.mode.kind === 'eval' && plan.mode.fake) {
    return { costStatus: 'priced', costMicroUsd: 0n };
  }
  if (!spent) return { costStatus: 'unknown', costMicroUsd: null };
  if (recorded) {
    return recorded.unpriced
      ? { costStatus: 'unpriced', costMicroUsd: null }
      : { costStatus: 'priced', costMicroUsd: BigInt(recorded.costMicroUsd) };
  }
  if (!rateFor(spent.model))
    return { costStatus: 'unpriced', costMicroUsd: null };
  return {
    costStatus: 'priced',
    costMicroUsd: BigInt(
      estimateCost(spent.model, {
        inputTokens: spent.inputTokens,
        cachedInputTokens: spent.cachedInputTokens,
        outputTokens: spent.outputTokens,
      }).costMicroUsd,
    ),
  };
}

const SCHEMA_RETRY_NOTE =
  'Попередня відповідь не пройшла перевірку схеми. Поверни ОДИН JSON-об’єкт строго за схемою; посилайся лише на id з контексту.';

/** Одна попытка: модель → учёт → разбор (без записи итога). */
async function attempt(
  plan: ExecPlan,
  deps: RunDeps,
  timeoutMs: number = MODEL_TIMEOUT_MS,
): Promise<AttemptOutcome> {
  let result: GenerateResult | null = null;
  let status: AiCallStatus = 'running';
  let spent: TextModelSpent | null = null;
  const t0 = Date.now();
  try {
    result = await deps.model.generate({
      system: plan.prompt.system,
      user: plan.prompt.user,
      json: true,
      temperature: AI_TEMPERATURE,
      maxOutputTokens: plan.spec.maxOutputTokens,
      timeoutMs,
      model: plan.model,
    });
    spent = {
      model: result.model,
      inputTokens: result.inputTokens,
      cachedInputTokens: result.cachedInputTokens,
      outputTokens: result.outputTokens,
    };
  } catch (e) {
    spent = spentOf(e);
    status = e instanceof TextModelError ? e.kind : 'unavailable';
    // Синхронный путь исчерпал СВОЁ окно (прервали мы, а не провайдер) —
    // не итог, а передача очереди: вызов остаётся `running`, задание
    // `ai-calls-run` повторит. Таймаут провайдера раньше окна — итог.
    if (
      status === 'timeout' &&
      !spent &&
      timeoutMs < MODEL_TIMEOUT_MS &&
      Date.now() - t0 >= timeoutMs - HANDOFF_SLACK_MS
    ) {
      status = 'running';
    }
  }
  let recorded: { costMicroUsd: number; unpriced: boolean } | null = null;
  const fake = plan.mode.kind === 'eval' && plan.mode.fake;
  if (spent && !fake) {
    const operation: SiteAiOperation =
      plan.mode.kind === 'eval'
        ? 'pub-eval'
        : (aiOperationOf(plan.generator) as SiteAiOperation);
    try {
      recorded = await deps.usage.record(deps.usageDb(plan.product.accountId), {
        accountId: plan.product.accountId,
        siteId: plan.product.siteId,
        operation,
        model: spent.model,
        units: {
          inputTokens: spent.inputTokens,
          cachedInputTokens: spent.cachedInputTokens,
          outputTokens: spent.outputTokens,
        },
      });
    } catch {
      recorded = null; // учёт не должен уронить вызов; стоимость — по прайсу ниже
    }
  }
  const cost = costOf(plan, spent, recorded);
  if (!result) {
    return {
      callId: plan.callId,
      status,
      rawText: null,
      parsed: undefined,
      output: null,
      issues: [],
      findings: [],
      ...cost,
      spent,
    };
  }
  const v = validateOutput(plan.spec, result.text, plan.ctx, plan.input);
  return {
    callId: plan.callId,
    status: v.ok ? 'ok' : 'schema_invalid',
    rawText: result.text,
    parsed: v.parsed,
    output: v.ok ? v.parsed : null,
    issues: v.issues,
    findings: v.ok
      ? [
          ...(plan.spec.postCheck?.(v.parsed, plan.ctx) ?? []),
          ...(plan.spec.inputFindings?.(v.parsed, plan.input, plan.ctx) ?? []),
        ]
      : [],
    ...cost,
    spent,
  };
}

/**
 * Поздний факт (аудит S1-4): вызов уже закрыт заданием `ai-calls-reap`
 * (`timeout`, стоимость `unknown`, резерв держится), а модель ответила и
 * расход записан в `site_ai_usage` — дописать токены и стоимость в вызов
 * и заменить резерв месяца фактом.
 */
async function lateFact(
  tx: PubTx,
  plan: ExecPlan,
  o: AttemptOutcome,
): Promise<void> {
  if (!o.spent || o.costStatus === 'unknown') return;
  const res = await tx.pubAiCall.updateMany({
    where: {
      id: plan.callId,
      status: 'timeout',
      errorCode: 'reaped',
      costStatus: 'unknown',
    },
    data: {
      inputTokens: o.spent.inputTokens,
      cachedInputTokens: o.spent.cachedInputTokens,
      outputTokens: o.spent.outputTokens,
      costStatus: o.costStatus,
      costMicroUsd: o.costMicroUsd,
      errorCode: 'reaped:late_cost',
    },
  });
  if (res.count === 1 && plan.mode.kind === 'cabinet') {
    await settleAiMonth(
      tx,
      plan.product,
      plan.month,
      plan.aborted ? 0n : plan.est,
      o.costStatus === 'priced' ? (o.costMicroUsd ?? 0n) : null,
      o.costStatus !== 'priced',
    );
  }
}

/**
 * Передача очереди (аудит S2-1): окно синхронного пути вышло, модель
 * прервана. Вызов остаётся `running`; в конверте — счётчик прерванных
 * попыток (их расход неизвестен — резерв за них держится); аренда снята
 * (`updatedAt` старше `LEASE_MS`) — ближайший проход `ai-calls-run` берёт
 * вызов. Процесс, упавший посреди модели, аренду не снимает: задание
 * возьмёт вызов не раньше чем через `LEASE_MS` от последней отметки.
 */
async function markHandoff(tx: PubTx, plan: ExecPlan): Promise<void> {
  await tx.$executeRaw`
    UPDATE "sites"."pub_ai_calls"
       SET "output" = jsonb_set("output", '{pending,aborted}',
             to_jsonb(COALESCE(("output" #>> '{pending,aborted}')::int, 0) + 1)),
           "updatedAt" = ${new Date(Date.now() - LEASE_MS - 1_000)}
     WHERE "id" = ${plan.callId} AND "accountId" = ${plan.product.accountId}
       AND "status" = 'running' AND "output" ? 'pending'`;
}

/**
 * Находка для журнала: код и важность; у «чисел вне контекста» — сами
 * числа (предаудит D2-05), но только короткие (≤ 6 цифр) и не похожие на
 * контакт: длинное число в журнале — риск телефона (правило P-A1), оно
 * считается в `more`.
 */
export function findingMeta(f: PostCheckFinding): {
  code: string;
  severity: 'critical' | 'warning';
  values?: string[];
  more?: number;
} {
  const values = (f as { values?: unknown }).values;
  if (!Array.isArray(values)) return { code: f.code, severity: f.severity };
  const safe = values.filter(
    (v): v is string =>
      typeof v === 'string' && /^\d{1,6}$/.test(v) && !looksLikeContact(v),
  );
  return {
    code: f.code,
    severity: f.severity,
    values: safe,
    ...(values.length > safe.length
      ? { more: values.length - safe.length }
      : {}),
  };
}

/** Итог попытки в журнал (транзакция 2); false — вызов уже закрыт (reap). */
async function finalize(
  tx: PubTx,
  plan: ExecPlan,
  o: AttemptOutcome,
  deps: RunDeps,
): Promise<boolean> {
  const now = new Date();
  // Аудит S1-3: в журнал — ответ с маской контактов (модель могла повторить
  // контакт из источника; проверки схемы и находки — по сырому ответу).
  const keep = { keep: maskKeep(plan.input, plan.ctx) };
  const output = o.status === 'ok' ? maskDeep(o.output, keep).value : null;
  const raw =
    o.status === 'schema_invalid' && o.rawText !== null
      ? maskContacts(o.rawText.slice(0, 4000), keep).text.slice(0, 4000)
      : null;
  const res = await tx.pubAiCall.updateMany({
    where: { id: plan.callId, status: 'running' },
    data: {
      status: o.status,
      finishedAt: now,
      inputTokens: o.spent ? o.spent.inputTokens : null,
      cachedInputTokens: o.spent ? o.spent.cachedInputTokens : null,
      outputTokens: o.spent ? o.spent.outputTokens : null,
      costStatus: o.costStatus,
      costMicroUsd: o.costMicroUsd,
      // Конверт исполнения заменяется ответом или стирается.
      output: output === null ? Prisma.DbNull : (output as object),
      rawExcerpt: raw,
      errorCode:
        o.status === 'ok'
          ? null
          : o.status === 'schema_invalid'
            ? `schema:${o.issues
                .slice(0, 3)
                .map((i) => `${i.field}/${i.code}`)
                .join(',')}`.slice(0, 100)
            : o.status,
    },
  });
  if (res.count !== 1) {
    await lateFact(tx, plan, o);
    return false;
  }
  if (plan.mode.kind === 'cabinet') {
    // Неизвестная стоимость не ноль (аудит S1-4): `priced` — резерв
    // заменяется фактом; `unpriced` и `unknown` (таймаут/обрыв без отчёта
    // провайдера) — резерв-оценка остаётся в месяце до сверки. Была
    // прерванная синхронная попытка — её расход неизвестен: резерв остаётся
    // за неё, факт этой попытки добавляется сверху.
    await settleAiMonth(
      tx,
      plan.product,
      plan.month,
      plan.aborted ? 0n : plan.est,
      o.costStatus === 'priced' ? (o.costMicroUsd ?? 0n) : null,
      o.costStatus !== 'priced',
    );
  }
  await deps.audit.write(tx, {
    accountId: plan.product.accountId,
    productId: plan.product.id,
    actor: plan.actor,
    objectType: 'ai_call',
    objectId: plan.callId,
    action: 'transition',
    fromStatus: 'running',
    toStatus: o.status,
    meta: {
      findings: o.findings.slice(0, 20).map(findingMeta),
      issues: o.issues.slice(0, 20),
    },
  });
  return true;
}

/** Задача → `needs_human` (две неудачи / ошибка схемы после повтора, §7.5). */
async function giveUp(tx: PubTx, plan: ExecPlan): Promise<void> {
  await tx.pubAiTask.updateMany({
    where: { id: plan.taskId, status: 'open' },
    data: { status: 'needs_human', revision: { increment: 1 } },
  });
}

/** Повторная попытка при ошибке схемы — вторая генерация той же задачи. */
async function openRetry(
  tx: PubTx,
  plan: ExecPlan,
  deps: RunDeps,
  issues: FieldIssue[],
): Promise<ExecPlan | null> {
  const task = await tx.$queryRaw<
    Array<{ generationsUsed: number; extraAllowance: number }>
  >`
    SELECT "generationsUsed", "extraAllowance" FROM "sites"."pub_ai_tasks"
     WHERE "id" = ${plan.taskId} AND "accountId" = ${plan.product.accountId} FOR UPDATE`;
  const t = task[0];
  if (!t || t.generationsUsed >= BASE_GENERATIONS + t.extraAllowance)
    return null;
  const now = new Date();
  const month = kyivMonthOf(now);
  if (plan.mode.kind === 'cabinet') {
    const r = await reserveAiMonth(tx, plan.product, month, plan.est);
    if (!r.ok) return null;
  }
  const note = `${SCHEMA_RETRY_NOTE}\nПомилки: ${issues
    .slice(0, 10)
    .map((i) => `${i.field}: ${i.code}`)
    .join('; ')}`;
  const again = preparePrompt(plan.spec, plan.input, plan.ctx, note);
  const next: ExecPlan = {
    ...plan,
    callId: aiRowId('aic'),
    attemptNo: await nextAttempt(tx, plan.taskId),
    opKey: derivedOpKey(plan.opKey, 'schema-retry'),
    month,
    prompt: again.prompt,
    masked: again.masked,
    note,
    aborted: 0,
  };
  await tx.pubAiTask.updateMany({
    where: { id: plan.taskId },
    data: { generationsUsed: { increment: 1 }, revision: { increment: 1 } },
  });
  await insertCall(tx, {
    id: next.callId,
    product: plan.product,
    taskId: plan.taskId,
    attemptNo: next.attemptNo,
    generator: plan.generator,
    purpose: plan.purpose,
    configId: plan.configId,
    instructionVersion: plan.spec.instructionVersion,
    contextRulesVersion: plan.spec.contextRulesVersion,
    sourceIds: plan.sourceIds,
    provider: plan.provider,
    model: plan.model,
    opKey: next.opKey,
    actor: plan.actor,
    status: 'running',
    now,
    envelope: {
      pending: {
        v: 1,
        input: maskDeep(plan.input, {
          keep: maskKeep(plan.input, plan.ctx),
        }).value,
        audience: plan.ctx.audience,
        sourceIds: plan.sourceIds,
        note,
      },
    },
  });
  await deps.audit.write(tx, {
    accountId: plan.product.accountId,
    productId: plan.product.id,
    actor: plan.actor,
    objectType: 'ai_call',
    objectId: next.callId,
    action: 'create',
    toStatus: 'running',
    meta: {
      generator: plan.generator,
      taskId: plan.taskId,
      attemptNo: next.attemptNo,
      retryOfId: plan.callId,
      factIds: plan.factIds,
      sourceCount: plan.sourceIds.length,
    },
  });
  return next;
}

export interface RunResult {
  /** Первая попытка (набор задач оценивает её — «первый ответ»). */
  first: AttemptOutcome;
  /** Последняя попытка (после повтора при ошибке схемы). */
  last: AttemptOutcome;
  /** Окно синхронного пути исчерпано — вызов передан очереди (`running`). */
  handedOff: boolean;
}

export interface RunOptions {
  /** Окно синхронного пути (маршрут — 25 с); без него — полный таймаут. */
  budgetMs?: number;
}

/**
 * Вызов модели вне транзакции + финализация. В режиме кабинета при ошибке
 * схемы — одна повторная попытка; вторая неудача или нет права на повтор —
 * задача `needs_human`. С `budgetMs` модель прерывается по окну: вызов
 * остаётся `running` и его исполнит задание `ai-calls-run` (аудит S2-1) —
 * «доработки в том же процессе» нет.
 */
export async function runCall(
  plan: ExecPlan,
  deps: RunDeps,
  opts: RunOptions = {},
): Promise<RunResult> {
  const started = Date.now();
  const left = (): number =>
    opts.budgetMs === undefined
      ? MODEL_TIMEOUT_MS
      : Math.max(
          1,
          Math.min(
            MODEL_TIMEOUT_MS - 1,
            opts.budgetMs - (Date.now() - started),
          ),
        );
  const first = await attempt(plan, deps, left());
  if (first.status === 'running') {
    await deps.transaction(plan.product.accountId, (tx) =>
      markHandoff(tx, plan),
    );
    return { first, last: first, handedOff: true };
  }
  if (first.status !== 'schema_invalid' || plan.mode.kind === 'eval') {
    await deps.transaction(plan.product.accountId, async (tx) => {
      const done = await finalize(tx, plan, first, deps);
      if (done && first.status === 'schema_invalid') await giveUp(tx, plan);
    });
    return { first, last: first, handedOff: false };
  }
  const retry = await deps.transaction(plan.product.accountId, async (tx) => {
    if (!(await finalize(tx, plan, first, deps))) return null;
    const next = await openRetry(tx, plan, deps, first.issues);
    if (!next) await giveUp(tx, plan);
    return next;
  });
  if (!retry) return { first, last: first, handedOff: false };
  const second = await attempt(retry, deps, left());
  if (second.status === 'running') {
    await deps.transaction(plan.product.accountId, (tx) =>
      markHandoff(tx, retry),
    );
    return { first, last: second, handedOff: true };
  }
  await deps.transaction(plan.product.accountId, async (tx) => {
    const done = await finalize(tx, retry, second, deps);
    if (done && second.status === 'schema_invalid') await giveUp(tx, retry);
  });
  return { first, last: second, handedOff: false };
}

/**
 * План исполнения из строки вызова `running` (задание очереди): промпт
 * восстанавливается из конверта; источники — снимок вызова, проверенный
 * ЗАНОВО (отозванный за время ожидания — вызов не исполняется).
 */
export async function planFromRow(
  tx: PubTx,
  row: {
    id: string;
    productId: string;
    accountId: string;
    taskId: string;
    attemptNo: number;
    generator: string;
    purpose: string;
    configId: string | null;
    provider: string;
    model: string;
    opKey: string;
    requestedBy: string;
    requestedAt: Date;
    output: unknown;
  },
  siteId: string,
): Promise<ExecPlan> {
  const spec = GENERATORS[row.generator as GeneratorId];
  if (!spec || !isPendingEnvelope(row.output)) {
    throw new PubError('PUB_VALIDATION', {
      fields: [{ field: 'output', code: 'no_pending_envelope' }],
    });
  }
  const env = row.output.pending;
  const built = await buildContext(tx, row.productId, {
    audience: env.audience,
    sourceIds: env.sourceIds,
  });
  const { prompt, masked } = preparePrompt(
    spec,
    env.input,
    built.ctx,
    env.note,
  );
  const est = estimateCallMicroUsd(row.model, spec.maxOutputTokens);
  return {
    callId: row.id,
    product: { id: row.productId, accountId: row.accountId, siteId },
    generator: spec.id,
    spec,
    input: env.input,
    ctx: built.ctx,
    prompt,
    provider: row.provider,
    model: row.model,
    priced: est.priced,
    est: est.estMicroUsd,
    month: kyivMonthOf(row.requestedAt),
    taskId: row.taskId,
    attemptNo: row.attemptNo,
    // Повторная попытка хранит производный ключ — исходный не нужен.
    opKey: row.opKey,
    actor: row.requestedBy,
    purpose: row.purpose,
    sourceIds: built.sourceIds,
    factIds: built.factIds,
    configId: row.configId,
    mode: { kind: 'cabinet' },
    masked,
    note: env.note,
    aborted: typeof env.aborted === 'number' ? env.aborted : 0,
  };
}

/** Продукт — платформенный (сайт из `ASSIST_INTERNAL_SITE_IDS`, P-R-ADM). */
async function isPlatformProduct(
  tx: PubTx,
  productId: string,
): Promise<boolean> {
  const site = publisherPlatformSiteId();
  if (!site) return false;
  const p = await tx.pubProduct.findFirst({
    where: { id: productId },
    select: { siteId: true },
  });
  return p?.siteId === site;
}

/**
 * Перепроверка отложенного вызова перед исполнением очередью (предаудит
 * D2-03): то же, что проверил маршрут, — действующее право автора на
 * действие (`ai.helper` / `ai.generate`, гранты из базы на сейчас), гейт
 * `ai_use` по ТЕКУЩЕЙ привязке (модель, провайдер, версии, hash) и что
 * привязана та же конфигурация, с которой вызов создан. Иначе — код
 * отказа (`refused`, модель не вызывается).
 */
export async function recheckCall(
  tx: PubTx,
  row: {
    productId: string;
    accountId: string;
    generator: string;
    model: string;
    provider: string;
    instructionVersion: string;
    contextRulesVersion: string;
    configId: string | null;
    requestedBy: string;
  },
  productKind: string,
  gates: GatePort,
  now: Date,
): Promise<string | null> {
  const action =
    row.generator === 'pub.helper.answer' ? 'ai.helper' : 'ai.generate';
  let access: PubAccess | null;
  if (isAdminActor(row.requestedBy)) {
    // P-R-ADM (Р-RD-ADM-2): оператор Админки — только `pub.reddit.draft` и
    // только в платформенном продукте (как на внутреннем маршруте).
    if (
      !(ADMIN_GENERATORS as readonly string[]).includes(row.generator) ||
      !(await isPlatformProduct(tx, row.productId))
    ) {
      return 'PUB_ROLE_REQUIRED';
    }
    access = adminRedditAccess(row.requestedBy.slice('admin:'.length));
  } else {
    const memberId = /^member:(.+)$/.exec(row.requestedBy)?.[1];
    if (!memberId) return 'PUB_ROLE_REQUIRED';
    access = await memberAccessIn(tx, row.productId, memberId);
  }
  if (
    !access ||
    !can(access, action) ||
    deniedForKind(action, productKind as ProductCtx['kind'])
  ) {
    return 'PUB_ROLE_REQUIRED';
  }
  const ref = { id: row.productId, accountId: row.accountId };
  const bound = await boundConfig(tx, row.productId);
  if ((bound?.id ?? null) !== row.configId) return 'PUB_AI_NOT_EVALUATED';
  const spec = GENERATORS[row.generator as GeneratorId];
  const missing = await aiGateMissing(tx, gates, ref, now, bound, {
    generator: row.generator,
    model: row.model,
    instructionVersion: row.instructionVersion,
    priced: estimateCallMicroUsd(row.model, spec?.maxOutputTokens ?? 0).priced,
    provider: row.provider,
    contextRulesVersion: row.contextRulesVersion,
    schemaSetVersion: SCHEMA_SET_VERSION,
  });
  if (missing.length === 0) return null;
  if (onlyUnpriced(missing)) return 'PUB_AI_UNPRICED';
  return missing.some((m) => m.kind === 'ai_config')
    ? 'PUB_AI_NOT_EVALUATED'
    : 'PUB_GATE_CLOSED';
}

/** Вызов, который нельзя исполнить (источник отозван за время ожидания). */
export async function refuseCall(
  tx: PubTx,
  row: {
    id: string;
    productId: string;
    accountId: string;
    model: string;
    generator: string;
    requestedAt: Date;
    requestedBy: string;
    output: unknown;
  },
  reason: string,
  audit: AuditPort,
): Promise<boolean> {
  const n = await tx.pubAiCall.updateMany({
    where: { id: row.id, status: 'running' },
    data: {
      status: 'refused',
      finishedAt: new Date(),
      costStatus: 'priced',
      costMicroUsd: 0n,
      output: Prisma.DbNull,
      errorCode: reason.slice(0, 100),
    },
  });
  if (n.count !== 1) return false;
  const spec = GENERATORS[row.generator as GeneratorId];
  // Прерванная синхронная попытка могла стоить денег — резерв за неё держится.
  const aborted =
    isPendingEnvelope(row.output) && (row.output.pending.aborted ?? 0) > 0;
  if (!aborted)
    await settleAiMonth(
      tx,
      { id: row.productId, accountId: row.accountId },
      kyivMonthOf(row.requestedAt),
      estimateCallMicroUsd(row.model, spec?.maxOutputTokens ?? 0).estMicroUsd,
      0n,
    );
  await audit.write(tx, {
    accountId: row.accountId,
    productId: row.productId,
    actor: row.requestedBy,
    objectType: 'ai_call',
    objectId: row.id,
    action: 'transition',
    fromStatus: 'running',
    toStatus: 'refused',
    meta: { errorCode: reason.slice(0, 100) },
  });
  return true;
}

/**
 * Причина `PUB_AI_BUDGET` из `errorCode` вызова (`PUB_AI_BUDGET:<reason>`,
 * Р-RD-ADM-15): `month_not_open` — месяц AI не открыт (гейт `spend` или
 * задание `ai-month-open`), `cap_exhausted` — потолок месяца исчерпан. Та же
 * пара, что у `POST …/ai/tasks/:id/extra`; код ошибки прежний.
 */
export function aiBudgetReasonOf(
  errorCode: string | null | undefined,
): 'month_not_open' | 'cap_exhausted' | null {
  const m = /^PUB_AI_BUDGET:(month_not_open|cap_exhausted)$/.exec(
    errorCode ?? '',
  );
  return m ? (m[1] as 'month_not_open' | 'cap_exhausted') : null;
}

/** Код ошибки маршрута для итогового/блокирующего статуса вызова (§11.2). */
export function errorCodeOfStatus(
  status: AiCallStatus,
  missing: GateMissing[] = [],
): import('../contracts/errors').PubErrorCode | null {
  switch (status) {
    case 'ok':
    case 'running':
      return null;
    case 'disabled':
      return 'PUB_AI_DISABLED';
    case 'not_evaluated':
      return missing.length && !missing.some((m) => m.kind === 'ai_config')
        ? 'PUB_GATE_CLOSED'
        : 'PUB_AI_NOT_EVALUATED';
    case 'unpriced_blocked':
      return 'PUB_AI_UNPRICED';
    case 'budget_blocked':
      return 'PUB_AI_BUDGET';
    case 'schema_invalid':
      return 'PUB_AI_SCHEMA_INVALID';
    case 'timeout':
    case 'unavailable':
    case 'empty':
    case 'truncated':
    case 'refused':
      return 'PUB_AI_UNAVAILABLE';
  }
}
