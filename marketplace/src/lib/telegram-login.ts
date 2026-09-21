/**
 * Постоянный (cookie) Telegram-логин для маркетплейса — тот же бэкенд-
 * контур, что уже используют admin/ и frontend/ (backend/src/modules/
 * telegram-login): виджет → POST /telegram-login/callback → httpOnly
 * cookie → GET /telegram-login/me. Нужен для действий, требующих
 * identity (бриф, лайк, квиз исполнителя) — сама витрина (каталог,
 * профили) читается без входа, см. lib/api.ts. Внутри Telegram (TMA-
 * режим, lib/telegram.ts) этот файл по большей части не нужен — identity
 * уже автоматическая через initData, TelegramLoginButton сам не
 * рендерит виджет в этом случае.
 */

import { getAuthHeaders } from './telegram';

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

/**
 * Аудит (тот же класс бага, что найден и исправлен в `client-api.ts` —
 * см. его доккомментарий на `request()` за полным разбором) — HIGH,
 * серьёзнее, чем в client-api.ts: `fetchTelegramLoginMe()` ниже читает
 * поля (`loggedIn`/`telegramId`/...) прямо с результата этой функции, а
 * без распаковки `{success, data}` результат — сама обёртка, на которой
 * `.loggedIn` всегда `undefined` (falsy) — то есть КАЖДЫЙ посетитель вне
 * Telegram Mini App (обычный веб, cookie-логин) детектировался как «не
 * вошёл», даже будучи реально залогиненным httpOnly-cookie. `catch` в
 * `fetchTelegramLoginMe()` эту поломку маскировал тем же исходом
 * (`{loggedIn:false}`), что и настоящий сетевой сбой — то есть баг не
 * бросал видимую ошибку нигде, просто тихо не давал постоянному логину
 * вне TMA когда-либо сработать.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
    const err = body?.error;
    const message = typeof err === 'string' ? err : err?.message;
    throw new Error(message ?? `request failed: ${res.status}`);
  }
  const body = (await res.json()) as { success?: boolean; data?: T } | T;
  return ((body as { success?: boolean }).success ? (body as { data: T }).data : body) as T;
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
