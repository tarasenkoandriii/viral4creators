/**
 * AI Publisher, P-R-ADM v1.4 — состояние AI платформенного продукта для
 * вкладки «Reddit» Админки (Р-RD-ADM-14, -15; аудит S2-1):
 *
 *  - `aiGateState` — гейт `ai_use` и доступность генератора
 *    `pub.reddit.draft` (флаг, выключен до eval 2.3, стенд E2E);
 *  - `aiMonthState` — открыт ли месяц AI и почему нет;
 *  - `platformBudgetHint` — подсказка бюджетных ключей «только AI»: закупок
 *    у платформенного продукта нет (размещения, резерв и потолок закупки —
 *    0), инструменты = потолок месяца AI по курсу × `PLATFORM_AI_MONTHS`.
 *
 * Чистые функции: данные читает сервис, решения — оператор (подсказка
 * ничего не пишет).
 */
import type { GateMissing } from '../../contracts/common';
import type { ParameterValues } from '../../contracts/parameters';
import { monthCommitMinor } from '../../ai/ai-month.job';

/** Месяцев AI в подсказке бюджета (пилот на год; оператор меняет). */
export const PLATFORM_AI_MONTHS = 12;

export type AdminAiGateReason =
  'flag_off' | 'generator_disabled' | 'gate_closed';

export interface AdminAiGate {
  /** Гейт `ai_use` открыт (параметры и привязка AI; без контекста вызова). */
  open: boolean;
  missing: GateMissing[];
  /** Генератор `pub.reddit.draft` включён (eval 2.3 или стенд E2E). */
  generatorEnabled: boolean;
  /** Первая причина, по которой генерация сейчас недоступна; null — доступна. */
  reason: AdminAiGateReason | null;
}

export function aiGateState(input: {
  flagOn: boolean;
  generatorEnabled: boolean;
  gate: { open: boolean; missing: GateMissing[] };
}): AdminAiGate {
  const { gate: g, generatorEnabled } = input;
  const reason: AdminAiGateReason | null = !input.flagOn
    ? 'flag_off'
    : !generatorEnabled
      ? 'generator_disabled'
      : !g.open
        ? 'gate_closed'
        : null;
  return { open: g.open, missing: g.missing, generatorEnabled, reason };
}

export type AdminAiMonthReason =
  | 'ai_params_missing'
  | 'spend_gate_closed'
  | 'month_not_open'
  | 'cap_exhausted';

export interface AdminAiMonth {
  /** Месяц Kyiv `YYYY-MM`. */
  month: string;
  /** Строка месяца есть (обязательство `tools` записано). */
  open: boolean;
  reason: AdminAiMonthReason | null;
  /** Чего не хватает: ключи AI или пункты гейта `spend`. */
  missing: GateMissing[];
}

/**
 * Месяц открыт — свободный остаток > 0 или `cap_exhausted`. Не открыт:
 * не утверждены ключи AI (`ai_params_missing`) → закрыт гейт `spend`
 * (`spend_gate_closed`, его пункты) → `month_not_open` (ждёт прохода
 * `ai-month-open`; бюджет не вмещает потолок; функций P-C нет).
 */
export function aiMonthState(input: {
  month: string;
  row: {
    capMicroUsd: bigint;
    spentMicroUsd: bigint;
    reservedMicroUsd: bigint;
  } | null;
  aiParamsMissing: GateMissing[];
  spend: { open: boolean; missing: GateMissing[] } | null;
}): AdminAiMonth {
  const { month, row } = input;
  if (row) {
    const free = row.capMicroUsd - row.spentMicroUsd - row.reservedMicroUsd;
    return {
      month,
      open: true,
      reason: free > 0n ? null : 'cap_exhausted',
      missing: [],
    };
  }
  if (input.aiParamsMissing.length) {
    return {
      month,
      open: false,
      reason: 'ai_params_missing',
      missing: input.aiParamsMissing,
    };
  }
  if (input.spend && !input.spend.open) {
    return {
      month,
      open: false,
      reason: 'spend_gate_closed',
      missing: input.spend.missing,
    };
  }
  return { month, open: false, reason: 'month_not_open', missing: [] };
}

export interface PlatformBudgetHint {
  /** Платформенный продукт: закупок нет, бюджет — только AI. */
  mode: 'ai_only';
  currency: string;
  months: number;
  /** Обязательство одного месяца AI в валюте бюджета; null — нет курса. */
  aiMonthMinor: number | null;
  /** Значения для предложения; null — сначала утвердить `ai_fx_rate`. */
  values: {
    budget_total: ParameterValues['budget_total'];
    budget_split: ParameterValues['budget_split'];
    per_purchase_max: ParameterValues['per_purchase_max'];
  } | null;
}

/** Подсказка бюджетных ключей из текущих значений `ai_*` и валюты. */
export function platformBudgetHint(values: {
  ai_budget_usd_month?: unknown;
  ai_fx_rate?: unknown;
  budget_total?: unknown;
}): PlatformBudgetHint {
  const cur = (values.budget_total as { currency?: unknown } | undefined)
    ?.currency;
  const currency = typeof cur === 'string' ? cur : 'UAH';
  const micro = (values.ai_budget_usd_month as { microUsd?: unknown })
    ?.microUsd;
  const rate = (values.ai_fx_rate as { rate?: unknown })?.rate;
  let aiMonthMinor: number | null = null;
  if (
    typeof micro === 'number' &&
    Number.isSafeInteger(micro) &&
    micro > 0 &&
    typeof rate === 'string'
  ) {
    try {
      const m = monthCommitMinor(BigInt(micro), rate);
      if (m > 0n && m <= BigInt(Number.MAX_SAFE_INTEGER))
        aiMonthMinor = Number(m);
    } catch {
      aiMonthMinor = null;
    }
  }
  const tools =
    aiMonthMinor !== null ? aiMonthMinor * PLATFORM_AI_MONTHS : null;
  return {
    mode: 'ai_only',
    currency,
    months: PLATFORM_AI_MONTHS,
    aiMonthMinor,
    values:
      tools !== null && Number.isSafeInteger(tools)
        ? {
            budget_total: { amountMinor: tools, currency },
            budget_split: {
              placementsMinor: 0,
              toolsMinor: tools,
              reserveMinor: 0,
            },
            per_purchase_max: { amountMinor: 0 },
          }
        : null,
  };
}
