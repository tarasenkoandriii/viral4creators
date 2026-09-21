/**
 * Обёртка над Telegram WebApp SDK — делает marketplace/ ещё и Telegram
 * Mini App (TMA), тот же приём, что уже есть у frontend/ (см. его
 * lib/telegram.ts — этот файл порт оттуда, адаптированный под Next.js:
 * `process.env.NEXT_PUBLIC_*` вместо `import.meta.env.VITE_*`, без
 * SPA-специфичных вещей вроде hash-роутера (у marketplace/ обычные
 * Next.js path-маршруты — `#tgWebAppData=...` в hash серверный
 * middleware вообще не видит, а свой hash-роутинг marketplace не ведёт)).
 *
 * Полный набор из frontend/ (тема из Telegram, тактильная отдача,
 * openInvoice для Stars, openLink для внешнего OAuth) сюда НЕ перенесён
 * целиком — marketplace пока не показывает Stars-инвойсы, не уводит на
 * внешний OAuth и не имеет собственной тёмной темы (нет .dark/
 * prefers-color-scheme в globals.css, в отличие от frontend/). Перенесено
 * только то, что действительно нужно для identity: initData →
 * X-Telegram-Init-Data (валидируется на бэкенде, backend/src/modules/
 * telegram-auth — тот же контур, что уже использует frontend/).
 */

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: { language_code?: string } };
  ready: () => void;
  expand: () => void;
  colorScheme: 'light' | 'dark';
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

export function isTelegramWebAppAvailable(): boolean {
  return getTelegramWebApp() !== null;
}

/** Безопасный no-op вне Telegram — вызывать один раз при монтировании (см. components/TelegramInit.tsx). */
export function initTelegramWebApp(): void {
  const webApp = getTelegramWebApp();
  if (!webApp) return;
  webApp.ready();
  webApp.expand();
}

/**
 * Заголовки авторизации для API-запросов — тот же приоритет, что уже
 * есть на бэкенде (backend/src/modules/telegram-auth/telegram-identity.middleware.ts):
 * initData сильнее dev-заголовка, dev-заголовок сильнее анонимного
 * запроса. Cookie-логин (lib/telegram-login.ts) в этот список не входит
 * — она не заголовок, браузер прикладывает её сам через
 * `credentials: 'include'`, независимо от этой функции.
 *
 * - Внутри Telegram: реальный initData.
 * - Вне Telegram, но с явно включённым дев-входом
 *   (NEXT_PUBLIC_ALLOW_DEV_AUTH, докер-стенд): заголовок X-Dev-User-Id.
 * - Вне Telegram и без дев-входа: пустой объект — идентичность решает
 *   cookie-логин (или её отсутствие — анонимный запрос), как и раньше.
 */
export function getAuthHeaders(): Record<string, string> {
  const webApp = getTelegramWebApp();
  if (webApp?.initData) {
    return { 'X-Telegram-Init-Data': webApp.initData };
  }
  if (process.env.NEXT_PUBLIC_ALLOW_DEV_AUTH === 'true') {
    const devUserId = process.env.NEXT_PUBLIC_DEV_USER_ID || '123';
    return { 'X-Dev-User-Id': devUserId };
  }
  return {};
}
