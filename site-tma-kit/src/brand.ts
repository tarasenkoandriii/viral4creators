/**
 * Все публичные имена клиентских TMA — в ОДНОМ месте (контракт Э0 п.4).
 *
 * Почему один файл: бренд ещё не решён (В-1/В-22 плана помощника), а эти
 * строки живут у заказчиков годами — в DNS-зонах, в файлах на их
 * серверах, в разметке главной. Переименование потом должно быть правкой
 * одного файла, а не поиском по экранам. Бэкенд держит зеркало —
 * `sites-backend/src/brand.ts` (те же имена констант); значения обязаны
 * совпадать — сверяет `assist/scripts/brand.test.ts` (формат —
 * дословно `TZ-QA-TMA.md` §2.4 и ТЗ помощника §3.3).
 */

/** Имя TXT-записи: `_v4c-verify.<хост>`. */
export const VERIFY_TXT_PREFIX = '_v4c-verify';

/** Ключ в значении TXT-записи: `v4c-verify=<токен кабинета>`. */
export const VERIFY_TXT_KEY = 'v4c-verify';

/** Файл-маркер в корне хоста; токен — в первой строке. */
export const VERIFY_FILE_PATH = '/.well-known/v4c-verify.txt';

/** Мета-тег на `/`: `<meta name="v4c-verify" content="<токен>">`. */
export const VERIFY_META_NAME = 'v4c-verify';

/**
 * Заголовок, которым фронт сообщает бэкенду, ЧЕЙ это initData (ТЗ §4.1):
 * у двух ботов разные токены, и перебирать их по очереди запрещено —
 * тогда initData одного бота открывал бы маршруты другого.
 */
export const TELEGRAM_APP_HEADER = 'X-Telegram-App';

/** initData Telegram — тот же заголовок, что у генератора видео. */
export const TELEGRAM_INIT_DATA_HEADER = 'X-Telegram-Init-Data';

/** Дев-вход вне Telegram (только локальный стенд, как во `frontend/`). */
export const DEV_USER_HEADER = 'X-Dev-User-Id';

/**
 * Какой кабинет открыть, если человек состоит в нескольких (свой +
 * агентства): `sites-backend` читает этот заголовок в `SiteAccountGuard`.
 * Без него сервер берёт кабинет, куда человека добавили последним.
 */
export const SITE_ACCOUNT_HEADER = 'X-Site-Account';

/** Ключи localStorage — с общим префиксом, чтобы не пересечься с `frontend/`. */
export const STORAGE_PREFIX = 'v4c_sites_';

export type TelegramAppId = 'assist' | 'qa';

/** Название продукта в шапке TMA — тоже публичное имя. */
export const PRODUCT_NAMES: Record<
  TelegramAppId,
  Record<'uk' | 'ru' | 'en', string>
> = {
  assist: { uk: 'Помічник', ru: 'Помощник', en: 'Assistant' },
  qa: { uk: 'QA сайтів', ru: 'QA сайтов', en: 'Site QA' },
};
