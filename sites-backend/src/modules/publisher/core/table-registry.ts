/**
 * AI Publisher — реестр таблиц продукта (P-A1, проектный документ §6.8,
 * §15.4): упорядоченный по внешним ключам список `pub_*` с колонками,
 * владельцем-пакетом, признаком экспорта и шифрованными колонками.
 *
 *  - экспорт/восстановление (P-E, `reports/backup.service.ts`,
 *    `restore.service.ts`) пишут строки в этом порядке: родитель раньше
 *    ребёнка (ссылки ВНУТРИ таблицы — `supersedesId` и т. п. — порядок строк
 *    внутри таблицы держит P-E);
 *  - `table-ownership.spec.ts` берёт отсюда владельцев (§6.8);
 *  - строится из DMMF Prisma — новая модель `Pub*` попадает сюда сама, а
 *    тест требует, чтобы у неё был владелец.
 *
 * Межпродуктовые ссылки (Р-PUB-A0-4: конфигурация eval-продукта, копия
 * исходного продукта, целевой продукт восстановления) в порядок не входят.
 */
import { Prisma } from '@prisma/client';

export type PackageId =
  | 'P-A1'
  | 'P-B1'
  | 'P-B2'
  | 'P-C'
  | 'P-D'
  | 'P-E'
  /** Reddit Manual MVP (reddit-manual-mvp-adapted.md §1): только `pub_reddit_*`. */
  | 'P-R';

/** Кто пишет таблицу (§6.8). `pub_approvals` — по типам: P-B1, P-B2, P-C. */
export const TABLE_OWNERS: Readonly<Record<string, readonly PackageId[]>> = {
  pub_products: ['P-A1'],
  pub_parameters: ['P-A1'],
  pub_parameter_proposals: ['P-A1'],
  pub_parameter_decisions: ['P-A1'],
  pub_role_grants: ['P-A1'],
  pub_audit_events: ['P-A1'],
  pub_idempotency_keys: ['P-A1'],
  pub_review_tasks: ['P-A1'],
  pub_campaigns: ['P-A1'],
  pub_sources: ['P-B1'],
  pub_source_revocations: ['P-B1'],
  pub_question_groups: ['P-B1'],
  pub_questions: ['P-B1'],
  pub_question_sources: ['P-B1'],
  pub_brand_facts: ['P-B1'],
  pub_offer_versions: ['P-B1'],
  pub_offer_facts: ['P-B1'],
  pub_version_facts: ['P-B1'],
  pub_briefs: ['P-B1'],
  pub_brief_sources: ['P-B1'],
  pub_contents: ['P-B1'],
  pub_content_versions: ['P-B1'],
  pub_version_sources: ['P-B1'],
  pub_version_claims: ['P-B1'],
  pub_claims: ['P-B1'],
  pub_claim_sources: ['P-B1'],
  pub_qa_checks: ['P-B1'],
  pub_approvals: ['P-B1', 'P-B2', 'P-C'],
  pub_ai_configs: ['P-B2'],
  pub_ai_config_bindings: ['P-B2'],
  pub_ai_tasks: ['P-B2'],
  pub_ai_budget_months: ['P-B2'],
  pub_ai_calls: ['P-B2'],
  pub_ai_eval_runs: ['P-B2'],
  pub_ai_eval_results: ['P-B2'],
  pub_channels: ['P-C'],
  pub_distribution_actions: ['P-C'],
  pub_publications: ['P-C'],
  pub_venues: ['P-C'],
  pub_venue_evidence: ['P-C'],
  pub_placements: ['P-C'],
  pub_budget_limits: ['P-C'],
  pub_reserve_moves: ['P-C'],
  pub_expenses: ['P-C'],
  pub_expense_entries: ['P-C'],
  pub_prospects: ['P-D'],
  pub_lead_prospect_links: ['P-D'],
  pub_leads: ['P-D'],
  pub_lead_contacts: ['P-D'],
  pub_lead_decisions: ['P-D'],
  pub_erasures: ['P-D'],
  pub_payments: ['P-D'],
  pub_sessions: ['P-D'],
  pub_events: ['P-D'],
  pub_lead_outbox: ['P-D'],
  pub_notifications: ['P-D'],
  pub_queue_checks: ['P-D'],
  pub_rate_hits: ['P-D'],
  pub_time_entries: ['P-E'],
  pub_metric_imports: ['P-E'],
  pub_experiments: ['P-E'],
  pub_experiment_contents: ['P-E'],
  pub_reports: ['P-E'],
  pub_integrations: ['P-E'],
  pub_backups: ['P-E'],
  pub_restores: ['P-E'],
  pub_reddit_projects: ['P-R'],
  pub_reddit_communities: ['P-R'],
  pub_reddit_rule_snapshots: ['P-R'],
  pub_reddit_keywords: ['P-R'],
  pub_reddit_opportunities: ['P-R'],
  pub_reddit_briefs: ['P-R'],
};

