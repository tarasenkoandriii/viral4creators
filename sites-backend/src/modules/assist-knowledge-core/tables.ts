/**
 * Имена таблиц режима — их ПЕРЕДАЁТ модуль режима (assist-site-knowledge →
 * site-tables.ts, assist-admin-knowledge → admin-tables.ts). Сам
 * нейтральный модуль имён таблиц режимов не пишет (правило графа
 * neutral-names): общий код физически не может выбрать «не ту» таблицу —
 * её выбирает тот, у кого в коде есть только свои имена (слой 2, §4.3-бис).
 *
 * Формы таблиц обоих режимов одинаковы (schema.prisma), включая колонки
 * настроек: siteId, accountId, knowledgeVersion, configVersion, versionSeq,
 * lastIndexedCrawlRunId.
 */

export type KnowledgeMode = 'site' | 'admin';

export interface KnowledgeTables {
  readonly mode: KnowledgeMode;
  /** assist_sites | assist_admin_settings — опубликованная версия, счётчик версий. */
  readonly settings: string;
  readonly sources: string;
  readonly documents: string;
  readonly chunks: string;
  readonly versions: string;
  readonly faq: string;
  readonly exclusions: string;
}

/** Postgres-схема (адаптер квалифицирует только запросы Prisma, не сырой SQL). */
export const SITES_SCHEMA = 'sites';

/** `"sites"."<таблица>"` — только для имён из KnowledgeTables (не из ввода!). */
export function qualified(table: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`Недопустимое имя таблицы: ${table}`);
  }
  return `"${SITES_SCHEMA}"."${table}"`;
}
