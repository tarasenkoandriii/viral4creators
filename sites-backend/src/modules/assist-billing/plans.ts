/**
 * Тарифы Помощника — `ASSIST_PLANS` (ТЗ помощника §7.1, §5-тер.17, Р-58;
 * план, Приложение А «Этап 4»). ОДНА таблица на продукт: лимиты, бюджеты,
 * возможности и цены. Чистый модуль (без базы и Nest): его читают квота
 * диалогов, бюджеты обучения, обход, экран тарифов TMA, публичный
 * `GET /public/assist/plans` (лендинг) и админка платформы.
 *
 * Своя линейка, не `PlanId` генератора (§7.1): у двух продуктов границы
 * двигаются независимо.
 *
 * Цены — ориентир в USD (§7.1, решает владелец — В-3); к оплате — гривна
 * (WayForPay) и Stars по курсу из env (billing-env.ts): сумма платежа
 * пересчитывается на сервере при каждом чекауте, клиент её не присылает.
 *
 * Деньги — в микродолларах (как site_ai_usage.costMicroUsd).
 */

export const MICRO = 1_000_000;

export const ASSIST_PLAN_IDS = ['trial', 'start', 'business', 'pro'] as const;
export type AssistPlanId = (typeof ASSIST_PLAN_IDS)[number];
/** Тарифы, которые можно купить (trial не продаётся). */
export const PAID_PLAN_IDS = ['start', 'business', 'pro'] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

export type Recrawl = 'manual' | 'weekly' | 'daily' | 'daily+hook';

export interface AssistPlan {
  id: AssistPlanId;
  /** Ориентир цены, USD в месяц (§7.1). */
  priceUsdMonthly: number;
  /** Пробный период — дни; у платных null. */
  trialDays: number | null;
  /** Длина периода учёта: пробный — trialDays, платные — 30 дней. */
  periodDays: number;
  /** Лимит периода в ЕДИНИЦАХ (текстовый диалог — 1; §7.1 Р-58). */
  dialogsPerMonth: number;
  sites: number;
  knowledgePages: number;
  documents: number;
  recrawl: Recrawl;
  telegramOperators: number;
  retentionDays: number;
  /** Докупка 100 единиц, USD; null — сверх лимита стоп (Trial). */
  overageUsdPer100: number | null;
  /** Бюджет обучения подписки в месяц (§4-тер.11, Р-58). */
  learningBudgetMicroUsd: number;
  /** Бюджет аналитики подписки в месяц (§5-тер.17, Р-50). */
  analyticsBudgetMicroUsd: number;
  voice: boolean;
  voiceControlSite: boolean;
  voiceControlAdmin: boolean;
  video: boolean;
  adminRead: boolean;
  adminActions: boolean;
  strictNumbers: boolean;
  aiAnalytics: boolean;
  // ── Э3-бис (§5-тер.17, решения «Э3-бис — сделано» плана) ──
  /** Калибровка lead score по сайту → вероятность вместо корзин (§5-тер.4). */
  leadCalibration: boolean;
  /** Эксперименты (holdout, варианты приветствия/подсказок) — по одному на сайт. */
  experiments: boolean;
  /** Связанный режим (с согласием): окно атрибуции, дней; 0 — только документ. */
  linkedWindowDays: number;
  /** Поведенческие факторы: просмотров в месяц на подписку (Р-58); 0 — нет. */
  behaviorViewsPerMonth: number;
  removePoweredBy: boolean;
  ownLoaderDomain: boolean;
}

const usd = (v: number) => Math.round(v * MICRO);

