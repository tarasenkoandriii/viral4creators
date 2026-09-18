/**
 * ActorsService — оркестрация пилота говорящего AI-аватара
 * (doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md §3.2, этап 72; субтитры —
 * этап 72а, по прямому пожеланию владельца продукта: «субтитры на всех
 * пайплайнах должны включаться явным чекбоксом — не всем они нужны»).
 *
 * Новый, не переиспользующий `GenerationService` поток — намеренно
 * (§3.3 документа): единственный сегодня протестированный, стабильный
 * Veo-путь не трогается ради нового движка. `FfmpegApiService` из
 * `PostProductionModule` переиспользуется — тот же самый хостед-ffmpeg,
 * что и у Veo-пути, второй клиент для того же внешнего сервиса не
 * заводится.
 *
 * Порядок шагов (§3.2):
 *  1. Текст реплики — берётся из уже утверждённого промпта сессии
 *     (`generationPrompt`), тем же полем, что использует постобработка
 *     Veo-пути (`postprod.service.ts`).
 *  2. Синтез голоса — Resemble, ДО видео: аудио — входной параметр,
 *     управляющий движением губ, а не дорожка поверх готового ролика.
 *  3. Генерация аватар-видео — Hedra Character-3.
 *  4. Статус — поллинг `GET /v3/jobs/{job_id}`.
 *  5. Результат — скачивается и перезаливается в наш Blob.
 *  6. Субтитры (этап 72а) — явный чекбокс `GenerateAvatarRequestDto.subtitles`,
 *     выключен по умолчанию. Включён — `.srt` собирается из тайминга
 *     Resemble ЕЩЁ на шаге 2 (текст и alignment уже есть), а прожигается
 *     ВТОРЫМ, ОТДЕЛЬНЫМ проходом ffmpeg ПОСЛЕ шага 5: в отличие от
 *     Veo-пути, где кроп/голос/субтитры накладываются одной задачей на
 *     файл, который Veo уже отдала, здесь Hedra сама делает видео из
 *     фото+звука — субтитры физически некуда наложить, пока этого файла
 *     не существует. Второй платный вызов ffmpeg-api — цена этой
 *     разницы, явно принятая (см. §50 SPEC).
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SessionService } from '../../common/session.service';
import { BlobService } from '../storage/blob.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { ResembleService } from '../tts/resemble.service';
import { AvatarVideo } from '../../common/types/actors.types';
import {
  GenerationError,
  GenerationStatus,
} from '../../common/types/generation.types';
import { cueTimings, speakableText } from '../../common/voiceover-script';
import {
  buildSrt,
  normalizeSubtitleTheme,
  SUBTITLE_THEME_FORCE_STYLE,
  SubtitleTheme,
} from '../../common/subtitles';
import { planPostProduction } from '../../common/postprod';
import { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import { HedraClientService } from './hedra-client.service';
import { GoogleGenAI } from '@google/genai';
import { v4 as uuidv4 } from 'uuid';
import { createGeminiClient } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { GeminiFilesService } from '../analysis/gemini-files.service';
import { SoundCheck } from '../../common/types/audit.types';
import { activeSnapshotCharacterImage } from '../../common/active-image';
import { BrandCharacterSnapshot } from '../../common/types/brand-manifest.types';
import {
  appendSoundCheck,
  parseSoundCheckResponse,
  soundCheckPrompt,
} from '../../common/sound-check';

/** Сколько держится замок запуска — тот же порядок величины, что GENERATE_CLAIM_TTL_MS у Veo. */
const AVATAR_CLAIM_TTL_MS = 5 * 60 * 1000;

/**
 * Сколько ждём Hedra, прежде чем закрыть рендер сбоем — по аналогии с
 * `RENDER_DEADLINE_MS` у Veo (§3.5 документа: верхний предел ролика у
 * Character-3 — 10 минут аудио, дедлайн ожидания взят с запасом и
 * подлежит корректировке по факту первых реальных прогонов пилота).
 * Считается от `initiatedAt` — то есть покрывает ТОЛЬКО фазу Hedra;
 * прожиг субтитров (если заказан) идёт после и имеет собственный
 * дедлайн `AVATAR_SUBTITLE_DEADLINE_MS` от момента отправки той задачи
 * — тот же приём, что у Veo (`RENDER_DEADLINE_MS` + отдельный
 * `POSTPROD_DEADLINE_MS` постобработки, два независимых отсчёта).
 */
export const AVATAR_RENDER_DEADLINE_MS = 20 * 60 * 1000;

export function avatarRenderExpired(
  video: Pick<AvatarVideo, 'initiatedAt' | 'renderedUrl'>,
  now: number = Date.now(),
): boolean {
  // Hedra уже отдала результат (renderedUrl задан) — дальше идёт
  // отдельная фаза прожига субтитров со своим дедлайном, эта проверка
  // больше не применяется, иначе долгий прожиг мог бы провалить уже
  // готовый ролик как «Hedra не ответила».
  if (video.renderedUrl) return false;
  const started = new Date(video.initiatedAt).getTime();
  return Number.isFinite(started) && now - started > AVATAR_RENDER_DEADLINE_MS;
}

