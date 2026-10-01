/**
 * Настройки сборки. Единственное место, где читается `import.meta.env`:
 * site-tma-kit получает их параметрами (его проверяют скрипты под tsx, где
 * Vite-переменных нет).
 */

import type { DevAuth } from '../kit';

export const APP_ID = 'assist' as const;

/**
 * База API. По умолчанию `/api` — same-origin прокси на sites-backend
 * (rewrite в `assist/vercel.json`): веб-кабинету нужна cookie сессии, а
 * same-origin избавляет от third-party-cookie и CORS с credentials.
 * `VITE_SITES_API_URL` переопределяет (локальный стенд без прокси).
 */
export const SITES_API_URL: string =
  import.meta.env.VITE_SITES_API_URL || '/api';

/**
 * Бот Помощника без «@»: Login Widget веб-кабинета (`data-telegram-login`)
 * и ссылки-приглашения `t.me/<бот>?startapp=inv_…`.
 */
export const ASSIST_BOT_USERNAME: string | null =
  (import.meta.env.VITE_ASSIST_BOT_USERNAME ?? '').replace(/^@/, '').trim() ||
  null;

export const DEV_AUTH: DevAuth = {
  // Только для локального стенда; в прод-сборке переменная не задаётся.
  enabled: import.meta.env.VITE_ALLOW_DEV_AUTH === 'true',
  userId: import.meta.env.VITE_DEV_USER_ID,
};
