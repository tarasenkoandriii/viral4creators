/**
 * Кабинет «Пригласить» — «Условно бесплатный Lite» §7, этап 133.
 *
 * Пока в ответе половина кабинета: сколько генераций осталось и чем
 * открывается стена. Приглашения и лестница приедут этапом 134 в ЭТОТ
 * ЖЕ ответ — экран не должен собираться из двух запросов.
 */

import { api } from './api';
import { clearReferralCode, storedReferralCode } from '../lib/referral';

export interface InviteeView {
  joinedAt: string;
  counted: boolean;
}

export interface InviteState {
  /** Стена включена. Выключена — условий пока нет, и экран это говорит. */
  wallEnabled: boolean;
  generationsAvailable: number;
  unlocked: boolean;
  subscription: {
    confirmed: boolean;
    confirmedKind: string | null;
    telegramChannel: string | null;
  };
  referrals: {
    code: string;
    target: number;
    funnel: { visited: number; identified: number; generated: number };
    invitees: InviteeView[];
  };
}

export async function getInviteState(): Promise<InviteState> {
  const res = await api.get<InviteState>('/referrals/me');
  if (!res.data) throw new Error('Пустой ответ: invite state');
  return res.data;
}

/**
 * Привязать себя к пригласившему — сразу после первой идентификации.
 *
 * Ответ намеренно беден: «не применился» может означать чужой код,
 * повторную привязку или самоприглашение, и ни об одном из этих случаев
 * человеку говорить нечего.
 */
export async function claimReferral(code: string): Promise<boolean> {
  const res = await api.post<{ claimed: boolean }>('/referrals/claim', {
    code,
  });
  return res.data?.claimed === true;
}

/**
 * Применить запомненный код — если он есть и если человек уже вошёл.
 *
 * Зовётся из ДВУХ мест, и это не перестраховка (находка аудита этапа
 * 134). Первая редакция звала привязку только при старте приложения. В
 * мини-аппе этого достаточно — там человек опознан с первого кадра. В
 * браузере он входит ПОЗЖЕ, у кнопки «Сгенерировать», и привязка,
 * сделанная до входа, отвечала 401 и не повторялась до следующего
 * запуска. А до следующего запуска его первый ролик успевал
 * завершиться — то есть момент, который единственный засчитывает
 * приглашение, проходил, когда привязки ещё не было. Приглашение
 * терялось насовсем, и тише всего именно у тех, кто пришёл с лендинга.
 *
 * Идемпотентна: код стирается после первой применённой попытки, а
 * сервер и без того держит «первое касание» уникальностью.
 */
export async function claimStoredReferral(): Promise<void> {
  const code = storedReferralCode();
  if (!code) return;
  try {
    await claimReferral(code);
    clearReferralCode();
  } catch {
    // 401 — ещё не вошёл; всё остальное — сеть. Код оставляем: он
    // пригодится следующей попытке, их теперь две.
  }
}

export async function confirmTelegramSubscription(): Promise<InviteState> {
  const res = await api.post<InviteState>('/referrals/telegram/check', {});
  if (!res.data) throw new Error('Пустой ответ: telegram check');
  return res.data;
}

/**
 * Четыре события кабинета (§12.2 ТЗ) — открыл, скопировал, поделился,
 * упёрся в стену.
 *
 * Отправка «выстрелил и забыл»: телеметрия наблюдает за продуктом, а не
 * ведёт человека, и её сбой не должен ни задерживать экран, ни рисовать
 * на нём ошибку. Поэтому не `await` у вызывающего и `.catch()` здесь.
 *
 * Тела с идентификаторами нет: маршрут открытый и пишет в таблицу, где
 * их не бывает (`wizard_step_events`).
 */
export type InviteEventStep = 'cabinet' | 'copy' | 'share' | 'wall';

export function recordInviteEvent(step: InviteEventStep): void {
  void api.post('/referrals/events', { steps: [step] }).catch(() => {
    // Сеть, блокировщик, выключенный бэкенд — событие просто не
    // запишется.
  });
}
