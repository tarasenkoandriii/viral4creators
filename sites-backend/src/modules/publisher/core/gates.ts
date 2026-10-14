/**
 * AI Publisher — гейты: параметры → технические блокировки (P-A1,
 * проектный документ §10; Р-PUB-0 п.4). Сервер — единственный судья:
 * гейт вычисляется в транзакции операции, закрытый — 409 `PUB_GATE_CLOSED
 * {gate, missing[]}` с перечнем недостающего (а не спрятанная кнопка).
 *
 *  - `kind=test` — по собственным параметрам, без `mode=live` и
 *    verified-хоста (§3.1); `kind=eval|restored` и `status=archived` —
 *    закрыты все гейты (`missing: product/...`);
 *  - «зелёный» только без пунктов: неизвестное (нет строки, не собран
 *    лимит, интеграция без `lastSuccessAt`) — всегда пункт (ТЗ §8.4).
 *
 * Чтение чужих таблиц (`pub_budget_limits`, `pub_expenses`,
 * `pub_integrations`, AI-конфигураций, `site_hosts`) — разрешено ядру
 * (§6.8 «читает всё»); запись — нет.
 */
import { Injectable } from '@nestjs/common';
import { evaluateHostAccess } from '../../site-core/ownership/host-access';
import { EVAL_COVERED_GENERATORS } from '../contracts/ai';
import type {
  GateContext,
  GateMissing,
  GateName,
  GateResult,
} from '../contracts/common';
import {
  BUDGET_LIMIT_PARAMETER_KEYS,
  GATE_PARAMETER_KEYS,
  budgetParamVersion,
  type ParameterKey,
} from '../contracts/parameters';
import { PubError } from './errors';
import {
  budgetConsistencyIssues,
  parameterPlaceholderIssues,
} from './parameter-schemas';
import { lockProduct } from './refresh-gate-flags';
import type { GatePort, ProductRef, PubTx } from './ports';

const HOUR_MS = 60 * 60 * 1000;

/** Интеграции измерения, без которых закупка закрыта (AT-CORE-12). */
export const MEASUREMENT_INTEGRATIONS = [
  'events_collector',
  'web_analytics',
] as const;

interface ParamRow {
  key: string;
  status: string;
  value: unknown;
  version: number;
}

function missingParams(
  params: ReadonlyMap<string, ParamRow>,
  keys: readonly ParameterKey[],
): GateMissing[] {
  const out: GateMissing[] = [];
  for (const k of keys) {
    const row = params.get(k);
    if (row?.status !== 'approved') {
      out.push({ kind: 'parameter', key: k, detail: row?.status ?? 'missing' });
    } else if (parameterPlaceholderIssues(k, row.value).length) {
      // Р-PUB-Z2-26: утверждённая (до правила) заглушка гейт не открывает.
      out.push({ kind: 'parameter', key: k, detail: 'placeholder' });
    }
  }
  return out;
}

async function loadParams(
  tx: PubTx,
  productId: string,
): Promise<Map<string, ParamRow>> {
  const rows = await tx.pubParameter.findMany({
    where: { productId },
    select: { key: true, status: true, value: true, version: true },
  });
  return new Map(rows.map((r) => [r.key, r]));
}

async function hostMissing(
  tx: PubTx,
  siteId: string,
  params: ReadonlyMap<string, ParamRow>,
  now: Date,
): Promise<GateMissing[]> {
  const v = params.get('domain_host')?.value as { host?: unknown } | undefined;
  const host = typeof v?.host === 'string' ? v.host : null;
  if (!host) return [{ kind: 'host', key: 'domain_host', detail: 'not_set' }];
  const rows = await tx.siteHost.findMany({
    where: { siteId, host },
    select: {
      id: true,
      accountId: true,
      host: true,
      status: true,
      expiresAt: true,
      revokedAt: true,
      reverifyBlockedAt: true,
      scheme: true,
    },
  });
  const ok = rows.some(
    (r) =>
      r.scheme === 'https' && evaluateHostAccess(r, 'publisher-public', now).ok,
  );
  return ok
    ? []
    : [
        {
          kind: 'host',
          key: host,
          detail: rows.length ? 'not_verified' : 'not_found',
        },
      ];
}

async function reconcileMissing(
  tx: PubTx,
  productId: string,
  categories: readonly string[] | null,
): Promise<GateMissing[]> {
  const n = await tx.pubExpense.count({
    where: {
      productId,
      reconcileRequired: true,
      ...(categories ? { category: { in: [...categories] } } : {}),
    },
  });
  return n > 0
    ? [
        {
          kind: 'reconcile',
          key: categories ? categories.join('|') : 'product',
          detail: `pending_or_unknown:${n}`,
        },
      ]
    : [];
}

