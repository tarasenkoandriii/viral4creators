/**
 * Таблицы знаний режима «Сайт» — единственное место, где модуль называет
 * их для нейтрального ядра (assist-knowledge-core/tables.ts). Имён
 * «Админки» здесь быть не может (правило графа site-names↛admin).
 */
import type { KnowledgeTables } from '../assist-knowledge-core/tables';

export const SITE_TABLES: KnowledgeTables = {
  mode: 'site',
  settings: 'assist_sites',
  sources: 'assist_site_sources',
  documents: 'assist_site_documents',
  chunks: 'assist_site_chunks',
  versions: 'assist_site_knowledge_versions',
  faq: 'assist_site_faq',
  exclusions: 'assist_site_exclusions',
};
