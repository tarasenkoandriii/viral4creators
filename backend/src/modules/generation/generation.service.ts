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
  VideoGenerationReferenceImage,
  VideoGenerationReferenceType,
} from '@google/genai';
import { createGeminiClient, geminiApiKey } from '../../common/gemini-client';
import { SessionService } from '../../common/session.service';
import { PlanService } from '../plan/plan.service';
import { CreditLedgerService } from '../credit-ledger/credit-ledger.service';
import {
  GrokVideoService,
  GrokResolution,
  effectiveGrokResolution,
} from './grok-video.service';
import { GrokVideoBatchService } from './grok-video-batch.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import {
  GROK_VIDEO_TRANSPORT_SETTING_KEY,
  GrokVideoTransportKey,
  resolveGrokVideoTransport,
} from './grok-video-transport';
import { PromptService } from '../prompt/prompt.service';
import {
  buildExtensionPlan,
  chainCostMicroUsd,
} from '../../common/video-extension-plan';
import { pickVeoModel, usesVeo30 } from '../../common/veo-model-choice';
import {
  cameraBriefCorrection,
  normalizeCameraMove,
} from '../../common/camera-move';
import { estimateCost } from '../../common/ai-pricing';
import { DailySpendLimitExceededException } from '../../common/spend-limits';
import {
  featureDeniedMessage,
  planAllows,
  resolveTargetAspectRatio,
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
import { activeProductImage } from '../../common/active-image';
import { readinessOfSession } from '../../common/wizard-readiness.session';

/**
 * Model IDs for each quality tier, on the Gemini Developer API (not
 * Vertex AI — see the VideoQuality doc comment in generation.types.ts for
 * why "fast" maps to Lite rather than a dedicated Fast model).
 */

export const VEO_MODELS: Record<VideoQuality, string> = {
  fast: 'veo-3.1-lite-generate-preview',
  standard: 'veo-3.1-generate-preview',
};

const DEFAULT_QUALITY: VideoQuality = 'fast';

/**
 * Доп. запрос владельца продукта, по итогам реального аудита (пролив
 * пива, битый текстовый оверлей, лишний звук, резкий обрыв в конце):
 * Veo поддерживает `negativePrompt` на Vertex AI и для более старой
 * Veo 3.0 через Gemini API (официальный пример Google — "barking,
 * woofing" для ролика с собакой). Этот же параметр отсутствует в
 * официальной таблице параметров именно Veo 3.1 (в отличие от
 * aspectRatio/durationSeconds, которые в ней есть), а у Veo 3.1 через
 * Gemini Developer API (не Vertex) уже есть задокументированная
 * история параметров «в доке есть, API отвечает 400 not supported» —
 * reference_images, last_frame, personGeneration=allow_adult, и ровно
 * так же вела себя generateAudio (см. её собственную историю в этом
 * файле) до этапа, где её убрали совсем.
 *
 * ОБНОВЛЕНО (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §1, этап 5 плана
 * §14): изначальное решение здесь было НЕ подключать `negativePrompt`
 * вовсе, чтобы не рисковать сломать ВСЕ генерации разом ради ещё не
 * подтверждённого улучшения. По прямому запросу подключено — но не
 * широко, а УЗКО: только когда авто-выбор (`veo-model-choice.ts`,
 * `usesVeo30()`) сам определил, что сессия идёт на Veo 3.0 (нет
 * персонажей бренда + `quality: 'standard'`) — там `negativePrompt`
 * подтверждён официально, риск сломать Veo 3.1-трафик не возникает,
 * потому что 3.1-трафик этот параметр вообще не видит (см.
 * `startVeoGeneration`, `isVeo30`/`avoidText`). Точный ID модели Veo
 * 3.0 всё ещё не подтверждён (`common/ai-pricing.ts`) — тот же
 * принцип «сначала проверить на одном ручном вызове», просто
 * сработавший только на этой узкой ветке, а не блокирующий её
 * реализацию целиком.
 */

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

/** Batch API xAI — «обычно до 24 часов»; запас сверху, чтобы не
 * закрыть сбоем пачку, которую xAI ещё честно обрабатывает. */
export const BATCH_RENDER_DEADLINE_MS = 26 * 60 * 60 * 1000;

/** Сколько сессий с Grok-пачкой досматривает один крон-тик. */
export const GROK_BATCH_SYNC_BATCH = 50;

/** Сколько сессий с зависшей постобработкой досматривает один крон-тик. */
export const POSTPROD_SYNC_BATCH = 50;

export function renderExpired(
  video: Pick<GeneratedVideo, 'initiatedAt' | 'xaiBatchId'>,
  now: number = Date.now(),
): boolean {
  // Даты из JSON приходят строками.
  const started = new Date(video.initiatedAt).getTime();
  const deadline = video.xaiBatchId
    ? BATCH_RENDER_DEADLINE_MS
    : RENDER_DEADLINE_MS;
  return Number.isFinite(started) && now - started > deadline;
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
/** М-6.5 седьмого аудита: скачивание готового ролика — с таймаутом. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

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
    private readonly grokVideo: GrokVideoService,
    private readonly promptService: PromptService,
    // Транспорт Grok для одиночных роликов (доп. запрос владельца
    // продукта, 14.09.2026): батч-клиент и настройка стенда.
    private readonly grokBatch: GrokVideoBatchService,
    private readonly settings: PlatformSettingsService,
  ) {
    // Ключ — явно в SDK (этап 53, В-6.15): `new GoogleGenAI({})` читал
    // только свои переменные, и GOOGLE_GEMINI_API_KEY до него не доходил.
    this.genai = createGeminiClient();
  }

  /**
   * Start a Veo or Grok video generation job (ТЗ
   * VEO-MODEL-VERSION-CHOICE-SPEC.md §10–11, этап 1 плана реализации).
   * @param sessionId - Session UUID
   * @param quality - 'fast' (default, Lite model) or 'standard' (full Veo 3.1) — только для `provider === 'veo'`.
   * @param provider - 'veo' (default, текущее поведение) или 'grok'.
   * @param resolution - только для `provider === 'grok'`; Veo разрешение не запрашивает явно (§10.1 ТЗ).
   * @param targetDurationSeconds - доп. запрос владельца продукта (§9,
   *   этап 4 плана §14): ролик длиннее 8 секунд через Scene Extension.
   *   `undefined`/`<= 8` — обычная, однократная генерация, как раньше.
   * @param avoidText - доп. запрос владельца продукта (§1/§6, этап 5
   *   плана §14): поле «Чего избежать» — `negativePrompt` на Veo 3.0,
   *   best-effort строкой в промпт иначе (§4.1 ТЗ).
   * @returns Generated video metadata with PROCESSING status
   */
  async generateVideo(
    sessionId: string,
    quality: VideoQuality = DEFAULT_QUALITY,
    aspectRatio?: string,
    // Найдено при попытке сменить это на 'grok' (ТЗ §20): десятки тестов
    // в этом файле вызывают `generateVideo('s1')` без явного provider,
    // и мок `grokVideo.isConfigured()` там по умолчанию `false` — смена
    // дефолта уронила бы их все разом ради изменения, которое НИ ОДИН
    // реальный вызывающий не использует (мастер всегда шлёт provider
    // явно из своего собственного состояния — вот где Grok реально стал
    // выбором по умолчанию, см. `GenerationWizard.tsx`; остальные —
    // admin-retry/export сохраняют исходный провайдер, ab-test/catalog-
    // batch теперь тоже передают 'veo' явно). Дефолт этого параметра —
    // мёртвый код на практике; оставлен 'veo' как самый безопасный
    // фолбэк для гипотетического будущего вызывающего, который забудет
    // его указать.
    provider: 'veo' | 'grok' = 'veo',
    resolution?: GrokResolution,
    targetDurationSeconds?: number,
    avoidText?: string,
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
    // Б-2.4 второго аудита (этап 120): проверять ПРИСЛАННЫЙ параметр
    // мало — рендерится не он, а `выбор ?? формат референса ?? 9:16`.
    // Пустое тело запроса («сгенерируй») проверку минувало целиком, и
    // Lite с референсом 1080×1350 получал ролик 4:5 — формат, закрытый
    // для его режима, — вместе с оплаченным проходом ffmpeg на обрезку.
    // Замок держался только тем, что интерфейс туда не пускает.
    const frameOfReference = owner?.originalVideo?.frame?.aspectRatio;
    const resolvedTarget = resolveTargetAspectRatio(
      access.plan,
      aspectRatio,
      frameOfReference,
    );
    if (resolvedTarget.denied) {
      throw new ForbiddenException(featureDeniedMessage('customAspectRatio'));
    }
    if (resolvedTarget.clamped) {
      this.logger.log(
        `сессия ${sessionId}: формат референса ${frameOfReference} закрыт для режима ${access.plan} — рендерим в ${resolvedTarget.target} (никто его не выбирал, отказывать не за что)`,
      );
    }
    // Этап 47 (В-2.6): полная модель в 2,7 раза дороже Lite, а параметр
    // приходит телом запроса — проверяем, как и формат кадра. У Grok
    // нет понятия `quality` (§11.2 ТЗ — там своя ось, разрешение) —
    // проверка применима только к `provider === 'veo'`.
    if (
      provider === 'veo' &&
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

    // Доп. запрос владельца продукта (ТЗ §9.4, этап 4 плана §14) —
    // ролик длиннее 8 секунд через Scene Extension.
    let extensionPlan: ReturnType<typeof buildExtensionPlan> | undefined;
    if (
      targetDurationSeconds &&
      targetDurationSeconds > VIDEO_DURATION_SECONDS
    ) {
      // Явный запрет для Lite — независимо от провайдера (§9.4 ТЗ):
      // не влезает НИ В ОДНУ комбинацию по деньгам (проверено в самом
      // ТЗ, §11.6/§9.4), поэтому явная подпись «недоступно», а не
      // ожидание, что бюджетная проверка ниже откажет сама.
      if (access.plan === 'LITE') {
        throw new ForbiddenException(
          'Ролики длиннее 8 секунд недоступны на тарифе Lite',
        );
      }

      extensionPlan = buildExtensionPlan(
        provider,
        targetDurationSeconds,
        session.videoAnalysis?.referenceDurationSeconds,
      );

      // Бюджет всей цепочки — заранее, целиком, не по одному вызову за
      // раз (§9.4 ТЗ): иначе ролик мог бы оборваться посередине от
      // нехватки денег, а не по выбору длины.
      // Найдено при аудите (ТЗ §7, тот же принцип): цена цепочки должна
      // отражать РЕАЛЬНО выбранную модель, не только тир качества —
      // иначе оценка бюджета молча разойдётся с реальным списанием в
      // момент, когда цены Veo 3.0/3.1 перестанут случайно совпадать
      // (сейчас у обеих $0.40/сек, но `common/ai-pricing.ts` явно
      // помечает цену Veo 3.0 как неподтверждённую).
      const model =
        provider === 'grok'
          ? // М-2.8: оценка цепочки — по фактическому разрешению (референсы
            // бренда → 720p); та же функция, что у учёта.
            `${this.grokVideo.modelName}:${effectiveGrokResolution(
              resolution ?? '480p',
              { references: !buildReferencePlan(session).legacyFirstFrame },
            )}`
          : pickVeoModel(
              buildReferencePlan(session),
              quality,
              VEO_MODELS[quality],
            );
      const perCallEstimate = estimateCost(model, {
        seconds: VIDEO_DURATION_SECONDS,
      });
      const totalChainCostMicroUsd = chainCostMicroUsd(
        extensionPlan,
        perCallEstimate.costMicroUsd,
      );
      const verdict = await this.aiUsage.budget(
        owner?.userId ?? null,
        access.spendPlan,
      );
      if (
        verdict.allowed &&
        verdict.remainingMicroUsd < totalChainCostMicroUsd
      ) {
        this.logger.warn(
          `сессия ${sessionId}: цепочка из ${extensionPlan.totalCalls} вызовов ` +
            `(${totalChainCostMicroUsd} мкд) не помещается в остаток дневного лимита ` +
            `(${verdict.remainingMicroUsd} мкд) — отказ целиком, не частично`,
        );
        throw new DailySpendLimitExceededException(
          `Ролик на ${extensionPlan.targetDurationSeconds} секунд стоил бы больше остатка дневного лимита — выберите короче или попробуйте завтра`,
        );
      }
      if (!verdict.allowed) {
        // Обычная проверка ниже (в startGeneration/startVeoGeneration)
        // всё равно откажет — здесь просто не даём цепочке начаться
        // с заведомо нулевым остатком, с тем же классом ошибки.
        throw new DailySpendLimitExceededException(
          'Дневной лимит расхода уже исчерпан',
        );
      }
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
      // М-2.7 седьмого аудита: проверка «рендер уже идёт» выше сделана по
      // снимку, прочитанному ДО замка; запрос, прочитавший сессию до
      // записи `generatedVideo` конкурентом и взявший замок после его
      // `releaseWork`, запустил бы второй платный рендер. Перечитываем.
      const fresh = await this.sessionService.getSession(sessionId);
      const freshInFlight = fresh?.generatedVideo;
      if (
        freshInFlight &&
        (freshInFlight.status === GenerationStatus.PENDING ||
          freshInFlight.status === GenerationStatus.PROCESSING)
      ) {
        this.logger.warn(
          `сессия ${sessionId}: рендер стартовал параллельно между чтением и замком — возвращаю его же`,
        );
        return freshInFlight;
      }
      return await this.startGeneration(
        fresh ?? session,
        quality,
        // Ниже по стеку — уже РЕШЁННЫЙ формат, а не то, что прислал
        // клиент: он прошёл проверку режима, и второй раз выводить его
        // из референса (по-разному у Veo и у Grok, см. Б-2.4) больше
        // негде и незачем.
        resolvedTarget.target,
        provider,
        resolution,
        extensionPlan,
        avoidText,
      );
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
    /** Уже решённый и проверенный по режиму формат (Б-2.4, этап 120). */
    target?: string,
    // Недостижимо на практике — `generateVideo()` всегда передаёт
    // `provider` явно. Оставлен 'veo' — см. её же доккомментарий выше
    // про то, почему смена этого дефолта не даёт пользы и рискованна.
    provider: 'veo' | 'grok' = 'veo',
    resolution?: GrokResolution,
    extensionPlan?: ReturnType<typeof buildExtensionPlan>,
    avoidText?: string,
  ): Promise<GeneratedVideo> {
    const sessionId = session.sessionId;
    // Тот же список, что рисует строку «до готового ролика» (§7.2 п.3):
    // два независимых списка условий расходятся — это не гипотеза, а то,
    // как ведут себя любые два списка.
    const ready = readinessOfSession(session);
    const done = (key: string) =>
      ready.items.find((i) => i.key === key)?.done === true;

    if (!done('prompt')) {
      throw new BadRequestException(
        'Prompt must be approved before generating video',
      );
    }

    // Изображение товара — только через резолвер: при применённом
    // скетче в Veo уходит скетч, а оригинал не читается вовсе
    // (§4 п.1 doc/AI-SKETCH-SPEC.md). Готовность смотрит туда же — тем
    // же `activeProductImage`, поэтому отдельного чтения здесь больше
    // нет.
    if (!done('photo')) {
      throw new BadRequestException(
        'Product image must be uploaded before generating video',
      );
    }

    const generatedVideoId = uuidv4();
    // Доп. запрос владельца продукта: история версий. Раньше путь был
    // фиксированным (`sessions/${sessionId}/generated.mp4`) — каждая
    // новая попытка молча ЗАТИРАЛА файл предыдущей в Blob, так что
    // «показать прошлую версию» было невозможно даже теоретически: её
    // уже не существовало. Уникальный путь на попытку хранит каждую
    // версию отдельно; уборка старых версий — открытый вопрос (список
    // может расти), но это дешевле, чем терять файлы безвозвратно.
    const pathname = `sessions/${sessionId}/generated-${generatedVideoId}.mp4`;

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
      // Проект передаётся ради тестового доступа (TODO §III п.37): без
      // него самая дорогая операция продукта осталась бы под потолком
      // даже у тестировщика, ради которого доступ и выдавали.
      await this.plans.assertCanSpendUser(session.userId ?? null, {
        projectId: session.projectId ?? null,
      });
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
      return provider === 'grok'
        ? await this.startGrokGeneration(
            session,
            sessionId,
            generatedVideoId,
            pathname,
            resolution ?? '480p',
            target,
            extensionPlan,
            avoidText,
          )
        : await this.startVeoGeneration(
            session,
            sessionId,
            generatedVideoId,
            pathname,
            quality,
            target,
            extensionPlan,
            avoidText,
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
    extensionPlan?: ReturnType<typeof buildExtensionPlan>,
    avoidText?: string,
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
    // Тот же резолвер, что и в `generateVideo` выше: при скетче в Veo
    // уходит он, а не оригинал (§4 п.1 doc/AI-SKETCH-SPEC.md).
    const productImage = activeProductImage(session.productInformation);
    if (!productImage?.pathname) {
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
      // Скетч сюда попасть не может: `buildReferencePlan` при скетче
      // товара всегда отдаёт режим референсов (§5.6 ТЗ скетча).
      const imageBuffer = await this.blobService.downloadBuffer(
        productImage.pathname,
      );
      imageInput = {
        imageBytes: imageBuffer.toString('base64'),
        mimeType: productImage.mimeType || 'image/png',
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

    // Spec §16: the target format was resolved once by the caller —
    // explicit choice, else the reference's detected frame, else
    // vertical, приведённый к разрешённому для режима (Б-2.4, этап
    // 120). Здесь только страховка на случай вызывающего, который
    // придёт мимо `generateVideo`. Non-native targets render in the
    // nearest Veo frame with a composition note for the later crop.
    const target =
      normaliseAspectRatio(aspectRatio) ??
      session.originalVideo?.frame?.aspectRatio ??
      '9:16';
    let render = planRender(target);

    // Доп. запрос владельца продукта (ТЗ §1/§6, этап 5 плана §14) —
    // пониженный приоритет (см. доккомментарий `veo-model-choice.ts`):
    // Veo 3.0 только для `standard` без персонажей бренда — у Veo 3.0
    // нет Lite-аналога, `fast` всегда остаётся на Veo 3.1 Lite, как и
    // раньше.
    const veoModel = pickVeoModel(plan, quality, VEO_MODELS[quality]);
    const isVeo30 = usesVeo30(plan, quality);
    // «Чего избежать» — настоящий `negativePrompt` на Veo 3.0 (§1 ТЗ);
    // иначе (Veo 3.1, `fast`) — best-effort строкой в промпт (§4.1 ТЗ):
    // `negativePrompt` там не подтверждён (§3 ТЗ), молчаливая потеря
    // ввода пользователя хуже, чем более слабый эффект.
    const promptText = [
      session.generationPrompt.finalText,
      // Spec §17: the authoritative "reference image N = …" mapping, computed
      // now — slots may have been re-chosen after the prompt was written.
      referenceMappingText(plan),
      `Output format: ${render.rendered} ${render.rendered === '9:16' ? 'vertical' : 'horizontal'} video.`,
      render.compositionNote ?? '',
      // В-1.9 третьего аудита (этап 120): амплитуда движения камеры
      // ушла в промпт по формату РЕФЕРЕНСА — другого значения в тот
      // момент не было, формат выбирают позже, здесь. Если «неродность»
      // формата с тех пор изменилась, амплитуда в тексте неверна: либо
      // наезд второй раз съест безопасную зону будущей обрезки, либо
      // движение напрасно урезано до дрожания. Поправка считается
      // сейчас — тем же приёмом, что и карта референсов строкой выше.
      cameraBriefCorrection(
        // Движение и формат берутся из ЗАПИСИ промпта, а не из снимка
        // манифеста и не из референса сессии: снимок можно сменить
        // между шагами, а у засеянной сессии (экспорт яруса B, A/B)
        // своего референса нет вовсе. Поправлять надо от того, что
        // реально попало в текст. Старые промпты записи не имеют —
        // для них прежний источник, как и раньше.
        session.generationPrompt.cameraBriefFor?.move ??
          normalizeCameraMove(session.brandManifestSnapshot?.cameraMove),
        session.generationPrompt.cameraBriefFor?.aspectRatio ??
          session.originalVideo?.frame?.aspectRatio,
        target,
      ),
      avoidText && !isVeo30 ? `Avoid: ${avoidText}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const start = (frame: VeoAspectRatio) =>
      this.genai.models.generateVideos({
        model: veoModel,
        prompt: promptText,
        ...(imageInput ? { image: imageInput } : {}),
        config: {
          durationSeconds: VIDEO_DURATION_SECONDS,
          aspectRatio: frame,
          ...(referenceImages ? { referenceImages } : {}),
          ...(avoidText && isVeo30 ? { negativePrompt: avoidText } : {}),
        },
      });

    let operation: GenerateVideosOperation;
    try {
      this.logger.log(
        `Starting Veo (${quality} -> ${veoModel}, ${render.rendered} for target ${target}) generation for session ${sessionId}`,
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
        model: veoModel,
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
        // М-2.4 седьмого аудита: целевая длительность пишется всегда,
        // когда план строился — у Grok 9–15 с это ОДИН нативный вызов
        // без цепочки, и без этого поля субтитры/перерендер/админ-повтор
        // считали ролик восьмисекундным.
        ...(extensionPlan
          ? { chainTargetDurationSeconds: extensionPlan.targetDurationSeconds }
          : {}),
        ...(extensionPlan && extensionPlan.totalCalls > 1
          ? {
              chainSegmentsDone: 1,
              chainSegmentsTotal: extensionPlan.totalCalls,
              chainSegmentSeconds: extensionPlan.segments,
            }
          : {}),
        ...(avoidText ? { avoidText } : {}),
      };

      // Доп. запрос владельца продукта: полная история версий. Уходящая
      // попытка архивируется РОВНО здесь — в момент, когда её всё равно
      // заменяет новая, и только если она уже завершилась (COMPLETE
      // или FAILED). Идущую (PENDING/PROCESSING) сюда попасть не
      // может: `generateVideo()` выше возвращает её же вместо повторного
      // старта (Б-2.3) — до этого момента дело просто не доходит.
      const previous = session.generatedVideo;
      const previousFinished =
        previous &&
        (previous.status === GenerationStatus.COMPLETE ||
          previous.status === GenerationStatus.FAILED);
      const videoHistory = previousFinished
        ? [previous, ...(session.videoHistory ?? [])]
        : (session.videoHistory ?? []);

      await this.sessionService.updateSession(sessionId, {
        generatedVideo,
        videoHistory,
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
   * Аналог `startVeoGeneration` для Grok (ТЗ
   * VEO-MODEL-VERSION-CHOICE-SPEC.md §10–11, этап 1 плана реализации).
   *
   * Область этой первой версии — НАМЕРЕННО ограничена: поддерживается
   * только `plan.legacyFirstFrame` (одно фото товара, тот же путь, что
   * у Veo без персонажей бренда) — множественные референс-изображения
   * персонажей («reference-to-video» у Grok, до 7 изображений, §10.1
   * ТЗ) НЕ реализованы в этом проходе: тот режим не исследован так же
   * тщательно (форма запроса под несколько `image_url` не подтверждена
   * документацией так, как подтверждён простой `image_url`) — честнее
   * явно отказать, чем притвориться, что работает. Сессии с
   * персонажами остаются на Veo, пока это не будет отдельно
   * реализовано.
   */
  private async startGrokGeneration(
    session: Session,
    sessionId: string,
    generatedVideoId: string,
    pathname: string,
    resolution: GrokResolution,
    aspectRatio?: string,
    extensionPlan?: ReturnType<typeof buildExtensionPlan>,
    avoidText?: string,
  ): Promise<GeneratedVideo> {
    if (!this.grokVideo.isConfigured()) {
      throw new BadRequestException(
        'Grok video provider is not configured (GROK_API_KEY missing)',
      );
    }

    const plan = buildReferencePlan(session);

    let imageUrl: string | undefined;
    let referenceImageUrls: string[] | undefined;
    let sceneText: string;
    if (plan.legacyFirstFrame) {
      const productImageUrl = activeProductImage(
        session.productInformation,
      )?.url;
      if (!productImageUrl) {
        throw new BadRequestException(
          'Product image URL is required for Grok generation (productImageUrl missing on session)',
        );
      }
      imageUrl = productImageUrl;
      sceneText = session.generationPrompt!.finalText;
    } else {
      // Доп. запрос владельца продукта: reference-to-video (ТЗ §15) —
      // тот же XOR, что у Veo (`image` vs `referenceImages`), просто
      // с другими полями запроса.
      referenceImageUrls = await Promise.all(
        plan.images.map((ref) => this.resolveReferenceUrl(ref)),
      );
      // Доп. запрос владельца продукта (ТЗ §15.3): переписанная версия
      // ЗАМЕНЯЕТ исходный текст сцены, а не добавляется к нему — она
      // уже содержит всё содержимое сцены, просто с вплетёнными метками
      // <IMAGE_N> (см. доккомментарий `rewriteForGrokReferences`).
      // Конкатенация с оригиналом задвоила бы описание сцены целиком.
      // Откатывается на прежнее приближение сам при сбое.
      sceneText = await this.promptService.rewriteForGrokReferences(
        session.generationPrompt!.finalText,
        plan,
        sessionId,
      );
      this.logger.log(
        `Grok reference-to-video: ${plan.images
          .map((i) => `#${i.index} ${i.kind}:${i.label}`)
          .join(', ')}`,
      );
    }

    const target = normaliseAspectRatio(aspectRatio) ?? '9:16';
    // §16 на пути Grok (этап 120). До этого здесь целевой формат был
    // либо явным выбором, либо вертикалью — неродные форматы просто не
    // доезжали. С этапа 120 сюда приезжает и формат референса (тот же
    // `resolveTargetAspectRatio`, что у Veo), а значит и неродной: без
    // этих трёх строк в xAI ушло бы `aspect_ratio: '4:5'`, чего он не
    // обещает, подпись «horizontal» к вертикальному кадру (строка
    // ниже сравнивала ровно с '9:16') и запись в сессию «файл 4:5»,
    // которую никто не проверял. Поэтому — тот же приём, что у Veo:
    // рендерим в ближайшем родном, обрезку помечаем как ещё должную.
    const render = planRender(target);
    // «Чего избежать» на Grok — тот же best-effort приём, что у Veo 3.1
    // (§4.1 ТЗ): решённый открытый вопрос §9.4 — Grok не рассматривался
    // в §1–7, потому что писались до появления Grok в этом ТЗ; решено
    // не заводить отдельную логику, а переиспользовать тот же приём.
    const promptText = [
      sceneText,
      `Output format: ${render.rendered === '9:16' ? 'vertical' : 'horizontal'} video.`,
      render.compositionNote ?? '',
      cameraBriefCorrection(
        session.generationPrompt?.cameraBriefFor?.move ??
          normalizeCameraMove(session.brandManifestSnapshot?.cameraMove),
        session.generationPrompt?.cameraBriefFor?.aspectRatio ??
          session.originalVideo?.frame?.aspectRatio,
        target,
      ),
      avoidText ? `Avoid: ${avoidText}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const baseSegmentSeconds =
      extensionPlan?.segments[0] ?? VIDEO_DURATION_SECONDS;

    // Транспорт — операторская настройка стенда (`grok-video-transport.ts`):
    // читается при каждом старте, так что смена в админке действует на
    // следующий ролик без передеплоя; уже начатый ролик дорисовывается
    // своим транспортом (см. `continueGrokChain`).
    const transport = await this.grokTransport();

    let requestId: string | undefined;
    let xaiBatchId: string | undefined;
    let xaiBatchRequestId: string | undefined;
    try {
      this.logger.log(
        `Starting Grok (${this.grokVideo.modelName}, ${resolution}, ${baseSegmentSeconds}s, ${transport}) generation for session ${sessionId}`,
      );
      if (transport === 'batch') {
        // Пачка из одного запроса; ключ запроса — id этой попытки.
        xaiBatchRequestId = generatedVideoId;
        const submitted = await this.grokBatch.submitBatch(
          `single-${sessionId}-${generatedVideoId}`,
          [
            {
              batchRequestId: xaiBatchRequestId,
              prompt: promptText,
              imageUrl,
              referenceImageUrls,
              durationSeconds: baseSegmentSeconds,
              aspectRatio: render.rendered,
              resolution,
            },
          ],
        );
        if (submitted.error) throw new Error(submitted.error);
        xaiBatchId = submitted.xaiBatchId;
      } else {
        ({ requestId } = await this.grokVideo.startGeneration({
          prompt: promptText,
          imageUrl,
          referenceImageUrls,
          // Сбой 14.09.2026 («при любой длительности — 8 секунд»): у Grok
          // длительность нативная (1–15 с), берём её из плана, а не из
          // константы Veo. Без плана (запрос ≤ 8 с) — прежние 8.
          durationSeconds: baseSegmentSeconds,
          aspectRatio: render.rendered,
          resolution,
        }));
      }
    } catch (error) {
      this.logger.error('Failed to start Grok generation:', error);
      // М-1.8 седьмого аудита (остаток Е-1.2 для Grok-пути): транзиентный
      // 429/5xx или сетевой обрыв — ServiceUnavailableException, чтобы
      // воркеры партии/A-B ретраили, а не хоронили строку навсегда.
      const message = this.extractErrorMessage(error);
      const httpStatus = Number(/HTTP (\d{3})/.exec(message)?.[1] ?? NaN);
      const transient =
        (Number.isFinite(httpStatus) &&
          (httpStatus === 429 || httpStatus >= 500)) ||
        /timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message);
      if (transient) {
        throw new ServiceUnavailableException(
          `Grok временно недоступен: ${message}`,
        );
      }
      throw new BadRequestException(
        `Failed to start video generation: ${message}`,
      );
    }

    // Тот же принцип «с этой точки деньги, скорее всего, уже
    // потрачены», что у Veo выше (Е-1.4) — тот же класс ошибки
    // (`VeoOperationOrphanedError`, имя историческое, значение —
    // «операция стартовала у провайдера, а мы её потеряли» — не
    // специфично для Veo как такового; переименовывать не стал, чтобы
    // не задевать классификацию `NON_RETRYABLE_NAMES` в воркерах
    // партии/A-B, которая проверяет это имя по строке).
    try {
      await this.aiUsage.record({
        operation: 'generation',
        // Составной ключ — та же цена по разрешению, что в
        // `common/ai-pricing.ts` (§11.5/§10.2 ТЗ): одна модель Grok,
        // три разные ставки, не одна.
        // М-6.6/М-1.7: ставка — по ФАКТИЧЕСКОМУ разрешению (референсы →
        // не выше 720p), иначе журнал дороже реального счёта xAI.
        model: `${this.grokVideo.modelName}:${effectiveGrokResolution(resolution, { references: !!referenceImageUrls?.length })}`,
        seconds: baseSegmentSeconds,
        sessionId,
      });

      const generatedVideo: GeneratedVideo = {
        generatedVideoId,
        pathname,
        fileName: 'generated.mp4',
        mimeType: 'video/mp4',
        status: GenerationStatus.PROCESSING,
        initiatedAt: new Date(),
        provider: 'grok',
        resolution,
        ...(requestId ? { grokRequestId: requestId } : {}),
        ...(xaiBatchId ? { xaiBatchId, xaiBatchRequestId } : {}),
        aspectRatio: target,
        // Что реально отрендерено и осталась ли обрезка — как у Veo
        // (этап 120): раньше здесь стояли `undefined`/`false`, то есть
        // сессия утверждала, что файл уже в целевом формате.
        renderedAspectRatio: render.reframe ? render.rendered : undefined,
        reframePending: render.reframe,
        references: plan.images.map((i) => ({
          index: i.index,
          kind: i.kind,
          label: i.label,
          characterId: i.characterId,
        })),
        // М-2.4 седьмого аудита: целевая длительность пишется всегда,
        // когда план строился — у Grok 9–15 с это ОДИН нативный вызов
        // без цепочки, и без этого поля субтитры/перерендер/админ-повтор
        // считали ролик восьмисекундным.
        ...(extensionPlan
          ? { chainTargetDurationSeconds: extensionPlan.targetDurationSeconds }
          : {}),
        ...(extensionPlan && extensionPlan.totalCalls > 1
          ? {
              chainSegmentsDone: 1,
              chainSegmentsTotal: extensionPlan.totalCalls,
              chainSegmentSeconds: extensionPlan.segments,
            }
          : {}),
        ...(avoidText ? { avoidText } : {}),
      };

      const previous = session.generatedVideo;
      const previousFinished =
        previous &&
        (previous.status === GenerationStatus.COMPLETE ||
          previous.status === GenerationStatus.FAILED);
      const videoHistory = previousFinished
        ? [previous, ...(session.videoHistory ?? [])]
        : (session.videoHistory ?? []);

      await this.sessionService.updateSession(sessionId, {
        generatedVideo,
        videoHistory,
        status: SessionStatus.GENERATING_VIDEO,
      });

      return generatedVideo;
    } catch (error) {
      // Для батча зацепка — id пачки, для синхронного пути — request_id.
      const handle = requestId ?? xaiBatchId ?? '';
      this.logger.error(
        `КРИТИЧНО: Grok стартовал (${transport}=${handle}) для сессии ${sessionId}, но запись результата упала — рендер оплачен и идёт в фоне, но не привязан ни к чему в базе: ${this.extractErrorMessage(error)}`,
      );
      throw new VeoOperationOrphanedError(
        `Рендер уже стартовал (${handle}), но сохранить состояние не удалось — обратитесь в поддержку, не запускайте повторно`,
        handle,
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
    const res = await fetch(ref.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new BadRequestException(
        `Failed to fetch reference image ${ref.index} (${ref.label}): HTTP ${res.status}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * То же самое, что `fetchReference` выше, но возвращает URL, а не
   * байты — для Grok reference-to-video (ТЗ §15), который принимает
   * картинки ссылкой (§10.1 ТЗ), а не в теле запроса. Та же проверка
   * `isOwnBlobUrl`/`FOREIGN_BLOB_URL_MESSAGE`, что у `fetchReference` —
   * пусть здесь скачивает не наш сервер, а Grok, доверие к источнику
   * URL должно быть тем же самым, не слабее.
   */
  private async resolveReferenceUrl(
    ref: ReferenceImageSource,
  ): Promise<string> {
    if (ref.pathname) {
      return this.blobService.getPublicUrl(ref.pathname);
    }
    if (!ref.url) {
      throw new BadRequestException(
        `Reference image ${ref.index} (${ref.label}) has neither a pathname nor a URL`,
      );
    }
    if (!isOwnBlobUrl(ref.url)) {
      this.logger.warn(
        `референс ${ref.index} (${ref.label}) указывает вне нашего хранилища — пропущен`,
      );
      throw new BadRequestException(
        `Reference image ${ref.index} (${ref.label}): ${FOREIGN_BLOB_URL_MESSAGE}`,
      );
    }
    return ref.url;
  }

  /**
   * Check (and, if newly complete, resolve) video generation status.
   * Called repeatedly by the client's poll loop — makes at most one Veo
   * API call per invocation.
   * @param sessionId - Session UUID
   * @returns Current video generation status
   */
  /**
   * Доп. запрос владельца продукта: нужно контроллеру
   * (`GET /generate/estimate`, §11.3 ТЗ) — расчёт цены должен знать,
   * что для сессий с персонажами бренда Grok reference-to-video (§15
   * ТЗ) молча понижает `1080p` до `720p` (см.
   * `GrokVideoService.startGeneration`) — иначе дисклеймер показал бы
   * цену 1080p за ролик, который на самом деле выйдет 720p.
   */
  async isReferenceMode(sessionId: string): Promise<boolean> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) return false;
    return !buildReferencePlan(session).legacyFirstFrame;
  }

  /**
   * Найдено при аудите (ТЗ §7): контроллер (`GET /generate/estimate`,
   * §11.3) считал цену дисклеймера по `VEO_MODELS[quality]` напрямую,
   * не учитывая авто-выбор Veo 3.0 (§1, этап 5 плана §14) — тот же
   * пробел, что был в самой `generateVideo()` до этого исправления.
   * Сейчас у Veo 3.0/3.1 совпадает цена, поэтому расхождение раньше
   * было незаметным — но `common/ai-pricing.ts` прямо помечает цену
   * Veo 3.0 как неподтверждённую, и дисклеймер не должен молча
   * разойтись с ней в будущем.
   */
  async pickVeoModelForSession(
    sessionId: string,
    quality: VideoQuality,
  ): Promise<string> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) return VEO_MODELS[quality];
    return pickVeoModel(
      buildReferencePlan(session),
      quality,
      VEO_MODELS[quality],
    );
  }

  /**
   * Доп. запрос владельца продукта — нужен контроллеру
   * (`GET /generate/estimate`, §9.4/§11.3 ТЗ) для дисклеймера цены
   * цепочки: сколько секунд референс, если анализ его уже сообщил
   * (`AnalysisService`, вывод из `scenes[last].end`).
   */
  async getReferenceDurationSeconds(
    sessionId: string,
  ): Promise<{ referenceDurationSeconds?: number }> {
    const session = await this.sessionService.getSession(sessionId);
    return {
      referenceDurationSeconds:
        session?.videoAnalysis?.referenceDurationSeconds,
    };
  }

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

    if (current.provider === 'grok') {
      return this.pollGrokStatus(sessionId, session, current);
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

    // Раньше здесь стоял `this.genai.operations.getVideosOperation({
    // operation: { name: current.veoOperationName } as GenerateVideosOperation })`.
    // Это ломалось НА КАЖДОМ опросе: `getVideosOperation` рассчитан на
    // живой объект операции, полученный от предыдущего вызова SDK — тот
    // объект несёт приватный метод `_fromAPIResponse(...)`, которым SDK
    // сам себя обновляет по ответу API. Сессия между запросами хранит
    // только строку `veoOperationName` (это Vercel Function — прежний
    // живой объект не переживает инстанс, который его вернул), так что
    // подсунутый литерал `{ name }` этого метода не имеет —
    // `TypeError: operation._fromAPIResponse is not a function` на
    // каждый вызов, без единого исключения. Ошибка ловилась ниже и
    // тихо возвращала `current` — рендер никогда не мог завершиться,
    // только истечь по `renderExpired` через RENDER_DEADLINE_MS.
    // Опрашиваем сырой REST — то же самое, что делает официальный
    // REST-пример в доке Veo (`GET {base}/{operation_name}`), без
    // зависимости от внутренних (`_`-префиксных) деталей SDK.
    const apiKey = geminiApiKey();
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY or GOOGLE_GEMINI_API_KEY environment variable is required',
      );
    }

    let operation: {
      done?: boolean;
      error?: { message?: string };
      response?: {
        generateVideoResponse?: {
          generatedSamples?: Array<{ video?: { uri?: string } }>;
        };
      };
    };
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${current.veoOperationName}`,
        {
          headers: { 'x-goog-api-key': apiKey },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) {
        throw new Error(`Veo operation status HTTP ${res.status}`);
      }
      operation = await res.json();
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
        String(operation.error.message || 'Veo failed to generate the video'),
        true,
      );
    }

    const videoUri =
      operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video
        ?.uri;
    if (!videoUri) {
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
      videoBuffer = await this.downloadVeoVideo(videoUri);
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

    // Доп. запрос владельца продукта (ТЗ §9, этап 4 плана §14): сегмент
    // готов, но цепочка ещё не дописана — продолжаем расширением вместо
    // финализации. `blobUrl` здесь ещё пригодится: `current.pathname`
    // уже содержит РАСТУЩЕЕ видео (каждый следующий Veo-вызов основан на
    // последнем кадре предыдущего — см. `continueVeoChain`), так что
    // сохранение сюда же перед продолжением не теряется, только пока не
    // выдаётся пользователю как готовое.
    if (
      current.chainSegmentsTotal &&
      (current.chainSegmentsDone ?? 1) < current.chainSegmentsTotal
    ) {
      return await this.continueChainGuarded(sessionId, current, () =>
        this.continueVeoChain(sessionId, session, current, videoBuffer),
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
   * Fetch the rendered video's bytes from Veo's temporary Google-hosted
   * `uri` (2-day retention). The same API key that starts/polls the
   * operation authorises the download — same as the official REST
   * example (`x-goog-api-key` header), no SDK object required.
   */
  /**
   * Аналог основного тела `getVideoStatus` для Grok — тот же принцип
   * (дедлайн, провал помечен retryable, скачать и сохранить готовый
   * файл), но свой источник статуса и своё скачивание: у Grok видео
   * отдаётся обычной временной ссылкой, без заголовка авторизации,
   * который нужен для скачивания у Veo (`downloadVeoVideo`).
   *
   * Не пытается переиспользовать общий код с Veo-веткой ниже —
   * сознательный выбор: та ветка проверена в бою, трогать её ради
   * общего пути с ещё не проверенным на реальном трафике Grok — риск
   * не в ту сторону (см. доккомментарий `GrokVideoService` — три места
   * там прямо помечены как неподтверждённые).
   */
  /**
   * Крон-досмотр одиночных роликов, поданных через Batch API (М-1.2/
   * М-2.3/М-5.2 седьмого аудита) — тот же принцип, что
   * `ExportService.runSyncTick` для яруса B: статус двигается и без
   * открытой вкладки, результат (живёт у xAI час) скачивается в том же
   * тике, а `touchSessions` продлевает сессии, чтобы TTL-уборка не
   * удалила их раньше 26-часового дедлайна батча. Вызывается из
   * `ExportService.runSyncTick` (крон `export-sync-run`, каждые 2 мин).
   */
  async runGrokBatchSyncTick(
    limit: number = GROK_BATCH_SYNC_BATCH,
  ): Promise<{ checked: number; failed: number }> {
    const ids =
      await this.sessionService.findSessionsWithPendingGrokBatch(limit);
    if (ids.length === 0) return { checked: 0, failed: 0 };
    await this.sessionService.touchSessions(ids);
    let failed = 0;
    for (const id of ids) {
      try {
        await this.getVideoStatus(id);
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `крон-досмотр Grok-пачки: сессия ${id} — ${this.extractErrorMessage(error)}`,
        );
      }
    }
    return { checked: ids.length, failed };
  }

  /**
   * Крон-досмотр постобработки (обрезка кадра / своя озвучка,
   * `PostProductionService`) — тот же принцип, что `runGrokBatchSyncTick`
   * выше и `ExportService.runSyncTick` для яруса B. До этой правки
   * `postStatus` двигал ТОЛЬКО клиентский поллинг
   * (`GET /sessions/:id/video-status`, `useWorkflow.ts`): закрыл
   * приложение/свернул вкладку между «Veo закончил» и «ffmpeg-задача
   * готова» — `postStatus` остаётся `'pending'` навсегда, а вместе с ним
   * и собственный дедлайн постобработки (`postProductionExpired`),
   * который проверяется только внутри того же `poll()`. Пользователь
   * тем временем видит «Скачать» (видео как таковое готово) и получает
   * от аудита ролика бессрочный отказ «Ролик ещё обрабатывается».
   * `getVideoStatus()` внутри уже вызывает `postprod.poll()` для
   * `status === COMPLETE` — отдельного вызова `poll()` здесь не нужно.
   */
  async runPostProductionSyncTick(
    limit: number = POSTPROD_SYNC_BATCH,
  ): Promise<{ checked: number; failed: number }> {
    const ids =
      await this.sessionService.findSessionsWithPendingPostProduction(limit);
    if (ids.length === 0) return { checked: 0, failed: 0 };
    await this.sessionService.touchSessions(ids);
    let failed = 0;
    for (const id of ids) {
      try {
        await this.getVideoStatus(id);
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `крон-досмотр постобработки: сессия ${id} — ${this.extractErrorMessage(error)}`,
        );
      }
    }
    return { checked: ids.length, failed };
  }

  /** Настройка стенда «транспорт Grok» — см. `grok-video-transport.ts`. */
  private async grokTransport(): Promise<GrokVideoTransportKey> {
    return resolveGrokVideoTransport(
      await this.settings.get(GROK_VIDEO_TRANSPORT_SETTING_KEY),
    );
  }

  /**
   * Статус одиночного ролика, поданного пачкой — в той же форме, что
   * `GrokVideoService.getStatus`, чтобы `pollGrokStatus` не ветвился
   * дальше этой точки. Готовность пачки — `pendingCount === 0` (тот же
   * принцип, что у каталог-партий); затем результат ищется по нашему
   * `batch_request_id`. Недоступный статус (HTTP-ошибка, `null`) —
   * «ещё не готово», не сбой: вызывающий и так терпит транзиентные
   * ошибки опроса.
   */
  private async grokBatchStatus(
    current: GeneratedVideo,
  ): Promise<{ done: boolean; error?: string; videoUrl?: string }> {
    const batchStatus = await this.grokBatch.getBatchStatus(
      current.xaiBatchId!,
    );
    if (!batchStatus || batchStatus.pendingCount > 0) {
      return { done: false };
    }
    const key = current.xaiBatchRequestId ?? current.generatedVideoId;
    const results = await this.grokBatch.getBatchResultsDetailed(
      current.xaiBatchId!,
    );
    const videoUrl = results.urlsByRequestId[key];
    if (videoUrl) return { done: true, videoUrl };
    const error = results.errorsByRequestId[key];
    if (error) return { done: true, error };
    if (batchStatus.errorCount > 0) {
      return {
        done: true,
        error: `xAI batch ${current.xaiBatchId}: запрос ${key} завершился ошибкой без текста`,
      };
    }
    // Пачка отчиталась «готово», а результата по нашему ключу нет —
    // скорее всего, страница результатов ещё не догнала статус;
    // опрос продолжится, дедлайн батча его ограничит.
    return { done: false };
  }

  private async pollGrokStatus(
    sessionId: string,
    session: Session,
    current: GeneratedVideo,
  ): Promise<GeneratedVideo> {
    if (renderExpired(current)) {
      return await this.markFailed(
        sessionId,
        current,
        'VIDEO_GENERATION_TIMEOUT',
        current.xaiBatchId
          ? `xAI не обработал пачку за ${BATCH_RENDER_DEADLINE_MS / 3_600_000} часов — попробуйте сгенерировать ещё раз`
          : `Grok не ответил за ${RENDER_DEADLINE_MS / 60000} минут — попробуйте сгенерировать ещё раз`,
        true,
      );
    }

    if (!current.grokRequestId && !current.xaiBatchId) {
      // Не должно случаться на практике — как и у Veo выше, нечего опрашивать.
      return current;
    }

    let status: { done: boolean; error?: string; videoUrl?: string };
    try {
      status = current.xaiBatchId
        ? await this.grokBatchStatus(current)
        : await this.grokVideo.getStatus(current.grokRequestId!);
    } catch (error) {
      this.logger.warn(`Grok status check failed, will retry: ${error}`);
      return current; // transient — same tolerance as the Veo branch above
    }

    if (!status.done) {
      return current; // still rendering
    }

    if (status.error) {
      return await this.markFailed(
        sessionId,
        current,
        'VIDEO_GENERATION_FAILED',
        status.error,
        true,
      );
    }

    if (!status.videoUrl) {
      return await this.markFailed(
        sessionId,
        current,
        'VIDEO_GENERATION_NO_OUTPUT',
        'Grok reported completion but returned no video',
        true,
      );
    }

    let videoBuffer: Buffer;
    let blobUrl: string;
    try {
      const res = await fetch(status.videoUrl, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Grok video download HTTP ${res.status}`);
      }
      videoBuffer = Buffer.from(await res.arrayBuffer());
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

    // Доп. запрос владельца продукта (ТЗ §9, этап 4 плана §14): сегмент
    // готов, но цепочка ещё не дописана — продолжаем расширением.
    // В отличие от Veo, Grok Extend принимает URL, а не байты (§10.1
    // ТЗ) — используем `blobUrl`, только что полученный выше, не
    // скачиваем и не кодируем ничего заново.
    if (
      current.chainSegmentsTotal &&
      (current.chainSegmentsDone ?? 1) < current.chainSegmentsTotal
    ) {
      return await this.continueChainGuarded(sessionId, current, () =>
        this.continueGrokChain(sessionId, session, current, blobUrl),
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

    await this.sharedVideos.markConverted(session.sharedFromPageId);

    this.logger.log(`Grok video generation complete for session ${sessionId}`);

    return this.postprod.start(sessionId, completed);
  }

  /**
   * Продолжает цепочку Scene Extension (ТЗ §9, этап 4 плана §14) —
   * запускает следующий сегмент поверх только что скачанного, не
   * финализирует ролик.
   *
   * ⚠️ Форма параметра `video` для расширения — ГЕНЕРАЛИЗАЦИЯ, не
   * подтверждённый факт. Официальный пример на `ai.google.dev`
   * показывает RAW REST-тело `video: {inlineData: {mimeType, data}}`,
   * но УЖЕ РАБОТАЮЩИЙ в этом файле код для параметра `image` (тот же
   * SDK, `@google/genai`) использует другое имя поля —
   * `{imageBytes, mimeType}`, не `{inlineData: {...}}`. Здесь применена
   * форма ПО АНАЛОГИИ с `image`/`imageBytes` (`video`/`videoBytes`) —
   * логика в том, что это тот же SDK и, вероятно, та же конвенция
   * именования для соседнего типа параметра, а не сырой REST — но это
   * ДОГАДКА, не проверенный факт, и её нужно сверить одним тестовым
   * вызовом до реального трафика (тот же принцип, что уже трижды
   * применялся в этом ТЗ). Есть и отдельный открытый баг-репорт
   * (discuss.ai.google.dev, 31 окт 2025) о том, что параметр `video`
   * вообще отклоняется как некорректный на этом эндпоинте — то есть
   * степень неопределённости здесь ВЫШЕ, чем у остального этого файла.
   */
  /**
   * М-2.2/М-1.3 седьмого аудита: продолжение цепочки — под замком
   * `claimWork('chain-continue')` и с перечитыванием сессии под ним.
   * Проигравший опрос (замок занят) или опоздавший (под замком видно,
   * что сегмент уже продвинут другим опросом) возвращает актуальную
   * запись и НЕ стартует свой платный сегмент. Тот же приём, что у
   * `pollExport`/`advanceSubtitleBurn`.
   */
  private async continueChainGuarded(
    sessionId: string,
    current: GeneratedVideo,
    run: () => Promise<GeneratedVideo>,
  ): Promise<GeneratedVideo> {
    const claimed = await this.sessionService.claimWork(
      sessionId,
      'chain-continue',
      GENERATE_CLAIM_TTL_MS,
    );
    if (!claimed) {
      this.logger.warn(
        `сессия ${sessionId}: продолжение цепочки уже идёт в другом опросе — этот пропускает`,
      );
      return current;
    }
    try {
      const fresh = await this.sessionService.getSession(sessionId);
      const latest = fresh?.generatedVideo;
      if (
        !latest ||
        latest.generatedVideoId !== current.generatedVideoId ||
        (latest.chainSegmentsDone ?? 1) !== (current.chainSegmentsDone ?? 1) ||
        latest.status !== GenerationStatus.PROCESSING
      ) {
        // Другой опрос уже продвинул (или закрыл) цепочку между нашим
        // чтением и замком — отдаём то, что в базе, без второго старта.
        return latest ?? current;
      }
      return await run();
    } finally {
      await this.sessionService.releaseWork(sessionId, 'chain-continue');
    }
  }

  private async continueVeoChain(
    sessionId: string,
    session: Session,
    current: GeneratedVideo,
    previousSegmentBuffer: Buffer,
  ): Promise<GeneratedVideo> {
    const quality = current.quality ?? DEFAULT_QUALITY;
    const target = current.renderedAspectRatio ?? current.aspectRatio ?? '9:16';
    // Тот же выбор модели, что был у базового сегмента (ТЗ §1, этап 5
    // плана §14) — пересчитываем от того же плана референсов, а не
    // берём `VEO_MODELS[quality]` заново: продолжение цепочки должно
    // идти той же моделью, что и её начало, иначе расширение почти
    // наверняка просто не примет чужую модель на входе.
    const plan = buildReferencePlan(session);
    const veoModel = pickVeoModel(plan, quality, VEO_MODELS[quality]);
    const isVeo30 = usesVeo30(plan, quality);

    let operation: { name?: string };
    try {
      // Найдено при аудите: без явной оговорки «это продолжение» модель
      // получала БУКВАЛЬНО тот же текст сцены, что и первый сегмент —
      // для сцены с законченным действием («открывает подарок и
      // улыбается») это могло бы означать «начни действие заново» на
      // каждом следующем сегменте, а не «продолжай». Официальный
      // механизм расширения и так подхватывает стиль/персонажей/сцену
      // с последнего кадра — эта строка только уточняет НАМЕРЕНИЕ
      // (продолжать, не повторять), не переписывает саму сцену заново.
      // Целевой формат ролика — у первого сегмента, не здесь: `target`
      // выше — это КАДР РЕНДЕРА (в нём продолжают цепочку), а обрезка
      // считается по `current.aspectRatio`. Оба указания — про рамку
      // будущей обрезки и про амплитуду наезда — до этапа 120
      // доставались только первому сегменту: остальные шли с голым
      // текстом промпта, и композиция в них расходилась с первым.
      const chainRender = planRender(current.aspectRatio ?? target);
      const continuationPrompt = [
        session.generationPrompt!.finalText,
        'This is a continuation of the same shot — keep the action, characters, and setting continuous with the previous segment. Do not restart or repeat the described action from the beginning.',
        chainRender.compositionNote ?? '',
        cameraBriefCorrection(
          session.generationPrompt?.cameraBriefFor?.move ??
            normalizeCameraMove(session.brandManifestSnapshot?.cameraMove),
          session.generationPrompt?.cameraBriefFor?.aspectRatio ??
            session.originalVideo?.frame?.aspectRatio,
          chainRender.target,
        ),
        current.avoidText && !isVeo30 ? `Avoid: ${current.avoidText}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      operation = await this.genai.models.generateVideos({
        model: veoModel,
        prompt: continuationPrompt,
        // См. доккомментарий метода — форма поля не подтверждена.
        video: {
          videoBytes: previousSegmentBuffer.toString('base64'),
          mimeType: 'video/mp4',
        },
        config: {
          durationSeconds: VIDEO_DURATION_SECONDS,
          aspectRatio: target as VeoAspectRatio,
          ...(current.avoidText && isVeo30
            ? { negativePrompt: current.avoidText }
            : {}),
        },
      } as Parameters<typeof this.genai.models.generateVideos>[0]);
    } catch (error) {
      this.logger.error(
        `Veo chain: не удалось продолжить цепочку (сегмент ${(current.chainSegmentsDone ?? 1) + 1}/${current.chainSegmentsTotal}) для сессии ${sessionId}:`,
        error,
      );
      return await this.markFailed(
        sessionId,
        current,
        'VIDEO_EXTENSION_FAILED',
        this.extractErrorMessage(error),
        true,
      );
    }

    if (!operation.name) {
      return await this.markFailed(
        sessionId,
        current,
        'VIDEO_EXTENSION_NO_OPERATION',
        'Veo did not return an operation for the next chain segment',
        true,
      );
    }

    // Тот же принцип, что при первом сегменте (§26 ТЗ): расход
    // пишется в момент запуска этого сегмента, не по завершении.
    await this.aiUsage.record({
      operation: 'generation',
      model: veoModel,
      seconds: VIDEO_DURATION_SECONDS,
      sessionId,
    });

    const nextSegmentsDone = (current.chainSegmentsDone ?? 1) + 1;
    const continued: GeneratedVideo = {
      ...current,
      veoOperationName: operation.name,
      chainSegmentsDone: nextSegmentsDone,
      // Найдено при аудите (ТЗ §9, этап 4 плана §14): без этого сброса
      // `renderExpired()` считал бы дедлайн от начала ВСЕЙ цепочки, а
      // не от старта этого сегмента — цепочка из 5-7 сегментов почти
      // неизбежно проваливалась бы по мнимому таймауту (20 минут на
      // ВСЮ цепочку — не то же самое, что 20 минут на один сегмент,
      // который сам по себе завершался бы успешно и быстро).
      initiatedAt: new Date(),
      // Статус остаётся PROCESSING — ролик ещё не готов пользователю,
      // даже если этот отдельный сегмент только что завершился.
    };

    await this.sessionService.updateSession(sessionId, {
      generatedVideo: continued,
    });

    this.logger.log(
      `Veo chain: сегмент ${nextSegmentsDone}/${current.chainSegmentsTotal} запущен для сессии ${sessionId}`,
    );

    return continued;
  }

  /**
   * Продолжает цепочку Grok Extend (ТЗ §9, этап 4 плана §14) — тот же
   * принцип, что `continueVeoChain`, но через
   * `GrokVideoService.extendVideo()` — отдельный эндпоинт
   * `/v1/videos/extensions` (docs.x.ai, с curl-примером; см.
   * доккомментарий метода). У Grok расширение всегда одно (вход
   * расширения ограничен 15 с), так что «цепочка» здесь — база +
   * один хвост; длины обоих — в `chainSegmentSeconds`.
   */
  private async continueGrokChain(
    sessionId: string,
    session: Session,
    current: GeneratedVideo,
    previousSegmentUrl: string,
  ): Promise<GeneratedVideo> {
    const resolution = current.resolution ?? '480p';
    // Найдено при аудите — то же самое, что у Veo-версии выше: без
    // явной оговорки модель получала бы буквально тот же текст сцены
    // на каждом сегменте, что для сцены с законченным действием могло
    // бы означать «начни заново», а не «продолжай».
    const continuationPrompt = [
      session.generationPrompt!.finalText,
      'This is a continuation of the same shot — keep the action, characters, and setting continuous with the previous segment. Do not restart or repeat the described action from the beginning.',
      current.avoidText ? `Avoid: ${current.avoidText}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    // Длина добавляемой части — из плана (`segments[next]`); записи до
    // 14.09.2026 поля не имеют — тогда прежние 8 (в допуске 2–10 с).
    const nextIndex = current.chainSegmentsDone ?? 1;
    const extendSeconds =
      current.chainSegmentSeconds?.[nextIndex] ?? VIDEO_DURATION_SECONDS;

    let requestId: string | undefined;
    let xaiBatchId: string | undefined;
    let xaiBatchRequestId: string | undefined;
    try {
      if (current.xaiBatchId) {
        // База шла пачкой — расширение тоже пачкой (тот же транспорт
        // на весь ролик, см. `grok-video-transport.ts`), новая пачка
        // из одного `video_extension_request`.
        xaiBatchRequestId = `${current.generatedVideoId}-ext-${nextIndex}`;
        const submitted = await this.grokBatch.submitExtendBatch(
          `single-${sessionId}-${xaiBatchRequestId}`,
          [
            {
              batchRequestId: xaiBatchRequestId,
              prompt: continuationPrompt,
              videoUrl: previousSegmentUrl,
              durationSeconds: extendSeconds,
            },
          ],
        );
        if (submitted.error) throw new Error(submitted.error);
        xaiBatchId = submitted.xaiBatchId;
      } else {
        // Сбой 14.09.2026: раньше — `startGeneration({ extendVideoUrl })`
        // на `/v1/videos/generations`, где такого поля нет, и xAI молча
        // рендерил новый 8-секундный ролик вместо продолжения. Теперь —
        // отдельный `/v1/videos/extensions` (см. `extendVideo`); формат
        // и разрешение там не принимаются — наследуются от входа.
        ({ requestId } = await this.grokVideo.extendVideo({
          prompt: continuationPrompt,
          videoUrl: previousSegmentUrl,
          durationSeconds: extendSeconds,
        }));
      }
    } catch (error) {
      this.logger.error(
        `Grok chain: не удалось продолжить цепочку (сегмент ${(current.chainSegmentsDone ?? 1) + 1}/${current.chainSegmentsTotal}) для сессии ${sessionId}:`,
        error,
      );
      return await this.markFailed(
        sessionId,
        current,
        'VIDEO_EXTENSION_FAILED',
        this.extractErrorMessage(error),
        true,
      );
    }

    await this.aiUsage.record({
      operation: 'generation',
      // М-2.8: выход расширения — не выше 720p, по такой ставке и учёт.
      model: `${this.grokVideo.extendModelName}:${effectiveGrokResolution(resolution, { extension: true })}`,
      seconds: extendSeconds,
      sessionId,
    });

    const nextSegmentsDone = (current.chainSegmentsDone ?? 1) + 1;
    const continued: GeneratedVideo = {
      ...current,
      grokRequestId: requestId,
      ...(xaiBatchId ? { xaiBatchId, xaiBatchRequestId } : {}),
      chainSegmentsDone: nextSegmentsDone,
      // Тот же сброс, что и у Veo-версии — см. её комментарий выше:
      // без него дедлайн считался бы от начала всей цепочки, а не от
      // старта этого сегмента.
      initiatedAt: new Date(),
    };

    await this.sessionService.updateSession(sessionId, {
      generatedVideo: continued,
    });

    this.logger.log(
      `Grok chain: сегмент ${nextSegmentsDone}/${current.chainSegmentsTotal} запущен для сессии ${sessionId}`,
    );

    return continued;
  }

  private async downloadVeoVideo(uri: string): Promise<Buffer> {
    const apiKey = geminiApiKey();
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY or GOOGLE_GEMINI_API_KEY environment variable is required',
      );
    }
    const res = await fetch(uri, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Failed to download Veo video: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
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
