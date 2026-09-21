/**
 * AuctionAiAssessmentService — Этап 3 (ТЗ на маркетплейс §22): ИИ-оценка
 * видео и (опционально) брендбука для заявки на аукцион, видна
 * исполнителю (§22, «Модерация очереди кандидатов»).
 *
 * НЕ переиспользует VideoAuditService напрямую, хотя ТЗ и говорило
 * «по образцу video-audit» — при ближайшем чтении тот сервис завязан
 * на sessionId генерации (PlanService/AiUsageService считают квоту по
 * сессии) и скачивает видео из СВОЕГО внутреннего blob-хранилища по
 * внутреннему пути (BlobService.downloadBuffer(pathname)), а не по
 * произвольному URL. У PortfolioItem.videoUrl — обычная внешняя ссылка
 * (исполнитель сам хостит), так что здесь используются только
 * действительно переиспользуемые низкоуровневые части — тот же приём,
 * что video-audit.module.ts/actors.module.ts уже применяют для
 * GeminiFilesService: провайдер заводится заново в каждом потребителе
 * (AnalysisModule её не экспортирует), а скачивание — свой fetch()
 * вместо BlobService, тот же паттерн, что уже есть в
 * catalog-batch-worker.service.ts для внешних видео.
 *
 * Выполняется фоново по крону (auction-assess), не синхронно при
 * подаче заявки: скачивание внешнего видео + загрузка в Gemini Files
 * API может занять до пары минут (тот же таймаут, что у
 * catalog-batch-worker.service.ts) — заявка не должна ждать этого.
 */

import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI, Part } from '@google/genai';
import { createGeminiClient } from '../../common/gemini-client';
import { GeminiFilesService } from '../analysis/gemini-files.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { GEMINI_MODEL } from '../../common/gemini-model';

const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Защита от неожиданной стоимости/злоупотребления — обычный UGC-ролик укладывается с большим запасом. */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

const VIDEO_PROMPT = `Ты модератор маркетплейса пользовательского видео. Кратко (3–5 предложений, на русском) опиши содержание ролика и явно отметь, если видишь:
1) откровенный или шокирующий контент;
2) явно узнаваемые чужие товарные знаки/логотипы без очевидного разрешения;
3) серьёзные технические проблемы (нечитаемое изображение, отсутствующий звук).
Если ничего из этого нет — так и напиши. Не придумывай проблем, которых не видно на самом деле.`;

interface BrandManifestForAssessment {
  title: string;
  styleNotes: string | null;
  voiceNotes: string | null;
  characters: { label: string; description: string | null }[];
  scenes: { label: string; description: string | null }[];
}

