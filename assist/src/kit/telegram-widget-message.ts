/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/telegram-widget-message.ts */
import type { TelegramLoginPayload } from './web-auth';

/** Only the installed Telegram iframe can deliver a login payload. */
export function readTelegramWidgetMessage(
  event: { origin: string; source: unknown; data: unknown },
  frameWindow: unknown
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
    if (!message || message.event !== 'auth_user') return null;
    const user = message.auth_data;
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
