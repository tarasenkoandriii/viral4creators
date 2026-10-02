/**
 * ВСЕ публичные имена лендинга — в одном месте.
 *
 * Бренд и домен семейства «клиентские сайты» ещё не решены (В-1 ТЗ
 * лендинга, В-1/В-22 плана помощника). Пока решения нет, здесь стоят
 * нейтральные заглушки, и переименование — правка ЭТОГО файла (плюс
 * пересборка OG-карточек `npm run og`, в них имя впечатано картинкой).
 * Ни одна страница, словарь или метаданные не пишут имя литералом —
 * словари ссылаются на него плейсхолдером `{brand}`.
 *
 * Чего здесь нет и почему:
 *  - **адреса сайта.** Он приходит из env `SITE_URL` (см. `lib/site-url.ts`
 *    и `next.config.js`): прод-сборка без него падает, а не строит
 *    canonical/hreflang на относительные пути или localhost (урок Ф-4,
 *    §0 ТЗ). `domainPlaceholder` ниже — только то, что вписано в
 *    `.env.example` и в CI-сборку, чтобы заглушку нельзя было принять за
 *    настоящий домен (`.invalid` зарезервирован RFC 2606 и не резолвится);
 *  - **имени бота.** Кнопки «Подключить в Telegram» в Л1 нет (реестр
 *    утверждений: `tma-connect` — `hidden`), а когда появится — имя бота
 *    придёт из env без дефолта (§7.1: выдуманное имя уводит к чужому боту).
 */
export const BRAND = {
  /** Имя бренда (В-1). Заглушка: видно, что не решено, и не похоже на чужую марку. */
  name: '<бренд>',
  /** Домен-заглушка до решения В-1. Реальный адрес — env `SITE_URL`. */
  domainPlaceholder: 'example.invalid',
  /**
   * Юридическое лицо — оператор формы пилота и сайта (контролёр ПД в
   * черновиках юр-страниц). Заполняет владелец вместе с юристом; пока
   * заглушка, поэтому юр-страницы — черновики с пометкой.
   */
  legalEntity: '[найменування оператора — заповнює власник]',
  /**
   * Название продуктов на витрине. Это не бренд, а род продукта —
   * поэтому строки локализованы в словарях; здесь — только машинные
   * ключи разделов (они же сегменты URL, нелокализованные, §3.1).
   */
  sections: { assistant: 'assistant', qa: 'qa' },
} as const;

export const BRAND_IS_PLACEHOLDER = BRAND.name === '<бренд>';

/**
 * Адреса продукта по умолчанию (Л2–Л3) — ВРЕМЕННЫЕ домены до решения В-1
 * (`doc/DEPLOYMENT.md` §6.0): виджет, API и кабинет живут на поддоменах
 * `viral4creators.app`. Переопределяются env (`ASSIST_WIDGET_ORIGIN`,
 * `ASSIST_API_ORIGIN`; проверка — `lib/assist-env.ts` и `next.config.js`),
 * после В-1 — правка этих строк. Компоненты адресов литералом не пишут.
 *
 * Чего здесь нет: публичного ключа нашего виджета (`ASSIST_WIDGET_PK`) и
 * имени бота (`ASSIST_BOT_USERNAME`) — только из env и без дефолта: без
 * ключа живого виджета на лендинге нет, без бота — нет кнопки «в Telegram»
 * (§7.1: выдуманное имя уводит к чужому боту).
 */
export const ASSIST_DEFAULTS = {
  widgetOrigin: 'https://assist-w.viral4creators.app',
  apiOrigin: 'https://assist-api.viral4creators.app',
} as const;

/**
 * Публичные имена виджета — зеркало `widget/src/shared/brand.ts`
 * (`WIDGET_LOADER_PATH`, `WIDGET_GLOBAL`); сверяет `scripts/assist-env.test.ts`.
 * Меняются вместе с В-1 (аудит 01.10: «v4c» в публичных именах).
 */
export const WIDGET_NAMES = {
  loaderPath: '/v1/loader.js',
  global: 'V4CAssist',
  /** Якорь «своей кнопки»: ссылка на него открывает чат (`WIDGET_ANCHOR`). */
  anchor: '#v4c-assist',
} as const;

/**
 * Публичные технические имена продукта, которые показывают документация
 * и страницы платформ (Л5) — зеркало `sites-backend/src/brand.ts` (+
 * `assist-integrations/npm/src/brand.ts`, `…/wordpress/…/brand.php`);
 * сверяет `scripts/integrations.test.ts`. Переименование — вместе с В-1
 * (у всех заказчиков — переустановка, аудит 01.10).
 */
export const PRODUCT_NAMES = {
  /** TXT `_v4c-verify.<хост>` со значением `v4c-verify=<токен>`. */
  verifyTxtPrefix: '_v4c-verify',
  verifyTxtKey: 'v4c-verify',
  verifyFilePath: '/.well-known/v4c-verify.txt',
  verifyMetaName: 'v4c-verify',
  /** Группа `User-agent:` в robots.txt заказчика для нашего обходчика. */
  crawlerRobotsToken: 'V4C-Assist',
  /** Полный User-Agent обходчика; в нём — адрес страницы о боте. */
  crawlerUserAgent: 'Mozilla/5.0 (compatible; V4C-Assist/1.0; +https://v4c.example.invalid/assistant/bot)',
  /** Заголовок ключа браузера публичной песочницы. */
  sandboxKeyHeader: 'X-Sandbox-Key',
  /** Подпись вебхука целей: `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<тело>")>`. */
  webhookSignatureHeader: 'X-Assist-Signature',
  npmPackage: '@v4c/assist-widget',
  wpPluginSlug: 'v4c-assist',
  /** Разметка цели в вёрстке: клик и отправка формы. */
  goalAttr: 'data-assist-goal',
  goalSubmitAttr: 'data-assist-goal-submit',
  /** Префикс `startapp` переноса песочницы (`site-tma-kit/src/start-param.ts`). */
  sandboxStartPrefix: 'sb_',
} as const;
