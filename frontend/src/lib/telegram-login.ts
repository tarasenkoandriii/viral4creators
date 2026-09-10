/**
 * Постоянный (cookie) Telegram-логин для обычного браузерного сценария
 * (вне Telegram) — кнопка «Войти через Telegram», параллельная уже
 * существующей автоматической identification внутри Telegram
 * (lib/telegram.ts, X-Telegram-Init-Data). Логика та же, что у admin/'s
 * login-страницы (Telegram Login Widget), но результат другой: здесь
 * вход не даёт никаких прав, он просто привязывает браузер к
 * Telegram-пользователю через httpOnly cookie (`user_session`,
 * см. backend/src/modules/telegram-login), чтобы созданные впредь
 * сессии не были анонимными — не обязательный шаг, обычный анонимный
 * сценарий работает и без него ровно как раньше.
 *
 * См. doc/TELEGRAM-ADMIN.md.
 */

import { api } from '../services/api';

export interface TelegramLoginWidgetPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export interface TelegramLoginMeResult {
  loggedIn: boolean;
  telegramId?: string;
  firstName?: string | null;
  username?: string | null;
}

/** Разворачивает возможный двойной wrapping ResponseInterceptor'а — тот
 * же паттерн, что используется по всему services/api.ts. */
function unwrap<T>(data: T | { data: T } | undefined, fallback: T): T {
  if (!data) return fallback;
  if (
    typeof data === 'object' &&
    data !== null &&
    'data' in (data as Record<string, unknown>)
  ) {
    return (data as { data: T }).data;
  }
  return data as T;
}

export async function fetchTelegramLoginMe(): Promise<TelegramLoginMeResult> {
  const response = await api.get<TelegramLoginMeResult>('/telegram-login/me');
  return unwrap(response.data, { loggedIn: false });
}

export async function telegramLoginCallback(
  payload: TelegramLoginWidgetPayload
): Promise<void> {
  await api.post('/telegram-login/callback', payload);
}

export async function devLoginTelegram(devUserId: string): Promise<void> {
  await api.post('/telegram-login/dev-login', { devUserId });
}

export async function logoutTelegram(): Promise<void> {
  await api.post('/telegram-login/logout');
}
