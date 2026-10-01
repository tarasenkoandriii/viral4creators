/**
 * Публичные имена виджета, нужные кабинету (зеркало блока «Э2»
 * `sites-backend/src/brand.ts`; сверяет `scripts/widget-view.test.ts`).
 * В кит (`site-tma-kit`) не вынесены: QA виджета нет, а кит — только
 * общее у двух TMA.
 */

/** Путь загрузчика на origin виджета. */
export const WIDGET_LOADER_PATH = '/v1/loader.js';

/** Глобальный объект JS API (`V4CAssist('open')`). */
export const WIDGET_GLOBAL = 'V4CAssist';

/** Якорь «своей кнопки». */
export const WIDGET_ANCHOR = '#v4c-assist';

/** Параметр ссылки «посмотреть на сайте». */
export const WIDGET_PREVIEW_PARAM = 'v4c_preview';

/**
 * Атрибут токена предпросмотра `purpose=tma` у тега загрузчика в
 * конфигураторе — предложение W1 (`data-preview-token`, контракт Э2 §5
 * «W1 ↔ W4»).
 */
export const WIDGET_PREVIEW_TOKEN_ATTR = 'data-preview-token';
