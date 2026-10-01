/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/telegram.ts */
/**
 * Telegram WebApp для клиентских TMA (Помощник и QA).
 *
 * Отличие от `frontend/src/lib/telegram.ts`: там анонимный браузерный
 * сценарий обязан работать без initData, здесь — нет. Кабинет заказчика
 * существует только как участник по `telegramId` (ТЗ помощника §3.0),
 * поэтому без initData (и без явно включённого дев-входа) экран входа
 * честно говорит «откройте в Telegram», а не шлёт анонимный запрос.
 *
 * `import.meta.env` здесь не читается намеренно: модуль проверяется
 * скриптами под tsx, где Vite-переменных нет. Настройки дев-входа
 * передаёт приложение.
 */

import {
  DEV_USER_HEADER,
  TELEGRAM_APP_HEADER,
  TELEGRAM_INIT_DATA_HEADER,
  type TelegramAppId,
} from './brand';

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: {
    user?: { id?: number; first_name?: string; language_code?: string };
    start_param?: string;
  };
  colorScheme: 'light' | 'dark';
  ready: () => void;
  expand: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  onEvent?: (event: 'themeChanged', handler: () => void) => void;
  BackButton?: {
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
  HapticFeedback?: {
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  const w = window.Telegram?.WebApp;
  // Скрипт telegram-web-app.js определяет WebApp и вне Telegram — с пустым
  // initData. Такой объект — не «мы в Telegram».
  return w && typeof w.initData === 'string' ? w : null;
}

export interface DevAuth {
  enabled: boolean;
  userId?: string;
}

/**
 * Заголовки авторизации для API клиентских сайтов.
 *
 * `X-Telegram-App` — всегда: по нему бэкенд выбирает токен бота
 * (ТЗ §4.1). initData — если он есть; иначе дев-заголовок, если
 * приложение явно включило дев-вход; иначе — `null`: запрос без
 * идентичности кабинетным маршрутам не нужен.
 */
export function buildAuthHeaders(
  app: TelegramAppId,
  initData: string | undefined,
  dev: DevAuth
): Record<string, string> | null {
  if (initData) {
    return {
      [TELEGRAM_APP_HEADER]: app,
      [TELEGRAM_INIT_DATA_HEADER]: initData,
    };
  }
  if (dev.enabled) {
    return {
      [TELEGRAM_APP_HEADER]: app,
      [DEV_USER_HEADER]: dev.userId || '123',
    };
  }
  return null;
}

/**
 * Как приложение узнаёт человека:
 *  - `tma` — открыто в Telegram, есть initData (подписан ботом);
 *  - `dev` — локальный стенд с явно включённым дев-входом;
 *  - `web` — обычный браузер: вход Telegram Login Widget, дальше —
 *    HttpOnly-cookie сессии, которую ставит `sites-backend`.
 *
 * Режим решает ТОЛЬКО initData: скрипт telegram-web-app.js определяет
 * `Telegram.WebApp` и в браузере — с пустым initData, и такой объект не
 * повод считать, что мы в Telegram.
 */
export type AuthMode = 'tma' | 'dev' | 'web';

export function detectAuthMode(
  initData: string | undefined | null,
  dev: DevAuth
): AuthMode {
  if (initData) return 'tma';
  return dev.enabled ? 'dev' : 'web';
}

/** Что приложить к каждому запросу API в выбранном режиме. */
export interface RequestAuth {
  headers: Record<string, string>;
  /**
   * `same-origin` только в веб-режиме: там идентичность — cookie сессии
   * (API за same-origin прокси `/api`). В TMA cookie не нужна и не
   * отправляется (`omit`): личность — только подписанный initData, и
   * случайная cookie из браузерного входа не должна её подменять.
   */
  credentials: RequestCredentials;
}

export function buildRequestAuth(
  app: TelegramAppId,
  mode: AuthMode,
  initData: string | undefined | null,
  dev: DevAuth
): RequestAuth | null {
  if (mode === 'web') {
    // initData нет; X-Telegram-App — чтобы сервер проверил подпись
    // виджета токеном именно этого бота (перебор токенов запрещён).
    return {
      headers: { [TELEGRAM_APP_HEADER]: app },
      credentials: 'same-origin',
    };
  }
  const headers = buildAuthHeaders(
    app,
    mode === 'tma' ? (initData ?? undefined) : undefined,
    mode === 'dev' ? dev : { enabled: false }
  );
  return headers ? { headers, credentials: 'omit' } : null;
}

/** Тёмная/светлая тема — по Telegram, вне Telegram — по системе. */
export function resolveDark(
  webApp: Pick<TelegramWebApp, 'colorScheme'> | null,
  systemPrefersDark: boolean
): boolean {
  return webApp ? webApp.colorScheme === 'dark' : systemPrefersDark;
}

function systemDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Фон шапки Telegram — в цвет нашего фона, иначе два оттенка рядом. */
const CHROME = { dark: '#0e1621', light: '#f7f8fa' };

export function applyTheme(): void {
  const webApp = getTelegramWebApp();
  const dark = resolveDark(webApp, systemDark());
  document.documentElement.classList.toggle('dark', dark);
  const color = dark ? CHROME.dark : CHROME.light;
  webApp?.setBackgroundColor?.(color);
  webApp?.setHeaderColor?.(color);
}

/**
 * Telegram дописывает в hash свой `#tgWebAppData=…` — hash-роутер принял
 * бы его за путь и показал «не найдено» (урок `frontend/`, этап 134).
 * Параметр запуска (`startapp`) читаем ДО очистки.
 */
export function readStartParam(): string | null {
  const fromSdk = getTelegramWebApp()?.initDataUnsafe?.start_param;
  if (fromSdk) return fromSdk;
  if (typeof window === 'undefined') return null;
  const raw = window.location.hash.replace(/^#/, '');
  const fromHash = new URLSearchParams(raw).get('tgWebAppStartParam');
  return fromHash || null;
}

/**
 * Hash после запуска без служебных параметров Telegram. Кнопка бота ведёт
 * и на маршрут (уведомление «версия удержана» →
 * `…#/sites/<id>/knowledge/site/versions`), и тогда Telegram дописывает
 * параметры К НЕМУ: `#/sites/…/versions?tgWebAppData=…` (так их и
 * разбирает telegram-web-app.js — `_path` до `?`). Срезать весь hash —
 * значит открыть главную вместо экрана из уведомления. Маршрут
 * сохраняется, параметры — нет; маршрута нет — пустой hash.
 */
export function launchHashRoute(hash: string): string {
  const raw = hash.replace(/^#/, '');
  if (!raw.includes('tgWebAppData=')) return hash;
  if (!raw.startsWith('/')) return '';
  const path = raw.split(/[?&]/, 1)[0];
  return path.includes('=') ? '' : `#${path}`;
}

function stripTelegramLaunchHash(): void {
  const hash = window.location.hash;
  if (!hash.includes('tgWebAppData=')) return;
  window.history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search + launchHashRoute(hash)
  );
}

/** Вызывается один раз в main.tsx до первого рендера. */
export function initTelegram(): { startParam: string | null } {
  const startParam = readStartParam();
  stripTelegramLaunchHash();
  applyTheme();
  const webApp = getTelegramWebApp();
  if (webApp) {
    webApp.ready();
    webApp.expand();
    webApp.onEvent?.('themeChanged', applyTheme);
  } else if (typeof window.matchMedia === 'function') {
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener?.('change', applyTheme);
  }
  return { startParam };
}

export function telegramLanguageCode(): string | undefined {
  return getTelegramWebApp()?.initDataUnsafe?.user?.language_code;
}

export function hapticResult(ok: boolean): void {
  getTelegramWebApp()?.HapticFeedback?.notificationOccurred(
    ok ? 'success' : 'error'
  );
}
