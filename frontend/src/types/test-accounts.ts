/**
 * Тестовые учётные записи сайта в мастере обучалки (Э-С Ш2) — ручная копия
 * ответа `client-site-test-accounts.service.ts` (backend) и вида учётки
 * sites-backend. Пароля здесь нет и быть не может: сервер его не отдаёт.
 */

export type TestAccountProduct = 'tutorial' | 'qa';
export type TestAccountStatus = 'active' | 'frozen' | 'expired';

export interface TestAccountSecretFlags {
  password: boolean;
  loginFields: boolean;
  session: boolean;
}

export interface SiteTestAccount {
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
  secrets: TestAccountSecretFlags;
  lastUsedAt: string | null;
  expiresAt: string;
  createdAt: string;
  coversHost?: boolean;
}

export interface UserSiteSession {
  id: string;
  origin: string;
  label: string | null;
  products: string[];
  secrets: TestAccountSecretFlags;
  lastUsedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface TestAccountsView {
  store: 'on' | 'off';
  mode: 'A' | 'B';
  hasDraft: boolean;
  accounts: SiteTestAccount[];
  hosts: Array<{ id: string; host: string; verified: boolean }>;
  sessions: UserSiteSession[];
  draftRecordId: string | null;
}

/** Тело создания/правки учётки реестра (режим A). */
export interface TestAccountPayload {
  label?: string;
  role?: string | null;
  plan?: string | null;
  username?: string | null;
  password?: string;
  hostIds?: string[];
  products?: TestAccountProduct[];
  lifetimeDays?: number;
  status?: 'active' | 'frozen';
  confirmedTestAccount?: boolean;
}
