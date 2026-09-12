/**
 * Обёртка над Telegram WebApp SDK — делает существующий frontend/ ещё и
 * Telegram Mini App (TMA), см. doc/TELEGRAM-ADMIN.md.
 *
 * Перенесено из проекта Devil's Advocate
 * (apps/tma/src/lib/telegram.ts), С ОДНИМ содержательным отличием в
 * getAuthHeaders(): там TMA без Telegram вообще не работает, и функция
 * бросает, если нет ни initData, ни dev-заголовка. Здесь — наоборот:
 * обычный браузерный сценарий (сессия по анонимному UUID, без аккаунта)
 * обязан продолжать работать без единого auth-заголовка, ровно как до
 * этой правки. Поэтому здесь — возврат `{}` вместо throw.
 *
 * В реальном запуске внутри Telegram window.Telegram.WebApp существует
 * и содержит initData, готовый к отправке в X-Telegram-Init-Data
 * (валидируется на бэкенде, см. backend/src/modules/telegram-auth).
 *
 * DEV-режим: если window.Telegram недоступен (обычная разработка в
 * браузере вне Telegram) И явно включён VITE_ALLOW_DEV_AUTH — заголовок
 * X-Dev-User-Id (зеркально dev-bypass на бэкенде, ALLOW_DEV_AUTH=true).
 */

import { readStoredThemePreference } from './theme';

export interface TelegramWebApp {
  initData: string;
  // Этап 55 — только для НАЧАЛЬНОГО определения языка интерфейса
  // (lib/i18n.ts, initialLocale()): это то, что Telegram передаёт САМ, по
  // настройке языка в своём клиенте, а не выведенное значение вроде
  // Accept-Language браузера. Не используется для авторизации — это
  // делает исключительно валидируемый на бэкенде initData (см.
  // getAuthHeaders() ниже).
  initDataUnsafe?: { user?: { language_code?: string } };
  ready: () => void;
  expand: () => void;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  onEvent?: (event: 'themeChanged', handler: () => void) => void;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
  };
  /**
   * Оплата Telegram Stars внутри Mini App (этап 62, ТЗ §41.2) — открывает
   * нативный экран оплаты Telegram поверх приложения, БЕЗ ухода со
   * страницы (в отличие от WayForPay-редиректа). `url` — результат
   * `createInvoiceLink` с бэкенда (services/billing-api.ts), не
   * произвольная ссылка.
   */
  openInvoice?: (
    url: string,
    callback?: (status: 'paid' | 'cancelled' | 'failed' | 'pending') => void
  ) => void;
  /**
   * Открыть ссылку в системном браузере, а не внутри WebView Mini App
   * (Г-1.4, аудит round4, этап 64) — нужно для OAuth-авторизации у
   * внешних площадок (Google/TikTok): Google блокирует встроенные WebView
   * (`403 disallowed_userAgent`), надёжно воспроизводится на
   * Android-WebView Telegram.
   */
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
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

/**
 * Тема (класс `dark` на <html>, см. tailwind.config.js darkMode:'class').
 * Этап 81: явный выбор человека (см. lib/theme.ts, ThemeToggle) теперь
 * приоритетнее автоматики — ровно как явный выбор языка приоритетнее
 * initData Telegram (initialLocale() в lib/i18n.ts). Автоматика (без
 * явного выбора) не изменилась: внутри Telegram — следуем
 * tg.colorScheme, вне Telegram — за системной настройкой, с тёмной по
 * умолчанию (index.html стартует с class="dark", чтобы не было вспышки
 * светлого). Экспортирована отдельно, чтобы вызывать и при смене темы
 * на лету (сама живая смена — событие Telegram themeChanged/matchMedia
 * — тоже игнорируется, если человек уже переключал тему явно, см. ниже).
 */
export function applyTheme(): void {
  const stored = readStoredThemePreference();
  if (stored) {
    document.documentElement.classList.toggle('dark', stored === 'dark');
    return;
  }
  const webApp = getTelegramWebApp();
  const prefersDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = webApp
    ? webApp.colorScheme !== 'light'
    : prefersDark || !window.matchMedia;
  document.documentElement.classList.toggle('dark', dark);
}

/**
 * Telegram при каждом открытии Mini App дописывает в URL hash свой
 * служебный payload — `#tgWebAppData=...&tgWebAppVersion=...&tgWebAppPlatform=...`
 * (это единственный способ, которым TMA передаёт initData в WebView на
 * старте; тот же initData отдельно доступен через `webApp.initData`,
 * так что сам hash приложению не нужен). Роутер (lib/router.ts) читает
 * `window.location.hash` как ЕДИНСТВЕННЫЙ источник маршрута — без этой
 * очистки он получает вместо пути строку от Telegram, ни один `if` в
 * `parseRoute` не совпадает, и первый же экран внутри Telegram — «Страница
 * не найдена». Deep-линки через Telegram `start_param` в проекте не
 * используются (см. комментарий в hooks/useWorkflow.ts — параметр
 * приходит query-строкой), так что просто отбрасываем весь hash целиком,
 * ДО того как `useRoute()` в App.tsx впервые его прочитает (эта функция
 * вызывается в main.tsx синхронно, до `ReactDOM...render()`).
 */
