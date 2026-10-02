/**
 * Уведомления владельцу кабинета о тарифе — в бот Помощника (§3.10: «на
 * 80% и 100% — уведомление в бот»), кнопка открывает экран тарифа TMA.
 * Получатели — только владелец кабинета (оплата — его право, §3.2).
 * Нет ASSIST_BOT_TOKEN/ASSIST_TMA_URL — строка в лог (sendToMembers).
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  recipients,
  sendToMembers,
  type FetchLike,
} from '../assist-knowledge-core/notify';
import { ASSIST_PLANS, isAssistPlanId } from './plans';

export type UsageNotice =
  'warn80' | 'warn100' | 'expired' | 'autotopup_failed' | 'renew_failed';

const PLAN_NAMES: Record<string, string> = {
  trial: 'Trial',
  start: 'Start',
  business: 'Business',
  pro: 'Pro',
};

export function noticeText(
  kind: UsageNotice,
  p: { used?: number; limit?: number },
): string {
  switch (kind) {
    case 'warn80':
      return `Помощник: израсходовано ${p.used} из ${p.limit} диалогов этого периода (80%). Можно докупить пакет или перейти на тариф выше.`;
    case 'warn100':
      return `Помощник: лимит диалогов периода исчерпан (${p.used} из ${p.limit}). Виджет на сайте принимает заявки, но не отвечает сам. Докупите пакет или смените тариф.`;
    case 'expired':
      return 'Помощник: оплаченный период закончился. Виджет на сайте принимает заявки, но не отвечает сам, пока тариф не продлён.';
    case 'autotopup_failed':
      return 'Помощник: не удалось списать пакет автодокупки — автодокупка выключена. Проверьте карту или докупите вручную.';
    case 'renew_failed':
      return 'Помощник: не удалось продлить тариф картой. Попробуем ещё раз; можно оплатить вручную на экране тарифа.';
  }
}

@Injectable()
export class BillingNotices {
  env: NodeJS.ProcessEnv = process.env;
  fetchImpl?: FetchLike;

  constructor(private readonly sitesDb: SitesDb) {}

  private async owners(accountId: string): Promise<bigint[]> {
    return recipients(this.sitesDb, accountId, (m) => m.role === 'owner');
  }

  async send(accountId: string, text: string): Promise<number> {
    return sendToMembers({
      chatIds: await this.owners(accountId),
      text,
      button: { text: 'Тариф и оплата', hashPath: '/billing' },
      env: this.env,
      fetchImpl: this.fetchImpl,
    });
  }

  async usage(
    accountId: string,
    kind: UsageNotice,
    p: { used?: number; limit?: number } = {},
  ): Promise<number> {
    return this.send(accountId, noticeText(kind, p));
  }

  async paymentApplied(
    accountId: string,
    kind: string,
    planId: string | null,
  ): Promise<number> {
    const plan = isAssistPlanId(planId) ? ASSIST_PLANS[planId] : null;
    const text =
      kind === 'topup' || kind === 'auto_topup'
        ? 'Помощник: оплата прошла — пакет диалогов добавлен к текущему периоду.'
        : `Помощник: оплата прошла — тариф ${PLAN_NAMES[planId ?? ''] ?? planId}${plan ? ` (${plan.dialogsPerMonth} диалогов в период)` : ''} действует.`;
    return this.send(accountId, text);
  }
}
