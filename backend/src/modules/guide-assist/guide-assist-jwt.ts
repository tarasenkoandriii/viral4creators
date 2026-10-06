/**
 * employee-JWT пользователя TMA для «Админки» помощника платформы (Э-С Ш6,
 * ТЗ помощника §5.1 «Скрипт в админке заказчика», §4-бис.8).
 *
 * Платформа проверяет: только `alg = HS256`, подпись за постоянное время,
 * `aud` = id сайта, `exp - iat ≤ 15 мин`, `iat` не из будущего, `sub` —
 * `[\p{L}\p{N}_.:@+-]{1,128}` (`sites-backend/.../identity-jwt.ts`). Здесь —
 * ровно такой токен и ничего сверх.
 *
 * ## `sub` — псевдоним с подписью, а не голый id пользователя
 *
 * Главный риск Ш6 (аудит §Ш6): «JWT пользователя TMA должен однозначно
 * мапиться на пользователя генератора; ошибка означает чужие факты».
 * Платформа возвращает `sub` нам заголовком `X-V4C-Actor` в каждом вызове
 * коннектора фактов. Если бы `sub` был голым `userId`, то любой, у кого
 * оказался ключ коннектора, читал бы факты ЛЮБОГО пользователя, подставив
 * чужой id. Поэтому `sub = g1.<userId>.<mac>`, где `mac` — HMAC-SHA256 от
 * `userId` ключом, выведенным из секрета подписи JWT (его нет ни у кого,
 * кроме нас и зашифрованной копии в кабинете платформы). Фактам нужен и
 * ключ коннектора, И подлинный `sub` — подделать второй без секрета JWT
 * нельзя. Заодно платформа не видит Telegram id и имени — только псевдоним.
 *
 * Ротация секрета JWT в кабинете меняет все `sub`: диалоги «Админки» (≤ 8 ч)
 * начнутся заново, статистика по сотрудникам — с новыми псевдонимами.
 *
 * Чистый модуль: ни Nest, ни базы.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { GUIDE_JWT_MAX_TTL_SEC } from './guide-assist-config';

export const GUIDE_ACTOR_PREFIX = 'g1';
/** 22 знака base64url = 132 бита подписи. */
const MAC_LEN = 22;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACTOR_RE = /^g1\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{22})$/;

/** Ключ подписи `sub` — выведен из секрета JWT (не сам секрет). */
function actorKey(jwtSecret: string): Buffer {
  return createHmac('sha256', jwtSecret).update('v4c-guide-actor-v1').digest();
}

function macOf(userId: string, jwtSecret: string): string {
  return createHmac('sha256', actorKey(jwtSecret))
    .update(userId)
    .digest('base64url')
    .slice(0, MAC_LEN);
}

/** Псевдоним сотрудника для `sub`. Бросает на id недопустимой формы. */
export function actorOf(userId: string, jwtSecret: string): string {
  if (!USER_ID_RE.test(userId)) {
    throw new Error('guide-assist: недопустимый id пользователя для sub');
  }
  return `${GUIDE_ACTOR_PREFIX}.${userId}.${macOf(userId, jwtSecret)}`;
}

/**
 * `X-V4C-Actor` → id пользователя генератора, или `null` (чужой формы,
 * чужая подпись, пусто). Сравнение подписи — за постоянное время.
 */
export function userIdOfActor(
  actor: string | null | undefined,
  jwtSecret: string,
): string | null {
  if (typeof actor !== 'string' || actor.length > 128) return null;
  const m = ACTOR_RE.exec(actor);
  if (!m) return null;
  const expected = Buffer.from(macOf(m[1], jwtSecret));
  const got = Buffer.from(m[2]);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return null;
  }
  return m[1];
}

export interface GuideJwtInput {
  userId: string;
  siteId: string;
  role: string;
  ttlSec: number;
  jwtSecret: string;
  nowMs?: number;
}

export interface GuideJwt {
  jwt: string;
  /** Секунды эпохи. */
  exp: number;
}

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

/**
 * Подписать employee-JWT. Имени в токене нет намеренно: платформе для
 * работы хватает псевдонима, а имя — лишние персональные данные в её
 * журнале и статистике (решение Р-Ш6-4).
 */
export function signGuideJwt(input: GuideJwtInput): GuideJwt {
  const iat = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const ttl = Math.min(GUIDE_JWT_MAX_TTL_SEC, Math.max(1, input.ttlSec));
  const exp = iat + ttl;
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    sub: actorOf(input.userId, input.jwtSecret),
    aud: input.siteId,
    role: input.role,
    iat,
    exp,
  });
  const sig = createHmac('sha256', input.jwtSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return { jwt: `${header}.${payload}.${sig}`, exp };
}
