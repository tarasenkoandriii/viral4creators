/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** База API клиентских сайтов (sites-backend); по умолчанию `/api`. */
  readonly VITE_SITES_API_URL?: string;
  /** Бот Помощника (без «@»): Login Widget веба и ссылки-приглашения. */
  readonly VITE_ASSIST_BOT_USERNAME?: string;
  /** https-origin sites-backend для адресов на сервере заказчика (вебхук целей). */
  readonly VITE_ASSIST_PUBLIC_API_ORIGIN?: string;
  /** Дев-вход вне Telegram — только локальный стенд. */
  readonly VITE_ALLOW_DEV_AUTH?: string;
  readonly VITE_DEV_USER_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
