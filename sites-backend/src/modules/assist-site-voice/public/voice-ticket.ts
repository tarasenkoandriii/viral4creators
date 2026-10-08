/**
 * «Билет голоса» — ЧИСТЫЙ модуль (Э5, ТЗ §4.10, §7.1 Р-58).
 *
 * Зачем. Распознавание (`POST /widget/v1/voice`) отдаёт текст, а вопрос
 * уходит обычным `POST /widget/v1/chat` (§4.10: «дальше обычный чат»).
 * Диалог с голосом стоит 2 единицы — значит, сервер должен знать, что ЭТОТ
 * вопрос пришёл голосом, а не верить флагу клиента. Билет — HMAC над
 * (сайт, посетитель, хеш текста, срок): чат засчитывает вес 2, только если
 * подпись сошлась и текст вопроса тот же, что распознан.
 *
 * Подделать билет посетитель не может (ключ на сервере), «потерять» — может:
 * тогда диалог посчитается за 1, хотя распознавание уже оплачено и списано
 * с денег дня сайта и голоса. Выгоды посетителю в этом нет (единицы — не
 * его), а владелец переплатит ровно 0 — поэтому так.
 *
 * Формат: `v1.<exp секунды>.<sig base64url>`; подпись — над
 * `v1|siteId|visitorId|sha256(текст)|exp`. Текст сравнивается после того же
 * обрезания пробелов, что делает чат.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { hmacKeyList, type HmacKeys } from '../../../common/secrets-keyring';

const TICKET = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

function textHash(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('base64url');
}

function sign(
  key: Buffer,
  p: { siteId: string; visitorId: string; text: string; exp: number },
): string {
  return createHmac('sha256', key)
    .update(`v1|${p.siteId}|${p.visitorId}|${textHash(p.text)}|${p.exp}`)
    .digest('base64url');
}

export function issueVoiceTicket(
  key: Buffer,
  p: {
    siteId: string;
    visitorId: string;
    text: string;
    now: Date;
    ttlMs: number;
  },
): string {
  const exp = Math.floor((p.now.getTime() + p.ttlMs) / 1000);
  return `v1.${exp}.${sign(key, { ...p, exp })}`;
}

/** true — билет наш, этого посетителя этого сайта, на этот текст и не истёк. */
export function verifyVoiceTicket(
  key: HmacKeys | null,
  ticket: unknown,
  p: { siteId: string; visitorId: string; text: string; now: Date },
): boolean {
  if (!key || typeof ticket !== 'string') return false;
  const m = TICKET.exec(ticket);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp * 1000 <= p.now.getTime()) return false;
  const got = Buffer.from(m[2]);
  // №60: текущим и прежними ключами связки (`voiceTicketKeys`).
  return hmacKeyList(key).some((k) => {
    const want = Buffer.from(sign(k, { ...p, exp }));
    return want.length === got.length && timingSafeEqual(want, got);
  });
}
