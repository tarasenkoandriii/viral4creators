/**
 * Локаль продукта (этап 59, ТЗ §35.5/§38) — общая для всего бэкенда,
 * а не только блога. Раньше `LOCALE_LANGUAGE_NAMES`/`languageNameForLocale`
 * жили только в `modules/grok/grok-translation-prompt.ts` (перевод статей
 * блога, этап 57) — с этапа 59 то же самое явное-имя-языка нужно
 * `AnalysisService` (перевод разбора), `ProductRecognitionService`,
 * `RelevanceService` и `VideoAuditService`, поэтому находка переехала
 * сюда, в общий модуль, а `grok-translation-prompt.ts` теперь берёт её
 * отсюда, не держит свою копию.
 *
 * Пять локалей — те же, что в frontend/src/lib/i18n.ts и
 * landing/src/lib/i18n.ts (этап 55). Список умышленно не импортируется
 * оттуда — у бэкенда нет зависимости на код фронтенда/лендинга, а сами
 * коды локалей — общий, независимо стабильный контракт (ISO 639-1).
 */

export const SUPPORTED_LOCALES = ['ru', 'uk', 'en', 'de', 'es'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * ru, а не en, сознательно: весь текущий продукт и его существующие
 * пользователи — русскоязычные (тот же выбор, что defaultLocale во
 * frontend/lib/i18n.ts). Локаль сессии, которую явно не передали
 * (старые сессии, созданные до этого этапа, либо клиент, который ещё не
 * обновился), считается русской, а не английской — иначе для всей
 * текущей аудитории поведение внезапно изменилось бы само по себе.
 */
export const DEFAULT_LOCALE: SupportedLocale = 'ru';

export function isSupportedLocale(
  value: string | null | undefined,
): value is SupportedLocale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Неизвестное/отсутствующее значение → DEFAULT_LOCALE, а не throw — локаль
 * никогда не должна блокировать генерацию, только выбирать её язык. */
export function normalizeLocale(
  value: string | null | undefined,
): SupportedLocale {
  return isSupportedLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * Промпт-находка solar-shop (ТЗ §35.1), перенесённая для перевода статей
 * блога и теперь используемая ЗДЕСЬ ЖЕ для всего остального ИИ-вывода:
 * язык в промпт нужно передавать ЯВНЫМ названием («Ukrainian»), а не
 * голым ISO-кодом («uk») — модель может прочитать `uk` как United Kingdom
 * (Великобританию), а не украинский.
 */
export const LOCALE_LANGUAGE_NAMES: Readonly<Record<SupportedLocale, string>> =
  {
    ru: 'Russian',
    uk: 'Ukrainian',
    en: 'English',
    de: 'German',
    es: 'Spanish',
  };

/**
 * Явное имя языка для промпта; неизвестный код — как есть (не
 * `normalizeLocale` — честно передать код лучше, чем молча подменить его
 * дефолтным языком, см. тот же принцип у `grok-translation-prompt.spec.ts`).
 */
export function languageNameForLocale(locale: string): string {
  return isSupportedLocale(locale) ? LOCALE_LANGUAGE_NAMES[locale] : locale;
}

/**
 * Локаль из заголовка `Accept-Language` (аудит 2026-09-08, Г-5.2).
 *
 * До этого этапа локаль уходила на бэкенд ТОЛЬКО при создании сессии
 * (`POST /projects/session`) — а всё, что отдаётся клиенту готовым
 * текстом вне этого одного маршрута (режимы `plans.ts`, пакеты кредитов
 * `billing-pricing.ts`, общий текст ошибки 500 в `HttpExceptionFilter`),
 * было жёстко зашито по-русски независимо от локали интерфейса.
 * `Accept-Language` — стандартный заголовок ровно для этой задачи:
 * axios-интерцептор фронтенда (`services/api.ts`) подставляет его на
 * каждый запрос сам, без протаскивания параметра локали вручную через
 * каждый маршрут.
 *
 * Фронтенд шлёт голый код локали (`ru`, `en`, ...), но в общем случае
 * значение заголовка может прийти в полном HTTP-формате
 * (`en-US,en;q=0.9`) — берём первый элемент до запятой и первые два
 * символа языка, без учёта региона и веса `q`; для пяти поддерживаемых
 * локалей этого достаточно.
 */
export function localeFromHeader(
  header: string | string[] | undefined,
): SupportedLocale {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return DEFAULT_LOCALE;
  const primary = raw.split(',')[0]?.trim().slice(0, 2).toLowerCase();
  return normalizeLocale(primary);
}

/**
 * Достаёт локаль прямо из Express-запроса — короткий путь для
 * контроллеров. `headers` — опционально: юнит-тесты фильтров/сервисов
 * нередко мокают запрос без него вовсе (см.
 * `http-exception.filter.spec.ts`), и это не повод падать — просто
 * запрос без заголовка локали, тот же случай, что и его отсутствие.
 */
export function localeFromRequest(req: {
  headers?: Record<string, string | string[] | undefined>;
}): SupportedLocale {
  return localeFromHeader(req.headers?.['accept-language']);
}
