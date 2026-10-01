import fs from 'node:fs';
import path from 'node:path';
import { BRAND } from '../brand';
import { fmt } from './format';

/**
 * Юридические черновики (§3.15, §13): Markdown в `sites-landing/legal/`,
 * одна редакция (украинская) вне `[locale]` — переводим только
 * проверенный юристом текст. Читаются при сборке (страницы статические),
 * `{brand}` и `{entity}` подставляются из `brand.ts`.
 *
 * Все три — ЧЕРНОВИКИ: на странице плашка, в поиске `noindex`, в
 * sitemap их нет. Снять пометку = юрист проверил + `draft: false` здесь.
 */
export const LEGAL_DOCS = [
  { slug: 'privacy', draft: true },
  { slug: 'terms', draft: true },
  { slug: 'cookies', draft: true },
] as const;

export type LegalSlug = (typeof LEGAL_DOCS)[number]['slug'];

export function isLegalSlug(s: string): s is LegalSlug {
  return LEGAL_DOCS.some((d) => d.slug === s);
}

export function legalMarkdown(slug: LegalSlug, root: string = process.cwd()): string {
  const raw = fs.readFileSync(path.join(root, 'legal', `${slug}.md`), 'utf8');
  return fmt(raw, { entity: BRAND.legalEntity });
}

/** Заголовок документа — первая строка `# …`. */
export function legalTitle(markdown: string): string {
  const m = /^# (.+)$/m.exec(markdown);
  return m ? m[1].trim() : '';
}
