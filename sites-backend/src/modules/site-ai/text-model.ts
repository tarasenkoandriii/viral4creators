/**
 * Текстовая модель Gemini — K3 (ответы песочницы, 3–5 вопросов по сайту;
 * ТЗ §4.5): модель по умолчанию — shared/gemini-model `GEMINI_MODEL`
 * (gemini-3.6-flash). Без стрима в Э1 (песочница отвечает JSON).
 * Таймаут, maxOutputTokens (песочница 800), temperature — параметрами.
 * Тела ошибок провайдера наружу и в лог не отдаются (У-11, §6.6).
 *
 * На assist-chat-core: таймаут — тот же `createChatAbort` (первый ответ =
 * весь ответ, стрима нет), токены — `chatUsageFromMeta` (мысли модели
 * считаются выходом — за них платят по ставке выхода).
 */
import { Injectable, Logger } from '@nestjs/common';
import type { GoogleGenAI } from '@google/genai';
import {
  chatUsageFromMeta,
  createChatAbort,
} from '../../shared/assist-chat-core';
import { siteGeminiClient } from './dev-fake-gemini';
import { GEMINI_MODEL } from '../../shared/gemini-model';

export interface GenerateRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature?: number;
  /** Ответ строго JSON (responseMimeType application/json). */
  json?: boolean;
  timeoutMs?: number;
  /**
   * Э3-бис: модель вызова (lite-модель разметки, ASSIST_LITE_MODEL); не
   * задана — GEMINI_MODEL. Ставку проверяет вызывающий (unpriced — не зовём).
   */
  model?: string;
}

export interface GenerateResult {
  text: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** Сбой модели — без текста провайдера (в нём бывают ключи и куски промпта). */
export class TextModelError extends Error {
  constructor(readonly kind: 'timeout' | 'unavailable' | 'empty') {
    super(
      kind === 'timeout'
        ? 'Модель не ответила вовремя'
        : kind === 'empty'
          ? 'Модель вернула пустой ответ'
          : 'Модель временно недоступна',
    );
    this.name = 'TextModelError';
  }
}

export const DEFAULT_TEXT_TIMEOUT_MS = 25_000;

/** Часть SDK, которой пользуемся (подменяется в тестах). */
export type TextModelClient = Pick<GoogleGenAI, 'models'>;

@Injectable()
export class GeminiText {
  private readonly logger = new Logger(GeminiText.name);
  private client: TextModelClient | null = null;

  /** Клиент создаётся при первом вызове: без ключа сервис всё равно стартует. */
  protected getClient(): TextModelClient {
    this.client ??= siteGeminiClient();
    return this.client;
  }

  /** Для тестов — без сети и ключа. */
  useClient(client: TextModelClient): this {
    this.client = client;
    return this;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_TEXT_TIMEOUT_MS;
    const abort = createChatAbort({
      firstTokenMs: timeoutMs,
      totalMs: timeoutMs,
    });
    const model = req.model || GEMINI_MODEL;
    try {
      const res = await this.getClient().models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        config: {
          systemInstruction: req.system,
          maxOutputTokens: req.maxOutputTokens,
          temperature: req.temperature ?? 0.2,
          ...(req.json ? { responseMimeType: 'application/json' } : {}),
          abortSignal: abort.signal,
        },
      });
      const usage = chatUsageFromMeta(res.usageMetadata);
      const text = res.text ?? '';
      if (!text.trim()) throw new TextModelError('empty');
      return {
        text,
        model,
        inputTokens: usage.in,
        cachedInputTokens: usage.cached,
        outputTokens: usage.out,
      };
    } catch (e) {
      if (e instanceof TextModelError) throw e;
      const kind = abort.signal.aborted ? 'timeout' : 'unavailable';
      // Только класс ошибки — тело провайдера в лог не пишем (У-11).
      this.logger.warn(
        `Gemini ${model}: ${kind} (${(e as Error | null)?.name ?? 'Error'})`,
      );
      throw new TextModelError(kind);
    } finally {
      abort.clear();
    }
  }
}
