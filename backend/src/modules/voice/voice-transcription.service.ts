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
}

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

@Injectable()
export class VoiceTranscriptionService {
  private readonly logger = new Logger(VoiceTranscriptionService.name);
  private readonly genai: GoogleGenAI | null;

  constructor(private readonly aiUsage: AiUsageService) {
    // Ключ передаётся SDK явно (этап 53, В-6.15).
    this.genai = geminiApiKey() ? createGeminiClient() : null;
  }

  async transcribe(
    audio: Buffer,
    mimeType: string,
    /** Чей это расход (ТЗ §26) — маршрут расшифровки идёт под идентичностью. */
    owner?: { userId?: string | null },
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
          { text: PROMPT },
        ],
      });
      await this.aiUsage.recordGemini(response, {
        operation: 'transcribe',
        model: MODEL,
        userId: owner?.userId ?? null,
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
