/**
 * AI Publisher — параметры продукта (контракт P-A1, проектный документ
 * §6.2, §10, ТЗ §26/§17): закрытый список ключей (= `pub_parameter_keys()`
 * миграции), форма значения каждого ключа, значения-допущения, которыми
 * сеется новый продукт, и какие гейты требуют утверждения ключа.
 *
 * Формы значений, которые читает представление `pub_public_products`
 * (Р-PUB-A0-10), закреплены здесь же: `form_limit {count, windowSec}`,
 * `analytics_storage "none"|"session"`, `consent_map {default, …}`,
 * `data_notice_version {version, text}`, `test_hosts ["https://…"]`.
 * Валидаторы — `core/parameter-schemas.ts` (schema-lite).
 *
 * Деньги в значениях — целые копейки JSON-числом (`amountMinor`): все
 * суммы пилота < 2^53, а в jsonb `bigint` не положить; сервис P-C читает
 * их в `bigint` (`core/money.ts`).
 *
 * Чистый модуль.
 */
import type { GateName } from './common';
import type {
  ConsentState,
  DependentStage,
  EVENT_NAMES,
  PubRole,
} from './states';

export const PARAMETER_KEYS = [
  'niche',
  'language',
  'market',
  'offer_active_version',
  'own_channels',
  'domain_host',
  'hosting',
  'attribution_tool',
  'consent_map',
  'analytics_storage',
  'event_map',
  'perf_targets',
  'data_notice_version',
  'retention_policy',
  'budget_total',
  'budget_split',
  'per_purchase_max',
  'ai_budget_usd_month',
  'ai_fx_rate',
  'ai_unpriced_allowed',
  'rates_by_role',
  'allowed_cpl_inputs',
  'investment_cpl_limit',
  'dev_investment',
  'cac_payment_window',
  'd42_thresholds',
  'd90_thresholds',
  'late_cohort_rules',
  'qualification_rules',
  'responsibles',
  'sales_hours_t42_t72',
  'contact_sla',
  'form_limit',
  'alt_contact',
  'test_hosts',
  'pilot_calendar',
  'launch_evidence_d0',
  'launch_evidence_purchase',
] as const;
export type ParameterKey = (typeof PARAMETER_KEYS)[number];

export function isParameterKey(v: unknown): v is ParameterKey {
  return (
    typeof v === 'string' && (PARAMETER_KEYS as readonly string[]).includes(v)
  );
}

// ── Формы значений ────────────────────────────────────────────────────────

export interface EventMapEntry {
  name: (typeof EVENT_NAMES)[number];
  /** Когда событие возникает (текст для утверждения). */
  trigger: string;
  /** Поля, которые допускается собирать. */
  fields: string[];
  /** Средство сбора (`own_endpoint`, …). */
  collector: string;
  /** Правило `event_id` и дедупликации. */
  eventIdRule: string;
  historyDays: number;
  /** Тестовые события исключаются из метрик. */
  excludeTest: boolean;
  /** Как событие соединяется с защищённой заявкой. */
  leadJoin: string;
}

/** Рабочий календарь Kyiv для срока первого контакта (§9.1, Р-PUB-35). */
export interface BusinessCalendar {
  /** Рабочие дни недели ISO: 1 = понедельник … 7 = воскресенье. */
  workdays: number[];
  /** Праздники и выходные-переносы, `YYYY-MM-DD` по Kyiv. */
  holidays: string[];
  /** Конец рабочего дня по Kyiv, `HH:MM`. */
  dayEnd: string;
}

