/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/account-select.ts */
/**
 * Выбор кабинета, если человек состоит в нескольких (свой + агентства).
 *
 * Выбор уходит на сервер заголовком `X-Site-Account` (api-client) и
 * запоминается на устройстве. Запомненный кабинет, которого больше нет в
 * списке (человека исключили), не отправляется: сервер ответил бы 403
 * `ACCOUNT_REQUIRED` на каждый экран.
 */

import { STORAGE_PREFIX } from './brand';
import type { AccountRef, AccountRole } from './types';

const KEY = `${STORAGE_PREFIX}account`;

export function readStoredAccountId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function storeAccountId(id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* приватный режим — выбор живёт до перезагрузки */
  }
}

/** Запомненный выбор, если он ещё есть в списке; иначе `null` (выбор сервера). */
export function pickAccountId(
  stored: string | null,
  accounts: AccountRef[]
): string | null {
  return stored && accounts.some((a) => a.id === stored) ? stored : null;
}

/** Кто может добавлять хосты и подтверждать владение (QA §1.5). */
export function canManage(role: AccountRole): boolean {
  return role === 'owner' || role === 'manager';
}

/** Короткая метка кабинета: хвост id — различимо и без имени. */
export function shortAccountId(id: string): string {
  return id.length > 6 ? `…${id.slice(-6)}` : id;
}

/**
 * В каком кабинете человек сейчас действует (аудит Н-1): экраны добавления
 * сайта и подтверждения хоста показывают это рядом с токеном. `own` —
 * человек его владелец; иначе всё, что он здесь подтвердит или заведёт,
 * достаётся владельцу чужого кабинета.
 */
export function accountContext(info: {
  account: { id: string };
  me: { role: AccountRole };
}): { own: boolean; label: string; role: AccountRole } {
  return {
    own: info.me.role === 'owner',
    label: shortAccountId(info.account.id),
    role: info.me.role,
  };
}