function stripTelegramLaunchHash(): void {
  if (typeof window === 'undefined') return;
  if (!window.location.hash.includes('tgWebAppData=')) return;
  window.history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search
  );
}

/** Безопасный no-op вне Telegram — вызывать один раз при монтировании
 * приложения (см. main.tsx). */
export function initTelegramWebApp(): void {
  stripTelegramLaunchHash();
  applyTheme();
  if (
    !getTelegramWebApp() &&
    typeof window !== 'undefined' &&
    window.matchMedia
  ) {
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener?.('change', applyTheme);
  }

  const webApp = getTelegramWebApp();
  if (!webApp) return;

  webApp.ready();
  webApp.expand();
  // Наши собственные цвета фона/шапки в цветах палитры (silver-950 /
  // silver-50), а не Telegram'овские themeParams — иначе шапка Telegram
  // и тело приложения получаются разного оттенка. Telegram красит
  // системную шапку в то, что мы передадим.
  //
  // Этап 81: раньше здесь читался webApp.colorScheme напрямую — при
  // явном выборе темы человеком (см. lib/theme.ts) это стало враньём
  // (webApp.colorScheme — тема САМОГО Telegram, а не выбор человека
  // внутри приложения). Источник истины теперь один — класс `dark` на
  // <html>, уже выставленный applyTheme() строкой выше с учётом
  // явного выбора.
  const chromeColor = () =>
    document.documentElement.classList.contains('dark') ? '#0e1621' : '#f7f8fa';
  webApp.setBackgroundColor(chromeColor());
  webApp.setHeaderColor(chromeColor());
  webApp.onEvent?.('themeChanged', () => {
    applyTheme();
    webApp.setBackgroundColor(chromeColor());
    webApp.setHeaderColor(chromeColor());
  });
}

/**
 * Заголовки авторизации для API-запросов.
 *
 * - Внутри Telegram: реальный initData.
 * - Вне Telegram, но с явно включённым дев-входом (VITE_ALLOW_DEV_AUTH,
 *   докер-стенд): заголовок X-Dev-User-Id.
 * - Вне Telegram и без дев-входа (обычный сценарий продукта в браузере):
 *   пустой объект — запрос идёт полностью анонимно, ровно как раньше.
 */
export function getAuthHeaders(): Record<string, string> {
  const webApp = getTelegramWebApp();
  if (webApp?.initData) {
    return { 'X-Telegram-Init-Data': webApp.initData };
  }

  if (import.meta.env.VITE_ALLOW_DEV_AUTH === 'true') {
    const devUserId = import.meta.env.VITE_DEV_USER_ID || '123';
    console.warn(
      `[DEV] Telegram WebApp недоступен — используется X-Dev-User-Id=${devUserId}. Не должно происходить в production-сборке.`
    );
    return { 'X-Dev-User-Id': devUserId };
  }

  return {};
}

/** Лёгкая тактильная отдача на выбор/тап — no-op вне Telegram. */
export function haptic(style: 'light' | 'medium' | 'heavy' = 'light'): void {
  getTelegramWebApp()?.HapticFeedback?.impactOccurred(style);
}

/**
 * Открывает оплату Stars и резолвится итоговым статусом (этап 62).
 * `'failed'` — и настоящий отказ платежа, и «нет Telegram/старый клиент
 * без openInvoice»: обе причины экран показывает одним и тем же текстом
 * («не удалось открыть оплату»), различать их пользователю незачем — в
 * обоих случаях правильное действие одно и то же, попробовать снова
 * внутри актуального Telegram.
 */
/**
 * Переход на внешнюю площадку (OAuth-авторизация YouTube/TikTok, Г-1.4
 * аудита round4, этап 64). Раньше `ChannelsScreen` делал
 * `window.location.href = url` — ЭТО навигация внутри текущего WebView
 * Telegram, а не системного браузера, и Google OAuth такие WebView
 * блокирует (см. комментарий у `openLink` в интерфейсе выше). `openLink`
 * — штатный способ Mini App открыть системный браузер, где OAuth
 * работает как обычно.
 *
 * Вне Telegram (обычная разработка/браузер) WebView-ограничение ни при
 * чём — обычная навигация уже работает штатно, поэтому там сохраняется
 * прежнее поведение.
 */
export function openExternalLink(url: string): void {
  const webApp = getTelegramWebApp();
  if (webApp?.openLink) {
    webApp.openLink(url);
    return;
  }
  window.location.href = url;
}

export function openStarsInvoice(
  url: string
): Promise<'paid' | 'cancelled' | 'failed' | 'pending'> {
  return new Promise((resolve) => {
    const webApp = getTelegramWebApp();
    if (!webApp?.openInvoice) {
      resolve('failed');
      return;
    }
    webApp.openInvoice(url, (status) => resolve(status));
  });
}