export interface ParameterValues {
  niche: { text: string };
  language: { code: string };
  market: { country: string };
  offer_active_version: {
    offerVersionId: string | null;
    version: number | null;
  };
  own_channels: {
    channels: Array<{ code: string; name: string; url: string | null }>;
  };
  domain_host: { host: string | null };
  hosting: { provider: string; note: string | null };
  attribution_tool: { tool: string; note: string | null };
  consent_map: { default: ConsentState; note: string | null };
  analytics_storage: 'none' | 'session';
  event_map: { version: string; events: EventMapEntry[] };
  perf_targets: {
    leadsP95Ms: number;
    leadsRps: number;
    parallelSubmits: number;
    publicReadP95Ms: number;
    mainTextInFirstHtml: boolean;
    protocolRef: string | null;
  };
  data_notice_version: { version: string; text: string };
  retention_policy: {
    leadReviewDays: number;
    closedReviewDays: number;
    backupRotationDays: number;
  };
  budget_total: { amountMinor: number; currency: string };
  budget_split: {
    placementsMinor: number;
    toolsMinor: number;
    reserveMinor: number;
  };
  per_purchase_max: { amountMinor: number };
  ai_budget_usd_month: { microUsd: number };
  ai_fx_rate: { rate: string | null; source: string | null; at: string | null };
  ai_unpriced_allowed: { allowed: boolean };
  rates_by_role: {
    currency: string;
    /** Ставка в минимальных единицах за час; null — не утверждена. */
    rates: Record<PubRole | 'admin', number | null>;
  };
  allowed_cpl_inputs: {
    contributionMinor: number | null;
    pPayBp: number | null;
    shareBp: number | null;
  };
  investment_cpl_limit: { amountMinor: number | null };
  /**
   * Пакет разработки программного контура P0 (Р-PUB-Z2-24, предаудит
   * B1-F-02; ТЗ §17 «разработка оценивается отдельным пакетом», §15
   * инвестиционный CPL включает разработку). `amountMinor` — деньги пакета в
   * валюте бюджета (часы, AI-агенты, инфраструктура разработки), `hours` —
   * справочно. Пока `null` (допущение, сумма неизвестна) инвестиционные
   * CPL/CAC — «не менее» (неизвестное ≠ 0); операционные — без изменений.
   */
  dev_investment: {
    amountMinor: number | null;
    hours: number | null;
    note: string | null;
  };
  cac_payment_window: { until: 't72' | 't90' | 'days'; days: number | null };
  d42_thresholds: {
    sessions: number;
    qualified: number;
    proposals: number;
    minSampleForConclusion: number;
  };
  d90_thresholds: {
    indexedPages: number;
    pagesTotal: number;
    pagesWithClicks28d: number;
  };
  late_cohort_rules: { closeAfterDays: number; explicitEndRequired: boolean };
  qualification_rules: {
    externalOnly: boolean;
    requireConfirmedInterest: boolean;
    budgetUnknownAllowed: boolean;
    note: string | null;
  };
  responsibles: {
    formOwnerMemberId: string | null;
    salesMemberIds: string[];
    afterT72MemberId: string | null;
  };
  sales_hours_t42_t72: { minutes: number | null };
  contact_sla: { rule: 'next_business_day_end'; calendar: BusinessCalendar };
  form_limit: { count: number; windowSec: number };
  alt_contact: { label: string; href: string | null };
  test_hosts: string[];
  pilot_calendar: { t0Planned: string | null };
  launch_evidence_d0: {
    qaRunId: string | null;
    perfProtocolRef: string | null;
    note: string | null;
  };
  launch_evidence_purchase: { qaRunId: string | null; note: string | null };
}

// ── Гейты → ключи (§10) ───────────────────────────────────────────────────

const PUBLIC_PUBLISH_KEYS = [
  'niche',
  'language',
  'market',
  'offer_active_version',
  'domain_host',
  'hosting',
  'data_notice_version',
  'consent_map',
  'analytics_storage',
  'event_map',
  'perf_targets',
  'responsibles',
  'qualification_rules',
  'pilot_calendar',
  'launch_evidence_d0',
] as const satisfies readonly ParameterKey[];

const SPEND_KEYS = [
  'budget_total',
  'budget_split',
] as const satisfies readonly ParameterKey[];

