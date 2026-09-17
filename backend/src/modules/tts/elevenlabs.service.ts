/**
 * ElevenLabsService — синтез речи (ТЗ §15.3, этап 35).
 *
 * Протокол взят из рабочего кода соседнего проекта владельца
 * (`blog.service.ts` в atm-travel): заголовок `xi-api-key`, POST на
 * `/v1/text-to-speech/{voice_id}` с `{text, model_id, output_format}` →
 * сразу байты mp3; каталог голосов — `/v1/shared-voices`. Это не догадки
 * о чужом API, а то, что там работает.
 *
 * ## Мягкий фоллбек — главное свойство этого класса
 *
 * Ключ не задан — не ошибка. Ролик у пользователя уже есть, говорит в нём
 * голос Veo, и продукт работает ровно как до этого этапа. Разница между
 * «не настроено» и «сломалось» проведена в типе ответа
 * (`skipped: true` против `skipped: false`), потому что показывать их
 * одинаково нечестно: первое — состояние стенда, второе — повод
 * разбираться.
 *
 * По той же причине здесь нет ни одного `throw`: единственный способ
 * уронить генерацию из-за необязательного улучшения — это бросить
 * исключение, и его тут просто нет.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  SynthesisOutcome,
  SynthesisRequest,
  TtsProvider,
  VoiceOption,
} from './tts.types';

/** Лимит одного запроса у мультиязычной модели — режем до него. */
const MAX_CHARACTERS = 5000;

/** М-6.5 седьмого аудита: таймаут внешних HTTP-вызовов. */
const EXTERNAL_TIMEOUT_MS = 60_000;

@Injectable()
export class ElevenLabsService implements TtsProvider {
  readonly providerKey = 'elevenlabs';
  private readonly logger = new Logger(ElevenLabsService.name);
  private readonly base = 'https://api.elevenlabs.io/v1';

  private key(): string | undefined {
    return process.env.VOICE_API_KEY?.trim() || undefined;
  }

  configured(): boolean {
    return !!this.key();
  }

  private defaultVoice(): string {
    // Тот же голос по умолчанию, что в проекте-референсе: нейтральный
    // женский из библиотеки. Бренд задаёт свой в манифесте (§12).
    return process.env.VOICE_ID?.trim() || 'EXAVITQu4vr4xnSDxMaL';
  }