@Injectable()
export class AuctionAiAssessmentService {
  private readonly logger = new Logger(AuctionAiAssessmentService.name);
  private readonly genai: GoogleGenAI;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geminiFiles: GeminiFilesService,
    private readonly aiUsage: AiUsageService,
  ) {
    this.genai = createGeminiClient();
  }

  /**
   * Один тик — одна заявка (тот же принцип, что у остальных
   * тик-воркеров крона, например feed-import-run): предсказуемая
   * стоимость шага, не нужен внутренний параллелизм на старте.
   */
  async runTick(): Promise<{ assessed: boolean }> {
    const listing = await this.prisma.auctionListing.findFirst({
      where: { status: 'PENDING_MODERATION', aiAssessment: null },
      orderBy: { createdAt: 'asc' },
      include: {
        portfolioItem: true,
        creatorProfile: true,
        brandManifest: { include: { characters: true, scenes: true } },
      },
    });
    if (!listing) return { assessed: false };

    // Аудит-фикс по ходу написания: userId для учёта расходов — это
    // User.id, не CreatorProfile.id (разные сущности) — использовал бы
    // не тот id, если бы не перепроверил.
    const userId = listing.creatorProfile.userId;

    const [videoAssessment, brandManifestAssessment] = await Promise.all([
      this.assessVideo(listing.portfolioItem.videoUrl, userId),
      listing.includeBrandManifest && listing.brandManifest
        ? this.assessBrandManifest(listing.brandManifest, userId)
        : Promise.resolve(null),
    ]);

    await this.prisma.auctionListing.update({
      where: { id: listing.id },
      data: { aiAssessment: videoAssessment, brandManifestAiAudit: brandManifestAssessment },
    });
    return { assessed: true };
  }

  private async assessVideo(videoUrl: string, userId: string): Promise<string> {
    try {
      const res = await fetch(videoUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) return `Не удалось скачать видео для оценки (HTTP ${res.status}).`;

      const contentLength = Number(res.headers.get('content-length') ?? '0');
      if (contentLength > MAX_VIDEO_BYTES) {
        return 'Видео слишком большое для автоматической оценки — нужна ручная проверка.';
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength > MAX_VIDEO_BYTES) {
        return 'Видео слишком большое для автоматической оценки — нужна ручная проверка.';
      }

      // Аудит-фикс: нельзя жёстко считать mp4 — videoUrl произвольная
      // внешняя ссылка, исполнитель мог захостить в любом формате.
      // Берём Content-Type ответа, если это видео; иначе — безопасный
      // дефолт (Gemini сам откажет на явно не-видео контенте).
      const contentType = res.headers.get('content-type');
      const mimeType = contentType?.startsWith('video/') ? contentType : 'video/mp4';

      const file = await this.geminiFiles.uploadAndWaitActive(buffer, mimeType);
      try {
        const videoPart: Part = { fileData: { fileUri: file.uri, mimeType: file.mimeType } };
        const result = await this.genai.models.generateContent({
          model: GEMINI_MODEL,
          contents: [videoPart, { text: VIDEO_PROMPT }],
        });
        await this.aiUsage.recordGemini(result, {
          operation: 'auction-assessment',
          model: GEMINI_MODEL,
          userId,
        });
        return result.text?.trim() || 'ИИ не вернул текстовую оценку.';
      } finally {
        void this.geminiFiles.deleteFile(file.name);
      }
    } catch (e) {
      this.logger.warn(`ИИ-оценка видео не удалась: ${(e as Error).message}`);
      return 'Автоматическая оценка не удалась — нужна ручная проверка.';
    }
  }

  private async assessBrandManifest(manifest: BrandManifestForAssessment, userId: string): Promise<string> {
    try {
      const summary = [
        `Название: ${manifest.title}`,
        manifest.styleNotes ? `Стиль: ${manifest.styleNotes}` : null,
        manifest.voiceNotes ? `Голос/тон: ${manifest.voiceNotes}` : null,
        manifest.characters.length
          ? `Персонажи: ${manifest.characters.map((c) => c.label + (c.description ? ` — ${c.description}` : '')).join('; ')}`
          : 'Персонажи: не заданы',
        manifest.scenes.length
          ? `Сцены: ${manifest.scenes.map((s) => s.label + (s.description ? ` — ${s.description}` : '')).join('; ')}`
          : 'Сцены: не заданы',
      ]
        .filter(Boolean)
        .join('\n');

      const prompt = `Ты оцениваешь брендбук, который исполнитель хочет продать ЭКСКЛЮЗИВНО вместе с видео на аукционе — после продажи он больше не сможет его использовать в новых работах. Вот содержимое:\n\n${summary}\n\nКратко (2–4 предложения, на русском) оцени: достаточно ли он полон и завершён, чтобы быть ценным активом для покупателя, или выглядит слишком скудным, чтобы продавать его безвозвратно. Не выдумывай деталей сверх приведённых.`;

      const result = await this.genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ text: prompt }],
      });
      await this.aiUsage.recordGemini(result, {
        operation: 'auction-assessment',
        model: GEMINI_MODEL,
        userId,
      });
      return result.text?.trim() || 'ИИ не вернул текстовую оценку.';
    } catch (e) {
      this.logger.warn(`ИИ-аудит брендбука не удался: ${(e as Error).message}`);
      return 'Автоматический аудит не удался — нужна ручная проверка.';
    }
  }
}
