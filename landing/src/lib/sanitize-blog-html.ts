import sanitizeHtml from 'sanitize-html';

/**
 * Г-3.1 (аудит round4, этап 64): вторым слоем перед рендером — тот же
 * allow-list, что и на входе в БД backend'а
 * (`backend/src/common/sanitize-blog-html.ts`). Backend уже санитизирует
 * `bodyHtml` на всех путях записи (ИИ-черновик/перевод/ручная правка),
 * но эта страница — Server Component (Node, не браузер), а не
 * пользовательский ввод, так что повторный фильтр здесь дёшев и
 * защищает от строк, заведённых до этого исправления или в обход
 * backend'а (прямая правка БД при отладке и т.п.) — по требованию
 * аудита «тот же фильтр перед рендером на лендинге».
 */
const ALLOWED_TAGS = ['p', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'br'];

export function sanitizeBlogHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['https'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
  });
}
