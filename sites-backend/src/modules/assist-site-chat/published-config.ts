/**
 * Чтение ОПУБЛИКОВАННОЙ строки `assist_site_config_versions` под ролью
 * `assist_public` — одно место для виджета (вид, W2) и конвейера (персона,
 * W3). Интеграция Э2: раньше каждый писал свой сырой SQL.
 *
 * Почему сырой SQL, а не модель Prisma: у роли колоночный GRANT
 * SELECT(`siteId, kind, version, config`) без `id` (контракт Э2 §2), а
 * Prisma дочитывает первичный ключ в любой запрос к модели → 42501 в проде.
 * Это фиксирует `published-config.spec.ts` (под логин-ролью: модель —
 * отказ, эта функция — данные). Кабинет (W4) и системные части читают
 * моделью под основной ролью — им можно.
 */
import { Prisma } from '@prisma/client';

export type ConfigVersionKind = 'widget' | 'persona';

/** Любой клиент Prisma с `$queryRaw` (AssistPublicDb, транзакция). */
export interface RawQueryDb {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ): Prisma.PrismaPromise<T>;
}

/** `config` опубликованной версии (объект) или null (не опубликовано/нет строки). */
export async function readPublishedConfig(
  db: RawQueryDb,
  siteId: string,
  kind: ConfigVersionKind,
  version: number,
): Promise<Record<string, unknown> | null> {
  if (!(version > 0)) return null;
  const rows = await db.$queryRaw<Array<{ config: unknown }>>(Prisma.sql`
    SELECT "config" FROM "sites"."assist_site_config_versions"
    WHERE "siteId" = ${siteId} AND "kind" = ${kind} AND "version" = ${version}
    LIMIT 1`);
  const c = rows[0]?.config;
  return c && typeof c === 'object' && !Array.isArray(c)
    ? (c as Record<string, unknown>)
    : null;
}
