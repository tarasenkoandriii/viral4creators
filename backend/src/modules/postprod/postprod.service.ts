/**
 * PostProductionService — доведение готового ролика (ТЗ §15.4/§16.1,
 * этапы 34–35).
 *
 * На этапе 34 здесь была только обрезка кадра. Этап 35 добавил вторую
 * операцию над тем же файлом — наложение своей звуковой дорожки, — и
 * важное решение принято именно здесь: обе делаются ОДНОЙ задачей
 * ffmpeg, а не двумя. Причины расписаны в `common/postprod.ts`; коротко —
 * два счёта, два перекодирования и гонка за порядок, из-за которой
 * озвучка регулярно ложилась бы на необрезанный кадр.
 *
 * ## Четыре решения, из которых состоит сервис
 *
 * 1. **Постобработка не блокирует выдачу.** Как только Veo закончил, у
 *    пользователя УЖЕ есть работающий ролик. Всё остальное идёт следом и
 *    заменяет ссылку, когда получится. Не настроено или упало — остаётся
 *    исходный файл с честной пометкой. Ухудшение, а не поломка.
 * 2. **Озвучка не отменяет обрезку.** Синтез может не состояться
 *    (нет ключа — штатное состояние стенда), и тогда задача всё равно
 *    уходит, просто без звуковой дорожки. Обратное — «нет голоса, значит
 *    и кадр не режем» — было бы наказанием за ненастроенный необязательный
 *    сервис.
 * 3. **Результаты переносятся в наш Blob.** И дорожка, и готовый ролик:
 *    ссылки чужих сервисов живут часы, а по §22 у каждого файла должен
 *    быть один владелец в нашей базе.
 * 4. **Исходник не удаляется.** Он остаётся под `renderedUrl` — и как
 *    страховка, и потому что сравнить «до и после» иногда единственный
 *    способ понять, что композиция поехала или голос лёг не туда.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { BlobService } from '../storage/blob.service';
import { SessionService } from '../../common/session.service';
import {
  ExportVariant,
  GeneratedVideo,
  GenerationStatus,
} from '../../common/types/generation.types';
import { planPostProduction, PostProdError } from '../../common/postprod';
import { NATIVE, planBatchReframe } from '../../common/reframe';
import { aspectRatioFamily } from '../../common/aspect-ratio';
import {
  normalizeVoiceMode,
  usesOwnVoice,
  VoiceMode,
} from '../../common/voice-mode';
import {
  cueTimings,
  firstCueSeconds,
  heuristicCueTimings,
  speakableText,
} from '../../common/voiceover-script';
import { resolveVoiceoverLanguage } from '../../common/voiceover';
import {
  buildSrt,
  normalizeSubtitlesMode,
  normalizeSubtitleTheme,
  SUBTITLE_THEME_FORCE_STYLE,
  SubtitleAlignment,
  SubtitleCue,
  SubtitlesMode,
  SubtitleTheme,
} from '../../common/subtitles';
import { VIDEO_DURATION_SECONDS } from '../../common/veo-duration';
import { FfmpegApiService } from './ffmpeg-api.service';
import { TTS_PROVIDER } from '../tts/tts.module';
import { TtsProvider } from '../tts/tts.types';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PlanService } from '../plan/plan.service';
import { Session } from '../../common/types/session.types';

/** Что именно предстоит сделать с готовым роликом. */
interface Work {
  /** Нужна ли обрезка кадра. */
  crop: string | null;
  /** Режим озвучки, как он записан в снимке бренда. */
  voiceMode: VoiceMode;
  /** Субтитры (этап 67), как они записаны в снимке бренда. */
  subtitlesMode: SubtitlesMode;
  subtitleTheme: SubtitleTheme;
  /**
   * Текст для синтеза и/или субтитров — уже очищенный от пометок о
   * сценах. Считается, если нужен синтез ИЛИ субтитры (не только синтез,
   * как до этапа 67): режиму `veo` синтез не нужен никогда, но текст для
   * субтитров есть всегда — это те же реплики, что написаны в промпте.
   */
  speech: string;
  /**
   * На какой секунде ролика начинается речь — из таймкодов, которые
   * модель уже написала в тексте (§15.4). Без сдвига голос стартует
   * поверх кадра-крючка, где по замыслу никто не говорит. Тот же сдвиг
   * используется как начало диапазона для эвристики субтитров в режиме
   * `veo` (этап 67).
   */
  speechStartSeconds: number;
  voiceId: string | null;
  ttsModel: string | null;
  language: string | null;
  /**
   * Провайдер, выпустивший `voiceId` (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md
   * §4.2) — `null`, если бренд не указывает (старая запись или голос не
   * выбран). Сверяется с активным `TTS_PROVIDER` стенда перед вызовом
   * синтеза: не молча использовать чужой идентификатор голоса.
   */
  ttsProvider: string | null;
}

