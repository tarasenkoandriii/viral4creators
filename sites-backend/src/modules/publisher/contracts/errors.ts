/**
 * AI Publisher — коды ошибок API (контракт P-A1, проектный документ §11.2).
 * Код стабилен (клиент ветвится по нему), HTTP-статус закреплён здесь,
 * текст — на языке `Accept-Language` (uk/ru/en; умолчание — uk, язык
 * пилота). Форма ответа — общий конверт sites-backend:
 * `{success:false, error:{code, message, details?}, meta}`.
 *
 * Чистый модуль (берут публичный код, assist, publisher-site).
 */

export const PUB_ERROR_STATUS = {
  PUB_NOT_FOUND: 404,
  PUB_PRODUCT_NONE: 404,
  PUB_PRODUCT_EXISTS: 409,
  PUB_ROLE_REQUIRED: 403,
  PUB_VALIDATION: 400,
  PUB_CONFLICT: 409,
  PUB_IDEMPOTENCY_REUSED: 409,
  PUB_BUSY: 503,
  PUB_TRANSITION_INVALID: 409,
  PUB_GATE_CLOSED: 409,
  PUB_PARAMETER_UNAPPROVED: 409,
  PUB_BLOCKERS_OPEN: 409,
  PUB_BRIEF_NOT_READY: 409,
  PUB_APPROVAL_REQUIRED: 409,
  PUB_APPROVAL_EXPIRED: 409,
  PUB_APPROVAL_STALE: 409,
  PUB_CONTENT_STALE: 409,
  PUB_OBSERVATION_PENDING: 409,
  PUB_PRICE_INCOMPLETE: 400,
  PUB_FX_REQUIRED: 400,
  PUB_BUDGET_INSUFFICIENT: 409,
  PUB_BUDGET_STOPPED: 409,
  PUB_RECONCILE_REQUIRED: 409,
  PUB_MEASUREMENT_UNAVAILABLE: 409,
  PUB_SOURCE_NOT_ALLOWED: 409,
  PUB_IMPORT_BLOCKED: 400,
  PUB_CONTACT_KEY_MISSING: 503,
  PUB_AI_NOT_EVALUATED: 409,
  PUB_AI_DISABLED: 409,
  PUB_AI_LIMIT: 409,
  PUB_AI_BUDGET: 409,
  PUB_AI_UNPRICED: 409,
  PUB_AI_UNAVAILABLE: 503,
  PUB_AI_SCHEMA_INVALID: 422,
  PUB_WINDOW_OPEN: 409,
  PUB_RESTORE_CONFLICT: 409,
  PUB_FORM_CLOSED: 503,
  PUB_RATE_LIMITED: 429,
  PUB_ORIGIN_DENIED: 403,
  PUB_PAYLOAD_TOO_LARGE: 413,
  /**
   * Сверх §11.2 (Р-PUB-A1-3): порт пакета ещё не реализован (заглушка
   * этапа 0 — «не успех», §16.0) или задание крона не зарегистрировано.
   */
  PUB_NOT_IMPLEMENTED: 501,
} as const;

export type PubErrorCode = keyof typeof PUB_ERROR_STATUS;
export const PUB_ERROR_CODES = Object.keys(PUB_ERROR_STATUS) as PubErrorCode[];

export type PubLang = 'uk' | 'ru' | 'en';
export const PUB_LANGS: readonly PubLang[] = ['uk', 'ru', 'en'];

/** Поле с ошибкой (`PUB_VALIDATION.details.fields`). */
export interface FieldIssue {
  field: string;
  /** `required|type|enum|length|range|format|pii|unknown_field|…` */
  code: string;
}

/** Тексты по коду; параметров в тексте нет — подробности в `details`. */
export const PUB_ERROR_MESSAGES: Record<
  PubErrorCode,
  Record<PubLang, string>
