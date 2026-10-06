// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/assist-chat-core/index.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

/**
 * `assist-chat-core` — ядро консультанта, вынесенное из
 * `modules/assistant` (ТЗ помощника §0, §4.2; план, Приложение А «Этап 0»).
 * Общее для лендинга и Помощника; специфика продукта (тексты, словарь
 * действий, знания, стоп-фразы, секрет соли) передаётся параметрами.
 *
 * Все файлы папки ЧИСТЫЕ (без Nest, Prisma, env и импортов вне папки):
 * `scripts/sync-sites-shared.mjs` копирует их в `sites-backend/src/shared/`.
 */
export * from './protocol';
export * from './delimiter-buffer';
export * from './actions-parser';
export * from './post-filter';
export * from './forbidden-promises';
export * from './ip-hash';
export * from './timeouts';
export * from './stream-chat';
