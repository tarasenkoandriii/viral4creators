/**
 * Клиент Bot API бота Помощника — H (§3.7): sendMessage (inline-кнопки
 * callback_data ≤ 64 байт и web_app), editMessageText, answerCallbackQuery.
 * Токен — ASSIST_BOT_TOKEN; без него — `{ ok: false, code: 'bot_not_configured' }`
 * без сети и без текста в логе. 403 «bot was blocked» → assist_bot_users.blockedAt.
 * fetch — параметром (тесты: подменённый fetch, как leads.spec Э2).
 * Уведомления Э1–Э2 (notify.ts) не трогаем — у них своя простая отправка.
 */
import type { FetchLike } from '../../assist-knowledge-core/notify';

export type BotButton =
  { text: string; callback: string } | { text: string; webAppHashPath: string };

export interface BotSendResult {
  ok: boolean;
  messageId: number | null;
  /** sent | blocked | bot_not_configured | http_<код> | network */
  code: string;
}

export interface TelegramBotClient {
  send(p: {
    chatId: bigint;
    text: string;
    buttons?: BotButton[][];
    replyToMessageId?: number;
  }): Promise<BotSendResult>;
  edit(p: {
    chatId: bigint;
    messageId: number;
    text: string;
    buttons?: BotButton[][];
  }): Promise<BotSendResult>;
  answerCallback(p: { callbackQueryId: string; text?: string }): Promise<void>;
}

/** Фабрика клиента (env и fetch — параметрами). Реализация — H. */
export type TelegramBotClientFactory = (p?: {
  env?: { ASSIST_BOT_TOKEN?: string; ASSIST_TMA_URL?: string };
  fetchImpl?: FetchLike;
}) => TelegramBotClient;

/** Лимит Telegram на callback_data (байты UTF-8). */
export const CALLBACK_DATA_MAX_BYTES = 64;
/** Лимит Telegram на текст сообщения. */
export const BOT_TEXT_MAX = 4096;

const API = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;

interface BotApiJson {
  ok?: boolean;
  result?: { message_id?: unknown } | boolean;
  description?: string;
}

/** Ссылка TMA на хеш-маршрут — как notify.ts (`<база>/#/sites/…`). */
export function tmaHashUrl(base: string, hashPath: string): string {
  const clean = base.replace(/#.*$/, '').replace(/\/+$/, '');
  return `${clean}/#${hashPath.startsWith('/') ? '' : '/'}${hashPath}`;
}

function keyboard(
  rows: BotButton[][] | undefined,
  tmaBase: string | null,
): { inline_keyboard: unknown[][] } | undefined {
  if (!rows?.length) return undefined;
  const out: unknown[][] = [];
  for (const row of rows) {
    const r: unknown[] = [];
    for (const b of row) {
      if ('callback' in b) {
        // Длинный callback Telegram отвергнет всё сообщение — кнопку не шлём.
        if (Buffer.byteLength(b.callback, 'utf8') > CALLBACK_DATA_MAX_BYTES) {
          continue;
        }
        r.push({ text: b.text, callback_data: b.callback });
      } else if (tmaBase) {
        r.push({
          text: b.text,
          web_app: { url: tmaHashUrl(tmaBase, b.webAppHashPath) },
        });
      }
    }
    if (r.length) out.push(r);
  }
  return out.length ? { inline_keyboard: out } : undefined;
}

/**
 * Клиент Bot API (H). Ответ Telegram читается через `json()`, если он есть
 * у ответа fetch (подменённый fetch тестов его отдаёт) — иначе messageId
 * неизвестен (null), а отправка всё равно считается успешной.
 */
export const createTelegramBotClient: TelegramBotClientFactory = (p = {}) => {
  const env = p.env ?? process.env;
  const token = env.ASSIST_BOT_TOKEN?.trim() || null;
  const tmaBase = env.ASSIST_TMA_URL?.trim() || null;
  const doFetch = p.fetchImpl ?? (fetch as unknown as FetchLike);

  async function call(
    method: string,
    body: Record<string, unknown>,
  ): Promise<BotSendResult> {
    if (!token)
      return { ok: false, messageId: null, code: 'bot_not_configured' };
    let res: Awaited<ReturnType<FetchLike>>;
    let timer: NodeJS.Timeout | undefined;
    try {
      res = await Promise.race([
        doFetch(`${API}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS);
        }),
      ]);
    } catch {
      return { ok: false, messageId: null, code: 'network' };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 403)
      return { ok: false, messageId: null, code: 'blocked' };
    if (!res.ok)
      return { ok: false, messageId: null, code: `http_${res.status}` };
    let messageId: number | null = null;
    const json = (res as { json?: () => Promise<unknown> }).json;
    if (typeof json === 'function') {
      try {
        const j = (await json.call(res)) as BotApiJson;
        const id =
          j && typeof j.result === 'object' && j.result
            ? j.result.message_id
            : null;
        messageId = typeof id === 'number' ? id : null;
      } catch {
        messageId = null;
      }
    }
    return { ok: true, messageId, code: 'sent' };
  }

  return {
    send(q) {
      return call('sendMessage', {
        chat_id: q.chatId.toString(),
        text: q.text.slice(0, BOT_TEXT_MAX),
        link_preview_options: { is_disabled: true },
        ...(q.replyToMessageId
          ? {
              reply_parameters: {
                message_id: q.replyToMessageId,
                allow_sending_without_reply: true,
              },
            }
          : {}),
        ...(keyboard(q.buttons, tmaBase)
          ? { reply_markup: keyboard(q.buttons, tmaBase) }
          : {}),
      });
    },
    edit(q) {
      return call('editMessageText', {
        chat_id: q.chatId.toString(),
        message_id: q.messageId,
        text: q.text.slice(0, BOT_TEXT_MAX),
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard(q.buttons, tmaBase) ?? { inline_keyboard: [] },
      });
    },
    async answerCallback(q) {
      await call('answerCallbackQuery', {
        callback_query_id: q.callbackQueryId,
        ...(q.text ? { text: q.text.slice(0, 200) } : {}),
      });
    },
  };
};
