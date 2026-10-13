/**
 * AI Publisher — оцениваемые конфигурации AI и их применение (P-B2,
 * проектный документ §6.7, §12.6; Р-PUB-32).
 *
 * Конфигурации живут в продукте `kind=eval` (их создаёт CLI прогона по
 * текущему коду, `not_run`). Решение по конфигурации — владелец продукта
 * в кабинете eval-продукта:
 *  - `passed` — только по ЖИВОМУ прогону этой конфигурации, где по
 *    последним строкам все 30 задач оценены человеком, 30 `criticalPass`
 *    и `usefulnessPass` ≥ 24 (§12.6; то же держит триггер
 *    `pub_eval_guard` — прогон `fake` перевести в `passed` нельзя);
 *  - `failed`/`blocked` — в любой момент с основанием; из `passed` —
 *    отзыв (`blocked`/`failed`): привязки перестают открывать гейт сами.
 * Применение к рабочему продукту — привязка `pub_ai_config_bindings` с
 * основанием и журналом (одна активная — частичный индекс; новая
 * привязка снимает прежнюю в той же транзакции).
 */
import { Injectable } from '@nestjs/common';
import type {
  AiBindingView,
  AiBindingsResponse,
  AiConfigView,
  EvalRunSummary,
} from '../contracts/ai-api';
import { PubError, assertNoIssues, validationError } from '../core/errors';
import { piiIssues } from '../core/pii-guard';
import type { AuditInput, ProductRef, PubTx } from '../core/ports';
import { FAKE_PROVIDER, loadProtocol } from './eval/cli-gateway';
import { EVAL_FIXTURE_SET_HASH } from './eval/fixtures';

export const CONFIG_DECISIONS = ['passed', 'failed', 'blocked'] as const;
export type ConfigDecision = (typeof CONFIG_DECISIONS)[number];

type ConfigRow = NonNullable<
  Awaited<ReturnType<PubTx['pubAiConfig']['findFirst']>>
>;
type RunRow = NonNullable<
  Awaited<ReturnType<PubTx['pubAiEvalRun']['findFirst']>>
>;
type BindingRow = NonNullable<
  Awaited<ReturnType<PubTx['pubAiConfigBinding']['findFirst']>>
>;

export function runSummary(r: RunRow): EvalRunSummary {
  return {
    id: r.id,
    configId: r.configId,
    mode: r.mode as 'fake' | 'live',
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    totals: (r.totals ?? null) as EvalRunSummary['totals'],
  };
}

export function configView(c: ConfigRow, runs: RunRow[] = []): AiConfigView {
  return {
    id: c.id,
    provider: c.provider,
    model: c.model,
    configHash: c.configHash,
    contextRulesVersion: c.contextRulesVersion,
    schemaSetVersion: c.schemaSetVersion,
    instructionVersions: (c.instructionVersions ?? {}) as Record<
      string,
      string
    >,
    coveredGenerators: (c.coveredGenerators ?? []) as string[],
    evalSetVersion: c.evalSetVersion,
    evalStatus: c.evalStatus as AiConfigView['evalStatus'],
    evalRunId: c.evalRunId,
    decidedBy: c.decidedBy,
    decidedAt: c.decidedAt ? c.decidedAt.toISOString() : null,
    basis: c.basis,
    createdAt: c.createdAt.toISOString(),
    runs: runs.map(runSummary),
  };
}

function bindingView(b: BindingRow, c: ConfigRow | null): AiBindingView {
  return {
    id: b.id,
    configId: b.configId,
    boundBy: b.boundBy,
    boundAt: b.boundAt.toISOString(),
    basis: b.basis,
    unboundAt: b.unboundAt ? b.unboundAt.toISOString() : null,
    unboundBy: b.unboundBy,
    active: b.unboundAt === null,
    config: c
      ? {
          configHash: c.configHash,
          provider: c.provider,
          model: c.model,
          evalStatus: c.evalStatus as AiConfigView['evalStatus'],
        }
      : null,
  };
}

function basisIssues(basis: unknown, min: number) {
  if (
    typeof basis !== 'string' ||
    basis.trim().length < min ||
    basis.length > 2000
  ) {
    return [
      { field: 'basis', code: basis === undefined ? 'required' : 'length' },
    ];
  }
  return piiIssues({ basis });
}

/** Решение по конфигурации допустимо из текущего статуса. */
export function decisionAllowed(from: string, to: ConfigDecision): boolean {
  if (from === 'not_run') return true;
  if (from === 'passed') return to === 'failed' || to === 'blocked';
  return false;
}

