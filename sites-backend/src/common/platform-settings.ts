/**
 * Настройки платформы из админки (ТЗ помощника §8 п.5, Э4): рубильник
 * виджета и суточный потолок платформы. Пишет внутренний API
 * (platform-admin), читает конвейер ответа под assist_public (колоночный
 * SELECT "key","value" на assist_platform_settings).
 *
 * env остаётся ВЕРХНЕЙ границей: `ASSIST_WIDGET_ENABLED=false` выключает
 * виджет независимо от админки, потолок из админки не может быть больше
 * `ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD` (аварийный рычаг — у владельца
 * деплоя, а не у учётки админки).
 *
 * Кэш в памяти инстанса — 30 с: переключатель действует быстро, а горячий
 * путь не делает лишнего запроса на каждое сообщение.
 */

import { MICRO_USD } from '../config/assist-defaults';

export const WIDGET_SETTINGS_KEY = 'widget';
export const SETTINGS_CACHE_MS = 30_000;

export interface WidgetPlatformSettings {
  /** false — все виджеты отвечают формой заявки (рубильник платформы). */
  enabled: boolean;
  /** Суточный потолок платформы, USD; null — как в env. */
  dailyCapUsd: number | null;
}

export const DEFAULT_WIDGET_SETTINGS: WidgetPlatformSettings = {
  enabled: true,
  dailyCapUsd: null,
};

interface RawQueryDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export function parseWidgetSettings(v: unknown): WidgetPlatformSettings {
  const o =
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  const cap = o.dailyCapUsd;
  return {
    enabled: o.enabled !== false,
    dailyCapUsd:
      typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? cap : null,
  };
}

let cache: { at: number; value: WidgetPlatformSettings } | null = null;

/** Сбросить кэш (тесты; запись из админки в этом же инстансе). */
export function resetPlatformSettingsCache(): void {
  cache = null;
}

export async function readWidgetPlatformSettings(
  db: RawQueryDb,
  now: number = Date.now(),
): Promise<WidgetPlatformSettings> {
  if (cache && now - cache.at < SETTINGS_CACHE_MS) return cache.value;
  let value = DEFAULT_WIDGET_SETTINGS;
  try {
    const rows = await db.$queryRawUnsafe<Array<{ value: unknown }>>(
      `SELECT "value" FROM "sites"."assist_platform_settings" WHERE "key" = $1`,
      WIDGET_SETTINGS_KEY,
    );
    value = rows[0]
      ? parseWidgetSettings(rows[0].value)
      : DEFAULT_WIDGET_SETTINGS;
  } catch {
    // Сбой чтения — умолчания (env решает), а не 500 на каждом сообщении.
    value = cache?.value ?? DEFAULT_WIDGET_SETTINGS;
  }
  cache = { at: now, value };
  return value;
}

/** Потолок платформы: env — верхняя граница, админка может только опустить. */
export function effectivePlatformCapMicroUsd(
  envCapMicroUsd: number,
  s: WidgetPlatformSettings,
): number {
  if (s.dailyCapUsd === null) return envCapMicroUsd;
  return Math.min(envCapMicroUsd, Math.round(s.dailyCapUsd * MICRO_USD));
}