/**
 * Прожиг субтитров — один видеофильтр без кропа и голоса (тот и другой
 * уже сделала Hedra), заведомо быстрее, чем `POSTPROD_DEADLINE_MS`
 * (15 минут) у Veo-пути, которому иногда приходится делать втрое больше
 * за один проход. 10 минут — тот же запас с большим накладом, что и у
 * основного дедлайна выше.
 */
export const AVATAR_SUBTITLE_DEADLINE_MS = 10 * 60 * 1000;

export function avatarSubtitleExpired(
  video: Pick<AvatarVideo, 'subtitleJobStartedAt'>,
  now: number = Date.now(),
): boolean {
  if (!video.subtitleJobStartedAt) return false;
  const started = new Date(video.subtitleJobStartedAt).getTime();
  return (
    Number.isFinite(started) && now - started > AVATAR_SUBTITLE_DEADLINE_MS
  );
}

/** Грубая оценка длительности озвучки, когда `alignment` недоступен — тот же ориентир (≈15 симв/сек), что уже используется в common/ai-pricing.ts для оценки resemble-tts. */
const FALLBACK_CHARS_PER_SECOND = 15;

export const AVATAR_IN_FLIGHT_MESSAGE =
  'Генерация аватар-ролика уже запускается — дождитесь ответа первого запроса.';

/** Е-3.1 шестого аудита: тот же приём отказа, что у AVATAR_IN_FLIGHT_MESSAGE. */
export const AVATAR_SOUND_CHECK_IN_FLIGHT_MESSAGE =
  'Проверка звука для этой сессии уже выполняется — дождитесь ответа первого запроса.';

