/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/invite.ts */
/**
 * Ссылки-приглашения и права приглашённого (ТЗ помощника §3.2): чистые
 * функции — проверяются скриптом без React.
 */

import { WEB_INVITE_PARAM } from './start-param';
import type { ProductRoles } from './types';

export type InviteRole = 'manager' | 'operator';
export type AdminRole = ProductRoles['assistAdmin'];

/** Ссылка в бот: `https://t.me/<бот>?startapp=inv_…` (ТЗ помощника §3.2). */
export function telegramInviteLink(
  botUsername: string,
  startParam: string
): string {
  const bot = botUsername.replace(/^@/, '');
  return `https://t.me/${bot}?startapp=${encodeURIComponent(startParam)}`;
}

/** Ссылка в веб-кабинет: `<адрес приложения>?invite=inv_…`. */
export function webInviteLink(webUrl: string, startParam: string): string {
  const u = new URL(webUrl);
  u.hash = '';
  u.searchParams.set(WEB_INVITE_PARAM, startParam);
  return u.toString();
}

/**
 * Права по продукту для приглашённого. Роль кабинета без прав продукта
 * (умолчание сервера — `none`) не открыла бы человеку экраны продукта,
 * в который его зовут: приглашение из Помощника даёт `assist` той же
 * роли, из QA — `qa` (менеджер → admin, оператор → viewer). «Админка»
 * Помощника — отдельное право (К-9), только явным выбором.
 */
export function inviteProductRoles(
  app: 'assist' | 'qa',
  role: InviteRole,
  assistAdmin: AdminRole
): Partial<ProductRoles> {
  if (app === 'qa') return { qa: role === 'manager' ? 'admin' : 'viewer' };
  return { assist: role, assistAdmin };
}

/** Коды отказов правок участников (сервер — site-core, агент H Э3). */
export const MEMBER_ERROR_CODES = [
  'MEMBER_NOT_FOUND',
  'MEMBER_LAST_OWNER',
  'MEMBER_ROLES_INVALID',
] as const;
export type MemberErrorCode = (typeof MEMBER_ERROR_CODES)[number];

export function isMemberErrorCode(v: unknown): v is MemberErrorCode {
  return (
    typeof v === 'string' &&
    (MEMBER_ERROR_CODES as readonly string[]).includes(v)
  );
}

interface MemberLike {
  memberId?: string;
  telegramId: string;
  role: 'owner' | 'manager' | 'operator';
}

/**
 * Что можно сделать с участником `m` (кнопки экрана; решает всё равно
 * сервер): роль меняет только владелец и не у владельца; удалить —
 * владелец (не владельца), себя — любой не-владелец («выйти»). Без
 * `memberId` (id не прошёл проверку сегмента пути) — ничего.
 */
export function memberActions(
  me: MemberLike,
  m: MemberLike
): { changeRole: boolean; remove: boolean; leave: boolean } {
  const none = { changeRole: false, remove: false, leave: false };
  if (!m.memberId) return none;
  const self = m.telegramId === me.telegramId;
  if (self) return { ...none, leave: m.role !== 'owner' };
  if (me.role !== 'owner' || m.role === 'owner') return none;
  return { changeRole: true, remove: true, leave: false };
}

/** PATCH роли: роль кабинета + права продукта той же роли (как приглашение). */
export function memberRolePatch(
  app: 'assist' | 'qa',
  role: InviteRole,
  assistAdmin: AdminRole
): { role: InviteRole; productRoles: Partial<ProductRoles> } {
  return { role, productRoles: inviteProductRoles(app, role, assistAdmin) };
}
