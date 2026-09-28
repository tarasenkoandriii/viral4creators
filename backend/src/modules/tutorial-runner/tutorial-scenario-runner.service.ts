/**
 * TutorialScenarioRunnerService — крон-воркер `tutorial-scenario-run`
 * (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §5, этап 97).
 *
 * Проигрывает уже сгенерированные и, если платные, одобренные
 * сценарии (этап 94, `tutorial-scenario-generate`) настоящим headless-
 * браузером (`common/headless-chromium.ts`, этап 95) против фикстурного
 * пользователя (§3.3 ТЗ, `common/fixture-token.ts` + `scripts/seed-
 * fixture-user.ts`) и пишет результат в `TutorialScenario.lastRunAt/
 * lastRunStatus/lastRunError`.
 *
 * ## Регрессионный прогон (§5/§6.1 ТЗ, этап 97)
 *
 * Это в первую очередь РЕГРЕССИОННЫЙ прогон — та часть §5 ТЗ, которая
 * проверяет, что экраны мастера всё ещё доходят до конца без ошибок
 * (§6.1 ТЗ: «провал сценария — сигнал, что что-то сломалось… одновременно
 * служит функциональным regression-тестом»). Видео — вторичный, не
 * блокирующий побочный продукт успешного прогона (см. ниже).
 *
 * ## Видео (этап 98) — слайд-шоу из кадров через внешний ffmpeg-api, не puppeteer-запись
 *
 * §4.2 ТЗ предлагает Playwright с `recordVideo`, но реальная
 * инфраструктура этапа 95 — puppeteer-core, у которого нет встроенного
 * эквивалента (его собственный `page.screencast()` есть, но требует
 * ЛОКАЛЬНЫЙ ffmpeg-бинарник на диске — которого на Vercel Functions нет,
 * см. `postprod/ffmpeg-api.service.ts`). Вместо непрерывной записи —
 * `scenario-runner.ts` с `captureFrames: true` снимает по PNG-скриншоту
 * после каждого успешного шага, этот сервис грузит их как транзитные
 * файлы в Blob (`tutorial-video-frames/{assetId}/{номер шага}.png`
 * — по id АКТИВА и номеру ШАГА, почему именно так, см. у
 * `scenarioFramePrefix` и у `ScenarioFrame`; тот же
 * транзитный приём, что у референсного видео анализа) и отправляет
 * задачу СБОРКИ слайд-шоу в УЖЕ СУЩЕСТВУЮЩИЙ внешний ffmpeg-api
 * (`FfmpegApiService`, `tutorial-video-assembly.ts`) — тот же провайдер,
 * что уже кроит кадр и переозвучивает рекламные ролики, а не вторая
 * инфраструктура. Задача асинхронна (submit на этом тике, poll — на
 * следующих, тот же приём, что `PostProductionService.poll`), поэтому
 * каждый вызов `run()` СНАЧАЛА опрашивает незавершённые сборки прошлых
 * тиков (`pollPendingVideoAssets`), и только потом проигрывает новые
 * сценарии. Готовое видео скачивается с внешнего API и перезаливается в
 * НАШ Blob (§4.3 ТЗ) — как уже делает `PostProductionService.poll` для
 * рекламных роликов, не вторая копия логики.
 *
 * Видео собирается ТОЛЬКО при успешном прогоне (`result.ok === true`) —
 * слайд-шоу из сценария, упавшего на середине, не показывает ничего
 * полезного, а лишний платный вызов внешнего API того не стоит. Сборка —
 * best-effort: неудача отправки (не настроен `FFMPEG_API_KEY`, сбой
 * сети) логируется и НЕ трогает уже записанный `lastRunStatus` —
 * regression-результат самоценен независимо от того, получилось ли
 * видео (см. доккомментарий `scenario-runner.ts` про честное «слайд-шоу»,
 * не «видео» в полном смысле). `TutorialVideoAsset` создаётся строкой
 * `reviewed: false` (§4.6 ТЗ) — админский просмотр/одобрение и
 * консультантское действие `video` (§4.8/§4.9 ТЗ) — предмет отдельного,
 * следующего этапа.
 *
 * ## Сколько роликов накапливается и кто их убирает (§11-тер ТЗ)
 *
 * Прогон идёт по всем сценариям КАЖДУЮ ночь, и без двух ограничителей
 * ниже это означало бы до тридцати новых строк и mp4 за ночь,
 * навсегда.
 *
 * Первый — не собирать лишнего. §7.2 ТЗ обещает, что ролики
 * пересобираются при изменении интерфейса или текста шага, а не по
 * расписанию; исполняет это `contentHash` (`slideshowContentHash` от
 * байтов кадров, дорожки и длительностей): совпал с отпечатком
 * последнего собранного ролика пары — задача не отправляется и строка
 * не заводится.
 *
 * Второй — убирать лишнее. `sweepOldAssets` ходит вместе с опросом
 * сборок и держит на пару (шаг, локаль) до трёх строк, по одной на
 * роль; подробности и границы — в его доккомментарии.
 *
 * ## Почему платные сценарии не тратят деньги на этом прогоне
 *
 * `triggerPaidOperation` — декларативный маркер и на генерации, и на
 * исполнении (см. `scenario-runner.ts`): регрессионный прогон нужен
 * КАЖДУЮ ночь, а платить за настоящий рендер Veo/переозвучку при
 * каждом прогоне крона нельзя — `approved` (§4.11 ТЗ) в принципе не про
 * «можно тратить при каждом regression-тесте», а про будущий видео-
 * захват, где платный шаг случится по-настоящему один раз для записи.
 * Оценка `costly`/`approved` здесь используется только как входной
 * фильтр (см. ниже), не как разрешение тратить.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ProjectType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import { BlobService } from '../storage/blob.service';
import { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { TtsProviderResolverService } from '../tts/tts-provider-resolver.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import {
  launchHeadlessBrowser,
  withTimeout,
} from '../../common/headless-chromium';
import { runScenario, ScenarioFrame, ScenarioPage } from './scenario-runner';
import { FixtureRouteContext, resolveScenarioRoute } from './route-templates';
import {
  evenFrameSeconds,
  narrationFrameSeconds,
  planSlideshow,
  slideshowContentHash,
  SlideshowFrame,
} from './tutorial-video-assembly';
import {
  hasTutorialSteps,
  parseTutorialLocales,
  tutorialStepFor,
  TUTORIAL_LOCALES_SETTING_KEY,
} from '../tutorial-scenario/tutorial-locales';
import {
  narrationTextForSubject,
  parseRequireNarrationReview,
  parseTutorialVoiceSetting,
  TUTORIAL_REQUIRE_NARRATION_REVIEW_KEY,
  TUTORIAL_VOICE_SETTING_KEY,
  TutorialVoiceKey,
  matchesVoiceKey,
  VOICE_SLOT_WHOLE,
  voiceoverCachePathname,
  voiceoverCachePrefix,
  voiceoverDurationMsFromPathname,
  voiceoverSlotPrefix,
} from './tutorial-voice';
import { pathnameFromBlobUrl } from '../../common/blob-paths';
import { selectSweepableAssets } from './tutorial-video-retention';
import { tryAcquireJobLock, releaseJobLock } from '../../common/cron-job-lock';
import {
  narrationOf,
  ScenarioStep,
} from '../tutorial-scenario/scenario-steps.types';
import {
  SPA_LOCALE_STORAGE_KEY,
  SPA_THEME_STORAGE_KEY,
} from '../../common/spa-storage-keys';

/** Сколько сценариев проигрываем за один тик — сегодня их 10 (по числу
 * шагов обучалки, `tutorial-scenario-generator.service.ts`), но потолок
 * не завязан на это число жёстко: свободные ключи воркфлоу (§4.4 ТЗ)
 * когда-нибудь дадут больше строк. */
const RUN_BATCH_LIMIT = 30;

/** Общий бюджет времени на весь тик — функция Vercel живёт до 300с
 * (см. `SessionService.CLEANUP_BATCH`'а доккомментарий про тот же
 * потолок), оставляем запас на запуск браузера и завершение процесса.
 * Сценарии, не уложившиеся в бюджет, остаются на следующий прогон —
 * `lastRunAt` у них просто не обновится сегодня. */
const RUN_DEADLINE_MS = 4 * 60 * 1000;

/** Таймаут на один сценарий целиком (до 30 шагов, `MAX_SCENARIO_STEPS`) —
 * защита от одного зависшего сценария, съедающего весь бюджет тика. */
const SCENARIO_TIMEOUT_MS = 90_000;

/** Отдельный, заметно меньший бюджет на опрос НЕЗАВЕРШЁННЫХ сборок
 * видео в начале тика (этап 98) — это дешёвые HTTP-статусы, не запуск
 * браузера, но всё равно не должны есть бюджет, отведённый на сами
 * сценарии (`RUN_DEADLINE_MS`). */
const POLL_DEADLINE_MS = 60_000;

/** Дедлайн одной сборки слайд-шоу — тот же порядок величины, что
 * `POSTPROD_DEADLINE_MS` у переозвучки/кропа (минуты, не часы): если
 * внешний ffmpeg-api не ответил за это время, задача считается
 * провалившейся, а не «всё ещё идёт» навсегда. */
const ASSEMBLY_DEADLINE_MS = 10 * 60 * 1000;

/** Тема интерфейса на съёмке. Светлая — та же, что по умолчанию у
 * снимков мастера (`ui-snapshot-runner`), чтобы кадры обучалки и
 * кадры лендинга выглядели одним продуктом, а не двумя. */
const SCENARIO_THEME = 'light';

/** Сколько провалов назвать поимённо, прежде чем перейти на одно
 * итоговое сообщение. Три — чтобы единичная поломка приходила со
 * всеми подробностями, а массовая (упал стенд, сломался фикстурный
 * вход) не превращалась в тридцать одинаковых строк. */
const ALERT_DETAIL_LIMIT = 3;

/**
 * Сколько строк `TutorialVideoAsset` просматривает подметальщик за
 * один тик и сколько удаляет.
 *
 * Пар (шаг, локаль) сегодня до пятидесяти (десять шагов × пять
 * локалей), и держим мы на пару не больше трёх строк — то есть в
 * устоявшемся состоянии просмотр упирается в полторы сотни, а не в
 * потолок. Потолок нужен для ПЕРВОГО прогона на накопленной таблице:
 * ходит подметальщик каждые две минуты, и сносить всё разом одним
 * запросом (с удалением файлов по одному) незачем — 100 строк за тик
 * это 72 тысячи за сутки, накопить столько не успеет никто.
 */
