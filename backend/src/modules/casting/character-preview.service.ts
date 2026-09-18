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
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createGeminiClient } from '../../common/gemini-client';
import { GEMINI_IMAGE_MODEL } from '../../common/gemini-image-model';
import { GoogleGenAI } from '@google/genai';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { BlobService } from '../storage/blob.service';
import { PlanService } from '../plan/plan.service';
import {
  exhaustedQuota,
  IMAGE_OPERATIONS,
  imageQuotaFor,
  startOfMonthUtc,
} from '../../common/image-generation-quota';

/** Ответ `POST …/preview`: картинка (или `null` при сбое модели) и
 * остаток квоты — чтобы экран показал «осталось N», не делая второй
 * запрос. */
export interface CharacterPreviewResult {
  url: string | null;
  pathname: string | null;
  dayUsed: number;
  dayLimit: number;
  monthUsed: number;
  monthLimit: number;
}

/** Путь превью — единственное, что `use-as-photo` согласен копировать
 * (§6.8 doc/AI-SKETCH-SPEC.md): раньше клиентский `previewPathname`
 * не сверялся ни с чем, и в слот фото можно было скопировать любой
 * Blob хранилища, включая чужие файлы. */
export function previewPathnameFor(
  sessionId: string,
  characterId: string,
  ext: 'png' | 'jpg',
): string {
  return `sessions/${sessionId}/character-preview-${characterId}.${ext}`;
}

/** Описание пользователя для промпта: без управляющих символов и
 * двойных кавычек (они закрыли бы цитату), не длиннее 2000 символов. */
export function sanitizeDescription(description: string): string {
  return (
    description
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/"/g, "'")
      .trim()
      .slice(0, 2000)
  );
}

export function isOwnPreviewPathname(
  pathname: string,
  sessionId: string,
  characterId: string,
): boolean {
  return (
    pathname === previewPathnameFor(sessionId, characterId, 'png') ||
    pathname === previewPathnameFor(sessionId, characterId, 'jpg')
  );
}

@Injectable()
export class CharacterPreviewService {
  private readonly logger = new Logger(CharacterPreviewService.name);
  private readonly genai: GoogleGenAI;

  constructor(
    private readonly aiUsage: AiUsageService,
    private readonly blob: BlobService,
    private readonly plans: PlanService,
  ) {
    this.genai = createGeminiClient();
  }

