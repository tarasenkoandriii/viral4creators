/**
 * Постоянный (cookie) Telegram-логин для маркетплейса — тот же бэкенд-
 * контур, что уже используют admin/ и frontend/ (backend/src/modules/
 * telegram-login): виджет → POST /telegram-login/callback → httpOnly
 * cookie → GET /telegram-login/me. Нужен для действий, требующих
 * identity (бриф, лайк, квиз исполнителя) — сама витрина (каталог,
 * профили) читается без входа, см. lib/api.ts.
 */

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000/api';

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? `request failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchTelegramLoginMe(): Promise<TelegramLoginMeResult> {
  try {
    return await request<TelegramLoginMeResult>('/telegram-login/me');
  } catch {
    return { loggedIn: false };
  }
}

export function telegramLoginCallback(payload: TelegramLoginWidgetPayload): Promise<void> {
  return request('/telegram-login/callback', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function devLoginTelegram(devUserId: string): Promise<void> {
  return request('/telegram-login/dev-login', {
    method: 'POST',
    body: JSON.stringify({ devUserId }),
  });
}

export function logoutTelegram(): Promise<void> {
  return request('/telegram-login/logout', { method: 'POST' });
}
