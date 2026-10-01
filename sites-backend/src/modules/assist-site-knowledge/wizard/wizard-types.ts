/**
 * Мастер «Научите помощника» и полнота знаний (ТЗ §4-тер.9; приёмка
 * §4-тер.15 п.6) — формы ответов (конверт `{ success, data }`), стык W5
 * (сервер) ↔ W4 (assist/src/lib/wizard-api.ts повторяет и разбирает строго).
 * Менять — через координатора.
 */

export const WIZARD_BUSINESS_TYPES = ['shop', 'services', 'saas'] as const;
export type WizardBusinessType = (typeof WIZARD_BUSINESS_TYPES)[number];

/** Темы магазина (§4-тер.9 п.1); у услуг и SaaS — свои наборы (wizard-topics.ts). */
export type WizardTopic =
  | 'delivery'
  | 'payment'
  | 'returns'
  | 'warranty'
  | 'hours_contacts'
  | 'availability'
  | 'wholesale_discounts'
  | 'must_not_promise'
  | 'handoff_when'
  | 'top_question'
  | 'booking'
  | 'pricing'
  | 'trial'
  | 'support';

/** Куда превращается ответ владельца (§4-тер.9 п.3). */
export type WizardAnswerTarget = 'golden' | 'persona_forbid' | 'handoff_rule';

export interface WizardItemView {
  topic: WizardTopic;
  /** Вопрос владельцу на языке кабинета. */
  question: string;
  target: WizardAnswerTarget;
  /** Черновик по сайту («На странице „Доставка“: …») — данные, не HTML. */
  draft: string | null;
  draftSources: Array<{ url: string | null; title: string | null }>;
  /** Ответ владельца (после «Да» — равен черновику). */
  answer: string | null;
  /** pending | confirmed | edited | skipped | saved */
  status: 'pending' | 'confirmed' | 'edited' | 'skipped' | 'saved';
  /** Созданный проверенный ответ (origin = wizard). */
  faqId: string | null;
}

export interface WizardView {
  siteId: string;
  businessType: WizardBusinessType;
  status: 'in_progress' | 'done';
  items: WizardItemView[];
  /** Осталось прогонов черновиков (1 + 3 повтора, платит платформа). */
  draftRunsLeft: number;
  /** Сводка сайта (§4.6 п.3) — показать владельцу (данные). */
  siteSummary: SiteSummary | null;
}

/** Строгая форма сводки сайта: короткие строки, без императивов (§4.6 п.3). */
export interface SiteSummary {
  businessType: WizardBusinessType | 'other';
  /** ≤ 8 разделов, каждый ≤ 60 символов. */
  sections: string[];
  contacts: { phones: string[]; emails: string[]; address: string | null };
  /** «Пн–Пт 9–18» — ≤ 100. */
  hours: string | null;
  /** Описание бизнеса ≤ 200, без обращений к модели. */
  about: string | null;
  lang: string | null;
}

/** Индикатор полноты (§4-тер.9): чек-лист, НЕ процент. */
export interface CompletenessView {
  siteId: string;
  topics: { covered: number; total: number; missing: WizardTopic[] };
  pages: {
    read: number;
    skipped: number;
    quarantined: number;
    excluded: number;
  };
  quality: {
    lastEvalAt: string | null;
    passed: number | null;
    failed: number | null;
  };
  /** Э3 (очередь): старше 7 дней; Э2 — 0. */
  openGapsOlderThan7d: number;
  goldenNeedsReview: number;
  /** Что сделать дальше — коды для текстов фронта. */
  next: Array<
    | 'run_wizard'
    | 'answer_topics'
    | 'review_quarantine'
    | 'add_documents'
    | 'publish_widget'
  >;
}