  /**
   * Возвращает публичный Blob URL и pathname сгенерированного превью,
   * или `{url: null, pathname: null}` при сбое (best-effort, тот же
   * принцип, что и у `extractLiteralTexts`/`renderTextCard` — сбой не
   * должен ронять экран кастинга, ради которого это превью и вызвано).
   * `pathname` нужен вызывающему для `promoteToPhoto()` ниже — не
   * восстанавливается из URL надёжно (Blob URL и internal pathname —
   * разные строки).
   */
  async generateFromText(
    sessionId: string,
    characterId: string,
    description: string,
    userId: string,
  ): Promise<CharacterPreviewResult> {
    // §6.8 doc/AI-SKETCH-SPEC.md: у маршрута не было ни лимита, ни
    // `userId` в учёте расхода — квоту считать было не по чему. Тариф и
    // бюджет проверяет вызывающий (`CastingService.assertPreviewAllowed`),
    // здесь — квота на число картинок.
    const quota = imageQuotaFor(await this.plans.planOfUser(userId));
    const now = new Date();
    // Лимит общий с ИИ-скетчем: обе операции — картинки одной модели за
    // одни деньги, и считаются в одну квоту §8.2 (аудит A-10).
    const [dayUsed, monthUsed] = await Promise.all([
      this.aiUsage.countToday(userId, IMAGE_OPERATIONS, now),
      this.aiUsage.countSince(userId, IMAGE_OPERATIONS, startOfMonthUtc(now)),
    ]);
    const exhausted = exhaustedQuota({ dayUsed, monthUsed }, quota);
    if (exhausted) {
      throw new HttpException(
        exhausted === 'day'
          ? `Лимит превью на сегодня исчерпан (${quota.day} в сутки). Обновится в 00:00 UTC (03:00 по Киеву).`
          : `Лимит превью в этом месяце исчерпан (${quota.month}). Больше — на старшем тарифе.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const counters = {
      dayLimit: quota.day,
      monthLimit: quota.month,
    };
    // Сбой без ответа модели расход не пишет — и квоту не тратит (§8.2 ТЗ).
    const failed = (): CharacterPreviewResult => ({
      url: null,
      pathname: null,
      dayUsed,
      monthUsed,
      ...counters,
    });
    let recorded = false;

    try {
      const response = await this.genai.models.generateContent({
        model: GEMINI_IMAGE_MODEL,
        contents: [
          {
            // Описание — данные, а не инструкция: в кавычках и без
            // управляющих символов (§5.2 doc/AI-SKETCH-SPEC.md). Запреты
            // на несовершеннолетних и реальных людей — §5.4 того же ТЗ.
            text: `Create a single clear, photorealistic photo of a fictional adult person for a UGC video ad casting reference. The person is described (in quotes) as: "${sanitizeDescription(description)}". Plain neutral background, well-lit, medium shot from the waist up, facing the camera, natural expression. No text, no watermark, no logo. Do not depict minors. No nudity or sexual content. Do not depict any real, identifiable or famous person.`,
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
        userId,
      });
      recorded = true;
      const used = { dayUsed: dayUsed + 1, monthUsed: monthUsed + 1 };

      const parts = response?.candidates?.[0]?.content?.parts ?? [];
      const imagePart = parts.find((p) => p.inlineData?.data);
      if (!imagePart?.inlineData?.data) {
        this.logger.warn(
          `CharacterPreviewService: ответ Gemini без изображения — сессия ${sessionId}, персонаж ${characterId}`,
        );
        return { url: null, pathname: null, ...used, ...counters };
      }

      const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
      const mimeType = imagePart.inlineData.mimeType || 'image/png';
      const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const pathname = previewPathnameFor(sessionId, characterId, ext);
      const { url } = await this.blob.uploadBuffer(pathname, buffer, mimeType);
      return { url, pathname, ...used, ...counters };
    } catch (error) {
      this.logger.warn(
        `CharacterPreviewService: вызов не удался (${error instanceof Error ? error.message : String(error)}) — сессия ${sessionId}, персонаж ${characterId}`,
      );
      // Ответ получен и оплачен, а упало что-то после (загрузка в Blob) —
      // попытка уже засчитана в квоту.
      return recorded
        ? {
            url: null,
            pathname: null,
            dayUsed: dayUsed + 1,
            monthUsed: monthUsed + 1,
            ...counters,
          }
        : failed();
    }
  }

  /**
   * Доп. запрос владельца продукта: «продвинуть» уже сгенерированное
   * превью до статуса настоящего фото персонажа — копирует байты из
   * временного пути превью в путь, который ожидает
   * `CastingService.confirmPhoto()` (`sessions/{id}/characters/{cid}/photo.<ext>`
   * — точный формат см. `CastPhotoConfirmRequestDto`), возвращает этот
   * путь для последующего вызова `confirmPhoto()`. Само подтверждение
   * НЕ здесь — переиспользуется уже существующий, уже проверенный путь
   * (`CastingController.confirm`), не дублируется его логика.
   *
   * `null` — копирование не удалось (например, превью уже удалено или
   * никогда не существовало) — вызывающий не должен пытаться
   * подтверждать несуществующий путь.
   */
  async copyPreviewToPhotoPath(
    sessionId: string,
    characterId: string,
    previewPathname: string,
  ): Promise<string | null> {
    if (!isOwnPreviewPathname(previewPathname, sessionId, characterId)) {
      throw new BadRequestException(
        'previewPathname не принадлежит этому персонажу — сгенерируйте превью заново',
      );
    }
    const ext = previewPathname.endsWith('.jpg') ? 'jpg' : 'png';
    const contentType = ext === 'jpg' ? 'image/jpeg' : 'image/png';
    const toPathname = `sessions/${sessionId}/characters/${characterId}/photo.${ext}`;
    const url = await this.blob.copyBlob(
      previewPathname,
      toPathname,
      contentType,
    );
    return url ? toPathname : null;
  }
}
