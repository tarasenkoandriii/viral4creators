/**
 * SonioxTtsService — синтез речи Soniox, четвёртый пункт «Озвучки по
 * умолчанию» рядом с ElevenLabs, Resemble и Veo (решение владельца
 * 29.09.2026: сильный русский и украинский). Формы API — `common/soniox.ts`.
 *
 * ## Чем отличается от соседей
 *
 * - **Язык — обязательное поле запроса**, а не SSML-обёртка, как у
 *   Resemble. Не передан явно — берётся по буквам текста
 *   (`detectLanguage`), и только если и это не вышло — русский.
 * - **Голос по умолчанию есть** — `SONIOX_TTS_VOICE` или `Maya` из
 *   справочника моделей; голоса Soniox работают на всех языках модели.
 *   У Resemble голоса по умолчанию нет, и синтез без выбранного голоса
 *   там пропускается; здесь — нет.
 * - **Пословного тайминга нет** в REST-ответе: `timestamps: true` —
 *   синтез без `alignment`, та же принятая деградация, что у
 *   провайдеров без тайминга (субтитры такого ролика — без тайминга).
 * - **Ответ — сырые байты mp3**, не JSON с base64.
 *
 * ## Граница честности
 *
 * Написано по документации 29.09.2026 без живого вызова; см.
 * `common/soniox.ts`. Ставка в `ai-pricing.ts` пересчитана из
 * опубликованных «≈ $0.70 за час речи» — ПРОВЕРИТЬ по первому счёту.
 */

import { Injectable, Logger } from '@nestjs/common';
import { mp3DurationSeconds } from '../../common/mp3-duration';
import { detectLanguage } from '../../common/voiceover';
import {
  SONIOX_DEFAULT_TTS_VOICE,
  SONIOX_API_BASE,
  SONIOX_TTS_BASE,
  SONIOX_TTS_MAX_CHARACTERS,
  SONIOX_TTS_MODEL,
  sonioxApiKey,
  sonioxLanguage,
} from '../../common/soniox';
import {
  SynthesisOutcome,
  SynthesisRequest,
  TtsProvider,
  VoiceOption,
} from './tts.types';

const EXTERNAL_TIMEOUT_MS = 60_000;

interface SonioxTtsModels {
  models?: Array<{
    id?: string;
    name?: string;
    languages?: Array<{ code?: string; name?: string }>;
    voices?: Array<{ id?: string; description?: string; gender?: string }>;
  }>;
}

/** Язык запроса: явный → по буквам текста → русский. Экспорт — для тестов. */
export function sonioxTtsLanguage(
  requested: string | null | undefined,
  text: string,
): string {
  return (
    sonioxLanguage(requested) ?? sonioxLanguage(detectLanguage(text)) ?? 'ru'
  );
}

@Injectable()
export class SonioxTtsService implements TtsProvider {
  readonly providerKey = 'soniox';
  private readonly logger = new Logger(SonioxTtsService.name);

  configured(): boolean {
    return !!sonioxApiKey();
  }

  defaultVoice(): string {
    return process.env.SONIOX_TTS_VOICE?.trim() || SONIOX_DEFAULT_TTS_VOICE;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisOutcome> {
    const key = sonioxApiKey();
    if (!key) {
      return {
        ok: false,
        skipped: true,
        reason:
          'SONIOX_API_KEY не задан — озвучка Soniox на этом стенде не подключена',
      };
    }
    const full = request.text?.trim() ?? '';
    if (!full)
      return { ok: false, skipped: true, reason: 'пустой текст озвучки' };

    const text = full.slice(0, SONIOX_TTS_MAX_CHARACTERS);
    if (text.length < full.length) {
      this.logger.warn(
        `текст озвучки обрезан до ${SONIOX_TTS_MAX_CHARACTERS} символов (было ${full.length})`,
      );
    }
    const voiceId = request.voiceId?.trim() || this.defaultVoice();
    const model = request.model?.trim() || SONIOX_TTS_MODEL;
    const language = sonioxTtsLanguage(request.language, text);

    try {
      const res = await fetch(`${SONIOX_TTS_BASE}/tts`, {
        method: 'POST',
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          language,
          voice: voiceId,
          audio_format: 'mp3',
          text,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          ok: false,
          skipped: false,
          reason: `Soniox TTS ответил ${res.status}: ${body.slice(0, 200)}`,
        };
      }
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length === 0) {
        return {
          ok: false,
          skipped: false,
          reason: 'Soniox вернул пустой файл',
        };
      }
      return {
        ok: true,
        audio,
        mimeType: 'audio/mpeg',
        characters: text.length,
        durationSeconds: mp3DurationSeconds(audio),
        voiceId,
        model,
      };
    } catch (e) {
      return {
        ok: false,
        skipped: false,
        reason: `ошибка Soniox TTS: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Каталог голосов — из справочника моделей. Голоса Soniox не привязаны
   * к языку (работают на всех языках модели), поэтому `language` лишь
   * проверяет, что модель этот язык знает: не знает — пустой список с
   * пояснением, а не голоса, которые прочтут текст чужой просодией.
   */
  async voices(
    language?: string,
  ): Promise<{ voices: VoiceOption[]; error?: string }> {
    const key = sonioxApiKey();
    if (!key) return { voices: [], error: 'SONIOX_API_KEY не задан' };
    try {
      // Справочник моделей живёт на API-хосте (`GET /v1/tts-models`,
      // operationId `get_tts_models` в openapi.yaml Soniox), а не на
      // хосте синтеза: прежний `tts-rt.soniox.com/tts/models` отвечал
      // ошибкой, и экран голоса отправителя на проде писал «Каталог
      // голосов Soniox не загрузился» (найдено в кадре обучалки
      // 01.10.2026).
      const res = await fetch(`${SONIOX_API_BASE}/tts-models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      });
      if (!res.ok) return { voices: [], error: `Soniox ответил ${res.status}` };
      return sonioxVoicesFrom((await res.json()) as SonioxTtsModels, language);
    } catch (e) {
      return {
        voices: [],
        error: `ошибка Soniox: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}

/** Разбор справочника моделей. Экспорт — для тестов. */
export function sonioxVoicesFrom(
  data: SonioxTtsModels,
  language?: string,
): { voices: VoiceOption[]; error?: string } {
  const model =
    data.models?.find((m) => (m.id ?? m.name) === SONIOX_TTS_MODEL) ??
    data.models?.[0];
  if (!model)
    return { voices: [], error: 'Soniox не вернул ни одной модели синтеза' };
  const lang = sonioxLanguage(language);
  if (
    lang &&
    !(model.languages ?? []).some((l) => sonioxLanguage(l.code) === lang)
  ) {
    return { voices: [], error: `модель Soniox не поддерживает язык ${lang}` };
  }
  return {
    voices: (model.voices ?? [])
      .filter(
        (v): v is { id: string; description?: string; gender?: string } =>
          !!v.id,
      )
      .map((v) => ({
        voiceId: v.id,
        name: v.gender ? `${v.id} (${v.gender})` : v.id,
        previewUrl: null,
        accent: v.description?.slice(0, 120) ?? null,
      })),
  };
}
