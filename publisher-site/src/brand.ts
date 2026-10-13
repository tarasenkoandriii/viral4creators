/**
 * Бренд и технические имена публичного сайта AI Publisher (проектный
 * документ §13.1, ТЗ — вступление).
 *
 * Две части:
 *  1. Имя, позиционирование и домен — решение владельца (ТЗ: «Назва та
 *     домен обрані власником»). Здесь — единственное место, где они
 *     записаны в коде сайта.
 *  2. ЗЕРКАЛО технических имён `sites-backend/src/brand.ts` (раздел
 *     «AI Publisher» и подтверждение владения): их видят разметка страниц,
 *     трекер и сервер приёма. Совпадение с источником держит
 *     `scripts/brand.test.ts` — копия, потому что у Vercel-проекта сайта
 *     свой корень и код бэкенда в сборку не тянется.
 */

export const PUBLISHER_BRAND = {
  /** Имя продукта (ТЗ, вступление). */
  name: 'AI Publisher',
  /** Позиционирование на языке пилота (ТЗ, вступление). */
  positioning: 'Цифрова агенція повного циклу',
  /** Выбранный домен; адрес сборки — всегда `SITE_URL`, не эта строка. */
  domain: 'ai-publisher.org',
  /** Язык пилота (ТЗ §2): один язык — один `lang`. */
  lang: 'uk',
  /** Часовой пояс дат на страницах (рынок пилота — Украина). */
  timeZone: 'Europe/Kyiv',
} as const;

// ── Зеркало sites-backend/src/brand.ts ─────────────────────────────────

/** Префикс публичного ключа продукта: `pp_` + 24 символа base62. */
export const PUBLISHER_KEY_PREFIX = 'pp_';
/** Формат публичного ключа — тот же, что у триггера `pub_products_guard`. */
export const PUBLISHER_PUBLIC_KEY_RE = /^pp_[A-Za-z0-9]{24}$/;
/** `name` мета-тега с hash опубликованной версии. */
export const PUBLISHER_VERSION_META = 'pub-version';
/** Ключ sessionStorage для `session_ref` (только при analytics_storage=session). */
export const PUBLISHER_SESSION_STORAGE_KEY = 'pub_sref';
/** События сайта продукта (ТЗ §14); `lead_submit_success` пишет только сервер. */
export const PUBLISHER_EVENT_NAMES = ['content_view', 'cta_click', 'lead_submit_success'] as const;
/** События, которые шлёт сайт (`POST /public/publisher/v1/events`). */
export const PUBLISHER_CLIENT_EVENT_NAMES = ['content_view', 'cta_click'] as const;
/** Путь файла-маркера подтверждения владения (способ «файл»). */
export const VERIFY_FILE_PATH = '/.well-known/v4c-verify.txt';

/** Префикс публичных маршрутов API (`contracts/public-api.ts`). */
export const PUBLIC_API_PREFIX = '/public/publisher/v1';
