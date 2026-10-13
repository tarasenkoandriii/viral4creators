/**
 * AI Publisher — контракт публичных маршрутов приёма P-D (проектный
 * документ §11.4, §13.4–13.5; ТЗ §6, §8.3, §14), заполненный по
 * `_template.ts`. Префикс `/public/publisher/v1`, без входа (`@PublicRoute`),
 * клиент БД — роль `publisher_public`. Чтение контента (`GET /contents*`) —
 * контракт P-B1 (`content-api.ts`).
 *
 * Потребители: publisher-site (P-F) — форма, трекер, сборка страниц;
 * тест `public-api.spec.ts` сверяет список с контроллером.
 *
 * Чистый модуль: только типы, константы и проверка карты событий.
 */
import { route } from './_template';
import type { LeadBody } from './lead-validation';
import type { ConsentState, ProductMode } from './states';

export const PUBLIC_PREFIX = '/public/publisher/v1';

// ── GET /site-config ─────────────────────────────────────────────────────

/** Конфиг сайта продукта для сборки страниц и формы (`?key=pp_…&host=`). */
export interface SiteConfigView {
  mode: ProductMode;
  /** `host` запроса ∈ `indexableHosts` (verified-хост live рабочего продукта). */
  indexable: boolean;
  /** Форма принимает заявки (live с открытыми гейтами или режим test). */
  formOpen: boolean;
  /** Альтернативный контакт (утверждённый параметр `alt_contact`) или null. */
  altContact: unknown;
  analyticsStorage: 'none' | 'session';
  consentState: ConsentState;
  dataNotice: {
    version: string | null;
    text: string | null;
    approved: boolean;
  } | null;
  /** Активные факты `faq` (≤ 5). */
  faq: unknown[];
  offer: {
    title: string | null;
    text: string | null;
    priceNote: string | null;
  } | null;
  /** Лимит формы (для текста ошибки 429 на сайте). */
  formLimit: { count: number; windowSec: number };
  /**
   * Срок ответа заявителю — правило параметра `contact_sla` (утверждённое
   * или допущение решения в test) или null: тогда сайт берёт умолчание
   * параметра (Р-PUB-Z2-9, запрос P-F 17.4 №2).
   */
  contactSla: { rule: string } | null;
}

// ── POST /leads ──────────────────────────────────────────────────────────

/** Тело формы — `contracts/lead-validation.ts` (`LeadBody`, P-A1). */
export type LeadSubmitBody = LeadBody;

/**
 * 201 — заявка сохранена (повтор того же `submissionKey` с тем же телом —
 * 200 с тем же `leadRef`). Успех на сайте показывается ТОЛЬКО по этому
 * ответу (§13.4, AT-CORE-03).
 */
export interface LeadAccepted {
  /** `L-` + 10 base32 — номер обращения для посетителя. */
  leadRef: string;
  receivedAt: string;
  /** id серверного события `lead_submit_success` (повтор — тот же). */
  eventId: string;
}

// ── POST /events (text/plain с JSON внутри) ──────────────────────────────

/** События, которые шлёт клиент; `lead_submit_success` создаёт сервер. */
export const CLIENT_EVENT_NAMES = ['content_view', 'cta_click'] as const;
export type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];

/**
 * Тело события. Отправляется `navigator.sendBeacon` с `Blob` типа
 * `text/plain` (межсайтовый `application/json` без preflight браузер не
 * отправит, аудит P2-24); запасной путь — `fetch(…, {keepalive:true})`.
 */
export interface EventBody {
  key: string;
  /** UUID клиента — дедупликация `(productId, eventId)`. */
  eventId: string;
  name: ClientEventName;
  /**
   * Путь страницы (`location.pathname`): сервер отрезает query и фрагмент
   * (контракт P-A0 для `pub_sessions.landingPath`). Дополнение P-D к §11.4:
   * без пути сессия получает `/`.
   */
  path?: string;
  contentSlug?: string;
  placementCode?: string;
  /** Только хост перехода (`document.referrer` → host), без пути. */
  referrerHost?: string;
  /** Только при `analyticsStorage='session'`; иначе сервер его не хранит. */
  sessionRef?: string;
  /** Четыре ключа `source|medium|campaign|content` (с `utm_` или без). */
  utm?: Record<string, string>;
  consentState: ConsentState;
  /** Время клиента (справочно, ISO); время события ставит сервер. */
  clientAt?: string;
}

