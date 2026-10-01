/**
 * Уведомления «Админки» — K2: удержанная версия и карантин — ТОЛЬКО
 * владельцу кабинета и участникам с productRoles.assistAdmin = owner
 * (§3.2, К-9: менеджер «Сайта» о данных «Админки» не узнаёт ничего, даже
 * что они менялись). Кнопка — `#/sites/<id>/knowledge/admin/versions`.
 */
import { SitesDb } from '../../prisma/sites-db.service';
import {
  recipients,
  sendToMembers,
  type FetchLike,
} from '../assist-knowledge-core/notify';

export class AdminKnowledgeNotifier {
  /** Подмена отправки — только тестами (никогда из env). */
  fetchImpl: FetchLike | undefined;

  constructor(private readonly sitesDb: SitesDb) {}

  private owners(accountId: string) {
    return recipients(
      this.sitesDb,
      accountId,
      (m) => m.role === 'owner' || m.productRoles.assistAdmin === 'owner',
    );
  }

  async versionHeld(p: {
    accountId: string;
    siteId: string;
    number: number;
    reason: string;
  }): Promise<void> {
    await sendToMembers({
      chatIds: await this.owners(p.accountId),
      text:
        `Обновление знаний «Админки» (версия ${p.number}) удержано: ${p.reason}.\n` +
        'Сотрудники пока получают прежние ответы.',
      button: {
        text: 'Открыть версии',
        hashPath: `/sites/${p.siteId}/knowledge/admin/versions`,
      },
      fetchImpl: this.fetchImpl,
    });
  }

  async quarantineAlarm(p: {
    accountId: string;
    siteId: string;
    count: number;
    suspectedHack: boolean;
  }): Promise<void> {
    await sendToMembers({
      chatIds: await this.owners(p.accountId),
      text:
        `В знаниях «Админки» найден текст с командами для ИИ (${p.count} фрагм.)` +
        `${p.suspectedHack ? ' — похоже на взлом' : ''}. Он в карантине и не используется.`,
      button: {
        text: 'Открыть карантин',
        hashPath: `/sites/${p.siteId}/knowledge/admin`,
      },
      fetchImpl: this.fetchImpl,
    });
  }
}
