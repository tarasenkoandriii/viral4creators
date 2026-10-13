/**
 * AI Publisher P-B2 — построители тестов AI-зоны (проектный документ §16.0:
 * предметные TD — в `<зона>/testing/`): модель без сети, утверждение
 * параметров AI, источники, месяц потолка, конфигурация с привязкой.
 * Пишут сырым клиентом владельца схемы (тест).
 */
import { randomUUID } from 'crypto';
import type { PrismaService } from '../../../../prisma/prisma.service';
import {
  TextModelError,
  type GenerateRequest,
  type GenerateResult,
} from '../../../site-ai/text-model';
import { P0_ENABLED_GENERATORS } from '../../contracts/ai';
import type { ParameterKey } from '../../contracts/parameters';
import { sha256Hex, sourceContentHash } from '../../core/content-hash';
import { kyivMonthOf } from '../../core/kyiv-time';
import {
  configHashOf,
  currentConfigSpec,
  type AiCallParams,
  type AiConfigSpec,
} from '../config';
import { testSlug } from '../../testing/fixtures.testing';

/** Ответ модели: текст, ошибка модели или функция от запроса. */
export type ScriptedReply =
  | string
  | TextModelError
  | ((req: GenerateRequest) => string | Promise<string>);

/** Модель без сети: очередь ответов, запись запросов. */
export class ScriptedModel {
  requests: GenerateRequest[] = [];
  queue: ScriptedReply[] = [];
  /** Ответ, когда очередь пуста. */
  fallback: ScriptedReply | null = null;
  delayMs = 0;
  usage = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200 };

  reply(...r: ScriptedReply[]): this {
    this.queue.push(...r);
    return this;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    // Как GeminiText: задержка дольше `timeoutMs` — прерывание без расхода.
    if (
      this.delayMs &&
      req.timeoutMs !== undefined &&
      this.delayMs > req.timeoutMs
    ) {
      await new Promise((r) => setTimeout(r, req.timeoutMs));
      throw new TextModelError('timeout');
    }
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const next = this.queue.shift() ?? this.fallback;
    if (next === null) throw new Error('ScriptedModel: ответ не задан тестом');
    if (next instanceof TextModelError) throw next;
    const text = typeof next === 'function' ? await next(req) : next;
    return { text, model: req.model ?? 'gemini-3.6-flash', ...this.usage };
  }
}

export const helperJson = (
  sourceIds: string[],
  answer = 'Відповідь за джерелом.',
) =>
  JSON.stringify({
    answer,
    used_source_ids: sourceIds,
    unknowns: [],
    next_action: 'Перевірити людиною.',
  });

/** Утвердить ключи параметров напрямую (решение той же версии → параметр). */
export async function approveParams(
  db: PrismaService,
  acc: { accountId: string; ownerMemberId: string },
  productId: string,
  values: Partial<Record<ParameterKey, unknown>>,
): Promise<void> {
  for (const [key, override] of Object.entries(values)) {
    const p = await db.pubParameter.findFirst({ where: { productId, key } });
    if (!p) throw new Error(`approveParams: нет ключа ${key}`);
    const value = (override ?? p.value) as object;
    await db.$transaction(async (tx) => {
      await tx.pubParameterDecision.create({
        data: {
          accountId: acc.accountId,
          productId,
          parameterKey: key,
          version: p.version + 1,
          fromStatus: p.status,
          toStatus: 'approved',
          valueSnapshot: value,
          decidedBy: `member:${acc.ownerMemberId}`,
          basis: 'Тестове затвердження',
          dependentStages: [],
          createdBy: `member:${acc.ownerMemberId}`,
        },
      });
      await tx.pubParameter.update({
        where: { id: p.id },
        data: {
          value,
          status: 'approved',
          version: p.version + 1,
          approvedAt: new Date(),
          approvedBy: `member:${acc.ownerMemberId}`,
        },
      });
    });
  }
}

export const AI_PARAMS: Partial<Record<ParameterKey, unknown>> = {
  ai_budget_usd_month: { microUsd: 20_000_000 },
  ai_fx_rate: { rate: '41.5', source: 'НБУ', at: '2026-10-12T10:00:00+03:00' },
};

