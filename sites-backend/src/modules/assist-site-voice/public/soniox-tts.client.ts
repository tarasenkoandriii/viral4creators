import { SonioxObservability } from '../../soniox-observability/soniox-observability.service';
/**
 * Озвучка ответа — Soniox TTS (Э5, ТЗ помощника §4.10 «Вывод», §7.2: для
 * массового виджета — самый дешёвый провайдер с приемлемым украинским,
 * Soniox TTS ≈ $14 / M символов; ElevenLabs — только дополнением, В-6).
 * Формы API — `shared/soniox.ts` (копия генератора); механика — как у
 * `backend/src/modules/tts/soniox-tts.service.ts`: язык — обязательное поле,
 * голос по умолчанию есть, ответ — сырые байты mp3.
 *
 * Отличия от генератора: `fetch` — полем (тесты), в лог — только код ответа
 * (§6.6), каталог голосов кэшируется в памяти экземпляра на час (кабинет
 * зовёт его при каждом открытии экрана персоны).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  SONIOX_API_BASE,
  SONIOX_TTS_BASE,
  SONIOX_TTS_MAX_CHARACTERS,
  SONIOX_TTS_MODEL,
  sonioxApiKey,
  sonioxLanguage,
} from '../../../shared/soniox';
import { defaultTtsVoice } from '../../../config/voice-env';

export interface SiteTtsRequest {
  text: string;
  voice: string | null;
  lang: string | null;
}

export type SiteTtsResult =
  | {
      ok: true;
      audio: Buffer;
      mime: 'audio/mpeg';
      characters: number;
      voice: string;
      lang: string;
      model: string;
    }
  | { ok: false; reason: 'no_key' | 'empty' | 'error' };

export interface VoiceChoice {
  id: string;
  gender: string | null;
  description: string | null;
}

// Complete response audio may take longer than the catalogue request.
export const SONIOX_TTS_TIMEOUT_MS = 60_000;
const CATALOG_TIMEOUT_MS = 20_000;
const CATALOG_TTL_MS = 60 * 60 * 1000;

/** Язык синтеза: явный → по буквам текста → украинский (рынок — Украина). */
export function ttsLanguage(requested: string | null, text: string): string {
  const explicit = sonioxLanguage(requested);
  if (explicit) return explicit;
  if (/[іїєґІЇЄҐ]/.test(text)) return 'uk';
  if (/[ыэъёЫЭЪЁ]/.test(text)) return 'ru';
  if (/[а-яА-Я]/.test(text)) return 'uk';
  if (/[a-zA-Z]/.test(text)) return 'en';
  return 'uk';
}

interface TtsModels {
  models?: Array<{
    id?: string;
    name?: string;
    voices?: Array<{ id?: string; description?: string; gender?: string }>;
  }>;
}

@Injectable()
export class SiteSonioxTts {
  private readonly logger = new Logger(SiteSonioxTts.name);
  constructor(@Optional() private readonly telemetry?: SonioxObservability) {}
  fetch: typeof fetch = (...a) => fetch(...a);
  env: NodeJS.ProcessEnv = process.env;
  private catalog: { at: number; voices: VoiceChoice[] } | null = null;

  configured(): boolean {
    return !!sonioxApiKey(this.env);
  }

  model(): string {
    return SONIOX_TTS_MODEL;
  }

  /** Модель счёта в ai-pricing (`soniox-tts`). */
  pricingModel(): string {
    return 'soniox-tts';
  }

  defaultVoice(): string {
    return defaultTtsVoice(this.env);
  }

  async synthesize(req: SiteTtsRequest): Promise<SiteTtsResult> {
    return this.telemetry
      ? this.telemetry.track('tts', 'system', () => this.synthesizeImpl(req))
      : this.synthesizeImpl(req);
  }
  private async synthesizeImpl(req: SiteTtsRequest): Promise<SiteTtsResult> {
    const key = sonioxApiKey(this.env);
    if (!key) return { ok: false, reason: 'no_key' };
    const text = req.text.trim().slice(0, SONIOX_TTS_MAX_CHARACTERS);
    if (!text) return { ok: false, reason: 'empty' };
    const voice = req.voice?.trim() || this.defaultVoice();
    const lang = ttsLanguage(req.lang, text);
    try {
      const res = await this.fetch(`${SONIOX_TTS_BASE}/tts`, {
        method: 'POST',
        signal: AbortSignal.timeout(SONIOX_TTS_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: SONIOX_TTS_MODEL,
          language: lang,
          voice,
          audio_format: 'mp3',
          text,
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Soniox TTS ответил ${res.status}`);
        return { ok: false, reason: 'error' };
      }
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length === 0) return { ok: false, reason: 'error' };
      return {
        ok: true,
        audio,
        mime: 'audio/mpeg',
        characters: text.length,
        voice,
        lang,
        model: SONIOX_TTS_MODEL,
      };
    } catch (e) {
      this.logger.warn(
        `Soniox TTS не удался: ${e instanceof Error ? e.name : typeof e}`,
      );
      return { ok: false, reason: 'error' };
    }
  }

  /** Голоса модели (справочник `GET /v1/tts-models`); ошибка — пустой список. */
  async voices(now: number = Date.now()): Promise<VoiceChoice[]> {
    return this.telemetry
      ? this.telemetry.track('catalog', 'system', () => this.voicesImpl(now))
      : this.voicesImpl(now);
  }
  private async voicesImpl(now: number): Promise<VoiceChoice[]> {
    if (this.catalog && now - this.catalog.at < CATALOG_TTL_MS) {
      return this.catalog.voices;
    }
    const key = sonioxApiKey(this.env);
    if (!key) return [];
    try {
      const res = await this.fetch(`${SONIOX_API_BASE}/tts-models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`Soniox tts-models ответил ${res.status}`);
        return [];
      }
      const voices = voicesFrom((await res.json()) as TtsModels);
      this.catalog = { at: now, voices };
      return voices;
    } catch (e) {
      this.logger.warn(
        `Soniox tts-models не удался: ${e instanceof Error ? e.name : typeof e}`,
      );
      return [];
    }
  }
}

/** Разбор справочника: модель синтеза по id, иначе первая. Экспорт — тестам. */
export function voicesFrom(data: TtsModels): VoiceChoice[] {
  const model =
    data.models?.find((m) => (m.id ?? m.name) === SONIOX_TTS_MODEL) ??
    data.models?.[0];
  return (model?.voices ?? [])
    .filter(
      (v): v is { id: string; description?: string; gender?: string } =>
        typeof v.id === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(v.id),
    )
    .map((v) => ({
      id: v.id,
      gender: typeof v.gender === 'string' ? v.gender.slice(0, 20) : null,
      description:
        typeof v.description === 'string' ? v.description.slice(0, 120) : null,
    }));
}
