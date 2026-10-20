/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/telegram-widget-message.ts */
import type { TelegramLoginPayload } from './web-auth';

/** Only the exact Telegram iframe/popup may deliver a signed login payload. */
function readTelegramMessage(
  event: { origin: string; source: unknown; data: unknown },
  frameWindow: unknown,
  kind: 'auth_user' | 'auth_result'
): TelegramLoginPayload | null {
  if (
    !frameWindow ||
    event.source !== frameWindow ||
    event.origin !== 'https://oauth.telegram.org'
  )
    return null;
  if (typeof event.data !== 'string') return null;
  try {
    const message = JSON.parse(event.data);
    if (!message || message.event !== kind) return null;
    const user = kind === 'auth_user' ? message.auth_data : message.result;
    if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
    if (
      !Number.isSafeInteger(user.id) ||
      user.id <= 0 ||
      !Number.isSafeInteger(user.auth_date) ||
      user.auth_date <= 0 ||
      typeof user.hash !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(user.hash)
    )
      return null;
    // Cryptographic signature and freshness are validated by the backend.
    return user as TelegramLoginPayload;
  } catch {
    return null;
  }
}

/** Match both origin and exact window, never accept a neighbouring tab. */
export function readTelegramWidgetMessage(
  event: { origin: string; source: unknown; data: unknown },
  frameWindow: unknown
): TelegramLoginPayload | null {
  return readTelegramMessage(event, frameWindow, 'auth_user');
}
export function readTelegramPopupMessage(
  event: { origin: string; source: unknown; data: unknown },
  popupWindow: unknown
): TelegramLoginPayload | null {
  return readTelegramMessage(event, popupWindow, 'auth_result');
}

/** Public bot ID; return URL deliberately excludes invitation/query/fragment. */
export function telegramPopupUrl(botId: string, origin: string): string {
  if (!/^[1-9][0-9]{4,15}$/.test(botId))
    throw new Error('Invalid Telegram bot ID');
  const site = new URL(origin);
  if (site.protocol !== 'https:' || site.origin !== origin)
    throw new Error('HTTPS origin required');
  const url = new URL('https://oauth.telegram.org/auth');
  url.searchParams.set('bot_id', botId);
  url.searchParams.set('origin', site.origin);
  url.searchParams.set('return_to', site.origin + '/');
  return url.href;
}
