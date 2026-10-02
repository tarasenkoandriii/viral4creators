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

/**
 * GET /public/assist/plans — Э4: живые тарифы из `ASSIST_PLANS`
 * (assist-billing/plans.ts, `publicPlans`) в форме файла-снимка лендинга
 * `sites-landing/assist-plans.snapshot.json` (+ `dialogWeights`).
 */
export type { PublicPlansResponse as AssistPlansResponse } from '../../assist-billing/plans';

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
