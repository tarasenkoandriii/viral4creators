/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/web-auth.ts */
/**
 * Веб-кабинет вне Telegram: вход Telegram Login Widget → сессия.
 *
 * Тот же кабинет, что в TMA (человек — тот же `telegramId`), только
 * идентичность — не initData, а HttpOnly-cookie, которую ставит
 * `sites-backend` в ответ на `POST /sites/auth/web-login`. Фронт cookie не
 * видит и не хранит: все запросы веб-режима идут с
 * `credentials: 'same-origin'` через прокси `/api` (см. assist/vercel.json).
 */

import type { ApiClient } from './api-client';
import { ApiError } from './envelope';

/** Объект, который виджет передаёт в `data-onauth` (подписан ботом). */
export interface TelegramLoginPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export const TELEGRAM_LOGIN_WIDGET_SRC =
  'https://telegram.org/js/telegram-widget.js?22';

export interface WebSessionUser {
  telegramId: string | null;
  firstName: string | null;
  username: string | null;
}

function parseUser(v: unknown): WebSessionUser {
  const o =
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  const s = (x: unknown) => (typeof x === 'string' && x ? x : null);
  const id = o.telegramId ?? o.id;
  return {
    telegramId:
      typeof id === 'string' || typeof id === 'number' ? String(id) : null,
    firstName: s(o.firstName ?? o.first_name),
    username: s(o.username),
  };
}

/** «Не вошёл» — ответ, а не сбой: 401/403 на `/me`. */
const isLoggedOut = (e: unknown) =>
  e instanceof ApiError && (e.status === 401 || e.status === 403);

export function createWebAuthApi(client: ApiClient) {
  return {
    /** Сессия есть → пользователь; нет → `null`; сеть/5xx — бросает. */
    me: async (): Promise<WebSessionUser | null> => {
      try {
        return parseUser(await client.request('GET', '/sites/auth/me'));
      } catch (e) {
        if (isLoggedOut(e)) return null;
        throw e;
      }
    },
    /**
     * Тело — объект виджета КАК ЕСТЬ: подпись считается по его полям.
     * Ответ сервера — `{ user, expiresAt }` (web-auth.controller.ts), в
     * отличие от `/me`, где пользователь — сам ответ.
     */
    login: async (payload: TelegramLoginPayload) => {
      const r = await client.request('POST', '/sites/auth/web-login', payload);
      const o =
        r !== null && typeof r === 'object' && !Array.isArray(r)
          ? (r as Record<string, unknown>)
          : {};
      return parseUser('user' in o ? o.user : r);
    },
    logout: async () => {
      try {
        await client.request('POST', '/sites/auth/logout');
      } catch (e) {
        // Пустой ответ и «уже не вошёл» — тоже выход.
        if (
          !(e instanceof ApiError) ||
          (e.code !== 'empty_response' && !isLoggedOut(e))
        ) {
          throw e;
        }
      }
    },
  };
}

export type WebAuthApi = ReturnType<typeof createWebAuthApi>;
