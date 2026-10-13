import { setTimeout as delay } from 'node:timers/promises';
/**
 * Стрим ответа модели для виджета — W3 (ТЗ §4.5: `gemini-3.6-flash` =
 * GEMINI_MODEL). GeminiText (site-ai, Э1) стрима не умеет — здесь только
 * открытие `generateContentStream` с сигналом отмены; таймауты, разделитель
 * действий и токены — runChatStream (shared/assist-chat-core).
 *
 * Тело ошибки провайдера наружу и в лог не идёт (§6.6) — только класс.
 * Тесты подменяют `useClient` (фейковая/«злая» модель, без сети).
 *
 * `maxOutputTokens` запроса — размер ВИДИМОГО ответа: провайдеру уходит
 * `geminiOutputCeiling` (+ запас на размышления, site-ai/gemini-output.ts).
 * Обрыв по потолку виден только здесь: runChatStream (shared, копия
 * backend) смотрит на текст и usageMetadata, а `finishReason` кусков не
 * читает. Поэтому `openStream` по желанию заполняет `StreamFinish` —
 * вызывающий после конца стрима решает, что делать с обрезанным ответом
 * (посетитель уже получил часть текста — протокол виджета не меняется).
 */
import { Injectable } from '@nestjs/common';
import type { GoogleGenAI } from '@google/genai';
import {
  toGeminiContent,
  type ModelStreamChunk,
} from '../../shared/assist-chat-core';
import { siteGeminiClient } from '../site-ai/dev-fake-gemini';
import { GEMINI_MODEL } from '../../shared/gemini-model';
import {
  providerErrorStatus,
  providerQuotaDiagnostic,
} from '../../common/provider-error-status';
import {
  GEMINI_FINISH_MAX_TOKENS,
  geminiOutputCeiling,
} from '../site-ai/gemini-output';

export interface ChatModelRequest {
  system: string;
  contents: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Размер ВИДИМОГО ответа; провайдеру — `geminiOutputCeiling` от него. */
  maxOutputTokens: number;
  temperature?: number;
}

/** Часть SDK, которой пользуемся (подменяется в тестах). */
export type ChatModelClient = Pick<GoogleGenAI, 'models'>;

/**
 * Чем закончился стрим: заполняется по ходу, читать — после конца стрима.
 * Без текста ответа (в лог/trace можно целиком).
 */
export interface StreamFinish {
  /** `candidates[0].finishReason` последнего куска, где он был. */
  reason: string | null;
  /** `usageMetadata.thoughtsTokenCount` последнего куска с usageMetadata. */
  thoughts: number;
}

export function newStreamFinish(): StreamFinish {
  return { reason: null, thoughts: 0 };
}

/** Ответ упёрся в потолок выхода — текст оборван на полуслове. */
export function streamTruncated(f: StreamFinish): boolean {
  return f.reason === GEMINI_FINISH_MAX_TOKENS;
}

type SdkChunk = ModelStreamChunk & {
  candidates?: Array<{ finishReason?: unknown }>;
};

/**
 * Пропускает куски как есть, попутно запоминая finishReason и мысли.
 * Экспорт — для фейковой модели стендов (тот же путь, что у SDK).
 */
export async function* watchFinish(
  stream: AsyncIterable<SdkChunk>,
  finish: StreamFinish,
): AsyncGenerator<ModelStreamChunk> {
  for await (const chunk of stream) {
    const reason = chunk.candidates?.[0]?.finishReason;
    if (reason) finish.reason = String(reason);
    if (chunk.usageMetadata) {
      finish.thoughts = chunk.usageMetadata.thoughtsTokenCount ?? 0;
    }
    yield chunk;
  }
}

@Injectable()
export class SiteChatModel {
  private client: ChatModelClient | null = null;

  get model(): string {
    return GEMINI_MODEL;
  }

  /** Клиент — при первом вызове: без ключа сервис всё равно стартует. */
  protected getClient(): ChatModelClient {
    this.client ??= siteGeminiClient();
    return this.client;
  }

  useClient(client: ChatModelClient): this {
    this.client = client;
    return this;
  }

  async openStream(
    req: ChatModelRequest,
    signal: AbortSignal,
    finish?: StreamFinish,
  ): Promise<AsyncIterable<ModelStreamChunk>> {
    const open = () =>
      this.getClient().models.generateContentStream({
        model: this.model,
        contents: req.contents.map(toGeminiContent),
        config: {
          systemInstruction: req.system,
          maxOutputTokens: geminiOutputCeiling(req.maxOutputTokens),
          temperature: req.temperature ?? 0.2,
          abortSignal: signal,
        },
      });
    // SDK may deliver a 503 inside the first iterator.next() after HTTP 200.
    // Both opening and consuming share two retries, bounded by the caller's
    // first-token deadline. Never replay any chunk already given to the caller.
    let retries = 0;
    const retry = async (error: unknown): Promise<void> => {
      if (signal.aborted || retries >= 2) throw error;
      let waitMs: number;
      if (providerErrorStatus(error) === '503') {
        waitMs = 1000 * 2 ** retries;
      } else {
        const quota = providerQuotaDiagnostic(error);
        // Only an explicit short minute-window RetryInfo is retriable.
        // Daily quota, billing, auth, unknown 429 and long waits fail promptly.
        if (
          quota.period !== 'minute' ||
          quota.retryAfterSeconds === null ||
          quota.retryAfterSeconds > 10
        )
          throw error;
        waitMs = Math.max(1000, Math.ceil(quota.retryAfterSeconds * 1000));
      }
      retries++;
      await delay(waitMs, undefined, { signal });
    };
    const openWithRetry = async () => {
      for (;;) {
        try {
          return await open();
        } catch (error) {
          await retry(error);
        }
      }
    };
    const initial = await openWithRetry();
    const guarded = async function* (): AsyncGenerator<ModelStreamChunk> {
      let stream = initial;
      let emitted = false;
      for (;;) {
        try {
          for await (const chunk of stream) {
            emitted = true;
            yield chunk;
          }
          return;
        } catch (error) {
          if (emitted) throw error;
          await retry(error);
          stream = await openWithRetry();
        }
      }
    };
    const stream = guarded();
    const chunks = stream as AsyncIterable<SdkChunk>;
    return finish ? watchFinish(chunks, finish) : chunks;
  }
}