/** Не экспортируются (§15.4): вне тенанта, служебные очереди. */
export const NOT_EXPORTED = [
  'pub_rate_hits',
  'pub_idempotency_keys',
  'pub_notifications',
  'pub_lead_outbox',
] as const;

/** Шифротексты (переносятся как есть; перешифровка — под новый AAD). */
export const ENCRYPTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  pub_lead_contacts: ['contactEnc', 'matchHash'],
  pub_prospects: ['noteEnc'],
  pub_lead_decisions: ['noteEnc'],
  pub_backups: ['blobPathEnc'],
};

/** Ссылки на строку ДРУГОГО продукта (Р-PUB-A0-4) — вне порядка. */
export const CROSS_PRODUCT_REFS: ReadonlyArray<
  [model: string, column: string]
> = [
  ['PubProduct', 'restoredFromBackupId'],
  ['PubRestore', 'targetProductId'],
  ['PubAiConfigBinding', 'configId'],
  ['PubAiCall', 'configId'],
];

/**
 * Обратные ссылки циклов FK (необязательные колонки): при восстановлении
 * строка пишется с NULL, колонка — вторым проходом UPDATE после детей
 * (§15.4). Тест: без них граф ацикличен, все — nullable.
 */
export const DEFERRED_REFS: ReadonlyArray<[model: string, column: string]> = [
  ['PubParameterProposal', 'decisionId'],
  ['PubContent', 'currentVersionId'],
  ['PubContent', 'approvedVersionId'],
  ['PubContent', 'publishedVersionId'],
  ['PubPlacement', 'expenseId'],
  ['PubAiConfig', 'evalRunId'],
];

export interface PubTableInfo {
  model: string;
  table: string;
  /** Имя делегата Prisma (`pubLeadContact`). */
  delegate: string;
  columns: string[];
  /** Ссылки на другие таблицы продукта (колонка → модель). */
  refs: Array<{ columns: string[]; model: string; table: string }>;
  /** Колонки второго прохода (обратные ссылки циклов, `DEFERRED_REFS`). */
  deferred: Array<{ column: string; model: string; table: string }>;
  owners: readonly PackageId[];
  exported: boolean;
  encrypted: readonly string[];
}

export interface DmmfField {
  name: string;
  kind: string;
  type: string;
  relationName?: string;
  relationFromFields?: readonly string[];
}
export interface DmmfModel {
  name: string;
  dbName: string | null;
  fields: readonly DmmfField[];
}

function pubModels(): DmmfModel[] {
  return (Prisma.dmmf.datamodel.models as unknown as DmmfModel[]).filter((m) =>
    /^Pub[A-Z]/.test(m.name),
  );
}

