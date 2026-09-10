// `export = sanitize` в @types/sanitize-html (CJS-модуль без интеропа
// default-экспорта) — tsconfig здесь без `esModuleInterop`, поэтому
// `import sanitizeHtml from 'sanitize-html'` компилируется в вызов
// несуществующего `.default` и падает в рантайме. `import ... =
// require(...)` — корректный TS-способ подключить такой модуль.
import sanitizeHtml = require('sanitize-html');

/**
 * Г-3.1 (аудит round4, этап 64): HTML статей блога раньше писался в БД
 * (и рендерился на лендинге/в админке) БЕЗ какой-либо санитизации —
 * `grep sanitize|DOMPurify` по всему проекту находил 0 совпадений.
 * Источники текста небезопасны в обе стороны:
 *  - `blog-generation.service.ts` — Gemini собирает `bodyHtml` из
 *    заголовка/описания ЧУЖОГО YouTube-ролика (prompt-injection в
 *    описании → `<img onerror>` в ответе модели);
 *  - `blog-translation-apply.ts` — то же самое от xAI Grok при переводе;
 *  - ручные записи оператора (`adminCreateManual`/`adminUpdate`) — сам
 *    оператор не обязан быть источником доверия для сырого HTML.
 * Черновик рендерится оператору В АДМИНКЕ ДО модерации
 * (`dangerouslySetInnerHTML`, cookie AdminSession — из XSS доступны
 * approve/refund/block), а после публикации — каждому посетителю
 * лендинга. Санитизация — ОДНА функция на входе в БД (единственное
 * место, общее для всех путей записи `bodyHtml`, включая переводы) —
 * закрывает оба случая разом, без отдельного фильтра на каждом рендере.
 *
 * Allow-list — ровно то, что нужно для статьи-текста (форматирование +
 * ссылки), ничего интерактивного и ничего, что рендерит атрибуты со
 * скриптами (`onerror`/`onclick` и т.п. не в allowedAttributes — сами
 * отбрасываются библиотекой, даже если бы тег был разрешён).
 */
const ALLOWED_TAGS = ['p', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'br'];

export function sanitizeBlogHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href'] },
    // a[href^=https] из аудита — только https, никаких javascript:/data:/
    // протокол-независимых (//evil.com) ссылок.
    allowedSchemes: ['https'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
  });
}