/** Ключи, которые должны быть `approved`, чтобы гейт открылся. */
export const GATE_PARAMETER_KEYS: Readonly<
  Record<GateName, readonly ParameterKey[]>
> = {
  public_publish: PUBLIC_PUBLISH_KEYS,
  real_leads: [
    ...PUBLIC_PUBLISH_KEYS,
    'retention_policy',
    'alt_contact',
    'form_limit',
    'contact_sla',
    'sales_hours_t42_t72',
  ],
  spend: SPEND_KEYS,
  purchases: [
    ...SPEND_KEYS,
    'per_purchase_max',
    'rates_by_role',
    'allowed_cpl_inputs',
    'cac_payment_window',
    'd42_thresholds',
    'own_channels',
    'attribution_tool',
    'launch_evidence_purchase',
  ],
  ai_use: ['ai_budget_usd_month', 'ai_fx_rate'],
};

/** Гейты, которые требуют ключ (для экрана параметров). */
export function gatesOfKey(key: ParameterKey): GateName[] {
  return (Object.keys(GATE_PARAMETER_KEYS) as GateName[]).filter((g) =>
    GATE_PARAMETER_KEYS[g].includes(key),
  );
}

/**
 * Этапы, которые затрагивает решение по ключу (умолчание `dependentStages`
 * решения): гейты ключа + `reports` для порогов и правил отчётов.
 */
export function defaultDependentStages(key: ParameterKey): DependentStage[] {
  const stages = new Set<DependentStage>(gatesOfKey(key));
  if (
    [
      'rates_by_role',
      'allowed_cpl_inputs',
      'investment_cpl_limit',
      'dev_investment',
      'cac_payment_window',
      'd42_thresholds',
      'd90_thresholds',
      'late_cohort_rules',
      'qualification_rules',
    ].includes(key)
  ) {
    stages.add('reports');
  }
  if (key === 'ai_unpriced_allowed') stages.add('ai_use');
  return [...stages];
}

/**
 * Бюджетные ключи — из них P-C собирает строку `pub_budget_limits`
 * (`BudgetLimitPort.applyParameters`, §8.2). После решения по любому из них
 * ядро вызывает порт.
 */
export const BUDGET_LIMIT_PARAMETER_KEYS = [
  'budget_total',
  'budget_split',
  'per_purchase_max',
] as const satisfies readonly ParameterKey[];

/**
 * `pub_budget_limits.paramVersion` = сумма версий бюджетных ключей. Версия
 * параметра только растёт (триггер), поэтому сумма меняется при каждом
 * решении по любому из них: строка лимита, собранная из прежних версий,
 * видна гейту `spend` как устаревшая (`missing: budget/stale`). P-C пишет
 * это же число при сборке (Р-PUB-A1-5).
 */
export function budgetParamVersion(
  versions: Partial<Record<ParameterKey, number>>,
): number {
  return BUDGET_LIMIT_PARAMETER_KEYS.reduce(
    (sum, k) => sum + (versions[k] ?? 0),
    0,
  );
}

// ── Значения-допущения нового продукта (ТЗ §26, §17; §6.2) ────────────────

const UAH = 'UAH';
/** 10 000 грн = 6 000 / 2 000 / 2 000, одна закупка ≤ 2 000 (ТЗ §17). */
const TOTAL_MINOR = 1_000_000;

