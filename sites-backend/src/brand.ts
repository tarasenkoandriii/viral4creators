/**
 * ВСЕ публичные технические имена продукта — в одном месте.
 *
 * Бренд ещё не решён (В-1/В-22 плана помощника), а имена ниже видит
 * заказчик: он вписывает их в DNS, кладёт файл на свой сервер, вставляет
 * мета-тег. Когда бренд утвердят, переименование должно быть правкой ОДНОГО
 * файла (и его зеркала во фронтенде), а не поиском строк по проекту.
 * Поэтому ни один модуль не пишет `v4c-verify` литералом — только через
 * этот файл (решение координатора Э0, п.4).
 *
 * Формат подтверждения владения — ровно QA-ТЗ §2.4 (общий с помощником):
 *  - DNS: TXT `_v4c-verify.<хост>` со значением `v4c-verify=<токен>`;
 *  - файл: `https://<хост>/.well-known/v4c-verify.txt`, токен в первой строке;
 *  - мета: `<meta name="v4c-verify" content="<токен>">` на `/`.
 */

/** Префикс имени TXT-записи: `_v4c-verify.<хост>`. */
export const VERIFY_TXT_PREFIX = '_v4c-verify';

/** Ключ в значении TXT-записи: `v4c-verify=<токен>`. */
export const VERIFY_TXT_KEY = 'v4c-verify';

/** Путь файла-маркера в корне хоста. */
export const VERIFY_FILE_PATH = '/.well-known/v4c-verify.txt';

/** `name` мета-тега на главной. */
export const VERIFY_META_NAME = 'v4c-verify';

/**
 * Заголовок, которым TMA сообщает, из какого бота она открыта. По нему
 * выбирается токен бота для проверки initData — перебор токенов запрещён
 * (решение координатора Э0, п.5).
 */
export const TELEGRAM_APP_HEADER = 'X-Telegram-App';

/** initData Telegram — тот же заголовок, что у генератора видео и фронта. */
export const TELEGRAM_INIT_DATA_HEADER = 'X-Telegram-Init-Data';

/**
 * Дев-вход вне Telegram: условный telegramId. Бэкенд принимает его только
 * при `ALLOW_DEV_AUTH=true` и `NODE_ENV !== 'production'` (как backend).
 */
export const DEV_USER_HEADER = 'X-Dev-User-Id';

/**
 * Cookie сессии веб-кабинета (вход виджетом Telegram в обычном браузере).
 * HttpOnly — фронт её не читает, но имя видно в DevTools у заказчика и
 * в инструкциях поддержки, поэтому оно тоже здесь, а не литералом в коде.
 */
export const WEB_SESSION_COOKIE = 'v4c_site_session';

/** Значения заголовка `X-Telegram-App`. */
export const TELEGRAM_APPS = ['assist', 'qa'] as const;
export type TelegramApp = (typeof TELEGRAM_APPS)[number];

/** Имя TXT-записи для хоста: `_v4c-verify.shop.example.com`. */
export function verifyTxtName(host: string): string {
  return `${VERIFY_TXT_PREFIX}.${host}`;
}

/** Значение TXT-записи: `v4c-verify=<токен>`. */
export function verifyTxtValue(token: string): string {
  return `${VERIFY_TXT_KEY}=${token}`;
}

/** Мета-тег целиком — для инструкции заказчику «вставьте в <head>». */
export function verifyMetaTag(token: string): string {
  return `<meta name="${VERIFY_META_NAME}" content="${token}">`;
}

/**
 * Значение заголовка → приложение. Регистр не важен (прокси и клиенты
 * его меняют), а всё, кроме двух известных значений, — `null`: вызывающий
 * код обязан ответить отказом, а не «угадать» бота.
 */
export function parseTelegramApp(
  value: string | string[] | undefined,
): TelegramApp | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return (TELEGRAM_APPS as readonly string[]).includes(v)
    ? (v as TelegramApp)
    : null;
}