/** Сколько ждём задачу ffmpeg, прежде чем закрыть её сбоем (этап 52). */
export const POSTPROD_DEADLINE_MS = 15 * 60 * 1000;
/**
 * Для записей до этапа 52, у которых нет `postStartedAt`, отсчёт идёт от
 * старта рендера с запасом на сам рендер: лучше поздний сбой, чем вечное
 * ожидание.
 */
const LEGACY_POSTPROD_DEADLINE_MS = 35 * 60 * 1000;

export function postProductionExpired(
  video: Pick<GeneratedVideo, 'postStartedAt' | 'initiatedAt'>,
  now: number = Date.now(),
): boolean {
  // Даты из JSON приходят строками — приводим, а не сравниваем как есть.
  const started = video.postStartedAt
    ? new Date(video.postStartedAt).getTime()
    : new Date(video.initiatedAt).getTime();
  if (!Number.isFinite(started)) return false;
  const limit = video.postStartedAt
    ? POSTPROD_DEADLINE_MS
    : LEGACY_POSTPROD_DEADLINE_MS;
  return now - started > limit;
}

/**
 * Дедлайн автоэкспорта яруса A (Е-2.2 шестого аудита, этап 76) — тот же
 * класс работы (пакетная задача ffmpeg-api), что и основная
 * постобработка, поэтому тот же срок. Без него зависшая или окончательно
 * недоступная (провайдер продолжает отвечать `pending`, либо задача
 * пропала — 404) задача блокирует ВСЕ следующие автоэкспорты для сессии
 * навсегда: `startExport` отказывает, пока есть хоть один `pending`
 * вариант яруса A, а способа вручную сбросить `exportJobId`/`exportVariants`
 * в коде нет.
 */
export const EXPORT_DEADLINE_MS = POSTPROD_DEADLINE_MS;

/** Захват работы 'export' (Е-2.1 шестого аудита) — с запасом на самый
 * долгий реалистичный шаг (сетевой submit/status ffmpeg-api, скачивание
 * и заливка готового файла в свой Blob). Один вид работы на ОБА яруса
 * (см. `WORK_KINDS` в `session.service.ts`) — гонка «потерянное
 * обновление» бьёт по общему полю `generatedVideo.exportVariants`
 * независимо от того, какой ярус его последним переписал. */
export const EXPORT_CLAIM_TTL_MS = 3 * 60 * 1000;

/** Самый ранний `requestedAt` среди ожидающих вариантов одного батча —
 * все варианты одного вызова `startExport` получают его одновременно,
 * так что для дедлайна достаточно самого старого. */
export function exportBatchExpired(
  pending: Pick<ExportVariant, 'requestedAt'>[],
  now: number = Date.now(),
): boolean {
  const timestamps = pending
    .map((v) => (v.requestedAt ? new Date(v.requestedAt).getTime() : NaN))
    .filter((t) => Number.isFinite(t));
  if (timestamps.length === 0) return false;
  const earliest = Math.min(...timestamps);
  return now - earliest > EXPORT_DEADLINE_MS;
}

@Injectable()
export class PostProductionService {
  private readonly logger = new Logger(PostProductionService.name);

  constructor(
    private readonly api: FfmpegApiService,
    @Inject(TTS_PROVIDER) private readonly tts: TtsProvider,
    private readonly blob: BlobService,
    private readonly sessions: SessionService,
    private readonly aiUsage: AiUsageService,
    private readonly plans: PlanService,
  ) {}