/** 202 — принято (дубликат `eventId` — тоже 202, без второй строки). */
export type EventAccepted = Record<string, never>;

/** Поля тела события, которые попадают в `pub_events` (карта событий). */
export const EVENT_BODY_FIELDS = [
  'contentSlug',
  'placementCode',
  'referrerHost',
  'utm',
  'sessionRef',
  'consentState',
  'clientAt',
  'path',
] as const;

/** Поля заявки, которые попадают в событие `lead_submit_success`. */
export const LEAD_EVENT_FIELDS = [
  'contentSlug',
  'placementCode',
  'utm',
  'sessionRef',
] as const;

/**
 * Сверка утверждённой карты событий (`event_map`, ТЗ §14, аудит P2-18) с
 * фактическим API: каждое событие карты существует, его поля — из тех,
 * что API принимает и хранит, сбор `own_endpoint` (клиент) или `server`
 * (`lead_submit_success`). Пустой список — карта совпадает с кодом.
 */
export function eventMapIssues(map: unknown): string[] {
  const issues: string[] = [];
  const events = (map as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return ['event_map.events: не список'];
  const seen = new Set<string>();
  for (const [i, raw] of events.entries()) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const name = String(e.name);
    seen.add(name);
    const allowed: readonly string[] =
      name === 'lead_submit_success'
        ? LEAD_EVENT_FIELDS
        : (CLIENT_EVENT_NAMES as readonly string[]).includes(name)
          ? EVENT_BODY_FIELDS
          : [];
    if (allowed.length === 0) {
      issues.push(`event_map.events[${i}].name: «${name}» нет в API`);
      continue;
    }
    const fields = Array.isArray(e.fields) ? e.fields : [];
    for (const f of fields) {
      if (!allowed.includes(String(f))) {
        issues.push(
          `event_map.events[${i}].fields: «${String(f)}» API не собирает`,
        );
      }
    }
    const collector =
      name === 'lead_submit_success' ? 'server' : 'own_endpoint';
    if (e.collector !== collector) {
      issues.push(`event_map.events[${i}].collector: ожидается ${collector}`);
    }
    if (e.excludeTest !== true) {
      issues.push(
        `event_map.events[${i}].excludeTest: тестовые события исключаются`,
      );
    }
  }
  for (const n of ['content_view', 'cta_click', 'lead_submit_success']) {
    if (!seen.has(n)) issues.push(`event_map: нет события ${n}`);
  }
  return issues;
}

// ── Ошибки (коды — `contracts/errors.ts`) ────────────────────────────────

/** `PUB_RATE_LIMITED` 429 (+ заголовок `Retry-After`). */
export interface RateLimitedDetails {
  retryAfterSec: number;
  altContact: unknown;
}
/** `PUB_FORM_CLOSED` 503: форма закрыта, честное сообщение и альтернатива. */
export interface FormClosedDetails {
  altContact: unknown;
  /** `closed` — режим/гейты; `intake_unavailable` — нет строки publisher_public. */
  reason: 'closed' | 'intake_unavailable';
}

export const PUBLIC_ROUTES = {
  siteConfig: route<void, SiteConfigView>({
    method: 'GET',
    path: `${PUBLIC_PREFIX}/site-config`,
    action: null,
    mutation: false,
    status: 200,
  }),
  submitLead: route<LeadSubmitBody, LeadAccepted>({
    method: 'POST',
    path: `${PUBLIC_PREFIX}/leads`,
    action: null,
    mutation: true,
    status: 201,
  }),
  trackEvent: route<EventBody, EventAccepted>({
    method: 'POST',
    path: `${PUBLIC_PREFIX}/events`,
    action: null,
    mutation: true,
    status: 202,
  }),
} as const;

/** Лимиты публичных маршрутов P-D (§11.4). */
export const PUBLIC_LIMITS = {
  /** GET /site-config — на IP в минуту. */
  siteConfigPerMinute: 120,
  /** POST /events — на IP в минуту. */
  eventsPerIpMinute: 120,
  /** POST /events — на sessionRef в минуту. */
  eventsPerSessionMinute: 30,
} as const;
