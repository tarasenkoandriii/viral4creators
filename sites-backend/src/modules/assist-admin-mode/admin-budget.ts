/**
 * Суточный денежный потолок «Админки» сайта (аудит Э7; ТЗ §7.3): сумма
 * `costMicroUsd` ответов сотрудников за UTC-сутки и расходов голосового
 * управления «Админкой» и lite-выбора мемо АМ-N (`site_ai_usage`, операции
 * ниже). Один расчёт на всех: ход чата (AdminChatService) и выбор мемо
 * моделью (AdminMemoService) не должны разойтись в том, что считать.
 */
import type { SitesDb } from '../../prisma/sites-db.service';

type Db = ReturnType<SitesDb['forAccount']>;

/** Операции `site_ai_usage`, которые платит суточный потолок «Админки». */
export const ADMIN_DAILY_USAGE_OPERATIONS = [
  'assist-admin-stt',
  'assist-admin-ui-plan',
  'assist-admin-memo',
] as const;

/** Начало UTC-суток. */
export function utcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Потрачено «Админкой» сайта с начала UTC-суток, микродоллары. */
export async function adminSpentToday(
  db: Db,
  siteId: string,
  now: Date,
): Promise<number> {
  const day = utcDay(now);
  const [chat, usage] = await Promise.all([
    db.assistAdminMessage.aggregate({
      where: { siteId, createdAt: { gte: day } },
      _sum: { costMicroUsd: true },
    }),
    db.siteAiUsage.aggregate({
      where: {
        siteId,
        operation: { in: [...ADMIN_DAILY_USAGE_OPERATIONS] },
        createdAt: { gte: day },
      },
      _sum: { costMicroUsd: true },
    }),
  ]);
  return (chat._sum.costMicroUsd ?? 0) + (usage._sum.costMicroUsd ?? 0);
}
