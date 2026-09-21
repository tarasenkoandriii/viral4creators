/**
 * VirtualStudioService — оркестрация «Виртуальной студии»
 * (docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md §2-§6, Этап 1-3):
 * референс-кадр → видео-фрагмент (§4.1), голосовой фрагмент (§4.3),
 * ИИ-анализ (§4.4). Живой аукцион (Этап 5 того же ТЗ — привязка студии
 * к лоту, оркестрация подсказок озвучки) сюда не входит.
 *
 * Переиспользование, а не новый код, там, где это уже есть в проекте
 * (§4 ТЗ, с учётом правок ПРАВКА 1.1):
 *  - видео-фрагмент (Grok) → существующий `GrokVideoService`
 *    (`generation/grok-video.service.ts`) — тот же клиент, что уже
 *    используют обычные сессии генерации;
 *  - видео-фрагмент (Hedra) → существующий `HedraClientService`
 *    (`actors/hedra-client.service.ts`), напрямую, без `sessionId` —
 *    он и так его не использует (см. доккомментарий класса);
 *  - голосовой фрагмент → существующий `TtsProviderResolverService`
 *    (`tts/tts-provider-resolver.service.ts`), `.resolveByKey()`;
 *  - ИИ-анализ → тот же приём, что уже применён в
 *    `AuctionAiAssessmentService` (`auction/auction-ai-assessment.service.ts`):
 *    `GeminiFilesService` + свой `fetch()` по произвольному внешнему
 *    URL, без `BlobService`/`PlanService` — инструмент admin-only, не
 *    пользовательский, вход — произвольная внешняя ссылка, не сессия.
 *  - только референс-кадр (`GrokImageService`, `/v1/images/generations`)
 *    — действительно новый код, такого эндпоинта в проекте не было.
 *
 * Всё видео/анализ — асинхронно (внешний вызов может занять минуты):
 * фрагмент создаётся со `status: 'pending'`/`'processing'` и
 * провайдерским `providerJobId`, клиент опрашивает `getFragmentStatus`
 * тем же приёмом, что `ActorsService.getAvatarVideoStatus` — не более
 * одного вызова провайдера за обращение. Голос синхронный
 * (`TtsProvider.synthesize` не асинхронный job, отдаёт байты сразу).
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GoogleGenAI, Part } from '@google/genai';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { GeminiFilesService } from '../analysis/gemini-files.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { TtsProviderResolverService } from '../tts/tts-provider-resolver.service';
import { HedraClientService } from '../actors/hedra-client.service';
import { GrokVideoService } from '../generation/grok-video.service';
import { GrokImageService } from './grok-image.service';
import { createGeminiClient } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { GenerationStatus } from '../../common/types/generation.types';
import {
  CreateAnalysisFragmentDto,
  CreateVideoFragmentDto,
  CreateVoiceFragmentDto,
} from './dto/virtual-studio.dto';

/** Platform setting (§3.5 ТЗ) — по умолчанию выключено: юридический
 * периметр (нет инфраструктуры маркировки ИИ-контента/согласия,
 * doc/AI-ACTORS-NO-REFERENCE-SPEC.md §0) применяется к Hedra-ветке
 * студии так же, как и к пилоту аватара. */
export const VIRTUAL_STUDIO_HEDRA_ENABLED_KEY = 'virtual_studio_hedra_enabled';

const DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_VIDEO_DURATION_SEC = 12;
const DEFAULT_ASPECT_RATIO = '9:16';
const DEFAULT_RESOLUTION = '720p';

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

const ANALYSIS_VIDEO_PROMPT = `Ты готовишь материал для видео-ведущей виртуальной студии. Кратко (3-5 предложений, на русском) опиши содержание ролика и предложи короткий (2-3 предложения) черновик реплики, которую ведущая могла бы сказать по мотивам этого видео. Не выдумывай деталей, которых не видно на самом деле.`;

function buildAnalysisManifestPrompt(manifest: {
  title: string;
  styleNotes: string | null;
  voiceNotes: string | null;
}): string {
  return `Ты оцениваешь брендбук для виртуальной студии. Название: ${manifest.title}.${
    manifest.styleNotes ? ` Стиль: ${manifest.styleNotes}.` : ''
  }${manifest.voiceNotes ? ` Голос/тон: ${manifest.voiceNotes}.` : ''}\n\nКратко (2-4 предложения, на русском) оцени, насколько он подходит для видео-ведущей студии, и предложи, что учесть в её тоне и манере.`;
}

