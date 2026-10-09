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
 *
 * №113 (заход 11, Р-З11-Б8): если Soniox распознал часть слов неуверенно,
 * билет — `v2.<exp>.<спаны>.<sig>`: спаны `start-len` (≤ 3, через `_`) —
 * места этих слов В САМОМ тексте (сам текст в билет не кладётся), подпись —
 * над `v2|…|exp|спаны`. Записать их в кандидаты терминов может только тот,
 * кто знает назначение текста: команда без значений полей (план) или вопрос
 * чата при совпадении со словарём сайта; само распознавание не пишет ничего.
 * Билет непрозрачен для виджета (≤ 200 символов) — старые бандлы работают.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { hmacKeyList, type HmacKeys } from '../../../common/secrets-keyring';

const TICKET = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const TICKET2 =
  /^v2\.(\d{1,12})\.(\d{1,4}-\d{1,2}(?:_\d{1,4}-\d{1,2}){0,2})\.([A-Za-z0-9_-]{43})$/;

/** Место неуверенного слова в тексте (символы, после `trim`). */
export interface TicketSpan {
  start: number;
  len: number;
}

function textHash(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('base64url');
}

function sign(
  key: Buffer,
  p: {
    siteId: string;
    visitorId: string;
    text: string;
    exp: number;
    spans?: string;
  },
): string {
  const head = p.spans ? 'v2' : 'v1';
  const tail = p.spans ? `|${p.spans}` : '';
  return createHmac('sha256', key)
    .update(
      `${head}|${p.siteId}|${p.visitorId}|${textHash(p.text)}|${p.exp}${tail}`,
    )
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
    /** (заход 11) Неуверенные слова в тексте — билет v2. */
    spans?: readonly TicketSpan[];
  },
): string {
  const exp = Math.floor((p.now.getTime() + p.ttlMs) / 1000);
  const t = p.text.trim();
  const spans = (p.spans ?? [])
    .filter(
      (s) =>
        Number.isInteger(s.start) &&
        Number.isInteger(s.len) &&
        s.start >= 0 &&
        s.start <= 9999 &&
        s.len > 0 &&
        s.len <= 99 &&
        s.start + s.len <= t.length,
    )
    .slice(0, 3)
    .map((s) => `${s.start}-${s.len}`)
    .join('_');
  return spans
    ? `v2.${exp}.${spans}.${sign(key, { ...p, exp, spans })}`
    : `v1.${exp}.${sign(key, { ...p, exp, spans: undefined })}`;
}

/**
 * Билет наш, этого посетителя этого сайта, на этот текст и не истёк — тогда
 * неуверенные слова из спанов (v1 — пусто); иначе null.
 */
export function readVoiceTicket(
  key: HmacKeys | null,
  ticket: unknown,
  p: { siteId: string; visitorId: string; text: string; now: Date },
): { spans: string[] } | null {
  if (!key || typeof ticket !== 'string') return null;
  const m1 = TICKET.exec(ticket);
  const m2 = m1 ? null : TICKET2.exec(ticket);
  if (!m1 && !m2) return null;
  const exp = Number((m1 ?? m2)![1]);
  if (exp * 1000 <= p.now.getTime()) return null;
  const spans = m2 ? m2[2] : undefined;
  const got = Buffer.from(m1 ? m1[2] : m2![3]);
  // №60: текущим и прежними ключами связки (`voiceTicketKeys`).
  const ok = hmacKeyList(key).some((k) => {
    const want = Buffer.from(sign(k, { ...p, exp, spans }));
    return want.length === got.length && timingSafeEqual(want, got);
  });
  if (!ok) return null;
  const t = p.text.trim();
  const words: string[] = [];
  for (const part of spans ? spans.split('_') : []) {
    const [a, b] = part.split('-').map(Number);
    if (a + b <= t.length) words.push(t.slice(a, a + b));
  }
  return { spans: words };
}

/** true — билет наш, этого посетителя этого сайта, на этот текст и не истёк. */
export function verifyVoiceTicket(
  key: HmacKeys | null,
  ticket: unknown,
  p: { siteId: string; visitorId: string; text: string; now: Date },
): boolean {
  return readVoiceTicket(key, ticket, p) !== null;
}
