/**
 * Срок жизни блокировки повторного подтверждения (QA-ТЗ §5.1).
 *
 * Блокировку ставит кабинет, доказавший контроль над хостом, когда
 * отзывает чужих («Отозвать все чужие»), и снимает он же. Но снять её
 * может только тот, у кого хост ПОДТВЕРЖДЁН сейчас (`assertOwnVerified`), —
 * значит, если подтверждение блокирующего истекло (90 дней без повтора),
 * отозвано кроном или он удалил хост, снять блокировку не может уже
 * никто, а заблокированный кабинет не может ни подтвердить хост, ни даже
 * удалить его строку (HOST_BLOCKED). Тупик навсегда — в том числе для
 * настоящего владельца, которого успел заблокировать тот, кто ненадолго
 * получил доступ к его хостингу (аудит Э0).
 *
 * Правило: блокировка действует, пока блокирующий кабинет сам держит
 * действующее подтверждение этого хоста (L1 без льготы). Перестал —
 * блокировка снимается при следующем обращении к строке. Это не
 * ослабляет отзыв: чужой токен из DNS/файла владелец к этому времени
 * удалил (экран отзыва его показывает), а без токена заблокированный
 * кабинет всё равно не подтвердится; если же владелец вернётся, он
 * подтвердит хост и снова отзовёт чужих.
 */

import type { SiteHost } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { evaluateHostAccess } from './host-access';

const REASON =
  'блокировка повторного подтверждения: держит ли её ещё подтвердивший кабинет (QA §5.1)';

/**
 * Строка хоста с действующей блокировкой — как есть; с «осиротевшей» —
 * блокировка снимается в базе и возвращается строка без неё.
 */
export async function releaseLapsedBlock(
  db: SitesDb,
  host: SiteHost,
  now: Date,
): Promise<SiteHost> {
  if (!host.reverifyBlockedAt) return host;
  const system = db.system(REASON);
  const candidates = await system.siteHost.findMany({
    where: {
      scheme: host.scheme,
      host: host.host,
      port: host.port,
      status: 'verified',
      accountId: { not: host.accountId },
    },
  });
  const blocker = host.reverifyBlockedByAccountId;
  const held = candidates.some(
    (c) =>
      // Старые строки без автора блокировки — держит любой подтвердивший.
      (blocker === null || c.accountId === blocker) &&
      evaluateHostAccess(c, 'assist-admin', now).ok,
  );
  if (held) return host;
  // Условие на ту же отметку блокировки: если её только что поставили
  // заново (новый отзыв), эта запись её не снимет.
  const { count } = await system.siteHost.updateMany({
    where: {
      id: host.id,
      accountId: host.accountId,
      reverifyBlockedAt: host.reverifyBlockedAt,
    },
    data: { reverifyBlockedAt: null, reverifyBlockedByAccountId: null },
  });
  return count === 1
    ? { ...host, reverifyBlockedAt: null, reverifyBlockedByAccountId: null }
    : host;
}