export interface SourceSeed {
  usage?: 'allowed' | 'restricted' | 'revoked';
  visibility?: 'public' | 'private';
  title?: string;
  fragment?: string;
}

export async function seedAiSource(
  db: PrismaService,
  product: { id: string; accountId: string },
  s: SourceSeed = {},
): Promise<string> {
  const fragment = s.fragment ?? `Фрагмент ${randomUUID()}`;
  const revoked = s.usage === 'revoked';
  const row = await db.pubSource.create({
    data: {
      accountId: product.accountId,
      productId: product.id,
      kind: 'manual_text',
      title: s.title ?? 'Джерело',
      fragment,
      usage: s.usage ?? 'allowed',
      visibility: s.visibility ?? 'private',
      contentHash: sourceContentHash(null, fragment),
      createdBy: 'system:test-seed',
      ...(revoked
        ? {
            revokedAt: new Date(),
            revokedBy: 'system:test-seed',
            revokeReason: 'тест',
          }
        : {}),
    },
  });
  return row.id;
}

/** Месяц потолка AI (в проде — задание `ai-month-open` с обязательством P-C). */
export async function openAiMonth(
  db: PrismaService,
  product: { id: string; accountId: string },
  capMicroUsd: bigint,
  at = new Date(),
): Promise<string> {
  const row = await db.pubAiBudgetMonth.create({
    data: {
      accountId: product.accountId,
      productId: product.id,
      month: kyivMonthOf(at),
      capMicroUsd,
      createdBy: 'system:test-seed',
    },
  });
  return row.id;
}

/**
 * Конфигурация eval-продукта со статусом `passed` и привязка рабочего
 * продукта. `passed` требует 30 оценённых задач живого прогона (триггер) —
 * здесь, для проверки шлюза, статус ставится в обход триггеров
 * (`session_replication_role`, как `core/gates.db.spec`); честный путь
 * (прогон → оценки → решение) — в `ai-eval-run.spec`.
 */
export async function seedBoundConfig(
  db: PrismaService,
  acc: { accountId: string; ownerMemberId: string },
  evalProductId: string,
  workProductId: string,
  opts: {
    model?: string;
    instructionVersions?: Record<string, string>;
    status?: string;
    provider?: string;
    contextRulesVersion?: string;
    schemaSetVersion?: string;
    callParams?: AiCallParams;
  } = {},
): Promise<{ configId: string; bindingId: string }> {
  // Hash — честный hash состава (предаудит D2-04: шлюз сверяет hash
  // привязанной конфигурации с кодом); тот же состав и статус в том же
  // eval-продукте — та же строка (уникальность productId+configHash).
  const status = opts.status ?? 'passed';
  const spec: AiConfigSpec = {
    ...currentConfigSpec(
      opts.provider ?? 'gemini',
      opts.model ?? 'gemini-3.6-flash',
    ),
    ...(opts.contextRulesVersion
      ? { contextRulesVersion: opts.contextRulesVersion }
      : {}),
    ...(opts.schemaSetVersion
      ? { schemaSetVersion: opts.schemaSetVersion }
      : {}),
    ...(opts.instructionVersions
      ? { instructionVersions: opts.instructionVersions }
      : {}),
    ...(opts.callParams ? { callParams: opts.callParams } : {}),
  };
  let configHash = configHashOf(spec);
  const same = await db.pubAiConfig.findFirst({
    where: { productId: evalProductId, configHash },
    select: { id: true, evalStatus: true },
  });
  if (same && same.evalStatus !== status) configHash = sha256Hex(randomUUID());
  const cfg =
    same && same.evalStatus === status
      ? { id: same.id }
      : await db.pubAiConfig.create({
          data: {
            accountId: acc.accountId,
            productId: evalProductId,
            provider: spec.provider,
            model: spec.model,
            contextRulesVersion: spec.contextRulesVersion,
            schemaSetVersion: spec.schemaSetVersion,
            instructionVersions: spec.instructionVersions,
            configHash,
            coveredGenerators: [...P0_ENABLED_GENERATORS],
            createdBy: 'system:test-seed',
          },
        });
  if (!(same && same.evalStatus === status) && status !== 'not_run') {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL session_replication_role = replica`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "sites"."pub_ai_configs" SET "evalStatus" = $2 WHERE "id" = $1`,
        cfg.id,
        status,
      );
    });
  }
  const b = await db.pubAiConfigBinding.create({
    data: {
      accountId: acc.accountId,
      productId: workProductId,
      configId: cfg.id,
      boundBy: `member:${acc.ownerMemberId}`,
      basis: 'Застосувати конфігурацію',
      createdBy: `member:${acc.ownerMemberId}`,
    },
  });
  return { configId: cfg.id, bindingId: b.id };
}

