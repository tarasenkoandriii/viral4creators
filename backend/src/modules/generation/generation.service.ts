import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  ForbiddenException,
  ServiceUnavailableException,
  InternalServerErrorException,
} from '@nestjs/common';
import { FOREIGN_BLOB_URL_MESSAGE, isOwnBlobUrl } from '../../common/blob-url';
import {
  GoogleGenAI,
  GenerateVideosOperation,
  Video,
  VideoGenerationReferenceImage,
  VideoGenerationReferenceType,
} from '@google/genai';
import { createGeminiClient } from '../../common/gemini-client';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionService } from '../../common/session.service';
import { PlanService } from '../plan/plan.service';
import { CreditLedgerService } from '../credit-ledger/credit-ledger.service';
import {
  allowsAspectRatio,
  featureDeniedMessage,
  planAllows,
} from '../../common/plans';
import { BlobService } from '../storage/blob.service';
import {
  GeneratedVideo,
  GenerationStatus,
  GenerationError,
  VideoQuality,
} from '../../common/types/generation.types';
import { Session, SessionStatus } from '../../common/types/session.types';
import { v4 as uuidv4 } from 'uuid';
import {
  buildReferencePlan,
  ReferenceImageSource,
  referenceMappingText,
} from '../../common/reference-plan';
import {
  normaliseAspectRatio,
  planRender,
  VeoAspectRatio,
} from '../../common/aspect-ratio';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PostProductionService } from '../postprod/postprod.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import { SharedVideoService } from '../shared-video/shared-video.service';
import { VIDEO_DURATION_SECONDS } from '../../common/veo-duration';

/**
 * Model IDs for each quality tier, on the Gemini Developer API (not
 * Vertex AI — see the VideoQuality doc comment in generation.types.ts for
 * why "fast" maps to Lite rather than a dedicated Fast model).
 */

const VEO_MODELS: Record<VideoQuality, string> = {
  fast: 'veo-3.1-lite-generate-preview',
  standard: 'veo-3.1-generate-preview',
};

const DEFAULT_QUALITY: VideoQuality = 'fast';

/**
 * Сколько держится замок запуска (этап 47). Клиентский таймаут — 120 с,
 * сборка референсов и старт Veo укладываются в него почти всегда;
 * запас нужен на случай, когда экземпляр функции умер, не сняв замок
 * (потолок функции на Vercel — 300 с). Протухший замок считается
 * свободным.
 */
const GENERATE_CLAIM_TTL_MS = 5 * 60 * 1000;

export const GENERATION_IN_FLIGHT_MESSAGE =
  'Генерация уже запускается — дождитесь ответа первого запроса.';

/** Сколько ждём Veo, прежде чем закрыть рендер сбоем (этап 52, В-2.8). */
export const RENDER_DEADLINE_MS = 20 * 60 * 1000;

export function renderExpired(
  video: Pick<GeneratedVideo, 'initiatedAt'>,
  now: number = Date.now(),
): boolean {
  // Даты из JSON приходят строками.
  const started = new Date(video.initiatedAt).getTime();
  return Number.isFinite(started) && now - started > RENDER_DEADLINE_MS;
}

/**
 * Е-1.4 шестого аудита: узкое окно между тем, как Veo реально ПРИНЯЛА
 * запрос (значит, деньги уже потрачены — рендер идёт в фоне у Google),
 * и тем, как это успело записаться в сессию. Обычный сценарий сбоя
 * между резервом кредита и `updateSession` — вернуть кредит целиком
 * (см. комментарий Г-2.3 в `startGeneration`) — здесь опасен вдвойне:
 * ролик либо остаётся оплаченным, но недостижимым (кредит вернули, а
 * Veo-операция никуда не привязана), либо, что хуже, пользователь видит
 * "ошибку" и жмёт "Повторить" — второй настоящий платный рендер того же
 * ролика. Отдельный класс ошибки, чтобы `startGeneration` мог отличить
 * этот случай от обычного (сбой ДО того, как Veo вообще стартовала,
 * где возврат кредита по-прежнему безопасен и обязателен) и не звать
 * `refundIfReserved` — баланс остаётся списанным, разбор ручной.
 */
