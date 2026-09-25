/**
 * Приглашение тестировщика — чистые правила (этап 155,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §2).
 *
 * ## Почему это отдельный чистый модуль
 *
 * Здесь решается, кому и на каком основании выдаётся тестовый доступ,
 * то есть право тратить наши деньги. Проверять такое глазами по коду
 * сервиса, у которого рядом база и Telegram, — плохая идея; в
 * отдельном модуле каждое правило под тестом и под мутацией.
 */

import { CODE_ALPHABET } from './referral';

/**
 * Префикс полезной нагрузки `?start=`.
 *
 * Нагрузка одна на весь бот, и однажды в неё захотят положить что-то
 * ещё (второй аудит ТЗ, Б-5). Без префикса разобрать, чей это токен,
 * будет нечем — а перепутанный токен это выданный не тот доступ.
 */
export const INVITE_PREFIX = 't_';

/** 24 символа + префикс = 26 из 64 допустимых. Запас на будущие виды. */
export const INVITE_TOKEN_LENGTH = 24;

/**
 * Что Telegram вообще принимает в `?start=`: `A-Z a-z 0-9 _ -`, не
 * длиннее 64. Проверка нужна не от злого умысла, а чтобы ссылка,
 * собранная из токена, не оказалась молча нерабочей.
 */
const PAYLOAD_OK = /^[A-Za-z0-9_-]{1,64}$/;

export function inviteToken(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < INVITE_TOKEN_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return out;
}

export function invitePayload(token: string): string {
  return `${INVITE_PREFIX}${token}`;
}

export function inviteLink(botUsername: string, token: string): string {
  return `https://t.me/${botUsername}?start=${invitePayload(token)}`;
}

/**
 * Достать токен из текста команды.
 *
 * `null` означает «это не наше приглашение» и для всех причин одно и то
 * же: нет нагрузки, чужой префикс, недопустимые символы. Разные ответы
 * на разные причины рассказали бы постороннему, как устроены наши
 * ссылки, а пользы не дали бы никакой.
 */
export function tokenFromStart(text: string | undefined): string | null {
  if (!text) return null;
  const m = /^\/start(?:@\S+)?\s+(\S+)$/.exec(text.trim());
  if (!m) return null;
  const payload = m[1];
  if (!PAYLOAD_OK.test(payload)) return null;
  if (!payload.startsWith(INVITE_PREFIX)) return null;
  const token = payload.slice(INVITE_PREFIX.length);
  return token.length > 0 ? token : null;
}

export interface InviteRow {
  token: string;
  freeScenarios: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  userId: string | null;
}

export type InviteVerdict =
  | { kind: 'activate' }
  | { kind: 'repeat' }
  | { kind: 'revoked' }
  | { kind: 'expired' }
  | { kind: 'taken' };

/**
 * Можно ли активировать приглашение этим человеком.
 *
 * Порядок проверок важнее самих проверок. Отзыв идёт ПЕРВЫМ: отозванное
 * приглашение не должно отвечать «уже использовано» тому, кто его
 * активировал, — оператор отозвал его именно затем, чтобы доступа
 * больше не было, и подсказывать бывшему владельцу, что ссылка «его»,
 * незачем.
 *
 * Повтор тем же человеком — не ошибка: нажатие START легко повторить,
 * и второй ответ должен быть тем же, а не отказом.
 */
export function inviteVerdict(
  row: InviteRow,
  telegramUserId: string,
  now: Date,
): InviteVerdict {
  if (row.revokedAt) return { kind: 'revoked' };
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'expired' };
  }
  if (row.userId) {
    return row.userId === telegramUserId
      ? { kind: 'repeat' }
      : { kind: 'taken' };
  }
  return { kind: 'activate' };
}
