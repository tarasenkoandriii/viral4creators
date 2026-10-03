/**
 * employee-JWT заказчика (ТЗ §5.1, 7b): бэкенд заказчика подписывает HS256
 * секретом сайта (выпущен в TMA, показан один раз), поля `sub` (id
 * сотрудника у заказчика), `role`, `name`, `exp ≤ 15 мин`, `aud = siteId`.
 * Это тот же приём, что identity verification чат-виджетов: без подписи
 * бэкенда заказчика любой посетитель мог бы назваться админом.
 *
 * Проверка строгая и закрытая: только `alg = HS256` (никаких `none`, RS256,
 * «алгоритм из заголовка»), подпись сравнивается за постоянное время,
 * `exp` обязателен и не дальше 15 минут (+ допуск часов), `aud` — ровно
 * этот сайт, `iat` не из будущего. Любое сомнение — отказ с кодом (без
 * текста токена в ошибке и в логе).
 *
 * Чистый модуль: ни базы, ни Nest.
 */
import { createHmac, timingSafeEqual } from 'crypto';

/** Максимальный срок жизни JWT (§5.1). */
export const IDENTITY_MAX_TTL_SEC = 15 * 60;
/** Допуск расхождения часов бэкенда заказчика и нашего. */
export const IDENTITY_CLOCK_SKEW_SEC = 60;
const MAX_TOKEN_LEN = 4096;

export type IdentityRejectCode =
  | 'malformed'
  | 'alg'
  | 'signature'
  | 'expired'
  | 'ttl_too_long'
  | 'not_yet_valid'
  | 'audience'
  | 'claims';

export class IdentityJwtError extends Error {
  constructor(readonly code: IdentityRejectCode) {
    super(`employee-JWT отклонён: ${code}`);
    this.name = 'IdentityJwtError';
  }
}

export interface EmployeeIdentity {
  sub: string;
  role: string | null;
  name: string | null;
  /** Секунды эпохи. */
  iat: number;
  exp: number;
}

function b64urlJson(part: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new IdentityJwtError('malformed');
  try {
    const o = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (o === null || typeof o !== 'object' || Array.isArray(o)) {
      throw new IdentityJwtError('malformed');
    }
    return o as Record<string, unknown>;
  } catch (e) {
    if (e instanceof IdentityJwtError) throw e;
    throw new IdentityJwtError('malformed');
  }
}

const SUB_RE = /^[\p{L}\p{N}_.:@+\-]{1,128}$/u;
const ROLE_RE = /^[\p{L}\p{N}_.:\-]{1,64}$/u;

/** Проверить JWT сотрудника для сайта `siteId`. Бросает IdentityJwtError. */
export function verifyEmployeeJwt(
  token: string,
  secret: string,
  siteId: string,
  nowMs: number = Date.now(),
): EmployeeIdentity {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LEN
  ) {
    throw new IdentityJwtError('malformed');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdentityJwtError('malformed');
  const header = b64urlJson(parts[0]);
  if (header.alg !== 'HS256') throw new IdentityJwtError('alg');
  if (header.typ !== undefined && header.typ !== 'JWT') {
    throw new IdentityJwtError('malformed');
  }
  // `crit` (RFC 7515 §4.1.11): расширений мы не понимаем — обязаны отказать.
  // `jku`/`jwk`/`x5u`/`x5c` — ключ из токена не берём никогда (аудит Э7).
  for (const k of ['crit', 'jku', 'jwk', 'x5u', 'x5c']) {
    if (header[k] !== undefined) throw new IdentityJwtError('alg');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(parts[2])) {
    throw new IdentityJwtError('signature');
  }
  const expected = createHmac('sha256', secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new IdentityJwtError('signature');
  }
  const p = b64urlJson(parts[1]);
  const now = Math.floor(nowMs / 1000);
  const exp = p.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new IdentityJwtError('claims');
  }
  if (exp <= now - IDENTITY_CLOCK_SKEW_SEC)
    throw new IdentityJwtError('expired');
  const iat = p.iat === undefined ? now : p.iat;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) {
    throw new IdentityJwtError('claims');
  }
  if (iat > now + IDENTITY_CLOCK_SKEW_SEC) {
    throw new IdentityJwtError('not_yet_valid');
  }
  if (
    exp - iat > IDENTITY_MAX_TTL_SEC ||
    exp > now + IDENTITY_MAX_TTL_SEC + IDENTITY_CLOCK_SKEW_SEC
  ) {
    throw new IdentityJwtError('ttl_too_long');
  }
  if (
    p.nbf !== undefined &&
    (typeof p.nbf !== 'number' || !Number.isFinite(p.nbf))
  ) {
    throw new IdentityJwtError('claims');
  }
  if (typeof p.nbf === 'number' && p.nbf > now + IDENTITY_CLOCK_SKEW_SEC) {
    throw new IdentityJwtError('not_yet_valid');
  }
  const aud = p.aud;
  const audOk =
    (typeof aud === 'string' && aud === siteId) ||
    (Array.isArray(aud) && aud.length === 1 && aud[0] === siteId);
  if (!audOk) throw new IdentityJwtError('audience');
  if (typeof p.sub !== 'string' || !SUB_RE.test(p.sub)) {
    throw new IdentityJwtError('claims');
  }
  const role =
    typeof p.role === 'string' && ROLE_RE.test(p.role) ? p.role : null;
  const name =
    typeof p.name === 'string'
      ? p.name
          .replace(/[\u0000-\u001f\u007f]/g, '')
          .trim()
          .slice(0, 100) || null
      : null;
  return { sub: p.sub, role, name, iat, exp };
}

/**
 * Подпись — для тестов и для примера в TMA («так подписывает ваш бэкенд»).
 * В проде JWT выписывает ТОЛЬКО бэкенд заказчика.
 */
export function signEmployeeJwt(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = createHmac('sha256', secret).update(`${h}.${b}`).digest();
  return `${h}.${b}.${s.toString('base64url')}`;
}

/** Ссылка на сотрудника в наших таблицах: только `sub`, без имени. */
export function employeeRefOfSub(sub: string): string {
  return `jwt:${sub}`;
}
