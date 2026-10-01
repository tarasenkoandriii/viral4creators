/**
 * Уведомление владельцу/менеджерам «Сайта» в бот помощника — K2 (§4-тер.2:
 * удержанная версия — с причиной и кнопкой; §4-тер.7: всплеск карантина —
 * «похоже на взлом»). Telegram Bot API sendMessage токеном
 * ASSIST_BOT_TOKEN; получатели — владелец кабинета и участники с
 * productRoles.assist = manager; кнопка web_app → ASSIST_TMA_URL
 * `#/sites/<siteId>/knowledge/site/versions`. Без токена/URL — только лог.
 * Своя минимальная отправка (assist-knowledge-core/notify.ts): общий
 * `notify` для sites-backend не написан (контракт Э0 п.3), Э3 заменит.
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  recipients,
  sendToMembers,
  type FetchLike,
} from '../assist-knowledge-core/notify';

@Injectable()
export class SiteKnowledgeNotifier {
  /** Подмена отправки — только тестами (никогда из env). */
  fetchImpl: FetchLike | undefined;

  constructor(private readonly sitesDb: SitesDb) {}

  private managers(accountId: string) {
    return recipients(
      this.sitesDb,
      accountId,
      (m) => m.role === 'owner' || m.productRoles.assist === 'manager',
    );
  }

  async versionHeld(p: {
    accountId: string;
    siteId: string;
    number: number;
    reason: string;
  }): Promise<void> {
    await sendToMembers({
      chatIds: await this.managers(p.accountId),
      text:
        `Обновление знаний помощника (версия ${p.number}) удержано: ${p.reason}.\n` +
        'Посетители пока получают прежние ответы. Откройте версии, чтобы опубликовать как есть или отбросить.',
      button: {
        text: 'Открыть версии',
        hashPath: `/sites/${p.siteId}/knowledge/site/versions`,
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
    const head = p.suspectedHack
      ? `Похоже на взлом сайта: ${p.count} фрагментов с командами для ИИ.`
      : `На сайте найден текст с командами для ИИ (${p.count} фрагм.).`;
    await sendToMembers({
      chatIds: await this.managers(p.accountId),
      text:
        `${head} Помощник его не использует — он в карантине. ` +
        'Проверьте: «включить как есть» или «исключить страницу».',
      button: {
        text: 'Открыть карантин',
        hashPath: `/sites/${p.siteId}/knowledge/site`,
      },
      fetchImpl: this.fetchImpl,
    });
  }
}