> = {
  PUB_NOT_FOUND: {
    uk: "Об'єкт не знайдено",
    ru: 'Объект не найден',
    en: 'Not found',
  },
  PUB_PRODUCT_NONE: {
    uk: 'Для цього сайту продукт ще не створено',
    ru: 'Для этого сайта продукт ещё не создан',
    en: 'This site has no product yet',
  },
  PUB_PRODUCT_EXISTS: {
    uk: 'Продукт для цього сайту вже існує',
    ru: 'Продукт для этого сайта уже существует',
    en: 'This site already has a product',
  },
  PUB_ROLE_REQUIRED: {
    uk: 'Немає ролі продукту для цієї дії',
    ru: 'Нет роли продукта для этого действия',
    en: 'Your product role does not allow this action',
  },
  PUB_VALIDATION: {
    uk: 'Перевірте поля форми',
    ru: 'Проверьте поля формы',
    en: 'Check the form fields',
  },
  PUB_CONFLICT: {
    uk: 'Дані вже змінив хтось інший — оновіть сторінку',
    ru: 'Данные уже изменил кто-то другой — обновите страницу',
    en: 'Someone else changed this — reload and try again',
  },
  PUB_IDEMPOTENCY_REUSED: {
    uk: 'Ключ операції вже використано для іншого запиту',
    ru: 'Ключ операции уже использован для другого запроса',
    en: 'The operation key was already used for a different request',
  },
  PUB_BUSY: {
    uk: 'Сервер зайнятий — повторіть дію',
    ru: 'Сервер занят — повторите действие',
    en: 'Server is busy — please retry',
  },
  PUB_TRANSITION_INVALID: {
    uk: 'Такий перехід статусу неможливий',
    ru: 'Такой переход статуса невозможен',
    en: 'This status transition is not allowed',
  },
  PUB_GATE_CLOSED: {
    uk: 'Дію заблоковано: не виконані умови запуску',
    ru: 'Действие заблокировано: не выполнены условия запуска',
    en: 'Blocked: launch conditions are not met',
  },
  PUB_PARAMETER_UNAPPROVED: {
    uk: 'Потрібен затверджений параметр',
    ru: 'Нужен утверждённый параметр',
    en: 'An approved parameter is required',
  },
  PUB_BLOCKERS_OPEN: {
    uk: 'Є відкриті блокери перевірки',
    ru: 'Есть открытые блокеры проверки',
    en: 'There are open review blockers',
  },
  PUB_BRIEF_NOT_READY: {
    uk: 'Бриф не готовий',
    ru: 'Бриф не готов',
    en: 'The brief is not ready',
  },
  PUB_APPROVAL_REQUIRED: {
    uk: 'Потрібне активне погодження',
    ru: 'Нужно активное согласование',
    en: 'An active approval is required',
  },
  PUB_APPROVAL_EXPIRED: {
    uk: 'Погодження прострочене',
    ru: 'Согласование истекло',
    en: 'The approval has expired',
  },
  PUB_APPROVAL_STALE: {
    uk: 'Погодження не відповідає поточній версії або ціні',
    ru: 'Согласование не соответствует текущей версии или цене',
    en: 'The approval does not match the current version or price',
  },
  PUB_CONTENT_STALE: {
    uk: 'Матеріал потребує виправлення перед поширенням',
    ru: 'Материал требует исправления перед распространением',
    en: 'The content must be corrected before distribution',
  },
  PUB_OBSERVATION_PENDING: {
    uk: '7 днів безкоштовного спостереження ще не минули',
    ru: '7 дней бесплатного наблюдения ещё не прошли',
    en: 'The 7-day free observation period is not over',
  },
  PUB_PRICE_INCOMPLETE: {
    uk: 'Немає підсумкової ціни з комісіями або її підтвердження',
    ru: 'Нет итоговой цены с комиссиями или её подтверждения',
    en: 'Total price with fees or its confirmation is missing',
  },
  PUB_FX_REQUIRED: {
    uk: 'Для ціни в іншій валюті потрібні курс, джерело і час',
    ru: 'Для цены в другой валюте нужны курс, источник и время',
    en: 'A foreign-currency price needs a rate, source and time',
  },
  PUB_BUDGET_INSUFFICIENT: {
    uk: 'Недостатньо бюджету',
    ru: 'Недостаточно бюджета',
    en: 'Insufficient budget',
  },
  PUB_BUDGET_STOPPED: {
    uk: 'Бюджет вичерпано: нові зобов’язання зупинено',
    ru: 'Бюджет исчерпан: новые обязательства остановлены',
    en: 'Budget exhausted: new commitments are stopped',
  },
  PUB_RECONCILE_REQUIRED: {
    uk: 'Спершу звірте оплату зі статусом «очікує» або «невідомо»',
    ru: 'Сначала сверьте оплату в статусе «ожидает» или «неизвестно»',
    en: 'Reconcile the pending or unknown payment first',
  },
  PUB_MEASUREMENT_UNAVAILABLE: {
    uk: 'Вимірювання недоступне',
    ru: 'Измерение недоступно',
    en: 'Measurement is unavailable',
  },
  PUB_SOURCE_NOT_ALLOWED: {
    uk: 'Джерело обмежене або відкликане',
    ru: 'Источник ограничен или отозван',
    en: 'The source is restricted or revoked',
  },
  PUB_IMPORT_BLOCKED: {
    uk: 'Сторінку не вдалося безпечно імпортувати',
    ru: 'Страницу не удалось безопасно импортировать',
    en: 'The page could not be imported safely',
  },
  PUB_CONTACT_KEY_MISSING: {
    uk: 'Приймання звернень тимчасово недоступне',
    ru: 'Приём обращений временно недоступен',
    en: 'Requests are temporarily not accepted',
  },
  PUB_AI_NOT_EVALUATED: {
    uk: 'Конфігурацію AI не перевірено набором задач',
    ru: 'Конфигурация AI не проверена набором задач',
    en: 'The AI configuration has not passed evaluation',
  },
  PUB_AI_DISABLED: {
    uk: 'AI для цієї функції вимкнено — працюйте вручну',
    ru: 'AI для этой функции выключен — работайте вручную',
    en: 'AI is disabled for this feature — use the manual path',
  },
  PUB_AI_LIMIT: {
    uk: 'Дві генерації вичерпано — потрібне рішення редактора',
    ru: 'Две генерации исчерпаны — нужно решение редактора',
    en: 'Two generations used — an editor decision is required',
  },
  PUB_AI_BUDGET: {
    uk: 'Місячний ліміт AI вичерпано',
    ru: 'Месячный лимит AI исчерпан',
    en: 'The monthly AI budget is exhausted',
  },
  PUB_AI_UNPRICED: {
    uk: 'Ціна моделі невідома і не дозволена',
    ru: 'Цена модели неизвестна и не разрешена',
    en: 'The model price is unknown and not allowed',
  },
  PUB_AI_UNAVAILABLE: {
    uk: 'AI недоступний — працюйте вручну',
    ru: 'AI недоступен — работайте вручную',
    en: 'AI is unavailable — use the manual path',
  },
  PUB_AI_SCHEMA_INVALID: {
    uk: 'Відповідь AI не пройшла перевірку схеми',
    ru: 'Ответ AI не прошёл проверку схемы',
    en: 'The AI answer failed schema validation',
  },
  PUB_WINDOW_OPEN: {
    uk: 'Вікно спостереження відкрите або вибірка замала',
    ru: 'Окно наблюдения открыто или выборка мала',
    en: 'The observation window is open or the sample is too small',
  },
  PUB_RESTORE_CONFLICT: {
    uk: 'Відновлення вже йде або копія не збігається',
    ru: 'Восстановление уже идёт или копия не совпадает',
    en: 'A restore is already running or the backup does not match',
  },
  PUB_FORM_CLOSED: {
    uk: 'Форма зараз не приймає звернень',
    ru: 'Форма сейчас не принимает обращения',
    en: 'The form is not accepting requests right now',
  },
  PUB_RATE_LIMITED: {
    uk: 'Забагато звернень — спробуйте пізніше',
    ru: 'Слишком много обращений — попробуйте позже',
    en: 'Too many requests — try again later',
  },
  PUB_ORIGIN_DENIED: {
    uk: 'Запит з цього сайту не приймається',
    ru: 'Запрос с этого сайта не принимается',
    en: 'Requests from this origin are not accepted',
  },
  PUB_PAYLOAD_TOO_LARGE: {
    uk: 'Запит завеликий',
    ru: 'Запрос слишком большой',
    en: 'Request is too large',
  },
  PUB_NOT_IMPLEMENTED: {
    uk: 'Функція ще не підключена',
    ru: 'Функция ещё не подключена',
    en: 'This feature is not connected yet',
  },
};

