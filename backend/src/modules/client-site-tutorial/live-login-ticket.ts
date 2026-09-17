/**
 * Квитанция живого входа — §7.4.4/§7.4.5 ТЗ
 * (doc/CLIENT-SITE-TUTORIAL-SPEC.md), этап 114.
 *
 * ## Какую дыру она закрывает
 *
 * §7.4.5 описывает завершение так: фронтенд зовёт
 * `POST .../live-login/complete { sessionId }`, backend идёт к реле за
 * куками и кладёт их в черновик. Буквальная реализация означает, что
 * `sessionId` ПРИХОДИТ ОТ КЛИЕНТА и ничем не связан с черновиком:
 * подставив чужой идентификатор (а он — обычный UUID, который сосед
 * видит у себя на экране), пользователь запишет ЧУЖИЕ куки, то есть
 * чужую живую сессию к чужому кабинету, в СВОЙ черновик. Это не
 * теоретический риск — это прямой межпользовательский увод сессии.
 *
 * ## Почему квитанция, а не колонка в БД
 *
 * Очевидная альтернатива — запомнить выданный `sessionId` на строке
 * черновика и сверять с присланным. Это правильно по сути, но стоит
 * миграции и записи в БД на каждый старт, причём записи, конфликтующей
 * с оптимистичной блокировкой по `version` (старт живого входа сам по
 * себе черновик не меняет). Квитанция даёт ту же гарантию без единого
 * байта состояния: `sessionId` уезжает клиенту ЗАШИФРОВАННЫМ вместе с
 * идентификатором черновика и сроком годности, и `complete` берёт
 * `sessionId` из расшифрованной квитанции, а не из тела запроса.
 * Подделать её нельзя (AES-256-GCM, тот же ключ и тот же шифровальщик,
 * что у кук и кред), подставить чужую — тоже: внутри записан ЕЁ
 * черновик.
 *
 * Тот же приём, что у `fixture-token.ts` по духу: не про личность
 * пользователя вообще, только «есть право завершить эту конкретную
 * сессию этого конкретного черновика в ближайшие N минут».
 */

import { decryptToken, encryptToken } from '../../common/token-crypto';

/** Чуть больше потолка самой сессии на реле (3 минуты стены) плюс
 * запас на то, чтобы человек успел нажать «Готово». Меньше — и
 * квитанция протухала бы раньше сессии; заметно больше — и она жила бы
 * дольше, чем что-либо, что ею можно открыть. */
export const LIVE_TICKET_TTL_MS = 10 * 60 * 1000;

export class LiveTicketError extends Error {}

interface TicketPayload {
  s: string;
  d: string;
  e: number;
}

export function issueLiveTicket(
  input: { sessionId: string; draftId: string },
  key: string,
  now: Date = new Date(),
): string {
  const payload: TicketPayload = {
    s: input.sessionId,
    d: input.draftId,
    e: now.getTime() + LIVE_TICKET_TTL_MS,
  };
  return encryptToken(JSON.stringify(payload), key);
}

/**
 * Возвращает `sessionId` — или бросает. Три причины отказа намеренно
 * дают РАЗНЫЙ текст: «квитанция не читается» это почти всегда смена
 * ключа на стенде, «истекла» — обычная жизнь, а «от другого черновика»
 * — единственный случай, который вообще не должен встречаться у
 * честного клиента.
 */
export function readLiveTicket(
  ticket: string,
  expect: { draftId: string },
  key: string,
  now: Date = new Date(),
): string {
  let payload: TicketPayload;
  try {
    payload = JSON.parse(decryptToken(ticket, key)) as TicketPayload;
  } catch {
    throw new LiveTicketError(
      'квитанция живого входа не читается — начните вход заново',
    );
  }
  if (
    typeof payload?.s !== 'string' ||
    typeof payload?.d !== 'string' ||
    typeof payload?.e !== 'number'
  ) {
    throw new LiveTicketError(
      'квитанция живого входа повреждена — начните вход заново',
    );
  }
  if (payload.d !== expect.draftId) {
    throw new LiveTicketError(
      'квитанция живого входа выдана для другого черновика',
    );
  }
  if (payload.e <= now.getTime()) {
    throw new LiveTicketError(
      'квитанция живого входа истекла — начните вход заново',
    );
  }
  return payload.s;
}