/**
 * Какая доля снятых кадров должна иметь реплику, чтобы включился
 * вариант Б (покадровая озвучка, §3-бис).
 *
 * Половина. Ниже — ролик больше молчит, чем говорит, и запасной путь
 * (одна дорожка из текста шага обучалки) даёт зрителю больше. Порог
 * заведён аудитом этапа D: §11 п.12 приёмки описывает случай «модель
 * написала слишком длинные реплики», а делает она это пачкой — и одна
 * уцелевшая реплика из десяти включала бы вариант Б с девятью немыми
 * кадрами.
 */
const MIN_NARRATED_SHARE = 0.5;

const ASSET_SCAN_LIMIT = 500;
const ASSET_DELETE_LIMIT = 100;

/** Заголовок для subjectKey вне диапазона шагов обучалки (свободный
 * ключ воркфлоу, §4.4 ТЗ) — сам ключ, раз человекочитаемого заголовка
 * взять неоткуда. */
function resolveTutorialVideoTitle(subjectKey: string, locale: string): string {
  return tutorialStepFor(subjectKey, locale)?.title ?? subjectKey;
}

export interface TutorialScenarioRunOutcome {
  id: string;
  subjectKey: string;
  /** Язык прогона. Без него в журнале крона пять локалей выглядят
   *  пятью одинаковыми строками (правка аудита этапа C). */
  locale: string;
  ok: boolean;
  error?: string;
}

export interface TutorialScenarioRunResult {
  /** Сколько строк реально дошло до исполнения. Меньше `total`,
   *  когда бюджет прогона исчерпан. */
  executed?: number;
  /** Заполнено, если прогон пропущен целиком (фикстура не настроена/не
   * заведена, браузер недоступен) — total/passed/failed тогда 0. */
  skipped?: string;
  total: number;
  passed: number;
  failed: number;
  outcomes: TutorialScenarioRunOutcome[];
}

/**
 * Ключ джоб-замка опроса сборок. Тот же, что у крона
 * `tutorial-assembly-poll` — специально: замок общий на всех, кто
 * опрашивает, а не на один маршрут.
 */
const ASSEMBLY_POLL_LOCK = 'tutorial-assembly-poll';

/**
 * Префикс кадров-транзитов ОДНОГО актива. По id актива, а не по
 * `scenarioId`: последний общий для всех прогонов сценария, и прогоны
 * затирали кадры друг друга (аудит 27.09.2026).
 */
function scenarioFramePrefix(assetId: string): string {
  return `tutorial-video-frames/${assetId}/`;
}

export interface TutorialAssemblyPollResult {
  /** Заполнено, когда опрос пропущен: замок держит другой прогон. */
  skipped?: string;
  /** Сколько строк опрошено за этот тик. */
  polled: number;
  /** Сколько осталось висеть ПОСЛЕ опроса. */
  pending?: number;
  /** Сколько строк снято из зависшего `preparing` — см.
   *  `abandonStalePreparing`. Обычно 0; не ноль означает, что
   *  подготовка где-то обрывается, и это повод посмотреть логи. */
  abandoned?: number;
  /** Сколько устаревших роликов удалено — см. `sweepOldAssets`.
   *  В устоявшемся состоянии 0 или единицы за ночь: ровно столько,
   *  сколько новых сборок вытеснило прежние. */
  swept?: number;
}

/**
 * Что именно будет звучать в ролике — один из трёх исходов §3/§3-бис
 * ТЗ. Размеченное объединение, а не «url плюс карта, что-нибудь из
 * двух заполнено»: варианты А и Б взаимоисключающие, `planSlideshow`
 * отвергает план, где есть оба, и тип обязан говорить то же самое,
 * что планировщик.
 */
type NarrationPlan =
  | { mode: 'none' }
  | { mode: 'whole'; url: string; speechSeconds: number | null }
  | {
      mode: 'perFrame';
      /** Номер шага → дорожка. Шаги без реплики сюда не попадают:
       *  их кадр получает `MIN_FRAME_SECONDS` и тишину. */
      tracks: Map<number, { url: string; seconds: number | null }>;
    };

@Injectable()
export class TutorialScenarioRunnerService {
  private readonly logger = new Logger(TutorialScenarioRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: TelegramNotifyService,
    private readonly blob: BlobService,
    private readonly ffmpeg: FfmpegApiService,
    // Озвучка (этап B). `TtsModule` и `AiUsageModule` — global,
    // явного импорта в `TutorialRunnerModule` не требуют.
    private readonly settings: PlatformSettingsService,
    private readonly tts: TtsProviderResolverService,
    private readonly aiUsage: AiUsageService,
  ) {}

  /**
   * Готовая дорожка из кеша, если она там есть.
   *
   * Длительность читается ИЗ ИМЕНИ файла, а не измерением по байтам.
   * Прежняя редакция скачивала mp3 целиком ради одного числа, и
   * довод у неё был верный — «второе место хранения это второй
   * источник правды». Он перестал быть верным, когда в имя попал хеш
   * текста: имя адресует конкретные байты, и записанная рядом с
   * таким адресом длина разойтись с файлом не может (см.
   * `voiceoverCachePathname`).
   *
   * Цена прежнего решения выросла на этапе D: дорожек на сценарий
   * стало до тридцати вместо одной, то есть до тридцати скачиваний
   * внутри четырёхминутного бюджета прогона (находка аудита этапа
   * D). Теперь попадание в кеш стоит одного листинга слота.
   */
  private async cachedNarration(
    key: TutorialVoiceKey,
  ): Promise<{ url: string; speechSeconds: number | null } | null> {
    const prefix = voiceoverSlotPrefix(key.subjectKey, key.locale, key.slot);
    const page = await this.blob.listByPrefix(prefix, {});
    const hit = page.blobs.find((b) => matchesVoiceKey(b.pathname, key));
    if (!hit) return null;
    const ms = voiceoverDurationMsFromPathname(hit.pathname);
    const url = await this.blob.getPublicUrl(hit.pathname);
    return { url, speechSeconds: ms === null ? null : ms / 1000 };
  }

  /** Сносит всё под префиксом постранично — тот же цикл, что у
   * `wipeScenarioFrames`, только префикс приходит аргументом. */
  private async wipePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.blob.listByPrefix(prefix, { cursor });
      if (page.blobs.length > 0) {
        await this.blob.deleteMany(page.blobs.map((b) => b.pathname));
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }

  /**
   * План озвучки ролика — какой из трёх исходов ТЗ у нас сегодня.
   *
   * - `none` — немой ролик. Выключенная настройка, ненастроенный
   *   провайдер, отказ синтеза, неудачная заливка, текста нет,
   *   реплики не вычитаны при включённом требовании — всё это сюда.
   *   Первый принцип ТЗ соблюдается буквально: результат получается
   *   ВСЕГДА, озвучка это улучшение, а не условие.
   * - `whole` — вариант А (§3): одна дорожка на весь ролик, текст из
   *   карточки шага обучалки. Запасной путь, и он остаётся навсегда:
   *   у сценариев, сгенерированных до этапа D, реплик нет и не
   *   появится, пока их не перегенерируют.
   * - `perFrame` — вариант Б (§3-бис, этап D): своя реплика на кадр
   *   каждого шага. Включается САМ ФАКТОМ наличия реплик в шагах —
   *   отдельного выключателя нет и не нужно: реплики попали в
   *   сценарий решением человека (генерация плюс, при желании,
   *   правка), а второй тумблер к тому же решению ничего не
   *   добавляет.
   *
   * Смешения нет: `planSlideshow` отвергает план, где есть и общая
   * дорожка, и покадровая, — это два разных ответа на вопрос «что
   * звучит на кадре N».
   */
  private async buildNarration(
    scenario: {
      subjectKey: string;
      locale: string;
      steps: unknown;
      narrationReviewedAt?: Date | null;
    },
    /** Номера шагов СНЯТЫХ кадров. Реплики синтезируются только для
     *  них: у пропавшего кадра реплику показывать не на чем, а
     *  платить за неё пришлось бы. */
    stepIndexes: readonly number[],
    /** Фикстурный пользователь, под которым идёт прогон. Расход
     *  пишется на него — см. `fixture-seed.ts`. */
    userId: string,
  ): Promise<NarrationPlan> {
    try {
      const voice = parseTutorialVoiceSetting(
        await this.settings.get(TUTORIAL_VOICE_SETTING_KEY),
      );
      if (!voice.enabled) return { mode: 'none' };

      const requireReview = parseRequireNarrationReview(
        await this.settings.get(TUTORIAL_REQUIRE_NARRATION_REVIEW_KEY),
      );
      const perStep = this.narrationByStep(
        scenario,
        stepIndexes,
        requireReview,
      );
      if (perStep === 'blocked') return { mode: 'none' };

      // Провайдер выбирается ДО обращения к кешу: он входит в ключ.
      // Сети тут нет — `resolve()` читает настройку.
      const provider = await this.tts.resolve();

      // Вариант Б включается, только если реплик хватает на
      // БОЛЬШИНСТВО снятых кадров. Иначе — запасной путь.
      //
      // Порог нужен не для красоты. §11 п.12 приёмки описывает
      // реальный случай: модель «разошлась» и написала слишком
      // длинные реплики — а делает она это обычно сразу на всех
      // шагах, и валидатор отбрасывает их пачкой. Без порога одна
      // уцелевшая реплика из десяти включала бы вариант Б: девять
      // кадров молчат, один говорит фразу. Вариант А в той же
      // ситуации озвучил бы ролик целиком человеческим текстом
      // карточки шага. «Ролик получается всегда» (§3) — это про
      // ролик, а не про файл.
      const narratedShare =
        stepIndexes.length > 0 ? perStep.size / stepIndexes.length : 0;
      if (perStep.size > 0 && narratedShare < MIN_NARRATED_SHARE) {
        this.logger.warn(
          `сценарий ${scenario.subjectKey} (${scenario.locale}): реплик хватает только на ${perStep.size} из ${stepIndexes.length} кадров — берём запасной путь, текст шага обучалки`,
        );
      }
      if (perStep.size > 0 && narratedShare >= MIN_NARRATED_SHARE) {
        const tracks = new Map<
          number,
          { url: string; seconds: number | null }
        >();
        // `keep` строится по ВСЕМ репликам сценария, а не по снятым
        // сегодня кадрам. Кадр снимается best-effort и пропадает
        // молча; сложив `keep` из снятых, мы бы стирали из кеша
        // готовую дорожку пропавшего шага и платили за неё заново
        // ближайшей ночью — тихая трата ровно того рода, ради
        // которого кеш и заводился.
        const keep = this.allNarrationKeys(scenario, voice, provider);
        for (const [stepIndex, text] of perStep) {
          // Свой `try` на слот. Раньше исключение отсюда (икота Blob
          // на заливке или на чтении кеша) улетало в общий `catch`
          // ниже и делало немым ВЕСЬ ролик — при том, что дорожки
          // предыдущих шагов уже синтезированы и оплачены. До этапа
          // D заливка была одна на сценарий, теперь их до тридцати:
          // вероятность попасть выросла тридцатикратно, а цена — с
          // «одна фраза» до «весь сценарий молчит».
          try {
            const track = await this.voiceTrack(
              scenario,
              String(stepIndex),
              text,
              voice,
              provider,
              userId,
            );
            if (!track) continue;
            tracks.set(stepIndex, {
              url: track.url,
              seconds: track.speechSeconds,
            });
          } catch (e) {
            this.logger.warn(
              `сценарий ${scenario.subjectKey}: дорожка шага ${stepIndex} не получилась (${
                e instanceof Error ? e.message : String(e)
              }) — этот кадр будет немым`,
            );
          }
        }
        if (tracks.size === 0) {
          // Все реплики отвалились — это немой ролик, а НЕ повод
          // подставить вариант А: отказы синтеза обычно преходящи
          // (лимит провайдера), следующая ночь их подберёт, а
          // подмена дала бы ролик, который сегодня говорит одно,
          // завтра другое. Отличается от порога выше: там реплик
          // НЕТ по существу, здесь они есть и просто не доехали.
          return { mode: 'none' };
        }
        if (tracks.size < perStep.size) {
          this.logger.warn(
            `сценарий ${scenario.subjectKey} (${scenario.locale}): синтезировано ${tracks.size} дорожек из ${perStep.size} — остальные кадры немые, следующий прогон попробует снова`,
          );
        }
        await this.reconcileVoiceCache(scenario, keep);
        return { mode: 'perFrame', tracks };
      }

      // Вариант А. Текста может не быть, и причин две — называть надо
      // ту, которая случилась: ключ вне десяти шагов обучалки
      // (свободный ключ воркфлоу) или локаль, которой нет в словаре.
      // Обобщённое «для локали нет» отправляло бы искать перевод
      // там, где дело в ключе (находка аудита этапа B).
      const text = narrationTextForSubject(
        scenario.subjectKey,
        scenario.locale,
      );
      if (!text) {
        const known = hasTutorialSteps(scenario.locale);
        this.logger.warn(
          known
            ? `сценарий ${scenario.subjectKey}: ключ не из десяти шагов обучалки, текста озвучки нет — ролик соберётся немым`
            : `сценарий ${scenario.subjectKey}: локали ${scenario.locale} нет в словаре шагов, текста озвучки нет — ролик соберётся немым`,
        );
        return { mode: 'none' };
      }
      const track = await this.voiceTrack(
        scenario,
        VOICE_SLOT_WHOLE,
        text,
        voice,
        provider,
        userId,
      );
      if (!track) return { mode: 'none' };
      await this.reconcileVoiceCache(scenario, [track.key]);
      return {
        mode: 'whole',
        url: track.url,
        speechSeconds: track.speechSeconds,
      };
    } catch (err) {
      this.logger.warn(
        `сценарий ${scenario.subjectKey}: озвучка не получилась (${
          err instanceof Error ? err.message : String(err)
        }) — ролик соберётся немым`,
      );
      return { mode: 'none' };
    }
  }

