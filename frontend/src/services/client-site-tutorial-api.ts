/**
 * Визард обучалки по сайту заказчика (§5.2 ТЗ, этап 115) — тонкие
 * функции над общим `api`, тем же приёмом, что
 * `product-feed-import-api.ts`.
 *
 * Все маршруты за `TelegramIdentityGuard`: черновик принадлежит
 * владельцу проекта, анонимный путь ловит 401.
 */

import { api } from './api';
import axios from 'axios';
import type {
  ClientSiteDraftView,
  ClientSiteRoundResult,
  ConsentLocale,
  LiveLoginStart,
  LoginFieldPick,
  RegistryLoginOptions,
  SiteAccessView,
} from '../types/client-site-tutorial';

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

const base = (projectId: string) => `/projects/${projectId}/site-tutorial`;

/** `null`, если визард ещё не начинали — это не ошибка. */
export async function getSiteTutorial(
  projectId: string
): Promise<ClientSiteDraftView | null> {
  const res = await api.get<ClientSiteDraftView | null>(base(projectId));
  return res.data ?? null;
}

export async function exploreSite(
  projectId: string,
  url: string
): Promise<ClientSiteRoundResult> {
  return unwrap(
    await api.post<ClientSiteRoundResult>(`${base(projectId)}/explore`, {
      url,
    }),
    'explore'
  );
}

/** Э6 помощника: к какому сайту ИИ-помощника привязан черновик. */
export interface AssistLinkView {
  clientSiteId: string | null;
  siteName: string | null;
}

/**
 * Привязать черновик к сайту помощника (`null` — отвязать). Сервер
 * проверяет во внутреннем API sites-backend, что человек — владелец или
 * менеджер помощника этого сайта; иначе 403.
 */
export async function setAssistLink(
  projectId: string,
  siteId: string | null
): Promise<AssistLinkView> {
  return unwrap(
    await api.putJson<AssistLinkView>(`${base(projectId)}/assist-link`, {
      siteId,
    }),
    'assist-link'
  );
}

export async function stepSite(
  projectId: string,
  input: {
    expectedVersion: number;
    fills: Array<{ selector: string; value: string }>;
    clickSelector?: string;
  }
): Promise<ClientSiteRoundResult> {
  return unwrap(
    await api.post<ClientSiteRoundResult>(`${base(projectId)}/step`, input),
    'step'
  );
}

export async function loginSite(
  projectId: string,
  input: {
    expectedVersion: number;
    submitSelector: string;
    fields: Array<{ selector: string; value: string; sensitive: boolean }>;
  }
): Promise<ClientSiteRoundResult> {
  return unwrap(
    await api.post<ClientSiteRoundResult>(`${base(projectId)}/login`, input),
    'login'
  );
}

/** Ш2-хвост (3): учётки реестра сайта для входа на шаге мастера. */
export async function getRegistryLoginOptions(
  projectId: string
): Promise<RegistryLoginOptions> {
  return unwrap(
    await api.get<RegistryLoginOptions>(
      `${base(projectId)}/test-accounts/for-login`
    ),
    'login options'
  );
}

/**
 * Ш2-хвост (3): вход учёткой реестра. Секретов в теле нет — только id
 * учётки; поля формы сервер находит сам, а если не нашёл (422
 * `LOGIN_FIELDS_NOT_FOUND`) — тот же вызов с указанными полями (`pick`).
 */
export async function loginWithRegistryAccount(
  projectId: string,
  input: {
    expectedVersion: number;
    testAccountId: string;
    pick?: LoginFieldPick;
  }
): Promise<ClientSiteRoundResult> {
  return unwrap(
    await api.post<ClientSiteRoundResult>(
      `${base(projectId)}/login-registry`,
      input
    ),
    'login-registry'
  );
}

/**
 * Свежий снимок текущей страницы — без записи в черновик. Нужен, чтобы
 * продолжить запись после перезагрузки вкладки: кадр приходит только
 * ответом на раунд, и восстановить его из состояния нечем.
 */