@Injectable()
export class VirtualStudioService {
  private readonly logger = new Logger(VirtualStudioService.name);
  private readonly genai: GoogleGenAI;

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly aiUsage: AiUsageService,
    private readonly geminiFiles: GeminiFilesService,
    private readonly settings: PlatformSettingsService,
    private readonly tts: TtsProviderResolverService,
    private readonly hedra: HedraClientService,
    private readonly grokVideo: GrokVideoService,
    private readonly grokImage: GrokImageService,
  ) {
    this.genai = createGeminiClient();
  }

  // ── Студии ────────────────────────────────────────────────────────

  async listStudios() {
    return this.prisma.virtualStudio.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { variants: { orderBy: { createdAt: 'desc' } } },
    });
  }

  async createStudio(name: string, refPrompt: string, createdBy: string) {
    return this.prisma.virtualStudio.create({
      data: { name, refPrompt, createdBy },
    });
  }

  /** Soft-delete (§3.1) — ссылки из VirtualStudioFragment.studio не должны ломаться. */
  async deleteStudio(id: string): Promise<void> {
    await this.getStudioOrThrow(id);
    await this.prisma.virtualStudio.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  private async getStudioOrThrow(id: string) {
    const studio = await this.prisma.virtualStudio.findFirst({
      where: { id, deletedAt: null },
    });
    if (!studio) throw new NotFoundException(`Студия ${id} не найдена`);
    return studio;
  }

  // ── Варианты референс-кадра (§3.2) ──────────────────────────────────

  async listVariants(studioId: string) {
    await this.getStudioOrThrow(studioId);
    return this.prisma.virtualStudioVariant.findMany({
      where: { studioId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async generateVariant(studioId: string, promptOverride?: string) {
    const studio = await this.getStudioOrThrow(studioId);
    if (!this.grokImage.isConfigured()) {
      throw new BadRequestException('GROK_API_KEY не задан на этом стенде — генерация референс-кадра недоступна');
    }
    const prompt = promptOverride?.trim() || studio.refPrompt;

    let imageUrl: string;
    try {
      const result = await this.grokImage.generate(prompt, DEFAULT_ASPECT_RATIO);
      const bytes = await this.download(result.url);
      const pathname = `virtual-studio/${studioId}/variant-${Date.now()}.png`;
      ({ url: imageUrl } = await this.blob.uploadBuffer(pathname, bytes, 'image/png'));
    } catch (error) {
      throw new BadRequestException(
        `Не удалось сгенерировать референс-кадр: ${this.extractErrorMessage(error)}`,
      );
    }

    await this.aiUsage.record({
      operation: 'virtual-studio-image',
      model: this.grokImage.modelName,
    });

    const variant = await this.prisma.virtualStudioVariant.create({
      data: { studioId, imageUrl, prompt },
    });

    // Первый вариант автовыбирается (§3.2) — дальше оператор выбирает вручную.
    const existingCount = await this.prisma.virtualStudioVariant.count({
      where: { studioId },
    });
    if (existingCount === 1) {
      await this.prisma.virtualStudio.update({
        where: { id: studioId },
        data: { selectedVariantId: variant.id, status: 'READY' },
      });
    }

    return variant;
  }

  async selectVariant(studioId: string, variantId: string) {
    await this.getStudioOrThrow(studioId);
    const variant = await this.prisma.virtualStudioVariant.findFirst({
      where: { id: variantId, studioId },
    });
    if (!variant) throw new NotFoundException(`Вариант ${variantId} не найден`);
    return this.prisma.virtualStudio.update({
      where: { id: studioId },
      data: { selectedVariantId: variantId, status: 'READY' },
    });
  }

  /** Удаление выбранного варианта сбрасывает selectedVariantId и
   * переводит студию обратно в DRAFT — статус READY по определению
   * (§2, комментарий VirtualStudioStatus) означает «вариант выбран». */
  async deleteVariant(studioId: string, variantId: string): Promise<void> {
    const studio = await this.getStudioOrThrow(studioId);
    const variant = await this.prisma.virtualStudioVariant.findFirst({
      where: { id: variantId, studioId },
    });
    if (!variant) throw new NotFoundException(`Вариант ${variantId} не найден`);

    await this.prisma.virtualStudioVariant.delete({ where: { id: variantId } });

    if (studio.selectedVariantId === variantId) {
      await this.prisma.virtualStudio.update({
        where: { id: studioId },
        data: { selectedVariantId: null, status: 'DRAFT' },
      });
    }
  }

  // ── Фрагменты (§3.3-§3.4) ───────────────────────────────────────────

  async listFragments(studioId: string) {
    await this.getStudioOrThrow(studioId);
    return this.prisma.virtualStudioFragment.findMany({
      where: { studioId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listVoices(providerKey: 'resemble' | 'elevenlabs', language?: string) {
    const provider = this.tts.resolveByKey(providerKey);
    return provider.voices(language);
  }

  async getHedraEnabled(): Promise<boolean> {
    return (await this.settings.get(VIRTUAL_STUDIO_HEDRA_ENABLED_KEY)) === 'true';
  }

  async setHedraEnabled(enabled: boolean, updatedBy: string): Promise<void> {
    await this.settings.set(VIRTUAL_STUDIO_HEDRA_ENABLED_KEY, enabled ? 'true' : 'false', updatedBy);
  }

  async createVideoFragment(studioId: string, dto: CreateVideoFragmentDto) {
    const studio = await this.getStudioOrThrow(studioId);
    if (!studio.selectedVariantId) {
      throw new BadRequestException('У студии нет выбранного варианта референс-кадра — сначала выберите или сгенерируйте его (§3.2)');
    }
    const variant = await this.prisma.virtualStudioVariant.findFirst({
      where: { id: studio.selectedVariantId, studioId },
    });
    if (!variant) {
      throw new BadRequestException('Выбранный вариант референс-кадра не найден — выберите другой');
    }

    const durationSec = dto.durationSec ?? DEFAULT_VIDEO_DURATION_SEC;
    const aspectRatio = dto.aspectRatio ?? DEFAULT_ASPECT_RATIO;

    if (dto.provider === 'hedra') {
      if (!(await this.getHedraEnabled())) {
        throw new BadRequestException('Hedra выключена в настройках (§3.5) — включите её в /settings, чтобы использовать этот провайдер');
      }
      if (!this.hedra.configured()) {
        throw new BadRequestException('HEDRA_API_KEY не задан на этом стенде');
      }
      if (!dto.voiceFragmentId) {
        throw new BadRequestException('Для Hedra нужен готовый голосовой фрагмент (voiceFragmentId) — лип-синк ведётся её озвучкой (§4.2)');
      }
      const voiceFragment = await this.prisma.virtualStudioFragment.findFirst({
        where: { id: dto.voiceFragmentId, studioId, kind: 'VOICE', status: 'complete' },
      });
      if (!voiceFragment?.resultUrl) {
        throw new BadRequestException('Указанный голосовой фрагмент не найден или ещё не готов');
      }

      let jobId: string;
      try {
        const job = await this.hedra.submit({
          prompt: dto.prompt,
          startImage: variant.imageUrl,
          audioUrl: voiceFragment.resultUrl,
          aspectRatio,
          resolution: (dto.resolution as '540p' | '720p' | '1080p' | undefined) ?? '720p',
        });
        jobId = job.jobId;
      } catch (error) {
        throw new BadRequestException(`Не удалось запустить Hedra: ${this.extractErrorMessage(error)}`);
      }

      return this.prisma.virtualStudioFragment.create({
        data: {
          studioId,
          variantId: variant.id,
          kind: 'VIDEO',
          status: GenerationStatus.PROCESSING,
          provider: 'hedra',
          text: dto.prompt,
          durationSec,
          providerJobId: jobId,
        },
      });
    }

    // provider === 'grok' — переиспользуем существующий GrokVideoService
    // (§4.1), тот же клиент, что и у обычных сессий генерации.
    if (!this.grokVideo.isConfigured()) {
      throw new BadRequestException('GROK_API_KEY не задан на этом стенде');
    }
    let requestId: string;
    try {
      const job = await this.grokVideo.startGeneration({
        prompt: dto.prompt,
        imageUrl: variant.imageUrl,
        durationSeconds: durationSec,
        aspectRatio,
        resolution: (dto.resolution as '480p' | '720p' | '1080p' | undefined) ?? DEFAULT_RESOLUTION,
      });
      requestId = job.requestId;
    } catch (error) {
      throw new BadRequestException(`Не удалось запустить Grok: ${this.extractErrorMessage(error)}`);
    }

    return this.prisma.virtualStudioFragment.create({
      data: {
        studioId,
        variantId: variant.id,
        kind: 'VIDEO',
        status: GenerationStatus.PROCESSING,
        provider: 'grok',
        text: dto.prompt,
        durationSec,
        providerJobId: requestId,
      },
    });
  }

  async createVoiceFragment(studioId: string, dto: CreateVoiceFragmentDto) {
    await this.getStudioOrThrow(studioId);
    const provider = this.tts.resolveByKey(dto.provider);
    if (!provider.configured()) {
      throw new BadRequestException(`Провайдер озвучки «${dto.provider}» не настроен на этом стенде`);
    }

    const outcome = await provider.synthesize({
      text: dto.text,
      voiceId: dto.voiceId,
      language: dto.language,
    });
    if (!outcome.ok) {
      throw new BadRequestException(`Синтез голоса не состоялся: ${outcome.reason}`);
    }

    await this.aiUsage.record({
      operation: 'virtual-studio-voice',
      model: `${provider.providerKey}-tts`,
      characters: outcome.characters,
    });

    const pathname = `virtual-studio/${studioId}/voice-${Date.now()}.mp3`;
    const { url } = await this.blob.uploadBuffer(pathname, outcome.audio, outcome.mimeType);

    return this.prisma.virtualStudioFragment.create({
      data: {
        studioId,
        kind: 'VOICE',
        status: GenerationStatus.COMPLETE,
        provider: dto.provider,
        voiceId: dto.voiceId,
        text: dto.text,
        resultUrl: url,
        readyAt: new Date(),
      },
    });
  }

  async createAnalysisFragment(studioId: string, dto: CreateAnalysisFragmentDto) {
    await this.getStudioOrThrow(studioId);

    const brandManifest = dto.brandManifestId
      ? await this.prisma.brandManifest.findUnique({ where: { id: dto.brandManifestId } })
      : null;
    if (dto.brandManifestId && !brandManifest) {
      throw new BadRequestException(`Брендбук ${dto.brandManifestId} не найден`);
    }

    const fragment = await this.prisma.virtualStudioFragment.create({
      data: {
        studioId,
        kind: 'ANALYSIS',
        status: GenerationStatus.PROCESSING,
        provider: 'gemini',
        sourceVideoUrl: dto.sourceVideoUrl,
        brandManifestId: dto.brandManifestId,
      },
    });

    // Синхронно (§4.4, по образцу AuctionAiAssessmentService) — скачивание
    // + Gemini Files API занимает секунды-десятки секунд для короткого
    // ролика, тот же порядок, что уже принят для оценки лота аукциона.
    try {
      const [videoAssessment, manifestAssessment] = await Promise.all([
        this.assessVideo(dto.sourceVideoUrl),
        brandManifest ? this.assessBrandManifest(brandManifest) : Promise.resolve(null),
      ]);
      const resultText = [videoAssessment, manifestAssessment].filter(Boolean).join('\n\n');
      return this.prisma.virtualStudioFragment.update({
        where: { id: fragment.id },
        data: { status: GenerationStatus.COMPLETE, resultText, readyAt: new Date() },
      });
    } catch (error) {
      return this.prisma.virtualStudioFragment.update({
        where: { id: fragment.id },
        data: { status: GenerationStatus.FAILED, errorMessage: this.extractErrorMessage(error) },
      });
    }
  }

  private async assessVideo(videoUrl: string): Promise<string> {
    const res = await fetch(videoUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return `Не удалось скачать видео для анализа (HTTP ${res.status}).`;

    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (contentLength > MAX_VIDEO_BYTES) {
      return 'Видео слишком большое для автоматического анализа.';
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_VIDEO_BYTES) {
      return 'Видео слишком большое для автоматического анализа.';
    }

    const contentType = res.headers.get('content-type');
    const mimeType = contentType?.startsWith('video/') ? contentType : 'video/mp4';

    const file = await this.geminiFiles.uploadAndWaitActive(buffer, mimeType);
    try {
      const videoPart: Part = { fileData: { fileUri: file.uri, mimeType: file.mimeType } };
      const result = await this.genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [videoPart, { text: ANALYSIS_VIDEO_PROMPT }],
      });
      await this.aiUsage.recordGemini(result, {
        operation: 'virtual-studio-analysis',
        model: GEMINI_MODEL,
      });
      return result.text?.trim() || 'ИИ не вернул текстовую сводку.';
    } finally {
      void this.geminiFiles.deleteFile(file.name);
    }
  }

  private async assessBrandManifest(manifest: {
    title: string;
    styleNotes: string | null;
    voiceNotes: string | null;
  }): Promise<string> {
    const result = await this.genai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ text: buildAnalysisManifestPrompt(manifest) }],
    });
    await this.aiUsage.recordGemini(result, {
      operation: 'virtual-studio-analysis',
      model: GEMINI_MODEL,
    });
    return result.text?.trim() || 'ИИ не вернул текстовую оценку.';
  }

  /**
   * Поллинг статуса VIDEO-фрагмента (§3.4) — тот же приём, что
   * `ActorsService.getAvatarVideoStatus`: не более одного вызова
   * провайдера за обращение, ре-хостинг временной ссылки в свой Blob
   * сразу после готовности (§4.1, ПРАВКА 1.1: xAI-ссылка недолговечна).
   */
  async getFragmentStatus(studioId: string, fragmentId: string) {
    await this.getStudioOrThrow(studioId);
    const fragment = await this.prisma.virtualStudioFragment.findFirst({
      where: { id: fragmentId, studioId },
    });
    if (!fragment) throw new NotFoundException(`Фрагмент ${fragmentId} не найден`);

    if (
      fragment.kind !== 'VIDEO' ||
      fragment.status === GenerationStatus.COMPLETE ||
      fragment.status === GenerationStatus.FAILED ||
      !fragment.providerJobId
    ) {
      return fragment;
    }

    if (fragment.provider === 'hedra') {
      let status;
      try {
        status = await this.hedra.status(fragment.providerJobId);
      } catch (error) {
        this.logger.warn(`Hedra status check failed, will retry: ${this.extractErrorMessage(error)}`);
        return fragment;
      }
      if (status.status === 'pending') return fragment;
      if (status.status === 'failed') {
        return this.prisma.virtualStudioFragment.update({
          where: { id: fragment.id },
          data: { status: GenerationStatus.FAILED, errorMessage: status.error ?? 'Hedra сообщила об ошибке' },
        });
      }
      const output = status.outputs?.[0];
      if (!output) {
        return this.prisma.virtualStudioFragment.update({
          where: { id: fragment.id },
          data: { status: GenerationStatus.FAILED, errorMessage: 'Hedra отметила задачу завершённой, но не вернула файл' },
        });
      }
      return this.finalizeVideo(fragment.id, output.url);
    }

    // provider === 'grok'
    let status;
    try {
      status = await this.grokVideo.getStatus(fragment.providerJobId);
    } catch (error) {
      this.logger.warn(`Grok status check failed, will retry: ${this.extractErrorMessage(error)}`);
      return fragment;
    }
    if (!status.done) return fragment;
    if (status.error || !status.videoUrl) {
      return this.prisma.virtualStudioFragment.update({
        where: { id: fragment.id },
        data: { status: GenerationStatus.FAILED, errorMessage: status.error ?? 'Grok не вернул видео' },
      });
    }
    return this.finalizeVideo(fragment.id, status.videoUrl);
  }

  /** Ре-хостинг готового видео (Grok/Hedra) в свой Blob — временная
   * ссылка провайдера недолговечна (§4.1, ПРАВКА 1.1). */
  private async finalizeVideo(fragmentId: string, providerUrl: string) {
    try {
      const bytes = await this.download(providerUrl);
      const pathname = `virtual-studio/fragments/${fragmentId}.mp4`;
      const { url } = await this.blob.uploadBuffer(pathname, bytes, 'video/mp4');
      const fragment = await this.prisma.virtualStudioFragment.findUniqueOrThrow({ where: { id: fragmentId } });
      if (fragment.durationSec) {
        // Разрешение запроса не хранится отдельной колонкой на
        // фрагменте (схема §2 её не заводит) — для составного ключа
        // прайса (`{модель}:{разрешение}`, common/ai-pricing.ts) берём
        // разрешение по умолчанию (720p). Расход по факту может
        // отличаться, если оператор явно попросил другое разрешение —
        // приемлемое приближение для admin-only инструмента с низким
        // объёмом вызовов, не путать с тарификацией пользователя.
        await this.aiUsage.record({
          operation: 'virtual-studio-video',
          model:
            fragment.provider === 'hedra'
              ? 'hedra-character-3'
              : `${this.grokVideo.modelName}:${DEFAULT_RESOLUTION}`,
          seconds: fragment.durationSec,
        });
      }
      return this.prisma.virtualStudioFragment.update({
        where: { id: fragmentId },
        data: { status: GenerationStatus.COMPLETE, resultUrl: url, readyAt: new Date() },
      });
    } catch (error) {
      return this.prisma.virtualStudioFragment.update({
        where: { id: fragmentId },
        data: { status: GenerationStatus.FAILED, errorMessage: this.extractErrorMessage(error) },
      });
    }
  }

  async deleteFragment(studioId: string, fragmentId: string): Promise<void> {
    await this.getStudioOrThrow(studioId);
    const fragment = await this.prisma.virtualStudioFragment.findFirst({
      where: { id: fragmentId, studioId },
    });
    if (!fragment) throw new NotFoundException(`Фрагмент ${fragmentId} не найден`);
    await this.prisma.virtualStudioFragment.delete({ where: { id: fragmentId } });
  }

  private async download(url: string): Promise<Buffer> {
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`скачивание файла: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return 'Unknown error';
  }
}