  /**
   * Реплики сценария по номерам СНЯТЫХ шагов, либо `'blocked'` —
   * реплики есть, но вычитки требуют и её нет.
   *
   * Пустая карта означает «реплик в сценарии нет» и уводит на
   * вариант А. Это разные исходы, и `'blocked'` отдельным значением
   * именно поэтому: при включённом требовании вычитки сценарий с
   * невычитанными репликами обязан собраться НЕМЫМ, а не подменить
   * реплики текстом шага обучалки. Подмена выглядела бы как «всё
   * работает» и обесценила бы выключатель ровно тогда, когда его
   * включили.
   */
  private narrationByStep(
    scenario: {
      subjectKey: string;
      locale: string;
      steps: unknown;
      narrationReviewedAt?: Date | null;
    },
    stepIndexes: readonly number[],
    requireReview: boolean,
  ): Map<number, string> | 'blocked' {
    const steps = (scenario.steps ?? []) as ScenarioStep[];
    const byStep = new Map<number, string>();
    if (!Array.isArray(steps)) return byStep;
    for (const stepIndex of stepIndexes) {
      const step = steps[stepIndex];
      if (!step) continue;
      const text = narrationOf(step);
      if (text) byStep.set(stepIndex, text);
    }
    if (byStep.size === 0) return byStep;
    if (requireReview && !scenario.narrationReviewedAt) {
      this.logger.warn(
        `сценарий ${scenario.subjectKey} (${scenario.locale}): реплики не вычитаны, а ${TUTORIAL_REQUIRE_NARRATION_REVIEW_KEY} включена — ролик соберётся немым`,
      );
      return 'blocked';
    }
    return byStep;
  }

  /**
   * Пути кеша ВСЕХ реплик сценария — независимо от того, снялся ли
   * сегодня кадр соответствующего шага.
   *
   * Нужен `reconcileVoiceCache`, чтобы он не сносил дорожку шага,
   * кадр которого сегодня не снялся: скриншот делается best-effort и
   * пропадает молча, а платить за ту же фразу повторно не за что.
   */
  private allNarrationKeys(
    scenario: { subjectKey: string; locale: string; steps: unknown },
    voice: { voiceId: string | null },
    provider: { providerKey: string },
  ): TutorialVoiceKey[] {
    const steps = scenario.steps;
    if (!Array.isArray(steps)) return [];
    const out: TutorialVoiceKey[] = [];
    (steps as ScenarioStep[]).forEach((step, stepIndex) => {
      const text = narrationOf(step);
      if (!text) return;
      out.push({
        subjectKey: scenario.subjectKey,
        locale: scenario.locale,
        slot: String(stepIndex),
        provider: provider.providerKey,
        voiceId: voice.voiceId,
        text,
      });
    });
    return out;
  }

  /**
   * Одна дорожка: из кеша, а если там пусто — синтезом.
   *
   * Кеш живёт ВНЕ префикса актива намеренно: дорожка обязана пережить
   * сборку, иначе следующей ночью за ту же фразу заплатят заново —
   * ночной прогон идёт по всем сценариям каждую ночь. Яма при этом не
   * заводится (§4.3 ТЗ — про транзитные файлы сборки, а не про кеш):
   * под слотом всегда ровно один файл, а всё лишнее из префикса
   * сценария выметает `reconcileVoiceCache`.
   *
   * `null` — дорожки не будет: отказ синтеза или заливки. Немой кадр
   * (или немой ролик) — штатный исход, а не ошибка.
   */
  private async voiceTrack(
    scenario: { subjectKey: string; locale: string },
    slot: string,
    text: string,
    voice: { voiceId: string | null },
    provider: Awaited<ReturnType<TtsProviderResolverService['resolve']>>,
    userId: string,
  ): Promise<{
    url: string;
    speechSeconds: number | null;
    /** Ключ кеша этой дорожки. Отдаётся наружу вместо пути:
     *  сверка кеша сличает по ключу, потому что путь несёт ещё и
     *  длину, известную только записавшему. */
    key: TutorialVoiceKey;
  } | null> {
    // В ключ входит ВСЁ, от чего дорожка зависит: слот, шаг, локаль,
    // провайдер, голос и текст. Провайдер и голос попали туда
    // правкой сквозного аудита: без них смена голоса в админке не
    // меняла НИЧЕГО в уже собранных шагах, а переключение провайдера
    // на `veo` (второй уровень отката §9, обещающий немые ролики)
    // оставляло их озвученными старой дорожкой.
    const voiceKey: TutorialVoiceKey = {
      subjectKey: scenario.subjectKey,
      locale: scenario.locale,
      slot,
      provider: provider.providerKey,
      voiceId: voice.voiceId,
      text,
    };

    const cached = await this.cachedNarration(voiceKey);
    if (cached) return { ...cached, key: voiceKey };

    const outcome = await provider.synthesize({
      text,
      language: scenario.locale,
      voiceId: voice.voiceId,
    });
    if (!outcome.ok) {
      this.logger.warn(
        `сценарий ${scenario.subjectKey}: синтез озвучки (слот ${slot}) не состоялся (${outcome.reason}) — этот кадр будет немым`,
      );
      return null;
    }

    // Расход пишется СРАЗУ и до заливки: деньги провайдеру уже
    // отданы, и запись о них не должна зависеть от того, доедет ли
    // файл до Blob. Операция — общая `voiceover`: своя строка
    // (`tutorial-voiceover`) заводится этапом F вместе с ключом в
    // `AI_OPERATION_LABEL`, а до тех пор молчаливая трата была бы
    // хуже неточной подписи.
    await this.aiUsage.record({
      operation: 'voiceover',
      model: `${provider.providerKey}-tts`,
      characters: outcome.characters,
      // На фикстурного пользователя, а не «в никуда»: строка без
      // владельца считается АНОНИМНОЙ и выбирает общий суточный
      // потолок анонимных посетителей (≈$5). Один ночной прогон
      // озвучки его и выбирал — то есть закрывал мастер настоящим
      // гостям до полуночи (находка сквозного аудита A+B+C).
      userId,
    });

    // `voiceoverCachePathname(voiceKey)` подставляется в вызов
    // ЦЕЛИКОМ, а не через локальную `pathname` выше, — намеренно. Шов
    // «все заливки обучалки идут под убираемый префикс»
    // (`scripts/check-docs.mjs`) читает текст аргумента, и переменная
    // его ослепляет; обход этого шва переменной уже был однажды
    // заведён и найден аудитом. Лишний вызов чистой функции дешевле
    // ослепшего шва.
    // Длина берётся у провайдера, а не измеряется по байтам:
    // контракт TTS её отдаёт, а `null` там значит «измерить не
    // удалось» — и в имя уедет `x`, честно.
    // Имя `trackMs`, а не `durationMs`: последнее в этом проекте
    // занято длительностью ВИДЕО, её сторожит отдельный шов
    // («пишется только как `plan.durationMs`»), и одноимённая
    // переменная про длину mp3 его ослепляла бы. Это разные числа.
    const trackMs =
      outcome.durationSeconds === null ||
      !Number.isFinite(outcome.durationSeconds)
        ? null
        : outcome.durationSeconds * 1000;
    const { url } = await this.blob.uploadBuffer(
      voiceoverCachePathname(voiceKey, trackMs),
      outcome.audio,
      outcome.mimeType,
    );
    return { url, speechSeconds: outcome.durationSeconds, key: voiceKey };
  }