export async function refreshSiteTutorial(
  projectId: string
): Promise<ClientSiteRoundResult> {
  return unwrap(
    await api.post<ClientSiteRoundResult>(`${base(projectId)}/refresh`),
    'refresh'
  );
}

export async function undoSiteRound(
  projectId: string,
  expectedVersion: number
): Promise<ClientSiteRoundResult> {
  return unwrap(
    await api.post<ClientSiteRoundResult>(`${base(projectId)}/undo`, {
      expectedVersion,
    }),
    'undo'
  );
}

/**
 * Кадры в теле НЕ едут: сервер заливает в хранилище то, что сам же снял
 * на каждом раунде (§15 п.1). Лента на экране просмотра показывает ровно
 * то же самое, но источником правды не является.
 */
export async function finishSiteTutorial(
  projectId: string,
  input: {
    expectedVersion: number;
    title: string;
    /** Озвучить по кадрам (06.10.2026); по умолчанию сервер — ВКЛ. */
    voice?: boolean;
    /** Язык реплик и подписей — язык интерфейса. */
    locale?: string;
  }
): Promise<ClientSiteDraftView> {
  return unwrap(
    await api.post<ClientSiteDraftView>(`${base(projectId)}/finish`, input),
    'finish'
  );
}

export async function resumeSiteTutorial(
  projectId: string
): Promise<ClientSiteDraftView> {
  return unwrap(
    await api.post<ClientSiteDraftView>(`${base(projectId)}/resume`),
    'resume'
  );
}

export async function deleteSiteTutorial(projectId: string): Promise<void> {
  await api.delete(base(projectId));
}

export async function startLiveLogin(
  projectId: string
): Promise<LiveLoginStart> {
  return unwrap(
    await api.post<LiveLoginStart>(`${base(projectId)}/live-login/start`),
    'live login'
  );
}

export async function completeLiveLogin(
  projectId: string,
  ticket: string,
  expectedVersion: number
): Promise<ClientSiteRoundResult> {
  return unwrap(
    await api.post<ClientSiteRoundResult>(
      `${base(projectId)}/live-login/complete`,
      { ticket, expectedVersion }
    ),
    'live login complete'
  );
}

/** Машинный код отказа сервера (`error.code` конверта) или `null`. */
export function apiErrorCode(err: unknown): string | null {
  if (!axios.isAxiosError(err)) return null;
  const code = (
    err.response?.data as { error?: { code?: unknown } } | undefined
  )?.error?.code;
  return typeof code === 'string' ? code : null;
}

/** Подробность отказа (`error.details.reason` конверта) или `null`. */
export function apiErrorReason(err: unknown): string | null {
  if (!axios.isAxiosError(err)) return null;
  const reason = (
    err.response?.data as
      | { error?: { details?: { reason?: unknown } } }
      | undefined
  )?.error?.details?.reason;
  return typeof reason === 'string' ? reason : null;
}

/** Э-С Ш1: режим A/B. До первого `/explore` — по ссылке, потом — по черновику. */
export async function getSiteAccess(
  projectId: string,
  url?: string
): Promise<SiteAccessView> {
  return unwrap(
    await api.post<SiteAccessView>(
      `${base(projectId)}/access`,
      url ? { url } : {}
    ),
    'site access'
  );
}

/** П-Т2: подтверждение прав на аккаунт (режим B) с версией текста. */
export async function acceptAccountConsent(
  projectId: string,
  input: { url?: string; textVersion: string; locale: ConsentLocale }
): Promise<SiteAccessView> {
  return unwrap(
    await api.post<SiteAccessView>(`${base(projectId)}/consent`, {
      ...input,
      accepted: true,
    }),
    'account consent'
  );
}

/** Ш1: «Это мой сайт» — завести хост в кабинете сайтов (согласие на привязку — на экране). */
export async function verifySite(
  projectId: string,
  url?: string
): Promise<SiteAccessView> {
  return unwrap(
    await api.post<SiteAccessView>(`${base(projectId)}/verify-site`, {
      ...(url ? { url } : {}),
      linkAccount: true,
    }),
    'verify site'
  );
}
