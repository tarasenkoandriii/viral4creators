import snapshot from '../../assist-plans.snapshot.json';
import { INTL_LOCALES, type Locale } from './i18n';
import type { ClaimId } from './claims';

/**
 * Тарифы Помощника для `/pricing` — из файла-снимка
 * `assist-plans.snapshot.json` (ТЗ лендинга §3.8, аудит 01.10), а не из
 * словарей: урок `TZ-Client-Site-Tutorial-Landing.md` §3 — у лендинга нет
 * доступа к backend-прайсу, и тексты расходятся. С Э4 продукта источником
 * станет публичный `GET /public/assist/plans` (ISR, последняя успешная
 * версия при падении), снимок останется резервом.
 *
 * Числа в снимке сверены с ТЗ TMA §7.1; совпадение держит
 * `scripts/plans.test.ts` (таблица ожидаемых значений из §7.1 — сверка
 * при каждой правке §7.1 — пункт чек-листа релиза).
 *
 * Валюта (§3.8, аудит 01.10): к оплате продукт принимает только гривну
 * (WayForPay) и Stars, USD — ориентир. Гривневой сетки в ТЗ TMA нет
 * (§2.6 — «гривна по фиксированной сетке» без чисел), поэтому на всех
 * локалях показан USD-ориентир со строкой «оплата в гривне по курсу или
 * Stars»; EUR не показываем — оплаты в EUR нет.
 */

export type AssistPlanId = 'trial' | 'start' | 'business' | 'pro';

export interface AssistPlan {
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
}

export interface PlansSnapshot {
  source: string;
  checkedAt: string;
  currency: 'USD';
  annualDiscountPercent: number;
  minOveragePerDialogUsd: number;
  dialogRules: { idleCloseMinutes: number; countsAsTwoAfterReplies: number; countsAsThreeAfterReplies: number };
  plans: AssistPlan[];
}

const PLAN_ORDER: readonly AssistPlanId[] = ['trial', 'start', 'business', 'pro'];

/** Проверка формы снимка: сломанный файл — ошибка сборки, а не пустая страница. */
export function parsePlansSnapshot(raw: unknown): PlansSnapshot {
  const s = raw as PlansSnapshot;
  if (!s || s.currency !== 'USD' || !Array.isArray(s.plans)) throw new Error('assist-plans.snapshot.json: неверная форма');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.checkedAt)) throw new Error('assist-plans.snapshot.json: checkedAt не дата');
  const ids = s.plans.map((p) => p.id);
  if (ids.join() !== PLAN_ORDER.join()) throw new Error(`assist-plans.snapshot.json: тарифы ${ids.join()} ≠ ${PLAN_ORDER.join()}`);
  for (const p of s.plans) {
    for (const k of ['priceUsdMonthly', 'dialogsPerMonth', 'sites', 'knowledgePages', 'documents', 'telegramOperators', 'retentionDays'] as const) {
      if (typeof p[k] !== 'number' || !Number.isFinite(p[k]) || p[k] < 0) throw new Error(`assist-plans.snapshot.json: ${p.id}.${k}`);
    }
    if (p.overageUsdPer100 !== null && p.overageUsdPer100 / 100 < s.minOveragePerDialogUsd - 1e-9) {
      throw new Error(`assist-plans.snapshot.json: докупка ${p.id} ниже минимума $${s.minOveragePerDialogUsd} за диалог`);
    }
  }
  return s;
}

export const PLANS: PlansSnapshot = parsePlansSnapshot(snapshot);

export function formatUsd(value: number, locale: Locale): string {
  return new Intl.NumberFormat(INTL_LOCALES[locale], {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(INTL_LOCALES[locale]).format(value);
}

/**
 * Строки таблицы возможностей: булево поле снимка ↔ утверждение реестра.
 * Возможность ещё не в проде — строка всё равно видна (это условия
 * тарифа), но с меткой «скоро» из реестра (§3.8: «таблица возможностей
 * по реестру утверждений»).
 */
export const FEATURE_ROWS: ReadonlyArray<{ key: keyof AssistPlan & string; claim: ClaimId }> = [
  { key: 'voice', claim: 'voice' },
  { key: 'video', claim: 'video' },
  { key: 'adminRead', claim: 'admin-read' },
  { key: 'adminActions', claim: 'admin-actions' },
  { key: 'removePoweredBy', claim: 'remove-powered-by' },
  { key: 'ownLoaderDomain', claim: 'own-loader-domain' },
];
