/**
 * HTML iframe панели редактора голосовой карты (Э6-тер, ТЗ §5-кватер.3,
 * В-51) — ЧИСТЫЙ модуль. Отдаётся функцией `GET /we/v1/frame?pk=` на
 * ОТДЕЛЬНОМ origin `we.<домен>` (не `w.` публичного чата: сессия редактора
 * меняет поведение помощника для всех посетителей, а чат `w.` — самое
 * враждебное место продукта; doc/DEPLOYMENT.md §6.22), с заголовками:
 *   Content-Security-Policy: default-src 'none'; script-src 'self';
 *     style-src 'self'; img-src 'self'; connect-src 'self'; media-src 'none';
 *     frame-ancestors <verified-хосты «Сайта» без льготы>; base-uri 'none';
 *     form-action 'none'; require-trusted-types-for 'script'; trusted-types 'none'
 * На чужой странице панель не рисуется. Тело — статический шаблон: чанк
 * `/v1/editor-panel.js` и `/v1/editor-panel.css` своего origin; токен
 * ссылки — во ФРАГМЕНТЕ адреса iframe (`#t=…`: не уходит на сервер с
 * запросом HTML и в `Referer`).
 */
import { WIDGET_EDITOR_PANEL_PATH } from '../../../brand';

export const EDITOR_FRAME_ROOT_ID = 'app';

export function editorFrameHtml(): string {
  const css = WIDGET_EDITOR_PANEL_PATH.replace(/\.js$/, '.css');
  return [
    '<!doctype html>',
    '<html lang="uk">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<link rel="stylesheet" href="${css}">`,
    `<script src="${WIDGET_EDITOR_PANEL_PATH}" defer></script>`,
    '</head>',
    `<body><div id="${EDITOR_FRAME_ROOT_ID}"></div></body>`,
    '</html>',
    '',
  ].join('\n');
}

/** Источник frame-ancestors: https-origin или localhost-стенд (pk_test_). */
const ANCESTOR =
  /^(?:https:\/\/(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::\d{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1):\*)$/;

export function editorFrameCsp(ancestors: string[]): string {
  const ok = ancestors.filter((a) => ANCESTOR.test(a));
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "media-src 'none'",
    `frame-ancestors ${ok.length ? ok.join(' ') : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ');
}
