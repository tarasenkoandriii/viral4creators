/**
 * Клиент внутреннего API sites-backend для обучалки по сайту заказчика
 * (Э-С Ш1; П-С3 `docs-tz/SECURITY-PROPOSALS-2026-10-02.md`).
 *
 * Тот же подход, что у `admin-panel/admin-assist.client.ts` (Э4):
 * генератор НЕ получает DSN схемы `sites` и ключей `site_*` — только HTTP
 * к `SITES_BACKEND_URL`. Отличие — способ доказать, что зовёт генератор:
 * вместо секрета в заголовке — HMAC тела с меткой времени и id запроса
 * (`common/sites-internal-signature.ts`, общий код с sites-backend), и
 * секрет свой — `SITES_TUTORIAL_HMAC_SECRET` (почему не общий
 * `SITES_INTERNAL_SECRET` — шапка `sites-backend/.../tutorial-hmac.guard.ts`).
 *
 * Ошибки — типами, а не HTTP-исключениями: решает вызывающий. Обучалка
 * при любой недоступности переходит в режим B и работает дальше (П-Т1:
 * «sites-backend недоступен — режим B, без падения обучалки»), а на
 * явное действие «подтвердить сайт» отвечает понятным текстом.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  SITES_CALLER_TUTORIAL,
  isUsableSitesSecret,
  sitesSignatureHeaders,
} from '../../common/sites-internal-signature';

/** Статус хоста — короче админского таймаута: это раунд визарда, а не отчёт. */
const STATUS_TIMEOUT_MS = 5_000;
const REGISTER_TIMEOUT_MS = 15_000;

export type SitesHostReason =
  | null
  | 'no_account'
  | 'not_registered'
  | 'not_verified'
  | 'expired'
  | 'revoked'
  | 'role'
  | 'opted_out';

export interface SitesHostStatus {
  mode: 'A' | 'B';
  host: string;
  registrableDomain: string | null;
  hostId: string | null;
  status: 'pending' | 'verified' | 'expired' | 'revoked' | 'none';
  expiresAt: string | null;
  optedOut: boolean;
  reason: SitesHostReason;
}

export interface SitesRegisterResult extends SitesHostStatus {
  hostId: string;
  siteId: string;
  created: boolean;
  accountCreated: boolean;
}

export class SitesNotConfiguredError extends Error {
  constructor() {
    super(
      'кабинет сайтов не подключён: задайте SITES_BACKEND_URL и SITES_TUTORIAL_HMAC_SECRET',
    );
    this.name = 'SitesNotConfiguredError';
  }
}

/** Сеть, таймаут, 5xx, 401 (секреты не совпали) — «сейчас не получилось». */
export class SitesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SitesUnavailableError';
  }
}

/** 4xx с машинным кодом sites-backend (HOST_INVALID, HOST_OPTED_OUT…). */
export class SitesRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SitesRejectedError';
  }
}

/** Адрес sites-backend: https (или localhost/имя сервиса compose) — как у админки. */
export function sitesBackendOrigin(env: NodeJS.ProcessEnv): string | null {
  const raw = env.SITES_BACKEND_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (
      u.protocol !== 'https:' &&
      u.hostname !== 'localhost' &&
      u.hostname !== 'sites-backend'
    ) {
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}

/** Telegram-id пользователя генератора — только настоящий, числовой. */
export function sitesTelegramId(raw: string | null | undefined): string | null {
  return typeof raw === 'string' && /^[1-9]\d{0,19}$/.test(raw) ? raw : null;
}

@Injectable()
export class SitesInternalClient {
  private readonly logger = new Logger(SitesInternalClient.name);
  /** Тесты подменяют сеть, env и часы. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  configured(): boolean {
    return (
      !!sitesBackendOrigin(this.env) &&
      isUsableSitesSecret(this.env.SITES_TUTORIAL_HMAC_SECRET)
    );
  }

  hostStatus(telegramId: string, url: string): Promise<SitesHostStatus> {
    return this.post<SitesHostStatus>(
      '/internal/sites/tutorial/host-status',
      { telegramId, url },
      STATUS_TIMEOUT_MS,
    );
  }

  registerHost(telegramId: string, url: string): Promise<SitesRegisterResult> {
    return this.post<SitesRegisterResult>(
      '/internal/sites/tutorial/register-host',
      { telegramId, url },
      REGISTER_TIMEOUT_MS,
    );
  }

  private async post<T>(
    path: string,
    payload: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const base = sitesBackendOrigin(this.env);
    const secret = this.env.SITES_TUTORIAL_HMAC_SECRET?.trim();
    if (!base || !isUsableSitesSecret(secret)) {
      throw new SitesNotConfiguredError();
    }
    const body = JSON.stringify(payload);
    const headers = sitesSignatureHeaders(secret, {
      caller: SITES_CALLER_TUTORIAL,
      method: 'POST',
      path,
      body,
      unixSeconds: Math.floor(this.now().getTime() / 1000),
      // Новый id на КАЖДУЮ попытку: повтор после таймаута — это новый
      // запрос, а не перехваченный старый (тот отвергнет журнал id).
      requestId: randomUUID(),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}${path}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      clearTimeout(timer);
      this.logger.warn(
        `sites-backend не ответил на ${path}: ${(err as Error).name}`,
      );
      throw new SitesUnavailableError('кабинет сайтов сейчас не отвечает');
    }
    // Таймер держит и чтение тела (аудит Ш1): заголовки пришли, а тело
    // зависло — без этого раунд визарда ждал бы его без срока, а не
    // уходил бы в режим B через 5 с.
    let json: {
      data?: T;
      error?: { code?: string; message?: string };
    } | null;
    try {
      json = (await res.json().catch(() => null)) as typeof json;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const code = json?.error?.code ?? 'SITES_BACKEND_ERROR';
      // Коды — в лог (без тела и без telegramId): по ним видно, что
      // секреты разошлись (INTERNAL_SIGNATURE_*), а не «что-то сломалось».
      this.logger.warn(
        `sites-backend ответил ${res.status} ${code} на ${path}`,
      );
      if (res.status >= 400 && res.status < 500 && res.status !== 401) {
        throw new SitesRejectedError(
          res.status,
          code,
          json?.error?.message ?? 'запрос отклонён',
        );
      }
      throw new SitesUnavailableError(
        res.status === 401
          ? 'кабинет сайтов не принял подпись генератора (проверьте SITES_TUTORIAL_HMAC_SECRET с обеих сторон)'
          : 'кабинет сайтов вернул ошибку',
      );
    }
    if (!json || json.data === undefined || json.data === null) {
      throw new SitesUnavailableError('пустой ответ кабинета сайтов');
    }
    return json.data;
  }
}
