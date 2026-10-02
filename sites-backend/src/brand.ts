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

/**
 * Э1: обход сайтов. Имя для групп robots.txt (заказчик пишет
 * `User-agent: V4C-Assist`) и полный User-Agent с адресом страницы о боте
 * (QA-ТЗ §5.5: IP-диапазоны, abuse-контакт, opt-out). Домен не решён
 * (В-1/В-22) — адрес страницы заменится вместе с брендом.
 */
export const CRAWLER_ROBOTS_TOKEN = 'V4C-Assist';
export const CRAWLER_USER_AGENT =
  'Mozilla/5.0 (compatible; V4C-Assist/1.0; +https://v4c.example.invalid/assistant/bot)';

/**
 * Э1: ключ браузера публичной песочницы лендинга (лендинг-ТЗ §6.2:
 * результат открывается только в браузере, запустившем песочницу). Ключ
 * выдаётся один раз в ответе `POST /public/assist/sandbox`, лендинг хранит
 * его в sessionStorage и шлёт этим заголовком; в базе — только SHA-256.
 * Заголовок, а не cookie: лендинг и sites-backend — разные сайты, а
 * сторонние cookie браузеры режут.
 */
export const SANDBOX_KEY_HEADER = 'X-Sandbox-Key';

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

// ══ Э2: виджет на сайте заказчика (ТЗ §3-бис, §4.12, §4-бис) ══════════════
//
// Эти имена заказчик вставляет в вёрстку своего сайта (тег, JS API,
// CSP-фрагмент) — переименование бренда (В-1) должно быть правкой ЭТОГО
// блока и его зеркала `widget/src/brand.ts` (сверяет widget/scripts/brand.test.ts),
// а не поиском по проекту. Домен — заглушка до решения В-1.

/** Origin загрузчика, iframe-чата и публичного API виджета (Vercel-проект `widget`). */
export const WIDGET_ORIGIN_DEFAULT = 'https://w.v4c.example.invalid';

/** Путь загрузчика (версия протокола в пути — не ломаем установленные виджеты, §4.12). */
export const WIDGET_LOADER_PATH = '/v1/loader.js';

/** Путь HTML iframe-чата: отдаёт sites-backend с динамическим frame-ancestors. */
export const WIDGET_FRAME_PATH = '/w/v1/frame';

/** Глобальный объект JS API: `window.V4CAssist('open')` (§3-бис.2). */
export const WIDGET_GLOBAL = 'V4CAssist';

/** Якорь «своей кнопки»: `<a href="#v4c-assist">` открывает чат (§3-бис.3). */
export const WIDGET_ANCHOR = '#v4c-assist';

/** Параметр ссылки «посмотреть на сайте» (§3-бис.4): одноразовый токен. */
export const WIDGET_PREVIEW_PARAM = 'v4c_preview';

/** Префиксы публичных ключей сайта (§4.17). */
export const WIDGET_PK_LIVE_PREFIX = 'pk_live_';
export const WIDGET_PK_TEST_PREFIX = 'pk_test_';

/**
 * CHIPS-cookie указателя посетителя (§4-бис.3, Р-27): `__Host-` — без
 * Domain, Path=/, Secure; плюс `Partitioned; HttpOnly; SameSite=None`.
 * Это ПРЕФИКС: настоящее имя — `widgetResumeCookieName(pk)` ниже.
 */
export const WIDGET_RESUME_COOKIE = '__Host-v4c_resume';

/**
 * Имя cookie указателя ДЛЯ КЛЮЧА САЙТА: `<WIDGET_RESUME_COOKIE>_<8 hex>`.
 * CHIPS партиционирует cookie по сайту ВЕРХНЕГО уровня (eTLD+1): два разных
 * сайта клиентов на одном eTLD+1 (`a.example.com` и `b.example.com`, разные
 * pk) делят одну секцию, и общее имя давало перезапись указателя друг друга
 * (интеграция Э2). Суффикс — FNV-1a 32 бита от pk: не секрет (pk публичен),
 * а короткое различимое имя; считается синхронно и в Node, и в браузере.
 * Зеркало — `widget/src/shared/brand.ts` (сверяет widget/scripts/brand.test.ts).
 */
