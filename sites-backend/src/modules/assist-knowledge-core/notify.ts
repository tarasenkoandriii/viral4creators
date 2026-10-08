/**
 * Минимальная отправка владельцу в бот помощника — K2 (контракт Э1 п.12):
 * удержанная версия, всплеск карантина. Общий `notify` для sites-backend —
 * Э3 (контракт Э0 п.3: нечистый модуль генератора не копируется), здесь —
 * только sendMessage с web_app-кнопкой. Нейтральный: КОМУ слать, решает
 * режим (фильтр участников) — «Админка» не шлёт менеджерам «Сайта».
 *
 * Без ASSIST_BOT_TOKEN или ASSIST_TMA_URL — только строка в лог: отсутствие
 * уведомления не должно ронять индексацию. Токен в лог не попадает.
 */
import { Logger } from '@nestjs/common';
import type { SitesDb } from '../../prisma/sites-db.service';
import {
  parseAccountRole,
  parseProductRoles,
  type AccountRole,
  type ProductRoles,
} from '../site-core/account/roles';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface BotNotifyEnv {
  ASSIST_BOT_TOKEN?: string;
  ASSIST_TMA_URL?: string;
}

const logger = new Logger('AssistKnowledgeNotify');

/** Ссылка TMA на хеш-маршрут (`#/sites/<id>/…`). */
export function tmaLink(base: string, hashPath: string): string {
  const clean = base.replace(/#.*$/, '').replace(/\/+$/, '');
  return `${clean}/#${hashPath.startsWith('/') ? '' : '/'}${hashPath}`;
}

/** Получатели кабинета по фильтру режима. */
export async function recipients(
  sitesDb: SitesDb,
  accountId: string,
  allow: (m: { role: AccountRole; productRoles: ProductRoles }) => boolean,
): Promise<bigint[]> {
  const members = await sitesDb
    .forAccount(accountId)
    .siteAccountMember.findMany({
      select: { telegramId: true, role: true, productRoles: true },
    });
  const out: bigint[] = [];
  for (const m of members) {
    const role = parseAccountRole(m.role);
    if (!role) continue;
    if (allow({ role, productRoles: parseProductRoles(m.productRoles) })) {
      out.push(m.telegramId);
    }
  }
  return out;
}

/** Язык уведомления владельцу/сотруднику (Р-З9-7). */
export type NotifyLang = 'uk' | 'ru' | 'en';

/**
 * Язык из `language_code` Telegram (`assist_bot_users.languageCode`):
 * uk/ru/en по первой части кода (`ru-RU` → ru), всё прочее и пусто — uk
 * (основной рынок; так же решает карточка передачи по умолчанию).
 */
export function notifyLangOf(code: string | null | undefined): NotifyLang {
  const base = (code ?? '').toLowerCase().split(/[-_]/)[0];
  return base === 'ru' || base === 'en' ? base : 'uk';
}

/**
 * Получатели с языком (Р-З9-7): тот же фильтр режима, что `recipients`, и
 * язык каждого — из `assist_bot_users` (таблица личностей Telegram без
 * кабинета, поэтому чтение системное, только `languageCode` по уже
 * отобранным id). Нет строки — uk.
 */
export async function recipientsWithLang(
  sitesDb: SitesDb,
  accountId: string,
  allow: (m: { role: AccountRole; productRoles: ProductRoles }) => boolean,
): Promise<Array<{ chatId: bigint; lang: NotifyLang }>> {
  const ids = await recipients(sitesDb, accountId, allow);
  if (!ids.length) return [];
  const rows = await sitesDb
    .system('notify: язык получателей (assist_bot_users)')
    .assistBotUser.findMany({
      where: { telegramId: { in: ids } },
      select: { telegramId: true, languageCode: true },
    });
  const lang = new Map(
    rows.map((r) => [r.telegramId.toString(), notifyLangOf(r.languageCode)]),
  );
  return ids.map((chatId) => ({
    chatId,
    lang: lang.get(chatId.toString()) ?? 'uk',
  }));
}

/**
 * Разослать каждому на его языке (Р-З9-7): группы по языку — по одному
 * `sendToMembers` на группу. `texts` — текст и кнопка на каждый язык.
 */
export async function sendToMembersByLang(p: {
  recipients: Array<{ chatId: bigint; lang: NotifyLang }>;
  texts: Record<NotifyLang, { text: string; button: string }>;
  hashPath: string;
  env?: BotNotifyEnv;
  fetchImpl?: FetchLike;
}): Promise<number> {
  let sent = 0;
  for (const lang of ['uk', 'ru', 'en'] as const) {
    const chatIds = p.recipients
      .filter((r) => r.lang === lang)
      .map((r) => r.chatId);
    if (!chatIds.length) continue;
    sent += await sendToMembers({
      chatIds,
      text: p.texts[lang].text,
      button: { text: p.texts[lang].button, hashPath: p.hashPath },
      env: p.env,
      fetchImpl: p.fetchImpl,
    });
  }
  return sent;
}

/** Отправить каждому; возвращает число успешных отправок. */
export async function sendToMembers(p: {
  chatIds: bigint[];
  text: string;
  button: { text: string; hashPath: string };
  env?: BotNotifyEnv;
  fetchImpl?: FetchLike;
}): Promise<number> {
  const env = p.env ?? process.env;
  const token = env.ASSIST_BOT_TOKEN?.trim();
  const base = env.ASSIST_TMA_URL?.trim();
  if (!token || !base) {
    logger.warn(
      `Уведомление не отправлено (нет ASSIST_BOT_TOKEN/ASSIST_TMA_URL): ${p.text.slice(0, 120)}`,
    );
    return 0;
  }
  const doFetch = p.fetchImpl ?? (fetch as unknown as FetchLike);
  const url = tmaLink(base, p.button.hashPath);
  let sent = 0;
  for (const chatId of p.chatIds) {
    try {
      const res = await doFetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId.toString(),
            text: p.text,
            reply_markup: {
              inline_keyboard: [[{ text: p.button.text, web_app: { url } }]],
            },
          }),
        },
      );
      if (res.ok) sent++;
      // 403 — человек не запускал бота: это не ошибка индексации.
      else logger.warn(`sendMessage: HTTP ${res.status}`);
    } catch (e) {
      logger.warn(`sendMessage не удался: ${(e as Error).name}`);
    }
  }
  return sent;
}