@Injectable()
export class AiConfigsService {
  /** Только продукт `kind=eval`: в остальных конфигураций нет (404). */
  assertEval(product: { kind: string }): void {
    if (product.kind !== 'eval')
      throw new PubError('PUB_NOT_FOUND', { reason: 'not_eval_product' });
  }

  async list(db: PubTx, productId: string): Promise<{ items: AiConfigView[] }> {
    const configs = await db.pubAiConfig.findMany({
      where: { productId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const runs = await db.pubAiEvalRun.findMany({
      where: { productId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    });
    return {
      items: configs.map((c) =>
        configView(
          c,
          runs.filter((r) => r.configId === c.id),
        ),
      ),
    };
  }

  async decide(
    tx: PubTx,
    product: ProductRef,
    configId: string,
    body: { evalStatus: unknown; evalRunId: unknown; basis: unknown },
    actor: string,
    now: Date,
  ): Promise<{ view: AiConfigView; audit: AuditInput[] }> {
    const to = body.evalStatus as ConfigDecision;
    if (!(CONFIG_DECISIONS as readonly unknown[]).includes(to)) {
      throw validationError([{ field: 'evalStatus', code: 'enum' }]);
    }
    assertNoIssues(basisIssues(body.basis, 10));
    const config = await tx.pubAiConfig.findFirst({
      where: { id: configId, productId: product.id },
    });
    if (!config) throw new PubError('PUB_NOT_FOUND');
    if (!decisionAllowed(config.evalStatus, to)) {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'ai_config',
        from: config.evalStatus,
        to,
        allowed: CONFIG_DECISIONS.filter((d) =>
          decisionAllowed(config.evalStatus, d),
        ),
      });
    }
    let evalRunId: string | null = config.evalRunId;
    if (to === 'passed') {
      if (typeof body.evalRunId !== 'string') {
        throw validationError([{ field: 'evalRunId', code: 'required' }]);
      }
      const run = await tx.pubAiEvalRun.findFirst({
        where: {
          id: body.evalRunId,
          productId: product.id,
          configId: config.id,
        },
      });
      if (!run)
        throw validationError([
          { field: 'evalRunId', code: 'not_this_config' },
        ]);
      if (run.mode !== 'live' || config.provider === FAKE_PROVIDER)
        throw validationError([{ field: 'evalRunId', code: 'fake_run' }]);
      const p = await loadProtocol(tx, product.id, run.id);
      // Аудит S3-10: прогон — на эталонной синтетике S1–S7 текущего набора.
      if (p.totals.fixtureSetHash !== EVAL_FIXTURE_SET_HASH) {
        throw validationError([
          { field: 'evalRunId', code: 'fixtures_mismatch' },
        ]);
      }
      if (!p.totals.thresholdsMet) {
        throw new PubError('PUB_VALIDATION', {
          fields: [{ field: 'evalRunId', code: 'thresholds_not_met' }],
          totals: p.totals,
        });
      }
      evalRunId = run.id;
    } else if (typeof body.evalRunId === 'string') {
      const run = await tx.pubAiEvalRun.findFirst({
        where: {
          id: body.evalRunId,
          productId: product.id,
          configId: config.id,
        },
        select: { id: true },
      });
      if (!run)
        throw validationError([
          { field: 'evalRunId', code: 'not_this_config' },
        ]);
      evalRunId = run.id;
    }
    const n = await tx.pubAiConfig.updateMany({
      where: { id: config.id, evalStatus: config.evalStatus },
      data: {
        evalStatus: to,
        evalRunId,
        decidedBy: actor,
        decidedAt: now,
        basis: (body.basis as string).trim(),
      },
    });
    // Аудит S3-3: решение параллельного запроса успело раньше — 409, не «успех».
    if (n.count !== 1) {
      throw new PubError('PUB_CONFLICT', {
        configId: config.id,
        reason: 'eval_status_changed',
      });
    }
    const after = await tx.pubAiConfig.findFirst({ where: { id: config.id } });
    return {
      view: configView(after!),
      audit: [
        {
          objectType: 'ai_config',
          objectId: config.id,
          action: to === 'passed' ? 'approve' : 'reject',
          fromStatus: config.evalStatus,
          toStatus: to,
          reason: (body.basis as string).trim(),
          meta: { evalRunId, configHash: config.configHash },
        },
      ],
    };
  }

  // ── Привязки рабочего продукта (§6.7) ────────────────────────────────

  async bindings(
    db: PubTx,
    product: ProductRef & { kind: string },
  ): Promise<AiBindingsResponse> {
    const rows = await db.pubAiConfigBinding.findMany({
      where: { productId: product.id },
      orderBy: [{ boundAt: 'desc' }, { id: 'desc' }],
    });
    const configs = await db.pubAiConfig.findMany({
      where: {
        OR: [
          { id: { in: [...new Set(rows.map((r) => r.configId))] } },
          { evalStatus: 'passed' },
        ],
      },
    });
    const byId = new Map(configs.map((c) => [c.id, c]));
    return {
      items: rows.map((r) => bindingView(r, byId.get(r.configId) ?? null)),
      available: configs
        .filter((c) => c.evalStatus === 'passed')
        .map((c) => configView(c)),
    };
  }

  async bind(
    tx: PubTx,
    product: ProductRef & { kind: string },
    body: { configId: unknown; basis: unknown },
    actor: string,
    now: Date,
  ): Promise<{ view: AiBindingView; audit: AuditInput[] }> {
    if (product.kind !== 'working') {
      throw validationError([
        { field: 'product', code: 'not_working_product' },
      ]);
    }
    if (typeof body.configId !== 'string')
      throw validationError([{ field: 'configId', code: 'required' }]);
    assertNoIssues(basisIssues(body.basis, 10));
    // Конфигурация того же кабинета (тенант); чужая или нет — 404.
    const config = await tx.pubAiConfig.findFirst({
      where: { id: body.configId },
    });
    if (!config) throw new PubError('PUB_NOT_FOUND');
    if (config.evalStatus !== 'passed') {
      throw new PubError('PUB_AI_NOT_EVALUATED', {
        configId: config.id,
        evalStatus: config.evalStatus,
      });
    }
    await tx.$queryRaw`SELECT "id" FROM "sites"."pub_products"
       WHERE "id" = ${product.id} AND "accountId" = ${product.accountId} FOR NO KEY UPDATE`;
    const audit: AuditInput[] = [];
    const prev = await tx.pubAiConfigBinding.findFirst({
      where: { productId: product.id, unboundAt: null },
    });
    if (prev) {
      await tx.pubAiConfigBinding.updateMany({
        where: { id: prev.id, unboundAt: null },
        data: { unboundAt: now, unboundBy: actor },
      });
      audit.push({
        objectType: 'ai_config_binding',
        objectId: prev.id,
        action: 'unbind',
        reason: 'Замінено новою конфігурацією',
        meta: { configId: prev.configId },
      });
    }
    const row = await tx.pubAiConfigBinding.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        configId: config.id,
        boundBy: actor,
        boundAt: now,
        basis: (body.basis as string).trim(),
        createdBy: actor,
      },
    });
    audit.push({
      objectType: 'ai_config_binding',
      objectId: row.id,
      action: 'bind',
      reason: (body.basis as string).trim(),
      meta: { configId: config.id, configHash: config.configHash },
    });
    return { view: bindingView(row, config), audit };
  }

  async unbind(
    tx: PubTx,
    product: ProductRef,
    bindingId: string,
    reason: unknown,
    actor: string,
    now: Date,
  ): Promise<{ view: AiBindingView; audit: AuditInput[] }> {
    if (
      typeof reason !== 'string' ||
      reason.trim().length < 3 ||
      reason.length > 2000
    ) {
      throw validationError([
        { field: 'reason', code: reason === undefined ? 'required' : 'length' },
      ]);
    }
    assertNoIssues(piiIssues({ reason }));
    const b = await tx.pubAiConfigBinding.findFirst({
      where: { id: bindingId, productId: product.id },
    });
    if (!b) throw new PubError('PUB_NOT_FOUND');
    if (b.unboundAt) {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'ai_config_binding',
        from: 'unbound',
        to: 'unbound',
        allowed: [],
      });
    }
    await tx.pubAiConfigBinding.updateMany({
      where: { id: b.id, unboundAt: null },
      data: { unboundAt: now, unboundBy: actor },
    });
    const after = await tx.pubAiConfigBinding.findFirst({
      where: { id: b.id },
    });
    const config = await tx.pubAiConfig.findFirst({
      where: { id: b.configId },
    });
    return {
      view: bindingView(after!, config),
      audit: [
        {
          objectType: 'ai_config_binding',
          objectId: b.id,
          action: 'unbind',
          reason: reason.trim(),
          meta: { configId: b.configId },
        },
      ],
    };
  }
}