/** М-6.5 седьмого аудита: скачивание готового ролика — с таймаутом. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

@Injectable()
export class ActorsService {
  private readonly logger = new Logger(ActorsService.name);
  // Свой клиент, не через VideoAuditService/GeminiFilesService DI —
  // этот пайплайн admin-only и не импортирует VideoAuditModule (у него
  // своя авторизация); common/sound-check.ts даёт общий промпт/разбор
  // ответа, а сам Gemini-вызов у каждого пайплайна свой, как и раньше
  // ffmpeg-путь был общим сервисом, а вызовы — раздельными.
  private readonly genai: GoogleGenAI;

  constructor(
    private readonly sessions: SessionService,
    private readonly blob: BlobService,
    private readonly aiUsage: AiUsageService,
    private readonly resemble: ResembleService,
    private readonly hedra: HedraClientService,
    private readonly ffmpeg: FfmpegApiService,
    private readonly geminiFiles: GeminiFilesService,
  ) {
    this.genai = createGeminiClient();
  }

  async generateAvatarVideo(
    sessionId: string,
    characterIndex: number,
    promptOverride?: string,
    aspectRatio = '9:16',
    resolution: '540p' | '720p' | '1080p' = '720p',
    wantSubtitles = false,
  ): Promise<AvatarVideo> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }

    // Повторный запуск при идущей операции — та же логика, что у
    // GenerationService.generateVideo: отдаём ту же операцию, а не 409,
    // чтобы повторный клик оператора не выглядел ошибкой.
    const inFlight = session.avatarVideo;
    if (
      inFlight &&
      (inFlight.status === GenerationStatus.PENDING ||
        inFlight.status === GenerationStatus.PROCESSING)
    ) {
      this.logger.warn(
        `сессия ${sessionId}: повторный запуск аватар-генерации при идущей операции ${
          inFlight.providerJobId ?? '—'
        } — возвращаю её же`,
      );
      return inFlight;
    }

    const character =
      session.brandManifestSnapshot?.characters?.[characterIndex];
    if (!character) {
      throw new BadRequestException(
        `В снимке манифеста бренда этой сессии нет персонажа с индексом ${characterIndex}`,
      );
    }
    // §4 п.1 ТЗ скетча: аватар собирается из активного изображения
    // персонажа — при применённом скетче портрет берётся из него.
    const characterImage = activeSnapshotCharacterImage(character);
    if (!characterImage) {
      throw new BadRequestException(
        `У персонажа «${character.label}» нет фото — Hedra Character-3 требует портрет как start_image`,
      );
    }

    if (!this.hedra.configured()) {
      throw new BadRequestException(
        'HEDRA_API_KEY не задан на этом стенде — пилот аватара не подключён',
      );
    }
    if (!this.resemble.configured()) {
      throw new BadRequestException(
        'RESEMBLE_API_KEY не задан на этом стенде — синтез голоса для пилота аватара не подключён',
      );
    }

    const script =
      session.generationPrompt?.finalVoiceoverScript ??
      session.generationPrompt?.voiceoverScript ??
      null;
    const speech = speakableText(script);
    if (!speech) {
      throw new BadRequestException(
        'В сессии нет текста реплик (generationPrompt) — синтезировать озвучку для аватара нечего',
      );
    }

    const prompt =
      promptOverride?.trim() ||
      character.description?.trim() ||
      `${character.label} говорит на камеру, естественная речь и мимика`;

    // Голос бренда — только если он размечен именно под Resemble
    // (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.2): иначе `ttsVoiceId`
    // принадлежит другому провайдеру и передавать его Resemble
    // бессмысленно — пусть используется RESEMBLE_VOICE_ID стенда.
    const voiceId =
      session.brandManifestSnapshot?.ttsProvider === 'resemble'
        ? (session.brandManifestSnapshot?.ttsVoiceId ?? undefined)
        : undefined;

    // Тема оформления — из брендового манифеста (та же тема, что и у
    // Veo-пути для этого бренда), а не отдельная настройка пилота: одно
    // визуальное решение на бренд, не на движок.
    const subtitleTheme = normalizeSubtitleTheme(
      session.brandManifestSnapshot?.subtitleTheme,
    );

    // Замок — тот же приём, что claimWork('generate') у Veo (Б-2.2/В-2.2):
    // защищает именно от гонки между «уже записан» и «уже стартовал
    // платный вызов», не только от повторного клика после ответа.
    const claimed = await this.sessions.claimWork(
      sessionId,
      'avatar-generate',
      AVATAR_CLAIM_TTL_MS,
    );
    if (!claimed) {
      this.logger.warn(
        `сессия ${sessionId}: параллельный запуск аватар-генерации при уже занятом замке — отказ`,
      );
      throw new ConflictException(AVATAR_IN_FLIGHT_MESSAGE);
    }

    try {
      return await this.startAvatarGeneration(
        sessionId,
        characterIndex,
        character,
        prompt,
        speech,
        voiceId,
        aspectRatio,
        resolution,
        wantSubtitles,
        subtitleTheme,
      );
    } finally {
      await this.sessions.releaseWork(sessionId, 'avatar-generate');
    }
  }

  private async startAvatarGeneration(
    sessionId: string,
    characterIndex: number,
    /** Снимок персонажа бренда целиком — вместе с применённым скетчем
     * (§4 п.1 ТЗ скетча): портрет для Hedra берётся резолвером. */
    character: BrandCharacterSnapshot,
    prompt: string,
    speech: string,
    voiceId: string | undefined,
    aspectRatio: string,
    resolution: '540p' | '720p' | '1080p',
    wantSubtitles: boolean,
    subtitleTheme: SubtitleTheme,
  ): Promise<AvatarVideo> {
    // Шаг 2 (§3.2): синтез Resemble — ДО видео, аудио управляет губами.
    // Провайдер выбран явно (владелец продукта), не через активный
    // TTS_PROVIDER стенда — см. доккомментарий tts.module.ts.
    const outcome = await this.resemble.synthesize({
      text: speech,
      voiceId,
      timestamps: true,
    });

    if (!outcome.ok) {
      throw new BadRequestException(
        `Синтез голоса Resemble не состоялся: ${outcome.reason}`,
      );
    }

    // ТЗ §26 / §1.1 документа: расход пишется в момент старта платного
    // вызова, а не завершения — деньги считаются потраченными, даже
    // если рендер потом не удастся.
    await this.aiUsage.record({
      operation: 'voiceover',
      model: `${this.resemble.providerKey}-tts`,
      sessionId,
      characters: outcome.characters,
    });

    const voiceoverPathname = `sessions/${sessionId}/avatar-voiceover.mp3`;
    const { url: audioUrl } = await this.blob.uploadBuffer(
      voiceoverPathname,
      outcome.audio,
      outcome.mimeType,
    );

    // Шаг 2b (этап 72а) — субтитры собираются здесь, а не позже: текст и
    // `alignment` уже есть в этот самый момент, второй поход к Resemble
    // не нужен. Прожиг (второй проход ffmpeg) идёт отдельно, после того
    // как у нас появится файл от Hedra — см. `getAvatarVideoStatus`.
    let subtitleStatus: AvatarVideo['subtitleStatus'] = 'skipped';
    let subtitlePathname: string | null = null;
    let subtitleUrl: string | null = null;
    let subtitleError: string | null = null;
    if (wantSubtitles) {
      if (!outcome.alignment) {
        // `timestamps: true` запрошен всегда (нужен и для оценки
        // расхода Hedra ниже), но Resemble может не разобрать тайминг
        // (защитный разбор, resemble.service.ts) — деградация, не
        // повод отменять рендер.
        subtitleStatus = 'failed';
        subtitleError =
          'Resemble не вернул тайминг речи — субтитры для этого ролика недоступны';
      } else {
        const cues = cueTimings(speech, outcome.alignment);
        const srt = buildSrt(cues);
        if (!srt.trim()) {
          subtitleStatus = 'failed';
          subtitleError = 'не удалось разобрать текст на субтитры';
        } else {
          try {
            subtitlePathname = `sessions/${sessionId}/avatar-subtitles.srt`;
            const uploaded = await this.blob.uploadBuffer(
              subtitlePathname,
              Buffer.from(srt, 'utf8'),
              'text/plain',
            );
            subtitleUrl = uploaded.url;
            subtitleStatus = 'pending';
          } catch (error) {
            subtitleStatus = 'failed';
            subtitleError = this.extractErrorMessage(error);
          }
        }
      }
      if (subtitleStatus === 'failed') {
        this.logger.warn(
          `сессия ${sessionId}: субтитры аватара не собраны — ${subtitleError}`,
        );
      }
    }

    // Шаг 3 (§3.2): запуск Hedra Character-3.
    let jobId: string;
    try {
      const job = await this.hedra.submit({
        prompt,
        // Активное изображение персонажа: скетч, если он применён.
        startImage: (activeSnapshotCharacterImage(character)?.url ??
          character.photoUrl) as string,
        audioUrl,
        aspectRatio,
        resolution,
      });
      jobId = job.jobId;
    } catch (error) {
      throw new BadRequestException(
        `Не удалось запустить Hedra Character-3: ${this.extractErrorMessage(error)}`,
      );
    }

    // Расход на сам рендер Hedra — оценка по длительности озвучки:
    // точных секунд видео до готовности задачи нет, `alignment` даёт
    // лучшее доступное приближение (конец последнего слова), иначе —
    // грубая оценка по числу символов (тот же ориентир, что уже
    // используется для resemble-tts в ai-pricing.ts).
    const estimatedSeconds =
      outcome.alignment && outcome.alignment.ends.length > 0
        ? outcome.alignment.ends[outcome.alignment.ends.length - 1]
        : outcome.characters / FALLBACK_CHARS_PER_SECOND;
    await this.aiUsage.record({
      operation: 'avatar-generation',
      model: 'hedra-character-3',
      sessionId,
      seconds: Math.max(1, Math.round(estimatedSeconds)),
    });

    const avatarVideo: AvatarVideo = {
      status: GenerationStatus.PROCESSING,
      provider: 'hedra',
      providerJobId: jobId,
      characterIndex,
      sourceCharacterId: character.sourceCharacterId,
      characterLabel: character.label,
      photoUrl: character.photoUrl as string,
      prompt,
      voiceoverPathname,
      renderedUrl: null,
      downloadUrl: null,
      initiatedAt: new Date(),
      completedAt: null,
      subtitleStatus,
      subtitleTheme,
      subtitlePathname,
      subtitleUrl,
      subtitleError,
      subtitleJobId: null,
      subtitleJobStartedAt: null,
      costMicroUsd: null,
      error: null,
    };

    await this.sessions.updateSession(sessionId, { avatarVideo });
    return avatarVideo;
  }

  /**
   * Опрос статуса — вызывается повторно клиентом (админкой). Две фазы,
   * различаемые по `current.renderedUrl` (см. `avatarRenderExpired`):
   *  - `renderedUrl` пуст — идёт рендер Hedra, опрашиваем Hedra (не
   *    более одного вызова за обращение, тот же принцип, что
   *    `GenerationService.getVideoStatus`);
   *  - `renderedUrl` задан — Hedra уже отдала файл; если субтитры не
   *    заказаны (`subtitleStatus !== 'pending'`), результат уже
   *    финализирован в момент, когда `renderedUrl` был установлен (см.
   *    `finalizeWithSubtitleOutcome` ниже), и этот метод сюда больше не
   *    попадёт (статус уже COMPLETE/FAILED, ранний возврат выше);
   *    остаётся только фаза прожига субтитров — отправить задачу ffmpeg
   *    (`subtitleJobId` ещё не задан) или опросить уже отправленную.
   */
  async getAvatarVideoStatus(sessionId: string): Promise<AvatarVideo> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }

    const current = session.avatarVideo;
    if (!current) {
      throw new NotFoundException('Avatar generation has not been initiated');
    }

    if (
      current.status === GenerationStatus.COMPLETE ||
      current.status === GenerationStatus.FAILED
    ) {
      return current;
    }

    if (!current.providerJobId) {
      return current;
    }

    if (current.renderedUrl) {
      // Фаза 2: Hedra уже отдала файл, идёт (или ещё не начат) прожиг
      // субтитров.
      return this.advanceSubtitleBurn(sessionId, current);
    }

    if (avatarRenderExpired(current)) {
      return this.markFailed(
        sessionId,
        current,
        'AVATAR_GENERATION_TIMEOUT',
        `Hedra не ответила за ${AVATAR_RENDER_DEADLINE_MS / 60000} минут — попробуйте сгенерировать ещё раз`,
        true,
      );
    }

    let status;
    try {
      status = await this.hedra.status(current.providerJobId);
    } catch (error) {
      this.logger.warn(
        `Hedra status check failed, will retry: ${this.extractErrorMessage(error)}`,
      );
      return current; // сетевая икота — следующий опрос повторит
    }

    if (status.status === 'pending') {
      return current;
    }

    if (status.status === 'failed') {
      return this.markFailed(
        sessionId,
        current,
        'AVATAR_GENERATION_FAILED',
        status.error ?? 'Hedra сообщила об ошибке рендера',
        true,
      );
    }

    const output = status.outputs?.[0];
    if (!output) {
      return this.markFailed(
        sessionId,
        current,
        'AVATAR_GENERATION_NO_OUTPUT',
        'Hedra отметила задачу завершённой, но не вернула файл',
        true,
      );
    }

    // Шаг 5 (§3.2): внешняя ссылка недолговечна — переносим в наш Blob,
    // тот же принцип, что уже применён в postprod.service.ts для Veo.
    // Файл — «сырой» (без субтитров): `avatar-raw.mp4`, не `avatar.mp4`
    // — этап 72а (renderedUrl теперь источник для второго прохода
    // ffmpeg, а не то же самое, что итоговый downloadUrl).
    let rawUrl: string;
    try {
      const bytes = await this.download(output.url);
      const pathname = `sessions/${sessionId}/avatar-raw.mp4`;
      ({ url: rawUrl } = await this.blob.uploadBuffer(
        pathname,
        bytes,
        'video/mp4',
      ));
    } catch (error) {
      return this.markFailed(
        sessionId,
        current,
        'AVATAR_DOWNLOAD_FAILED',
        this.extractErrorMessage(error),
        true,
      );
    }

    const withRendered: AvatarVideo = {
      ...current,
      renderedUrl: rawUrl,
      costMicroUsd: status.costMicroUsd ?? current.costMicroUsd,
    };
    // Сохраняем СРАЗУ, а не только вместе с исходом фазы 2 ниже: если
    // следующий шаг (отправка прожига) проиграет гонку за замок другому
    // конкурентному опросу и вернёт `current` без записи, скачанный и
    // перезалитый файл всё равно не потеряется — следующий опрос не
    // будет повторно качать его у Hedra.
    //
    // Пишем через `writeIfStillCurrent` (аудит 2026-09-09, Д-2), а не
    // напрямую: пока шло скачивание у Hedra, другой, более быстрый
    // параллельный опрос той же сессии мог уже сам продвинуть (или даже
    // полностью завершить) состояние — прямая запись поверх стёрла бы
    // его результат откатом на более раннее состояние.
    const persisted = await this.writeIfStillCurrent(
      sessionId,
      current,
      withRendered,
    );
    if (persisted !== withRendered) {
      // Не наша запись победила — отдаём то, что реально в БД, вместо
      // повторной обработки поверх устаревшего снимка.
      return persisted;
    }

    if (persisted.subtitleStatus !== 'pending') {
      // Субтитры не заказаны (чекбокс выключен) или их сборка уже не
      // удалась на шаге 2b — финализируем сразу, ролик доставляется без
      // второго прохода ffmpeg.
      return this.finalize(sessionId, persisted, rawUrl);
    }

    // Субтитры заказаны и `.srt` собран — переходим к фазе 2 прямо
    // сейчас, не дожидаясь следующего опроса: экономит один лишний тик
    // клиентского поллинга.
    return this.advanceSubtitleBurn(sessionId, persisted);
  }

  /**
   * Пишет `next` в сессию, только если запись в БД всё ещё совпадает с
   * тем, что вызывающий код прочитал как `expected` — по `status`,
   * `renderedUrl`, `subtitleJobId` и «завершён ли уже» (`completedAt`).
   *
   * Зачем: `SessionService.updateSession` — это замена ЦЕЛОГО значения
   * ключа `avatarVideo`, а не глубокое слияние (`session.service.ts`).
   * Вызывающий код в этом файле читает `current`/`session.avatarVideo`
   * ОДИН раз в начале обработки опроса, а затем идёт на внешний вызов
   * (Hedra/ffmpeg/скачивание файла) — на время которого этот снимок
   * может устареть. Без проверки более медленный параллельный опрос,
   * закончивший обработку позже, чем более быстрый, может переписать
   * уже готовый (и оплаченный) результат более раннего, устаревшего
   * состояния — включая откат `COMPLETE` обратно в `PROCESSING`/`FAILED`
   * (аудит 2026-09-09, Д-2: именно так гонка «двух опросов у дедлайна»
   * могла необратимо стереть уже досчитанный ролик).
   *
   * При конфликте ничего не пишем и отдаём то, что реально в БД —
   * оно всегда как минимум не хуже (не более устаревшее), чем то, что
   * собирались записать мы.
   */
  private async writeIfStillCurrent(
    sessionId: string,
    expected: AvatarVideo,
    next: AvatarVideo,
  ): Promise<AvatarVideo> {
    const fresh = await this.sessions.getSession(sessionId);
    const freshVideo = fresh?.avatarVideo;
    const stillCurrent =
      !!freshVideo &&
      freshVideo.status === expected.status &&
      freshVideo.renderedUrl === expected.renderedUrl &&
      freshVideo.subtitleJobId === expected.subtitleJobId &&
      !freshVideo.completedAt === !expected.completedAt;
    if (!stillCurrent) {
      this.logger.warn(
        `сессия ${sessionId}: состояние аватар-генерации изменил параллельный опрос, пока шёл внешний вызов — не перезаписываю (ожидали статус ${expected.status}, сейчас ${freshVideo?.status ?? '—'})`,
      );
      return freshVideo ?? expected;
    }
    await this.sessions.updateSession(sessionId, { avatarVideo: next });
    return next;
  }

  /**
   * Фаза 2 (этап 72а): у нас уже есть сырой файл Hedra
   * (`current.renderedUrl`) и `.srt` (`current.subtitleUrl`). Либо
   * отправляем задачу ffmpeg (первый заход сюда — `subtitleJobId` ещё
   * не задан), либо опрашиваем уже отправленную.
   */
  private async advanceSubtitleBurn(
    sessionId: string,
    current: AvatarVideo,
  ): Promise<AvatarVideo> {
    const rawUrl = current.renderedUrl;
    if (!rawUrl) {
      // Défensive: сюда не должны попасть без renderedUrl — но пустой
      // Hedra-результат обработан выше, а не здесь.
      return current;
    }

    if (!current.subtitleJobId) {
      if (!current.subtitleUrl || !this.ffmpeg.configured()) {
        // `.srt` не собран (не должно случиться — subtitleStatus уже
        // был бы 'failed') либо ffmpeg-сервис не настроен на этом
        // стенде — деградация, не поломка: ролик уходит без субтитров.
        return this.finalize(
          sessionId,
          current,
          rawUrl,
          !current.subtitleUrl
            ? undefined
            : 'сервис постобработки не настроен на этом стенде',
        );
      }

      // Замок — тот же приём, что у 'avatar-generate' и
      // `claimPostProduction` у Veo-пути: клиент опрашивает статус раз в
      // несколько секунд, и без замка два конкурентных опроса, оба
      // прочитавшие пустой `subtitleJobId`, оба отправили бы задачу
      // ffmpeg и оба списали бы расход — та же гонка, что уже закрыта
      // для постобработки Veo (`session.service.ts`, WORK_KINDS).
      const claimed = await this.sessions.claimWork(
        sessionId,
        'avatar-subtitle-burn',
        AVATAR_CLAIM_TTL_MS,
      );
      if (!claimed) {
        this.logger.log(
          `сессия ${sessionId}: отправку прожига субтитров уже занял другой опрос`,
        );
        return current;
      }

      try {
        // Гонка второго рода (аудит 2026-09-09, Д-1): замок выше защищает
        // только от ОДНОВРЕМЕННОГО захвата — если другой, более быстрый
        // опрос уже успел отправить задачу, получить результат и снять
        // замок ДО того, как замок достался нам, наш `current` всё ещё
        // показывает `subtitleJobId: null` (устаревший снимок, прочитанный
        // до чужой записи). Единственный способ узнать это честно —
        // перечитать сессию из БД ЗАНОВО, уже под замком, и проверить
        // САМЫЙ АКТУАЛЬНЫЙ `subtitleJobId`, а не доверять `current`. Это
        // и есть та проверка «check прямо перед платным вызовом», которую
        // `claimWork`-версия замка (в отличие от `claimPostProduction`
        // Veo-пути, атомарно завязанного на само поле) не даёт бесплатно.
        const fresh = await this.sessions.getSession(sessionId);
        const freshVideo = fresh?.avatarVideo;
        if (
          !freshVideo ||
          freshVideo.subtitleJobId ||
          freshVideo.status !== GenerationStatus.PROCESSING
        ) {
          this.logger.log(
            `сессия ${sessionId}: прожиг субтитров уже отправлен (или сессия уже завершена) другим опросом, пока мы ждали замок — вторую задачу не отправляем`,
          );
          return freshVideo ?? current;
        }

        // `subtitlesInputKey` здесь всегда непустая строка-константа
        // ('subs') — единственные ветки, где `planPostProduction` бросает
        // `PostProdError`, это некорректный `targetAspectRatio` (мы его
        // не передаём) и «крой+голос+субтитры все не нужны» (что
        // невозможно, раз субтитры нужны всегда). Раньше здесь стоял
        // try/catch на этот случай, скопированный из `postprod.service.ts`
        // (где он реально достижим) — недостижимый код, который аудит
        // 2026-09-09 (Д-6) отметил как вводящий в заблуждение; убран.
        const plan = planPostProduction({
          subtitlesInputKey: 'subs',
          subtitleForceStyle:
            SUBTITLE_THEME_FORCE_STYLE[freshVideo.subtitleTheme],
        });

        try {
          const job = await this.ffmpeg.submit({
            inputs: { source: rawUrl, subs: freshVideo.subtitleUrl! },
            outputs: [plan.outputName],
            commands: [plan.command],
          });
          await this.aiUsage.record({
            operation: 'reframe',
            model: 'ffmpeg-api',
            sessionId,
          });
          const withJob: AvatarVideo = {
            ...freshVideo,
            subtitleJobId: job.jobId,
            subtitleJobStartedAt: new Date(),
          };
          await this.sessions.updateSession(sessionId, {
            avatarVideo: withJob,
          });
          this.logger.log(
            `прожиг субтитров аватара запущен (задача ${job.jobId}) — сессия ${sessionId}`,
          );
          return withJob;
        } catch (error) {
          return this.finalize(
            sessionId,
            freshVideo,
            rawUrl,
            this.extractErrorMessage(error),
          );
        }
      } finally {
        await this.sessions.releaseWork(sessionId, 'avatar-subtitle-burn');
      }
    }

    // Задача уже отправлена — опрашиваем.
    if (avatarSubtitleExpired(current)) {
      return this.finalize(
        sessionId,
        current,
        rawUrl,
        `прожиг субтитров не завершился за ${AVATAR_SUBTITLE_DEADLINE_MS / 60000} минут — ролик доступен без них`,
      );
    }

    let status;
    try {
      status = await this.ffmpeg.status(current.subtitleJobId);
    } catch (error) {
      this.logger.warn(
        `ffmpeg status check failed (субтитры аватара), will retry: ${this.extractErrorMessage(error)}`,
      );
      return current; // сетевая икота — следующий опрос повторит
    }

    if (status.status === 'pending') {
      return current;
    }

    if (status.status === 'failed') {
      return this.finalize(
        sessionId,
        current,
        rawUrl,
        status.error ?? 'сервис постобработки вернул ошибку',
      );
    }

    const burnedUrl = status.outputs
      ? Object.values(status.outputs).find(Boolean)
      : undefined;
    if (!burnedUrl) {
      return this.finalize(
        sessionId,
        current,
        rawUrl,
        'задача прожига завершилась, но файла в ответе нет',
      );
    }

    try {
      const bytes = await this.download(burnedUrl);
      const pathname = `sessions/${sessionId}/avatar.mp4`;
      const { url } = await this.blob.uploadBuffer(
        pathname,
        bytes,
        'video/mp4',
      );
      const completed: AvatarVideo = {
        ...current,
        status: GenerationStatus.COMPLETE,
        completedAt: new Date(),
        downloadUrl: url,
        subtitleStatus: 'done',
        subtitleError: null,
      };
      // `writeIfStillCurrent` (Д-1/Д-2, аудит 2026-09-09): скачивание
      // прожжённого файла — тоже внешний вызов, во время которого
      // параллельный опрос той же сессии (например, уже упёршийся в
      // `avatarSubtitleExpired` на своём устаревшем снимке) мог успеть
      // записать «не удалось» — без проверки наш успешный результат
      // потерялся бы под чужой более ранней, но позже записанной ошибкой.
      const persisted = await this.writeIfStillCurrent(
        sessionId,
        current,
        completed,
      );
      if (persisted === completed) {
        this.logger.log(
          `Аватар-генерация завершена с субтитрами для сессии ${sessionId}`,
        );
      }
      return persisted;
    } catch (error) {
      return this.finalize(
        sessionId,
        current,
        rawUrl,
        this.extractErrorMessage(error),
      );
    }
  }

  /**
   * Завершить ролик БЕЗ (или без успешных) субтитров — тем же
   * «ухудшение, а не поломка», что и весь остальной пайплайн
   * постобработки: `subtitleError` заполняется, только если реально
   * что-то пошло не так (заказаны, но не удались); чекбокс просто
   * выключен — ошибки нет, `subtitleStatus` остаётся тем, каким уже был
   * ('skipped').
   *
   * Пишет через `writeIfStillCurrent` (Д-2, аудит 2026-09-09): вызывается
   * в том числе из ветки дедлайна прожига субтитров — если наш `current`
   * устарел (другой, более быстрый опрос уже успешно дописал субтитры,
   * пока мы ждали свой собственный, более медленный вызов), запись
   * «доставлено без субтитров» не должна перезаписывать уже готовый,
   * лучший результат.
   */
  private async finalize(
    sessionId: string,
    current: AvatarVideo,
    rawUrl: string,
    subtitleFailureReason?: string,
  ): Promise<AvatarVideo> {
    if (subtitleFailureReason) {
      this.logger.warn(
        `сессия ${sessionId}: прожиг субтитров аватара не удался — ${subtitleFailureReason}`,
      );
    }
    const completed: AvatarVideo = {
      ...current,
      status: GenerationStatus.COMPLETE,
      completedAt: new Date(),
      downloadUrl: rawUrl,
      subtitleStatus: subtitleFailureReason ? 'failed' : current.subtitleStatus,
      subtitleError: subtitleFailureReason ?? current.subtitleError,
    };
    const persisted = await this.writeIfStillCurrent(
      sessionId,
      current,
      completed,
    );
    if (persisted === completed) {
      this.logger.log(`Аватар-генерация завершена для сессии ${sessionId}`);
    }
    return persisted;
  }

  /**
   * Пишет `status: FAILED`. Через `writeIfStillCurrent` (Д-2, аудит
   * 2026-09-09) по той же причине, что у `finalize`: главный вызывающий
   * путь — таймаут дедлайна рендера/сети, вычисленный по устаревшему
   * `current`, а к моменту записи более быстрый параллельный опрос мог
   * уже завершить ролик успешно — тогда «неудача» не должна побеждать
   * уже готовый и оплаченный результат.
   */
  private async markFailed(
    sessionId: string,
    current: AvatarVideo,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<AvatarVideo> {
    const errorDetail: GenerationError = {
      code,
      message,
      timestamp: new Date(),
      retryable,
    };
    const failed: AvatarVideo = {
      ...current,
      status: GenerationStatus.FAILED,
      error: errorDetail,
    };
    const persisted = await this.writeIfStillCurrent(
      sessionId,
      current,
      failed,
    );
    if (persisted === failed) {
      this.logger.error(
        `Аватар-генерация не удалась для сессии ${sessionId}: ${message}`,
      );
    }
    return persisted;
  }

  /** GET /admin/actors/:sessionId/sound-check (этап 73). */
  async getSoundCheckState(
    sessionId: string,
  ): Promise<{ history: SoundCheck[] }> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    return session.soundCheck ?? { history: [] };
  }

  /**
   * POST /admin/actors/:sessionId/sound-check (этап 73) — по прямому
   * запросу владельца продукта: «когда Джемини отсматривает она может и
   * делать саундчек отдельным отчётом». У пилота аватара нет вообще
   * никакого артефакт-аудита (в отличие от Veo-пути, `VideoAuditService`)
   * — это первая Gemini-проверка результата этого пайплайна, и она сразу
   * про самый важный для этой задачи вопрос (см. §1 `doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md`):
   * не «сломано ли», а «звучит ли как реальный человек-блогер, а не как
   * типовой TTS».
   *
   * Промпт и разбор ответа — `common/sound-check.ts`, общие с Veo-путём
   * (`VideoAuditService.runSoundCheck`); сам вызов Gemini — свой, потому
   * что этот пайплайн admin-only и не проходит через тарифные гейты
   * `PlanService`, которые есть у Veo-пути.
   */
  async runSoundCheck(sessionId: string): Promise<{ history: SoundCheck[] }> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    const video = session.avatarVideo;
    if (
      !video ||
      video.status !== GenerationStatus.COMPLETE ||
      !video.downloadUrl
    ) {
      throw new BadRequestException(
        'Нет готового ролика для проверки звука — сначала дождитесь готовности рендера',
      );
    }

    // Е-3.1 шестого аудита: раньше метод шёл на медленный платный внешний
    // вызов (загрузка в Gemini Files + опрос готовности + generateContent)
    // и только потом писал `soundCheck` целиком через `updateSession` без
    // замка — тот же класс гонки, который уже закрыт для
    // 'avatar-generate'/'avatar-subtitle-burn'. Два параллельных запроса
    // «Проверить звук» (две вкладки — `RateLimitGuard` 5/15с обоих
    // пропускает) оба платили за отдельный Gemini-вызов, и какой
    // `updateSession` выполнялся позже, тот и «побеждал» — второй,
    // тоже оплаченный результат молча пропадал.
    const claimed = await this.sessions.claimWork(
      sessionId,
      'avatar-sound-check',
      AVATAR_CLAIM_TTL_MS,
    );
    if (!claimed) {
      this.logger.warn(
        `сессия ${sessionId}: параллельная проверка звука при уже занятом замке — отказ`,
      );
      throw new ConflictException(AVATAR_SOUND_CHECK_IN_FLIGHT_MESSAGE);
    }

    try {
      const check: SoundCheck = {
        checkId: uuidv4(),
        subject: 'avatar',
        requestedAt: new Date(),
        completedAt: null,
        status: 'complete',
        verdict: 'unknown',
        summary: '',
        notes: [],
      };
      try {
        const bytes = await this.download(video.downloadUrl);
        const file = await this.geminiFiles.uploadAndWaitActive(
          bytes,
          'video/mp4',
        );
        try {
          const res = await this.genai.models.generateContent({
            model: GEMINI_MODEL,
            contents: [
              { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
              { text: soundCheckPrompt('Russian') },
            ],
            config: { responseMimeType: 'application/json' },
          });
          await this.aiUsage.recordGemini(res, {
            operation: 'audit',
            model: GEMINI_MODEL,
            sessionId,
          });
          const parsed = parseSoundCheckResponse(res.text ?? '', 'ru');
          check.verdict = parsed.verdict;
          check.summary = parsed.summary;
          check.notes = parsed.notes;
        } finally {
          void this.geminiFiles.deleteFile(file.name);
        }
      } catch (error) {
        check.status = 'failed';
        check.error = this.extractErrorMessage(error);
        this.logger.error(
          `Проверка звука аватар-ролика не удалась для сессии ${sessionId}: ${check.error}`,
        );
      }
      check.completedAt = new Date();

      // Свежее чтение под замком непосредственно перед записью (Е-3.1) —
      // тот же приём, что уже применяется у других платных путей этого
      // файла: история строится поверх самого нового состояния из БД, а
      // не поверх снимка, прочитанного до начала долгого Gemini-вызова.
      const fresh = await this.sessions.getSession(sessionId);
      const state = appendSoundCheck(
        fresh?.soundCheck ?? session.soundCheck,
        check,
      );
      await this.sessions.updateSession(sessionId, { soundCheck: state });
      return state;
    } finally {
      await this.sessions.releaseWork(sessionId, 'avatar-sound-check');
    }
  }

  private async download(url: string): Promise<Buffer> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`скачивание результата Hedra: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return 'Unknown error during avatar generation';
  }
}
