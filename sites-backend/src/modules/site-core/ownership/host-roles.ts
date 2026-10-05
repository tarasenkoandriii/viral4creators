/**
 * Роль хоста сайта (ТЗ помощника §3.3): хосты «Админки» перечислены в
 * настройках «Админки» (`adminHostIds`), остальные подтверждённые — хосты
 * «Сайта» (`public`). Ядро отвечает только «какие id — admin»: режимы не
 * читают настроек друг друга (правило графа `site-names↛admin`), а редактору
 * голосовой карты «Сайта» (Э6-тер, §5-кватер.2) нужно отказать на admin-хосте.
 *
 * Публичный код (роль assist_public) настроек «Админки» не читает вовсе: ему
 * роль хоста видна колонкой `site_hosts.assistRole` — зеркалом
 * `adminHostIds`, которое держат триггеры БД (миграция
 * `…_assist_visual_editor`, аудит Э6-бис (б) (8), инвариант «Админка → Сайт»
 * ТЗ §10). Все выборки хостов «Сайта» под ролью виджета и списки хостов
 * вида «Сайта» в кабинете фильтруются `PUBLIC_SITE_HOST`.
 */
import type { SitesDb } from '../../../prisma/sites-db.service';

type Db = ReturnType<SitesDb['forAccount']>;

export type SiteHostRole = 'public' | 'admin';

/** Условие Prisma «хост "Сайта"» (не хост «Админки»). */
export const PUBLIC_SITE_HOST = { assistRole: 'public' } as const;

/** id хостов сайта с ролью `admin` (пусто — режим «Админка» не настроен). */
export async function adminHostIdsOf(
  db: Db,
  siteId: string,
): Promise<Set<string>> {
  const s = await db.assistAdminSettings.findFirst({
    where: { siteId },
    select: { adminHostIds: true },
  });
  return new Set(s?.adminHostIds ?? []);
}
