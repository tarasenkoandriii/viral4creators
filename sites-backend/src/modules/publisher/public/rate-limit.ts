/**
 * AI Publisher — лимиты публичного приёма (P-D, проектный документ §6.2
 * `pub_rate_hits`, §11.4; аудит P2-10; ТЗ §8.3 «до пяти попыток за десять
 * минут на технический источник запроса»).
 *
 * Запись (форма, события) — СКОЛЬЗЯЩЕЕ окно в `pub_rate_hits` под ролью
 * `publisher_public`: в транзакции приёма `pg_advisory_xact_lock` ключа,
 * подсчёт ударов за последние `windowSec` секунд, при запасе — вставка
 * удара. Стыка корзин нет (окно «последние 600 с», а не «текущие 10 мин»),
 * параллельные запросы одного источника сериализуются блокировкой, а откат
 * транзакции (сбой, ошибка) откатывает и удар — неудачная отправка лимит
 * не тратит.
 *
 * Ключ: `<productId>:<scope>:<ipKeyHmac>`, где `ipKeyHmac` = HMAC
 * (`ipLimitKey(ip)`, ключ связки `publisher-rate-ip-v1`) БЕЗ суточной соли
 * (соль сбрасывала бы окно в 00:00 UTC); сырой IP не хранится, строки
 * живут ≤ 1 ч (`rate-hits-sweep`). IPv6 — по /64, IPv4-mapped — как IPv4
 * («учитывать общие сети», ТЗ §8.3: лимит считает технический источник,
 * а не человека; у человека за общим NAT — альтернативный контакт).
 *
 * Чтение (`GET /site-config`, P-B1 `GET /contents*`) базу НЕ пишет:
 * скользящее окно в памяти экземпляра (`MemoryWindowLimiter`) — грубая
 * защита от перебора; ответы кэширует CDN (`s-maxage`).
 */
import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import { ipLimitKey } from '../../../common/ip-limit-key';
import type { DerivedKeys } from '../../../common/secrets-keyring';
import { rateIpHmac } from '../core/contact-crypto';

/** Области окна (часть ключа `pub_rate_hits.key`). */
export const RATE_SCOPES = {
  /** Новые отправки формы (параметр `form_limit`, умолчание 5 / 600 с). */
  form: 'form',
  /** События с IP (120 в минуту). */
  eventsIp: 'ev-ip',
  /** События одной сессии (30 в минуту). */
  eventsSession: 'ev-sr',
  /**
   * След ловушки `hp` (аудит P-D S3-5): строка без тела и без IP —
   * счётчик срабатываний за час (живёт до `rate-hits-sweep`).
   */
  trap: 'trap',
} as const;

/** Ключ следа ловушки продукта (без HMAC источника — только счётчик). */
export const trapKey = (productId: string): string =>
  `${productId}:${RATE_SCOPES.trap}:hp`;
export type RateScope = (typeof RATE_SCOPES)[keyof typeof RATE_SCOPES];

/** HMAC ключа источника запроса (IP → ipLimitKey → HMAC связки). */
export function ipKeyHmac(ip: string, keys: DerivedKeys): string {
  return rateIpHmac(ipLimitKey(ip), keys);
}

/**
 * Ключ окна. Для `eventsSession` вместо IP — sessionRef (тоже через HMAC:
 * в ключе окна нет ничего, что можно сопоставить с посетителем).
 */
export function rateKey(
  productId: string,
  scope: RateScope,
  sourceHmac: string,
): string {
  return `${productId}:${scope}:${sourceHmac}`;
}

export function sessionKeyHmac(sessionRef: string, keys: DerivedKeys): string {
  return createHmac('sha256', keys.currentKey)
    .update(`session\n${sessionRef}`, 'utf8')
    .digest('hex');
}

export type WindowResult =
  | { ok: true; count: number }
  | { ok: false; count: number; retryAfterSec: number };

/** Клиент транзакции с сырым SQL (`PublisherPublicDb` в `$transaction`). */
export interface RawTx {
  $queryRaw<T = unknown>(
    q: TemplateStringsArray | Prisma.Sql,
    ...v: unknown[]
  ): Promise<T>;
  $executeRaw(
    q: TemplateStringsArray | Prisma.Sql,
    ...v: unknown[]
  ): Promise<number>;
}

/** Строка `pg_advisory_xact_lock` по тексту ключа (64 бита). */
export async function lockKey(tx: RawTx, key: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS l`;
}

/**
 * Скользящее окно: «не больше `limit` ударов за последние `windowSec` с».
 * Вызывать ВНУТРИ транзакции приёма (удар откатывается вместе с ней).
 * `newId` — id строки удара (у таблицы нет DEFAULT для id).
 */
export async function slidingWindowHit(
  tx: RawTx,
  key: string,
  limit: number,
  windowSec: number,
  newId: string,
): Promise<WindowResult> {
  await lockKey(tx, key);
  const rows = await tx.$queryRaw<Array<{ n: number; wait: number | null }>>`
    SELECT count(*)::int AS "n",
           ceil(extract(epoch FROM (min("at") + make_interval(secs => ${windowSec}::int) - now())))::int AS "wait"
      FROM "sites"."pub_rate_hits"
     WHERE "key" = ${key} AND "at" > now() - make_interval(secs => ${windowSec}::int)`;
  const n = Number(rows[0]?.n ?? 0);
  if (n >= limit) {
    const wait = Number(rows[0]?.wait ?? windowSec);
    return {
      ok: false,
      count: n,
      retryAfterSec: Math.min(windowSec, Math.max(1, wait)),
    };
  }
  await tx.$executeRaw`
    INSERT INTO "sites"."pub_rate_hits" ("id", "key") VALUES (${newId}, ${key})`;
  return { ok: true, count: n + 1 };
}

/**
 * Скользящее окно в памяти экземпляра — для ЧТЕНИЙ (база не пишется).
 * Ключ — `ipLimitKey(ip)` (в памяти, наружу не уходит). Старые метки
 * выбрасываются при каждом обращении; ключей не больше `maxKeys`.
 */
export class MemoryWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  hit(ip: string, nowMs = Date.now()): WindowResult {
    const key = ipLimitKey(ip);
    const since = nowMs - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      const wait = Math.ceil((list[0] + this.windowMs - nowMs) / 1000);
      return {
        ok: false,
        count: list.length,
        retryAfterSec: Math.max(1, wait),
      };
    }
    list.push(nowMs);
    this.hits.delete(key);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return { ok: true, count: list.length };
  }

  reset(): void {
    this.hits.clear();
  }
}