export const DEFAULT_PARAMETER_VALUES: {
  [K in ParameterKey]: ParameterValues[K];
} = {
  niche: { text: 'Малий бізнес або експерти — вузька ніша ще не обрана' },
  language: { code: 'uk' },
  market: { country: 'UA' },
  offer_active_version: { offerVersionId: null, version: null },
  own_channels: { channels: [] },
  domain_host: { host: 'ai-publisher.org' },
  hosting: { provider: 'vercel', note: null },
  attribution_tool: { tool: 'own_events', note: null },
  consent_map: { default: 'not_required', note: null },
  analytics_storage: 'none',
  event_map: {
    version: '1',
    events: [
      {
        name: 'content_view',
        trigger: 'перегляд сторінки матеріалу',
        fields: ['contentSlug', 'placementCode', 'referrerHost', 'utm'],
        collector: 'own_endpoint',
        eventIdRule: 'uuid клієнта, дедуплікація за (productId, eventId)',
        historyDays: 400,
        excludeTest: true,
        leadJoin: 'sessionRef лише при analytics_storage=session',
      },
      {
        name: 'cta_click',
        trigger: 'натискання CTA матеріалу',
        fields: ['contentSlug', 'placementCode', 'utm'],
        collector: 'own_endpoint',
        eventIdRule: 'uuid клієнта, дедуплікація за (productId, eventId)',
        historyDays: 400,
        excludeTest: true,
        leadJoin: 'sessionRef лише при analytics_storage=session',
      },
      {
        name: 'lead_submit_success',
        trigger: 'сервер зберіг звернення (після COMMIT)',
        fields: ['contentSlug', 'placementCode', 'utm'],
        collector: 'server',
        eventIdRule: 'створює сервер у транзакції приймання',
        historyDays: 400,
        excludeTest: true,
        leadJoin: 'leadId у тій самій транзакції',
      },
    ],
  },
  perf_targets: {
    leadsP95Ms: 1500,
    leadsRps: 2,
    parallelSubmits: 5,
    publicReadP95Ms: 500,
    mainTextInFirstHtml: true,
    protocolRef: null,
  },
  data_notice_version: {
    version: 'draft-1',
    text: 'Чернетка повідомлення про обробку даних — потребує затвердження власником.',
  },
  retention_policy: {
    leadReviewDays: 90,
    closedReviewDays: 90,
    backupRotationDays: 90,
  },
  budget_total: { amountMinor: TOTAL_MINOR, currency: UAH },
  budget_split: {
    placementsMinor: 600_000,
    toolsMinor: 200_000,
    reserveMinor: 200_000,
  },
  per_purchase_max: { amountMinor: 200_000 },
  ai_budget_usd_month: { microUsd: 20_000_000 },
  ai_fx_rate: { rate: null, source: null, at: null },
  ai_unpriced_allowed: { allowed: false },
  rates_by_role: {
    currency: UAH,
    rates: {
      product_owner: null,
      editor: null,
      operator: null,
      analyst: null,
      sales: null,
      viewer: null,
      admin: null,
    },
  },
  allowed_cpl_inputs: { contributionMinor: null, pPayBp: null, shareBp: null },
  investment_cpl_limit: { amountMinor: null },
  dev_investment: {
    amountMinor: null,
    hours: null,
    note: 'Пакет розробки програмного контуру P0 — оцінка власником (Р-PUB-Z2-24)',
  },
  cac_payment_window: { until: 't72', days: null },
  d42_thresholds: {
    sessions: 100,
    qualified: 5,
    proposals: 2,
    minSampleForConclusion: 5,
  },
  d90_thresholds: { indexedPages: 3, pagesTotal: 6, pagesWithClicks28d: 2 },
  late_cohort_rules: { closeAfterDays: 30, explicitEndRequired: true },
  qualification_rules: {
    externalOnly: true,
    requireConfirmedInterest: true,
    budgetUnknownAllowed: true,
    note: null,
  },
  responsibles: {
    formOwnerMemberId: null,
    salesMemberIds: [],
    afterT72MemberId: null,
  },
  sales_hours_t42_t72: { minutes: null },
  contact_sla: {
    rule: 'next_business_day_end',
    calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], dayEnd: '18:00' },
  },
  form_limit: { count: 5, windowSec: 600 },
  alt_contact: { label: 'Напишіть нам', href: null },
  test_hosts: [],
  pilot_calendar: { t0Planned: null },
  launch_evidence_d0: { qaRunId: null, perfProtocolRef: null, note: null },
  launch_evidence_purchase: { qaRunId: null, note: null },
};
