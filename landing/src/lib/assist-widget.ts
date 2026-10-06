/**
 * Э-С Ш5: какой консультант стоит на лендинге — старый (`AssistantWidget`,
 * свой бэкенд `/assistant/*`) или виджет платформы (тенант «viral4creators»
 * в sites-backend, одна строка загрузчика). Чистый модуль: его читают
 * страницы (на сервере, при сборке) и тест `scripts/assist-widget.test.ts`.
 *
 * Переключатель — env сборки лендинга (NEXT_PUBLIC_*: значение
 * вклеивается при `next build`, смена — новый деплой):
 *   NEXT_PUBLIC_ASSIST_WIDGET           `legacy` (умолчание) | `platform`
 *   NEXT_PUBLIC_ASSIST_WIDGET_SRC       адрес загрузчика из кода вставки
 *                                       (TMA помощника → «Установка»)
 *   NEXT_PUBLIC_ASSIST_WIDGET_SITE_KEY  публичный ключ сайта `pk_live_…`
 *
 * По умолчанию — СТАРЫЙ: пока владелец не включил, прод не меняется.
 * `platform` без адреса или ключа (или кривые) — тоже старый: консультант
 * не пропадает со страницы из-за опечатки в env.
 */

export type AssistWidgetChoice =
  | { mode: 'legacy' }
  | { mode: 'platform'; src: string; siteKey: string };

/** Языки интерфейса виджета платформы (`widget/src/shared/config.ts` UI_LANGS). */
export const PLATFORM_UI_LANGS = ['uk', 'ru', 'en'] as const;

/**
 * Публичный ключ сайта виджета — только `pk_live_`/`pk_test_`
 * (WIDGET_PK_*_PREFIX в sites-backend/src/brand.ts). Аудит Ш5: раньше
 * подходил любой `xx_live_…` — `sk_live_…`/`rk_live_…` из соседней
 * переменной вклеился бы в публичный бандл лендинга.
 */
const SITE_KEY = /^pk_(?:live|test)_[0-9A-Za-z]{24}$/;
/** Путь загрузчика (WIDGET_LOADER_PATH в sites-backend/src/brand.ts). */
export const WIDGET_LOADER_PATH = '/v1/loader.js';

/**
 * Аудит Ш5: адрес — только origin виджета + `/v1/loader.js` (не любой
 * `*.js` на любом хосте и порту: опечатка/подмена env не должна
 * подгружать на лендинг произвольный скрипт). Стенд `http://localhost` —
 * только с тестовым ключом `pk_test_`.
 */
function loaderSrc(raw: string | undefined, siteKey: string): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  const https = u.protocol === 'https:' && u.port === '';
  const stand = local && u.protocol === 'http:' && siteKey.startsWith('pk_test_');
  if (!https && !stand) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== WIDGET_LOADER_PATH) return null;
  return u.toString();
}

export function resolveAssistWidget(env: Record<string, string | undefined>): AssistWidgetChoice {
  if ((env.NEXT_PUBLIC_ASSIST_WIDGET ?? '').trim() !== 'platform') return { mode: 'legacy' };
  const siteKey = (env.NEXT_PUBLIC_ASSIST_WIDGET_SITE_KEY ?? '').trim();
  if (!SITE_KEY.test(siteKey)) return { mode: 'legacy' };
  const src = loaderSrc(env.NEXT_PUBLIC_ASSIST_WIDGET_SRC, siteKey);
  if (!src) return { mode: 'legacy' };
  return { mode: 'platform', src, siteKey };
}

/**
 * Значения читаются ЯВНО по имени: Next вклеивает `process.env.<ИМЯ>`
 * (NEXT_PUBLIC_*) только в таком виде, а не через `process.env[name]` или весь объект.
 */
export function assistWidgetFromBuildEnv(): AssistWidgetChoice {
  return resolveAssistWidget({
    NEXT_PUBLIC_ASSIST_WIDGET: process.env.NEXT_PUBLIC_ASSIST_WIDGET,
    NEXT_PUBLIC_ASSIST_WIDGET_SRC: process.env.NEXT_PUBLIC_ASSIST_WIDGET_SRC,
    NEXT_PUBLIC_ASSIST_WIDGET_SITE_KEY: process.env.NEXT_PUBLIC_ASSIST_WIDGET_SITE_KEY,
  });
}

/** `data-lang` загрузчику — только язык, который у виджета есть. */
export function platformLang(locale: string): string | null {
  return (PLATFORM_UI_LANGS as readonly string[]).includes(locale) ? locale : null;
}

/**
 * CSP-директивы, которые нужны виджету (`buildCspSnippet` sites-backend:
 * script-src, frame-src, img-src, connect-src). У лендинга сейчас НЕТ
 * своего CSP (ни в next.config.js, ни в middleware, ни в vercel.json) —
 * добавлять нечего. Если CSP появится, к нему ДОПИСАТЬ эти источники, иначе
 * загрузчик не загрузится; сверку держит `scripts/assist-widget.test.ts`.
 */
export function widgetCspSources(src: string): Record<'script-src' | 'frame-src' | 'img-src' | 'connect-src', string> {
  const origin = new URL(src).origin;
  return {
    'script-src': origin,
    'frame-src': origin,
    'img-src': `${origin} data:`,
    'connect-src': origin,
  };
}