  /**
   * Запустить постобработку только что готового ролика. Возвращает
   * обновлённое состояние — вызывающему не нужно ничего перечитывать.
   *
   * Никогда не бросает: у пользователя на этот момент уже есть ролик, и
   * уронить ответ из-за необязательного улучшения было бы худшим из
   * возможных решений.
   */
  async start(
    sessionId: string,
    video: GeneratedVideo,
  ): Promise<GeneratedVideo> {
    // Быстрая отсечка по прочитанному состоянию: дешёвая и покрывает
    // подавляющее большинство повторов. От гонки она НЕ защищает —
    // этим занимается захват ниже.
    if (video.postStatus && video.postStatus !== 'skipped') return video;

    const source = video.downloadUrl;
    if (!source) return video;

    const session = await this.sessions.getSession(sessionId);
    const work = this.planWork(session, video);
    const wantsSubtitles = work.subtitlesMode === 'on';

    if (!work.crop && !usesOwnVoice(work.voiceMode) && !wantsSubtitles) {
      // Кадр родной, озвучка не заказана, субтитры выключены — делать
      // нечего, и это норма.
      return this.save(sessionId, video, {
        postStatus: 'skipped',
        reframePending: false,
        voiceMode: work.voiceMode,
        subtitlesMode: work.subtitlesMode,
        subtitleStatus: 'skipped',
      });
    }

    if (!this.api.configured()) {
      // Не ошибка: продукт работает как до этапа 34. Пометка нужна, чтобы
      // интерфейс не обещал того, чего не будет. `subtitlesMode`/
      // `subtitleStatus: 'skipped'` (Е-2.7 шестого аудита) — тот же
      // соседний патч выше (строка 204) уже их проставляет; здесь их не
      // было, хотя `work.subtitlesMode` уже посчитан — расхождение только
      // в поле, объясняющем ОТСУТСТВИЕ субтитров, основной оплаченный
      // ролик не задевало.
      return this.save(sessionId, video, {
        postStatus: 'skipped',
        postError: 'сервис постобработки не настроен на этом стенде',
        voiceMode: work.voiceMode,
        subtitlesMode: work.subtitlesMode,
        subtitleStatus: 'skipped',
      });
    }

    // ТЗ §26.4 (этап 38, А-2.15): постобработка — платные вызовы, и до
    // этого этапа они были единственными, кто проверку не проходил.
    //
    // Отказ здесь — НЕ исключение, в отличие от всех остальных платных
    // маршрутов. Разница в том, что ролик уже снят и отдан: уронить
    // ответ на опросе статуса значит показать пользователю ошибку вместо
    // готового ролика, за который он уже заплатил. Поэтому — пометка с
    // причиной, ровно как у ненастроенного сервиса.
    try {
      await this.plans.assertCanSpendSession(sessionId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`постобработка не оплачена: ${message}`);
      // Е-2.7 шестого аудита — та же пропажа `subtitlesMode`/
      // `subtitleStatus`, что и в патче выше на несостроенный сервис.
      return this.save(sessionId, video, {
        postStatus: 'skipped',
        postError: message,
        voiceMode: work.voiceMode,
        subtitlesMode: work.subtitlesMode,
        subtitleStatus: 'skipped',
      });
    }

    // ТЗ §15.4, этап 37: занять работу ОДНИМ запросом в базу — иначе
    // параллельные опросы статуса, каждый из которых прочитал пустой
    // `postStatus`, оплатят по своему синтезу и по своей задаче ffmpeg.
    // Захват идёт последним из проверок: занимать нечего, пока не решено,
    // что работа вообще нужна и сервис настроен.
    if (!(await this.sessions.claimPostProduction(sessionId))) {
      this.logger.log(
        `постобработку уже занял другой опрос — сессия ${sessionId}`,
      );
      return video;
    }

    // Голос синтезируем ДО задачи: ffmpeg нужен готовый файл, а не
    // обещание. Провал синтеза не отменяет обрезку (решение 2).
    let patch: Partial<GeneratedVideo> = {
      voiceMode: work.voiceMode,
      subtitlesMode: work.subtitlesMode,
    };
    let voiceUrl: string | null = null;
    let alignment: SubtitleAlignment | undefined;
    if (usesOwnVoice(work.voiceMode)) {
      // Тайминг alignment нужен, только если субтитры реально заказаны —
      // лишний JSON-ответ ElevenLabs вместо сырых байт был бы накладным
      // расходом там, где субтитры выключены.
      const voice = await this.synthesize(sessionId, work, wantsSubtitles);
      patch = { ...patch, ...voice.patch };
      voiceUrl = voice.url;
      alignment = voice.alignment;
    }

    // Субтитры собираем ДО задачи, тем же принципом, что и голос: ffmpeg
    // нужен готовый `.srt`-файл. Провал сборки не отменяет ни обрезку,
    // ни голос (то же «ухудшение, а не поломка», решение 6 плана этапа
    // 67) — задача просто уйдёт без субтитрового фильтра.
    let subsUrl: string | null = null;
    if (wantsSubtitles) {
      const subs = await this.buildSubtitles(sessionId, work, alignment);
      patch = { ...patch, ...subs.patch };
      subsUrl = subs.url;
    }

    let plan;
    try {
      plan = planPostProduction({
        targetAspectRatio: work.crop,
        voiceInputKey: voiceUrl ? 'voice' : null,
        voiceMode: work.voiceMode === 'dub' ? 'dub' : 'voiceover',
        voiceDelayMs: Math.round(work.speechStartSeconds * 1000),
        subtitlesInputKey: subsUrl ? 'subs' : null,
        subtitleForceStyle: subsUrl
          ? SUBTITLE_THEME_FORCE_STYLE[work.subtitleTheme]
          : null,
      });
    } catch (e) {
      // Сюда попадает и «делать нечего» — например, кадр родной, голос не
      // синтезировался и субтитры не собрались. Правильная реакция —
      // снять флаг, а не чинить.
      const message = e instanceof PostProdError ? e.message : String(e);
      this.logger.warn(`постобработка не нужна или невозможна: ${message}`);
      return this.save(sessionId, video, {
        ...patch,
        postStatus: 'skipped',
        reframePending: false,
      });
    }

    const inputs: Record<string, string> = { source };
    if (voiceUrl) inputs.voice = voiceUrl;
    if (subsUrl) inputs.subs = subsUrl;

    try {
      const job = await this.api.submit({
        inputs,
        outputs: [plan.outputName],
        commands: [plan.command],
      });
      await this.aiUsage.record({
        operation: 'reframe',
        model: 'ffmpeg-api',
        sessionId,
      });
      this.logger.log(
        `постобработка запущена (задача ${job.jobId}): ` +
          `${plan.crop ? `кадр ${video.renderedAspectRatio} → ${plan.crop.target}` : 'кадр без изменений'}, ` +
          `${plan.audio ? `звук — ${plan.audio.mode}` : 'звук без изменений'}, ` +
          `${plan.subtitles ? 'субтитры вшиты' : 'без субтитров'}`,
      );
      return this.save(sessionId, video, {
        ...patch,
        postStatus: 'pending',
        postJobId: job.jobId,
        postStartedAt: new Date(),
        postError: undefined,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`не удалось отправить постобработку: ${message}`);
      return this.save(sessionId, video, {
        ...patch,
        postStatus: 'failed',
        postError: message,
      });
    }
  }

  /**
   * Опросить идущую задачу и, если она готова, забрать результат.
   * Вызывается из того же опроса статуса генерации, что и Veo, — второй
   * механизм опроса ради одной операции был бы лишним.
   */
  async poll(
    sessionId: string,
    video: GeneratedVideo,
  ): Promise<GeneratedVideo> {
    if (video.postStatus !== 'pending') return video;

    if (!video.postJobId) {
      // Захват состоялся, а до отправки задачи дело не дошло: процесс
      // умер между ними (на Vercel это обычное дело — таймаут функции).
      // Оставить как есть значит вечное «обрезаем…», которое никогда не
      // закончится; поэтому честно закрываем сбоем. Ролик у пользователя
      // рабочий, и он хотя бы узнает, почему обработки не будет.
      this.logger.warn(
        `постобработка занята, но задача не отправлена — сессия ${sessionId}`,
      );
      return this.save(sessionId, video, {
        postStatus: 'failed',
        postError:
          'обработка не запустилась — попробуйте сгенерировать ролик заново',
      });
    }

    // Этап 52 (В-2.7): у ожидания есть дедлайн. Любой незнакомый статус
    // провайдера читался как «идёт», любая ошибка опроса — как «оставляем
    // как есть», включая постоянную (задачи нет, 404). Клиент опрашивал
    // каждые четыре секунды бесконечно, а аудит отвечал «дождитесь готовой
    // версии» и не отпускал никогда. Обрезка и озвучка укладываются в
    // минуты; четверть часа без ответа — это не «долго», это «не будет».
    if (postProductionExpired(video)) {
      this.logger.warn(
        `постобработка не завершилась за ${POSTPROD_DEADLINE_MS / 60000} мин — сессия ${sessionId}, задача ${video.postJobId}`,
      );
      return this.save(sessionId, video, {
        postStatus: 'failed',
        postError:
          'обработка не завершилась в отведённое время — ролик доступен без неё',
      });
    }

    let status;
    try {
      status = await this.api.status(video.postJobId);
    } catch (e) {
      // Сетевая икота — оставляем как есть, следующий опрос повторит;
      // затянувшуюся серию икот закроет дедлайн выше.
      this.logger.warn(
        `статус постобработки недоступен: ${e instanceof Error ? e.message : String(e)}`,
      );
      return video;
    }

    if (status.status === 'pending') return video;

    if (status.status === 'failed') {
      this.logger.warn(
        `постобработка не удалась: ${status.error ?? 'без причины'}`,
      );
      return this.save(sessionId, video, {
        postStatus: 'failed',
        postError: status.error ?? 'сервис постобработки вернул ошибку',
      });
    }

    const url = status.outputs
      ? Object.values(status.outputs).find(Boolean)
      : undefined;
    if (!url) {
      return this.save(sessionId, video, {
        postStatus: 'failed',
        postError: 'задача завершилась, но файла в ответе нет',
      });
    }

    try {
      const bytes = await this.download(url);
      const pathname = this.finalPathname(sessionId, video);
      const { url: ourUrl } = await this.blob.uploadBuffer(
        pathname,
        bytes,
        'video/mp4',
      );
      this.logger.log(`постобработка готова: ${bytes.length} байт`);
      return this.save(sessionId, video, {
        postStatus: 'complete',
        reframePending: false,
        postPathname: pathname,
        // Исходник остаётся доступным — и как страховка, и чтобы можно
        // было сравнить «до и после».
        renderedUrl: video.renderedUrl ?? video.downloadUrl,
        downloadUrl: ourUrl,
        fileSize: bytes.length,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`не удалось забрать готовый ролик: ${message}`);
      return this.save(sessionId, video, {
        postStatus: 'failed',
        postError: message,
      });
    }
  }

  /**
   * Автоэкспорт, ярус A (TODO §III, «Уровень 6», п.35;
   * `doc/MULTI-FORMAT-EXPORT-SPEC.md` §3/§8, этап 75) — дешёвая обрезка
   * УЖЕ готового файла (после основной постобработки, со звуком и
   * субтитрами, если они были) в несколько дополнительных форматов ОДНОЙ
   * пакетной задачей ffmpeg. В отличие от `start()`, вызывается явно
   * пользователем, а не автоматически из опроса статуса — поэтому, в
   * отличие от `start()`, БРОСАЕТ на отказе, а не сохраняет причину в
   * поле: это отдельное платное действие с собственной кнопкой, и
   * пользователь должен узнать об отказе сразу, а не по молчаливому
   * `postError`.
   *
   * ## Захват работы + свежее чтение (Е-2.1 шестого аудита, этап 76)
   *
   * До этой правки вся проверка и запись шли по снимку `video`,
   * прочитанному ВЫЗЫВАЮЩИМ кодом (`ExportService.ownSessionWithVideo`)
   * ещё ДО этого метода — двойной клик «Экспортировать», два таба или
   * повтор после клиентского таймаута проходили снимочную проверку «нет
   * ожидающего варианта», оба реально платили за отдельную ffmpeg-задачу,
   * и один `exportVariants` бесследно терялся при записи (`updateSession`
   * заменяет `generatedVideo` целиком, а не сливает поля). Приём —
   * тот же, что `ActorsService.advanceSubtitleBurn` (docstring
   * `ffmpeg-api.service.ts` прямо называет его образцом для этого
   * файла): захватить работу, ЗАНОВО прочитать сессию УЖЕ под замком,
   * проверить самое актуальное состояние — и только потом платить.
   * `video`-параметр остаётся запасным на случай, если сессия успела
   * исчезнуть между чтением вызывающего кода и захватом (`?? video`
   * ниже) — не более устаревшим источником, чем раньше.
   */
  async startExport(
    sessionId: string,
    video: GeneratedVideo,
    targets: string[],
  ): Promise<GeneratedVideo> {
    if (!this.api.configured()) {
      throw new PostProdError(
        'сервис постобработки не настроен на этом стенде — автоэкспорт недоступен',
      );
    }

    const claimed = await this.sessions.claimWork(
      sessionId,
      'export',
      EXPORT_CLAIM_TTL_MS,
    );
    if (!claimed) {
      throw new PostProdError(
        'автоэкспорт уже выполняется — дождитесь его завершения',
      );
    }
    try {
      const fresh = await this.sessions.getSession(sessionId);
      const freshVideo = fresh?.generatedVideo ?? video;

      if (
        freshVideo.status !== GenerationStatus.COMPLETE ||
        !freshVideo.downloadUrl
      ) {
        throw new PostProdError(
          'ролик ещё не готов — автоэкспорт доступен только для готового ролика',
        );
      }
      if (
        (freshVideo.exportVariants ?? []).some(
          (v) => v.tier === 'A' && v.status === 'pending',
        )
      ) {
        throw new PostProdError(
          'предыдущий автоэкспорт ещё выполняется — дождитесь его завершения',
        );
      }

      // Семейство считаем от РЕАЛЬНО отрендеренного Veo-кадра, а не от
      // запрошенного `aspectRatio`: обрезать можно только из того, что
      // физически есть в файле.
      const sourceFamily = aspectRatioFamily(
        freshVideo.renderedAspectRatio ?? freshVideo.aspectRatio ?? '9:16',
      );
      const already = new Set(
        [
          freshVideo.aspectRatio,
          ...(freshVideo.exportVariants ?? []).map((v) => v.format),
        ].filter((v): v is string => !!v),
      );

      const wanted: string[] = [];
      const rejected: string[] = [];
      for (const raw of targets) {
        const target = raw?.trim();
        if (!target || already.has(target)) continue; // уже есть — второй раз не просим
        if (aspectRatioFamily(target) !== sourceFamily) {
          rejected.push(target);
          continue;
        }
        wanted.push(target);
      }
      if (rejected.length) {
        throw new PostProdError(
          `формат(ы) ${rejected.join(', ')} — из другого семейства кадра, для них ` +
            'нужен повторный рендер (POST /export/rerender), а не дешёвая обрезка',
        );
      }

      const items = planBatchReframe(wanted);
      if (!items.length) {
        throw new PostProdError(
          'нет новых форматов для автоэкспорта — все уже готовы, совпадают с ' +
            'исходным или родные для Veo',
        );
      }

      // §26.4: платный вызов, инициированный явным действием пользователя —
      // отказ здесь ДОЛЖЕН быть исключением (в отличие от `start()`,
      // вызываемого из хот-пути опроса статуса).
      await this.plans.assertCanSpendSession(sessionId);

      const job = await this.api.submit({
        inputs: { source: freshVideo.downloadUrl },
        outputs: items.map((i) => i.outputName),
        commands: items.map((i) => i.command),
      });
      // Один вызов — одна запись в журнале расходов, независимо от числа
      // форматов внутри батча (решение владельца продукта, этап 75,
      // §7.3 документа): дешевле для пользователя, реальный счёт
      // хостед-сервиса не проверен по числу команд в задаче.
      await this.aiUsage.record({
        operation: 'reframe',
        model: 'ffmpeg-api',
        sessionId,
      });
      this.logger.log(
        `автоэкспорт запущен (задача ${job.jobId}): форматы ${items
          .map((i) => i.target)
          .join(', ')}`,
      );

      const now = new Date().toISOString();
      const newVariants: ExportVariant[] = items.map((i) => ({
        format: i.target,
        tier: 'A',
        status: 'pending',
        outputName: i.outputName,
        requestedAt: now,
      }));
      return this.save(sessionId, freshVideo, {
        exportJobId: job.jobId,
        exportVariants: [...(freshVideo.exportVariants ?? []), ...newVariants],
      });
    } finally {
      await this.sessions.releaseWork(sessionId, 'export');
    }
  }

  /**
   * Опросить задачу автоэкспорта яруса A (та же логика, что `poll()` для
   * основной постобработки — вызывается из того же цикла опроса статуса
   * генерации). Ничего не делает, если пакетной задачи нет или ждать
   * больше нечего.
   *
   * Е-2.2 шестого аудита: дедлайн на «всё ещё выполняется», тем же
   * приёмом, что `postProductionExpired()` у основной постобработки —
   * без него зависшая или окончательно недоступная задача блокирует ВСЕ
   * следующие автоэкспорты для сессии навсегда (`startExport` отказывает,
   * пока есть pending-вариант яруса A).
   *
   * Е-2.1 шестого аудита: захват работы + свежее чтение — тот же приём и
   * то же обоснование, что у `startExport` (см. её доккомментарий) —
   * только берётся ПОСЛЕ дешёвого «нечего делать» и «сеть недоступна»
   * выходов: незачем захватывать замок ради тика, который и так ничего
   * не запишет.
   */
  async pollExport(
    sessionId: string,
    video: GeneratedVideo,
  ): Promise<GeneratedVideo> {
    const pending = (video.exportVariants ?? []).filter(
      (v) => v.tier === 'A' && v.status === 'pending',
    );
    if (!video.exportJobId || pending.length === 0) return video;

    let status;
    try {
      status = await this.api.status(video.exportJobId);
    } catch (e) {
      this.logger.warn(
        `статус автоэкспорта недоступен: ${e instanceof Error ? e.message : String(e)}`,
      );
      return video; // сетевая икота — следующий опрос повторит
    }

    if (status.status === 'pending') {
      if (!exportBatchExpired(pending)) return video;
      this.logger.warn(
        `автоэкспорт не завершился за ${EXPORT_DEADLINE_MS / 60000} мин — сессия ${sessionId}, задача ${video.exportJobId}`,
      );
      // Не возвращаемся сразу — ниже, под замком, закрываем ожидающие
      // варианты сбоем (тот же путь записи, что и настоящий провал
      // провайдера, см. `status.status === 'failed'` внутри блока).
    }

    const claimed = await this.sessions.claimWork(
      sessionId,
      'export',
      EXPORT_CLAIM_TTL_MS,
    );
    if (!claimed) {
      this.logger.log(
        `результат автоэкспорта уже обрабатывает другой опрос — сессия ${sessionId}`,
      );
      return video;
    }
    try {
      const fresh = await this.sessions.getSession(sessionId);
      const freshVideo = fresh?.generatedVideo ?? video;
      const freshPending = (freshVideo.exportVariants ?? []).filter(
        (v) => v.tier === 'A' && v.status === 'pending',
      );
      if (!freshVideo.exportJobId || freshPending.length === 0) {
        // Параллельный опрос уже обработал результат, пока мы ждали
        // замок/сеть — ничего дописывать не нужно.
        return freshVideo;
      }

      if (status.status === 'pending') {
        // Дедлайн истёк (проверка выше) — закрываем сбоем все ещё
        // ожидающие варианты яруса A этого батча.
        return this.save(sessionId, freshVideo, {
          exportVariants: (freshVideo.exportVariants ?? []).map((v) =>
            v.tier === 'A' && v.status === 'pending'
              ? {
                  ...v,
                  status: 'failed',
                  error: 'автоэкспорт не завершился в отведённое время',
                }
              : v,
          ),
        });
      }

      if (status.status === 'failed') {
        const failed = status.error ?? 'сервис постобработки вернул ошибку';
        return this.save(sessionId, freshVideo, {
          exportVariants: (freshVideo.exportVariants ?? []).map((v) =>
            v.tier === 'A' && v.status === 'pending'
              ? { ...v, status: 'failed', error: failed }
              : v,
          ),
        });
      }

      const outputs = status.outputs ?? {};
      const nextVariants: ExportVariant[] = [];
      for (const v of freshVideo.exportVariants ?? []) {
        if (v.tier !== 'A' || v.status !== 'pending') {
          nextVariants.push(v);
          continue;
        }
        const url = v.outputName ? outputs[v.outputName] : undefined;
        if (!url) {
          nextVariants.push({
            ...v,
            status: 'failed',
            error:
              'задача завершилась, но файла для этого формата в ответе нет',
          });
          continue;
        }
        try {
          const bytes = await this.download(url);
          const pathname = `sessions/${sessionId}/export-${v.format.replace(/[^0-9]+/g, 'x')}.mp4`;
          const { url: ourUrl } = await this.blob.uploadBuffer(
            pathname,
            bytes,
            'video/mp4',
          );
          nextVariants.push({
            ...v,
            status: 'complete',
            pathname,
            url: ourUrl,
          });
        } catch (e) {
          nextVariants.push({
            ...v,
            status: 'failed',
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      this.logger.log(
        `автоэкспорт готов: ${nextVariants.filter((v) => v.tier === 'A' && v.status === 'complete').length} формат(ов)`,
      );
      return this.save(sessionId, freshVideo, { exportVariants: nextVariants });
    } finally {
      await this.sessions.releaseWork(sessionId, 'export');
    }
  }

  /**
   * Что предстоит сделать. Отдельным шагом и чистым по духу — чтобы
   * решение «резать / озвучивать» можно было прочитать целиком, не
   * распутывая его по ветвям `start`.
   */
  private planWork(
    session: Session | null | undefined,
    video: GeneratedVideo,
  ): Work {
    const brand = session?.brandManifestSnapshot;
    const voiceMode = normalizeVoiceMode(brand?.voiceMode);
    const subtitlesMode = normalizeSubtitlesMode(brand?.subtitlesMode);
    const subtitleTheme = normalizeSubtitleTheme(brand?.subtitleTheme);
    // Родной для Veo формат — это «резать нечего», а не «резать в тот же
    // формат». Разобраться в этом надо ЗДЕСЬ, до захвата работы: иначе
    // ролик 9:16 без озвучки успевал бы занять постобработку и тут же
    // отменить её, оставив в базе лишний переход pending → skipped.
    const wanted = video.reframePending ? (video.aspectRatio ?? null) : null;
    const crop =
      wanted && !(NATIVE as readonly string[]).includes(wanted) ? wanted : null;

    // `??`, а не `||`: пустая строка в `finalVoiceoverScript` означает
    // «пользователь стёр реплики» и обязана победить текст от GPT
    // (этап 37, А-2.5). `||` откатил бы к сгенерированному.
    const script =
      session?.generationPrompt?.finalVoiceoverScript ??
      session?.generationPrompt?.voiceoverScript ??
      null;
    // Этап 67: текст нужен не только для синтеза, но и для субтитров —
    // в режиме `veo` синтеза нет никогда, а субтитры (best-effort) есть,
    // если бренд их включил. Разъединяем условие, а не считаем текст
    // всегда: пустая работа на сессиях без субтитров не нужна.
    const wantsSubtitles = subtitlesMode === 'on';
    const speech =
      usesOwnVoice(voiceMode) || wantsSubtitles ? speakableText(script) : '';

    return {
      crop,
      voiceMode,
      subtitlesMode,
      subtitleTheme,
      speech,
      speechStartSeconds: speech ? firstCueSeconds(script) : 0,
      voiceId: brand?.ttsVoiceId ?? null,
      ttsModel: brand?.ttsModel ?? null,
      ttsProvider: brand?.ttsProvider ?? null,
      language: session?.productInformation
        ? resolveVoiceoverLanguage(session.productInformation).language
        : null,
    };
  }

  /**
   * Синтез и перенос дорожки в наш Blob. Возвращает патч состояния и
   * ссылку для ffmpeg; ссылки нет — значит задача пойдёт без звука.
   * `withTimestamps` запрашивает пословное выравнивание у провайдера
   * (этап 67) — только когда субтитры реально нужны в voiceover/dub.
   */
  private async synthesize(
    sessionId: string,
    work: Work,
    withTimestamps: boolean,
  ): Promise<{
    patch: Partial<GeneratedVideo>;
    url: string | null;
    alignment?: SubtitleAlignment;
  }> {
    if (!work.speech) {
      return {
        patch: {
          voiceStatus: 'skipped',
          voiceError: 'текста озвучки нет — напишите реплики на шаге промпта',
        },
        url: null,
      };
    }

    // doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.2: голос помечен, каким
    // провайдером выпущен — если это ЗАДАНО и не совпадает с активным
    // на стенде, `voiceId` для другого провайдера бессмысленен, и звать
    // его — заведомо обречённый платный вызов. `null` — старая запись
    // или голос не выбран — пропускает проверку намеренно (нечего
    // сверять, а не «сверка провалена»).
    if (work.ttsProvider && work.ttsProvider !== this.tts.providerKey) {
      this.logger.warn(
        `голос настроен для провайдера ${work.ttsProvider}, активен ${this.tts.providerKey} — синтез пропущен`,
      );
      return {
        patch: {
          voiceStatus: 'failed',
          voiceError:
            'голос настроен для другого провайдера синтеза — выберите голос заново в манифесте бренда',
        },
        url: null,
      };
    }

    const outcome = await this.tts.synthesize({
      text: work.speech,
      voiceId: work.voiceId,
      model: work.ttsModel,
      language: work.language,
      timestamps: withTimestamps,
    });

    if (!outcome.ok) {
      // «Не настроено» и «сломалось» показываются по-разному, поэтому и
      // хранятся по-разному: первое не повод идти разбираться.
      this.logger.warn(`озвучка не состоялась: ${outcome.reason}`);
      return {
        patch: {
          voiceStatus: outcome.skipped ? 'skipped' : 'failed',
          voiceError: outcome.reason,
        },
        url: null,
      };
    }

    await this.aiUsage.record({
      operation: 'voiceover',
      model: `${this.tts.providerKey}-tts`,
      sessionId,
      characters: outcome.characters,
    });

    try {
      const pathname = `sessions/${sessionId}/voiceover.mp3`;
      const { url } = await this.blob.uploadBuffer(
        pathname,
        outcome.audio,
        outcome.mimeType,
      );
      return {
        patch: {
          voiceStatus: 'synthesized',
          voiceError: undefined,
          voiceoverPathname: pathname,
          voiceoverUrl: url,
          voiceCharacters: outcome.characters,
        },
        url,
        alignment: outcome.alignment,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`не удалось сохранить дорожку: ${message}`);
      return {
        patch: { voiceStatus: 'failed', voiceError: message },
        url: null,
      };
    }
  }

  /**
   * Собрать `.srt` и перенести в наш Blob (этап 67). Возвращает патч
   * состояния и ссылку для ffmpeg; ссылки нет — задача пойдёт без
   * субтитрового фильтра (то же «ухудшение, а не поломка», что у
   * голоса — ни кроп, ни звук из-за этого не отменяются).
   *
   * Тайминг — по двум путям: `alignment` есть (voiceover/dub, реальное
   * пословное выравнивание от ElevenLabs) — `cueTimings`; `alignment`
   * нет (`veo` — синтеза не было и взять неоткуда) — `heuristicCueTimings`
   * по фиксированной длительности ролика (best-effort, решение владельца
   * продукта).
   */
  private async buildSubtitles(
    sessionId: string,
    work: Work,
    alignment?: SubtitleAlignment,
  ): Promise<{ patch: Partial<GeneratedVideo>; url: string | null }> {
    if (!work.speech) {
      return {
        patch: {
          subtitleStatus: 'skipped',
          subtitleError:
            'текста для субтитров нет — напишите реплики на шаге промпта',
        },
        url: null,
      };
    }

    const cues: SubtitleCue[] = alignment
      ? cueTimings(work.speech, alignment)
      : heuristicCueTimings(
          work.speech,
          work.speechStartSeconds,
          VIDEO_DURATION_SECONDS,
        );

    const srt = buildSrt(cues);
    if (!srt.trim()) {
      return {
        patch: {
          subtitleStatus: 'skipped',
          subtitleError: 'не удалось разобрать текст на субтитры',
        },
        url: null,
      };
    }

    try {
      const pathname = `sessions/${sessionId}/subtitles.srt`;
      const { url } = await this.blob.uploadBuffer(
        pathname,
        Buffer.from(srt, 'utf8'),
        'text/plain',
      );
      return {
        patch: {
          // `burned` здесь значит «дорожка субтитров готова и передана в
          // задачу ffmpeg» — тот же смысл, что у voiceStatus:
          // 'synthesized' независимо от исхода самой задачи постобработки.
          subtitleStatus: 'burned',
          subtitleError: undefined,
          subtitlePathname: pathname,
          subtitleUrl: url,
        },
        url,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`не удалось сохранить субтитры: ${message}`);
      return {
        patch: { subtitleStatus: 'failed', subtitleError: message },
        url: null,
      };
    }
  }

  /**
   * `sessions/<id>/generated-4x5.mp4` — рядом с исходным, но не поверх
   * него. Без обрезки формат в имени взять неоткуда, поэтому суффикс
   * говорит о звуке: два разных результата не должны делить один путь.
   */
  private finalPathname(sessionId: string, video: GeneratedVideo): string {
    const suffix =
      video.reframePending && video.aspectRatio
        ? video.aspectRatio.replace(/[^0-9]+/g, 'x')
        : 'voiced';
    return `sessions/${sessionId}/generated-${suffix}.mp4`;
  }

  private async download(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`скачивание результата: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private async save(
    sessionId: string,
    video: GeneratedVideo,
    patch: Partial<GeneratedVideo>,
  ): Promise<GeneratedVideo> {
    const next = { ...video, ...patch };
    await this.sessions.updateSession(sessionId, { generatedVideo: next });
    return next;
  }
}
