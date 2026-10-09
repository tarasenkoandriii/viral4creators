/**
 * HTML iframe панели редактора карты «Админки» (заход 11, №117; ТЗ
 * §5-кватер.3: «для „Админки“ — iframe `wa.<домен>` (тот же origin, что чат
 * сотрудника)») — ЧИСТЫЙ модуль. Отдаётся `GET /wa/v1/editor-frame?pk=` на
 * origin «Админки» (rewrite Vercel `/wa/v1/*` — только на домене `wa.`,
 * doc/DEPLOYMENT.md §6.19) с CSP чата сотрудника (`adminFrameCsp`:
 * frame-ancestors — verified-хосты САМОЙ админки). Тело — тот же статический
 * чанк панели, что у `we.` (`/v1/editor-panel.js|css` своего origin), плюс
 * метка контура `<meta name="v4c-editor-kind" content="admin">`: по ней
 * панель берёт API `/assist-admin/v1/editor/*` и шлёт сессию сотрудника
 * `wa.` вторым заголовком. Данных сайта в разметке нет; токен ссылки — во
 * фрагменте адреса iframe (`#t=…`), как у `we.`.
 */
import {
  EDITOR_KIND_META,
  WIDGET_ADMIN_EDITOR_FRAME_PATH,
  WIDGET_EDITOR_PANEL_PATH,
} from '../../../brand';

/** Зеркало виджета — `widget/src/shared/brand.ts` (сверяет brand.test.ts). */
export const ADMIN_EDITOR_FRAME_PATH = WIDGET_ADMIN_EDITOR_FRAME_PATH;
export const ADMIN_EDITOR_KIND_META = EDITOR_KIND_META;
export const ADMIN_EDITOR_FRAME_ROOT_ID = 'app';

export function adminEditorFrameHtml(): string {
  const css = WIDGET_EDITOR_PANEL_PATH.replace(/\.js$/, '.css');
  return [
    '<!doctype html>',
    '<html lang="uk">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<meta name="${ADMIN_EDITOR_KIND_META}" content="admin">`,
    `<link rel="stylesheet" href="${css}">`,
    `<script src="${WIDGET_EDITOR_PANEL_PATH}" defer></script>`,
    '</head>',
    `<body><div id="${ADMIN_EDITOR_FRAME_ROOT_ID}"></div></body>`,
    '</html>',
    '',
  ].join('\n');
}
