/**
 * HTML iframe-чата (ТЗ §4.12) — ЧИСТЫЙ модуль, W2. Отдаётся функцией
 * `GET /w/v1/frame?pk=` (не статикой) с заголовками:
 *   Content-Security-Policy: default-src 'none'; script-src 'self';
 *     style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self';
 *     media-src blob: 'self' <хосты роликов> (Э5: озвучка ответа — байты
 *     `POST /widget/v1/tts` из Blob-URL; Э6: ролик обучалки — подписанная
 *     ссылка `/widget/v1/video/:token` своего origin и её редирект на
 *     хранилище роликов, config/media-env.ts ASSIST_VIDEO_HOSTS);
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

/** Имя выпуска — каталог `/v1/r/<имя>/` (common/voice-control-platform.ts). */
const RELEASE = /^[a-z0-9][a-z0-9.-]{0,23}$/;

/**
 * Э6-бис (г), канарейка выпусков (§5-бис.12): у сайта в канарейке (или при
 * заданном стабильном выпуске) чат берётся из `/v1/r/<выпуск>/`; без
 * выпуска — `/v1/` (как раньше). Имя — только правильной формы: в HTML
 * не попадает ничего, кроме пути своего origin.
 */
export function frameHtml(release: string | null = null): string {
  const base = release && RELEASE.test(release) ? `/v1/r/${release}/` : '/v1/';
  return [
    '<!doctype html>',
    '<html lang="uk">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<link rel="stylesheet" href="${base}chat.css">`,
    `<script src="${base}chat.js" defer></script>`,
    '</head>',
    `<body><div id="${FRAME_ROOT_ID}"></div></body>`,
    '</html>',
    '',
  ].join('\n');
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
/** Источник media-src: `https://*.x.y`, `https://x.y`, `http://localhost:*`. */
const MEDIA_SOURCE =
  /^(?:https:\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+|http:\/\/(?:localhost|127\.0\.0\.1):\*)$/;

export function frameCsp(
  ancestors: string,
  mediaSources: string[] = [],
): string {
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
    // Э5: озвучка ответа — Blob-URL из байтов `POST /widget/v1/tts`.
    // Э6: ролик — подписанная ссылка своего origin и редирект на хранилище
    // роликов (только источники правильной формы — как frame-ancestors).
    [
      "media-src blob: 'self'",
      ...mediaSources.filter((m) => MEDIA_SOURCE.test(m)),
    ].join(' '),
    `frame-ancestors ${fa}`,
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ');
}