export const ASSIST_PLANS: Readonly<Record<AssistPlanId, AssistPlan>> = {
  trial: {
    id: 'trial',
    priceUsdMonthly: 0,
    trialDays: 14,
    periodDays: 14,
    dialogsPerMonth: 50,
    sites: 1,
    knowledgePages: 50,
    documents: 5,
    recrawl: 'manual',
    telegramOperators: 1,
    retentionDays: 30,
    overageUsdPer100: null,
    learningBudgetMicroUsd: usd(0.5),
    analyticsBudgetMicroUsd: 0,
    voice: false,
    voiceControlSite: false,
    voiceControlAdmin: false,
    video: false,
    adminRead: false,
    adminActions: false,
    strictNumbers: false,
    aiAnalytics: false,
    leadCalibration: false,
    experiments: false,
    linkedWindowDays: 0,
    behaviorViewsPerMonth: 0,
    removePoweredBy: false,
    ownLoaderDomain: false,
  },
  start: {
    id: 'start',
    priceUsdMonthly: 19,
    trialDays: null,
    periodDays: 30,
    dialogsPerMonth: 400,
    sites: 1,
    knowledgePages: 300,
    documents: 20,
    recrawl: 'weekly',
    telegramOperators: 2,
    retentionDays: 90,
    overageUsdPer100: 6,
    learningBudgetMicroUsd: usd(0.5),
    analyticsBudgetMicroUsd: usd(0.1),
    voice: false,
    voiceControlSite: false,
    voiceControlAdmin: false,
    video: false,
    adminRead: false,
    adminActions: false,
    strictNumbers: false,
    aiAnalytics: false,
    leadCalibration: false,
    experiments: false,
    linkedWindowDays: 0,
    behaviorViewsPerMonth: 0,
    removePoweredBy: false,
    ownLoaderDomain: false,
  },
  business: {
    id: 'business',
    priceUsdMonthly: 59,
    trialDays: null,
    periodDays: 30,
    dialogsPerMonth: 1200,
    sites: 3,
    knowledgePages: 2000,
    documents: 200,
    recrawl: 'daily',
    telegramOperators: 5,
    retentionDays: 180,
    overageUsdPer100: 5.5,
    learningBudgetMicroUsd: usd(3),
    analyticsBudgetMicroUsd: usd(1),
    voice: true,
    voiceControlSite: true,
    voiceControlAdmin: false,
    video: true,
    adminRead: true,
    adminActions: false,
    strictNumbers: true,
    aiAnalytics: true,
    leadCalibration: false,
    experiments: true,
    linkedWindowDays: 7,
    behaviorViewsPerMonth: 100_000,
    removePoweredBy: true,
    ownLoaderDomain: false,
  },
  pro: {
    id: 'pro',
    priceUsdMonthly: 149,
    trialDays: null,
    periodDays: 30,
    dialogsPerMonth: 3000,
    sites: 10,
    knowledgePages: 10000,
    documents: 1000,
    recrawl: 'daily+hook',
    telegramOperators: 20,
    retentionDays: 365,
    overageUsdPer100: 5,
    learningBudgetMicroUsd: usd(8),
    analyticsBudgetMicroUsd: usd(3),
    voice: true,
    voiceControlSite: true,
    voiceControlAdmin: true,
    video: true,
    adminRead: true,
    adminActions: true,
    strictNumbers: true,
    aiAnalytics: true,
    leadCalibration: true,
    experiments: true,
    linkedWindowDays: 30,
    behaviorViewsPerMonth: 500_000,
    removePoweredBy: true,
    ownLoaderDomain: true,
  },
};

/** Годовая оплата — скидка (§7.1). Чекаут Э4 — только помесячно (вопрос владельцу). */
export const ANNUAL_DISCOUNT_PERCENT = 20;
/** Нижняя граница докупки за диалог (§7.1, аудит 01.10). */
export const MIN_OVERAGE_PER_DIALOG_USD = 0.05;
/** Единица ≈ себестоимость текстового диалога «Сайта» (§7.1, Р-58). */
export const UNIT_COST_MICRO_USD = 40_000;
/** Докупка — пакетами по 100 единиц; за раз не больше 10 пакетов. */
export const TOPUP_PACK_UNITS = 100;
export const TOPUP_MAX_PACKS = 10;
/** Предупреждения владельцу (§3.10). */
export const WARN_THRESHOLDS = [0.8, 1] as const;

export type AssistFeature =
  | 'voice'
  | 'voiceControlSite'
  | 'voiceControlAdmin'
  | 'video'
  | 'adminRead'
  | 'adminActions'
  | 'strictNumbers'
  | 'aiAnalytics'
  | 'leadCalibration'
  | 'experiments'
  | 'removePoweredBy'
  | 'ownLoaderDomain'
  | 'overage';

export function isAssistPlanId(v: unknown): v is AssistPlanId {
  return (
    typeof v === 'string' && (ASSIST_PLAN_IDS as readonly string[]).includes(v)
  );
}

export function isPaidPlanId(v: unknown): v is PaidPlanId {
  return (
    typeof v === 'string' && (PAID_PLAN_IDS as readonly string[]).includes(v)
  );
}

/** Возможность тарифа (тот же приём, что `planAllows` генератора). null — подписки нет. */
export function assistPlanAllows(
  planId: AssistPlanId | null,
  feature: AssistFeature,
): boolean {
  if (!planId) return false;
  const p = ASSIST_PLANS[planId];
  if (feature === 'overage') return p.overageUsdPer100 !== null;
  return p[feature];
}

/** Цена пакета докупки (100 единиц) в микродолларах; null — докупки нет. */
export function topupPackMicroUsd(planId: AssistPlanId): number | null {
  const v = ASSIST_PLANS[planId].overageUsdPer100;
  return v === null ? null : usd(v);
}

/**
 * Суточный денежный потолок ответов САЙТА (§7.3): «месячная себестоимость
 * лимита / 10» — от единиц тарифа подписки (атака не съест месяц за день).
 * Нет действующего тарифа — 0 (виджет — форма заявки).
 */