  /**
   * Оставить в кеше сценария ровно те файлы, которые сегодня нужны, и
   * снести всё остальное.
   *
   * Одним проходом вместо «снести префикс перед укладкой», как было
   * до этапа D. Тогда слот был один и разницы не было; теперь их до
   * тридцати, и снос префикса при промахе по одной реплике
   * пересинтезировал бы весь сценарий — оператор, поправивший одно
   * слово, платил бы за все тридцать.
   *
   * Сверка закрывает сразу три способа накопить сирот, и ни один из
   * них не гипотетический: старая плоская раскладка кеша (файл лежал
   * прямо под префиксом сценария, без слота); шаг, у которого реплику
   * убрали (его слот иначе остался бы навсегда); переход варианта Б
   * обратно на А (все покадровые слоты становятся лишними разом).
   *
   * Зовётся ТОЛЬКО когда дорожка действительно построена. Немой исход
   * кеш не трогает: выключили озвучку на ночь — вернув её, платить за
   * весь набор заново не придётся.
   */
  private async reconcileVoiceCache(
    scenario: { subjectKey: string; locale: string },
    keep: readonly TutorialVoiceKey[],
  ): Promise<void> {
    const prefix = voiceoverCachePrefix(scenario.subjectKey, scenario.locale);
    let cursor: string | undefined;
    do {
      const page = await this.blob.listByPrefix(prefix, { cursor });
      // Сверка по КЛЮЧУ, а не по готовому пути. Путь несёт ещё и
      // длину дорожки (`…-9000.mp3`), а она известна только тому, кто
      // файл записывал: собрать ожидаемый путь из ключа нельзя.
      // Первая редакция собирала — и сносила из кеша ровно то, что
      // берегла, потому что в её путях стояло `-x`.
      const stale = page.blobs
        .map((b) => b.pathname)
        .filter((pathname) => !keep.some((k) => matchesVoiceKey(pathname, k)));
      if (stale.length > 0) await this.blob.deleteMany(stale);
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }

  async run(): Promise<TutorialScenarioRunResult> {
    // Опрос сборок прошлых тиков — до фикстурного входа и запуска
    // браузера намеренно: сборка видео не завязана ни на фикстуру, ни
    // на сегодняшний регресс-прогон, и должна продвигаться независимо
    // от того, настроен ли ещё сам фикстурный вход. См. доккомментарий
    // модуля.
    // Через `pollAssemblies`, а не напрямую: замок опроса живёт там, и
    // в обход него суточный прогон снова разошёлся бы с двухминутным
    // поллером на одной строке.
    //
    // Под `catch`, и это правка повторного сквозного аудита A+B+C.
    // Абзац выше обещает независимость («сборка не завязана ни на
    // фикстуру, ни на сегодняшний регресс-прогон»), но зависимость
    // была обратная и не обещанная: любое исключение из опроса —
    // икота базы на выборке, вторая подряд ошибка Blob в
    // `failAssembly`, отказ нового подметальщика — вылетало наружу
    // ДО первого сценария, и ночной прогон не исполнял НИ ОДНОГО.
    // Опрос сборок тем временем повторяется каждые две минуты сам.
    try {
      await this.pollAssemblies();
    } catch (err) {
      this.logger.warn(
        `опрос сборок не удался, прогон сценариев продолжается: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const telegramId = process.env.FIXTURE_TELEGRAM_ID?.trim();
    const token = process.env.FIXTURE_USER_TOKEN?.trim();
    const tmaBaseUrl = process.env.TMA_PUBLIC_URL?.trim();
    if (!telegramId || !token) {
      this.logger.warn(
        'FIXTURE_USER_TOKEN/FIXTURE_TELEGRAM_ID не настроены — пропуск (см. .env.example)',
      );
      return this.skip('фикстурный вход не настроен');
    }
    if (!tmaBaseUrl) {
      this.logger.warn('TMA_PUBLIC_URL не настроен — пропуск');
      return this.skip('TMA_PUBLIC_URL не настроен');
    }

    const user = await this.prisma.user.findUnique({
      where: { telegramId },
    });
    if (!user) {
      this.logger.warn(
        `фикстурный пользователь telegramId=${telegramId} не найден — запустите npm run seed:fixture-user`,
      );
      return this.skip('фикстурный пользователь не заведён');
    }

    // Только не-платные ИЛИ платные, но явно одобренные оператором
    // (§4.11 ТЗ) — тот же барьер, что уже действует для показа карточки
    // одобрения в админке, применён здесь как фильтр "что вообще можно
    // трогать автоматически", а не только "что можно показать".
    // Локали — тот же список, по которому генерируются сценарии
    // (`tutorial.scenarioLocales`). Без этого фильтра пятый уровень
    // отката §9 не работал: сузили список до `['ru']`, а ночной
    // прогон продолжал исполнять испанские строки, снимать по ролику
    // на каждую и слать те же алерты — то есть откат, объявленный
    // «без деплоя», не останавливал ни съёмку, ни расход (находка
    // аудита этапа C). Приёмка §11 п.10 — ровно про это: «новые
    // ролики только русские, уже снятые остались».
    const locales = parseTutorialLocales(
      await this.settings.get(TUTORIAL_LOCALES_SETTING_KEY),
    );
    const scenarios = await this.prisma.tutorialScenario.findMany({
      where: {
        locale: { in: locales },
        OR: [{ costly: false }, { approved: true }],
      },
      // Сперва те, что дольше всех не исполнялись (`nulls: 'first'` —
      // ни разу не исполнявшиеся впереди всех). По `createdAt asc`
      // порядок был СТАБИЛЕН навсегда, и при пяти локалях пятьдесят
      // строк против `RUN_BATCH_LIMIT = 30` означали: двадцать
      // сценариев не исполнятся НИКОГДА, а лог при этом честно писал
      // «отложено до следующего прогона» (находка аудита этапа C).
      // Ротация по давности даёт каждой строке дойти до очереди.
      orderBy: [
        { lastRunAt: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'asc' },
      ],
      take: RUN_BATCH_LIMIT,
    });
    if (scenarios.length === 0) {
      return { total: 0, passed: 0, failed: 0, outcomes: [] };
    }

    const ctx = await this.resolveFixtureContext(user.id);

    const launched = await launchHeadlessBrowser();
    if ('error' in launched) {
      this.logger.warn(`headless-браузер недоступен: ${launched.error}`);
      await this.recordInfraFailure(scenarios, launched.error);
      await this.notify.alert(
        'tutorial-scenario-run:browser',
        `Исполнитель сценариев обучающих видео: браузер не запустился. ${launched.error}`,
      );
      return {
        total: scenarios.length,
        passed: 0,
        failed: scenarios.length,
        // `locale` обязателен в `TutorialScenarioRunOutcome` — и
        // именно здесь его забыли. В песочнице это не видно (типы
        // Prisma подменены заглушкой, и `scenarios` выводится как
        // `any[]`), а боевая сборка с настоящим `prisma generate`
        // упала бы на TS2322. Заодно это ровно та потеря языка в
        // журнале, ради которой поле и заводили на этапе C —
        // в ветке, где не исполнился НИ ОДИН сценарий (находка
        // сквозного аудита A+B+C).
        outcomes: scenarios.map((s) => ({
          id: s.id,
          subjectKey: s.subjectKey,
          locale: s.locale,
          ok: false,
          error: launched.error,
        })),
      };
    }

    const { browser } = launched;
    const outcomes: TutorialScenarioRunOutcome[] = [];
    const failures: string[] = [];
    const deadline = Date.now() + RUN_DEADLINE_MS;
    try {
      for (const scenario of scenarios) {
        if (Date.now() >= deadline) {
          this.logger.warn(
            `тик исчерпал бюджет времени — ${scenarios.length - outcomes.length} сценариев отложено до следующего прогона`,
          );
          break;
        }
        const outcome = await this.runOne(
          browser,
          scenario,
          ctx,
          // Владелец расхода этого прогона — фикстурный пользователь
          // (см. `synthesizeNarration`). Тянется параметром, а не
          // через `ctx`: `FixtureRouteContext` описывает МАРШРУТЫ,
          // и подмешивать в него владельца денег значит завести
          // второе назначение у одной структуры.
          user.id,
          token,
          tmaBaseUrl,
        );
        outcomes.push(outcome);
        if (!outcome.ok) {
          failures.push(`${scenario.subjectKey}/${scenario.locale}`);
          // Локаль в fingerprint И в тексте. Без неё пять локалей
          // схлопывались в одно сообщение: `TelegramNotifyService`
          // давит повторы по fingerprint в окне 10 минут, а весь
          // прогон укладывается в 4 — то есть четыре из пяти
          // сообщений просто не отправлялись, и какой язык сломался,
          // узнать было неоткуда (находка аудита этапа C).
          //
          // Но поимённо — только первые `ALERT_DETAIL_LIMIT`.
          // Обратная крайность тоже плоха: при пяти локалях и общей
          // причине (сломался фикстурный вход, упал стенд) оператор
          // получал до тридцати одинаковых красных сообщений за
          // ночь, каждую ночь (находка сквозного аудита A+B+C).
          // Дальше — одно итоговое, в конце прогона.
          if (failures.length <= ALERT_DETAIL_LIMIT) {
            await this.notify.alert(
              `tutorial-scenario-run:${scenario.subjectKey}:${scenario.locale}`,
              `Сценарий обучающего видео «${scenario.subjectKey}» (${scenario.locale}) провалился на regression-прогоне: ${outcome.error}`,
            );
          }
        }
      }
    } finally {
      await browser.close().catch(() => undefined);
    }

    // Итоговое сообщение вместо хвоста поимённых: причина у них
    // обычно одна, а тридцать красных строк подряд читаются как
    // тридцать разных поломок.
    if (failures.length > ALERT_DETAIL_LIMIT) {
      await this.notify.alert(
        'tutorial-scenario-run:many',
        `Сценарии обучающего видео: провалились ${failures.length} из ${outcomes.length} — ${failures.join(', ')}. Поимённые сообщения выше только для первых ${ALERT_DETAIL_LIMIT}.`,
      );
    }

    return {
      total: scenarios.length,
      // Сколько РЕАЛЬНО дошло до исполнения. `total` — размер
      // выбранной партии, и при исчерпанном бюджете он больше:
      // оператор видел «total 30, passed 2, failed 6» и двадцать две
      // строки, про которые в журнале не было ничего (находка
      // сквозного аудита A+B+C).
      executed: outcomes.length,
      passed: outcomes.filter((o) => o.ok).length,
      failed: outcomes.filter((o) => !o.ok).length,
      outcomes,
    };
  }

  private async runOne(
    browser: import('puppeteer-core').Browser,
    scenario: {
      id: string;
      subjectKey: string;
      locale: string;
      steps: unknown;
      /** Отметка о вычитке реплик. Нужна не самому прогону, а
       *  озвучке: при включённой `tutorial.requireNarrationReview`
       *  сценарий без неё собирается немым (§3-бис.5 ТЗ). */
      narrationReviewedAt?: Date | null;
    },
    ctx: FixtureRouteContext,
    /** Фикстурный пользователь — владелец расхода прогона. */
    userId: string,
    token: string,
    tmaBaseUrl: string,
  ): Promise<TutorialScenarioRunOutcome> {
    const steps = scenario.steps as unknown as ScenarioStep[];
    let page: import('puppeteer-core').Page | undefined;
    try {
      page = await browser.newPage();
      // Тот же трюк, что задумывался для og:image (Accept-Language) —
      // заголовок уходит СО ВСЕМИ запросами страницы, включая XHR/fetch
      // самого SPA к API бэкенда (CDP `Network.setExtraHTTPHeaders`, не
      // только на сам document-запрос), поэтому фронтенд не нуждается
      // ни в какой правке ради фикстурного входа — TelegramIdentity-
      // Middleware видит заголовок на каждом запросе так же, как видел
      // бы X-Telegram-Init-Data внутри настоящего Telegram.
      await page.setExtraHTTPHeaders({ 'X-Fixture-Token': token });

      // Локаль интерфейса — ДО загрузки SPA, теми же ключами, что
      // пишет сам продукт (`v4c_locale` в frontend/src/lib/i18n.ts,
      // `v4c_theme` в lib/theme.ts). Тот же приём, что у
      // `ui-snapshot-runner`.
      //
      // Без этого локаль-параметр этапа C выглядела бы работающей и
      // не работала: сценарий сгенерировался бы по-испански, прогон
      // прошёл бы по селекторам (они одинаковы во всех языках) и
      // упал бы на первом `assertText` — с виду непонятно почему.
      // Сравнение там `includes` по подстроке, то есть «испанский
      // текст в русском интерфейсе» не находится и выглядит как
      // сломанный интерфейс, а не как несовпадение языков.
      //
      // Тема — константа: у `TutorialScenario` поля темы нет, и
      // заводить его незачем. Ролики снимаются в светлой теме, как
      // и раньше по умолчанию; важно здесь только то, что тема
      // задана ЯВНО и не зависит от системной у машины, где
      // случился прогон.
      await page.evaluateOnNewDocument(
        (
          locale: string,
          theme: string,
          localeKey: string,
          themeKey: string,
        ) => {
          try {
            window.localStorage.setItem(localeKey, locale);
            window.localStorage.setItem(themeKey, theme);
          } catch {
            // хранилище недоступно — SPA откроется в умолчаниях, и
            // сценарий чужой локали честно упадёт на `assertText`.
            // Ронять из-за этого весь прогон нечего.
          }
        },
        scenario.locale,
        SCENARIO_THEME,
        SPA_LOCALE_STORAGE_KEY,
        SPA_THEME_STORAGE_KEY,
      );

      const base = tmaBaseUrl.replace(/\/+$/, '');
      const resolveRoute = (routeName: string) => {
        const resolved = resolveScenarioRoute(routeName, ctx);
        return resolved.ok
          ? { ok: true as const, url: `${base}/#${resolved.path}` }
          : { ok: false as const, reason: resolved.reason };
      };

      const result = await withTimeout(
        runScenario(
          page as unknown as ScenarioPage,
          steps,
          resolveRoute,
          undefined,
          true, // captureFrames — этап 98
        ),
        SCENARIO_TIMEOUT_MS,
        `сценарий не уложился в ${Math.round(SCENARIO_TIMEOUT_MS / 1000)}с`,
      );

      const failedStep = result.steps.find((s) => !s.ok);
      const error = failedStep
        ? `шаг ${failedStep.index + 1} (${failedStep.step.kind}): ${failedStep.error}`
        : undefined;

      await this.prisma.tutorialScenario.update({
        where: { id: scenario.id },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: result.ok ? 'ok' : 'failed',
          lastRunError: error ?? null,
        },
      });

      // Видео — необязательный побочный продукт успешного прогона
      // (см. доккомментарий модуля): best-effort, никогда не бросает и
      // не меняет уже записанный regression-результат выше.
      if (result.ok) {
        await this.submitVideoAssembly(scenario, result.frames, userId);
      }

      return {
        id: scenario.id,
        subjectKey: scenario.subjectKey,
        locale: scenario.locale,
        ok: result.ok,
        error,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.prisma.tutorialScenario
        .update({
          where: { id: scenario.id },
          data: {
            lastRunAt: new Date(),
            lastRunStatus: 'failed',
            lastRunError: error,
          },
        })
        .catch(() => undefined);
      return {
        id: scenario.id,
        subjectKey: scenario.subjectKey,
        locale: scenario.locale,
        ok: false,
        error,
      };
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  /** Браузер вообще не поднялся — ни один сценарий не мог быть
   * проигран, но каждый всё равно получает свежую метку неудачи: иначе
   * оператор в админке видел бы устаревший `lastRunAt` от предыдущего
   * успешного дня и не понял бы, что сегодняшний прогон вообще
   * случился. Одна тревога на весь тик (см. вызывающий код), не по
   * сценарию — причина одна и та же для всех. */
  private async recordInfraFailure(
    scenarios: Array<{ id: string }>,
    error: string,
  ): Promise<void> {
    await this.prisma.tutorialScenario.updateMany({
      where: { id: { in: scenarios.map((s) => s.id) } },
      data: {
        lastRunAt: new Date(),
        lastRunStatus: 'failed',
        lastRunError: error,
      },
    });
  }

  /**
   * ID фикстурных данных (§3.3 ТЗ) — по владельцу (userId), не по
   * фиксированным ID из `seed-fixture-user.ts`: так резолвер работает и
   * для фикстуры, заведённой/донастроенной вручную, а не только для
   * строк ровно с теми ID, что генерирует скрипт по умолчанию. "Самая
   * свежая" запись каждого вида — на случай, если оператор когда-то
   * пересоздаст фикстурные данные заново, а старые оставит в базе.
   */
  private async resolveFixtureContext(
    userId: string,
  ): Promise<FixtureRouteContext> {
    /**
     * Тип проекта в `where` — обязателен с этапа G ТЗ
     * `docs-tz/TZ-Enterprise-Tutorial-Landing.md`, и это не
     * перестраховка.
     *
     * Раньше здесь брался просто «самый свежий проект пользователя». У
     * фикстуры проект был один, и всё сходилось. Как только фикстура
     * завела ВТОРОЙ проект — `CLIENT_SITE` для мастера обучалки — он
     * стал самым свежим, и `projectId` начал указывать на него. А по
     * этому `projectId` строятся пути рекламного пайплайна
     * (`/projects/<id>`, `/projects/<id>/items/<itemId>`): товар лежит
     * в ДРУГОМ проекте, у `CLIENT_SITE` товаров нет по построению. Обход
     * снимал бы «проект не найден» и считал бы это нормальным экраном.
     *
     * Поэтому рекламный проект отбирается по типу, обучалка — по
     * своему, и товар ищется внутри рекламных проектов, а не «любого
     * проекта пользователя».
     */
    const AD_TYPES = [ProjectType.SINGLE, ProjectType.LINE];
    const [project, clientSiteProject, item, manifest, session] =
      await Promise.all([
        this.prisma.project.findFirst({
          where: { userId, deletedAt: null, type: { in: AD_TYPES } },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.project.findFirst({
          where: {
            userId,
            deletedAt: null,
            type: ProjectType.CLIENT_SITE,
          },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.productItem.findFirst({
          where: {
            project: { userId, type: { in: AD_TYPES } },
            deletedAt: null,
          },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.brandManifest.findFirst({
          where: { userId },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.session.findFirst({
          where: { userId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
    return {
      projectId: project?.id,
      itemId: item?.id,
      manifestId: manifest?.id,
      sessionId: session?.id,
      clientSiteProjectId: clientSiteProject?.id,
      // `greetingProjectId` сознательно не ищется: фикстура проект
      // четвёртого типа не заводит, и маршрут `greeting-video` честно
      // отказывает «нет фикстурных данных» — см. route-templates.ts.
    };
  }

  private skip(reason: string): TutorialScenarioRunResult {
    return { skipped: reason, total: 0, passed: 0, failed: 0, outcomes: [] };
  }

  /**
   * Грузит кадры успешного прогона как транзитные файлы в Blob и
   * отправляет задачу сборки слайд-шоу внешнему ffmpeg-api (§4.2 ТЗ,
   * `tutorial-video-assembly.ts`). Best-effort: любая неудача здесь
   * логируется и НЕ бросает наружу — сам regression-результат уже
   * записан вызывающим кодом до этого метода, необязательное улучшение
   * не должно его портить.
   */
  private async submitVideoAssembly(
    scenario: {
      id: string;
      subjectKey: string;
      locale: string;
      /** Шаги нужны озвучке: реплика берётся у шага по его номеру
       *  (§3-бис.2, этап D). */
      steps: unknown;
      narrationReviewedAt?: Date | null;
    },
    frames: readonly ScenarioFrame[],
    /** Фикстурный пользователь — владелец расхода (см.
     *  `synthesizeNarration`). */
    userId: string,
  ): Promise<void> {
    if (frames.length === 0) return;
    if (!this.ffmpeg.configured()) {
      this.logger.warn(
        `сценарий ${scenario.subjectKey}: FFMPEG_API_KEY не настроен — слайд-шоу не собирается (regression-результат уже учтён)`,
      );
      return;
    }

    // Строка заводится ПЕРВОЙ, ещё до заливки кадров, и это правка
    // аудита 27.09.2026. Прежний порядок был «кадры → задача →
    // строка», и у него две дыры сразу:
    //
    // 1. Бросит `submit` или `create` — строки нет, кадры в Blob есть,
    //    опрашивать нечего, `cleanupFrames` не вызовется никогда.
    //    Подметальщика по префиксу `tutorial-video-frames/` в проекте
    //    нет, значит файлы оставались навсегда.
    // 2. Путь кадров строился по `scenarioId`, общему для ВСЕХ
    //    прогонов одного сценария. Повторный прогон перезаписывал
    //    файлы предыдущего, а уборка старого актива сносила кадры
    //    нового; более короткий прогон оставлял «хвост» прошлого.
    //
    // Обе лечатся одним: у строки есть `id` до заливки, по нему и
    // строится префикс. Статус `preparing` — не `pending`: опрос
    // выбирает только `pending`, и полусобранную строку он не тронет.
    // Озвучка и длительности считаются ДО строки и до заливки
    // кадров: из них складывается отпечаток входов, а он решает,
    // нужна ли сборка вообще. Порядок «кадры → озвучка» был важен по
    // другому поводу — длительность кадра зависит от длины речи, а не
    // наоборот, — и он сохранён: `evenFrameSeconds` по-прежнему
    // считается после синтеза. Число кадров для этого известно и без
    // заливки. Синтез при попадании в кеш — один `head` в Blob, то
    // есть дешевле, чем заливка кадров, которую он теперь опережает.
    // `buildNarration` свой `catch` уже имеет и на любой сбой
    // возвращает `{mode:'none'}` (немой ролик — штатный исход).
    const narration = await this.buildNarration(
      scenario,
      frames.map((f) => f.stepIndex),
      userId,
    );
    // Длительность кадра назначается по-разному в двух вариантах, и
    // это не деталь реализации, а разница между ними (§3/§3-бис).
    // Вариант А: речь одна на весь ролик, делим поровну. Вариант Б:
    // каждый кадр висит ровно столько, сколько звучит ЕГО реплика, а
    // кадр без реплики — минимум. Вариант А на покадровых репликах
    // дал бы кадр, который меняется посреди фразы.
    const planFrames = frames.map((frame) => {
      const track =
        narration.mode === 'perFrame'
          ? (narration.tracks.get(frame.stepIndex) ?? null)
          : null;
      return {
        stepIndex: frame.stepIndex,
        bytes: frame.bytes,
        seconds:
          narration.mode === 'perFrame'
            ? narrationFrameSeconds(track?.seconds ?? null)
            : evenFrameSeconds(
                narration.mode === 'whole' ? narration.speechSeconds : null,
                frames.length,
              ),
        audioUrl: track?.url ?? null,
      };
    });

    // §7.2 ТЗ: «ролики пересобираются, когда меняется интерфейс или
    // текст шага, а не по расписанию». До этой проверки обещание не
    // выполнялось: ночной прогон отправлял платную задачу на КАЖДЫЙ
    // успешный сценарий каждую ночь, получая побайтово тот же mp4, а
    // подметальщик той же ночью выносил вчерашний. Теперь вход
    // сравнивается с отпечатком последнего СОБРАННОГО ролика пары.
    const contentHash = slideshowContentHash(
      planFrames,
      narration.mode === 'whole' ? narration.url : null,
    );
    // Сбой этой выборки — не повод не собирать ролик: худшее, что
    // случится без неё, — лишняя пересборка, то есть поведение ровно
    // как до этой проверки.
    const previous = (await this.prisma.tutorialVideoAsset
      .findFirst({
        where: {
          subjectKey: scenario.subjectKey,
          locale: scenario.locale,
          assemblyStatus: 'complete',
          blobUrl: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, contentHash: true },
      })
      .catch(() => null)) as { id: string; contentHash: string | null } | null;
    if (previous?.contentHash && previous.contentHash === contentHash) {
      // Ни строки, ни файлов: новая строка с тем же роликом — это
      // лишний mp4 в Blob и лишняя работа подметальщику, а не
      // история. Regression-результат прогона уже записан выше по
      // стеку, он от сборки не зависит.
      this.logger.log(
        `сценарий ${scenario.subjectKey} (${scenario.locale}): кадры и озвучка не изменились с ролика ${previous.id} — сборка не нужна`,
      );
      return;
    }

    // Строка заводится в своём `try`: до неё убирать нечего, и
    // `abandonAssembly` ниже звать не с чем. Без него любая икота
    // базы на `create` летела бы наружу — в `runOne`, который уже
    // записал regression-результат, — и рушила бы исход прогона
    // из-за необязательного улучшения. Доккомментарий метода обещает
    // ровно обратное («любая неудача здесь логируется и НЕ бросает
    // наружу»), а `create` из-под защиты выпадал с самого начала
    // (найдено повторным сквозным аудитом A+B+C, вместе с тем, что
    // предпроверка отпечатка встала рядом).
    let asset: { id: string };
    try {
      asset = (await this.prisma.tutorialVideoAsset.create({
        data: {
          subjectKey: scenario.subjectKey,
          locale: scenario.locale,
          title: resolveTutorialVideoTitle(
            scenario.subjectKey,
            scenario.locale,
          ),
          scenarioId: scenario.id,
          frameCount: frames.length,
          assemblyStatus: 'preparing',
          contentHash,
        },
      })) as { id: string };
    } catch (err) {
      this.logger.warn(
        `сценарий ${scenario.subjectKey}: не удалось завести строку ролика: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    try {
      // Имя файла — по номеру ШАГА, а не по позиции в массиве (этап A
      // ТЗ `TZ-Tutorial-Video-Voiced.md`): пропавший кадр оставляет
      // дыру в нумерации, а не сдвигает все следующие. Уборка идёт по
      // префиксу целиком (`wipeScenarioFrames`), сплошная нумерация ей
      // не нужна.
      // Номер шага едет С КАДРОМ до самого плана, а не выводится из
      // позиции в массиве: `uniformFrames` здесь вызывать НЕЛЬЗЯ.
      // Кадр снимается best-effort и пропадает молча, поэтому
      // позиция врёт, а номер шага — нет (см. `ScenarioFrame` и
      // `SlideshowFrame.stepIndex`).
      //
      const slides: SlideshowFrame[] = [];
      for (const frame of planFrames) {
        const { url } = await this.blob.uploadBuffer(
          `${scenarioFramePrefix(asset.id)}${frame.stepIndex}.png`,
          Buffer.from(frame.bytes),
          'image/png',
        );
        // `framesFromSteps` здесь больше не годится: он раздаёт ОДНУ
        // длительность всем кадрам, а с покадровыми репликами они
        // разные. Длительность и дорожка уже посчитаны выше, вместе с
        // отпечатком, — и это важно: отпечаток обязан считаться по
        // тому же, что уедет в команду, иначе он сторожит не то.
        slides.push({
          stepIndex: frame.stepIndex,
          url,
          seconds: frame.seconds,
          ...(frame.audioUrl ? { audioUrl: frame.audioUrl } : {}),
        });
      }

      const plan = planSlideshow(slides, {
        voiceoverUrl: narration.mode === 'whole' ? narration.url : null,
      });
      if (!plan) {
        this.logger.warn(
          `сценарий ${scenario.subjectKey}: ${frames.length} кадров не годятся для сборки (больше потолка слайд-шоу или у кадра неположительная длительность) — пропуск`,
        );
        // Кадры уже залиты — снимаем их и строку за собой, иначе
        // получили бы ровно ту сироту, ради которой всё это и
        // переставлено.
        await this.abandonAssembly(asset.id, 'кадры не годятся для сборки');
        return;
      }

      const job = await this.ffmpeg.submit({
        inputs: plan.inputs,
        outputs: plan.outputs,
        commands: plan.commands,
      });

      // Сборка стоит денег, и до сквозного аудита A+B+C этот расход
      // не записывался ВООБЩЕ — ни здесь, ни на пути обучалки по
      // сайту заказчика. При пяти локалях это до тридцати
      // неучтённых вызовов за ночь. Пишем сразу после отправки:
      // деньги списываются за приём задачи, а не за её результат.
      await this.aiUsage.record({
        operation: 'tutorial-video-assembly',
        model: 'ffmpeg-api',
        userId,
      });

      await this.prisma.tutorialVideoAsset.update({
        where: { id: asset.id },
        data: {
          assemblyStatus: 'pending',
          assemblyJobId: job.jobId,
          assemblyStartedAt: new Date(),
          // Длительность берётся из плана и пишется ЗДЕСЬ, при
          // отправке, — см. комментарий у `durationMs` в
          // `SlideshowPlan`. До этапа A она вычислялась при
          // завершении как `frameCount × SECONDS_PER_FRAME`, то есть
          // повторялась своими словами в трёх модулях от команды.
          durationMs: plan.durationMs,
        },
      });

      this.logger.log(
        `сценарий ${scenario.subjectKey}: слайд-шоу отправлено на сборку (задача ${job.jobId}, ${frames.length} кадров)`,
      );
    } catch (err) {
      await this.abandonAssembly(
        asset.id,
        err instanceof Error ? err.message : String(err),
      );
      this.logger.warn(
        `сценарий ${scenario.subjectKey}: не удалось отправить слайд-шоу на сборку: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Опрашивает все НЕЗАВЕРШЁННЫЕ сборки прошлых тиков (submit был на
   * предыдущем прогоне, ответ ffmpeg-api может подоспеть только сейчас
   * — тот же приём, что `PostProductionService.poll`). Свой, заметно
   * меньший бюджет времени (`POLL_DEADLINE_MS`), не общий с прогоном
   * сценариев (`RUN_DEADLINE_MS`) — это дешёвые HTTP-статусы, не запуск
   * браузера, но не должны есть его бюджет.
   */
  /**
   * Опросить только сборки слайд-шоу, без запуска сценариев.
   *
   * Заведено сквозным аудитом (27.09.2026). Раньше результат сборки
   * подбирал единственный крон `tutorial-scenario-run` — раз в сутки в
   * 09:00 UTC. Для регрессионных прогонов это нормально, а для
   * обучалки по сайту заказчика — нет: оператор одобряет запись,
   * задача уходит в ffmpeg сразу, готовый файл лежит у подрядчика
   * через минуту, а ссылка у человека появлялась в следующие сутки.
   * Экран мастера при этом опрашивает статус 15 с × 40 = десять минут
   * и сдаётся — то есть в норме пользователь не дожидался ссылки
   * никогда и уходил, думая, что сломалось.
   *
   * Отдельный вход, а не изменение расписания общего прогона: тот
   * держит headless-браузер открытым минутами, и гонять его каждые две
   * минуты нельзя. Здесь же — один запрос в базу и несколько проверок
   * статуса по HTTP.
   *
   * ## Замок стоит ЗДЕСЬ, а не у вызывающего
   *
   * Правка аудита 27.09.2026, находка на собственной же вчерашней
   * работе. Сначала замок взял крон, а `run()` продолжал опрашивать
   * сборки сам — под ДРУГИМ ключом. Значит в 09:00 UTC (и при любом
   * ручном запуске из админки) суточный прогон и двухминутный поллер
   * могли взять одну и ту же строку: двойное скачивание, двойная
   * перезаливка в Blob, а проигравший доходил до `failAssembly` и
   * `cleanupFrames` уже ПОСЛЕ чужого `complete` — то есть помечал
   * готовую сборку сбойной и стирал её кадры.
   *
   * Инвариант «опрашивает не больше одного» принадлежит тому, что
   * защищают, а не одному из вызывающих. Поэтому замок взят здесь:
   * добавить третьего вызывающего и снова его забыть теперь нельзя.
   */
  async pollAssemblies(): Promise<TutorialAssemblyPollResult> {
    const acquired = await tryAcquireJobLock(this.prisma, ASSEMBLY_POLL_LOCK);
    if (!acquired) {
      // Пропуск и «очередь пуста» — разные вещи, и в журнале крона они
      // обязаны читаться по-разному: иначе занятый замок выглядит как
      // «сборок и правда не было».
      return { skipped: 'предыдущий опрос ещё не завершился', polled: 0 };
    }
    try {
      // Счётчик — ПОСЛЕ опроса и по факту: сколько строк осталось
      // висеть. Прежняя редакция считала до опроса, и в журнале после
      // успешного тика, закрывшего все сборки, всё равно стояло
      // `pending=N` — число, по которому нельзя было понять, сделал
      // тик что-нибудь или нет.
      const abandoned = await this.abandonStalePreparing();
      const polled = await this.pollPendingVideoAssets();
      // Подметальщик — ПОСЛЕ опроса, а не до: строка, которая вот
      // сейчас доехала до `complete`, обязана попасть в расчёт
      // «кого оставляем» этим же тиком, иначе на один тик в паре
      // числится на ролик больше, чем есть.
      const swept = await this.sweepOldAssets();
      const pending = await this.prisma.tutorialVideoAsset.count({
        where: { assemblyStatus: 'pending' },
      });
      return { polled, pending, abandoned, swept };
    } finally {
      await releaseJobLock(this.prisma, ASSEMBLY_POLL_LOCK, acquired);
    }
  }

  /**
   * Подметает строки, застрявшие в `preparing`.
   *
   * `preparing` — короткое окно между созданием строки и `submit`:
   * в нём заливаются кадры, а с этапа B ещё и синтезируется mp3. Опрос
   * сборок выбирает только `pending`, и это правильно — полусобранную
   * строку трогать нельзя. Но если процесс умрёт внутри окна (а это
   * функция с потолком времени), `abandonAssembly` не вызовется
   * никогда, и кадры с озвучкой останутся в Blob НАВСЕГДА: подметальщик
   * ходит только по префиксу конкретного актива и только когда его
   * позвали.
   *
   * До этапа B яма была той же, но дешевле — только кадры. Найдено
   * аудитом этапа B.
   *
   * Порог — тот же `ASSEMBLY_DEADLINE_MS`, что у зависшей задачи
   * внешнего сервиса: если за десять минут строка не доехала до
   * `pending`, доехать ей уже нечем.
   *
   * @returns сколько строк снято.
   */
  private async abandonStalePreparing(): Promise<number> {
    const stale = (await this.prisma.tutorialVideoAsset.findMany({
      where: {
        assemblyStatus: 'preparing',
        createdAt: { lt: new Date(Date.now() - ASSEMBLY_DEADLINE_MS) },
      },
      take: RUN_BATCH_LIMIT,
      // `clientSiteDraftId` — не для уборки, а для отката черновика
      // (см. ниже). С правки сквозного аудита A+B+C в `preparing`
      // заводятся и строки обучалки по сайту заказчика.
      select: { id: true, subjectKey: true, clientSiteDraftId: true },
    })) as {
      id: string;
      subjectKey: string;
      clientSiteDraftId: string | null;
    }[];
    for (const row of stale) {
      const reason =
        'подготовка оборвалась: строка застряла в preparing, задача не была отправлена';
      await this.abandonAssembly(row.id, reason);
      // Черновик заказчика обязан вернуться на одобрение — иначе он
      // остаётся `APPROVED` с брошенной сборкой, и повторить её
      // нечем. У сценарного пути этого шага нет: там откатывать
      // нечего.
      await this.releaseClientSiteDraft(row, reason);
    }
    return stale.length;
  }

  /**
   * Подметает устаревшие ролики обучалки: строку и её mp4.
   *
   * ## Зачем
   *
   * Ночной прогон берёт КАЖДЫЙ подходящий сценарий и на каждый
   * заводит новую строку `TutorialVideoAsset` с новым файлом —
   * дедупликации по паре (шаг, локаль) у этой таблицы нет и быть не
   * должно (история сборок нужна: по ней видно, что и когда
   * снималось и почему не вышло). Но и расти вечно она не может: при
   * пяти локалях это до тридцати строк и тридцати mp4 за ночь, то
   * есть около одиннадцати тысяч файлов в год, из которых
   * пользователю показываются полсотни. Уборки не было никакой —
   * ни здесь, ни где-либо ещё в проекте.
   *
   * ## Кого оставляем: три роли, а не «последние N»
   *
   * На пару (шаг, локаль) остаются до трёх строк, и каждая держится
   * за СВОЙ вопрос, а не за место в списке:
   *
   *  1. **Самая свежая любого статуса** — то, что оператор видит на
   *     вкладке «Видео-контент» как «последняя попытка». Если
   *     сегодняшняя сборка провалилась, её `assemblyError` — это
   *     единственное место, где написано почему; удалив её как
   *     «неудачную», мы бы стёрли ровно ту строку, ради которой
   *     оператор туда и заходит.
   *  2. **Самая свежая `complete`** — гарантия, что проигрываемый
   *     файл есть ВСЕГДА. Без этой роли достаточно одной ночи с
   *     провалом, чтобы у пары не осталось ни одного собранного
   *     ролика: свежая строка `failed` заняла бы единственное место.
   *  3. **Самая свежая `reviewed`** — то, что видит посетитель
   *     (§4.6: сырая запись не публикуется, показывается только
   *     одобренная). Она вполне может быть НЕ самой свежей и НЕ
   *     самой свежей `complete`: оператор одобрил ролик неделю
   *     назад, а ночные прогоны с тех пор насобирали новых,
   *     неодобренных. Удалить её значит убрать обучалку с экрана.
   *
   * Обычно все три — одна и та же строка, и в паре остаётся ровно
   * одна.
   *
   * ## Кого не трогаем вовсе
   *
   *  - `preparing`/`pending` — они в работе; за них отвечают
   *    `abandonStalePreparing` и опрос.
   *  - Ролики обучалки по сайту заказчика (`clientSiteDraftId`) —
   *    у них своя жизнь и своё удаление вместе с черновиком (§5.2
   *    `DELETE`), «одна пара — один ролик» к ним неприменимо: ключ
   *    у всех них один и тот же служебный `client-site`.
   *  - Всё, на что заведена заявка публикации: `publishTutorialVideo`
   *    намеренно НЕ делает своей копии файла («лежит в постоянном, не
   *    TTL'мом префиксе — копировать нечего»), и заявка ссылается
   *    прямо на этот mp4. Удалив его, мы бы уронили выгрузку на
   *    площадку молча.
   *
   * @returns сколько строк удалено.
   */
  private async sweepOldAssets(): Promise<number> {
    const rows = (await this.prisma.tutorialVideoAsset.findMany({
      where: {
        clientSiteDraftId: null,
        assemblyStatus: { in: ['complete', 'failed'] },
      },
      // Сортировка делает группировку потоковой: строки одной пары
      // идут подряд, свежие впереди. Обрезка по `take` режет хвост
      // ОБЩЕГО списка, то есть последние пары выпадают целиком, а
      // разрезанной оказывается не больше одной — и у неё теряются
      // самые старые строки. И то, и другое безвредно: и пропущенная
      // пара, и потерянный хвост подметутся следующим тиком.
      // Ошибиться в опасную сторону — не увидеть свежую строку и
      // удалить нужную — обрезка не может: свежие всегда впереди.
      orderBy: [
        { subjectKey: 'asc' },
        { locale: 'asc' },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: ASSET_SCAN_LIMIT,
      select: {
        id: true,
        subjectKey: true,
        locale: true,
        reviewed: true,
        // `assemblyStatus` здесь НЕ выбирается: правило ролей считает
        // по `blobUrl` — ровно по тому, что читают потребители ролика
        // (см. `SweepableAsset.blobUrl`). Статус остаётся только в
        // условии выборки, чтобы не трогать строки в работе.
        blobUrl: true,
      },
    })) as {
      id: string;
      subjectKey: string;
      locale: string;
      reviewed: boolean;
      blobUrl: string | null;
    }[];

    const doomed = selectSweepableAssets(rows).slice(0, ASSET_DELETE_LIMIT);
    if (doomed.length === 0) return 0;

    // Заявки публикации — одним запросом на всех кандидатов, а не по
    // одному на строку: кандидатов до сотни.
    const published = (await this.prisma.publicationRequest.findMany({
      where: { tutorialVideoAssetId: { in: doomed.map((r) => r.id) } },
      select: { tutorialVideoAssetId: true },
    })) as { tutorialVideoAssetId: string | null }[];
    const keepIds = new Set(
      published.map((r) => r.tutorialVideoAssetId).filter(Boolean),
    );

    let deleted = 0;
    for (const row of doomed) {
      if (keepIds.has(row.id)) continue;
      // Второй, точечный вопрос о заявке — прямо перед удалением.
      // Пакетный выше задан один раз на всю партию, а партия
      // удаляется до сотни строк подряд, по два обращения к сети на
      // каждую: оператор, нажавший «Опубликовать» внутри этого окна,
      // получил бы заявку со ссылкой на уже удалённый файл, и упала
      // бы она позже и не у него на глазах. Окно от этого не
      // исчезает совсем (мягкая ссылка, внешнего ключа нет), но
      // сжимается с секунд до одного запроса.
      const claimed = await this.prisma.publicationRequest.count({
        where: { tutorialVideoAssetId: row.id },
      });
      if (claimed > 0) continue;
      // Файл — ПЕРЕД строкой. Обратный порядок терял бы путь к mp4
      // навсегда при любом сбое между двумя операциями: путь
      // известен только из строки. Сбой на удалении файла оставляет
      // строку на месте — следующий тик попробует снова.
      const pathname = pathnameFromBlobUrl(row.blobUrl, 'tutorial-videos/');
      try {
        if (pathname) await this.blob.deleteBlob(pathname);
        await this.prisma.tutorialVideoAsset.delete({ where: { id: row.id } });
        deleted++;
      } catch (e) {
        this.logger.warn(
          `устаревший ролик ${row.id} (${row.subjectKey}/${row.locale}) не убрался: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    if (deleted > 0) {
      this.logger.log(
        `подметальщик роликов: удалено ${deleted} устаревших (просмотрено ${rows.length})`,
      );
    }
    return deleted;
  }

  /** @returns сколько строк успели опросить. */
  private async pollPendingVideoAssets(): Promise<number> {
    if (!this.ffmpeg.configured()) return 0;

    const pending = await this.prisma.tutorialVideoAsset.findMany({
      where: { assemblyStatus: 'pending' },
      take: RUN_BATCH_LIMIT,
    });
    if (pending.length === 0) return 0;

    const deadline = Date.now() + POLL_DEADLINE_MS;
    let polled = 0;
    for (const asset of pending) {
      if (Date.now() >= deadline) break;
      await this.pollOneVideoAsset(asset);
      polled++;
    }
    return polled;
  }

  private async pollOneVideoAsset(asset: {
    id: string;
    subjectKey: string;
    scenarioId: string | null;
    // Объявлено, потому что ЧИТАЕТСЯ дальше по цепочке:
    // `failAssembly` → `releaseClientSiteDraft` возвращает черновик
    // обучалки из `APPROVED` на одобрение. Поле необязательное в
    // подписи `releaseClientSiteDraft`, а `findMany` идёт без
    // `select`, поэтому раньше это сходилось молча — и первый же
    // `select:` (естественная оптимизация) запер бы черновик в
    // `APPROVED` навсегда, без единой ошибки компилятора. Найдено
    // аудитом этапа A.
    clientSiteDraftId: string | null;
    assemblyJobId: string | null;
    assemblyStartedAt: Date | null;
  }): Promise<void> {
    if (!asset.assemblyJobId) {
      await this.failAssembly(
        asset,
        'сборка помечена ожидающей, но задача не была отправлена (процесс оборвался между записью строки и submit)',
      );
      return;
    }

    if (
      asset.assemblyStartedAt &&
      Date.now() - asset.assemblyStartedAt.getTime() > ASSEMBLY_DEADLINE_MS
    ) {
      await this.failAssembly(
        asset,
        `сборка не завершилась за ${ASSEMBLY_DEADLINE_MS / 60000} мин`,
      );
      return;
    }

    let status;
    try {
      status = await this.ffmpeg.status(asset.assemblyJobId);
    } catch (err) {
      // Сетевая икота — оставляем как pending, следующий тик повторит;
      // затянувшуюся серию икот закроет дедлайн выше (тот же приём, что
      // PostProductionService.poll).
      this.logger.warn(
        `сценарий ${asset.subjectKey}: статус сборки видео недоступен: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    if (status.status === 'pending') return;

    if (status.status === 'failed') {
      await this.failAssembly(
        asset,
        status.error ?? 'ffmpeg-api вернул ошибку без текста',
      );
      return;
    }

    const url = status.outputs
      ? Object.values(status.outputs).find(Boolean)
      : undefined;
    if (!url) {
      await this.failAssembly(
        asset,
        'задача завершилась, но ffmpeg-api не вернул файла',
      );
      return;
    }

    try {
      const bytes = await this.downloadBytes(url);
      const { url: ourUrl } = await this.blob.uploadBuffer(
        `tutorial-videos/${asset.subjectKey}/${asset.id}.mp4`,
        bytes,
        'video/mp4',
      );
      await this.prisma.tutorialVideoAsset.update({
        where: { id: asset.id },
        data: {
          assemblyStatus: 'complete',
          blobUrl: ourUrl,
          assemblyError: null,
          // `durationMs` здесь НЕ пишется: он записан при отправке, из
          // `plan.durationMs` — того самого плана, по которому собран
          // файл. До этапа A он вычислялся тут заново, произведением
          // `frameCount × SECONDS_PER_FRAME`, и это сходилось ровно
          // пока все кадры были одной длины. С этапа B длины разные, и
          // повторное вычисление разошлось бы молча — а число это
          // человек читает на экране мастера («Длительность — около
          // N с»).
          //
          // Строки, отправленные до этой правки, досчитывать задним
          // числом не пытаемся: `durationMs` необязателен, экран
          // мастера без него просто не показывает строку.
        },
      });
      this.logger.log(
        `сценарий ${asset.subjectKey}: слайд-шоу собрано (${bytes.length} байт)`,
      );
    } catch (err) {
      await this.failAssembly(
        asset,
        `не удалось скачать/перезалить готовое видео: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    // Уборка кадров — ЗА пределами try выше, и это правка повторного
    // сквозного аудита A+B+C. Внутри него она создавала состояние,
    // которого в схеме не предусмотрено: икота Blob на `wipePrefix`
    // после уже записанного `complete` + `blobUrl` уводила строку в
    // `catch` → `failAssembly` → статус `failed`, а `blobUrl` при этом
    // оставался. Дальше всё честно ломалось по цепочке: оператор
    // видел красный бейдж и рабочий плеер, одобрял (`setReviewed`
    // статус не смотрит), консультант отдавал ролик посетителю
    // (`{reviewed, blobUrl}`, статус тоже не смотрит) — а текст
    // ошибки при этом врал: «не удалось скачать/перезалить», хотя и
    // скачали, и перезалили.
    //
    // Кадры — транзит: их потеря стоит места в Blob, а не ролика.
    // Своя обёртка, а не общий `catch`: единственный правильный
    // ответ на неубравшиеся кадры — запись в журнал, следующая
    // попытка уберёт их вместе со строкой (`sweepOldAssets`).
    try {
      await this.cleanupFrames(asset);
    } catch (e) {
      this.logger.warn(
        `сценарий ${asset.subjectKey}: кадры собранного ролика не убрались: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private async failAssembly(
    asset: {
      id: string;
      subjectKey: string;
      scenarioId?: string | null;
      clientSiteDraftId?: string | null;
    },
    reason: string,
  ): Promise<void> {
    this.logger.warn(
      `сценарий ${asset.subjectKey}: сборка видео провалилась — ${reason}`,
    );
    await this.prisma.tutorialVideoAsset.update({
      where: { id: asset.id },
      data: { assemblyStatus: 'failed', assemblyError: reason },
    });
    await this.cleanupFrames(asset);
    await this.releaseClientSiteDraft(asset, reason);
  }

  /**
   * Вернуть черновик обучалки по сайту заказчика из `APPROVED` в
   * `PENDING_REVIEW`, если его сборка провалилась.
   *
   * Найдено аудитом 27.09.2026. Одобрение переводит черновик в
   * `APPROVED` и отправляет слайд-шоу на сборку; откат на этот случай
   * был предусмотрен ТОЛЬКО для синхронного сбоя `submit`
   * (`client-site-tutorial-admin.service.ts`). Провал, обнаруженный
   * позже, на опросе, не откатывал ничего — а из `APPROVED` выхода
   * нет ни у кого: `approve`/`reject` требуют `PENDING_REVIEW`,
   * пользовательский `resume` — `REJECTED`. То есть неудачная сборка
   * запирала черновик навсегда, и починить его можно было только
   * руками в базе.
   *
   * `updateMany` с условием по статусу, а не `update`: между чтением и
   * записью оператор мог сделать что-то ещё, и молча переписывать его
   * решение нельзя.
   */
  private async releaseClientSiteDraft(
    asset: { clientSiteDraftId?: string | null },
    reason: string,
  ): Promise<void> {
    const draftId = asset.clientSiteDraftId;
    if (!draftId) return;
    const { count } = await this.prisma.clientSiteTutorialDraft.updateMany({
      where: { id: draftId, status: 'APPROVED' },
      data: {
        status: 'PENDING_REVIEW',
        rejectionReason: `сборка ролика не удалась: ${reason}`.slice(0, 500),
      },
    });
    if (count > 0) {
      this.logger.warn(
        `черновик обучалки ${draftId} возвращён на одобрение: сборка провалилась`,
      );
    }
  }

  /** Транзитные кадры (см. `submitVideoAssembly`) удаляются, как только
   * их судьба решена (собрано или провалено) — держать их в Blob дальше
   * этого момента незачем, тот же принцип, что уже применяет
   * `BlobService`'s доккомментарий к референсному видео анализа. */
  private async cleanupFrames(asset: {
    id: string;
    scenarioId?: string | null;
  }): Promise<void> {
    // Только строки ШТАТНОЙ обучалки: у них кадры транзитные — скачаны
    // внешним ffmpeg-api и больше не нужны. У обучалки по сайту
    // заказчика (`clientSiteDraftId`, этап 113) `scenarioId` пуст, и
    // ранний выход ниже намеренный, а не случайный: там те же файлы —
    // это ПРЕДПРОСМОТР, который видят пользователь и оператор, и живут
    // они до удаления черновика (§5.2 `DELETE`), а не до сборки.
    if (!asset.scenarioId) return;
    // По ПРЕФИКСУ, а не по счётчику 0..frameCount-1 (правка аудита
    // 27.09.2026, тот же довод, что у `wipeFrames` в обучалке по сайту
    // заказчика): счётчик мог быть меньше, чем лежит на самом деле, и
    // разница осталась бы навсегда.
    await this.wipeScenarioFrames(asset.id);
  }

  /** Стереть весь префикс кадров одного актива. */
  private async wipeScenarioFrames(assetId: string): Promise<void> {
    await this.wipePrefix(scenarioFramePrefix(assetId));
  }

  /**
   * Сборка не состоялась до отправки задачи: убираем за собой кадры и
   * помечаем строку сбойной. Строка НЕ удаляется — по ней видно, что
   * прогон пытался собрать видео и почему не вышло; удалённая строка
   * выглядела бы как «и не пытались».
   */
  private async abandonAssembly(
    assetId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.wipeScenarioFrames(assetId);
    } catch (e) {
      this.logger.warn(
        `кадры актива ${assetId} не убрались: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    await this.prisma.tutorialVideoAsset.update({
      where: { id: assetId },
      data: { assemblyStatus: 'failed', assemblyError: reason.slice(0, 500) },
    });
  }

  private async downloadBytes(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`скачивание результата: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
