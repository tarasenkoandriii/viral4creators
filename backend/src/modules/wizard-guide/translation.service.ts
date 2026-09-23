/**
 * Перевод записей опыта — «Тонкая красная линия» §6.7, этап 11.
 *
 * ## Зачем сохранять перевод, а не переводить каждый раз
 *
 * В версии 4 ТЗ перевод жил внутри суточного кеша подсказок: одна и та
 * же запись переводилась заново каждый день на каждый язык. Сохранённый
 * текст переводится ОДИН РАЗ за всю жизнь записи — при пяти локалях и
 * записи, живущей полгода, это около семисот вызовов, которых не будет.
 *
 * И второе, не менее важное: сохранённый перевод — строка в таблице, у
 * неё есть `reviewed`, её можно прочитать, поправить и утвердить. Пока
 * перевод жил внутри ответа, ревьюить было нечего: текст возникал и
 * исчезал.
 *
 * ## Почему перевод не блокирует подсказку
 *
 * Он идёт ПОСЛЕ ответа человеку и в его же запросе — но результат
 * попадает в базу, а не в текущую подсказку. Ждать перевода, чтобы
 * показать совет, значило бы добавить второй вызов модели в путь,
 * который и так небыстрый; зато на следующем показе запись уже будет.
 */

import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { createGeminiClient, geminiApiKey } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { SupportedLocale } from '../../common/locale';
import {
  buildTranslationPrompt,
  parseTranslation,
  type TranslatableText,
} from './translation';

/**
 * Короче, чем у подсказки (20 с), и намеренно.
 *
 * Перевод идёт внутри запроса человека — фона у serverless нет, и
 * обещанная «потом» задача умерла бы вместе с ответом. Платит за это
 * ожиданием ровно один человек: ПЕРВЫЙ, кто открыл эту ситуацию на этом
 * языке; дальше текст лежит в базе. При пяти локалях и десятке ситуаций
 * это десятки медленных показов за всю жизнь корпуса — но каждый из них
 * не должен превращаться в полминуты спиннера.
 */
const TRANSLATION_TIMEOUT_MS = 8_000;

@Injectable()
export class TranslationService {
  private readonly logger = new Logger(TranslationService.name);
  private readonly genai: GoogleGenAI | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUsage: AiUsageService,
  ) {
    this.genai = geminiApiKey() ? createGeminiClient() : null;
  }

  /**
   * Перевести и сохранить как `MODEL`/`reviewed: false`.
   *
   * @returns `true`, если перевод сохранён.
   */
  async translate(
    experienceId: string,
    target: SupportedLocale,
    source: TranslatableText,
  ): Promise<boolean> {
    if (!this.genai) return false;
    try {
      const response = await this.genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ text: 'Переведи запись.' }],
        config: {
          systemInstruction: buildTranslationPrompt(target, source),
          maxOutputTokens: 600,
          abortSignal: AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
        },
      });
      // Своя операция, а не `wizard-hint`: перевод случается один раз
      // за жизнь записи, а подсказка — на каждом шаге у каждого, и
      // сложенные в одну строку они делают бессмысленными обе. Заодно
      // перевод не съедает личный суточный лимит человека, который
      // просто оказался первым на своём языке.
      await this.aiUsage.recordGemini(response, {
        operation: 'wizard-translate',
        model: GEMINI_MODEL,
        userId: null,
      });
      const parsed = parseTranslation(response?.text ?? '', source);
      if (!parsed.text) {
        // Перевод, потерявший ключ словаря, НЕ сохраняется: подсказка
        // отдастся на авторитетной локали, а запись подождёт. Молча
        // сохранить его значило бы заморозить название кнопки словами —
        // ровно то, что §6.7 запрещает.
        this.logger.warn(
          `перевод записи ${experienceId} на ${target} отклонён: ${parsed.reason}`,
        );
        return false;
      }
      await this.prisma.wizardExperienceText.upsert({
        where: {
          experienceId_locale: { experienceId, locale: target },
        },
        create: {
          experienceId,
          locale: target,
          symptom: parsed.text.symptom,
          cause: parsed.text.cause,
          advice: parsed.text.advice,
          source: 'MODEL',
          reviewed: false,
        },
        // Ничего не перезаписываем: текст на этой локали уже есть,
        // значит его либо перевели раньше, либо написал оператор, и
        // затирать его свежим переводом — потерять ревью.
        update: {},
      });
      return true;
    } catch (e) {
      this.logger.warn(
        `перевод записи ${experienceId} на ${target} не вышел: ${String(e)}`,
      );
      return false;
    }
  }
}
