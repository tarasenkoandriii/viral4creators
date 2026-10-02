/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/types.ts */
/**
 * Формы данных кабинета (ядро `site-core`, ТЗ помощника §3.2–§3.3, §4.17;
 * `TZ-QA-TMA.md` §1.5, §4.7). Одна сущность на оба продукта: сайт,
 * подтверждённый в одном TMA, подтверждён и в другом.
 */

/** Статусы хоста в ядре — общие с QA (`TZ-QA-TMA.md` §2.4). */
export const HOST_STATUSES = [
  'pending',
  'verified',
  'expired',
  'revoked',
] as const;
export type HostStatus = (typeof HOST_STATUSES)[number];

export const VERIFY_METHODS = ['dns', 'file', 'meta'] as const;
export type VerifyMethod = (typeof VERIFY_METHODS)[number];

export type AccountRole = 'owner' | 'manager' | 'operator';

export interface ProductRoles {
  qa: 'admin' | 'viewer' | 'none';
  assist: 'manager' | 'operator' | 'none';
  assistAdmin: 'owner' | 'employee' | 'none';
}

/** Итог последней проверки — сервер пишет человеку текст сам. */
export interface HostCheck {
  ok: boolean;
  code?: string;
  message?: string;
  at?: string;
}

export interface SiteHost {
  id: string;
  siteId: string;
  scheme: 'https';
  host: string;
  port: number;
  status: HostStatus;
  method: VerifyMethod | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** `*.myshopify.com` и т.п. — только DNS (ТЗ §3.3). */
  publicPlatform: boolean;
  lastCheck: HostCheck | null;
  /** Последняя автоматическая перепроверка (крон ядра). */
  lastRecheckAt: string | null;
  /**
   * Владелец хоста (кабинет, подтвердивший его) отозвал наше подтверждение
   * и запретил повтор (QA-ТЗ §5.1): ни проверить, ни удалить хост нельзя.
   */
  reverifyBlocked: boolean;
}

export interface Site {
  id: string;
  name: string;
  hosts: SiteHost[];
}

export interface SiteAccount {
  id: string;
  type: 'owner' | 'agency';
  region: string;
  /**
   * Токен кабинета — один на все хосты (значение TXT/файла/меты).
   * `null` — оператору: подтверждают владение владелец и менеджер, и
   * токен им не нужен (сервер его не отдаёт).
   */
  verifyToken: string | null;
}

export interface AccountMember {
  /**
   * Э3: id участника для PATCH/DELETE `/sites/account/members/:memberId`
   * (сервер Э3 отдаёт всегда). Пустая строка — id не прошёл проверку
   * сегмента пути: правок для такой строки нет.
   */
  memberId: string;
  telegramId: string;
  role: AccountRole;
  productRoles: ProductRoles;
}

/** Кабинет из списка «мои кабинеты» — для переключателя. */
export interface AccountRef {
  id: string;
  role: AccountRole;
}

/** `GET /sites/account` — кабинет создаётся при первом входе. */
export interface AccountInfo {
  account: SiteAccount;
  me: AccountMember;
  /** Только владельцу и менеджеру; оператору — `null` (видит себя). */
  members: AccountMember[] | null;
  /** Все кабинеты человека (свой, агентства…); >1 — показать выбор. */
  accounts: AccountRef[];
  /** true — кабинет создан этим запросом (первый вход). */
  created: boolean;
}

export interface VerifyResult {
  host: SiteHost;
  ok: boolean;
  code?: string;
  message?: string;
}

/** `POST /sites/account/invites` — токен показывается один раз. */
export interface Invite {
  token: string;
  /** `inv_<token>` — для `t.me/<бот>?startapp=` и `?invite=` веба. */
  startParam: string;
  expiresAt: string | null;
}

/** Чужая строка того же хоста (другой кабинет). */
export interface ForeignAuthorization {
  hostId: string;
  status: HostStatus;
  method: VerifyMethod | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  reverifyBlocked: boolean;
}

export interface HostAuthorizations {
  host: SiteHost;
  others: ForeignAuthorization[];
}

/** Итог «Отозвать все чужие»: что осталось удалить руками в DNS/файле. */
export interface RevokeResult {
  revoked: number;
  foreignMarkers: {
    dnsName: string;
    dns: string[];
    file: string | null;
  };
}
