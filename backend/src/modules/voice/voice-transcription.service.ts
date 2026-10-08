/**
 * VoiceTranscriptionService — spoken product description → text.
 * doc/PRODUCT-PROJECT-SPEC.md §4 Экран 4, §6.2 (decided: Gemini audio
 * input, no new service/key); Stage 5 of the plan.
 *
 * Gemini takes the recording as an `inlineData` audio part next to a
 * plain-text instruction — there is no dedicated transcription endpoint,
 * transcription IS a prompt (ai.google.dev/gemini-api/docs/audio). Every
 * container a browser MediaRecorder can produce is on Gemini's supported
 * list: audio/webm (Chrome, Telegram Android WebView), audio/mp4 & m4a
 * (iOS Safari), audio/ogg & opus (Firefox, Telegram voice), plus
 * wav/mp3/aac/flac — so no server-side transcoding step is needed.
 * Inline request cap is 20 MB total; we cap the recording at 15 MB.
 *
 * Never throws (same contract as the Lens and recognition services):
 * voice is a way to FILL the description field, not a gate (§4 Экран 4,
 * §7.4) — on failure the user simply types. Returns `{ text: null,
 * reason }`.
 */

import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { createGeminiClient, geminiApiKey } from '../../common/gemini-client';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { GEMINI_MODEL } from '../../common/gemini-model';
import type { AiOperation } from '../../common/ai-pricing';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import {
  SPEECH_RECOGNITION_PROVIDER_SETTING_KEY,
  resolveSpeechRecognitionProvider,
} from '../../common/speech-recognition-provider';
import { SonioxSttClient } from './soniox-stt.client';

/** Gemini's documented audio MIME list ∩ what browsers actually record. Exported for the DTO. */
export const ALLOWED_AUDIO_MIME = [
  'audio/webm',
  'audio/ogg',
  'audio/opus',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/flac',
] as const;

export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

const MODEL = GEMINI_MODEL;

/**
 * The instruction is about a PRODUCT description: keep the speaker's
 * words, drop fillers, fix obvious dictation slips, never invent facts.
 * Language is whatever was spoken — the seller may dictate in Ukrainian,
 * Russian, Polish, English…
 */
const PROMPT =
  'Это голосовая заметка продавца — описание товара для карточки/рекламы. ' +
  'Расшифруй речь в чистый связный текст на ТОМ ЖЕ языке, на котором говорит человек. ' +
  'Убери междометия, повторы и оговорки, поправь пунктуацию, но НЕ добавляй ничего, ' +
  'чего не было сказано, и не пересказывай своими словами. Если речи нет или её ' +
  'невозможно разобрать — верни пустую строку. Ответ — только текст расшифровки, ' +
  'без кавычек, заголовков и пояснений.';

export interface TranscriptionResult {
  /** Cleaned transcript; null when nothing usable came back. */
  text: string | null;
  reason?: string;
  /**
   * Язык, на котором говорили, — только от провайдера, который определяет
   * его по звуку (Soniox). У Gemini поля нет: угадывать язык по буквам
   * расшифровки — не то же самое, и подменять одно другим нельзя.
   */
  language?: string | null;
  /** Длительность звука по данным провайдера, мс (Soniox); у Gemini нет. */
  durationMs?: number | null;
}

/**
 * Причина «запись длиннее допустимого» — по длительности, которую сообщил
 * провайдер (`recognize`, опция `maxDurationMs`). Текст при этом не
 * отдаётся: его платный разбор не нужен.
 */
export const AUDIO_TOO_LONG_REASON = 'audio too long';

/**
 * Причина «запасной путь не пущен»: Soniox не справился, а потолок
 * расхода к этому моменту уже исчерпан (`recognize`, опция `canFallback`).
 */
export const FALLBACK_REFUSED_REASON = 'fallback refused by spend limits';

