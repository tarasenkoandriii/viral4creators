import { BRAND } from '../brand';
import type { PilotApplication } from '../lib/pilot-validation';

/**
 * Отправка заявки пилота в служебный Telegram-канал через Bot API
 * (ТЗ лендинга §14 Л1: «механизм лидов Помощника» появится только в
 * продукте, до него — route handler → сообщение в канал).
 *
 * Секреты — ТОЛЬКО здесь и только из env сервера:
 *  - `PILOT_TELEGRAM_BOT_TOKEN` — токен бота, который добавлен в канал
 *    администратором с правом публикации;
 *  - `PILOT_TELEGRAM_CHAT_ID` — id канала (`-100…`) или `@username`.
 * Без префикса `NEXT_PUBLIC_` — в клиентский бандл Next их не включит;
 * что модуль не импортируется клиентским кодом и что значение не
 * попало в `.next/static`, проверяют `scripts/pilot.test.ts` и
 * `scripts/built/check-built.ts`.
 *
 * Не заданы — `unconfigured`: форма честно отвечает «временно
 * недоступно, заявка НЕ отправлена», данные остаются у человека в
 * форме. Молча «принять» и потерять — нельзя.
 */
export interface NotifyConfig {
  token: string;
  chatId: string;
}

export function notifyConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig | null {
  const token = env.PILOT_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.PILOT_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

export const CONSENT_VERSION = 'privacy-draft-2026-10-01';

/** Префикс строк сообщения заявителя в канале — см. `formatPilotMessage`. */
export const QUOTE_PREFIX = '│ ';

/**
 * Текст сообщения — простой текст без `parse_mode`: разметка из полей
 * заявки не исполняется. Поле «Повідомлення» многострочное, поэтому
 * каждая его строка идёт с префиксом `│ ` — иначе заявитель мог бы
 * дописать в текст строки «Контакт (…): …» или «Згода на обробку: …»,
 * неотличимые в канале от настоящих.
 */
export function formatPilotMessage(app: PilotApplication, receivedAt: Date): string {
  const lines = [
    `Заявка на пілот — ${BRAND.name}`,
    `Ім'я: ${app.name}`,
    `Контакт (${app.contactKind}): ${app.contact}`,
    `Сайт: ${app.site}`,
    `Тип: ${app.segment}`,
    `Мова сторінки: ${app.locale}`,
  ];
  if (app.message) lines.push('', 'Повідомлення:', ...app.message.split(/\n|[\u0085\u2028\u2029]/).map((l) => QUOTE_PREFIX + l));
  lines.push('', `Згода на обробку: так (${CONSENT_VERSION}), ${receivedAt.toISOString()}`);
  return lines.join('\n');
}

export type NotifyResult = 'sent' | 'unconfigured' | 'failed';

export async function sendPilotApplication(
  app: PilotApplication,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<NotifyResult> {
  const config = notifyConfig(opts.env);
  if (!config) return 'unconfigured';
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: formatPilotMessage(app, opts.now ?? new Date()),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) {
      // Ни токена, ни данных заявки в лог — только статус.
      console.error(`pilot: Telegram sendMessage ответил ${res.status}`);
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error(`pilot: Telegram sendMessage не выполнен: ${(err as Error).name}`);
    return 'failed';
  }
}
