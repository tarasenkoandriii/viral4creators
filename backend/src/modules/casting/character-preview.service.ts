/**
 * CharacterPreviewService — доп. запрос владельца продукта: статичное
 * превью персонажа из ТЕКСТОВОГО описания (двойной клик по описанию в
 * `CharacterCasting.tsx`, `kind: 'text'`, ещё нет фото). Помогает
 * представить, как модель поймёт словесное описание, ДО того как оно
 * уйдёт в дорогой вызов видео-генерации.
 *
 * НЕ становится референс-изображением персонажа автоматически —
 * только превью для самого пользователя; если понадобится сделать
 * его настоящим референсом, это отдельная, более крупная задача
 * (нужно решить, как это соотносится с `kind: 'photo'`/лимитом
 * референсов §2/§15 ТЗ) — не реализовано здесь намеренно, попросили
 * именно превью.
 *
 * ⚠️ Не прогнано ни разу в этой среде (нет сети, чтобы вызвать
 * реальный Gemini API) — API-вызов сверен с официальной документацией
 * (`common/gemini-image-model.ts`), но не проверен вживую.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createGeminiClient } from '../../common/gemini-client';
import { GEMINI_IMAGE_MODEL } from '../../common/gemini-image-model';
import { GoogleGenAI } from '@google/genai';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { BlobService } from '../storage/blob.service';

@Injectable()
export class CharacterPreviewService {
  private readonly logger = new Logger(CharacterPreviewService.name);
  private readonly genai: GoogleGenAI;

  constructor(
    private readonly aiUsage: AiUsageService,
    private readonly blob: BlobService,
  ) {
    this.genai = createGeminiClient();
  }

  /**
   * Возвращает публичный Blob URL сгенерированного превью или `null`
   * при сбое (best-effort, тот же принцип, что и у `extractLiteralTexts`/
   * `renderTextCard` — сбой не должен ронять экран кастинга, ради
   * которого это превью и вызвано).
   */
  async generateFromText(
    sessionId: string,
    characterId: string,
    description: string,
  ): Promise<string | null> {
    try {
      const response = await this.genai.models.generateContent({
        model: GEMINI_IMAGE_MODEL,
        contents: [
          {
            text: `Create a single clear, photorealistic photo of a person matching this description, for a UGC video ad casting reference: ${description}. Plain neutral background, well-lit, medium shot from the waist up, facing the camera, natural expression. No text, no watermark, no logo.`,
          },
        ],
        config: {
          // Только изображение — не тратим токены на текстовый ответ,
          // которого здесь никто не читает.
          //
          // ⚠️ Точный регистр строки НЕ подтверждён однозначно — разные
          // официальные источники показывают то `['Text', 'Image']`
          // (developers.googleblog.com, JS-пример), то `["IMAGE"]`
          // (та же страница, Python) — возможно, SDK принимает оба
          // варианта регистра, возможно, JS и Python расходятся.
          // ПРОВЕРИТЬ реальным вызовом перед тем, как полагаться на
          // этот путь — если ответ приходит без `inlineData` вовсе,
          // первым делом попробовать `['IMAGE']` вместо `['Image']`.
          responseModalities: ['Image'],
        },
      });
      await this.aiUsage.recordGemini(response, {
        operation: 'character-preview',
        model: GEMINI_IMAGE_MODEL,
        sessionId,
      });

      const parts = response?.candidates?.[0]?.content?.parts ?? [];
      const imagePart = parts.find((p) => p.inlineData?.data);
      if (!imagePart?.inlineData?.data) {
        this.logger.warn(
          `CharacterPreviewService: ответ Gemini без изображения — сессия ${sessionId}, персонаж ${characterId}`,
        );
        return null;
      }

      const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
      const mimeType = imagePart.inlineData.mimeType || 'image/png';
      const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const pathname = `sessions/${sessionId}/character-preview-${characterId}.${ext}`;
      const { url } = await this.blob.uploadBuffer(pathname, buffer, mimeType);
      return url;
    } catch (error) {
      this.logger.warn(
        `CharacterPreviewService: вызов не удался (${error instanceof Error ? error.message : String(error)}) — сессия ${sessionId}, персонаж ${characterId}`,
      );
      return null;
    }
  }
}