async function budgetMissing(
  tx: PubTx,
  productId: string,
  params: ReadonlyMap<string, ParamRow>,
): Promise<GateMissing[]> {
  const limit = await tx.pubBudgetLimit.findFirst({
    where: { productId },
    select: { paramVersion: true },
  });
  if (!limit)
    return [{ kind: 'budget', key: 'pub_budget_limits', detail: 'not_built' }];
  const expected = budgetParamVersion(
    Object.fromEntries(
      BUDGET_LIMIT_PARAMETER_KEYS.map((k) => [k, params.get(k)?.version ?? 0]),
    ),
  );
  return limit.paramVersion === expected
    ? []
    : [{ kind: 'budget', key: 'pub_budget_limits', detail: 'stale' }];
}

/**
 * Несогласованные бюджетные ключи (аудит P2-1, P3-7): пункт
 * `{kind:'budget', key, detail:'inconsistent'}`, пока пара не сойдётся.
 * `spend` — сумма и закупка ≤ размещений; `purchases` — ещё валюта ставок.
 */
function budgetConsistencyMissing(
  params: ReadonlyMap<string, ParamRow>,
  withRates: boolean,
): GateMissing[] {
  const values = Object.fromEntries(
    [...params.values()].map((p) => [p.key, p.value]),
  );
  return budgetConsistencyIssues(values)
    .filter((i) => withRates || i.check !== 'currency')
    .map((i) => ({ kind: 'budget' as const, key: i.key, detail: i.detail }));
}

async function integrationsMissing(
  tx: PubTx,
  productId: string,
  now: Date,
): Promise<GateMissing[]> {
  const rows = await tx.pubIntegration.findMany({
    where: { productId, kind: { in: [...MEASUREMENT_INTEGRATIONS] } },
    select: {
      kind: true,
      status: true,
      lastSuccessAt: true,
      staleAfterHours: true,
    },
  });
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  const out: GateMissing[] = [];
  for (const kind of MEASUREMENT_INTEGRATIONS) {
    const r = byKind.get(kind);
    if (!r) out.push({ kind: 'integration', key: kind, detail: 'missing' });
    else if (r.status !== 'connected') {
      out.push({ kind: 'integration', key: kind, detail: r.status });
    } else if (
      !r.lastSuccessAt ||
      now.getTime() - r.lastSuccessAt.getTime() > r.staleAfterHours * HOUR_MS
    ) {
      out.push({ kind: 'integration', key: kind, detail: 'stale' });
    }
  }
  return out;
}

async function aiMissing(
  tx: PubTx,
  productId: string,
  params: ReadonlyMap<string, ParamRow>,
  ctx: GateContext['ai'],
): Promise<GateMissing[]> {
  const out: GateMissing[] = [];
  if (
    ctx &&
    !(EVAL_COVERED_GENERATORS as readonly string[]).includes(ctx.generator)
  ) {
    out.push({
      kind: 'ai_config',
      key: ctx.generator,
      detail: 'not_covered_by_eval_set',
    });
  }
  const binding = await tx.pubAiConfigBinding.findFirst({
    where: { productId, unboundAt: null },
    select: { configId: true },
  });
  const config = binding
    ? await tx.pubAiConfig.findFirst({
        where: { id: binding.configId },
        select: {
          model: true,
          provider: true,
          contextRulesVersion: true,
          schemaSetVersion: true,
          evalStatus: true,
          instructionVersions: true,
          coveredGenerators: true,
        },
      })
    : null;
  if (!config) {
    out.push({ kind: 'ai_config', key: 'binding', detail: 'none' });
  } else {
    if (config.evalStatus !== 'passed') {
      out.push({ kind: 'ai_config', key: 'eval', detail: config.evalStatus });
    }
    if (ctx) {
      const covered = Array.isArray(config.coveredGenerators)
        ? (config.coveredGenerators as unknown[])
        : [];
      if (!covered.includes(ctx.generator)) {
        out.push({
          kind: 'ai_config',
          key: ctx.generator,
          detail: 'not_in_config',
        });
      }
      // Аудит P-B2 S2-5: смена провайдера, правил контекста или набора
      // схем — новая конфигурация и повторный прогон (ТЗ §28, §12.4).
      for (const key of [
        'provider',
        'contextRulesVersion',
        'schemaSetVersion',
      ] as const) {
        if (ctx[key] !== undefined && config[key] !== ctx[key]) {
          out.push({ kind: 'ai_config', key, detail: 'mismatch' });
        }
      }
      if (config.model !== ctx.model) {
        out.push({ kind: 'ai_config', key: 'model', detail: 'mismatch' });
      }
      const versions = (config.instructionVersions ?? {}) as Record<
        string,
        unknown
      >;
      if (versions[ctx.generator] !== ctx.instructionVersion) {
        out.push({ kind: 'ai_config', key: 'instruction', detail: 'mismatch' });
      }
    }
  }
  out.push(...missingParams(params, GATE_PARAMETER_KEYS.ai_use));
  if (ctx && !ctx.priced) {
    const p = params.get('ai_unpriced_allowed');
    const allowed =
      p?.status === 'approved' &&
      (p.value as { allowed?: unknown })?.allowed === true;
    if (!allowed) {
      out.push({
        kind: 'parameter',
        key: 'ai_unpriced_allowed',
        detail: 'unpriced_model',
      });
    }
  }
  return out;
}