export function widgetResumeCookieName(pk: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < pk.length; i++) {
    h ^= pk.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${WIDGET_RESUME_COOKIE}_${h.toString(16).padStart(8, '0')}`;
}

/** Заголовок visitor-token запросов iframe → API (не cookie: §4.13 п.2). */
export const WIDGET_VISITOR_TOKEN_HEADER = 'X-Assist-Visitor';

/** Заголовок сессии предпросмотра (после обмена `v4c_preview`). */
export const WIDGET_PREVIEW_SESSION_HEADER = 'X-Assist-Preview';

/**
 * Метка протокола postMessage загрузчик ↔ iframe (§4.12): каждое сообщение
 * несёт `{ ns: WIDGET_MESSAGE_NS, v: 1, type, … }`; чужое `ns`/`v` — игнор.
 */
export const WIDGET_MESSAGE_NS = 'v4c-widget';
export const WIDGET_PROTOCOL_VERSION = 1;

/** Префикс ключей sessionStorage страницы (`<pk>:ui`) и хранилища iframe. */
export const WIDGET_STORAGE_PREFIX = 'v4c_w';

/** Имя BroadcastChannel iframe: `<префикс>:<pk>:<origin родителя>` (§4-бис.7). */
export const WIDGET_CHANNEL_PREFIX = 'v4c-widget';

/** Метка HMAC visitor-token (ключ — производный от ASSIST_SECRETS_KEY, без нового секрета). */
export const WIDGET_TOKEN_HMAC_LABEL = 'v4c-widget-visitor';

/** Метка соли ipHash виджета (как `v4c-sandbox-ip` песочницы Э1). */
export const WIDGET_IP_HASH_LABEL = 'v4c-widget-ip';

/**
 * Э5: метка HMAC «билета голоса» — подпись «этот текст распознан у нас из
 * речи посетителя» (вопрос голосом — диалог весом 2, §7.1). Ключ —
 * производный от ASSIST_SECRETS_KEY, нового секрета нет.
 */
export const WIDGET_VOICE_TICKET_HMAC_LABEL = 'v4c-widget-voice-ticket';

/** Ссылка «Работает на …» в подвале чата (§3-бис.1) — с UTM. */
export const WIDGET_POWERED_BY_URL =
  'https://v4c.example.invalid/assistant?utm_source=widget&utm_medium=powered_by';

// ══ Э3: цели, выбор цели на сайте, интеграции (ТЗ §5-тер.1, §3-бис.2) ═════
// Те же правила, что у блока Э2: заказчик пишет эти имена в вёрстку,
// плагин и вебхук своего бэкенда. Зеркала: widget/src/shared/brand.ts
// (параметр выбора, путь чанка, атрибуты) и
// assist-integrations/npm/src/brand.ts + assist-integrations/wordpress
// (имя пакета, слаг плагина, заголовок подписи) — сверяют их тесты.

/** `?v4c_goal=<токен>` — одноразовый режим выбора цели на сайте (§5-тер.1). */
export const WIDGET_GOAL_PICKER_PARAM = 'v4c_goal';
/** Отдельный чанк режима выбора (в загрузчик не входит — бюджет 12 КБ). */
export const WIDGET_PICKER_PATH = '/v1/picker.js';
/**
 * Ленивый чанк вовлечения и целей (триггеры, пузырь, детекторы целей):
 * загрузчик грузит его после `load` + простоя или при первом взаимодействии
 * и только если в конфиге есть цели/триггеры — бюджет загрузчика 12 КБ.
 */
export const WIDGET_ENGAGE_PATH = '/v1/engage.js';
/** Разметка цели в вёрстке заказчика: клик и отправка формы. */
export const WIDGET_GOAL_ATTR = 'data-assist-goal';
export const WIDGET_GOAL_SUBMIT_ATTR = 'data-assist-goal-submit';
/** Подпись вебхука целей s2s: `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<тело>")>`. */
export const GOAL_WEBHOOK_SIGNATURE_HEADER = 'X-Assist-Signature';
/** npm-пакет обёртки загрузчика (§3-бис.2 «React/Vue/Next.js»). */
export const WIDGET_NPM_PACKAGE = '@v4c/assist-widget';
/** Слаг плагина WordPress/WooCommerce (каталог WordPress — ревью, план §6.3). */
export const WP_PLUGIN_SLUG = 'v4c-assist';
