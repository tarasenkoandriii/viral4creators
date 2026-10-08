/**
 * Уведомления «Админки: действия» (Э8, ТЗ §5.7; задача Э8 «уведомления
 * владельцу о danger-действиях»): ТОЛЬКО владельцу кабинета и участникам с
 * `assistAdmin: owner` (К-9: менеджер «Сайта» о действиях в админке не
 * узнаёт). В тексте — операция, кто и исход; параметров, ПД и секретов нет
 * никогда (текст может попасть в лог при отсутствии токена бота).
 * Заход 9 (Р-З9-7): язык — каждого получателя (`assist_bot_users.
 * languageCode`, uk/ru/en, иначе uk), было — только ru.
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  recipientsWithLang,
  sendToMembersByLang,
  type FetchLike,
  type NotifyLang,
} from '../assist-knowledge-core/notify';

type Texts = Record<NotifyLang, { text: string; button: string }>;

const STATUS_TEXT: Record<NotifyLang, Record<string, string>> = {
  uk: {
    done: 'виконано',
    failed: 'відхилено системою',
    unknown: 'результат невідомий — перевірте',
  },
  ru: {
    done: 'выполнено',
    failed: 'отклонено системой',
    unknown: 'исход неизвестен — проверьте',
  },
  en: {
    done: 'done',
    failed: 'rejected by the system',
    unknown: 'outcome unknown — please check',
  },
};

const LOG_BUTTON: Record<NotifyLang, string> = {
  uk: 'Журнал дій',
  ru: 'Журнал действий',
  en: 'Action log',
};

const MEMO_BUTTON: Record<NotifyLang, string> = {
  uk: 'Мемо «Адмінки»',
  ru: 'Мемо «Админки»',
  en: 'Admin memos',
};

/**
 * Тексты уведомлений (Р-З9-7: язык получателя uk/ru/en) — чистые функции:
 * в них только операция, номер, коды и исход; параметров и ПД нет.
 */
export const ADMIN_NOTIFY_TEXT = {
  danger(
    lang: NotifyLang,
    p: {
      title: string;
      operation: string;
      items: number;
      status: string;
      actor: string;
    },
  ): string {
    const what = `«${p.title.slice(0, 80)}» (${p.operation.slice(0, 80)}`;
    const st = STATUS_TEXT[lang][p.status] ?? p.status;
    const actor = p.actor.slice(0, 80);
    switch (lang) {
      case 'ru':
        return (
          `Опасное действие в админке: ${what}${p.items > 1 ? `, строк: ${p.items}` : ''}) — ${st}. ` +
          `Подтвердил: ${actor}.`
        );
      case 'en':
        return (
          `Dangerous action in the admin panel: ${what}${p.items > 1 ? `, rows: ${p.items}` : ''}) — ${st}. ` +
          `Confirmed by: ${actor}.`
        );
      default:
        return (
          `Небезпечна дія в адмінці: ${what}${p.items > 1 ? `, рядків: ${p.items}` : ''}) — ${st}. ` +
          `Підтвердив: ${actor}.`
        );
    }
  },

  memoReview(
    lang: NotifyLang,
    p: { number: number; code: string; step: number | null },
  ): string {
    const step = p.step ?? '?';
    const why: Record<NotifyLang, string> =
      p.code === 'goal_low'
        ? {
            uk: 'часто не доходить до мети',
            ru: 'часто не доходит до цели',
            en: 'often does not reach its goal',
          }
        : p.code === 'pin_mismatch'
          ? {
              uk: `крок ${step} не знаходиться на сторінці адмінки`,
              ru: `шаг ${step} не находится на странице админки`,
              en: `step ${step} is not found on the admin page`,
            }
          : {
              uk: `збої на кроці ${step} у кількох співробітників`,
              ru: `сбои на шаге ${step} у нескольких сотрудников`,
              en: `failures on step ${step} for several employees`,
            };
    switch (lang) {
      case 'ru':
        return (
          `Мемо АМ-${p.number} требует проверки: ${why.ru}. Пока сотрудникам оно не выполняется. ` +
          'Откройте «Помощник сотрудников → Мемо», исправьте и прогоните мемо в админке.'
        );
      case 'en':
        return (
          `Memo AM-${p.number} needs review: ${why.en}. Until then it does not run for employees. ` +
          'Open «Staff assistant → Memos», fix it and run the memo in the admin panel.'
        );
      default:
        return (
          `Мемо АМ-${p.number} потребує перевірки: ${why.uk}. Поки що співробітникам воно не виконується. ` +
          'Відкрийте «Помічник співробітників → Мемо», виправте й проженіть мемо в адмінці.'
        );
    }
  },

  authFailed(lang: NotifyLang, connector: string): string {
    const c = connector.slice(0, 80);
    switch (lang) {
      case 'ru':
        return `API «${c}» отклонило ключ помощника (401): коннектор на паузе до нового ключа.`;
      case 'en':
        return `The «${c}» API rejected the assistant's key (401): the connector is paused until a new key is set.`;
      default:
        return `API «${c}» відхилило ключ помічника (401): конектор на паузі до нового ключа.`;
    }
  },
};