/**
 * Состояние гейта (§10). Внутри транзакции операции; `now` — один на
 * операцию (сроки интеграций и хостов).
 */
export async function evaluateGate(
  tx: PubTx,
  productId: string,
  gate: GateName,
  now: Date,
  ctx: GateContext = {},
): Promise<GateResult> {
  const product = await tx.pubProduct.findFirst({
    where: { id: productId },
    select: { kind: true, mode: true, status: true, siteId: true },
  });
  if (!product) throw new PubError('PUB_NOT_FOUND');
  const done = (missing: GateMissing[]): GateResult => ({
    gate,
    open: missing.length === 0,
    missing,
  });
  if (product.kind === 'eval' || product.kind === 'restored') {
    return done([{ kind: 'product', key: 'kind', detail: product.kind }]);
  }
  if (product.status !== 'active') {
    return done([{ kind: 'product', key: 'status', detail: product.status }]);
  }
  const working = product.kind === 'working';
  const params = await loadParams(tx, productId);
  const missing: GateMissing[] = [];
  switch (gate) {
    case 'public_publish':
    case 'real_leads':
      missing.push(...missingParams(params, GATE_PARAMETER_KEYS[gate]));
      if (working)
        missing.push(...(await hostMissing(tx, product.siteId, params, now)));
      break;
    case 'spend':
      missing.push(...missingParams(params, GATE_PARAMETER_KEYS.spend));
      missing.push(...budgetConsistencyMissing(params, false));
      missing.push(...(await budgetMissing(tx, productId, params)));
      missing.push(
        ...(await reconcileMissing(
          tx,
          productId,
          ctx.category ? [ctx.category] : ['tools', 'other'],
        )),
      );
      break;
    case 'purchases':
      missing.push(...missingParams(params, GATE_PARAMETER_KEYS.purchases));
      missing.push(...budgetConsistencyMissing(params, true));
      missing.push(...(await budgetMissing(tx, productId, params)));
      missing.push(...(await integrationsMissing(tx, productId, now)));
      missing.push(...(await reconcileMissing(tx, productId, null)));
      if (working && product.mode !== 'live') {
        missing.push({ kind: 'product', key: 'mode', detail: product.mode });
      }
      if (ctx.placement) {
        if (!ctx.placement.observationOk) {
          missing.push({
            kind: 'observation',
            key: 'free_observation_7d',
            detail: 'pending',
          });
        }
        if (ctx.placement.purchaseSeq >= 3 && !ctx.placement.reportDecisionId) {
          missing.push({
            kind: 'report_decision',
            key: 'reportDecisionId',
            detail: 'required',
          });
        }
      }
      break;
    case 'ai_use':
      missing.push(...(await aiMissing(tx, productId, params, ctx.ai)));
      break;
    case 'reddit_publish':
      // P-R M2 (Р-RD-9, Р-RD-53): копирование Reddit-текста — только
      // утверждённые ключи продукта; параметры сайта не нужны. Стадия
      // публикации — отдельно (`public_publish` + продукт live).
      missing.push(
        ...missingParams(params, GATE_PARAMETER_KEYS.reddit_publish),
      );
      break;
  }
  return done(missing);
}

@Injectable()
export class GateService implements GatePort {
  evaluate(
    tx: PubTx,
    product: ProductRef,
    gate: GateName,
    now: Date,
    ctx?: GateContext,
  ): Promise<GateResult> {
    return evaluateGate(tx, product.id, gate, now, ctx);
  }

  /**
   * Аудит P1-1: сначала блокировка строки продукта (`lockProduct`, FOR NO
   * KEY UPDATE) — решения по параметрам и смена режима берут ту же
   * блокировку, поэтому гейт, открытый здесь, остаётся открытым до фиксации
   * операции. Вставки в дочерние таблицы (FK, KEY SHARE) не блокируются.
   */
  async assertOpen(
    tx: PubTx,
    product: ProductRef,
    gate: GateName,
    now: Date,
    ctx?: GateContext,
  ): Promise<void> {
    await lockProduct(tx, product);
    const r = await evaluateGate(tx, product.id, gate, now, ctx);
    if (!r.open) {
      throw new PubError('PUB_GATE_CLOSED', { gate, missing: r.missing });
    }
  }
}
