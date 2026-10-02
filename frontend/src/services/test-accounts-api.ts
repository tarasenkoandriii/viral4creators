/**
 * «Тестовые учётные записи» мастера обучалки (Э-С Ш2) — маршруты
 * `/projects/:id/site-tutorial/test-accounts`. Пароль уходит только в теле
 * создания/правки и обратно не возвращается.
 */
import { api } from './api';
import type {
  SiteTestAccount,
  TestAccountPayload,
  TestAccountsView,
  UserSiteSession,
} from '../types/test-accounts';

const base = (projectId: string) =>
  `/projects/${projectId}/site-tutorial/test-accounts`;

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

export async function listTestAccounts(
  projectId: string
): Promise<TestAccountsView> {
  return unwrap(await api.get<TestAccountsView>(base(projectId)), 'list');
}

export async function createTestAccount(
  projectId: string,
  payload: TestAccountPayload
): Promise<SiteTestAccount> {
  return unwrap(
    await api.post<SiteTestAccount>(base(projectId), payload),
    'create'
  );
}

export async function updateTestAccount(
  projectId: string,
  id: string,
  payload: TestAccountPayload | { label: string | null }
): Promise<SiteTestAccount | UserSiteSession> {
  return unwrap(
    await api.patch<SiteTestAccount | UserSiteSession>(
      `${base(projectId)}/${encodeURIComponent(id)}`,
      payload
    ),
    'update'
  );
}

export async function forgetTestAccount(
  projectId: string,
  id: string
): Promise<void> {
  await api.delete(`${base(projectId)}/${encodeURIComponent(id)}`);
}
