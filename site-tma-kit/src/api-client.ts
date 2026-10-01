/**
 * HTTP-клиент API клиентских сайтов (`sites-backend`).
 *
 * `fetch`, а не axios, как во `frontend/`: пакет копируется в два
 * приложения, и лишняя зависимость в каждом — лишняя версия, которую
 * держать в лад. `fetch` подменяется в тестах.
 */

import { SITE_ACCOUNT_HEADER } from './brand';
import { ApiError, unwrapEnvelope } from './envelope';
import type { RequestAuth } from './telegram';

export interface ApiClientOptions {
  baseUrl: string;
  /**
   * Авторизация на каждый запрос (`buildRequestAuth`): заголовки и режим
   * cookie; `null` — входа нет, запрос не отправляется.
   */
  auth: () => RequestAuth | null;
  /** Выбранный кабинет → `X-Site-Account`; `null` — выбор сервера. */
  accountId?: () => string | null;
  /**
   * 401 от сервера: в веб-режиме это «сессия истекла» — приложение
   * возвращает экран входа, а не показывает ошибку на каждом экране.
   */
  onUnauthorized?: (e: ApiError) => void;
  /** Язык интерфейса — сервер пишет тексты ошибок на нём. */
  locale: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ApiClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Идентификатор кабинета — тот же формат, что принимает сервер. */
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const doFetch = opts.fetchImpl ?? ((...a) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? 30000;

  return {
    async request<T>(method: string, path: string, body?: unknown) {
      const auth = opts.auth();
      if (!auth) {
        // Не шлём запрос без идентичности: кабинет есть только у участника
        // по telegramId, и анонимный ответ 401 человеку ничего не объяснит.
        throw new ApiError(
          'no_telegram',
          'Откройте приложение в Telegram',
          401
        );
      }
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Accept-Language': opts.locale(),
        ...auth.headers,
      };
      const accountId = opts.accountId?.() ?? null;
      if (accountId && ACCOUNT_ID_RE.test(accountId)) {
        headers[SITE_ACCOUNT_HEADER] = accountId;
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      const ctrl =
        typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      let res: Response;
      try {
        res = await doFetch(joinUrl(opts.baseUrl, path), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: auth.credentials,
          signal: ctrl?.signal,
        });
      } catch {
        throw new ApiError('network', 'Нет связи с сервером', 0);
      } finally {
        if (timer) clearTimeout(timer);
      }

      let json: unknown = null;
      const text = await res.text();
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      try {
        return unwrapEnvelope<T>(json, res.status, `${method} ${path}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) opts.onUnauthorized?.(e);
        throw e;
      }
    },
  };
}
