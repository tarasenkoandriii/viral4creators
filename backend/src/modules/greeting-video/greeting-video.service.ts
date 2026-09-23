/**
 * GreetingVideoService — video rendering trigger for GREETING_VIDEO (ТЗ
 * TZ-Greeting-Video-Project-Type.md §5.3).
 *
 * SCOPE NOTE (see the audit for the full reasoning — this is the most
 * consequential deviation from the ТЗ in this implementation):
 *
 *  - 'grok': §5.3 describes "image-to-video от сгенерированного
 *    референс-кадра" — no service in this codebase or in the ТЗ itself
 *    generates such a frame. Instead of inventing one, the creator can
 *    now UPLOAD up to 7 of their own reference images on the frontend
 *    (follow-up request to the ТЗ — see `GreetingReferenceService`,
 *    `session.greetingReferenceImages`), and this service sends them as
 *    Grok's native `reference_images` (docs.x.ai reference-to-video,
 *    ≤7, confirmed officially — see `GrokVideoService`'s doc-comment).
 *    With zero reference images uploaded it falls back to plain
 *    text-to-video, exactly as before. Either way, voice-over is left to
 *    the EXISTING, unmodified postprod pipeline
 *    (`PostProductionService.start`/`poll`), which reads only
 *    `session.generationPrompt`/`session.brandManifestSnapshot` — never
 *    `Project.type` — so it needs no changes at all (verified by reading
 *    `postprod.service.ts`'s `planWork()`).
 *
 *    voice-over is left to the EXISTING, largely-unmodified postprod
 *    pipeline (`PostProductionService.start`/`poll`), which reads only
 *    `session.generationPrompt`/`session.brandManifestSnapshot` for
 *    everything EXCEPT the TTS language, which used to silently become
 *    `null` for every GREETING_VIDEO session (`planWork()` only called
 *    `resolveVoiceoverLanguage` when `session.productInformation` was
 *    set) — fixed to fall back to detecting the language from the
 *    greeting's own spoken text instead (see the pipeline audit, finding
 *    №3, and `postprod.service.ts`'s `planWork()`).
 *
 *    Reference mode caps Grok at 720p regardless of tariff
 *    (`effectiveGrokResolution`, docs.x.ai) — a PREMIUM brief resolved to
 *    1080p is silently rendered at 720p when references are present, the
 *    same degrade-not-reject choice `GrokVideoService` already makes for
 *    every other caller of reference-to-video; the billed/recorded
 *    resolution below is always the EFFECTIVE one, never the requested.
 *
 *  - Content moderation: `GreetingPromptService` now runs the same
 *    keyword-based `PromptService.moderateText()` check SINGLE/LINE use
 *    (pipeline audit, finding №2). GREETING_VIDEO has no manual
 *    approve/bypass screen, so a FLAGGED prompt never gets `approvedAt`
 *    set — `startVideo` below refuses to render it rather than silently
 *    proceeding, since nothing else in this service would otherwise ever
 *    look at `moderationStatus`.
 *
 *  - Export tier B (cross-aspect-ratio re-render, `ExportService.
 *    startRerender`) is NOT wired to this service — it still calls the
 *    generic `GenerationService.generateVideo()`, which hard-requires a
 *    product photo GREETING_VIDEO sessions never have. Rather than leave
 *    that route producing a confusing "product image required" 400
 *    (pipeline audit, finding №1), `ExportService` now rejects it early
 *    for GREETING_VIDEO sessions with an honest "not supported yet"
 *    message — a real cross-ratio re-render path for this project type is
 *    future work, not implemented here.
 *
 *  - 'hedra': NOT wired to a public endpoint here. Reading
 *    `common/plans.ts` and `actors.controller.ts` shows the Hedra/Resemble
 *    pipeline (`ActorsService.generateAvatarVideo`) is a deliberate,
 *    documented ADMIN-ONLY pilot — `avatarLipsync` is `false` on every
 *    plan today, and its only controller is `admin/actors`, guarded by
 *    `AdminSessionGuard`, specifically because it isn't considered ready
 *    for real users yet (see that controller's doc-comment). §5.3's claim
 *    that GREETING_VIDEO can call it "exactly as today" for PREMIUM users
 *    would silently reverse that safety decision. `startHedraVideo` below
 *    exists so the API shape is complete, but it refuses with a clear,
 *    honest error until a product decision reopens that pilot to real
 *    traffic — see the audit's top finding for the two ways to close this.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SessionService } from '../../common/session.service';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PostProductionService } from '../postprod/postprod.service';
import {
  effectiveGrokResolution,
  GrokVideoService,
} from '../generation/grok-video.service';
import { renderExpired } from '../generation/generation.service';
import {
  GenerationStatus,
  GeneratedVideo,
} from '../../common/types/generation.types';
import { ModerationStatus } from '../../common/types/prompt.types';
import { featureDeniedMessage, planAllows } from '../../common/plans';
import { v4 as uuidv4 } from 'uuid';
import { BlobService } from '../storage/blob.service';
import { GreetingBriefSnapshot } from '../../common/types/greeting.types';
import { SceneAsset } from '../../common/types/reference.types';
import { activeSessionSceneImage } from '../../common/active-image';
import {
  normalizeSceneCount,
  withStoryboard,
} from '../../common/greeting-scenes';
import { normalizeVoiceMode, usesOwnVoice } from '../../common/voice-mode';
import { MAX_GREETING_REFERENCE_IMAGES } from '../greeting-reference/greeting-reference.service';

const GREETING_VIDEO_CLAIM_TTL_MS = 5 * 60 * 1000;
export const GREETING_VIDEO_IN_FLIGHT_MESSAGE =
  'Генерация ролика уже запускается — дождитесь ответа первого запроса.';

/** Полная нативная длительность Grok (§7 ТЗ не задаёт длину ролика явно —
 * взят потолок провайдера как самый безопасный дефолт для короткого
 * поздравления: длиннее пользователь попросить и не может, §5.3). */
