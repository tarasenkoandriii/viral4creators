/**
 * Таблицы знаний режима «Админка» — единственное место, где модуль называет
 * их для нейтрального ядра. Имён «Сайта» здесь быть не может (правило
 * графа admin-names↛site). Роль assist_public к ним прав не имеет.
 */
import type { KnowledgeTables } from '../assist-knowledge-core/tables';

export const ADMIN_TABLES: KnowledgeTables = {
  mode: 'admin',
  settings: 'assist_admin_settings',
  sources: 'assist_admin_sources',
  documents: 'assist_admin_documents',
  chunks: 'assist_admin_chunks',
  versions: 'assist_admin_knowledge_versions',
  faq: 'assist_admin_faq',
  exclusions: 'assist_admin_exclusions',
};
