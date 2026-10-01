/**
 * Стрим ответа модели для виджета — W3 (ТЗ §4.5: `gemini-3.6-flash` =
 * GEMINI_MODEL). GeminiText (site-ai, Э1) стрима не умеет — здесь только
 * открытие `generateContentStream` с сигналом отмены; таймауты, разделитель
 * действий и токены — runChatStream (shared/assist-chat-core).
 *
 * Тело ошибки провайдера наружу и в лог не идёт (§6.6) — только класс.
 * Тесты подменяют `useClient` (фейковая/«злая» модель, без сети).
 */
import { Injectable } from '@nestjs/common';
import type { GoogleGenAI } from '@google/genai';
import {
  toGeminiContent,
  type ModelStreamChunk,
} from '../../shared/assist-chat-core';
import { siteGeminiClient } from '../site-ai/dev-fake-gemini';
import { GEMINI_MODEL } from '../../shared/gemini-model';

export interface ChatModelRequest {
  system: string;
  contents: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxOutputTokens: number;
  temperature?: number;
}

/** Часть SDK, которой пользуемся (подменяется в тестах). */
export type ChatModelClient = Pick<GoogleGenAI, 'models'>;

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
  ): Promise<AsyncIterable<ModelStreamChunk>> {
    const stream = await this.getClient().models.generateContentStream({
      model: this.model,
      contents: req.contents.map(toGeminiContent),
      config: {
        systemInstruction: req.system,
        maxOutputTokens: req.maxOutputTokens,
        temperature: req.temperature ?? 0.2,
        abortSignal: signal,
      },
    });
    return stream as AsyncIterable<ModelStreamChunk>;
  }
}
