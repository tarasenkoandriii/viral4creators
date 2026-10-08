/**
 * HTML iframe чата сотрудника (ТЗ §4.12 «„Админка“ — отдельный origin
 * iframe», У-13) — ЧИСТЫЙ модуль. Отдаётся функцией `GET /wa/v1/frame?pk=`
 * на ОТДЕЛЬНОМ origin `wa.<домен>` (Vercel пропускает этот путь только на
 * домене «Админки», а публичный `/w/v1/frame` — только на домене виджета:
 * doc/DEPLOYMENT.md §6.19), с заголовками:
 *   Content-Security-Policy: default-src 'none'; script-src 'self';
 *     style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self';
 *     media-src 'none'; frame-ancestors <verified-хосты САМОЙ админки>;
 *     base-uri 'none'; form-action 'none';
 *     require-trusted-types-for 'script'; trusted-types 'none'
 * Чужая страница (и публичный сайт заказчика) не может даже отрисовать чат
 * сотрудника. Тело — статический шаблон: `/v1/admin-chat.js` и
 * `/v1/admin-chat.css` своего origin; данных сайта в разметке нет.
 */

export const ADMIN_FRAME_ROOT_ID = 'app';

/**
 * Кэш CDN для HTML iframe «Админки» (аудит Э7 (б), Р-З9-16): СВОЯ константа,
 * не общая с виджетом «Сайта» (`WIDGET_DEFAULTS.frameCacheSeconds` = 300).
 * После снятия хоста админки или выключения режима старый `frame-ancestors`
 * живёт в CDN не дольше этого срока (API и сессии гаснут сразу); трафик
 * `wa.` мал — минута кэша почти ничего не стоит.
 */
export const ADMIN_FRAME_CACHE_SECONDS = 60;

/** Cache-Control HTML iframe «Админки». */
export function adminFrameCacheControl(): string {
  return `public, max-age=0, s-maxage=${ADMIN_FRAME_CACHE_SECONDS}`;
}

export function adminFrameHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="uk">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<link rel="stylesheet" href="/v1/admin-chat.css">',
    '<script src="/v1/admin-chat.js" defer></script>',
    '</head>',
    `<body><div id="${ADMIN_FRAME_ROOT_ID}"></div></body>`,
    '</html>',
    '',
  ].join('\n');
}

/** Источник frame-ancestors: `'none'`, https-origin или localhost-стенд. */
const ANCESTOR =
  /^(?:'none'|https:\/\/(?:[a-z0-9-]+\.)+[a-z0-9-]+|http:\/\/(?:localhost|127\.0\.0\.1):\*)$/;

export function adminFrameCsp(ancestors: string[]): string {
  const ok = ancestors.filter((a) => ANCESTOR.test(a) && a !== "'none'");
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'none'",
    `frame-ancestors ${ok.length ? ok.join(' ') : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ');
}
