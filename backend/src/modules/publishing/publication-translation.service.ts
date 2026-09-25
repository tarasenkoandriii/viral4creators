/**
 * PublicationTranslationService — один дешёвый текстовый вызов, который
 * превращает заголовок и описание заявки в локализованные варианты для
 * `snippet.localizations` при загрузке (этап 137).
 *
 * ## Почему синхронно, а не пачкой, как блог
 *
 * ТЗ предполагало тот же механизм, что у блога, — xAI Grok Batch. Для
 * статьи это верно: перевод статьи не срочный и стоит вдвое дешевле
 * пачкой. Здесь наоборот: локализации нужны В МОМЕНТ загрузки ролика,
 * одним запросом вместе со `snippet` (см. `publication-translation.ts`
 * — почему insert, а не update), а пачка приходит часами позже, когда
 * ролик уже опубликован. Пришлось бы городить второй проход
 * `videos.update`, ради которого и понадобился бы скоуп `force-ssl`,
 * которого нет. Один короткий текстовый вызов на ролик — прецедент в
 * продукте уже есть: `analysis-translate` (этап 59).
 *
 * ## Лучшая попытка, всегда
 *
 * Нет ключа, отказ провайдера, мусор в ответе — пустая карта, и ролик
 * уходит на площадку без локализаций. Приёмка этапа требует ровно
 * этого: «ролик, у которого локализации не удались, всё равно
 * опубликован».
 */

import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { createGeminiClient, geminiApiKey } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { SupportedLocale } from '../../common/locale';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import {
  LocalizedText,
  buildPublicationTranslationPrompt,
  parsePublicationTranslations,
} from './publication-translation';

/**
 * Вызов идёт внутри тика крона выгрузки, который держит заявку под
 * локом пятнадцать минут, а сам живёт по таймауту функции. Зависший
 * вызов провайдера стоил бы заявке не перевода, а публикации: тик
 * умрёт, лок останется, и ролик подождёт до его истечения. Двадцати
 * секунд хватает с запасом — это один короткий текстовый ответ.
 */
const TRANSLATION_TIMEOUT_MS = 20_000;

/**
 * Потолок ответа. Четыре локали по заголовку и описанию — это заметно
 * меньше, но резать надо: обрыв JSON на половине даёт пустую карту
 * (ролик уйдёт без локализаций), а отсутствие потолка — счёт без
 * потолка.
 */
const MAX_OUTPUT_TOKENS = 8000;

@Injectable()
export class PublicationTranslationService {
  private readonly logger = new Logger(PublicationTranslationService.name);
  private readonly genai: GoogleGenAI | null;

  constructor(private readonly aiUsage: AiUsageService) {
    // Конструктор не бросает без ключа: этот сервис поднимается вместе с
    // модулем публикации, и падение здесь уронило бы выгрузку целиком —
    // ради украшения, без которого она прекрасно работает.
    this.genai = geminiApiKey() ? createGeminiClient() : null;
  }

  async translate(
    input: { title: string; description: string },
    source: SupportedLocale,
    ctx: { sessionId?: string | null; userId?: string | null } = {},
  ): Promise<Partial<Record<SupportedLocale, LocalizedText>>> {
    if (!this.genai) return {};
    if (!input.title.trim()) return {};

    try {
      const response = await this.genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ text: buildPublicationTranslationPrompt(input, source) }],
        config: {
          responseMimeType: 'application/json',
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          abortSignal: AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
        },
      });
      await this.aiUsage.recordGemini(response, {
        operation: 'publication-translate',
        model: GEMINI_MODEL,
        sessionId: ctx.sessionId ?? null,
        userId: ctx.userId ?? null,
      });
      return parsePublicationTranslations(response?.text ?? '', source);
    } catch (e) {
      this.logger.warn(
        `Перевод описания для площадки не удался, ролик уйдёт без локализаций: ${e instanceof Error ? e.message : String(e)}`,
      );
      return {};
    }
  }
}
