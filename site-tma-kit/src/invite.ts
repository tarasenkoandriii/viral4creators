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

/**
 * Приглашение из запуска (аудит Н-1): раньше `startapp=inv_…`/`?invite=`
 * принималось само при открытии и переключало человека в чужой кабинет.
 * Теперь — только по кнопке экрана подтверждения, и выбранный кабинет не
 * меняется. Шаги:
 *  - `idle` — приглашения нет;
 *  - `confirm` — экран «Вас приглашают в ЧУЖОЙ кабинет» (превью сервера);
 *  - `accepting` — человек нажал «Принять», запрос в пути;
 *  - `joined` — принято: кабинет добавлен, выбран прежний; тост
 *    «Переключиться»;
 *  - `closed` — отклонено/недействительно/тост закрыт.
 * Кабинет (`GET /sites/account`) не грузится, пока решение не принято:
 * новичку он создал бы пустой «свой» кабинет до того, как человек решил.
 */
export type InviteFlow =
  | { step: 'idle' }
  | { step: 'confirm'; token: string }
  | { step: 'accepting'; token: string }
  | {
      step: 'joined';
      accountId: string;
      role: 'owner' | 'manager' | 'operator';
    }
  | { step: 'closed' };

export type InviteFlowEvent =
  | { type: 'accept' }
  | { type: 'decline' }
  | {
      type: 'accepted';
      accountId: string;
      role: 'owner' | 'manager' | 'operator';
    }
  /** Сессия кончилась (401) — приглашение ждёт входа, снова на экран. */
  | { type: 'unauthorized' }
  | { type: 'failed' }
  /** Тост закрыт / человек сам выбрал кабинет. */
  | { type: 'dismiss' };

/** Начало: токен из запуска → экран подтверждения, без него — ничего. */
export function startInviteFlow(token: string | null): InviteFlow {
  return token ? { step: 'confirm', token } : { step: 'idle' };
}

export function inviteFlowNext(
  flow: InviteFlow,
  ev: InviteFlowEvent
): InviteFlow {
  switch (ev.type) {
    case 'accept':
      // Принять можно только с экрана подтверждения.
      return flow.step === 'confirm'
        ? { step: 'accepting', token: flow.token }
        : flow;
    case 'decline':
      return flow.step === 'confirm' ? { step: 'closed' } : flow;
    case 'accepted':
      return flow.step === 'accepting'
        ? { step: 'joined', accountId: ev.accountId, role: ev.role }
        : flow;
    case 'unauthorized':
      return flow.step === 'accepting'
        ? { step: 'confirm', token: flow.token }
        : flow;
    case 'failed':
      return flow.step === 'accepting' ? { step: 'closed' } : flow;
    case 'dismiss':
      return flow.step === 'joined' ? { step: 'closed' } : flow;
  }
}

/** Экран подтверждения вместо кабинета: решение ещё не принято. */
export function inviteBlocksAccount(flow: InviteFlow): boolean {
  return flow.step === 'confirm' || flow.step === 'accepting';
}

/** Токен, ждущий решения (подсказка на экране входа веб-кабинета). */
export function pendingInviteToken(flow: InviteFlow): string | null {
  return flow.step === 'confirm' || flow.step === 'accepting'
    ? flow.token
    : null;
}

/**
 * Тост после принятия. Выбранный кабинет принятие НЕ меняет (запрос идёт с
 * прежним `X-Site-Account` или без него — тогда сервер откроет свой).
 * `switch` — открыт другой кабинет, предложить переключиться в
 * добавленный; `here` — добавленный и так открыт (новичок без своего
 * кабинета); `null` — тоста нет.
 */
export function inviteJoinNotice(
  flow: InviteFlow,
  openAccountId: string
): { kind: 'switch' | 'here'; accountId: string } | null {
  if (flow.step !== 'joined') return null;
  return {
    kind: flow.accountId === openAccountId ? 'here' : 'switch',
    accountId: flow.accountId,
  };
}