const GREETING_VIDEO_DURATION_SECONDS = 15;

const DOWNLOAD_TIMEOUT_MS = 120_000;

@Injectable()
export class GreetingVideoService {
  private readonly logger = new Logger(GreetingVideoService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly plans: PlanService,
    private readonly aiUsage: AiUsageService,
    private readonly postprod: PostProductionService,
    private readonly grokVideo: GrokVideoService,
    private readonly blob: BlobService,
  ) {}

  /** POST /sessions/:id/greeting-video — starts rendering. */
  async startVideo(sessionId: string): Promise<GeneratedVideo> {
    await this.plans.assertCanSpendSession(sessionId);

    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    const brief = session.greetingBriefSnapshot;
    if (!brief) {
      throw new BadRequestException(
        'This session has no greeting brief — it was not created from a GREETING_VIDEO project.',
      );
    }
    if (!session.generationPrompt) {
      throw new BadRequestException(
        'No prompt yet — call POST /sessions/:id/greeting-prompt first.',
      );
    }
    // Найдено при аудите пайплайна (находка №2): GREETING_VIDEO теперь
    // модерирует текст сценария (`GreetingPromptService.
    // generateGreetingPrompt`, через `PromptService.moderateText`), но у
    // этого типа проекта нет отдельного экрана ручного одобрения, чтобы
    // осознанно обойти флаг (как `approvePrompt()`'s FLAGGED → BYPASSED у
    // SINGLE/LINE) — без этой проверки флаг был бы записан в БД, но ничто
    // ниже по конвейеру на него бы не посмотрело, и видео всё равно бы
    // сгенерировалось. Пользователь сам решает, что делать дальше:
    // отредактировать текст поздравления (`personalMessage`/
    // `customOccasionText`) на шаге брифа и заново собрать сценарий.
    if (
      session.generationPrompt.moderationStatus === ModerationStatus.FLAGGED
    ) {
      throw new BadRequestException(
        'Текст сценария не прошёл автоматическую проверку контента ' +
          `(${(session.generationPrompt.moderationFlags ?? []).join(', ') || 'без деталей'}). ` +
          'Измените текст поздравления или повод на шаге брифа и соберите сценарий заново.',
      );
    }

    const inFlight = session.generatedVideo;
    if (
      inFlight &&
      (inFlight.status === GenerationStatus.PENDING ||
        inFlight.status === GenerationStatus.PROCESSING)
    ) {
      return inFlight;
    }

    if (brief.resolvedPresenterProvider === 'hedra') {
      return this.startHedraVideo(sessionId, brief);
    }
    return this.startGrokVideo(
      sessionId,
      brief,
      session.generationPrompt.finalText,
      session.greetingReferenceImages ?? [],
      // Участвует ли НАШ синтез. Режим читается ровно так же, как его
      // прочитает постобработка (`PostProductionService.planWork`):
      // снимка бренда у бытового поздравления обычно нет, а
      // `normalizeVoiceMode` читает его отсутствие как 'voiceover'.
      usesOwnVoice(
        normalizeVoiceMode(session.brandManifestSnapshot?.voiceMode),
      ),
    );
  }