/**
 * Уточнённые тексты по `details.reason` (код и HTTP-статус прежние, клиент
 * по-прежнему ветвится по коду): ключ `<код>:<reason>`. Записи нет — текст
 * кода (`PUB_ERROR_MESSAGES`).
 */
export const PUB_ERROR_REASON_MESSAGES: Readonly<
  Record<string, Record<PubLang, string>>
> = {
  // `per_purchase_max = 0` (аудит Админки, раунд 2): не «мало бюджета».
  'PUB_GATE_CLOSED:purchases_disabled': {
    uk: 'Закупівлі вимкнено: максимум однієї закупівлі — 0',
    ru: 'Закупки отключены: максимум одной закупки — 0',
    en: 'Purchases are disabled: the single purchase maximum is 0',
  },
  'PUB_BUDGET_INSUFFICIENT:purchases_disabled': {
    uk: 'Закупівлі вимкнено: максимум однієї закупівлі — 0',
    ru: 'Закупки отключены: максимум одной закупки — 0',
    en: 'Purchases are disabled: the single purchase maximum is 0',
  },
};

/** Текст ошибки: уточнённый по `reason`, если есть, иначе — текст кода. */
export function pubErrorMessage(
  code: PubErrorCode,
  lang: PubLang,
  reason?: unknown,
): string {
  const byReason =
    typeof reason === 'string'
      ? PUB_ERROR_REASON_MESSAGES[`${code}:${reason}`]
      : undefined;
  return (byReason ?? PUB_ERROR_MESSAGES[code])[lang];
}

/** Язык из `Accept-Language` (первый поддерживаемый; умолчание — uk). */
export function pubLangOf(acceptLanguage: string | undefined | null): PubLang {
  if (!acceptLanguage) return 'uk';
  const tags = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)).find(Boolean);
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q[1]) : 1 };
    })
    .filter((t) => t.tag && t.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of tags) {
    const base = tag.split('-')[0] as PubLang;
    if (PUB_LANGS.includes(base)) return base;
  }
  return 'uk';
}
