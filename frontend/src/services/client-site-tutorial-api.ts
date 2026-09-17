/**
 * Визард обучалки по сайту заказчика (§5.2 ТЗ, этап 115) — тонкие
 * функции над общим `api`, тем же приёмом, что
 * `product-feed-import-api.ts`.
 *
 * Все маршруты за `TelegramIdentityGuard`: черновик принадлежит
 * владельцу проекта, анонимный путь ловит 401.
 */

import { api } from './api';
import type {
  ClientSiteDraftView,
  ClientSiteRoundResult,
  LiveLoginStart,
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
  input: { expectedVersion: number; title: string }
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