  /** GET /sessions/:id/greeting-video — polls the in-flight render. */
  async pollVideo(sessionId: string): Promise<GeneratedVideo | undefined> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    const current = session.generatedVideo;
    if (!current || current.status !== GenerationStatus.PROCESSING) {
      return current;
    }
    const polled = await this.pollGrokVideo(sessionId, current);
    return polled;
  }

  private async startHedraVideo(
    // Оба параметра сегодня не используются: метод гарантированно
    // отказывает до того, как дойдёт до них (см. ниже). Сигнатура
    // оставлена целиком, чтобы открытие пилота Hedra не потребовало
    // править вызывающего, — поэтому глушим правило здесь, а не
    // выбрасываем аргументы.
    /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
    sessionId: string,
    /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
    brief: GreetingBriefSnapshot,
  ): Promise<GeneratedVideo> {
    // §7 ТЗ гейтит 'hedra' по тарифу PREMIUM в GreetingBrief; но сама
    // Hedra-инфраструктура (`avatarLipsync`) сегодня выключена НА ВСЕХ
    // тарифах — это отдельный, более общий гейт (см. doc-comment файла).
    // `resolveGreetingConfig` уже гарантирует, что бриф с
    // `presenterProvider: 'hedra'` мог быть сохранён только на PREMIUM —
    // но "разрешено по тарифу поздравлений" и "пилот открыт для реальных
    // пользователей" — два разных вопроса, и второй решается здесь.
    if (!planAllows('PREMIUM', 'avatarLipsync')) {
      throw new BadRequestException(
        `Говорящий аватар для GREETING_VIDEO пока недоступен: ${featureDeniedMessage('avatarLipsync')} ` +
          '(пилот Hedra/Resemble сегодня открыт только оператору — см. ActorsController). ' +
          'Выберите presenterProvider "grok" или дождитесь решения о переводе пилота в публичный доступ.',
      );
    }
    // Недостижимо, пока условие выше не станет true — оставлено, чтобы
    // сигнатура метода была на месте и не потребовала правки маршрута,
    // когда пилот откроется.
    throw new BadRequestException('Not implemented');
  }

  private async startGrokVideo(
    sessionId: string,
    brief: GreetingBriefSnapshot,
    basePrompt: string,
    referenceImages: SceneAsset[],
    /**
     * Участвует ли наш синтез (`voiceover`/`dub` в снимке бренда).
     *
     * Сам по себе это ещё не значит «просить немой ролик»: пресетный
     * голос xAI в брифе перебивает режим — там реплику произносит
     * модель, и дорожка нужна. Решение принимается ниже, одной
     * строкой, чтобы оба условия читались вместе.
     *
     * Ради чего: до 22.09.2026 модель всегда отдавала дорожку, в
     * которой ведущий проговаривает то же поздравление, а
     * постобработка в режиме по умолчанию (`voiceover`) клала нашу
     * речь ПОВЕРХ приглушённой — слышны были обе, с небольшим
     * сдвигом. Промпт теперь просит не произносить реплику вслух
     * (`buildSceneDescription`), но просьба — не гарантия; флаг
     * закрывает тот же вопрос на уровне протокола.
     *
     * На цену это не влияет: у xAI тариф считается по секундам и
     * разрешению, отдельной ставки за звук в прайсе нет (проверено
     * 22.09.2026, docs.x.ai/developers/pricing).
     *
     * Платой за флаг остаётся атмосфера и музыка модели — их тоже не
     * будет. Для поздравления это приемлемо: фон там декоративный, а
     * вторая речь поверх своей — брак.
     */
    ownVoice: boolean,
  ): Promise<GeneratedVideo> {
    if (!this.grokVideo.isConfigured()) {
      throw new BadRequestException(
        'GROK_API_KEY не задан на этом стенде — генерация видео для GREETING_VIDEO не подключена',
      );
    }
    const claimed = await this.sessions.claimWork(
      sessionId,
      'generate',
      GREETING_VIDEO_CLAIM_TTL_MS,
    );
    if (!claimed) {
      throw new ConflictException(GREETING_VIDEO_IN_FLIGHT_MESSAGE);
    }

    const requestedResolution = brief.resolvedResolution;
    const aspectRatio = '9:16'; // §5.3: короткий вертикальный ролик — тот же формат, что аватар-пилот по умолчанию.
    const generatedVideoId = uuidv4();
    const pathname = `sessions/${sessionId}/generated.mp4`;

    // Активное изображение слота (оригинал или применённый скетч, §6.3
    // AI-SKETCH-SPEC.md) — никогда голый photoUrl напрямую, тот же
    // инвариант, что везде в проекте читает `common/active-image.ts`.
    // `MAX_GREETING_REFERENCE_IMAGES` уже гарантирован лимитом загрузки
    // (`GreetingReferenceService`), здесь лишний .slice — просто defence
    // in depth против будущей правки того лимита.
    const referenceImageUrls = referenceImages
      .slice(0, MAX_GREETING_REFERENCE_IMAGES)
      .map((s) => activeSessionSceneImage(s)?.url)
      .filter((url): url is string => !!url);

    // Grok's own limitation, confirmed in `GrokVideoService`'s
    // doc-comment: reference-to-video caps at 720p regardless of what
    // was requested/resolved by tariff. Recorded/billed resolution below
    // MUST be this effective value, not `requestedResolution` — a PREMIUM
    // user who attached references never pays 1080p pricing for a 720p
    // render.
    const resolution = effectiveGrokResolution(requestedResolution, {
      references: referenceImageUrls.length > 0,
    });

    // Пресетный голос xAI — реплику произносит модель (`<AUDIO_0>` в
    // промпте уже расставлен `buildSceneDescription`). Один голос, не
    // три: в поздравлении говорящий один, а лишние записи в
    // `reference_audios` модель попробует куда-нибудь пристроить.
    const presetVoiceId = brief.presetVoiceId?.trim() || null;
    const silent = ownVoice && !presetVoiceId;
    // Мультисцена (фича №7) — это раскадровка В ПРОМПТЕ, а не
    // несколько вызовов: модель рендерит сцены с монтажными склейками
    // одним клипом, ровно как товарная ветка уже делает
    // (`scenesBriefText`). Никакого нового состояния у ролика от этого
    // не появляется.
    const prompt = withStoryboard(
      basePrompt,
      normalizeSceneCount(brief.sceneCount ?? 1),
      GREETING_VIDEO_DURATION_SECONDS,
    );

    try {
      const { requestId } = await this.grokVideo.startGeneration({
        prompt,
        ...(referenceImageUrls.length ? { referenceImageUrls } : {}),
        durationSeconds: GREETING_VIDEO_DURATION_SECONDS,
        aspectRatio,
        resolution: requestedResolution,
        generateAudio: !silent,
        ...(presetVoiceId ? { referenceAudioVoiceIds: [presetVoiceId] } : {}),
      });

      const video: GeneratedVideo = {
        generatedVideoId,
        pathname,
        fileName: 'generated.mp4',
        mimeType: 'video/mp4',
        status: GenerationStatus.PROCESSING,
        provider: 'grok',
        resolution,
        grokRequestId: requestId,
        aspectRatio,
        initiatedAt: new Date(),
        // Постобработке знать обязательно: на файле без потока `0:a`
        // фильтр режима `voiceover` падает, а не пропускается молча.
        ...(silent ? { silentSource: true } : {}),
      };
      const updated = await this.sessions.updateSession(sessionId, {
        generatedVideo: video,
      });
      await this.aiUsage.record({
        operation: 'generation',
        model: `${this.grokVideo.modelName}:${resolution}`,
        sessionId,
        seconds: GREETING_VIDEO_DURATION_SECONDS,
        calls: 1,
      });
      return updated?.generatedVideo ?? video;
    } finally {
      await this.sessions.releaseWork(sessionId, 'generate');
    }
  }

  private async pollGrokVideo(
    sessionId: string,
    current: GeneratedVideo,
  ): Promise<GeneratedVideo> {
    if (renderExpired(current)) {
      return this.markFailed(
        sessionId,
        current,
        `Grok не ответил за отведённое время — попробуйте сгенерировать ещё раз`,
      );
    }
    if (!current.grokRequestId) return current;

    let status: { done: boolean; error?: string; videoUrl?: string };
    try {
      status = await this.grokVideo.getStatus(current.grokRequestId);
    } catch (error) {
      this.logger.warn(`Grok status check failed, will retry: ${error}`);
      return current;
    }
    if (!status.done) return current;
    if (status.error) {
      return this.markFailed(sessionId, current, status.error);
    }
    if (!status.videoUrl) {
      return this.markFailed(
        sessionId,
        current,
        'Grok reported completion but returned no video',
      );
    }

    let videoBuffer: Buffer;
    let blobUrl: string;
    try {
      const res = await fetch(status.videoUrl, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Grok video download HTTP ${res.status}`);
      videoBuffer = Buffer.from(await res.arrayBuffer());
      ({ url: blobUrl } = await this.blob.uploadBuffer(
        current.pathname,
        videoBuffer,
        'video/mp4',
      ));
    } catch (error) {
      return this.markFailed(
        sessionId,
        current,
        error instanceof Error ? error.message : String(error),
      );
    }

    const completed: GeneratedVideo = {
      ...current,
      status: GenerationStatus.COMPLETE,
      completedAt: new Date(),
      fileSize: videoBuffer.length,
      downloadUrl: blobUrl,
    };
    const updated = await this.sessions.updateSession(sessionId, {
      generatedVideo: completed,
    });
    const withVoiceover = updated?.generatedVideo ?? completed;
    // Тот же вызов, что generation.service.ts делает по завершении Veo/
    // Grok-рендера (`this.postprod.start(sessionId, completed)`) —
    // planWork() читает только session.generationPrompt/
    // brandManifestSnapshot, никогда Project.type, поэтому работает без
    // единой правки postprod.service.ts (см. doc-comment файла).
    return this.postprod.start(sessionId, withVoiceover);
  }

  private async markFailed(
    sessionId: string,
    current: GeneratedVideo,
    message: string,
  ): Promise<GeneratedVideo> {
    const failed: GeneratedVideo = {
      ...current,
      status: GenerationStatus.FAILED,
      error: {
        code: 'GREETING_VIDEO_GENERATION_FAILED',
        message,
        timestamp: new Date(),
        retryable: true,
      },
    };
    const updated = await this.sessions.updateSession(sessionId, {
      generatedVideo: failed,
    });
    return updated?.generatedVideo ?? failed;
  }
}
