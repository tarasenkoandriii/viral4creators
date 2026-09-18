/**
 * Вызов модели изображений для ИИ-скетча (doc/AI-SKETCH-SPEC.md §5.1).
 *
 * Отдельно от `ImageSketchService`, потому что это единственное место,
 * которое знает про формат запроса Gemini: когда модель сменится (а она
 * уже меняется — `gemini-2.5-flash-image` выводят 02.10.2026), правится
 * только этот файл.
 *
 * Различаем ТРИ исхода, а не два:
 *  - `ok` — картинка есть;
 *  - `refused` — модель ответила, но картинку не дала (безопасность).
 *    Вызов оплачен, значит попытка засчитывается в квоту;
 *  - `failed` — ответа не было вовсе (сеть, таймаут). Не оплачено —
 *    квота не тратится (§8.2 ТЗ).
 */

import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { createGeminiClient } from '../../common/gemini-client';
import { GEMINI_SKETCH_MODEL } from '../../common/gemini-image-model';

const TIMEOUT_MS = 60_000;

export interface SketchGenerationInput {
  prompt: string;
  /** Байты оригинала для image-to-image; пусто — рисуем по описанию. */
  source?: { bytes: Buffer; mimeType: string } | null;
}

export type SketchGenerationOutcome =
  | {
      status: 'ok';
      bytes: Buffer;
      mimeType: string;
      model: string;
      raw: unknown;
    }
  | { status: 'refused'; reason: string; model: string; raw: unknown }
  | { status: 'failed'; reason: string; model: string };

@Injectable()
export class SketchGeneratorService {
  private readonly logger = new Logger(SketchGeneratorService.name);
  private readonly genai: GoogleGenAI;

  constructor() {
    this.genai = createGeminiClient();
  }

  async generate(
    input: SketchGenerationInput,
  ): Promise<SketchGenerationOutcome> {
    const model = GEMINI_SKETCH_MODEL;
    const contents: Array<Record<string, unknown>> = [];
    if (input.source) {
      contents.push({
        inlineData: {
          data: input.source.bytes.toString('base64'),
          mimeType: input.source.mimeType,
        },
      });
    }
    contents.push({ text: input.prompt });

    let response: unknown;
    try {
      response = await withTimeout(
        this.genai.models.generateContent({
          model,
          contents: contents as never,
          config: {
            // Тот же вопрос про регистр, что у превью персонажа
            // (`character-preview.service.ts`): официальные примеры
            // расходятся. Проверяется первым же боевым вызовом; если
            // ответ приходит без `inlineData`, пробовать `['IMAGE']`.
            responseModalities: ['Image'],
          },
        }),
        TIMEOUT_MS,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`скетч: вызов модели не удался — ${reason}`);
      return { status: 'failed', reason, model };
    }

    const candidate = (
      response as {
        candidates?: Array<{
          finishReason?: string;
          content?: {
            parts?: Array<{
              inlineData?: { data?: string; mimeType?: string };
            }>;
          };
        }>;
      }
    )?.candidates?.[0];
    const part = (candidate?.content?.parts ?? []).find(
      (p) => p.inlineData?.data,
    );
    if (!part?.inlineData?.data) {
      const reason = candidate?.finishReason ?? 'модель не вернула изображение';
      this.logger.warn(`скетч: отказ модели (${reason})`);
      return { status: 'refused', reason, model, raw: response };
    }
    return {
      status: 'ok',
      bytes: Buffer.from(part.inlineData.data, 'base64'),
      mimeType: part.inlineData.mimeType || 'image/png',
      model,
      raw: response,
    };
  }
}

/** Свой таймаут: SDK его не обещает, а зависший вызов съест всю функцию. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`модель не ответила за ${ms / 1000} с`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
