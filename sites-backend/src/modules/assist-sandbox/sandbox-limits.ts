/**
 * Лимиты песочницы — K3 (лендинг-ТЗ §6.3, ТЗ §3.1, контракт Э1 §8):
 *  - ключ «на IP»: IPv4 целиком, IPv6 — по префиксу /64 (у абонента IPv6
 *    миллиарды адресов: лимит по полному адресу обходится сменой адреса);
 *    в базе — только хеш с суточной солью (сырой IP не хранится нигде);
 *  - суточные счётчики `assist_daily_counters` — атомарно одним
 *    `INSERT … ON CONFLICT DO UPDATE … WHERE value + n <= cap RETURNING`:
 *    параллельные запросы не проскакивают лимит (приёмка C2);
 *  - денежный потолок публичных песочниц (ВКЛЮЧЁН всегда) и рубильник;
 *  - «запрещённые категории» доменов (минимальный список — до общего
 *    списка ядра с QA, лендинг-ТЗ §6.3).
 *
 * Счётчики пишет и роль assist_public (GRANT S/I/U в миграции Э1), поэтому
 * клиент — параметр, а SQL квалифицирован полностью (адаптер search_path
 * не ставит).
 */
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { createHmac } from 'crypto';
import { isIP } from 'net';
import { MICRO_USD, SANDBOX_LIMITS } from '../../config/assist-defaults';
import { hashIpWithDailySalt } from '../../shared/assist-chat-core';
import { matchesAllowedOrigin } from '../../shared/cors-origin-match';
import { registrableDomain } from '../site-core/hosts/host-normalize';

export type CounterScope =
  'sandbox-ip' | 'sandbox-domain' | 'sandbox-money' | 'sandbox-cabinet';

/** Ключ денежного счётчика — один на все публичные песочницы. */
export const PUBLIC_MONEY_KEY = 'public';

/** Метка HMAC соли IP (контракт Э1 §8: без нового секрета). */
export const SANDBOX_IP_HMAC_LABEL = 'v4c-sandbox-ip';

export type CounterDb = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