/** Normalise the model's reply — exported for tests. */
export function cleanTranscript(raw: string | undefined): string | null {
  const text = String(raw ?? '')
    .replace(/^```[a-z]*\n?|```$/gi, '')
    .trim()
    // a model occasionally wraps the whole answer in quotes despite the prompt
    .replace(/^["«“](.*)["»”]$/s, '$1')
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * MediaRecorder reports e.g. "audio/webm;codecs=opus" — strip parameters
 * for the whitelist check and for what we send to Gemini. Exported for
 * the DTO validator.
 */
export function baseMime(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * Причины, означающие «речи нет», а не «провайдер сломался». Экспорт —
 * для сервиса поздравления: он различает «не расслышал» и «недоступно»
 * по тем же строкам.
 */
export const SPEECHLESS_REASONS: readonly string[] = [
  'empty audio',
  'no speech recognised',
];

export function isSpeechlessReason(reason: string | undefined): boolean {
  return !!reason && SPEECHLESS_REASONS.includes(reason);
}

@Injectable()
export class VoiceTranscriptionService {
  private readonly logger = new Logger(VoiceTranscriptionService.name);
  private readonly genai: GoogleGenAI | null;

  constructor(
    private readonly aiUsage: AiUsageService,
    private readonly settings: PlatformSettingsService,
    private readonly soniox: SonioxSttClient,
  ) {
    // Ключ передаётся SDK явно (этап 53, В-6.15).
    this.genai = geminiApiKey() ? createGeminiClient() : null;
  }

  async transcribe(
    audio: Buffer,
    mimeType: string,
    /** Чей это расход (ТЗ §26) — маршрут расшифровки идёт под идентичностью. */
    owner?: { userId?: string | null },
  ): Promise<TranscriptionResult> {
    // Язык продавца заранее неизвестен — подсказок нет, Soniox определит
    // сам. Soniox отдаёт речь дословно, без чистки междометий, которую
    // просит инструкция Gemini: для описания товара это приемлемо —
    // поле редактируемое, а распознаётся точнее.
    return this.recognize(audio, mimeType, {
      geminiPrompt: PROMPT,
      languageHints: [],
      operation: 'transcribe',
      userId: owner?.userId ?? null,
    });
  }

  /**
   * Расшифровка активным провайдером (админка → «Распознавание речи»).
   *
   * Выбран Soniox, но ключа на стенде нет — расшифровывает Gemini, с
   * предупреждением в лог. Голосовой ввод — способ заполнить поле, а не
   * барьер (шапка файла): «выбрали провайдера без ключа» не должно
   * превращаться в «микрофон перестал работать у всех».
   */
  async recognize(
    audio: Buffer,
    mimeType: string,
    opts: {
      /** Инструкция для Gemini; Soniox инструкций не читает. */
      geminiPrompt: string;
      languageHints: readonly string[];
      /** Имена и прочие слова, которые должны распознаться буква в букву. */
      terms?: ReadonlyArray<string | null | undefined>;
      /** Повтор после ответа латиницей. У Gemini строгость — в самой инструкции. */
      strictLanguage?: boolean;
      operation: AiOperation;
      userId?: string | null;
      sessionId?: string | null;
      /**
       * Потолок длительности, мс. Провайдер сообщил длительность больше —
       * `AUDIO_TOO_LONG_REASON` без текста и без запасного пути.
       */
      maxDurationMs?: number;
      /**
       * Можно ли платить за запасной Gemini после сбоя Soniox — те же
       * потолки, что перед первой попыткой (финальный аудит ветки K):
       * первый вызов уже оплачен, и между ним и вторым лимит мог кончиться.
       */
      canFallback?: () => Promise<boolean>;
    },
  ): Promise<TranscriptionResult> {
    // Настройка из БД — единственное, что здесь может бросить. Голосовой
    // ввод обещан «никогда не бросает» (шапка файла), и отказ чтения
    // настройки не должен превращаться в «микрофон сломан»: читаем как
    // «ничего не выбрано» — умолчание (Soniox с 07.10.2026, Р-З8-14; без
    // ключа — Gemini ниже) (сквозной аудит голоса 29.09.2026).
    const stored = await this.settings
      .get(SPEECH_RECOGNITION_PROVIDER_SETTING_KEY)
      .catch((e: unknown) => {
        this.logger.warn(
          `распознавание: настройка провайдера не прочиталась (${e instanceof Error ? e.message : String(e)}) — умолчание`,
        );
        return null;
      });
    const provider = resolveSpeechRecognitionProvider(stored);
    if (provider === 'soniox') {
      if (this.soniox.configured()) {
        const r = await this.soniox.transcribe({
          audio,
          mimeType: baseMime(mimeType),
          languageHints: opts.languageHints,
          strictLanguage: opts.strictLanguage,
          terms: opts.terms,
        });
        // Расход — по факту созданной задачи, а не по наличию текста:
        // тишина и ошибка у Soniox тоже оплачены (аудит 29.09.2026).
        if (r.billable) {
          await this.aiUsage.record({
            operation: opts.operation,
            model: 'soniox-stt-async',
            seconds: r.seconds,
            userId: opts.userId ?? null,
            ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
          });
        }
        const durationMs = r.audioMs ?? null;
        // Длительность — в ответ, только если провайдер её сообщил.
        const withDuration = durationMs !== null ? { durationMs } : {};
        if (
          opts.maxDurationMs !== undefined &&
          durationMs !== null &&
          durationMs > opts.maxDurationMs
        ) {
          return { text: null, reason: AUDIO_TOO_LONG_REASON, durationMs };
        }
        if (r.text) {
          return {
            text: r.text,
            language: r.language ?? null,
            ...withDuration,
          };
        }
        // «Не услышал» — это ответ, а не сбой: Gemini ту же тишину
        // не расслышит, а платить второй раз незачем.
        if (isSpeechlessReason(r.reason)) {
          return { text: null, reason: r.reason, ...withDuration };
        }
        if (opts.canFallback && !(await opts.canFallback())) {
          this.logger.warn(
            `распознавание: Soniox не справился (${r.reason ?? 'без причины'}), а потолок расхода исчерпан — Gemini не зовём`,
          );
          return {
            text: null,
            reason: FALLBACK_REFUSED_REASON,
            ...withDuration,
          };
        }
        this.logger.warn(
          `распознавание: Soniox не справился (${r.reason ?? 'без причины'}) — расшифровывает Gemini`,
        );
      } else {
        this.logger.warn(
          'распознавание: выбран Soniox, но SONIOX_API_KEY не задан — расшифровывает Gemini',
        );
      }
    }
    return this.transcribeWith(audio, mimeType, {
      prompt: opts.geminiPrompt,
      operation: opts.operation,
      userId: opts.userId,
      sessionId: opts.sessionId,
    });
  }

  /**
   * Та же расшифровка со своей инструкцией и своей строкой расхода.
   *
   * Заведено под голосовой ввод поздравления (этап K2 ТЗ Greeting 2.0,
   * §4А.3): там нужна ДОСЛОВНАЯ расшифровка с подсказками языка и имён, а
   * не «чистый связный текст» описания товара. Транспорт при этом
   * обязан остаться одним — `inlineData`, звук внутри запроса: Условия
   * (пункт 3.4, редакция 2026-09-29) обещают, что запись не остаётся у
   * ИИ-провайдера, и держит это обещание ровно эта строка. Второй
   * метод с собственным вызовом модели был бы вторым местом, где его
   * можно нарушить; шов `check-docs.mjs` смотрит на модуль целиком.
   */
  async transcribeWith(
    audio: Buffer,
    mimeType: string,
    opts: {
      prompt: string;
      operation: AiOperation;
      userId?: string | null;
      sessionId?: string | null;
    },
  ): Promise<TranscriptionResult> {
    if (!this.genai) {
      return { text: null, reason: 'GEMINI_API_KEY not set' };
    }
    if (audio.length === 0) {
      return { text: null, reason: 'empty audio' };
    }
    try {
      const response = await this.genai.models.generateContent({
        model: MODEL,
        contents: [
          {
            inlineData: {
              mimeType: baseMime(mimeType),
              data: audio.toString('base64'),
            },
          },
          { text: opts.prompt },
        ],
      });
      await this.aiUsage.recordGemini(response, {
        operation: opts.operation,
        model: MODEL,
        userId: opts.userId ?? null,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      });
      const text = cleanTranscript(response?.text);
      return text ? { text } : { text: null, reason: 'no speech recognised' };
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'gemini error';
      this.logger.error(`transcription failed: ${reason}`);
      return { text: null, reason };
    }
  }
}