function texts(
  make: (lang: NotifyLang) => string,
  button: Record<NotifyLang, string>,
): Texts {
  return {
    uk: { text: make('uk'), button: button.uk },
    ru: { text: make('ru'), button: button.ru },
    en: { text: make('en'), button: button.en },
  };
}

@Injectable()
export class AdminActionsNotifier {
  /** Подмена отправки — только тестами (никогда из env). */
  fetchImpl: FetchLike | undefined;
  /** Тесты: что ушло бы владельцам (`text` — uk, `texts` — все языки). */
  readonly sent: Array<{
    accountId: string;
    text: string;
    texts?: Record<NotifyLang, string>;
  }> = [];

  constructor(private readonly sitesDb: SitesDb) {}

  /** Владельцы «Админки» с языком каждого (Р-З9-7, notify.ts). */
  private owners(accountId: string) {
    return recipientsWithLang(
      this.sitesDb,
      accountId,
      (m) => m.role === 'owner' || m.productRoles.assistAdmin === 'owner',
    );
  }

  private remember(accountId: string, text: string, t?: Texts) {
    this.sent.push({
      accountId,
      text,
      ...(t ? { texts: { uk: t.uk.text, ru: t.ru.text, en: t.en.text } } : {}),
    });
    if (this.sent.length > 100) this.sent.shift();
  }

  private async send(
    accountId: string,
    hashPath: string,
    t: Texts,
  ): Promise<void> {
    await sendToMembersByLang({
      recipients: await this.owners(accountId),
      texts: t,
      hashPath,
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
    const t = texts((l) => ADMIN_NOTIFY_TEXT.danger(l, p), LOG_BUTTON);
    this.remember(p.accountId, t.uk.text, t);
    await this.send(p.accountId, `/sites/${p.siteId}/admin-mode/log`, t);
  }

  /** Мемо АМ-N «требует проверки» (§5-бис.17 п.8): коды и номер, без ПД. */
  async memoReview(p: {
    accountId: string;
    siteId: string;
    number: number;
    code: string;
    step: number | null;
  }): Promise<void> {
    const t = texts((l) => ADMIN_NOTIFY_TEXT.memoReview(l, p), MEMO_BUTTON);
    this.remember(p.accountId, `memo:${p.number}:${p.code}`, t);
    await this.send(p.accountId, `/sites/${p.siteId}/admin-mode/memos`, t);
  }

  async authFailed(p: {
    accountId: string;
    siteId: string;
    connector: string;
  }): Promise<void> {
    const t = texts(
      (l) => ADMIN_NOTIFY_TEXT.authFailed(l, p.connector),
      LOG_BUTTON,
    );
    this.remember(p.accountId, t.uk.text, t);
    await this.send(p.accountId, `/sites/${p.siteId}/admin-mode/log`, t);
  }
}