/** YYYY-MM-DD по UTC — сутки счётчиков. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** IPv6 → 8 групп по 4 hex (с IPv4 в хвосте — тоже). null — не IPv6. */
export function expandIPv6(ip: string): string[] | null {
  let s = ip.trim().toLowerCase().replace(/%.*$/, '');
  if (isIP(s) !== 6) return null;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    s =
      s.slice(0, -v4[1].length) +
      `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array<string>(fill).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, '0'));
}

/**
 * Ключ лимита: IPv4 как есть; IPv4-mapped IPv6 (`::ffff:a.b.c.d`) — как
 * IPv4 (иначе один адрес считался бы двумя ключами); IPv6 — /64.
 */
export function ipLimitKey(ip: string): string {
  const raw = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (isIP(raw) === 4) return raw;
  const groups = expandIPv6(raw);
  if (!groups) return `raw:${raw}`;
  const mapped =
    groups.slice(0, 5).every((g) => g === '0000') && groups[5] === 'ffff';
  if (mapped) {
    const a = parseInt(groups[6], 16);
    const b = parseInt(groups[7], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** Хеш ключа IP с суточной солью; null — нет ASSIST_SECRETS_KEY (песочница закрыта). */
export function sandboxIpHash(
  ip: string,
  env: NodeJS.ProcessEnv,
  now: Date,
): string | null {
  const key = env.ASSIST_SECRETS_KEY?.trim();
  if (!key) return null;
  const secret = createHmac('sha256', key)
    .update(SANDBOX_IP_HMAC_LABEL)
    .digest('hex');
  return hashIpWithDailySalt(ipLimitKey(ip), secret, now);
}

/** Рубильник публичной песочницы: открыта только явным `true`. */
export function publicSandboxEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ASSIST_SANDBOX_PUBLIC_ENABLED?.trim().toLowerCase() === 'true';
}

/** Суточный денежный потолок (µ$). Мусор в переменной — умолчание, не «без потолка». */
export function publicDailyCapMicroUsd(env: NodeJS.ProcessEnv): number {
  const raw = env.ASSIST_SANDBOX_PUBLIC_DAILY_CAP_USD;
  if (raw === undefined || raw.trim() === '') {
    return SANDBOX_LIMITS.public.dailyCapMicroUsdDefault;
  }
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) {
    return SANDBOX_LIMITS.public.dailyCapMicroUsdDefault;
  }
  return Math.round(usd * MICRO_USD);
}

/**
 * Origin лендинга (фильтр от чужих страниц в браузере, НЕ защита —
 * лендинг-ТЗ §6.3). Без Origin (не браузер) или без списка — пропуск:
 * стена — деньги и лимиты, а не этот заголовок.
 */
export function landingOriginAllowed(
  origin: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!origin) return true;
  const list = (env.ASSIST_LANDING_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return true;
  return matchesAllowedOrigin(origin, list);
}

/**
 * Атомарно прибавить `n` к счётчику, если не превысит `cap`. true —
 * прибавлено. Первая строка суток с n > cap не создаётся.
 */
export async function bumpCounter(
  db: CounterDb,
  scope: CounterScope,
  key: string,
  day: string,
  n: number,
  cap: number,
): Promise<boolean> {
  if (n > cap) return false;
  const rows = await db.$queryRaw<Array<{ value: bigint }>>(Prisma.sql`
    INSERT INTO "sites"."assist_daily_counters" ("scope", "key", "day", "value", "updatedAt")
    VALUES (${scope}, ${key}, ${day}, ${BigInt(n)}, now())
    ON CONFLICT ("scope", "key", "day") DO UPDATE
      SET "value" = "sites"."assist_daily_counters"."value" + EXCLUDED."value",
          "updatedAt" = now()
      WHERE "sites"."assist_daily_counters"."value" + EXCLUDED."value" <= ${BigInt(cap)}
    RETURNING "value"`);
  return rows.length === 1;
}

/** Поправка без условия (факт расхода, возврат резерва); не ниже нуля. */
export async function adjustCounter(
  db: CounterDb,
  scope: CounterScope,
  key: string,
  day: string,
  delta: number,
): Promise<void> {
  if (!delta) return;
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "sites"."assist_daily_counters" ("scope", "key", "day", "value", "updatedAt")
    VALUES (${scope}, ${key}, ${day}, ${BigInt(Math.max(delta, 0))}, now())
    ON CONFLICT ("scope", "key", "day") DO UPDATE
      SET "value" = GREATEST(0, "sites"."assist_daily_counters"."value" + ${BigInt(delta)}),
          "updatedAt" = now()`);
}

export async function readCounter(
  db: CounterDb,
  scope: CounterScope,
  key: string,
  day: string,
): Promise<number> {
  const rows = await db.$queryRaw<Array<{ value: bigint }>>(Prisma.sql`
    SELECT "value" FROM "sites"."assist_daily_counters"
    WHERE "scope" = ${scope} AND "key" = ${key} AND "day" = ${day}`);
  return rows.length ? Number(rows[0].value) : 0;
}

/**
 * Запрещённые категории (лендинг-ТЗ §6.3) — МИНИМУМ до общего списка ядра
 * с QA: доменные зоны взрослого контента/азарта и метки eTLD+1 целиком
 * (не подстрокой: «essex» — не «sex»). Публичные списки фишинга — Э3+
 * (запрос владельцу в отчёте K3).
 */
const BLOCKED_TLDS = ['xxx', 'adult', 'porn', 'sex', 'casino', 'bet', 'poker'];
const BLOCKED_LABEL_TOKENS = new Set([
  'porn',
  'porno',
  'xxx',
  'sex',
  'casino',
  'kazino',
  'betting',
  'escort',
]);

export function blockedCategory(host: string): string | null {
  const h = host.toLowerCase();
  const tld = h.split('.').pop() ?? '';
  if (BLOCKED_TLDS.includes(tld)) return 'tld';
  const domain = registrableDomain(h) ?? h;
  const label = domain.split('.')[0] ?? '';
  for (const token of label.split(/[-_]/)) {
    if (BLOCKED_LABEL_TOKENS.has(token)) return 'keyword';
  }
  return null;
}
