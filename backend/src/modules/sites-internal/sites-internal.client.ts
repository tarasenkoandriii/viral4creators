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
/** Хранилище учётных данных: запись кук сессии (до 256 КБ) — не дольше 10 с. */
const CREDENTIALS_TIMEOUT_MS = 10_000;
const CRED = '/internal/sites/credentials';

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
  /**
   * Может ли человек завести хост в кабинет («Это мой сайт»): `false` —
   * он только оператор кабинетов и своего нет. Старый sites-backend поле
   * не отдаёт — тогда `undefined`, кнопку решают остальные условия.
   */
  canRegister?: boolean;
}

export interface SitesRegisterResult extends SitesHostStatus {
  hostId: string;
  siteId: string;
  created: boolean;
  accountCreated: boolean;
}

/** Э-С Ш2: хранилище учётных данных — назначения секретов. */
export type SitesCredentialPurpose =
  | 'password'
  | 'login-fields'
  | 'session-cookies';

export type SitesCredentialSecrets = Partial<
  Record<SitesCredentialPurpose, string>
>;

export interface SitesSecretFlags {
  password: boolean;
  loginFields: boolean;
  session: boolean;
}

/** Тестовая учётка реестра сайта (режим A) — без секретов. */
export interface SitesTestAccount {
  id: string;
  siteId: string;
  label: string;
  role: string | null;
  plan: string | null;
  username: string | null;
  loginMethod: string;
  hostIds: string[];
  products: string[];
  status: string;
  confirmedTestAccount: boolean;
  createdBy: string;
  secrets: SitesSecretFlags;
  lastUsedAt: string | null;
  expiresAt: string;
  createdAt: string;
  /** Только в списке по хосту: учётка действует на хосте черновика. */
  coversHost?: boolean;
}

/** Ввод учётки (как `parseTestAccountInput` sites-backend). */
export interface SitesTestAccountInput {
  label?: string;
  role?: string | null;
  plan?: string | null;
  username?: string | null;
  password?: string;
  loginMethod?: 'password' | 'session' | 'sso';
  hostIds?: string[];
  products?: Array<'tutorial' | 'qa'>;
  lifetimeDays?: number;
  status?: 'active' | 'frozen';
  confirmedTestAccount?: boolean;
}

