/**
 * Формы публичного API (`/public/publisher/v1`), которые читает сайт.
 * Источник — замороженные контракты sites-backend:
 * `contracts/public-api.ts` (P-D: site-config, leads, events) и
 * `contracts/content-api.ts` (P-B1: contents). Копия, а не импорт — у
 * Vercel-проекта сайта свой корень; взаимную присваиваемость с источником
 * проверяет компилятор в `scripts/api-contract.test.ts`.
 */

export type ProductMode = 'closed' | 'test' | 'live';
export type ConsentState = 'granted' | 'denied' | 'unknown' | 'not_required';

/** `GET /site-config?key=&host=` (P-D, Р-PUB-D-21 — с `formLimit`). */
export interface SiteConfigView {
  mode: ProductMode;
  indexable: boolean;
  formOpen: boolean;
  /** Утверждённый `alt_contact` `{label, href}` или null. */
  altContact: unknown;
  analyticsStorage: 'none' | 'session';
  consentState: ConsentState;
  dataNotice: { version: string | null; text: string | null; approved: boolean } | null;
  /** Активные факты `faq` `{question, answer}` (≤ 5). */
  faq: unknown[];
  offer: { title: string | null; text: string | null; priceNote: string | null } | null;
  formLimit: { count: number; windowSec: number };
  /**
   * Правило параметра `contact_sla` (`{rule}`, без календаря) или null —
   * тогда сайт берёт умолчание параметра (`next_business_day_end`, ТЗ §6).
   * В контракте sites-backend с интеграции Z-2a (Р-PUB-Z2-9); старый API
   * без поля — `undefined`, `slaTextOf` даёт то же умолчание.
   */
  contactSla: { rule: string } | null;
}

/** `GET /contents?key=` (P-B1). */
export interface PublicContentListItem {
  slug: string;
  title: string | null;
  description: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  stage: 'test' | 'live';
  withdrawn: boolean;
}

/** `GET /contents/:slug?key=` (P-B1); снятый — HTTP 410 `{withdrawn:true}`. */
export interface PublicContent {
  title: string;
  shortAnswer: string | null;
  body: string;
  example: string | null;
  limitations: string[];
  editor: string | null;
  publishedAt: string | null;
  substantiallyUpdatedAt: string | null;
  sources: Array<{ title: string | null; url: string | null } | { private: true }>;
  cta: string | null;
  versionHash: string;
  stage: 'test' | 'live';
}

/** 201/200 `POST /leads`. */
export interface LeadAccepted {
  leadRef: string;
  receivedAt: string;
  eventId: string;
}

export const CLIENT_EVENT_NAMES = ['content_view', 'cta_click'] as const;
export type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];

/** Тело `POST /events` (`text/plain` с JSON внутри). */
export interface EventBody {
  key: string;
  eventId: string;
  name: ClientEventName;
  path?: string;
  contentSlug?: string;
  placementCode?: string;
  referrerHost?: string;
  sessionRef?: string;
  utm?: Record<string, string>;
  consentState: ConsentState;
  clientAt?: string;
}

export interface RateLimitedDetails {
  retryAfterSec: number;
  altContact: unknown;
}
export interface FormClosedDetails {
  altContact: unknown;
  reason: 'closed' | 'intake_unavailable';
}

/** Общий конверт sites-backend. */
export type Envelope<T> =
  { success: true; data: T } | { success: false; error: { code: string; message?: string; details?: unknown } };

// ── Нормализованные значения для страниц ───────────────────────────────

/** `alt_contact` (`parameters.ts`): `{label, href: https:|mailto:|tel: | null}`. */
export interface AltContact {
  label: string;
  href: string | null;
}
export interface FaqItem {
  question: string;
  answer: string;
}
