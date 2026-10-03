/**
 * Уведомления «Админки: действия» (Э8, ТЗ §5.7; задача Э8 «уведомления
 * владельцу о danger-действиях»): ТОЛЬКО владельцу кабинета и участникам с
 * `assistAdmin: owner` (К-9: менеджер «Сайта» о действиях в админке не
 * узнаёт). В тексте — операция, кто и исход; параметров, ПД и секретов нет
 * никогда (текст может попасть в лог при отсутствии токена бота).
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  recipients,
  sendToMembers,
  type FetchLike,
} from '../assist-knowledge-core/notify';

const STATUS_TEXT: Record<string, string> = {
  done: 'выполнено',
  failed: 'отклонено системой',
  unknown: 'исход неизвестен — проверьте',
};

@Injectable()
export class AdminActionsNotifier {
  /** Подмена отправки — только тестами (никогда из env). */
  fetchImpl: FetchLike | undefined;
  /** Тесты: что ушло бы владельцам. */
  readonly sent: Array<{ accountId: string; text: string }> = [];

  constructor(private readonly sitesDb: SitesDb) {}

  private owners(accountId: string) {
    return recipients(
      this.sitesDb,
      accountId,
      (m) => m.role === 'owner' || m.productRoles.assistAdmin === 'owner',
    );
  }

  private async send(accountId: string, siteId: string, text: string) {
    this.sent.push({ accountId, text });
    if (this.sent.length > 100) this.sent.shift();
    await sendToMembers({
      chatIds: await this.owners(accountId),
      text,
      button: {
        text: 'Журнал действий',
        hashPath: `/sites/${siteId}/admin-mode/log`,
      },
      fetchImpl: this.fetchImpl,
    }).catch(() => 0);
  }

  async dangerExecuted(p: {
    accountId: string;
    siteId: string;
    operation: string;
    title: string;
    actor: string;
    status: string;
    items: number;
  }): Promise<void> {
    await this.send(
      p.accountId,
      p.siteId,
      `Опасное действие в админке: «${p.title.slice(0, 80)}» (${p.operation.slice(0, 80)}` +
        `${p.items > 1 ? `, строк: ${p.items}` : ''}) — ${STATUS_TEXT[p.status] ?? p.status}. ` +
        `Подтвердил: ${p.actor.slice(0, 80)}.`,
    );
  }

  async authFailed(p: {
    accountId: string;
    siteId: string;
    connector: string;
  }): Promise<void> {
    await this.send(
      p.accountId,
      p.siteId,
      `API «${p.connector.slice(0, 80)}» отклонило ключ помощника (401/403): коннектор на паузе до нового ключа.`,
    );
  }
}
