/**
 * AI Publisher — валидаторы значений параметров (P-A1, проектный документ
 * §6.2): форма каждого ключа (`contracts/parameters.ts`), условия
 * утверждения (значение-допущение может быть неполным, утверждённое — нет)
 * и согласованность бюджетных ключей между собой.
 *
 * Чистый модуль.
 */
import type { FieldIssue } from '../contracts/errors';
import {
  DEFAULT_PARAMETER_VALUES,
  type ParameterKey,
  type ParameterValues,
} from '../contracts/parameters';
import { CONSENT_STATES, EVENT_NAMES, PUB_ROLES } from '../contracts/states';
import { FX_RATE_RE } from './money';
import { s, type SchemaLite } from './schema-lite';

const text = (max = 2000) => s.string({ min: 1, max });
const optText = (max = 2000) => s.nullable(s.string({ min: 1, max }));
const minor = (min = 0) => s.int({ min, max: Number.MAX_SAFE_INTEGER });
const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HTTPS = /^https:\/\/[^\s/?#]+[^\s]*$/;
const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Origin тестового хоста — тот же фильтр, что у `pub_public_products`. */
export const TEST_ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/;
const ALT_HREF = /^(https:\/\/[^\s]+|mailto:[^\s]+|tel:\+?[0-9 ()-]{5,30})$/;

const eventEntry = s.object({
  name: s.enum(EVENT_NAMES),
  trigger: text(500),
  fields: s.array(
    s.string({ min: 1, max: 64, pattern: /^[A-Za-z][A-Za-z0-9_.]*$/ }),
    {
      max: 30,
      unique: true,
    },
  ),
  collector: text(100),
  eventIdRule: text(500),
  historyDays: s.int({ min: 1, max: 3650 }),
  excludeTest: s.boolean(),
  leadJoin: text(500),
});

const rateValue = s.nullable(minor());

export const PARAMETER_SCHEMAS: {
  [K in ParameterKey]: SchemaLite<ParameterValues[K]>;
} = {
  niche: s.object({ text: text(300) }),
  language: s.object({
    code: s.string({
      min: 2,
      max: 35,
      pattern: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
    }),
  }),
  market: s.object({
    country: s.string({ min: 2, max: 2, pattern: /^[A-Z]{2}$/ }),
  }),
  offer_active_version: s.object({
    offerVersionId: s.nullable(s.string({ min: 1, max: 64 })),
    version: s.nullable(s.int({ min: 1 })),
  }),
  own_channels: s.object({
    channels: s.array(
      s.object({
        code: s.string({ min: 1, max: 64, pattern: CODE }),
        name: text(120),
        url: s.nullable(s.string({ min: 9, max: 2048, pattern: HTTPS })),
      }),
      { max: 10 },
    ),
  }),
  domain_host: s.object({
    host: s.nullable(s.string({ min: 3, max: 253, pattern: HOST })),
  }),
  hosting: s.object({ provider: text(100), note: optText() }),
  attribution_tool: s.object({ tool: text(100), note: optText() }),
  consent_map: s.object({ default: s.enum(CONSENT_STATES), note: optText() }),
  analytics_storage: s.enum(['none', 'session'] as const),
  event_map: s.refine(
    s.object({
      version: text(20),
      events: s.array(eventEntry, { min: 1, max: 10 }),
    }),
    (v) =>
      new Set(v.events.map((e) => e.name)).size === v.events.length
        ? null
        : { field: 'events', code: 'duplicate' },
  ),
  perf_targets: s.object({
    leadsP95Ms: s.int({ min: 1, max: 60_000 }),
    leadsRps: s.number({ min: 0.1, max: 1000 }),
    parallelSubmits: s.int({ min: 1, max: 1000 }),
    publicReadP95Ms: s.int({ min: 1, max: 60_000 }),
    mainTextInFirstHtml: s.boolean(),
    protocolRef: optText(500),
  }),
  data_notice_version: s.object({ version: text(50), text: text(20_000) }),
  retention_policy: s.object({
    leadReviewDays: s.int({ min: 1, max: 3650 }),
    closedReviewDays: s.int({ min: 1, max: 3650 }),
    backupRotationDays: s.int({ min: 1, max: 3650 }),
  }),
  budget_total: s.object({
    amountMinor: minor(1),
    currency: s.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
  }),
  budget_split: s.object({
    placementsMinor: minor(),
    toolsMinor: minor(),
    reserveMinor: minor(),
  }),
  per_purchase_max: s.object({ amountMinor: minor(1) }),
  ai_budget_usd_month: s.object({ microUsd: minor() }),
  // Аудит P3-8: формат — тот же `FX_RATE_RE`, что у `parseFxRate` (без
  // ведущих нулей), и курс > 0 — иначе утверждённое значение давало 500.
  ai_fx_rate: s.refine(
    s.object({
      rate: s.nullable(s.string({ min: 1, max: 30, pattern: FX_RATE_RE })),
      source: optText(300),
      at: s.nullable(s.string({ min: 10, max: 40, pattern: ISO })),
    }),
    (v) =>
      v.rate !== null && !/[1-9]/.test(v.rate)
        ? { field: 'rate', code: 'range' }
        : null,
  ),
  ai_unpriced_allowed: s.object({ allowed: s.boolean() }),
  rates_by_role: s.object({
    currency: s.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
    rates: s.object({
      product_owner: rateValue,
      editor: rateValue,
      operator: rateValue,
      analyst: rateValue,
      sales: rateValue,
      viewer: rateValue,
      admin: rateValue,
    }),
  }),
  allowed_cpl_inputs: s.object({
    contributionMinor: s.nullable(
      s.int({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
    ),
    pPayBp: s.nullable(s.int({ min: 0, max: 10_000 })),
    shareBp: s.nullable(s.int({ min: 1, max: 10_000 })),
  }),
  investment_cpl_limit: s.object({ amountMinor: s.nullable(minor(1)) }),
  dev_investment: s.object({
    amountMinor: s.nullable(minor()),
    hours: s.nullable(s.int({ min: 0, max: 1_000_000 })),
    note: optText(),
  }),
  cac_payment_window: s.refine(
    s.object({
      until: s.enum(['t72', 't90', 'days'] as const),
      days: s.nullable(s.int({ min: 1, max: 365 })),
    }),
    (v) =>
      (v.until === 'days') === (v.days !== null)
        ? null
        : { field: 'days', code: 'required' },
  ),
  d42_thresholds: s.object({
    sessions: s.int({ min: 0, max: 10_000_000 }),
    qualified: s.int({ min: 0, max: 100_000 }),
    proposals: s.int({ min: 0, max: 100_000 }),
    // AT-F17-02: «одна заявка — победителя нет»; пол заключения — 2
    // (`reports/metrics/economics.ts` MIN_SAMPLE_FLOOR, аудит P-E S2-6).
    minSampleForConclusion: s.int({ min: 2, max: 100_000 }),
  }),
  d90_thresholds: s.refine(
    s.object({
      indexedPages: s.int({ min: 0, max: 10_000 }),
      pagesTotal: s.int({ min: 1, max: 10_000 }),
      pagesWithClicks28d: s.int({ min: 0, max: 10_000 }),
    }),
    (v) =>
      v.indexedPages <= v.pagesTotal && v.pagesWithClicks28d <= v.pagesTotal
        ? null
        : { field: 'pagesTotal', code: 'range' },
  ),
  late_cohort_rules: s.object({
    closeAfterDays: s.int({ min: 1, max: 365 }),
    explicitEndRequired: s.boolean(),
  }),
  qualification_rules: s.object({
    externalOnly: s.boolean(),
    requireConfirmedInterest: s.boolean(),
    budgetUnknownAllowed: s.boolean(),
    note: optText(),
  }),
  responsibles: s.object({
    formOwnerMemberId: s.nullable(
      s.string({ min: 1, max: 64, pattern: MEMBER_ID }),
    ),
    salesMemberIds: s.array(s.string({ min: 1, max: 64, pattern: MEMBER_ID }), {
      max: 20,
      unique: true,
    }),
    afterT72MemberId: s.nullable(
      s.string({ min: 1, max: 64, pattern: MEMBER_ID }),
    ),
  }),
  sales_hours_t42_t72: s.object({
    minutes: s.nullable(s.int({ min: 0, max: 100_000 })),
  }),
  contact_sla: s.object({
    rule: s.literal('next_business_day_end'),
    calendar: s.object({
      workdays: s.array(s.int({ min: 1, max: 7 }), {
        min: 1,
        max: 7,
        unique: true,
      }),
      holidays: s.array(s.string({ min: 10, max: 10, pattern: DATE }), {
        max: 400,
        unique: true,
      }),
      dayEnd: s.string({
        min: 5,
        max: 5,
        pattern: /^([01]\d|2[0-3]):[0-5]\d$/,
      }),
    }),
  }),
  form_limit: s.object({
    count: s.int({ min: 1, max: 1000 }),
    windowSec: s.int({ min: 1, max: 86_400 }),
  }),
  alt_contact: s.object({
    label: s.string({ min: 1, max: 200 }),
    href: s.nullable(s.string({ min: 5, max: 500, pattern: ALT_HREF })),
  }),
  test_hosts: s.array(s.string({ min: 9, max: 300, pattern: TEST_ORIGIN_RE }), {
    max: 10,
    unique: true,
  }),
  pilot_calendar: s.object({
    t0Planned: s.nullable(s.string({ min: 10, max: 40, pattern: ISO })),
  }),
  launch_evidence_d0: s.object({
    qaRunId: s.nullable(s.string({ min: 1, max: 100 })),
    perfProtocolRef: optText(500),
    note: optText(),
  }),
  launch_evidence_purchase: s.object({
    qaRunId: s.nullable(s.string({ min: 1, max: 100 })),
    note: optText(),
  }),
  reddit_rules_stale_days: s.object({ days: s.int({ min: 1, max: 365 }) }),
  reddit_excerpt_retention_days: s.object({
    days: s.int({ min: 1, max: 3650 }),
  }),
};

/** Форма значения ключа (пустой список — подходит). */
export function parameterValueIssues(
  key: ParameterKey,
  value: unknown,
): FieldIssue[] {
  return PARAMETER_SCHEMAS[key]
    .validate(value, 'value')
    .map((i) => ({ field: i.field, code: i.code }));
}

const need = (cond: boolean, field: string, code = 'required'): FieldIssue[] =>
  cond ? [] : [{ field, code }];

/**
 * Заглушка умолчания (Р-PUB-Z2-26, предаудит DEF-C-04): значение, которое
 * P-A1 сеет как ЧЕРНОВИК («Чернетка… потребує затвердження власником»), —
 * не решение владельца. Утвердить его нельзя (400 `draft_placeholder`), а
 * уже утверждённая заглушка не открывает гейты (`{kind:'parameter',
 * detail:'placeholder'}`). Признак — версия умолчания (`draft-…`), текст
 * умолчания или текст, начинающийся с «Чернетка». Сейчас заглушка одна —
 * уведомление о данных; новые ключи-заглушки добавляются сюда.
 */
export function parameterPlaceholderIssues(
  key: ParameterKey,
  value: unknown,
): FieldIssue[] {
  if (key !== 'data_notice_version') return [];
  const v = value as Partial<ParameterValues['data_notice_version']> | null;
  if (!v || typeof v !== 'object') return [];
  const d = DEFAULT_PARAMETER_VALUES.data_notice_version;
  const draftVersion =
    typeof v.version === 'string' &&
    (v.version === d.version || /^draft(?:[-_.\s]|$)/i.test(v.version.trim()));
  const draftText =
    typeof v.text === 'string' &&
    (v.text.trim() === d.text || /^\s*чернетка/i.test(v.text));
  return [
    ...(draftVersion
      ? [{ field: 'value.version', code: 'draft_placeholder' }]
      : []),
    ...(draftText ? [{ field: 'value.text', code: 'draft_placeholder' }] : []),
  ];
}

/**
 * Утверждаемое значение должно быть полным: допущение может хранить
 * «ещё неизвестно» (`null`), решение владельца — нет (§6.2, ТЗ §16: при
 * неизвестном вкладе допустимый CPL не утверждается).
 */
export function parameterApprovalIssues(
  key: ParameterKey,
  value: unknown,
): FieldIssue[] {
  const shape = parameterValueIssues(key, value);
  if (shape.length) return shape;
  const placeholder = parameterPlaceholderIssues(key, value);
  if (placeholder.length) return placeholder;
  switch (key) {
    case 'offer_active_version': {
      const v = value as ParameterValues['offer_active_version'];
      return need(
        v.offerVersionId !== null && v.version !== null,
        'value.offerVersionId',
      );
    }
    case 'own_channels':
      return need(
        (value as ParameterValues['own_channels']).channels.length >= 1,
        'value.channels',
      );
    case 'domain_host':
      return need(
        (value as ParameterValues['domain_host']).host !== null,
        'value.host',
      );
    case 'ai_fx_rate': {
      const v = value as ParameterValues['ai_fx_rate'];
      return [
        ...need(v.rate !== null && Number(v.rate) > 0, 'value.rate'),
        ...need(v.source !== null, 'value.source'),
        ...need(v.at !== null, 'value.at'),
      ];
    }
    case 'rates_by_role': {
      const v = value as ParameterValues['rates_by_role'];
      // Ставка viewer/admin может остаться неизвестной (труд не учитывается),
      // ролей, которые работают по смете ТЗ §17, — нет.
      return (
        ['product_owner', 'editor', 'operator', 'analyst', 'sales'] as const
      ).flatMap((r) => need(v.rates[r] !== null, `value.rates.${r}`));
    }
    case 'allowed_cpl_inputs': {
      const v = value as ParameterValues['allowed_cpl_inputs'];
      return [
        ...need(v.contributionMinor !== null, 'value.contributionMinor'),
        ...need(v.pPayBp !== null, 'value.pPayBp'),
        ...need(v.shareBp !== null, 'value.shareBp'),
      ];
    }
    case 'dev_investment':
      // Утверждается только оценённый пакет (0 — явное «разработки нет»).
      return need(
        (value as ParameterValues['dev_investment']).amountMinor !== null,
        'value.amountMinor',
      );
    case 'investment_cpl_limit':
      return need(
        (value as ParameterValues['investment_cpl_limit']).amountMinor !== null,
        'value.amountMinor',
      );
    case 'responsibles': {
      const v = value as ParameterValues['responsibles'];
      return [
        ...need(v.formOwnerMemberId !== null, 'value.formOwnerMemberId'),
        ...need(v.salesMemberIds.length >= 1, 'value.salesMemberIds'),
      ];
    }
    case 'sales_hours_t42_t72':
      return need(
        (value as ParameterValues['sales_hours_t42_t72']).minutes !== null,
        'value.minutes',
      );
    case 'alt_contact':
      return need(
        (value as ParameterValues['alt_contact']).href !== null,
        'value.href',
      );
    case 'pilot_calendar':
      return need(
        (value as ParameterValues['pilot_calendar']).t0Planned !== null,
        'value.t0Planned',
      );
    case 'launch_evidence_d0': {
      const v = value as ParameterValues['launch_evidence_d0'];
      return [
        ...need(v.qaRunId !== null, 'value.qaRunId'),
        ...need(v.perfProtocolRef !== null, 'value.perfProtocolRef'),
      ];
    }
    case 'launch_evidence_purchase':
      return need(
        (value as ParameterValues['launch_evidence_purchase']).qaRunId !== null,
        'value.qaRunId',
      );
    case 'perf_targets':
      return need(
        (value as ParameterValues['perf_targets']).protocolRef !== null,
        'value.protocolRef',
      );
    default:
      return [];
  }
}

/** Несогласованность бюджетных ключей — пункт гейта `budget/inconsistent`. */
export interface BudgetInconsistency {
  /** Ключ, который надо поменять, чтобы пара сошлась. */
  key: 'budget_split' | 'per_purchase_max' | 'rates_by_role';
  detail: 'inconsistent';
  /** `sum` — категории ≠ общий лимит; `over_placements`; `currency`. */
  check: 'sum' | 'over_placements' | 'currency';
}

/**
 * Согласованность бюджетных ключей (ТЗ §15, §17, §25; аудит P2-1, P3-7):
 * категории + резерв = общий лимит; одна закупка ≤ лимита размещений;
 * валюта ставок = валюта бюджета (у `budget_split`, `per_purchase_max`,
 * `allowed_cpl_inputs` валюта неявная — это валюта `budget_total`).
 *
 * НЕ условие решения: каждое решение — один ключ, и смена суммы бюджета
 * (10 000 → 12 000) идёт двумя решениями; между ними пара не сходится.
 * Поэтому проверка живёт в гейтах `spend`/`purchases` (пункт
 * `{kind:'budget', key, detail:'inconsistent'}`) и в контракте
 * `BudgetLimitPort.applyParameters` (P-C не собирает лимит из
 * несогласованных значений и НЕ бросает — решение должно пройти). Чистая
 * функция; значения — действующие, любого статуса.
 */
export function budgetConsistencyIssues(
  values: Partial<{ [K in ParameterKey]: unknown }>,
): BudgetInconsistency[] {
  const t = values.budget_total as ParameterValues['budget_total'] | undefined;
  const sp = values.budget_split as ParameterValues['budget_split'] | undefined;
  const pp = values.per_purchase_max as
    ParameterValues['per_purchase_max'] | undefined;
  const rates = values.rates_by_role as
    ParameterValues['rates_by_role'] | undefined;
  const out: BudgetInconsistency[] = [];
  if (
    t &&
    sp &&
    sp.placementsMinor + sp.toolsMinor + sp.reserveMinor !== t.amountMinor
  ) {
    out.push({ key: 'budget_split', detail: 'inconsistent', check: 'sum' });
  }
  if (sp && pp && pp.amountMinor > sp.placementsMinor) {
    out.push({
      key: 'per_purchase_max',
      detail: 'inconsistent',
      check: 'over_placements',
    });
  }
  if (t && rates && rates.currency !== t.currency) {
    out.push({
      key: 'rates_by_role',
      detail: 'inconsistent',
      check: 'currency',
    });
  }
  return out;
}

/** Самопроверка: умолчания проходят свои схемы (тест — parameter-schemas.spec). */
export function defaultValueIssues(): Array<{
  key: ParameterKey;
  issues: FieldIssue[];
}> {
  return (Object.keys(DEFAULT_PARAMETER_VALUES) as ParameterKey[])
    .map((key) => ({
      key,
      issues: parameterValueIssues(key, DEFAULT_PARAMETER_VALUES[key]),
    }))
    .filter((x) => x.issues.length > 0);
}

// PUB_ROLES держит список ставок в одном месте с ролями (тест сверяет).
export const RATE_ROLES = [...PUB_ROLES, 'admin'] as const;
