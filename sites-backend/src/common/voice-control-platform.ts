/**
 * Настройки ПЛАТФОРМЫ для голосового управления и выпусков виджета —
 * Э6-бис (г) (ТЗ помощника §5-бис.12 «канарейка», §5-бис.14 «рубильник
 * платформы»). Хранятся в `assist_platform_settings` (как рубильник
 * виджета Э4): пишут монитор Т-4 и внутренний API админки платформы
 * (основная роль), читает и публичный код (колоночный SELECT
 * "key","value" у assist_public — без новых прав).
 *
 *  - `voice-control` — рубильник голосового управления ВСЕЙ платформы:
 *    `{ enabled, reason, at }`. env `ASSIST_VOICE_CONTROL_ENABLED=false`
 *    остаётся верхней границей (аварийный рычаг владельца деплоя); здесь —
 *    то, что может выключить монитор (нарушение запрета на ≥ 2 сайтах за
 *    сутки — дефект нашего кода) или оператор, и включить обратно оператор.
 *  - `widget-release` — канарейка выпусков чанков виджета: `{ stable,
 *    canary, canaryPercent, canarySince, rolledBack }`. Сайт попадает в
 *    канарейку по хешу `siteId` (доля — `canaryPercent`, по умолчанию 10%);
 *    загрузчик берёт ленивые чанки, а кадр iframe — чат из
 *    `/v1/r/<выпуск>/`. Откат — `canary: null` (монитор: падение `done`
 *    > 10 п.п. или нарушение запрета на канарейке).
 *
 * Кэш в памяти инстанса — 30 с (как у рубильника виджета).
 */
import { createHash } from 'crypto';

export const VOICE_CONTROL_SETTINGS_KEY = 'voice-control';
export const WIDGET_RELEASE_KEY = 'widget-release';
const CACHE_MS = 30_000;

/** Имя выпуска: каталог `/v1/r/<имя>/` (дата и номер сборки). */
export const RELEASE_RE = /^[a-z0-9][a-z0-9.-]{0,23}$/;

interface RawQueryDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface VoiceControlPlatform {
  enabled: boolean;
  /** Почему выключено: violation_sites | operator | … (код, без ПД). */
  reason: string | null;
  at: string | null;
}

export interface WidgetRelease {
  stable: string | null;
  canary: string | null;
  canaryPercent: number;
  canarySince: string | null;
  rolledBack: { release: string; at: string; reason: string } | null;
}

export const DEFAULT_VC_PLATFORM: VoiceControlPlatform = {
  enabled: true,
  reason: null,
  at: null,
};

export const DEFAULT_RELEASE: WidgetRelease = {
  stable: null,
  canary: null,
  canaryPercent: 10,
  canarySince: null,
  rolledBack: null,
};

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

const code = (v: unknown) =>
  typeof v === 'string' && /^[a-z0-9_.:-]{1,40}$/.test(v) ? v : null;
const iso = (v: unknown) =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
const rel = (v: unknown) =>
  typeof v === 'string' && RELEASE_RE.test(v) ? v : null;

export function parseVoiceControlPlatform(v: unknown): VoiceControlPlatform {
  const o = obj(v);
  return {
    enabled: o.enabled !== false,
    reason: code(o.reason),
    at: iso(o.at),
  };
}

export function parseWidgetRelease(v: unknown): WidgetRelease {
  const o = obj(v);
  const pct = o.canaryPercent;
  const rb = obj(o.rolledBack);
  const stable = rel(o.stable);
  const canary = rel(o.canary);
  return {
    stable,
    // Канарейка без стабильного выпуска — некуда откатывать: не включается.
    canary: stable && canary !== stable ? canary : null,
    canaryPercent:
      typeof pct === 'number' && Number.isInteger(pct) && pct >= 1 && pct <= 50
        ? pct
        : 10,
    canarySince: iso(o.canarySince),
    rolledBack:
      rel(rb.release) && iso(rb.at) && code(rb.reason)
        ? {
            release: rel(rb.release) as string,
            at: iso(rb.at) as string,
            reason: code(rb.reason) as string,
          }
        : null,
  };
}

const cache = new Map<string, { at: number; value: unknown }>();

/** Сбросить кэш (тесты; запись монитором/админкой в этом же инстансе). */
export function resetVoiceControlPlatformCache(): void {
  cache.clear();
}

async function readKey<T>(
  db: RawQueryDb,
  key: string,
  parse: (v: unknown) => T,
  def: T,
  now: number,
): Promise<T> {
  const c = cache.get(key);
  if (c && now - c.at < CACHE_MS) return c.value as T;
  let value = def;
  try {
    const rows = await db.$queryRawUnsafe<Array<{ value: unknown }>>(
      `SELECT "value" FROM "sites"."assist_platform_settings" WHERE "key" = $1`,
      key,
    );
    value = rows[0] ? parse(rows[0].value) : def;
  } catch {
    value = (c?.value as T | undefined) ?? def;
  }
  cache.set(key, { at: now, value });
  return value;
}

/** `key` — только тесты (свой ключ, чтобы не задевать параллельные наборы). */
export function readVoiceControlPlatform(
  db: RawQueryDb,
  now: number = Date.now(),
  key: string = VOICE_CONTROL_SETTINGS_KEY,
): Promise<VoiceControlPlatform> {
  return readKey(db, key, parseVoiceControlPlatform, DEFAULT_VC_PLATFORM, now);
}

export function readWidgetRelease(
  db: RawQueryDb,
  now: number = Date.now(),
  key: string = WIDGET_RELEASE_KEY,
): Promise<WidgetRelease> {
  return readKey(db, key, parseWidgetRelease, DEFAULT_RELEASE, now);
}

/** Корзина сайта 0…99 по хешу `siteId` (та же для всех экземпляров). */
export function releaseBucket(siteId: string): number {
  return (
    parseInt(
      createHash('sha256').update(siteId).digest('hex').slice(0, 8),
      16,
    ) % 100
  );
}

/** Выпуск чанков для сайта: канарейка по хешу, иначе стабильный (null — `/v1/`). */
export function releaseForSite(
  siteId: string,
  r: WidgetRelease,
): string | null {
  if (r.canary && releaseBucket(siteId) < r.canaryPercent) return r.canary;
  return r.stable;
}

/** Запись настройки — основной ролью (монитор, админка платформы). */
export interface SettingsWriter {
  assistPlatformSetting: {
    upsert(args: {
      where: { key: string };
      create: { key: string; value: object; updatedBy: string };
      update: { value: object; updatedBy: string };
    }): Promise<unknown>;
  };
}

export async function writePlatformSetting(
  db: SettingsWriter,
  key: string,
  value: VoiceControlPlatform | WidgetRelease,
  by: string,
): Promise<void> {
  await db.assistPlatformSetting.upsert({
    where: { key },
    create: { key, value: value as object, updatedBy: by },
    update: { value: value as object, updatedBy: by },
  });
  cache.delete(key);
}