/**
 * Колонки внешнего ключа поля-связи. Рантайм-DMMF Prisma 7 не несёт
 * `relationFromFields`, поэтому — по соглашению схемы P-A0: связь на
 * стороне ключа называется `<Модель>_<поле>`, колонка — `<поле>Id`
 * (+ `accountId` составного FK). Тест сверяет с `schema.prisma`.
 */
export function fkColumnsOf(model: DmmfModel, f: DmmfField): string[] {
  if (f.relationFromFields && f.relationFromFields.length)
    return [...f.relationFromFields];
  if (f.relationName !== `${model.name}_${f.name}`) return [];
  const col = `${f.name}Id`;
  return model.fields.some((x) => x.name === col && x.kind === 'scalar')
    ? [col, 'accountId']
    : [];
}

export function buildTableRegistry(
  models: readonly DmmfModel[] = pubModels(),
): PubTableInfo[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  const tableOf = (m: DmmfModel) => m.dbName ?? m.name;
  const cross = new Set(CROSS_PRODUCT_REFS.map(([m, c]) => `${m}.${c}`));
  const deferredSet = new Set(DEFERRED_REFS.map(([m, c]) => `${m}.${c}`));
  const infos = new Map<string, PubTableInfo>();
  for (const m of models) {
    const links = m.fields
      .filter(
        (f) => f.kind === 'object' && byName.has(f.type) && f.type !== m.name,
      )
      .map((f) => ({ f, cols: fkColumnsOf(m, f) }))
      .filter(
        ({ cols }) =>
          cols.length > 0 && !cols.some((c) => cross.has(`${m.name}.${c}`)),
      );
    const isDeferred = (cols: string[]) =>
      cols.some((c) => deferredSet.has(`${m.name}.${c}`));
    const deferred = links
      .filter(({ cols }) => isDeferred(cols))
      .map(({ f, cols }) => {
        const target = byName.get(f.type) as DmmfModel;
        return {
          column: cols.find((c) => c !== 'accountId') as string,
          model: target.name,
          table: tableOf(target),
        };
      });
    const refs = links
      .filter(({ cols }) => !isDeferred(cols))
      .map(({ f, cols }) => {
        const target = byName.get(f.type) as DmmfModel;
        return {
          columns: cols.filter((c) => c !== 'accountId'),
          model: target.name,
          table: tableOf(target),
        };
      });
    const table = tableOf(m);
    infos.set(m.name, {
      model: m.name,
      table,
      delegate: m.name.charAt(0).toLowerCase() + m.name.slice(1),
      columns: m.fields
        .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
        .map((f) => f.name),
      refs,
      deferred,
      owners: TABLE_OWNERS[table] ?? [],
      exported: !(NOT_EXPORTED as readonly string[]).includes(table),
      encrypted: ENCRYPTED_COLUMNS[table] ?? [],
    });
  }
  // Kahn: родитель раньше ребёнка; при равенстве — по имени таблицы.
  const pending = new Map(
    [...infos.values()].map((i) => [
      i.model,
      new Set(i.refs.map((r) => r.model)),
    ]),
  );
  const out: PubTableInfo[] = [];
  while (pending.size > 0) {
    const ready = [...pending.entries()]
      .filter(([, deps]) => [...deps].every((d) => !pending.has(d)))
      .map(([name]) => infos.get(name) as PubTableInfo)
      .sort((a, b) => a.table.localeCompare(b.table));
    if (ready.length === 0) {
      throw new Error(
        `table-registry: цикл внешних ключей среди ${[...pending.keys()].join(', ')}`,
      );
    }
    for (const r of ready) {
      out.push(r);
      pending.delete(r.model);
    }
  }
  return out;
}

let cached: PubTableInfo[] | null = null;

/** Реестр (строится один раз из DMMF). */
export function pubTableRegistry(): PubTableInfo[] {
  if (!cached) cached = buildTableRegistry();
  return cached;
}

/** Таблицы экспорта продукта в порядке FK. */
export function exportOrder(): PubTableInfo[] {
  return pubTableRegistry().filter((t) => t.exported);
}
