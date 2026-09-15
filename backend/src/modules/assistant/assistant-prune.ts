/**
 * Уборка журналов консультанта (ТЗ §10 — ретенция 30 дней), тот же приём,
 * что `pruneRateLimits`/`TelegramNotifyService.pruneStates`: чистая
 * функция от `PrismaService`, вызывается из `CronJobsService.runCleanupSessions`
 * рядом с остальной ежедневной уборкой.
 */
import { PrismaService } from '../../prisma/prisma.service';

export const ASSISTANT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function pruneAssistantExchanges(
  prisma: PrismaService,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - ASSISTANT_RETENTION_MS);
  const r = await prisma.assistantExchange.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return r.count;
}

export async function pruneAssistantEvents(
  prisma: PrismaService,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - ASSISTANT_RETENTION_MS);
  const r = await prisma.assistantEvent.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return r.count;
}
