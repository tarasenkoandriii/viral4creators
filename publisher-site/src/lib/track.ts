/**
 * Отправка событий `content_view`/`cta_click` (проектный документ §13.5,
 * контракт `EventBody` P-D; тест — `scripts/track.test.ts`).
 *
 * Транспорт — `navigator.sendBeacon` с `Blob` типа `text/plain` (JSON
 * внутри): межсайтовый `application/json` без preflight браузер не
 * отправит (аудит P2-24). Запасной путь — `fetch(…, {keepalive:true})` с
 * тем же `text/plain`. Ответ не читается: событие — не повод для ошибки на
 * странице. `lead_submit_success` сайт НЕ шлёт: его создаёт сервер в
 * транзакции приёма заявки.
 */
import { PUBLIC_API_PREFIX } from '@/brand';
import type { ClientEventName, ConsentState, EventBody } from './api-types';
import type { Attribution } from './attribution';

/** Лимит тела `POST /events` на сервере (`app.setup.ts`, P-A0). */
export const EVENT_MAX_BYTES = 2048;

export interface TrackConfig {
  apiOrigin: string;
  publicKey: string;
  consentState: ConsentState;
}

export function buildEvent(
  cfg: TrackConfig,
  name: ClientEventName,
  ctx: { path: string; contentSlug?: string; referrerHost?: string; attribution: Attribution },
  eventId: string,
  now: Date = new Date(),
): EventBody {
  const body: EventBody = {
    key: cfg.publicKey,
    eventId,
    name,
    path: ctx.path,
    consentState: cfg.consentState,
    clientAt: now.toISOString(),
  };
  if (ctx.contentSlug) body.contentSlug = ctx.contentSlug;
  if (ctx.referrerHost) body.referrerHost = ctx.referrerHost;
  if (ctx.attribution.placementCode) body.placementCode = ctx.attribution.placementCode;
  if (ctx.attribution.sessionRef) body.sessionRef = ctx.attribution.sessionRef;
  if (ctx.attribution.utm) body.utm = ctx.attribution.utm as Record<string, string>;
  return body;
}

/** Сериализация с запасом по лимиту: лишнее (метки, referrer) отбрасывается, а не режется посередине. */
export function serializeEvent(body: EventBody): string {
  let text = JSON.stringify(body);
  if (new TextEncoder().encode(text).length <= EVENT_MAX_BYTES) return text;
  const slim: EventBody = { ...body };
  delete slim.utm;
  delete slim.referrerHost;
  text = JSON.stringify(slim);
  return text;
}

export interface Transport {
  sendBeacon?: (url: string, data: Blob) => boolean;
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
}

/** Возвращает способ отправки: `beacon`, `fetch` или `none`. */
export function sendEvent(apiOrigin: string, body: EventBody, t: Transport): 'beacon' | 'fetch' | 'none' {
  const url = `${apiOrigin}${PUBLIC_API_PREFIX}/events`;
  const text = serializeEvent(body);
  try {
    if (t.sendBeacon && t.sendBeacon(url, new Blob([text], { type: 'text/plain' }))) return 'beacon';
  } catch {
    /* запасной путь ниже */
  }
  if (!t.fetch) return 'none';
  t.fetch(url, {
    method: 'POST',
    body: text,
    keepalive: true,
    credentials: 'omit',
    headers: { 'content-type': 'text/plain' },
  }).catch(() => undefined);
  return 'fetch';
}