/** Личная запись режима B — без секретов. */
export interface SitesUserSession {
  id: string;
  origin: string;
  label: string | null;
  products: string[];
  secrets: SitesSecretFlags;
  lastUsedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

/** Э6: результат проверки привязки черновика к сайту помощника. */
export interface SitesSiteLink {
  siteId: string;
  siteName: string;
  hosts: string[];
}

/** Э6: ролик для полного набора сайта (`site-videos`). */
export interface SitesVideoInput {
  externalId: string;
  draftId: string;
  ownerTelegramId: string;
  title: string;
  locale: string;
  durationMs: number | null;
  url: string;
  requiresLogin: boolean;
  stepHosts: string[];
}

export interface SitesVideoSyncResult {
  siteId: string;
  accepted: number;
  removed: number;
  rejected: Array<{ externalId: string; reason: string }>;
  /** Набор старше последнего принятого (`asOf`) — ничего не изменено. */
  stale?: boolean;
}

/** Э6: элемент карты интерфейса (sites-backend пересчитает id и почистит). */
export interface SitesUiElementInput {
  selector: string;
  tag: string;
  label: string;
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
  constructor(
    message: string,
    /** Машинный код 5xx sites-backend, если он был (Ш2: CREDENTIALS_NOT_CONFIGURED). */
    readonly code: string | null = null,
  ) {
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

  // ── Э-С Ш2: хранилище учётных данных ──────────────────────────────

  credentialsStatus(): Promise<{
    configured: boolean;
    currentKeyVersion: string | null;
  }> {
    return this.post(`${CRED}/status`, {}, STATUS_TIMEOUT_MS);
  }

  listTestAccounts(
    telegramId: string,
    hostId: string,
  ): Promise<{
    siteId: string;
    hosts: Array<{ id: string; host: string; verified: boolean }>;
    accounts: SitesTestAccount[];
  }> {
    return this.post(
      `${CRED}/test-accounts/list`,
      { telegramId, hostId },
      CREDENTIALS_TIMEOUT_MS,
    );
  }

  upsertTestAccount(
    telegramId: string,
    req: {
      hostId: string;
      testAccountId?: string | null;
      clientRef?: string | null;
      account: SitesTestAccountInput;
    },
  ): Promise<SitesTestAccount> {
    return this.post(
      `${CRED}/test-accounts/upsert`,
      {
        telegramId,
        hostId: req.hostId,
        account: req.account,
        ...(req.testAccountId ? { testAccountId: req.testAccountId } : {}),
        ...(req.clientRef ? { clientRef: req.clientRef } : {}),
      },
      CREDENTIALS_TIMEOUT_MS,
    );
  }

  deleteTestAccount(
    telegramId: string,
    testAccountId: string,
  ): Promise<{ deleted: boolean }> {
    return this.post(
      `${CRED}/test-accounts/delete`,
      { telegramId, testAccountId },
      CREDENTIALS_TIMEOUT_MS,
    );
  }

  putTestAccountSecret(
    telegramId: string,
    testAccountId: string,
    purpose: SitesCredentialPurpose,
    secret: string | null,
  ): Promise<SitesTestAccount> {
    return this.post(
      `${CRED}/test-accounts/put-secret`,
      { telegramId, testAccountId, purpose, secret },
      CREDENTIALS_TIMEOUT_MS,
    );
  }

  forgetTestAccountSecrets(
    telegramId: string,
    testAccountId: string,
  ): Promise<{ forgotten: number }> {
    return this.post(
      `${CRED}/test-accounts/forget-secrets`,
      { telegramId, testAccountId },
      CREDENTIALS_TIMEOUT_MS,
    );
  }

  /** Аренда + погашение: секреты учётки на ОДИН раунд (режим A). */
  async leaseSecrets(
    telegramId: string,
    req: { testAccountId: string; hostId: string; runRef?: string },
  ): Promise<SitesCredentialSecrets> {
    const lease = await this.post<{ leaseId: string }>(
      `${CRED}/lease`,
      {
        telegramId,
        testAccountId: req.testAccountId,
        hostId: req.hostId,
        product: 'tutorial',
        ...(req.runRef ? { runRef: req.runRef } : {}),
      },
      CREDENTIALS_TIMEOUT_MS,
    );
    const got = await this.post<{ secrets: SitesCredentialSecrets }>(
      `${CRED}/lease/redeem`,
      { telegramId, leaseId: lease.leaseId },
      CREDENTIALS_TIMEOUT_MS,
    );
    return got.secrets ?? {};
  }

  upsertUserSession(
    ownerRef: string,
    req: { origin: string; clientRef?: string | null; label?: string | null },
  ): Promise<SitesUserSession> {
    return this.post(
      `${CRED}/user-sessions/upsert`,
      {
        ownerRef,
        origin: req.origin,
        ...(req.clientRef ? { clientRef: req.clientRef } : {}),
        ...(req.label !== undefined ? { label: req.label } : {}),
      },
      CREDENTIALS_TIMEOUT_MS,
    );
  }

  listUserSessions(
    ownerRef: string,
  ): Promise<{ sessions: SitesUserSession[] }> {
    return this.post(
      `${CRED}/user-sessions/list`,
      { ownerRef },
      CREDENTIALS_TIMEOUT_MS,
    );
  }

  updateUserSession(
    ownerRef: string,
    sessionId: string,
    label: string | null,
  ): Promise<SitesUserSession> {
    return this.post(
      `${CRED}/user-sessions/update`,
      { ownerRef, sessionId, label },
      CREDENTIALS_TIMEOUT_MS,
    );
  }

  putUserSessionSecret(
    ownerRef: string,
    sessionId: string,
    purpose: SitesCredentialPurpose,
    secret: string | null,
  ): Promise<SitesUserSession> {
    return this.post(
      `${CRED}/user-sessions/put-secret`,
      { ownerRef, sessionId, purpose, secret },
      CREDENTIALS_TIMEOUT_MS,
    );
  }

  async readUserSession(
    ownerRef: string,
    sessionId: string,
    runRef?: string,
  ): Promise<SitesCredentialSecrets> {
    const got = await this.post<{ secrets: SitesCredentialSecrets }>(
      `${CRED}/user-sessions/read`,
      { ownerRef, sessionId, ...(runRef ? { runRef } : {}) },
      CREDENTIALS_TIMEOUT_MS,
    );
    return got.secrets ?? {};
  }

  deleteUserSession(
    ownerRef: string,
    sessionId: string,
  ): Promise<{ deleted: boolean }> {
    return this.post(
      `${CRED}/user-sessions/delete`,
      { ownerRef, sessionId },
      CREDENTIALS_TIMEOUT_MS,
    );
  }

  // ── Э6 помощника: ролики обучалки и карта интерфейса (ТЗ §4.11, §4.12) ──

  /**
   * Можно ли привязать черновик к сайту помощника: человек — владелец или
   * менеджер помощника в кабинете сайта. Чужой и несуществующий —
   * `SitesRejectedError(403, 'SITE_LINK_FORBIDDEN')`.
   */
  linkSite(telegramId: string, siteId: string): Promise<SitesSiteLink> {
    return this.post<SitesSiteLink>(
      '/internal/sites/tutorial/site-link',
      { telegramId, siteId },
      STATUS_TIMEOUT_MS,
    );
  }

  /**
   * Полный набор одобренных роликов сайта (замена на стороне sites-backend).
   * `asOf` — отметка набора (мс, взята ДО чтения базы): набор старше уже
   * принятого sites-backend отвергает (`stale: true`), не меняя ничего.
   */
  syncSiteVideos(
    siteId: string,
    videos: SitesVideoInput[],
    asOf: number,
  ): Promise<SitesVideoSyncResult> {
    return this.post<SitesVideoSyncResult>(
      '/internal/sites/tutorial/site-videos',
      { siteId, asOf, videos },
      REGISTER_TIMEOUT_MS,
    );
  }

  /** Карта интерфейса страницы из раунда обучалки (источник `tutorial`). */
  pushUiMap(
    telegramId: string,
    siteId: string,
    url: string,
    elements: SitesUiElementInput[],
  ): Promise<{ siteId: string; path: string; elements: number }> {
    return this.post(
      '/internal/sites/tutorial/ui-map',
      { telegramId, siteId, url, elements },
      STATUS_TIMEOUT_MS,
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
        res.status === 401 ? null : code,
      );
    }
    if (!json || json.data === undefined || json.data === null) {
      throw new SitesUnavailableError('пустой ответ кабинета сайтов');
    }
    return json.data;
  }
}