export function siteDailyCapFromPlan(planId: AssistPlanId | null): number {
  if (!planId) return 0;
  return Math.floor(
    (ASSIST_PLANS[planId].dialogsPerMonth * UNIT_COST_MICRO_USD) / 10,
  );
}

// ── Цены к оплате ─────────────────────────────────────────────────────

export interface PaymentRates {
  /** Гривен за доллар (WayForPay). */
  uahPerUsd: number;
  /** Stars за доллар (то, что получает бот после комиссии, ПРОВЕРИТЬ). */
  starsPerUsd: number;
}

export interface PlanPrice {
  /** Копейки UAH. */
  uahMinor: number;
  /** Целые Stars (XTR). */
  stars: number;
  usd: number;
}

/** USD → цена к оплате: гривна вверх до целой, Stars вверх до целой. */
export function priceFromUsd(
  amountUsd: number,
  rates: PaymentRates,
): PlanPrice {
  const uah = Math.ceil(amountUsd * rates.uahPerUsd - 1e-9);
  const stars = Math.ceil(amountUsd * rates.starsPerUsd - 1e-9);
  return { uahMinor: uah * 100, stars, usd: amountUsd };
}

export function planPrice(planId: PaidPlanId, rates: PaymentRates): PlanPrice {
  return priceFromUsd(ASSIST_PLANS[planId].priceUsdMonthly, rates);
}

export function topupPrice(
  planId: AssistPlanId,
  packs: number,
  rates: PaymentRates,
): PlanPrice | null {
  const per100 = ASSIST_PLANS[planId].overageUsdPer100;
  if (per100 === null) return null;
  return priceFromUsd(per100 * packs, rates);
}

// ── Публичный ответ для лендинга (GET /public/assist/plans) ───────────

/**
 * Форма — ровно `sites-landing/assist-plans.snapshot.json` (лендинг-ТЗ
 * §3.8): лендинг переключается со снимка на этот ответ без правок кода
 * разбора (`parsePlansSnapshot`). Сверку держит plans.spec.ts.
 */
export interface PublicPlansResponse {
  source: string;
  checkedAt: string;
  note: string;
  currency: 'USD';
  annualDiscountPercent: number;
  minOveragePerDialogUsd: number;
  dialogRules: {
    idleCloseMinutes: number;
    countsAsTwoAfterReplies: number;
    countsAsThreeAfterReplies: number;
  };
  /** Э4: веса единиц (сноска «голосовой диалог — 2, „Админка“ — 3»). */
  dialogWeights: { text: number; voice: number; admin: number };
  plans: Array<{
    id: AssistPlanId;
    priceUsdMonthly: number;
    trialDays: number | null;
    dialogsPerMonth: number;
    sites: number;
    knowledgePages: number;
    documents: number;
    telegramOperators: number;
    retentionDays: number;
    overageUsdPer100: number | null;
    voice: boolean;
    video: boolean;
    adminRead: boolean;
    adminActions: boolean;
    removePoweredBy: boolean;
    ownLoaderDomain: boolean;
  }>;
}

/** Дата сверки таблицы с ТЗ §7.1 — меняется вместе с таблицей выше. */
export const PLANS_CHECKED_AT = '2026-10-04';

export function publicPlans(rules: {
  idleCloseMinutes: number;
  weightSteps: readonly number[];
  weights: { text: number; voice: number; admin: number };
}): PublicPlansResponse {
  return {
    source: 'ASSIST_PLANS (sites-backend), ТЗ TMA §7.1',
    checkedAt: PLANS_CHECKED_AT,
    note: 'Живые тарифы из API (Э4). Цены — ориентир в USD; к оплате — гривна по курсу (WayForPay) или Telegram Stars.',
    currency: 'USD',
    annualDiscountPercent: ANNUAL_DISCOUNT_PERCENT,
    minOveragePerDialogUsd: MIN_OVERAGE_PER_DIALOG_USD,
    dialogRules: {
      idleCloseMinutes: rules.idleCloseMinutes,
      countsAsTwoAfterReplies: rules.weightSteps[0],
      countsAsThreeAfterReplies: rules.weightSteps[1],
    },
    dialogWeights: rules.weights,
    plans: ASSIST_PLAN_IDS.map((id) => {
      const p = ASSIST_PLANS[id];
      return {
        id,
        priceUsdMonthly: p.priceUsdMonthly,
        trialDays: p.trialDays,
        dialogsPerMonth: p.dialogsPerMonth,
        sites: p.sites,
        knowledgePages: p.knowledgePages,
        documents: p.documents,
        telegramOperators: p.telegramOperators,
        retentionDays: p.retentionDays,
        overageUsdPer100: p.overageUsdPer100,
        voice: p.voice,
        video: p.video,
        adminRead: p.adminRead,
        adminActions: p.adminActions,
        removePoweredBy: p.removePoweredBy,
        ownLoaderDomain: p.ownLoaderDomain,
      };
    }),
  };
}
