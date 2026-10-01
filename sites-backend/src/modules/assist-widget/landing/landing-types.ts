/**
 * Публичные маршруты для лендинга (лендинг-ТЗ §5.3, §7.3, §10.1, §17.3;
 * ТЗ помощника §4.16) — стык W2 ↔ агент лендинга (`sites-landing/`).
 * Менять — через координатора.
 */

/** POST /public/landing/event — батч ≤ 20, тело ≤ 4 КБ, sendBeacon; без идентификатора. */
export interface LandingEventBatch {
  events: Array<{
    /** [a-z0-9_.-], ≤ 64: page_view, cta_click, sandbox_start, … */
    name: string;
    /** Плоский объект строк/чисел/булевых, ≤ 20 ключей, строки ≤ 200. */
    props?: Record<string, string | number | boolean>;
    locale?: 'uk' | 'ru' | 'en';
    variant?: string;
    /** Путь без query (§6.6). */
    path?: string;
  }>;
}

/** GET /public/assist/plans — до Э4 снимок `assist-plans.snapshot.json` той же формы. */
export interface AssistPlansSnapshot {
  version: number;
  source: string;
  currency: 'USD';
  plans: Array<{
    id: 'trial' | 'start' | 'business' | 'pro';
    priceMonthly: number;
    trialDays?: number;
    dialogsPerMonth: number;
    sites: number;
    pages: number;
    documents: number;
    recrawl: string;
    poweredByRemovable: boolean;
    retentionDays: number;
    overagePer100?: number;
  }>;
}

/** POST /public/widget-drafts — «к Л3»: конфигурация вида ≤ 2 КБ (parseWidgetConfig без hosts и картинок). */
export interface WidgetDraftCreated {
  /** Для payload `wd_<id>` (≤ 60 символов [A-Za-z0-9_-]). */
  id: string;
  expiresAt: string;
}

/** POST /assist/acquisition (кабинет) — первый запуск TMA с payload лендинга. */
export interface AcquisitionRequest {
  /** start_param целиком: `lp_spring`, `pl_start`, `wd_…`, `sb_…`. */
  payload: string;
  utm?: Record<string, string>;
  landingPath?: string;
}
export interface AcquisitionResult {
  /** false — у кабинета уже есть запись (атрибуция — первый вход). */
  recorded: boolean;
}