export class VeoOperationOrphanedError extends InternalServerErrorException {
  constructor(
    message: string,
    /** Пусто, если Veo вообще не вернула имя операции (см. ниже) —
     * тогда зацепиться не за что даже для ручного разбора логами. */
    public readonly operationName: string,
  ) {
    super(message);
  }
}

/**
 * GenerationService handles video generation using Google Veo 3.1.
 *
 * Replaces the old Sora-2-via-Laozhang flow (see git history) — that
 * approach doesn't work going forward for two independent reasons: Sora's
 * API is being shut down by OpenAI on 2026-09-24, and its fire-and-forget
 * background-processing pattern was never compatible with Vercel Functions
 * in the first place (execution isn't guaranteed to continue once a
 * response has been sent, and Hobby caps a function at 300s anyway).
 *
 * Veo fixes both: it's a real long-running-operation API, so the flow is
 * naturally request/response-shaped —
 *  - generateVideo() starts the job and returns immediately once Veo has
 *    queued it (it does NOT wait for rendering to finish).
 *  - getVideoStatus() is polled by the client (same pattern already used
 *    for analysis status) and makes exactly one operation-status check
 *    per call. No server-side polling loop, no background continuation
 *    assumption — every HTTP request is short regardless of how long the
 *    overall generation takes.
 */
@Injectable()
export class GenerationService {
  private readonly logger = new Logger(GenerationService.name);
  private readonly genai: GoogleGenAI;

  constructor(
    private readonly sessionService: SessionService,
    private readonly blobService: BlobService,
    private readonly plans: PlanService,
    private readonly aiUsage: AiUsageService,
    private readonly postprod: PostProductionService,
    private readonly notify: TelegramNotifyService,
    private readonly sharedVideos: SharedVideoService,
    private readonly creditLedger: CreditLedgerService,
  ) {
    // Ключ — явно в SDK (этап 53, В-6.15): `new GoogleGenAI({})` читал
    // только свои переменные, и GOOGLE_GEMINI_API_KEY до него не доходил.
    this.genai = createGeminiClient();
  }

  /**
   * Start a Veo video generation job.
   * @param sessionId - Session UUID
   * @param quality - 'fast' (default, Lite model) or 'standard' (full Veo 3.1)
   * @returns Generated video metadata with PROCESSING status
   */
  async generateVideo(
    sessionId: string,
    quality: VideoQuality = DEFAULT_QUALITY,
    aspectRatio?: string,
  ): Promise<GeneratedVideo> {
    // §23: в Lite доступны только родные для Veo форматы — 16:9 и 9:16.
    // §25.3: заблокированному генерация запрещена — это самый дорогой
    // вызов сервиса, и именно ради него блокировка и существует.
    const owner = await this.sessionService.getSession(sessionId);
    // Блокировка проверяется здесь, а не бюджет/кредит (этап 62, ТЗ
    // §41.1): этот метод дёргается повторно на каждый клиентский ретрай
    // идущей операции (см. `inFlight`-ветку ниже) — списать кредит
    // здесь означало бы списывать его за КАЖДЫЙ повторный запрос, а не
    // один раз за реальный старт рендера. Настоящая проверка
    // «есть ли кредит / есть ли суточный лимит» — в `startGeneration`,
    // ровно там, где рождается `generatedVideoId` и начинается
    // необратимая трата денег.
    await this.plans.assertUserNotBlocked(owner?.userId ?? null);
    const access = await this.plans.accessOf(owner?.userId ?? null);
    if (aspectRatio && !allowsAspectRatio(access.plan, aspectRatio)) {
      throw new ForbiddenException(featureDeniedMessage('customAspectRatio'));
    }
    // Этап 47 (В-2.6): полная модель в 2,7 раза дороже Lite, а параметр
    // приходит телом запроса — проверяем, как и формат кадра.
    if (
      quality !== DEFAULT_QUALITY &&
      !planAllows(access.plan, 'fullQualityVideo')
    ) {
      throw new ForbiddenException(featureDeniedMessage('fullQualityVideo'));
    }
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }

    // Идущий рендер не запускается второй раз (Б-2.3).
    //
    // Метод не смотрел на `session.generatedVideo` вообще: второй POST
    // начинал вторую операцию Veo, писал второй расход и затирал
    // `generatedVideo` — первый, уже оплаченный рендер осиротевал, его
    // `veoOperationName` терялся, и скачать его было нечем. Повторить
    // запрос легко: сборка референсов и старт Veo укладываются не
    // всегда, а клиентский таймаут — 120 секунд.
    //
    // Возвращаем ту же операцию, а не 409: для пользователя это ровно
    // то, чего он ждал, — экран продолжит опрашивать статус.
    const inFlight = session.generatedVideo;
    if (
      inFlight &&
      (inFlight.status === GenerationStatus.PENDING ||
        inFlight.status === GenerationStatus.PROCESSING)
    ) {
      this.logger.warn(
        `сессия ${sessionId}: повторный запуск генерации при идущей операции ${
          inFlight.veoOperationName ?? '—'
        } — возвращаю её же`,
      );
      return inFlight;
    }

    // Этап 47 (В-2.2 / В-3.1): проверка выше видит только рендер, который
    // уже ЗАПИСАН, а запись происходит после скачивания фото, референсов
    // и самого вызова Veo — через секунды. Повтор после клиентского
    // таймаута и тридцать одновременных запросов попадали ровно в это
    // окно: каждый проходил и проверку бюджета (расход ещё не записан),
    // и проверку «уже идёт», и запускал свой рендер. Замок занимается
    // одним условным UPDATE в базе — на Vercel параллельные запросы
    // приходят в разные экземпляры функции, и разводит их только база.
    const claimed = await this.sessionService.claimWork(
      sessionId,
      'generate',
      GENERATE_CLAIM_TTL_MS,
    );
    if (!claimed) {
      this.logger.warn(
        `сессия ${sessionId}: параллельный запуск генерации при уже занятом замке — отказ`,
      );
      throw new ConflictException(GENERATION_IN_FLIGHT_MESSAGE);
    }
    try {
      return await this.startGeneration(session, quality, aspectRatio);
    } finally {
      // Успех или провал — замок снимается: при успехе повтор увидит
      // записанный `generatedVideo`, при провале повтор разрешён.
      await this.sessionService.releaseWork(sessionId, 'generate');
    }
  }

  /** Тело запуска — под замком `claimWork('generate')`, см. выше. */
  private async startGeneration(
    session: Session,
    quality: VideoQuality,
    aspectRatio?: string,
  ): Promise<GeneratedVideo> {
    const sessionId = session.sessionId;
    if (!session.generationPrompt || !session.generationPrompt.approvedAt) {
      throw new BadRequestException(
        'Prompt must be approved before generating video',
      );
    }

    const productImagePathname =
      session.productInformation?.productImagePathname;
    if (!productImagePathname) {
      throw new BadRequestException(
        'Product image must be uploaded before generating video',
      );
    }

    const generatedVideoId = uuidv4();
    const pathname = `sessions/${sessionId}/generated.mp4`;

    // Этап 62 (ТЗ §41.1): купленный кредит — это оплаченный РОЛИК, значит
    // проверяется он именно тут, под замком `claimWork('generate')`
    // (см. `generateVideo`), ровно один раз на реальный старт рендера —
    // не в `generateVideo` (тот метод вызывается повторно на идущую
    // операцию) и не универсальной правкой `assertCanSpendUser` (та же
    // проверка гейтит ещё девять неигровых мест — разбор, промпт,
    // озвучку и т.д., где «кредит» не значит ничего). Списывается СРАЗУ:
    // при параллельном старте резерв атомарен (см.
    // `CreditLedgerService.reserveForGeneration`), а списание по
    // завершении дало бы гонку, где обе параллельные попытки видят
    // «баланс > 0» и обе стартуют бесплатно. Нет кредита — обычная
    // проверка суточного лимита, как и раньше.
    const usedCredit = await this.creditLedger.reserveForGeneration(
      session.userId ?? null,
      generatedVideoId,
    );
    if (!usedCredit) {
      await this.plans.assertCanSpendUser(session.userId ?? null);
    }

    // Г-2.3 (аудит round4, этап 64): кредит списан ВЫШЕ, до того, как Veo
    // реально стартовал. Раньше всё, что могло бросить между резервом и
    // `updateSession` (скачивание референсов, сам вызов Veo, запись
    // расхода, запись сессии), просто теряло кредит навсегда — рендера не
    // было, а `refundIfReserved` вызывался только из `getVideoStatus` для
    // УЖЕ сохранённого `generatedVideoId`, до которого в таких случаях
    // дело не доходило. `refundIfReserved` — no-op, если резерва не было
    // (`usedCredit=false`, обычный дневной лимит) или он уже возвращён —
    // безопасно звать всегда, не только когда `usedCredit` истинен.
    try {
      return await this.startVeoGeneration(
        session,
        sessionId,
        generatedVideoId,
        pathname,
        quality,
        aspectRatio,
      );
    } catch (error) {
      // Е-1.4 шестого аудита: `VeoOperationOrphanedError` значит, что Veo
      // УЖЕ реально стартовала (деньги потрачены) — автоматический
      // возврат кредита здесь означал бы либо бесплатный, либо ВТОРОЙ
      // платный рендер того же ролика при повторе. Кредит остаётся
      // списанным намеренно; для любого другого сбоя (до старта Veo)
      // возврат по-прежнему безопасен и обязателен, как и раньше.
      if (!(error instanceof VeoOperationOrphanedError)) {
        await this.creditLedger.refundIfReserved(generatedVideoId);
      }
      throw error;
    }
  }

  /** Вынесено из `startGeneration` (Г-2.3): всё, что происходит МЕЖДУ
   * резервом кредита и сохранением `generatedVideo` в сессию, — единая
   * попытка старта рендера, которую вызывающий оборачивает `try/catch`
   * ради возврата кредита при любом сбое здесь. */
  private async startVeoGeneration(
    session: Session,
    sessionId: string,
    generatedVideoId: string,
    pathname: string,
    quality: VideoQuality,
    aspectRatio?: string,
  ): Promise<GeneratedVideo> {
    // Оба уже проверены вызывающим (`startGeneration`) до резерва кредита
    // — здесь просто читаем поля снова (и заново сужаем тип для
    // компилятора), а не пробрасываем параметрами лишний раз доказанные
    // непустыми значения через всю сигнатуру.
    if (!session.generationPrompt || !session.generationPrompt.approvedAt) {
      throw new BadRequestException(
        'Prompt must be approved before generating video',
      );
    }
    const productImagePathname =
      session.productInformation?.productImagePathname;
    if (!productImagePathname) {
      throw new BadRequestException(
        'Product image must be uploaded before generating video',
      );
    }

    // Spec §10.2/§10.3 (Stage 15): the same reference plan PromptService
    // numbered in the prompt. Two mutually exclusive Veo modes — the API
    // does not accept `image` (first frame) together with `referenceImages`:
    //  - legacy: no character photos → product photo is the first frame;
    //  - references: ≥1 character photo → up to 3 `asset` images (characters
    //    first by activation order, product photo in the last free slot),
    //    everyone else described in the prompt text.
    const plan = buildReferencePlan(session);

    let imageInput: { imageBytes: string; mimeType: string } | undefined;
    let referenceImages: VideoGenerationReferenceImage[] | undefined;
    if (plan.legacyFirstFrame) {
      // Product image becomes Veo's first frame (unchanged behaviour).
      const imageBuffer =
        await this.blobService.downloadBuffer(productImagePathname);
      imageInput = {
        imageBytes: imageBuffer.toString('base64'),
        mimeType:
          session.productInformation?.productImageMimeType || 'image/png',
      };
    } else {
      referenceImages = [];
      for (const ref of plan.images) {
        const bytes = await this.fetchReference(ref);
        referenceImages.push({
          image: {
            imageBytes: bytes.toString('base64'),
            mimeType: ref.mimeType,
          },
          referenceType: VideoGenerationReferenceType.ASSET,
        });
      }
      this.logger.log(
        `Reference mode: ${plan.images
          .map((i) => `#${i.index} ${i.kind}:${i.label}`)
          .join(', ')}; text-only characters: ${
          plan.characters
            .filter((c) => c.referenceIndex === null)
            .map((c) => c.label)
            .join(', ') || '—'
        }`,
      );
    }

    // Spec §16: target format = explicit choice, else the reference's
    // detected frame, else vertical. Non-native targets render in the
    // nearest Veo frame with a composition note for the later crop.
    const target =
      normaliseAspectRatio(aspectRatio) ??
      session.originalVideo?.frame?.aspectRatio ??
      '9:16';
    let render = planRender(target);
    const promptText = [
      session.generationPrompt.finalText,
      // Spec §17: the authoritative "reference image N = …" mapping, computed
      // now — slots may have been re-chosen after the prompt was written.
      referenceMappingText(plan),
      `Output format: ${render.rendered} ${render.rendered === '9:16' ? 'vertical' : 'horizontal'} video.`,
      render.compositionNote ?? '',
    ]
      .filter(Boolean)
      .join('\n');

    const start = (frame: VeoAspectRatio) =>
      this.genai.models.generateVideos({
        model: VEO_MODELS[quality],
        prompt: promptText,
        ...(imageInput ? { image: imageInput } : {}),
        config: {
          durationSeconds: VIDEO_DURATION_SECONDS,
          aspectRatio: frame,
          generateAudio: true,
          ...(referenceImages ? { referenceImages } : {}),
        },
      });

    let operation: GenerateVideosOperation;
    try {
      this.logger.log(
        `Starting Veo (${quality} -> ${VEO_MODELS[quality]}, ${render.rendered} for target ${target}) generation for session ${sessionId}`,
      );
      try {
        operation = await start(render.rendered);
      } catch (error) {
        // Known API quirk (Google AI forum, 2026): reference-image
        // requests may refuse 9:16 with "Unsupported output video aspect
        // ratio". Fall back to 16:9 and owe a crop rather than fail.
        if (
          referenceImages &&
          render.rendered === '9:16' &&
          /aspect ratio/i.test(this.extractErrorMessage(error))
        ) {
          this.logger.warn(
            `Veo refused 9:16 with referenceImages — retrying in 16:9 (target ${target} kept for reframe)`,
          );
          render = {
            target,
            rendered: '16:9',
            reframe: true,
            compositionNote: render.compositionNote,
          };
          operation = await start('16:9');
        } else {
          throw error;
        }
      }
    } catch (error) {
      this.logger.error('Failed to start Veo generation:', error);
      // Е-1.2 шестого аудита, этап 76: раньше ЛЮБАЯ ошибка самого вызова
      // Veo (включая транзиентный 429/5xx у @google/genai — SDK бросает
      // `ApiError` с числовым полем `status`, см. dist/genai.d.ts) попадала
      // в тот же BadRequestException, что и постоянные ошибки валидации
      // запроса. Воркеры партии/A-B (catalog-batch-worker.service.ts,
      // ab-test-worker.service.ts) классифицируют BadRequestException как
      // «ретраить бессмысленно» по имени класса — транзиентный сбой уводил
      // строку в FAILED навсегда, хотя обычный повтор почти наверняка
      // прошёл бы. ServiceUnavailableException не входит в их
      // NON_RETRYABLE_NAMES — такая ошибка проходит обычным
      // экспоненциальным бэкоффом, как и должна.
      const status = (error as { status?: number } | undefined)?.status;
      const transient =
        typeof status === 'number' && (status === 429 || status >= 500);
      if (transient) {
        throw new ServiceUnavailableException(
          `Veo временно недоступен (${status}): ${this.extractErrorMessage(error)}`,
        );
      }
      throw new BadRequestException(
        `Failed to start video generation: ${this.extractErrorMessage(error)}`,
      );
    }

    if (!operation.name) {
      // Е-1.4 шестого аудита: Veo ответила без ошибки, значит запрос
      // принят и деньги, скорее всего, уже потрачены — но без имени
      // операции зацепиться не за что даже для ручного разбора логами.
      // Тот же принцип "не возвращать кредит автоматически", что и ниже.
      throw new VeoOperationOrphanedError(
        'Veo did not return an operation to track — cannot poll for status',
        '',
      );
    }

    // Е-1.4 шестого аудита: с этой точки Veo УЖЕ реально рендерит —
    // любой сбой ниже (запись расхода, запись сессии, например
    // транзиентный сбой БД) больше не должен приводить к обычному
    // возврату кредита у вызывающего `startGeneration` — тот платный
    // рендер продолжает идти в фоне ни с чем не связанным, а обычный
    // повтор пользователя оплатил бы ещё один. Поэтому здесь отдельный
    // try/catch: любая ошибка на этом шаге оборачивается в
    // `VeoOperationOrphanedError`, которую вызывающий распознаёт и НЕ
    // возвращает кредит по ней (см. `startGeneration`).
    try {
      // ТЗ §26. Расход пишется в момент ЗАПУСКА, а не по завершении: деньги
      // считаются потраченными, даже если рендер потом упадёт. Занизить
      // отчёт о расходах опаснее, чем завысить — по нему планируют бюджет,
      // а невидимые неудачные рендеры превращают его в фантазию.
      await this.aiUsage.record({
        operation: 'generation',
        model: VEO_MODELS[quality],
        seconds: VIDEO_DURATION_SECONDS,
        sessionId,
      });

      const generatedVideo: GeneratedVideo = {
        generatedVideoId,
        pathname,
        fileName: 'generated.mp4',
        mimeType: 'video/mp4',
        status: GenerationStatus.PROCESSING,
        initiatedAt: new Date(),
        veoOperationName: operation.name,
        quality,
        aspectRatio: render.target,
        renderedAspectRatio: render.rendered,
        reframePending: render.reframe,
        references: plan.images.map((i) => ({
          index: i.index,
          kind: i.kind,
          label: i.label,
          characterId: i.characterId,
        })),
      };

      await this.sessionService.updateSession(sessionId, {
        generatedVideo,
        status: SessionStatus.GENERATING_VIDEO,
      });

      return generatedVideo;
    } catch (error) {
      this.logger.error(
        `КРИТИЧНО (Е-1.4): Veo стартовала (operation=${operation.name}) для сессии ${sessionId}, но запись результата упала — рендер оплачен и идёт в фоне, но не привязан ни к чему в базе: ${this.extractErrorMessage(error)}`,
      );
      throw new VeoOperationOrphanedError(
        `Рендер уже стартовал (${operation.name}), но сохранить состояние не удалось — обратитесь в поддержку, не запускайте повторно`,
        operation.name,
      );
    }
  }

  /**
   * Bytes of one reference image: our own Blob pathname when we uploaded
   * it (character skins, product photo), else the public URL (brand
   * character photos live under the manifest's pathnames — we only hold
   * the URL in the session snapshot).
   */
  private async fetchReference(ref: ReferenceImageSource): Promise<Buffer> {
    if (ref.pathname) {
      return this.blobService.downloadBuffer(ref.pathname);
    }
    if (!ref.url) {
      throw new BadRequestException(
        `Reference image ${ref.index} (${ref.label}) has neither a pathname nor a URL`,
      );
    }
    // Вторая линия той же защиты, что в DTO (А-2.11): снимок манифеста
    // мог быть записан до этапа 38 или прийти любым другим путём, а
    // скачивает картинку именно этот код. Проверка у самого `fetch` —
    // единственная, которую нельзя обойти, добавив новый маршрут записи.
    if (!isOwnBlobUrl(ref.url)) {
      this.logger.warn(
        `референс ${ref.index} (${ref.label}) указывает вне нашего хранилища — пропущен`,
      );
      throw new BadRequestException(
        `Reference image ${ref.index} (${ref.label}): ${FOREIGN_BLOB_URL_MESSAGE}`,
      );
    }
    const res = await fetch(ref.url);
    if (!res.ok) {
      throw new BadRequestException(
        `Failed to fetch reference image ${ref.index} (${ref.label}): HTTP ${res.status}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Check (and, if newly complete, resolve) video generation status.
   * Called repeatedly by the client's poll loop — makes at most one Veo
   * API call per invocation.
   * @param sessionId - Session UUID
   * @returns Current video generation status
   */
  async getVideoStatus(sessionId: string): Promise<GeneratedVideo> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }

    const current = session.generatedVideo;
    if (!current) {
      throw new NotFoundException('Video generation has not been initiated');
    }

    if (current.status === GenerationStatus.COMPLETE) {
      // current.downloadUrl was already set once, when the blob was
      // written (see below) — a public Blob URL for a fixed pathname is
      // stable, unlike the old S3 presigned GET URL, so there's nothing
      // to re-sign or refresh on a later poll.
      //
      // §15.4/§16.1: у готового ролика может идти постобработка —
      // обрезка кадра и/или своя звуковая дорожка, одной задачей.
      // Опрашиваем её здесь же, а не отдельным механизмом: клиент и так
      // опрашивает этот маршрут, и второй цикл опроса ради одной
      // операции был бы лишним. Постобработка не блокирует выдачу —
      // ролик уже есть.
      return this.postprod.poll(sessionId, current);
    }

    if (current.status === GenerationStatus.FAILED) {
      return current;
    }

    if (!current.veoOperationName) {
      // Shouldn't happen in practice — nothing to poll against.
      return current;
    }

    // Этап 52 (В-2.8): у ожидания рендера есть дедлайн. Любая ошибка
    // опроса — в том числе постоянная (имя операции протухло, ключ
    // отозван) — возвращала PROCESSING, и сессия висела в
    // GENERATING_VIDEO до самого TTL: «разрешение» выглядело как
    // исчезновение сессии под пользователем. `initiatedAt` записывался и
    // не читался никем. Veo отвечает за минуты; двадцать — это не
    // «долго», это «не будет». Провал помечен retryable — повтор законен.
    if (renderExpired(current)) {
      return await this.markFailed(
        sessionId,
        current,
        'VIDEO_GENERATION_TIMEOUT',
        `Veo не ответил за ${RENDER_DEADLINE_MS / 60000} минут — попробуйте сгенерировать ещё раз`,
        true,
      );
    }

    let operation: GenerateVideosOperation;
    try {
      operation = await this.genai.operations.getVideosOperation({
        // Only `name` is actually needed to address the operation; the
        // rest of GenerateVideosOperation's fields are optional, so this
        // structurally satisfies the type without round-tripping the
        // whole object through session storage.
        operation: {
          name: current.veoOperationName,
        } as GenerateVideosOperation,
      });
    } catch (error) {
      // Transient network hiccup — report the last known state and let
      // the client's poll loop retry rather than failing the whole job.
      this.logger.warn(`Veo status check failed, will retry: ${error}`);
      return current;
    }

    if (!operation.done) {
      return current; // still rendering
    }

    if (operation.error) {
      return await this.markFailed(
        sessionId,
        current,
        'VIDEO_GENERATION_FAILED',
        String(
          operation.error['message'] || 'Veo failed to generate the video',
        ),
        true,
      );
    }

    const video = operation.response?.generatedVideos?.[0]?.video;
    if (!video) {
      return await this.markFailed(
        sessionId,
        current,
        'VIDEO_GENERATION_NO_OUTPUT',
        'Veo reported completion but returned no video',
        true,
      );
    }

    let videoBuffer: Buffer;
    let blobUrl: string;
    try {
      videoBuffer = await this.downloadVeoVideo(video);
      ({ url: blobUrl } = await this.blobService.uploadBuffer(
        current.pathname,
        videoBuffer,
        'video/mp4',
      ));
    } catch (error) {
      return await this.markFailed(
        sessionId,
        current,
        'VIDEO_DOWNLOAD_FAILED',
        this.extractErrorMessage(error),
        true,
      );
    }

    const completed: GeneratedVideo = {
      ...current,
      status: GenerationStatus.COMPLETE,
      completedAt: new Date(),
      fileSize: videoBuffer.length,
      downloadUrl: blobUrl,
    };

    await this.sessionService.updateSession(sessionId, {
      generatedVideo: completed,
      status: SessionStatus.VIDEO_COMPLETE,
    });

    // Этап 60 (ТЗ §40): счётчик «дошёл до первой генерации» страницы
    // шеринга, с которой начата эта сессия — best-effort, не должен
    // мешать пользователю получить только что готовый ролик.
    await this.sharedVideos.markConverted(session.sharedFromPageId);

    this.logger.log(`Video generation complete for session ${sessionId}`);

    // §15.4/§16.1: доводим ролик — обрезаем кадр, если формат не родной
    // для Veo, и накладываем свою озвучку, если её заказал бренд. Ролик
    // пользователю уже отдан, поэтому запуск не может ничего сломать:
    // сервис не настроен или задача упала — остаётся исходный файл.
    return this.postprod.start(sessionId, completed);
  }

  /**
   * Fetch the rendered video's bytes. Veo either inlines them
   * (`videoBytes`, base64) or returns a temporary Google-hosted `uri` that
   * has to be downloaded via the SDK (which handles the required auth) —
   * handle both.
   */
  private async downloadVeoVideo(video: Video): Promise<Buffer> {
    if (video.videoBytes) {
      return Buffer.from(video.videoBytes, 'base64');
    }

    const tmpPath = path.join(os.tmpdir(), `veo-${uuidv4()}.mp4`);
    try {
      await this.genai.files.download({ file: video, downloadPath: tmpPath });
      return await fs.readFile(tmpPath);
    } finally {
      await fs.unlink(tmpPath).catch(() => undefined);
    }
  }

  private async markFailed(
    sessionId: string,
    current: GeneratedVideo,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<GeneratedVideo> {
    const errorDetail: GenerationError = {
      code,
      message,
      timestamp: new Date(),
      retryable,
    };

    const failed: GeneratedVideo = {
      ...current,
      status: GenerationStatus.FAILED,
      error: errorDetail,
    };

    await this.sessionService.updateSession(sessionId, {
      generatedVideo: failed,
      status: SessionStatus.ERROR,
    });

    // Этап 62 (ТЗ §41.1): если попытка была оплачена кредитом — кредит
    // возвращается на баланс. Best-effort и идемпотентно (см.
    // `CreditLedgerService.refundIfReserved`) — купленный и не
    // потраченный кредит обязаны вернуть, но сбой возврата не должен
    // мешать пользователю узнать, что рендер упал.
    await this.creditLedger.refundIfReserved(current.generatedVideoId);

    // ТЗ §28: самый дорогой вызов сервиса не состоялся — об этом узнают
    // из канала, а не от пользователя. Отпечаток — код ошибки без
    // идентификатора сессии: провайдер падает сразу для всех, и три
    // сотни одинаковых строк в канале равны нулю строк.
    //
    // В канал уходит только начало идентификатора сессии (этап 47,
    // В-3.5): полный UUID — предъявительский ключ анонимной сессии
    // (§7.8), а сообщение в чате пересылают и скриншотят. Для сверки с
    // логами Vercel восьми символов достаточно.
    await this.notify.alert(
      `veo:${code}`,
      `Генерация не удалась: ${code}. ${message}\nСессия ${sessionId.slice(0, 8)}…`,
    );

    this.logger.error(
      `Video generation failed for session ${sessionId}: ${message}`,
    );

    return failed;
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return 'Unknown error during video generation';
  }
}
