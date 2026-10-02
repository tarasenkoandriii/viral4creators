/**
 * Кабинет голоса виджета Э5 (ТЗ §3.5, §4.10) — повтор типов
 * `sites-backend/src/modules/assist-site-voice/api-types.ts` (сверку держит
 * scripts/voice-api.test.ts) и клиент `/assist/sites/:id/voice-config`.
 * Разбор строгий, как у остальных экранов виджета.
 */
import { ApiError, type ApiClient } from '../kit';
import { arr, obj, str, text } from './widget-api';

export interface VoiceConfig {
  schema: 1;
  input: boolean;
  output: boolean;
  voiceId: string | null;
}

export const VOICE_OFF_REASONS = [
  'platform_off',
  'no_provider',
  'plan',
  'site_off',
  'owner_off',
] as const;
export type VoiceOffReason = (typeof VOICE_OFF_REASONS)[number];

export interface VoiceSettingsView {
  siteId: string;
  config: VoiceConfig;
  available: boolean;
  reason: VoiceOffReason | null;
  voices: Array<{
    id: string;
    gender: string | null;
    description: string | null;
  }>;
  defaultVoice: string;
  dailyCapMicroUsd: number;
  todaySpentMicroUsd: number;
}

export const VOICE_CABINET_ERROR_CODES = [
  'VOICE_CONFIG_INVALID',
  'VOICE_PLAN_REQUIRED',
  'VOICE_UNAVAILABLE',
  'VOICE_LIMIT',
  'UPSTREAM',
] as const;
export type VoiceCabinetErrorCode = (typeof VOICE_CABINET_ERROR_CODES)[number];

/** Имя голоса провайдера — как VOICE_ID сервера. */
export const VOICE_ID = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

export function parseVoiceSettings(v: unknown): VoiceSettingsView {
  const o = obj(v);
  const c = obj(o.config);
  const id = str(c.voiceId);
  return {
    siteId: text(o.siteId),
    config: {
      schema: 1,
      input: c.input === true,
      output: c.output === true,
      voiceId: id && VOICE_ID.test(id) ? id : null,
    },
    available: o.available === true,
    reason: (VOICE_OFF_REASONS as readonly unknown[]).includes(o.reason)
      ? (o.reason as VoiceOffReason)
      : null,
    voices: arr(o.voices)
      .map((x) => obj(x))
      .filter((x) => typeof x.id === 'string' && VOICE_ID.test(x.id))
      .map((x) => ({
        id: x.id as string,
        gender: str(x.gender),
        description: str(x.description),
      })),
    defaultVoice:
      typeof o.defaultVoice === 'string' && VOICE_ID.test(o.defaultVoice)
        ? o.defaultVoice
        : '',
    dailyCapMicroUsd: num(o.dailyCapMicroUsd),
    todaySpentMicroUsd: num(o.todaySpentMicroUsd),
  };
}

/** Код ошибки голоса → ключ словаря; иначе null (общий перевод ошибок). */
export function voiceErrorCode(e: unknown): VoiceCabinetErrorCode | null {
  return e instanceof ApiError &&
    (VOICE_CABINET_ERROR_CODES as readonly string[]).includes(e.code)
    ? (e.code as VoiceCabinetErrorCode)
    : null;
}

/** $ с двумя знаками из микродолларов. */
export function usd(micro: number): string {
  return (micro / 1_000_000).toFixed(2);
}

export interface VoiceApi {
  get(siteId: string): Promise<VoiceSettingsView>;
  save(siteId: string, config: VoiceConfig): Promise<VoiceSettingsView>;
  /** Пример голоса: mp3 байтами (сервер отдаёт base64 в конверте). */
  sample(
    siteId: string,
    voiceId: string | null,
    lang: 'uk' | 'ru' | 'en'
  ): Promise<{ mime: string; bytes: Uint8Array<ArrayBuffer> }>;
}

const SEG = /^[A-Za-z0-9_-]{1,64}$/;
function seg(id: string): string {
  if (!SEG.test(id)) throw new Error('bad id');
  return id;
}

export function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function createVoiceApi(client: ApiClient): VoiceApi {
  const p = (id: string) => `/assist/sites/${seg(id)}/voice-config`;
  return {
    get: async (id) => parseVoiceSettings(await client.request('GET', p(id))),
    save: async (id, config) =>
      parseVoiceSettings(await client.request('PATCH', p(id), { config })),
    sample: async (id, voiceId, lang) => {
      const o = obj(
        await client.request('POST', `${p(id)}/sample`, { voiceId, lang })
      );
      const mime = text(o.mime);
      const data = text(o.dataBase64);
      if (
        !/^audio\/[a-z0-9.+-]+$/.test(mime) ||
        !/^[A-Za-z0-9+/=]+$/.test(data)
      )
        throw new Error('bad sample');
      return { mime, bytes: decodeBase64(data) };
    },
  };
}
