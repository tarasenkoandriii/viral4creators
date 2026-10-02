/**
 * Доступен ли голос виджета сайту — ОДНО решение для конфига виджета
 * (`GET /widget/v1/config` → поле `voice`), маршрутов `POST /widget/v1/voice`
 * и `/tts` и кабинета (Э5, ТЗ §4.10, §7.1, §7.3).
 *
 * Голос есть, только если ВСЁ сразу: рубильник голоса платформы не выключен
 * (ASSIST_VOICE_ENABLED), ключ провайдера задан, тариф кабинета включает
 * голос (Business+, `assistPlanAllows(…, 'voice')`), владелец включил
 * микрофон/озвучку (`voiceConfig`), чат сайта не на паузе и не заблокирован.
 * Суточный потолок голоса и единицы — НЕ здесь: они решаются атомарно в
 * момент запроса (резерв денег, доплата единиц), конфиг кэшируется 5 минут.
 */
import {
  assistPlanAllows,
  type AssistPlanId,
} from '../../assist-billing/plans';
import {
  voiceConfigOf,
  voiceDailyCapMicroUsd,
  type VoiceConfig,
} from '../voice-config';

export type VoiceOffReason =
  'platform_off' | 'no_provider' | 'plan' | 'site_off' | 'owner_off';

export interface VoiceAccess {
  input: boolean;
  output: boolean;
  /** Голос озвучки владельца; null — по умолчанию (env/провайдер). */
  voiceId: string | null;
  /** Суточный потолок голоса сайта, микродоллары. */
  capMicroUsd: number;
  /** Почему выключено (кабинет показывает владельцу); null — что-то включено. */
  reason: VoiceOffReason | null;
  config: VoiceConfig;
}

export interface VoiceAccessInput {
  platformEnabled: boolean;
  providerConfigured: boolean;
  planId: AssistPlanId | null;
  siteActive: boolean;
  voiceConfig: unknown;
  capOverrideMicroUsd: number | null;
}

/** Чистое решение (тесты — таблицей случаев). */
export function voiceAccess(p: VoiceAccessInput): VoiceAccess {
  const config = voiceConfigOf(p.voiceConfig);
  const capMicroUsd = voiceDailyCapMicroUsd(p.capOverrideMicroUsd, p.planId);
  const off = (reason: VoiceOffReason): VoiceAccess => ({
    input: false,
    output: false,
    voiceId: config.voiceId,
    capMicroUsd,
    reason,
    config,
  });
  if (!p.platformEnabled) return off('platform_off');
  if (!p.providerConfigured) return off('no_provider');
  if (!p.planId || !assistPlanAllows(p.planId, 'voice')) return off('plan');
  if (!p.siteActive) return off('site_off');
  if (!config.input && !config.output) return off('owner_off');
  return {
    input: config.input,
    output: config.output,
    voiceId: config.voiceId,
    capMicroUsd,
    reason: null,
    config,
  };
}

/** Колонки сайта, нужные решению (роль assist_public их читает). */
export interface VoiceSiteRow {
  enabled: boolean;
  chatPaused: boolean;
  operatorBlockedAt: Date | null;
  voiceConfig: unknown;
  voiceDailyCapMicroUsd: number | null;
}

export interface VoiceSiteDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export async function readVoiceSiteRow(
  db: VoiceSiteDb,
  siteId: string,
): Promise<VoiceSiteRow | null> {
  const rows = await db.$queryRawUnsafe<VoiceSiteRow[]>(
    `SELECT "enabled", "chatPaused", "operatorBlockedAt", "voiceConfig", "voiceDailyCapMicroUsd"
       FROM "sites"."assist_sites" WHERE "siteId" = $1`,
    siteId,
  );
  return rows[0] ?? null;
}
