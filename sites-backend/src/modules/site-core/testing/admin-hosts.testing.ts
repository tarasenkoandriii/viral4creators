/**
 * Тесты «Сайта» на реальной базе: отметить хосты сайта хостами «Админки».
 * Роль хоста (`site_hosts.assistRole`) пишут триггеры БД по настройкам
 * «Админки» (`adminHostIds`) — напрямую её не поставить (триггер
 * пересчитает). Модулям «Сайта» имена таблиц «Админки» называть нельзя
 * (правило графа `site-names↛admin`), ядро владения их уже знает
 * (`ownership/host-roles.ts`) — помощник живёт здесь.
 */
import type { PrismaService } from '../../../prisma/prisma.service';

export async function markAdminHosts(
  prisma: PrismaService,
  site: { accountId: string; siteId: string },
  hostIds: string[],
): Promise<void> {
  await prisma.assistAdminSettings.upsert({
    where: { siteId: site.siteId },
    create: {
      accountId: site.accountId,
      siteId: site.siteId,
      adminHostIds: hostIds,
    },
    update: { adminHostIds: hostIds },
  });
}
