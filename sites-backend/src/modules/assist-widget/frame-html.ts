/**
 * HTML iframe-чата (ТЗ §4.12) — ЧИСТЫЙ модуль, W2. Отдаётся функцией
 * `GET /w/v1/frame?pk=` (не статикой) с заголовками:
 *   Content-Security-Policy: default-src 'none'; script-src 'self';
 *     style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self';
 *     frame-ancestors <frameAncestors()>; base-uri 'none'; form-action 'none';
 *     require-trusted-types-for 'script'; trusted-types 'none'
 *   Cache-Control: public, max-age=0, s-maxage=<frameCacheSeconds>
 *   X-Content-Type-Options: nosniff; Referrer-Policy: no-referrer
 * Тело — статический шаблон: `<script src="/v1/chat.js" defer>` и
 * `<link rel=stylesheet href="/v1/chat.css">` (бандл W1, тот же origin
 * через Vercel-проект `widget`); никаких данных сайта в разметке — конфиг
 * iframe берёт запросом.
 *
 * `trusted-types 'none'` (контракт Э2 §3, а не `v4c-chat` из первого
 * эскиза шапки): чат W1 не создаёт политик и не пользуется HTML-приёмниками —
 * любая попытка будет отказом браузера, а не тихой вставкой.
 */

/** Корень, в который монтируется чат W1 (`widget/src/chat/main.tsx`). */
export const FRAME_ROOT_ID = 'app';

const HTML = [
  '<!doctype html>',
  '<html lang="uk">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="robots" content="noindex, nofollow">',
  '<link rel="stylesheet" href="/v1/chat.css">',
  '<script src="/v1/chat.js" defer></script>',
  '</head>',
  `<body><div id="${FRAME_ROOT_ID}"></div></body>`,
  '</html>',
  '',
].join('\n');

export function frameHtml(): string {
  return HTML;
}

/** Источник frame-ancestors: `'none'` или список origin (с `:*` для localhost). */
const ANCESTOR_SOURCE =
  /^(?:'none'|https?:\/\/(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::(?:\d{1,5}|\*))?)$/;

/**
 * Значение frame-ancestors пришло из базы и env — в заголовок попадает
 * только то, что похоже на источник CSP: `;`/пробел-инъекция в имени хоста
 * иначе дописала бы свою директиву. Негодное — отбрасывается; ничего не
 * осталось — `'none'`.
 */
export function frameCsp(ancestors: string): string {
  const sources = ancestors
    .split(/\s+/)
    .filter((s) => s && ANCESTOR_SOURCE.test(s));
  const fa =
    sources.length === 0 || sources.includes("'none'")
      ? "'none'"
      : sources.join(' ');
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-ancestors ${fa}`,
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ');
}
