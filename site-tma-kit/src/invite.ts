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
