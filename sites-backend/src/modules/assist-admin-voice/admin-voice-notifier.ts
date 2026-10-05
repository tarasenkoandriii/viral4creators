/**
 * Уведомления голосового управления «Админкой» (Э6-бис (б), §5-бис.14
 * «Админка»): нарушение запрета (режим выключен сразу), авто-деградация,
 * «работает плохо». ТОЛЬКО владельцу кабинета и `assistAdmin: owner` (К-9).
 * Без ПД, значений полей и текста команд — коды и числа.
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  recipients,
  sendToMembers,
  type FetchLike,
} from '../assist-knowledge-core/notify';

@Injectable()
export class AdminVoiceNotifier {
  /** Подмена отправки — только тестами. */
  fetchImpl: FetchLike | undefined;
  /** Тесты: что ушло бы владельцам. */
  readonly sent: Array<{ accountId: string; text: string }> = [];

  constructor(private readonly sitesDb: SitesDb) {}

  async send(accountId: string, siteId: string, text: string): Promise<void> {
    this.sent.push({ accountId, text });
    if (this.sent.length > 100) this.sent.shift();
    const chatIds = await recipients(
      this.sitesDb,
      accountId,
      (m) => m.role === 'owner' || m.productRoles.assistAdmin === 'owner',
    ).catch(() => [] as bigint[]);
    await sendToMembers({
      chatIds,
      text,
      button: {
        text: 'Голосове керування адмінкою',
        hashPath: `/sites/${siteId}/admin-mode/voice`,
      },
      fetchImpl: this.fetchImpl,
    }).catch(() => 0);
  }

  violation(accountId: string, siteId: string, reason: string) {
    return this.send(
      accountId,
      siteId,
      `Голосове керування адмінкою ВИМКНЕНО: крок на забороненій цілі (${reason.slice(0, 40)}). Це дефект або підміна — перевірте журнал дій.`,
    );
  }

  degraded(accountId: string, siteId: string, misses: number) {
    return this.send(
      accountId,
      siteId,
      `Голосове керування адмінкою переведено в режим підказки: ${misses} збережень за добу дали не той результат. Перезапустіть майстер перевірки.`,
    );
  }

  poor(accountId: string, siteId: string, plans: number, done: number) {
    return this.send(
      accountId,
      siteId,
      `Голосове керування адмінкою працює погано: за добу ${plans} команд, виконано ${done}. Перегляньте розмітку сторінок або запустіть майстер.`,
    );
  }
}