/** Вопрос F01 с источниками (кандидат) — вход `briefs/draft`. */
export async function seedQuestion(
  db: PrismaService,
  product: { id: string; accountId: string },
  sourceIds: string[],
  text = 'Як підготувати кілька форматів з одного матеріалу?',
): Promise<string> {
  const q = await db.pubQuestion.create({
    data: {
      accountId: product.accountId,
      productId: product.id,
      text,
      stage: 'unknown',
      scores: {},
      createdBy: 'system:test-seed',
    },
  });
  for (const sourceId of sourceIds) {
    await db.pubQuestionSource.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        questionId: q.id,
        sourceId,
        createdBy: 'system:test-seed',
      },
    });
  }
  return q.id;
}

/**
 * Статья с согласованной (замороженной) версией и источниками версии —
 * вход `adaptations/draft` и `qa-checks/ai-review`. Минимальная цепочка
 * P-B1 (вопрос → оффер → бриф → материал → версия), без сервисов P-B1.
 */
export async function seedApprovedArticle(
  db: PrismaService,
  product: { id: string; accountId: string },
  sourceIds: string[],
  authorMemberId: string,
): Promise<{ contentId: string; versionId: string; questionId: string }> {
  const questionId = await seedQuestion(db, product, sourceIds);
  const offer =
    (await db.pubOfferVersion.findFirst({
      where: { productId: product.id, version: 1 },
      select: { id: true },
    })) ??
    (await db.pubOfferVersion.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        version: 1,
        title: 'Офер',
        text: 'Послуга',
        hash: sha256Hex(randomUUID()),
        createdBy: 'system:test-seed',
      },
    }));
  const brief = await db.pubBrief.create({
    data: {
      accountId: product.accountId,
      productId: product.id,
      questionId,
      offerVersionId: offer.id,
      goal: 'Пояснити метод',
      format: 'instruction',
      structure: [],
      channels: [],
      readinessCriteria: [],
      unresolved: [],
      createdBy: 'system:test-seed',
    },
  });
  const content = await db.pubContent.create({
    data: {
      accountId: product.accountId,
      productId: product.id,
      kind: 'article',
      briefId: brief.id,
      slug: testSlug('method'),
      createdBy: 'system:test-seed',
    },
  });
  const v = await db.pubContentVersion.create({
    data: {
      accountId: product.accountId,
      productId: product.id,
      contentId: content.id,
      number: 1,
      title: 'Один матеріал — три формати',
      body: 'З одного перевіреного матеріалу можна підготувати пост, картки і сценарій.',
      meta: {},
      format: 'article',
      offerVersionId: offer.id,
      authorMemberId,
      createdBy: 'system:test-seed',
    },
  });
  for (const sourceId of sourceIds) {
    await db.pubVersionSource.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        versionId: v.id,
        sourceId,
        createdBy: 'system:test-seed',
      },
    });
  }
  await db.pubContentVersion.update({
    where: { id: v.id },
    data: {
      status: 'approved',
      hash: sha256Hex(randomUUID()),
      frozenAt: new Date(),
    },
  });
  await db.pubContent.update({
    where: { id: content.id },
    data: {
      currentVersionId: v.id,
      approvedVersionId: v.id,
      status: 'approved',
    },
  });
  return { contentId: content.id, versionId: v.id, questionId };
}