  private defaultModel(): string {
    // `eleven_multilingual_v2` — украинский и русский поддерживаются, а
    // это рынки продукта. Меняется переменной окружения без деплоя.
    return process.env.VOICE_MODEL?.trim() || 'eleven_multilingual_v2';
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisOutcome> {
    const key = this.key();
    if (!key) {
      return {
        ok: false,
        skipped: true,
        reason: 'VOICE_API_KEY не задан — озвучка на этом стенде не подключена',
      };
    }

    const text = request.text?.trim() ?? '';
    if (!text) {
      return { ok: false, skipped: true, reason: 'пустой текст озвучки' };
    }
    // Обрезаем молча, но пишем в лог: молчаливая потеря последних фраз
    // была бы хуже, а падение ради восьмисекундного ролика — глупостью.
    const payloadText = text.slice(0, MAX_CHARACTERS);
    if (payloadText.length < text.length) {
      this.logger.warn(
        `текст озвучки обрезан до ${MAX_CHARACTERS} символов (было ${text.length})`,
      );
    }

    const voiceId = request.voiceId?.trim() || this.defaultVoice();
    const model = request.model?.trim() || this.defaultModel();

    // Этап 67 (субтитры для voiceover/dub): тот же запрос, но другой
    // путь и ответ — `/with-timestamps` отдаёт JSON с base64-аудио и
    // пословным выравниванием вместо сырых байт. Не все вызовы просят
    // тайминг (обычная озвучка без субтитров — самый частый случай), и
    // для них лишний JSON-конверт был бы бессмысленным накладным
    // расходом, поэтому путь выбирается запросом, а не всегда.
    const withTimestamps = request.timestamps === true;
    const path = withTimestamps
      ? `/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`
      : `/text-to-speech/${encodeURIComponent(voiceId)}`;

    // Язык реплик — явно. Без него модель угадывает язык по тексту и
    // нередко читает украинский с чужой просодией (ударения не на тех
    // слогах). `eleven_multilingual_v2` параметр игнорирует (документация
    // ElevenLabs) — для неё язык не шлём вовсе, чтобы не делать вид, что
    // он на что-то влияет.
    const languageCode = elevenLabsLanguageCode(request.language, model);

    try {
      const res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
        body: JSON.stringify({
          text: payloadText,
          model_id: model,
          output_format: 'mp3_44100_128',
          ...(languageCode ? { language_code: languageCode } : {}),
        }),
      });
      if (!res.ok) {
        // Тело ответа — в лог; в `reason`, который ложится в сессию и
        // виден пользователю, только код (этап 54, Б-3.6).
        const body = await res.text().catch(() => '');
        this.logger.warn(
          `ElevenLabs ответил ${res.status}: ${body.slice(0, 300)}`,
        );
        return {
          ok: false,
          skipped: false,
          reason: `ElevenLabs ${res.status}`,
        };
      }

      if (withTimestamps) {
        return this.parseTimestampedResponse(res, payloadText, voiceId, model);
      }

      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length === 0) {
        return {
          ok: false,
          skipped: false,
          reason: 'ElevenLabs вернул пустой файл',
        };
      }
      return {
        ok: true,
        audio,
        mimeType: 'audio/mpeg',
        characters: payloadText.length,
        voiceId,
        model,
      };
    } catch (e) {
      return {
        ok: false,
        skipped: false,
        reason: `ошибка ElevenLabs: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Разбор ответа `/with-timestamps`: `{audio_base64, normalized_alignment:
   * {characters, character_start_times_seconds, character_end_times_seconds}}`.
   * `normalized_alignment`, а не `alignment` — он синхронизирован с тем,
   * что провайдер РЕАЛЬНО произнёс после своей нормализации текста
   * (числа, сокращения), а не с исходной строкой запроса — именно это
   * нужно для субтитров, которые накладываются на готовое аудио.
   */
  private async parseTimestampedResponse(
    res: Response,
    payloadText: string,
    voiceId: string,
    model: string,
  ): Promise<SynthesisOutcome> {
    let data: {
      audio_base64?: string;
      normalized_alignment?: {
        characters?: string[];
        character_start_times_seconds?: number[];
        character_end_times_seconds?: number[];
      };
    };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      return {
        ok: false,
        skipped: false,
        reason: 'ElevenLabs вернул не-JSON на /with-timestamps',
      };
    }

    if (!data.audio_base64) {
      return {
        ok: false,
        skipped: false,
        reason: 'ElevenLabs не вернул audio_base64 на /with-timestamps',
      };
    }
    const audio = Buffer.from(data.audio_base64, 'base64');
    if (audio.length === 0) {
      return {
        ok: false,
        skipped: false,
        reason: 'ElevenLabs вернул пустой файл',
      };
    }

    const alignmentSource = data.normalized_alignment;
    const alignment =
      alignmentSource?.characters &&
      alignmentSource.character_start_times_seconds &&
      alignmentSource.character_end_times_seconds
        ? {
            characters: alignmentSource.characters,
            starts: alignmentSource.character_start_times_seconds,
            ends: alignmentSource.character_end_times_seconds,
          }
        : undefined;

    return {
      ok: true,
      audio,
      mimeType: 'audio/mpeg',
      characters: payloadText.length,
      voiceId,
      model,
      alignment,
    };
  }

  /**
   * Каталог голосов для выбора в манифесте. Пустой список с пояснением —
   * тоже ответ: у части тарифов библиотека закрыта, и «ничего не
   * нашлось» без причины оператор прочитает как поломку.
   */
  async voices(
    language?: string,
  ): Promise<{ voices: VoiceOption[]; error?: string }> {
    const key = this.key();
    if (!key) {
      return { voices: [], error: 'VOICE_API_KEY не задан' };
    }
    const params = new URLSearchParams({ page_size: '100' });
    if (language) params.set('language', language);
    try {
      const res = await fetch(`${this.base}/shared-voices?${params}`, {
        headers: { 'xi-api-key': key },
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      });
      if (!res.ok) {
        return {
          voices: [],
          error: `ElevenLabs ${res.status} при запросе списка голосов`,
        };
      }
      const data = (await res.json()) as {
        voices?: Array<Record<string, unknown>>;
      };
      const byId = new Map<string, VoiceOption>();
      for (const v of data.voices ?? []) {
        const id = String(v.voice_id ?? v.voiceId ?? '');
        if (!id || byId.has(id)) continue;
        byId.set(id, {
          voiceId: id,
          name: String(v.name ?? 'Голос'),
          previewUrl: (v.preview_url ?? v.previewUrl ?? null) as string | null,
          accent: (v.accent ?? null) as string | null,
        });
      }
      const voices = [...byId.values()];
      return voices.length
        ? { voices }
        : {
            voices: [],
            error:
              'ElevenLabs вернул 0 голосов — возможно, на вашем тарифе библиотека голосов закрыта',
          };
    } catch (e) {
      return {
        voices: [],
        error: `не удалось получить список голосов: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
  }
}

/**
 * ISO 639-1 для `language_code` ElevenLabs: `uk-UA`/`UK` → `uk`.
 * `undefined` — если языка нет, он не двухбуквенный или модель параметр
 * не поддерживает (`eleven_multilingual_v2`).
 */
export function elevenLabsLanguageCode(
  language: string | null | undefined,
  model: string,
): string | undefined {
  if (model.startsWith('eleven_multilingual_v2')) return undefined;
  const code = language?.trim().toLowerCase().split(/[-_]/)[0];
  return code && /^[a-z]{2}$/.test(code) ? code : undefined;
}
