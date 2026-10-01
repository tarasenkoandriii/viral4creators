/**
 * visitor-token (ТЗ §4.13 п.2) — ЧИСТЫЙ модуль, W2: HMAC-SHA256 (ключ —
 * widgetTokenKey() из ASSIST_SECRETS_KEY) над { v:1, siteId, visitorId,
 * parentOrigin, ipHash, iat, exp (24 ч), preview? }; base64url(payload).sig.
 * Сравнение подписи — timingSafeEqual. Токен — в памяти и sessionStorage
 * iframe, заголовок WIDGET_VISITOR_TOKEN_HEADER (не cookie).
 *
 * iat/exp — секунды Unix (как JWT). Разбор строгий: лишнее или не того типа
 * поле — «не токен» (подпись своя, но схему держим всё равно — старый код
 * не должен принять токен будущей версии за свой).
 */
import { createHmac, timingSafeEqual } from 'crypto';

export interface VisitorTokenPayload {
  v: 1;
  siteId: string;
  visitorId: string;
  parentOrigin: string;
  ipHash: string;
  /** Сессия предпросмотра (без расхода квоты). */
  preview: boolean;
  iat: number;
  exp: number;
}

/** Длиннее не бывает (origin ≤ 300, id ≤ 64, хеш 64) — дальше не разбираем. */
const MAX_TOKEN_CHARS = 2048;
/** Часы экземпляров расходятся — «выдан в будущем» терпим на минуту. */
const IAT_SKEW_S = 60;

function sign(payloadB64: string, key: Buffer): string {
  return createHmac('sha256', key).update(payloadB64).digest('base64url');
}

export function signVisitorToken(p: VisitorTokenPayload, key: Buffer): string {
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      siteId: p.siteId,
      visitorId: p.visitorId,
      parentOrigin: p.parentOrigin,
      ipHash: p.ipHash,
      preview: p.preview,
      iat: p.iat,
      exp: p.exp,
    }),
  ).toString('base64url');
  return `${body}.${sign(body, key)}`;
}

function shortString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function parsePayload(raw: unknown): VisitorTokenPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'exp,iat,ipHash,parentOrigin,preview,siteId,v,visitorId') {
    return null;
  }
  if (o.v !== 1) return null;
  if (
    !shortString(o.siteId, 64) ||
    !shortString(o.visitorId, 64) ||
    !shortString(o.parentOrigin, 300) ||
    !shortString(o.ipHash, 128) ||
    typeof o.preview !== 'boolean' ||
    !Number.isSafeInteger(o.iat) ||
    !Number.isSafeInteger(o.exp)
  ) {
    return null;
  }
  return o as unknown as VisitorTokenPayload;
}

export type VisitorTokenCheck =
  | { status: 'ok'; payload: VisitorTokenPayload }
  | { status: 'expired' }
  | { status: 'invalid' };

/**
 * Разбор с причиной: маршрутам нужно отличить «нет/битый токен»
 * (SESSION_REQUIRED) от «истёк» (SESSION_EXPIRED — iframe молча берёт
 * новый по resumeKey). Срок проверяется только у токена с верной подписью.
 */
export function inspectVisitorToken(
  token: string | undefined | null,
  key: Buffer,
  now: Date,
): VisitorTokenCheck {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) {
    return { status: 'invalid' };
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { status: 'invalid' };
  }
  const [body, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) {
    return { status: 'invalid' };
  }
  const expected = Buffer.from(sign(body, key));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    return { status: 'invalid' };
  }
  let payload: VisitorTokenPayload | null;
  try {
    payload = parsePayload(
      JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
    );
  } catch {
    return { status: 'invalid' };
  }
  if (!payload) return { status: 'invalid' };
  const nowS = Math.floor(now.getTime() / 1000);
  if (payload.iat > nowS + IAT_SKEW_S || payload.exp <= payload.iat) {
    return { status: 'invalid' };
  }
  if (payload.exp <= nowS) return { status: 'expired' };
  return { status: 'ok', payload };
}

/** null — подпись, формат или срок не годятся (никаких подробностей наружу). */
export function verifyVisitorToken(
  token: string,
  key: Buffer,
  now: Date,
): VisitorTokenPayload | null {
  const r = inspectVisitorToken(token, key, now);
  return r.status === 'ok' ? r.payload : null;
}
