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
 * расписанию; исполняет это `contentHash` (`slideshowFingerprint` от
 * кадров — перцептивно, как ночной снимок интерфейса, — дорожек,
 * длительностей и СОДЕРЖИМОГО подписей): совпал с отпечатком последнего собранного ролика пары — задача не
 * отправляется и строка не заводится. Первая ночь после выката
 * этапа E пересоберёт весь уже собранный набор — до пятидесяти
 * платных задач единоразово: подписи меняют картинку, и это ровно
 * та пересборка, ради которой отпечаток и заводился.
 *
 * Второй — убирать лишнее. `sweepOldAssets` ходит вместе с опросом
 * сборок и держит на пару (шаг, локаль, тема) до трёх строк, по одной на
 * роль; подробности и границы — в его доккомментарии.
 *
 * ## Светлая и тёмная темы (заход 3 «Актуального демо», 06.10.2026)
 *
 * Каждый сценарий снимается в двух темах, и это два ОТДЕЛЬНЫХ ролика:
 * пара — (subjectKey, locale, theme). Тик берёт столько же сценариев,
 * сколько и раньше, и каждый — в одной теме, той, что дольше не
 * снималась (`tutorial-theme-rotation.ts`). Отпечаток кадров, счёт
 * провалов, подметальщик и одобрение — по паре с темой.
 *
 * Тема ставится «как внутри Telegram»: явный выбор темы человеком
 * (`v4c_theme`) НЕ пишется, а SDK Telegram получает `themeParams`
 * нужной темы — и фронтенд красится тем же путём, что в настоящем
 * клиенте (`applyTheme()` следует `WebApp.colorScheme`). Что этот
 * приём подтверждает и чего не подтверждает — у `runOne`.
 *
 * ## Почему платные сценарии не тратят деньги на этом прогоне
 *
 * Регрессионный прогон нужен КАЖДУЮ ночь, а платить за настоящий
 * рендер при каждом прогоне крона нельзя: `approved` (§4.11 ТЗ) не
 * про «можно тратить при каждом regression-тесте», а про будущий
 * видео-захват, где платный шаг случится по-настоящему один раз для
 * записи. Поэтому `scenario-runner.ts` не исполняет ни сам маркер
 * `triggerPaidOperation`, ни `click`, идущий сразу за ним, и
 * возвращает их номера в `skippedPaidClicks`. Оценка `costly`/
 * `approved` здесь — входной фильтр (см. ниже), не разрешение тратить.
 *
 * До сквозного аудита 29.09.2026 этот абзац утверждал ровно то же
 * самое, а `scenario-runner.ts` в своём доккомментарии прямо писал,
 * что следующий за маркером клик «тоже выполнится буквально» и «это
 * осознанно НЕ блокируется здесь». Правы были не оба: защиты не
 * существовало, а обещание о ней стояло здесь — в файле, который
 * читают, когда спрашивают «а не потратит ли крон денег». Стоит
 * помнить как образец: два доккомментария о ОДНОМ механизме в разных
 * файлах разошлись, и разошлись в сторону, безопасную для чтения и
 * опасную для кошелька.
 */

import { defaultDraftSecretsStore } from '../client-site-tutorial/draft-secrets-store';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ClientSiteMediaService } from '../client-site-media/client-site-media.service';
import { LandingVideosService } from '../client-site-media/landing-videos.service';
import { Prisma, ProjectType } from '@prisma/client';
import { TutorialVideoVersionsService } from '../postprod/tutorial-video-versions.service';
import { GenerationStatus } from '../../common/types/generation.types';
import { SessionStatus } from '../../common/types/session.types';
import { PrismaService } from '../../prisma/prisma.service';
import { estimateCost } from '../../common/ai-pricing';
import {
  budgetExhausted,
  openTutorialBudget,
  TutorialBudget,
} from './tutorial-budget';
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
import { FIXTURE_IDS, seedFixtureUser } from './fixture-seed';
import {
  FRESH_WIZARD_ROUTE,
  FixtureRouteContext,
  SEEDED_SESSION_ROUTES,
  resolveScenarioRoute,
} from './route-templates';
import {
  buildTutorialCaptionsAss,
  captionReadingSeconds,
  captionsPathname,
} from './tutorial-captions';
import {
  CANVAS,
  CAPTURE_DEVICE_SCALE_FACTOR,
  CAPTURE_VIEWPORT,
  evenFrameSeconds,
  narrationFrameSeconds,
  fingerprintRest,
  planSlideshow,
  sameSlideshowContent,
  slideshowFingerprint,
  TUTORIAL_FRAME_SENSITIVITY,
  TUTORIAL_FRAME_SENSITIVITY_ENV,
  SlideshowFrame,
  ZOOM_MAX_SECONDS,
} from './tutorial-video-assembly';
import { TERMS_VERSION } from '../legal/legal.service';
import { resolveChangeSensitivity } from '../ui-snapshot/perceptual-hash';
import {
  hasTutorialSteps,
  parseTutorialLocales,
  tutorialStepFor,
  TUTORIAL_LOCALES_SETTING_KEY,
} from '../tutorial-scenario/tutorial-locales';
import {
  narrationTextForSubject,
  parseRequireNarrationReview,
  parseTutorialCaptionsSetting,
  parseTutorialMotionSetting,
  parseTutorialPointerSetting,
  parseTutorialVoiceSetting,
  TUTORIAL_CAPTIONS_SETTING_KEY,
  TUTORIAL_MOTION_SETTING_KEY,
  TUTORIAL_POINTER_SETTING_KEY,
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
import {
  buildTutorialManifest,
  ManifestFrame,
  textSha,
} from './tutorial-manifest';
import {
  APPROVAL_STAMPS_SETTING_KEY,
  pairsInApprovalGrace,
  parseApprovalStamps,
  selectSweepableAssets,
} from './tutorial-video-retention';
import { tryAcquireJobLock, releaseJobLock } from '../../common/cron-job-lock';
import { TutorialDemoQualityService } from '../tutorial-quality/demo-quality.service';
import { TICK_BUDGET_MS as DEMO_QUALITY_TICK_BUDGET_MS } from '../tutorial-quality/demo-quality-queue';
import {
  attachFixtureToken,
  fixtureApiOrigin,
  FixtureTokenPage,
} from '../../common/fixture-token-page';
import {
  narrationOf,
  ScenarioStep,
} from '../tutorial-scenario/scenario-steps.types';
import {
  SPA_LOCALE_STORAGE_KEY,
  SPA_SESSION_STORAGE_KEY,
  SPA_THEME_STORAGE_KEY,
} from '../../common/spa-storage-keys';
import {
  assetTheme,
  assetThemeWhere,
  CaptureThemeProbe,
  captureThemeVia,
  CaptureThemeVia,
  clipRunError,
  isScenarioTheme,
  parseThemeRuns,
  planThemedRuns,
  recordThemeRun,
  ScenarioTheme,
  serializeThemeRuns,
  TELEGRAM_SDK_INIT_PARAMS_KEY,
  TELEGRAM_SDK_THEME_PARAMS_KEY,
  TELEGRAM_THEME_PARAMS,
  THEME_RUNS_SETTING_KEY,
  ThemeRuns,
} from './tutorial-theme-rotation';
import {
  isSiteTutorialDemoFamilyKey,
  isSiteTutorialDemoKey,
  parseSiteTutorialDemoAssetIds,
  SITE_TUTORIAL_DEMO_ASSETS_SETTING_KEY,
  SITE_TUTORIAL_DEMO_KEYS,
  SITE_TUTORIAL_DEMO_PREFIX,
} from '../tutorial-help/site-tutorial-demo';
import {
  polygonOrigin,
  resolvePolygonRoute,
  validatePolygonScenarioSteps,
  withPolygonReadyWait,
} from './polygon-scenario';
import { siteTutorialDemoTitle } from './site-tutorial-demo-seed';

/** Сколько сценариев БЕРЁМ из базы за один тик — 30. Это верхняя граница
 * выборки, а не пропускная способность: на деле за тик успевает около
 * пяти сценариев (упирается `RUN_DEADLINE_MS`, см. ниже), остальные
 * ждут следующего тика по ротации `lastRunAt`. Пар на локаль сегодня 15
 * (десять шагов мастера товара и пять тем поздравления,
 * `tutorial-scenario-generator.service.ts`), при одной локали `ru`
 * выборка их вмещает целиком; при пяти локалях строк 75 — больше
 * лимита, и справедливость держит именно ротация, а не это число. */
const RUN_BATCH_LIMIT = 30;

/**
 * Сколько строк сценариев читать, чтобы выбрать из них `RUN_BATCH_LIMIT`
 * прогонов (заход 3 «Актуального демо», 06.10.2026).
 *
 * До тем выборка отсекала «прошедшие недавно» прямо в SQL и брала
 * первые тридцать. С темами так нельзя: сценарий, прошедший час назад
 * в светлой теме, может ни разу не сниматься в тёмной, а колонка
 * `lastRunAt` у строки одна. Поэтому строки читаются шире, а «кому
 * сейчас нужен прогон и в какой теме» решает `planThemedRuns` по
 * по-темным отметкам. Сценариев сегодня 75 при пяти локалях — потолок
 * с большим запасом и при этом не «вся таблица навсегда».
 */
const SCENARIO_SCAN_LIMIT = 500;

/**
 * Потолок жизни функции Vercel, под которым считается весь тик: сверх
 * него платформа убивает процесс посреди работы.
 *
 * 300 с — это умолчание платформы при незаданном `maxDuration`, а не
 * предел тарифа: backend-проект на Vercel Pro (`doc/DEPLOYMENT.md`), и
 * `maxDuration` в `backend/vercel.json` может поднять потолок функции.
 * Держать 300 с — выбор (второй тик крона вместо длинной функции,
 * §11-новиес ТЗ обучалки). Поднимая `maxDuration`, поднимать и это
 * число — иначе дедлайн тика останется прежним, — и сверить его с
 * `JOB_LOCK_MS`.
 */
const TICK_CEILING_MS = 300_000;

/** Таймаут на один сценарий целиком (до 30 шагов, `MAX_SCENARIO_STEPS`) —
 * защита от одного зависшего сценария, съедающего весь бюджет тика.
 * Накрывает ТОЛЬКО браузерную часть (`runScenario`). */
const SCENARIO_TIMEOUT_MS = 90_000;

/**
 * Дедлайн на отправку сборки (`submitVideoAssembly`) — заливка кадров,
 * синтез дорожек озвучки, `submit` в ffmpeg-api.
 *
 * Заведён пятым боевым прогоном (29.09.2026). До него эта часть не была
 * ограничена НИЧЕМ: `SCENARIO_TIMEOUT_MS` накрывает `runScenario` и
 * заканчивается там, а дальше шли до тридцати заливок и до семи вызовов
 * внешнего синтеза без единого таймаута. Резерв под этот хвост при этом
 * существовал (`TICK_TAIL_RESERVE_MS`) — то есть время резервировалось
 * под величину, у которой не было верхней границы.
 *
 * Обрыв по времени здесь безопасен ровно потому, что метод объявлен
 * best-effort: regression-результат сценария уже записан в базу ДО
 * него, и ни его исход, ни его обрыв на этот результат не влияют.
 *
 * Обрыв ОТМЕНЯЕТ отправку, а не только перестаёт её ждать (аудит
 * кронов 06.10.2026): `runOne` передаёт в метод сигнал, и тот перед
 * каждым синтезом, заливкой и submit проверяет его — недоделанная
 * сборка закрывается строкой `failed` с причиной `infra:` и без
 * оплаченной задачи. Уже начатый сетевой вызов сигнал не прерывает;
 * если обрыв пришёлся на сам submit, задача уйдёт, и строка честно
 * станет `pending`. Строку, оставшуюся в `preparing` после смерти
 * процесса, подбирает `abandonStalePreparing`, её кадры — метла по
 * префиксу `tutorial-video-frames` (сквозной аудит 29.09.2026).
 */
const ASSEMBLY_SUBMIT_TIMEOUT_MS = 60_000;

/**
 * Резерв на выход из тика ПОСЛЕ последней сборки (аудит кронов
 * 06.10.2026): закрытие страницы и браузера, итоговая тревога, запись
 * результата и строки журнала крона. Сумма двух таймаутов ниже была
 * ровно 150 с — то есть «впритык» к потолку при худшем случае обоих, и
 * всё, что идёт после них, в арифметику не входило вовсе.
 */
const TICK_EXIT_RESERVE_MS = 15_000;

/**
 * Запас на «хвост» тика: сценарий, уже начатый к моменту дедлайна,
 * плюс отправка его сборки, плюс выход из тика.
 *
 * Это СУММА ДВУХ НАСТОЯЩИХ ГРАНИЦ, а не замер. Так было не всегда: до
 * пятого прогона здесь стояли 55 с, выведенные из среднего (≈46 с на
 * сценарий вместе со сборкой). У константы, которая существует ради
 * худшего случая, среднее не может быть основанием — и пятый прогон
 * это показал: тик занял 298.6 с при потолке 300 с, то есть хвост
 * съел 53.6 с из отведённых 55. Держалось это пять прогонов только
 * потому, что обычная сборка быстрая.
 */
const TICK_TAIL_RESERVE_MS =
  SCENARIO_TIMEOUT_MS + ASSEMBLY_SUBMIT_TIMEOUT_MS + TICK_EXIT_RESERVE_MS;

/**
 * Общий бюджет времени на весь тик. Не круглое «четыре минуты», а
 * разность: сколько остаётся под потолком функции, если оставить запас
 * на хвост.
 *
 * До 29.09.2026 здесь стояло `4 * 60 * 1000` с оговоркой «оставляем
 * запас» — но запас нигде не считался, и сценарий, начатый за секунду
 * до дедлайна, мог идти ещё `SCENARIO_TIMEOUT_MS` (90 с) плюс сборку,
 * то есть перевалить за потолок и быть убитым платформой.
 *
 * ## Чего эта константа НЕ может
 *
 * Вместить все сценарии в один тик. Девяти нужно ≈330–420 с (три
 * замера), потолок функции — 300 с. Узкое место — не бюджет, а сама
 * функция, и лечится оно вторым тиком крона (`vercel.json`), а не
 * этим числом. Ротация `lastRunAt asc nulls first` к этому готова:
 * отложенные идут первыми.
 *
 * Арифметика покрытия: при ≈37 с на сценарий (пятый прогон: 8 за
 * 298.6 с) в 135 с бюджета (300 − 90 − 60 − 15) помещается четыре
 * старта. Тиков 15 в сутки (в :05 каждого часа 9–23 UTC, `vercel.json`,
 * решение владельца: тики, а не длинная функция) — ≈60 стартов в сутки.
 * Одной локали (15 тем) это с избытком; пяти локалям (75 пар) круг
 * больше суток — но и не нужен каждый день: прошедший сценарий с
 * неизменными шагами повторно берётся не раньше `OK_RERUN_INTERVAL_MS`.
 * Держит число тиков `cron-wiring.spec.ts`.
 *
 * Сценарии, не уложившиеся в бюджет, остаются на следующий прогон —
 * `lastRunAt` у них просто не обновится сегодня.
 */
const RUN_DEADLINE_MS = TICK_CEILING_MS - TICK_TAIL_RESERVE_MS;

/** Отдельный, заметно меньший бюджет на опрос НЕЗАВЕРШЁННЫХ сборок
 * видео в начале тика (этап 98) — это дешёвые HTTP-статусы, не запуск
 * браузера, но всё равно не должны есть бюджет, отведённый на сами
 * сценарии (`RUN_DEADLINE_MS`). */
const POLL_DEADLINE_MS = 60_000;

/**
 * Не чаще какого интервала повторять сценарий, прошедший (`ok`) на тех
 * же шагах (аудит кронов 06.10.2026).
 *
 * При одной локали пятнадцать пар против ≈60 стартов в сутки давали
 * каждой паре по четыре-пять прогонов в день — браузер, кадры,
 * сравнение отпечатка, — и всё ради того же «ok». Регресс по
 * интерфейсу ловит и суточный повтор; двадцать часов, а не сутки, —
 * чтобы прогон не уползал каждый день на тик позже.
 *
 * «Те же шаги» держится без отдельного хеша: оба места, которые
 * переписывают шаги (генератор при `changed` и ручная правка в
 * админке), стирают `lastRunStatus`, — и пара с переписанными шагами
 * уходит в прогон на ближайшем тике. Провалившиеся интервала не ждут.
 */
const OK_RERUN_INTERVAL_MS = 20 * 60 * 60 * 1000;

/**
 * Пометка «провал инфраструктуры, а не содержимого» в
 * `assemblyError` (аудит кронов 06.10.2026).
 *
 * Потолок попыток (`MAX_ASSEMBLY_ATTEMPTS`) считает провалы ОДНОГО
 * содержимого — его смысл в том, чтобы не платить вечно за кадр, на
 * котором спотыкается внешний сервис. Но в тот же счёт попадали и
 * провалы, к содержимому отношения не имеющие: выбранный денежный
 * потолок, зависшая подготовка, сетевой сбой submit, икота Blob. Три
 * таких — и пара не пересобиралась больше никогда (до смены кадров), а
 * тревога «попытки остановлены» шла каждый прогон. Такие строки теперь
 * помечаются этим префиксом и теряют `contentHash` — в счёт попыток они
 * не попадают ни одним из двух признаков.
 */
const INFRA_ERROR_PREFIX = 'infra: ';

/** Вид провала сборки — см. `INFRA_ERROR_PREFIX`. */
type AssemblyFailureKind = 'infra' | 'content';

/**
 * Постер ролика — первый кадр, скопированный в ПОСТОЯННЫЙ префикс до
 * уборки кадров-транзитов (аудит кронов 06.10.2026). Живёт столько же,
 * сколько строка: `sweepOldAssets` удаляет его вместе с mp4, а сирот
 * подбирает метла `sweep-orphans` (область `tutorial-video-posters`).
 */
export const TUTORIAL_POSTER_PREFIX = 'tutorial-video-posters/';

export function tutorialPosterPathname(assetId: string): string {
  return `${TUTORIAL_POSTER_PREFIX}${assetId}.png`;
}

/**
 * Какой пропуск прогона уже поднимал тревогу (аудит кронов 06.10.2026).
 *
 * Пропуск громкий намеренно (см. `skipLoudly`), но при пятнадцати тиках в
 * сутки одна и та же причина давала пятнадцать одинаковых тревог —
 * дедупликация канала держит только десять минут. Тревога теперь одна
 * на ВИД причины, пока прогон не пойдёт снова: тогда отметка стирается,
 * и следующий пропуск снова громкий. Журнал крона при этом пишет
 * каждый пропуск (исход SKIPPED).
 */
const RUN_SKIP_ALERT_SETTING_KEY = 'tutorial.runSkipAlerted';

/** Дедлайн одной сборки слайд-шоу — тот же порядок величины, что
 * `POSTPROD_DEADLINE_MS` у переозвучки/кропа (минуты, не часы): если
 * внешний ffmpeg-api не ответил за это время, задача считается
 * провалившейся, а не «всё ещё идёт» навсегда. */
const ASSEMBLY_DEADLINE_MS = 10 * 60 * 1000;

/*
 * Тема интерфейса на съёмке — с захода 3 «Актуального демо» (06.10.2026)
 * не константа: крон чередует светлую и тёмную по паре
 * (`tutorial-theme-rotation.ts`), и каждая тема — отдельный ролик пары
 * (subjectKey, locale, theme). До этого здесь стояла `SCENARIO_THEME =
 * 'light'`, и тёмного ролика не было ни одного.
 */

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
  // Демо обучающего лендинга — заголовок сценария из сида («Как найти
  // условия доставки»), а не ключ слота.
  if (isSiteTutorialDemoKey(subjectKey)) {
    return siteTutorialDemoTitle(subjectKey, locale);
  }
  return tutorialStepFor(subjectKey, locale)?.title ?? subjectKey;
}

export interface TutorialScenarioRunOutcome {
  id: string;
  subjectKey: string;
  /** Язык прогона. Без него в журнале крона пять локалей выглядят
   *  пятью одинаковыми строками (правка аудита этапа C). */
  locale: string;
  /** Тема прогона (заход 3 «Актуального демо»): одна пара в двух темах
   *  — два разных прогона, и в журнале они обязаны различаться. */
  theme: ScenarioTheme;
  ok: boolean;
  error?: string;
  /** Сколько платных кликов прогон пропустил, не нажимая (см.
   * `scenario-runner.ts`). Больше нуля означает, что ролик показывает
   * экран ДО нажатия, а не результат — исход, отличный и от «прошло», и
   * от «упало». */
  paidClicksSkipped?: number;
  /** Реплики были, но их не хватило на порог — ролик озвучен текстом
   *  карточки шага, и вычитанные реплики в него не попали. */
  narrationFallback?: true;
  /** Сколько кадров не снялось при пройденных шагах: ролик короче
   *  сценария. «Прошло» и «прошло наполовину» — разные исходы. */
  framesMissed?: number;
  /** Шаги прошли, а кадров нет ни одного — ролика не будет, и статус
   *  «ok» об этом не говорит. */
  noFrames?: true;
  /** Подготовка не уложилась в срок: подметальщик забрал строку, пока
   *  она шла, и оплаченная задача осталась без хозяина. */
  lostRace?: true;
  /** Упал ровно так же, как в прошлый раз. Тревога о такой поломке
   *  уже была — повторять её каждую ночь значит превратить канал в
   *  фон, который перестают читать. */
  repeatFailure?: true;
  /** Отправку сборки оборвал `ASSEMBLY_SUBMIT_TIMEOUT_MS`. Шаги
   *  прошли, ролика не будет. Без этой отметки обрыв выглядел бы как
   *  чистый успех: regression-результат к этому моменту уже записан. */
  assemblyTimedOut?: true;
  /**
   * Как на деле нарисована тема кадров (см. `CaptureThemeVia`):
   * `telegram` — через SDK Telegram, как в клиенте; `media-query` — SDK
   * не дал темы, фронтенд взял её из `prefers-color-scheme`. Нет поля —
   * замер не удался (страница не умеет `evaluate`).
   */
  themeVia?: Exclude<CaptureThemeVia, 'mismatch'>;
  /** Кадры сняты НЕ в той теме — ролик не собирается: тёмный ролик со
   *  светлыми кадрами хуже, чем никакого. Шаги при этом прошли. */
  themeMismatch?: true;
  /** Прогон прошёл, а ролик не собирался: владельца расхода нет
   *  (демо витрины без тестовой фикстуры — см. `polygonSpendOwner`). */
  assemblySkipped?: 'no-spend-owner';
}

/**
 * Сводка прохода демо обучающего лендинга (витрина `/qa/demo-shop`) —
 * отдельным полем, потому что этот проход идёт и тогда, когда проход TMA
 * пропущен (фикстура не настроена): `skipped` в результате тогда про TMA,
 * а не про витрину.
 */
export interface PolygonPassSummary {
  /** Origin полигона, против которого шла съёмка. */
  origin: string;
  total: number;
  executed: number;
  passed: number;
  failed: number;
  /** Прошли, но ролик не собирался — нет владельца расхода. */
  assemblyWithoutOwner: number;
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
  /** Сумма пропущенных платных кликов по всем сценариям тика. В журнал
   * крона едет отдельным числом: «прогон прошёл» и «прогон прошёл, но
   * кнопку рендера никто не нажимал» оператор обязан различать, не
   * открывая логи. */
  paidClicksSkipped: number;
  /** У скольких сценариев вычитанные реплики не прозвучали: их было
   *  меньше порога, и ролик озвучен текстом карточки шага. */
  narrationFallbacks: number;
  /** Сколько кадров не снялось за тик при пройденных шагах. */
  framesMissed: number;
  /** У скольких сценариев не снялось НИ ОДНОГО кадра при пройденных
   *  шагах: зелёный «ok» и отсутствие ролика без объяснения. */
  withoutFrames: number;
  /** У скольких подготовка не уложилась в срок и оплаченная задача
   *  осталась без строки. Не ноль — повод поднять
   *  `ASSEMBLY_DEADLINE_MS` или разобраться с медленным Blob. */
  lostRaces: number;
  /** Сколько падений повторяют вчерашние. Тревог о них не шлётся —
   *  число здесь и есть способ о них узнать. */
  repeatFailures: number;
  /** У скольких сценариев отправка сборки оборвана по времени.
   *  Устойчиво не ноль — значит сборка систематически не влезает в
   *  `ASSEMBLY_SUBMIT_TIMEOUT_MS`, и это разговор о самой сборке, а
   *  не о бюджете тика. */
  assemblyTimeouts: number;
  /** У скольких прогонов кадры сняты не в той теме, и ролик не собран
   *  (см. `themeMismatch`). Необязательное — его нет у пропусков. */
  themeMismatches?: number;
  outcomes: TutorialScenarioRunOutcome[];
  /** Проход демо обучающего лендинга этого тика; нет поля — его не было
   *  (полигон не настроен, строк семейства нет или снимать нечего). */
  polygon?: PolygonPassSummary;
}

/**
 * Ключ джоб-замка опроса сборок. Тот же, что у крона
 * `tutorial-assembly-poll` — специально: замок общий на всех, кто
 * опрашивает, а не на один маршрут.
 */
const ASSEMBLY_POLL_LOCK = 'tutorial-assembly-poll';

/** Весь тик опроса сборок должен уложиться в функцию Vercel (300 с) с
 *  запасом; проверке качества демо достаётся остаток, но не больше
 *  её собственного потолка. */
const ASSEMBLY_TICK_TOTAL_MS = 240_000;
const QUALITY_TICK_BUDGET_MS = DEMO_QUALITY_TICK_BUDGET_MS;

/**
 * Сколько раз пробовать собрать ОДНО И ТО ЖЕ содержимое, прежде чем
 * перестать (сквозной аудит 29.09.2026).
 *
 * Три, а не одна: сбой внешнего сервиса чаще случайный, чем
 * систематический, и бросать после первого промаха значило бы терять
 * ролики из-за икоты. И не десять: к третьему утру одинаковый алерт
 * уже перестают читать, а платить за него продолжают.
 */
const MAX_ASSEMBLY_ATTEMPTS = 3;
/** Сколько последних провалов пары сличать перцептивно — с запасом
 * над `MAX_ASSEMBLY_ATTEMPTS`: среди них бывают провалы другого
 * содержимого той же пары. */
const FAILED_CANDIDATES_TAKE = 20;

/** Потолок на скачивание готового ролика у внешнего сервиса. Ролик
 *  обучалки — считаные мегабайты; минуты хватает с запасом, а
 *  зависшее навсегда соединение стоит целого тика. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Ниже этого размера скачанный «ролик» роликом не является. Настоящие
 *  — сотни килобайт (0.99 и 1.24 МБ на первом боевом прогоне). */
const MIN_ASSEMBLED_VIDEO_BYTES = 1024;

/**
 * Префикс кадров-транзитов ОДНОГО актива. По id актива, а не по
 * `scenarioId`: последний общий для всех прогонов сценария, и прогоны
 * затирали кадры друг друга (аудит 27.09.2026).
 */
function scenarioFramePrefix(assetId: string): string {
  return `tutorial-video-frames/${assetId}/`;
}

/**
 * Имя кадра под префиксом актива: `{номер шага}-{тема}.png` (заход 3
 * «Актуального демо», 06.10.2026; до него — `{номер шага}.png`). Номер
 * шага первым — по нему ищется постер (`SCENARIO_FRAME_NAME_RE`).
 */
export function scenarioFrameName(
  stepIndex: number,
  theme: ScenarioTheme,
): string {
  return `${stepIndex}-${theme}.png`;
}

/** Кадр под префиксом актива — в обоих форматах имени: прежнем
 *  `{шаг}.png` (строки, собранные до тем) и `{шаг}-{тема}.png`. Не
 *  подписи (`captions.ass`). */
export const SCENARIO_FRAME_NAME_RE = /^(\d+)(?:-(?:light|dark))?\.png$/;

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
  /** Сколько сборок провалилось за этот тик. В журнале крона отдельным
   *  числом: до сквозного аудита 29.09.2026 провал сборки нигде, кроме
   *  логов функции и цветного бейджа, не проявлялся. */
  failed?: number;
  /** Проверка качества демо (06.10.2026): сколько проверок взято в
   *  работу за тик и сколько из них завершено. Нет полей — проверка
   *  выключена или модуля нет. */
  qualityProcessed?: number;
  qualityCompleted?: number;
}

/**
 * Что именно будет звучать в ролике — один из трёх исходов §3/§3-бис
 * ТЗ. Размеченное объединение, а не «url плюс карта, что-нибудь из
 * двух заполнено»: варианты А и Б взаимоисключающие, `planSlideshow`
 * отвергает план, где есть оба, и тип обязан говорить то же самое,
 * что планировщик.
 */
/**
 * Что решено про звук И про подписи разом.
 *
 * Разом, потому что решается это по одним и тем же данным (реплики
 * шагов, настройки, отметка о вычитке), но исходы РАЗНЫЕ: подписи не
 * зависят от того, удалось ли озвучить. §9 требует уметь выключить
 * их независимо, а §5 объясняет зачем — ролик смотрят без звука чаще,
 * чем со звуком, и подпись тогда единственное, что объясняет кадр.
 * Первая редакция этапа E брала текст подписи у СИНТЕЗИРОВАННОЙ
 * дорожки, и подписи не появлялись вовсе, пока озвучка выключена —
 * то есть по умолчанию не появлялись никогда.
 */
interface NarrationOutcome {
  plan: NarrationPlan;
  /**
   * Номер шага → текст подписи. Заполняется из ШАГОВ СЦЕНАРИЯ, а не
   * из дорожек: у кадра, чья дорожка не синтезировалась, подпись
   * есть — текст-то цел. Пусто, когда реплик нет или вычитка
   * требуется и не сделана: непрочитанный текст не должен попасть
   * зрителю ни в уши, ни на экран.
   */
  captionTexts: Map<number, string>;
  /**
   * Реплики были, но их не хватило на порог `MIN_NARRATED_SHARE`, и
   * ролик озвучен ЗАПАСНЫМ путём — текстом карточки шага (сквозной
   * аудит 29.09.2026).
   *
   * Исход дорогой и до этого был виден только в логах функции: админка
   * в этот момент показывает «N реплик, вычитаны», оператор под ними
   * подписался, а в ролик не попала ни одна — ни в звук (звучит другой
   * текст), ни на экран (`captionTexts` обнуляется, иначе подпись
   * разошлась бы со звуком, что §11 п.16 прямо запрещает).
   *
   * Поэтому выносится наружу и считается в журнале крона: «прошло» и
   * «прошло, но вычитанные реплики не прозвучали» — разные исходы.
   */
  narrationFallback?: true;
}

type NarrationPlan =
  | { mode: 'none' }
  | { mode: 'whole'; url: string; speechSeconds: number | null }
  | {
      mode: 'perFrame';
      /** Номер шага → дорожка и ЕЁ ТЕКСТ. Шаги без реплики сюда не
       *  попадают: их кадр получает `MIN_FRAME_SECONDS` и тишину.
       *  Текст нужен подписям (этап E) и обязан быть тем же самым,
       *  что ушёл в синтез, — иначе подпись разойдётся с речью. */
      tracks: Map<
        number,
        {
          url: string;
          seconds: number | null;
          text: string;
          /** Происхождение дорожки — в монтажный manifest (темп). */
          provider?: string;
          voiceId?: string | null;
        }
      >;
    };

@Injectable()
export class TutorialScenarioRunnerService {
  /** Провалов сборки за текущий тик опроса — для одной агрегатной
   *  тревоги вместо тревоги на строку. Обнуляется в начале
   *  `pollAssemblies`; вне его не читается. */
  private failedThisTick = 0;

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
    // Э6 помощника: ролик черновика, привязанного к сайту помощника, собран
    // — обновить набор роликов сайта (необязателен: стенды без него).
    @Optional() private readonly siteMedia?: ClientSiteMediaService,
    // Темп обучалок в постпродакшене (06.10.2026): опрос версий в этом
    // же кроне, перенос исходников при `complete`, уборка версий вместе
    // с роликом. Необязателен — стенды и тесты без модуля темпа.
    @Optional() private readonly versions?: TutorialVideoVersionsService,
    // Проверка качества демо через Gemini (06.10.2026): очередь в этом
    // же тике и под этим же замком. Необязательна — стенды и тесты без
    // модуля качества работают как раньше.
    @Optional() private readonly quality?: TutorialDemoQualityService,
    // Ш5 (12): подметальщик удалил одобренный ролик — набор роликов сайта
    // тенанта лендинга переслать (иначе мёртвая ссылка до одобрения).
    // Необязателен — стенды и тесты без sites-backend.
    @Optional() private readonly landingVideos?: LandingVideosService,
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
  /** Потолок тика — см. `tutorial-budget.ts`. */
  private openBudget(): Promise<TutorialBudget> {
    return openTutorialBudget(this.settings, this.aiUsage);
  }

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
    /** Суточный потолок тика. Синтез — самая дробная из трёх трат, и
     *  именно он обязан уметь остановиться посередине сценария. */
    budget: TutorialBudget,
    /** Отмена отправки по дедлайну (см. `runOne`): синтез — платный, и
     *  после отмены не начинается ни один. */
    signal?: AbortSignal,
  ): Promise<NarrationOutcome> {
    // Реплики читаются ПЕРВЫМИ и независимо от выключателя озвучки:
    // подписям синтез не нужен, им нужен текст.
    const requireReview = parseRequireNarrationReview(
      await this.settings
        .get(TUTORIAL_REQUIRE_NARRATION_REVIEW_KEY)
        .catch(() => null),
    );
    const perStep = this.narrationByStep(scenario, stepIndexes, requireReview);
    const captionTexts =
      perStep === 'blocked' ? new Map<number, string>() : perStep;
    const silent = (): NarrationOutcome => ({
      plan: { mode: 'none' },
      captionTexts,
    });

    try {
      const voice = parseTutorialVoiceSetting(
        await this.settings.get(TUTORIAL_VOICE_SETTING_KEY),
      );
      if (!voice.enabled) return silent();
      if (perStep === 'blocked') return silent();

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
      const narrationFallback =
        perStep.size > 0 && narratedShare < MIN_NARRATED_SHARE;
      if (narrationFallback) {
        this.logger.warn(
          `сценарий ${scenario.subjectKey} (${scenario.locale}): реплик хватает только на ${perStep.size} из ${stepIndexes.length} кадров — берём запасной путь, текст шага обучалки; вычитанные реплики в ролик не попадут`,
        );
      }
      if (perStep.size > 0 && narratedShare >= MIN_NARRATED_SHARE) {
        const tracks = new Map<
          number,
          {
            url: string;
            seconds: number | null;
            text: string;
            provider?: string;
            voiceId?: string | null;
          }
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
            // Потолок проверяется перед КАЖДОЙ дорожкой, а не раз за
            // сценарий: тридцать реплик — это тридцать трат, и
            // остановиться надо на той, которая перевалила, а не
            // после всех.
            if (budgetExhausted(budget)) {
              this.logger.warn(
                `сценарий ${scenario.subjectKey}/${scenario.locale}: суточный потолок расхода обучалки выбран — остальные реплики этой ночью не синтезируются`,
              );
              break;
            }
            if (signal?.aborted) break;
            const track = await this.voiceTrack(
              scenario,
              String(stepIndex),
              text,
              voice,
              provider,
              userId,
              budget,
            );
            if (!track) continue;
            tracks.set(stepIndex, {
              url: track.url,
              seconds: track.speechSeconds,
              text,
              provider: provider.providerKey,
              voiceId: voice.voiceId,
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
          // Подписи при этом ОСТАЮТСЯ: текст цел, не доехал звук.
          return silent();
        }
        if (tracks.size < perStep.size) {
          this.logger.warn(
            `сценарий ${scenario.subjectKey} (${scenario.locale}): синтезировано ${tracks.size} дорожек из ${perStep.size} — остальные кадры немые, следующий прогон попробует снова`,
          );
        }
        await this.reconcileVoiceCache(scenario, keep);
        return { plan: { mode: 'perFrame', tracks }, captionTexts };
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
        return silent();
      }
      if (budgetExhausted(budget)) {
        this.logger.warn(
          `сценарий ${scenario.subjectKey}/${scenario.locale}: суточный потолок расхода обучалки выбран — ролик собирается немым`,
        );
        return silent();
      }
      if (signal?.aborted) return silent();
      const track = await this.voiceTrack(
        scenario,
        VOICE_SLOT_WHOLE,
        text,
        voice,
        provider,
        userId,
        budget,
      );
      if (!track) return silent();
      await this.reconcileVoiceCache(scenario, [track.key]);
      return {
        plan: {
          mode: 'whole',
          url: track.url,
          speechSeconds: track.speechSeconds,
        },
        // Вариант А: звучит текст карточки шага обучалки, а не
        // реплики сценария. Подписывать кадры репликами, которых
        // никто не произносит, значит показать одно и озвучить
        // другое — зритель прочтёт не то, что услышит.
        captionTexts: new Map<number, string>(),
        ...(narrationFallback ? { narrationFallback: true as const } : {}),
      };
    } catch (err) {
      this.logger.warn(
        `сценарий ${scenario.subjectKey}: озвучка не получилась (${
          err instanceof Error ? err.message : String(err)
        }) — ролик соберётся немым`,
      );
      return silent();
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
    budget: TutorialBudget,
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
    // файл до Blob. Операция — своя, `tutorial-voiceover` (этап F):
    // с этапа B до этапа F синтез обучалки писался общей `voiceover`
    // и в отчёте складывался с озвучкой роликов пользователей, так что
    // «сколько стоит озвучка обучалки» было не узнать. Модель — та же
    // `{провайдер}-tts`, что у постпрода: ставка у них одна, различается
    // только вопрос, на который отвечает строка.
    budget.spentMicroUsd += estimateCost(`${provider.providerKey}-tts`, {
      characters: outcome.characters,
    }).costMicroUsd;
    await this.aiUsage.record({
      operation: 'tutorial-voiceover',
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
    /**
     * Точка отсчёта бюджета — ВХОД в обработчик, а не момент, когда
     * поднялся браузер (правка 29.09.2026).
     *
     * `RUN_DEADLINE_MS` выведен из потолка функции Vercel, и весь смысл
     * этого вывода в том, чтобы тик не был убит платформой посреди
     * работы. Но считался он от `Date.now()` ПОСЛЕ
     * `launchHeadlessBrowser()`, а до него ещё шли опрос сборок,
     * фикстурный вход и сам запуск браузера — то есть формула была
     * верна для того, что измеряла, и измеряла не то.
     *
     * Цена честного счёта названа прямо: запуск браузера переехал
     * внутрь бюджета, поэтому в медленную ночь тик сделает на один
     * сценарий меньше. Ротация `lastRunAt asc nulls first` к этому
     * готова — остаток уйдёт первым на следующий тик, — но «девять за
     * одну ночь» перестало быть гарантией и стало обычным случаем.
     */
    const tickStartedAt = Date.now();
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

    const tma = await this.runTmaScenarios(tickStartedAt);

    // Демо обучающего лендинга (путь А, решение владельца 06.10.2026) —
    // ПОСЛЕ сценариев TMA и в остаток того же бюджета: демо витрины не
    // должно отнимать тик у демо продукта (черновик, раздел 4.1 п. 6).
    // От фикстуры TMA проход не зависит и идёт, даже если проход TMA
    // пропущен. Свой `catch`: сбой витрины не должен перекрасить уже
    // записанный результат TMA.
    let polygon: PolygonPass | null = null;
    try {
      polygon = await this.runPolygonScenarios(tickStartedAt);
    } catch (err) {
      this.logger.warn(
        `демо обучающего лендинга: проход витрины не удался — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return polygon ? mergePolygonPass(tma, polygon) : tma;
  }

  /**
   * Сценарии TMA: фикстурный вход, пересев, тема «как в Telegram». Строки
   * семейства демо обучающего лендинга сюда не попадают — у них свой
   * проход (`runPolygonScenarios`) без всей этой обвязки.
   */
  private async runTmaScenarios(
    tickStartedAt: number,
  ): Promise<TutorialScenarioRunResult> {
    const telegramId = process.env.FIXTURE_TELEGRAM_ID?.trim();
    const token = process.env.FIXTURE_USER_TOKEN?.trim();
    const tmaBaseUrl = process.env.TMA_PUBLIC_URL?.trim();
    if (!telegramId || !token) {
      return this.skipLoudly(
        'no-fixture-env',
        'фикстурный вход не настроен (FIXTURE_USER_TOKEN/FIXTURE_TELEGRAM_ID, см. .env.example)',
      );
    }
    if (!tmaBaseUrl) {
      return this.skipLoudly('no-tma-url', 'TMA_PUBLIC_URL не настроен');
    }
    // Токен несём только на origin своего API (`fixture-token-page.ts`).
    // Без адреса API отличить свой запрос от чужого нечем, а слать
    // токен всем подряд — ровно та утечка, которую закрыл этап I
    // ТЗ docs-tz/TZ-Tutorial-Video-Voiced.md.
    const apiOrigin = fixtureApiOrigin();
    if (!apiOrigin) {
      return this.skipLoudly(
        'no-api-url',
        'API_PUBLIC_URL не настроен или не разбирается — без него фикстурный токен ушёл бы и сторонним сайтам',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { telegramId },
    });
    if (!user) {
      return this.skipLoudly(
        'no-fixture-user',
        `фикстурный пользователь telegramId=${telegramId} не заведён — запустите npm run seed:fixture-user`,
      );
    }

    // Только ТЕСТОВЫЙ аккаунт (аудит кронов 06.10.2026, решение
    // владельца). Ниже прогон пересевает фикстуру — `seedFixtureUser`
    // ставит `isTestUser`/`freeOutsideProject` и переписывает сессии и
    // проекты, — принимает за неё оферту и снимает её экраны в ролики.
    // До правки защита стояла только у оферты, а пересев шёл безусловно:
    // `FIXTURE_TELEGRAM_ID`, указавший на живого человека, пятнадцать
    // раз в сутки превращал его в тестовый аккаунт с бесплатной
    // генерацией, перезаписывал его сессии и тащил его данные в ролики.
    //
    // Перевод аккаунта в фикстуру — только явным действием оператора:
    // кнопка «Завести фикстуру» (`POST /admin/tutorial-runner/seed-
    // fixture-user`). Крон сам этого не делает никогда.
    if (!user.isTestUser) {
      return this.skipLoudly(
        'not-test-user',
        `аккаунт telegramId=${telegramId} из FIXTURE_TELEGRAM_ID не помечен тестовым (isTestUser) — крон работает только с фикстурой; если это и есть фикстура, заведите её кнопкой «Завести фикстуру» в админке, если живой человек — исправьте FIXTURE_TELEGRAM_ID`,
      );
    }
    // Все условия запуска выполнены — пропуск, если он был, кончился.
    await this.forgetSkipAlert();

    // Оферта фикстуры — текущей версии (просмотр роликов прода
    // 01.10.2026). `TERMS_VERSION` сменился 29.09.2026, фикстура
    // принимала прежнюю, и мастер товара с тех пор открывался экраном
    // согласия (`TermsGate`) вместо выбора референса: сценарий шага 2
    // падал каждый тик на `reference-card`, а шаги, начинающиеся с
    // чистого мастера, снимали бы в ролик чекбокс оферты. Только для
    // тестового аккаунта (`isTestUser` ставит сидирование фикстуры):
    // `FIXTURE_TELEGRAM_ID` может указывать и на живого человека, а
    // принимать документы за него исполнитель права не имеет.
    // `isTestUser` здесь уже проверен выше — целиком прогон идёт только
    // по тестовому аккаунту.
    if (user.termsVersion !== TERMS_VERSION || !user.termsAcceptedAt) {
      try {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { termsVersion: TERMS_VERSION, termsAcceptedAt: new Date() },
        });
        this.logger.log(
          `фикстура: оферта обновлена до версии ${TERMS_VERSION} (было ${user.termsVersion ?? 'ничего'})`,
        );
      } catch (err) {
        this.logger.warn(
          `фикстура: не удалось обновить версию оферты — сценарии чистого мастера упрутся в экран согласия: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
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
    const allRows = (await this.prisma.tutorialScenario.findMany({
      where: {
        locale: { in: locales },
        // Семейство демо обучающего лендинга — не сюда: его маршруты не
        // резолвятся в TMA, и прогон здесь только красил бы строки
        // провалом. По префиксу — и в запросе, и ещё раз в коде ниже.
        NOT: { subjectKey: { startsWith: SITE_TUTORIAL_DEMO_PREFIX } },
        // Правило «прошедший на тех же шагах — не чаще
        // `OK_RERUN_INTERVAL_MS`» с захода 3 решается не здесь, а в
        // `planThemedRuns` — ПО ТЕМЕ: колонка `lastRunAt` у строки одна,
        // и свежий светлый прогон отсекал бы в SQL ни разу не снятую
        // тёмную тему (см. `SCENARIO_SCAN_LIMIT`).
        AND: [{ OR: [{ costly: false }, { approved: true }] }],
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
      take: SCENARIO_SCAN_LIMIT,
    })) as ScenarioRunRow[];
    const rows = allRows.filter(
      (r) => !isSiteTutorialDemoFamilyKey(r.subjectKey),
    );
    // По-темные отметки прогонов. Сбой чтения — пустая карта: все тёмные
    // темы выглядят неснятыми и встают первыми, светлые читаются из
    // колонок строки. Лишний прогон — безопасная сторона.
    const themeRuns = parseThemeRuns(
      await this.settings.get(THEME_RUNS_SETTING_KEY).catch(() => null),
    );
    const planned = planThemedRuns(
      rows,
      themeRuns,
      Date.now(),
      OK_RERUN_INTERVAL_MS,
      RUN_BATCH_LIMIT,
    );
    const scenarios = planned.map((p) => p.scenario);
    if (planned.length === 0) {
      return {
        total: 0,
        passed: 0,
        failed: 0,
        paidClicksSkipped: 0,
        narrationFallbacks: 0,
        framesMissed: 0,
        withoutFrames: 0,
        lostRaces: 0,
        assemblyTimeouts: 0,
        repeatFailures: 0,
        outcomes: [],
      };
    }

    // Каждый тик — с чистой фикстуры (просмотр роликов 01.10.2026).
    // Сценарии кликают переключатели и одобряют промпт в СОХРАНЁННЫХ
    // сессиях фикстуры, и состояние переходило в следующий прогон:
    // ролик шага 6 говорил «включаем учёт рекомендаций», а галочка в
    // кадре через раз оказывалась снятой — прошлый прогон её уже
    // включил, этот выключил. Пересев — те же upsert'ы, что у кнопки
    // «Завести фикстуру»: десяток запросов, оплаченный ролик готового
    // поздравления он не трогает. Сбой — не повод не снимать: будет
    // прежнее состояние, как до этой правки.
    try {
      await seedFixtureUser(
        this.prisma as unknown as Parameters<typeof seedFixtureUser>[0],
        telegramId,
      );
    } catch (err) {
      this.logger.warn(
        `фикстура: пересев перед прогоном не удался, снимаем на прежнем состоянии: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const ctx = await this.resolveFixtureContext(user.id);
    // Потолок открывается ОДИН раз на тик и ведётся в памяти — см.
    // `openBudget`. Читается до запуска браузера: если он уже выбран,
    // поднимать Chromium незачем.
    const budget = await this.openBudget();
    if (budgetExhausted(budget)) {
      const reason =
        'суточный потолок расхода обучалки выбран — прогон отложен до завтра';
      this.logger.warn(reason);
      await this.notify.alert(
        'tutorial-scenario-run:budget',
        `Сценарии обучающего видео: ${reason}.`,
      );
      return this.skip(reason);
    }

    const launched = await launchHeadlessBrowser();
    if ('error' in launched) {
      this.logger.warn(`headless-браузер недоступен: ${launched.error}`);
      await this.recordInfraFailure(scenarios, launched.error);
      for (const p of planned) {
        recordThemeRun(themeRuns, p.scenario, p.theme, {
          at: new Date().toISOString(),
          status: 'failed',
          error: launched.error,
          stepsSha: p.stepsSha,
        });
      }
      await this.saveThemeRuns(themeRuns);
      await this.notify.alert(
        'tutorial-scenario-run:browser',
        `Исполнитель сценариев обучающих видео: браузер не запустился. ${launched.error}`,
      );
      return {
        total: scenarios.length,
        passed: 0,
        failed: scenarios.length,
        paidClicksSkipped: 0,
        narrationFallbacks: 0,
        framesMissed: 0,
        withoutFrames: 0,
        lostRaces: 0,
        assemblyTimeouts: 0,
        repeatFailures: 0,
        // `locale` обязателен в `TutorialScenarioRunOutcome` — и
        // именно здесь его забыли. В песочнице это не видно (типы
        // Prisma подменены заглушкой, и `scenarios` выводится как
        // `any[]`), а боевая сборка с настоящим `prisma generate`
        // упала бы на TS2322. Заодно это ровно та потеря языка в
        // журнале, ради которой поле и заводили на этапе C —
        // в ветке, где не исполнился НИ ОДИН сценарий (находка
        // сквозного аудита A+B+C).
        outcomes: planned.map(({ scenario: s, theme }) => ({
          id: s.id,
          subjectKey: s.subjectKey,
          locale: s.locale,
          theme,
          ok: false,
          error: launched.error,
        })),
      };
    }

    const { browser } = launched;
    const outcomes: TutorialScenarioRunOutcome[] = [];
    const failures: string[] = [];
    const deadline = tickStartedAt + RUN_DEADLINE_MS;
    try {
      for (const { scenario, theme, lastError, stepsSha } of planned) {
        if (Date.now() >= deadline) {
          this.logger.warn(
            `тик исчерпал бюджет времени — ${scenarios.length - outcomes.length} сценариев отложено до следующего прогона`,
          );
          break;
        }
        const outcome = await this.runOne(
          browser,
          // «Чем упал в прошлый раз» — у ЭТОЙ темы, а не у строки:
          // колонка строки помнит последний прогон любой темы, и тёмная
          // поломка иначе глушила бы тревогу о светлой (и наоборот).
          { ...scenario, lastRunError: lastError },
          ctx,
          // Владелец расхода этого прогона — фикстурный пользователь
          // (см. `synthesizeNarration`). Тянется параметром, а не
          // через `ctx`: `FixtureRouteContext` описывает МАРШРУТЫ,
          // и подмешивать в него владельца денег значит завести
          // второе назначение у одной структуры.
          user.id,
          token,
          apiOrigin,
          tmaBaseUrl,
          budget,
          theme,
        );
        outcomes.push(outcome);
        // Отметка темы — после КАЖДОГО прогона, а не в конце тика:
        // функцию могут убить на потолке, и тогда недописанные отметки
        // означали бы лишний прогон тех же тем — безопасно, но зря.
        recordThemeRun(themeRuns, scenario, theme, {
          at: new Date().toISOString(),
          status: outcome.ok ? 'ok' : 'failed',
          error: outcome.error ?? null,
          stepsSha,
        });
        await this.saveThemeRuns(themeRuns);
        if (!outcome.ok) {
          failures.push(`${scenario.subjectKey}/${scenario.locale}/${theme}`);
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
          //
          // И ещё одно условие (сквозной аудит 29.09.2026): ТА ЖЕ
          // причина, что в прошлую ночь, поимённой тревоги не даёт.
          // Собственная приёмка ТЗ объявляет устойчивое состояние
          // «шаги 3–8 падают на `waitFor` (ожидаемо)», второй боевой
          // прогон дал 7 падений из 9 — то есть канал получал бы
          // четыре красных сообщения каждую ночь навсегда, за то, что
          // никто чинить и не собирался. Фон не читают, и настоящая
          // поломка приходит в нём тем же цветом.
          //
          // «Та же причина», а не «тот же сценарий»: изменившийся
          // текст ошибки означает, что сломалось что-то ДРУГОЕ, и об
          // этом сказать надо. Счётчики при этом считают всё — в
          // журнале крона провал виден всегда.
          if (failures.length <= ALERT_DETAIL_LIMIT && !outcome.repeatFailure) {
            await this.notify.alert(
              `tutorial-scenario-run:${scenario.subjectKey}:${scenario.locale}:${theme}`,
              `Сценарий обучающего видео «${scenario.subjectKey}» (${scenario.locale}, тема ${theme}) провалился на regression-прогоне: ${outcome.error}`,
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
    // Итоговая — тоже только когда есть НОВОЕ. Прогон, у которого все
    // падения повторяют вчерашние, молчит целиком: его результат
    // виден в журнале крона числами.
    const fresh = outcomes.filter((o) => !o.ok && !o.repeatFailure).length;
    if (failures.length > ALERT_DETAIL_LIMIT && fresh > 0) {
      await this.notify.alert(
        'tutorial-scenario-run:many',
        `Сценарии обучающего видео: провалились ${failures.length} из ${outcomes.length} (новых поломок ${fresh}) — ${failures.join(', ')}. Поимённые сообщения выше только для первых ${ALERT_DETAIL_LIMIT}.`,
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
      paidClicksSkipped: outcomes.reduce(
        (sum, o) => sum + (o.paidClicksSkipped ?? 0),
        0,
      ),
      narrationFallbacks: outcomes.filter((o) => o.narrationFallback).length,
      framesMissed: outcomes.reduce((sum, o) => sum + (o.framesMissed ?? 0), 0),
      withoutFrames: outcomes.filter((o) => o.noFrames).length,
      lostRaces: outcomes.filter((o) => o.lostRace).length,
      repeatFailures: outcomes.filter((o) => o.repeatFailure).length,
      assemblyTimeouts: outcomes.filter((o) => o.assemblyTimedOut).length,
      themeMismatches: outcomes.filter((o) => o.themeMismatch).length,
      outcomes,
    };
  }

  /**
   * Проход демо обучающего лендинга — сценарии семейства
   * `site-tutorial-demo-*` на витрине `/qa/demo-shop` (путь А, решение
   * владельца 06.10.2026; правила маршрутов и шагов —
   * `polygon-scenario.ts`).
   *
   * ## Чего здесь нет — и почему
   *
   * Ни фикстурного входа, ни `initData`, ни пересева, ни Telegram
   * `themeParams`: витрина — обычная страница лендинга без пользователя.
   * Поэтому нет и проверки `isTestUser` — некого проверять. Тема — только
   * `prefers-color-scheme` (витрина красится CSS-переменными по системной
   * теме), и замер после прогона — тот же медиазапрос на странице.
   *
   * ## Что то же самое
   *
   * Вьюпорт и плотность (390×844 @2), бюджет сценария (90 с), чередование
   * тем и их отметки, отпечаток сборки, счёт провалов, озвучка, подписи,
   * подметальщик — всё общее с TMA: ролик семейства — обычная строка
   * `TutorialVideoAsset` той же пары (ключ, локаль, тема).
   *
   * ## Деньги
   *
   * Синтез и сборка пишутся в расход на владельца — тестовую фикстуру,
   * если `FIXTURE_TELEGRAM_ID` указывает на `isTestUser` (только чтение,
   * без пересева и оферты). Нет её — прогон всё равно идёт (regression
   * витрины), но платного не начинается: строка расхода без владельца
   * выбрала бы общий суточный потолок анонимных посетителей лендинга.
   *
   * `null` — проходить нечего: полигон не настроен (`LANDING_PUBLIC_URL`
   * не https), строк семейства нет, все темы свежие, бюджет выбран.
   */
  private async runPolygonScenarios(
    tickStartedAt: number,
  ): Promise<PolygonPass | null> {
    const origin = polygonOrigin();
    if (!origin) return null;
    const locales = parseTutorialLocales(
      await this.settings.get(TUTORIAL_LOCALES_SETTING_KEY),
    );
    const found = (await this.prisma.tutorialScenario.findMany({
      where: {
        locale: { in: locales },
        // Точный список слотов, а не префикс: снимаем только то, что
        // справка умеет выдать.
        subjectKey: { in: [...SITE_TUTORIAL_DEMO_KEYS] },
        AND: [{ OR: [{ costly: false }, { approved: true }] }],
      },
      orderBy: [
        { lastRunAt: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'asc' },
      ],
      take: SCENARIO_SCAN_LIMIT,
    })) as ScenarioRunRow[];
    // Ещё раз в коде: строка чужой темы не должна поехать на витрину
    // даже при сбое `where`.
    const rows = found.filter((r) => isSiteTutorialDemoKey(r.subjectKey));
    if (rows.length === 0) return null;
    const themeRuns = parseThemeRuns(
      await this.settings.get(THEME_RUNS_SETTING_KEY).catch(() => null),
    );
    const planned = planThemedRuns(
      rows,
      themeRuns,
      Date.now(),
      OK_RERUN_INTERVAL_MS,
      RUN_BATCH_LIMIT,
    );
    if (planned.length === 0) return null;
    const deadline = tickStartedAt + RUN_DEADLINE_MS;
    if (Date.now() >= deadline) {
      this.logger.warn(
        `демо обучающего лендинга: бюджет тика выбран сценариями TMA — ${planned.length} прогонов витрины отложено до следующего тика`,
      );
      return null;
    }
    const budget = await this.openBudget();
    if (budgetExhausted(budget)) {
      this.logger.warn(
        'демо обучающего лендинга: суточный потолок расхода обучалки выбран — проход витрины отложен до завтра',
      );
      return null;
    }
    const ownerId = await this.polygonSpendOwner();

    const summary: PolygonPassSummary = {
      origin,
      total: planned.length,
      executed: 0,
      passed: 0,
      failed: 0,
      assemblyWithoutOwner: 0,
    };
    const scenarios = planned.map((p) => p.scenario);
    const launched = await launchHeadlessBrowser();
    if ('error' in launched) {
      this.logger.warn(
        `демо обучающего лендинга: headless-браузер недоступен: ${launched.error}`,
      );
      await this.recordInfraFailure(scenarios, launched.error);
      for (const p of planned) {
        recordThemeRun(themeRuns, p.scenario, p.theme, {
          at: new Date().toISOString(),
          status: 'failed',
          error: launched.error,
          stepsSha: p.stepsSha,
        });
      }
      await this.saveThemeRuns(themeRuns);
      await this.notify.alert(
        'tutorial-scenario-run:polygon-browser',
        `Демо обучающего лендинга: браузер не запустился. ${launched.error}`,
      );
      summary.failed = planned.length;
      return {
        summary,
        result: {
          ...this.emptyRunResult(),
          total: planned.length,
          failed: planned.length,
          outcomes: planned.map(({ scenario: s, theme }) => ({
            id: s.id,
            subjectKey: s.subjectKey,
            locale: s.locale,
            theme,
            ok: false,
            error: launched.error,
          })),
        },
      };
    }

    const { browser } = launched;
    const outcomes: TutorialScenarioRunOutcome[] = [];
    const failures: string[] = [];
    try {
      for (const { scenario, theme, lastError, stepsSha } of planned) {
        if (Date.now() >= deadline) {
          this.logger.warn(
            `демо обучающего лендинга: тик исчерпал бюджет — ${planned.length - outcomes.length} прогонов витрины отложено`,
          );
          break;
        }
        const outcome = await this.runPolygonOne(
          browser,
          { ...scenario, lastRunError: lastError },
          origin,
          ownerId,
          budget,
          theme,
        );
        outcomes.push(outcome);
        recordThemeRun(themeRuns, scenario, theme, {
          at: new Date().toISOString(),
          status: outcome.ok ? 'ok' : 'failed',
          error: outcome.error ?? null,
          stepsSha,
        });
        await this.saveThemeRuns(themeRuns);
        if (!outcome.ok) {
          failures.push(`${scenario.subjectKey}/${scenario.locale}/${theme}`);
          if (failures.length <= ALERT_DETAIL_LIMIT && !outcome.repeatFailure) {
            await this.notify.alert(
              `tutorial-scenario-run:${scenario.subjectKey}:${scenario.locale}:${theme}`,
              `Демо обучающего лендинга «${scenario.subjectKey}» (${scenario.locale}, тема ${theme}) провалилось на витрине: ${outcome.error}`,
            );
          }
        }
      }
    } finally {
      await browser.close().catch(() => undefined);
    }

    summary.executed = outcomes.length;
    summary.passed = outcomes.filter((o) => o.ok).length;
    summary.failed = outcomes.filter((o) => !o.ok).length;
    summary.assemblyWithoutOwner = outcomes.filter(
      (o) => o.assemblySkipped === 'no-spend-owner',
    ).length;
    return {
      summary,
      result: {
        ...this.emptyRunResult(),
        total: planned.length,
        executed: outcomes.length,
        passed: summary.passed,
        failed: summary.failed,
        narrationFallbacks: outcomes.filter((o) => o.narrationFallback).length,
        framesMissed: outcomes.reduce((n, o) => n + (o.framesMissed ?? 0), 0),
        withoutFrames: outcomes.filter((o) => o.noFrames).length,
        lostRaces: outcomes.filter((o) => o.lostRace).length,
        repeatFailures: outcomes.filter((o) => o.repeatFailure).length,
        assemblyTimeouts: outcomes.filter((o) => o.assemblyTimedOut).length,
        themeMismatches: outcomes.filter((o) => o.themeMismatch).length,
        outcomes,
      },
    };
  }

  /** Нулевой результат прогона — основа для прохода витрины. */
  private emptyRunResult(): TutorialScenarioRunResult {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      paidClicksSkipped: 0,
      narrationFallbacks: 0,
      framesMissed: 0,
      withoutFrames: 0,
      lostRaces: 0,
      assemblyTimeouts: 0,
      repeatFailures: 0,
      outcomes: [],
    };
  }

  /**
   * Владелец расхода прохода витрины — тестовая фикстура, если она есть.
   * Только ЧТЕНИЕ: ни пересева, ни оферты, ни проверки состояния
   * фикстуры для съёмки — витрине она не нужна, она нужна журналу
   * расходов. Не тестовый аккаунт или его нет — `null`, и ролики витрины
   * не собираются (см. `runPolygonScenarios`).
   */
  private async polygonSpendOwner(): Promise<string | null> {
    const telegramId = process.env.FIXTURE_TELEGRAM_ID?.trim();
    if (!telegramId) return null;
    try {
      const user = (await this.prisma.user.findUnique({
        where: { telegramId },
      })) as { id: string; isTestUser?: boolean } | null;
      return user?.isTestUser ? user.id : null;
    } catch {
      return null;
    }
  }

  /** Один прогон сценария витрины в одной теме. Никогда не бросает. */
  private async runPolygonOne(
    browser: import('puppeteer-core').Browser,
    scenario: {
      id: string;
      subjectKey: string;
      locale: string;
      steps: unknown;
      narrationReviewedAt?: Date | null;
      lastRunError?: string | null;
    },
    origin: string,
    ownerId: string | null,
    budget: TutorialBudget,
    theme: ScenarioTheme,
  ): Promise<TutorialScenarioRunOutcome> {
    let page: import('puppeteer-core').Page | undefined;
    try {
      // Шаги — ещё раз через правила витрины, теперь перед браузером:
      // строку могли поправить в базе мимо сида и ручной правки, а
      // исполняется она здесь каждую ночь.
      const checked = validatePolygonScenarioSteps(
        scenario.steps,
        scenario.subjectKey,
      );
      if (!checked.ok) {
        throw new Error(
          `шаги не проходят правила витрины: ${checked.reason ?? 'не разобрались'}`,
        );
      }
      page = await browser.newPage();
      // Тот же телефонный кадр, что у роликов TMA: формат ролика один.
      await page.setViewport({
        ...CAPTURE_VIEWPORT,
        deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
      });
      // Тема — только системная (`prefers-color-scheme`): у витрины нет
      // ни SDK Telegram, ни явного выбора темы.
      const emulateMedia = (
        page as unknown as {
          emulateMediaFeatures?: (
            f: { name: string; value: string }[],
          ) => Promise<void>;
        }
      ).emulateMediaFeatures;
      if (typeof emulateMedia === 'function') {
        await emulateMedia.call(page, [
          { name: 'prefers-color-scheme', value: theme },
        ]);
      }
      const result = await withTimeout(
        runScenario(
          withPolygonReadyWait(page as unknown as ScenarioPage),
          checked.steps,
          (routeName: string) =>
            resolvePolygonRoute(routeName, origin, scenario.locale),
          undefined,
          true,
        ),
        SCENARIO_TIMEOUT_MS,
        `сценарий не уложился в ${Math.round(SCENARIO_TIMEOUT_MS / 1000)}с`,
      );
      // Версия витрины — если лендинг кладёт `<meta name="app-build">`;
      // с приставкой, чтобы её нельзя было спутать с версией TMA в
      // сводках «устаревших» роликов.
      const build = await readCaptureBuild(page);
      const capture = {
        capturedAt: new Date(),
        captureBuild: build
          ? `landing:${build}`.slice(0, CAPTURE_BUILD_MAX_LENGTH)
          : null,
      };
      const themeVia = polygonThemeVia(
        theme,
        await readPolygonColorScheme(page),
      );
      // Страница ушла с полигона (ссылка на витрине, редирект) — кадры
      // сняты не с нашего сайта, ролика быть не должно.
      const landed = pageOrigin(page);
      const forcedError =
        result.ok && landed !== null && landed !== origin
          ? `страница ушла с полигона на ${landed} — кадры не с нашего сайта, ролик не собирается`
          : undefined;
      return await this.finishScenarioRun(scenario, result, {
        capture,
        themeVia,
        theme,
        budget,
        userId: ownerId,
        forcedError,
      });
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
        theme,
        ok: false,
        error,
        ...(clipRunError(error) === clipRunError(scenario.lastRunError)
          ? { repeatFailure: true as const }
          : {}),
      };
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  /** Записать карту по-темных отметок. Не бросает: без записи худшее —
   *  та же тема снимется ещё раз на следующем тике. */
  private async saveThemeRuns(runs: ThemeRuns): Promise<void> {
    try {
      await this.settings.set(
        THEME_RUNS_SETTING_KEY,
        serializeThemeRuns(runs, Date.now()),
      );
    } catch (e) {
      this.logger.warn(
        `отметки тем прогонов не записаны: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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
      /** Чем этот сценарий упал В ПРОШЛЫЙ раз. Нужен не прогону, а
       *  тревогам: повтор той же поломки не должен красить канал
       *  каждую ночь (сквозной аудит 29.09.2026). */
      lastRunError?: string | null;
    },
    ctx: FixtureRouteContext,
    /** Фикстурный пользователь — владелец расхода прогона. */
    userId: string,
    token: string,
    /** Origin API — единственный адресат токена (этап I ТЗ на озвученную обучалку). */
    apiOrigin: string,
    tmaBaseUrl: string,
    /** Суточный денежный потолок тика — один на все сценарии прогона. */
    budget: TutorialBudget,
    /**
     * Тема съёмки (заход 3 «Актуального демо»). По умолчанию светлая —
     * прежнее поведение для вызова без темы.
     *
     * ## Как ставится и что это подтверждает
     *
     * Как внутри Telegram: явный выбор человека (`v4c_theme`) из
     * хранилища УБИРАЕТСЯ, а SDK Telegram (`telegram-web-app.js`,
     * подключён в `index.html` фронтенда) находит в `sessionStorage`
     * параметры темы клиента — ровно те ключи, куда он сам кладёт
     * параметры запуска (`__telegram__initParams`/`__telegram__themeParams`).
     * Из `bg_color` SDK выводит `WebApp.colorScheme`, и фронтенд красится
     * своей ветвью «внутри Telegram» (`applyTheme()`: нет явного выбора —
     * следуем `colorScheme`). Запасной путь — `prefers-color-scheme`
     * нужной темы: если SDK не загрузился (сеть до telegram.org), фронтенд
     * возьмёт тему из системной. После прогона тема ЗАМЕРЯЕТСЯ на
     * странице (`themeVia`), и кадры не той темы в ролик не идут.
     *
     * Подтверждает: ветвь темы «как в Telegram» — SDK, `colorScheme`,
     * `applyTheme()` и вся тёмная/светлая вёрстка при ней; телефонный
     * вьюпорт и плотность.
     *
     * НЕ подтверждает (мобильный вьюпорт сам по себе — не Telegram):
     * настоящий WebView клиента (iOS WKWebView / Android WebView / tdesktop
     * — здесь headless Chromium), подпись `initData` (вход — фикстурным
     * токеном, `initData` пуст, и ветви, зависящие от него, идут как в
     * браузере), шапку и фон клиента (`setHeaderColor`/`setBackgroundColor`
     * уходят в никуда), живую смену темы (`themeChanged`), safe-area,
     * клавиатуру, `viewportChanged`, `openLink`/`openInvoice` и прочие
     * методы моста, которым нужен сам клиент.
     */
    theme: ScenarioTheme = 'light',
  ): Promise<TutorialScenarioRunOutcome> {
    const steps = scenario.steps as unknown as ScenarioStep[];

    // Какую сессию держать в `localStorage` до первой загрузки SPA.
    //
    // Решается ДО открытия браузера и на весь сценарий: подсев
    // работает через `evaluateOnNewDocument`, то есть на каждый
    // документ, а не на отдельный `goto`. Поэтому сценарий, зовущий и
    // чистый мастер, и мастер на готовой сессии, не запускается вовсе:
    // иначе второй `goto` молча получил бы не тот экран, и падение
    // случилось бы на шаге, который ни в чём не виноват.
    const gotoRoutes = steps
      .filter(
        (step): step is Extract<ScenarioStep, { kind: 'goto' }> =>
          step.kind === 'goto',
      )
      .map((step) => step.route);
    // Какие подсеянные маршруты просит сценарий — МНОЖЕСТВО, а не
    // «есть ли хоть один»: маршрутов с подсевом стало три
    // (29.09.2026), а ключ в `localStorage` один. Два разных в одном
    // сценарии — это молча не тот экран на втором goto, а не падение.
    const seededFields = [
      ...new Set(
        gotoRoutes
          .map((route) => SEEDED_SESSION_ROUTES.get(route))
          .filter((f): f is NonNullable<typeof f> => !!f),
      ),
    ];
    const wantsSeededSession = seededFields.length > 0;
    const mixesWizardRoutes =
      (wantsSeededSession && gotoRoutes.includes(FRESH_WIZARD_ROUTE)) ||
      seededFields.length > 1;
    const seededSessionId = wantsSeededSession
      ? (ctx[seededFields[0]] ?? '')
      : '';

    let page: import('puppeteer-core').Page | undefined;
    try {
      // Брошено внутри `try` намеренно: ниже уже есть `catch`, который
      // пишет причину в `lastRunError` и возвращает исход нужной формы.
      // Отдельная ветка выхода до него дублировала бы эту запись — и
      // однажды разошлась бы с ней.
      if (mixesWizardRoutes) {
        throw new Error(
          seededFields.length > 1
            ? `сценарий смешивает несколько маршрутов с подсевом сессии (${seededFields.join(', ')}) — ключ localStorage один, и второй goto открыл бы ПЕРВУЮ сессию, то есть снял бы не тот экран; разделите на два сценария`
            : `сценарий смешивает "${FRESH_WIZARD_ROUTE}" и маршрут на готовой сессии — подсев сессии действует на весь прогон, и чистый мастер после него чистым уже не будет; разделите на два сценария`,
        );
      }
      page = await browser.newPage();
      // Телефонный вьюпорт — ДО загрузки SPA (этап H, находка аудита).
      // Без него puppeteer открывает страницу 800×600: кадр ролика
      // выходил полосой посреди портретного холста, интерфейс — в
      // настольной вёрстке, а координаты клика привязывать было не к
      // чему. Плотность 2 — чтобы 390 CSS-пикселей дали 780 пикселей
      // снимка и холст в 720 брал их с запасом, а не растягивал.
      await page.setViewport({
        ...CAPTURE_VIEWPORT,
        deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
      });
      // Фикстурный вход (§3.3 ТЗ): `TelegramIdentityMiddleware` видит
      // `X-Fixture-Token` на каждом XHR SPA так же, как видел бы
      // `X-Telegram-Init-Data` внутри Telegram, — фронтенду правка не
      // нужна. До этапа I заголовок ставился `setExtraHTTPHeaders` и
      // уходил со ВСЕМИ запросами страницы, включая Google Fonts и
      // telegram.org; теперь — только на origin API.
      await attachFixtureToken(
        page as unknown as FixtureTokenPage,
        token,
        apiOrigin,
      );

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
      // Тема — НЕ этим ключом с захода 3: явный выбор человека
      // перебил бы тему Telegram, и съёмка шла бы мимо ветви «внутри
      // Telegram». Ключ темы здесь УДАЛЯЕТСЯ (страница могла остаться
      // от прошлого прогона), а тема приходит через SDK Telegram —
      // см. второй подсев ниже и доккомментарий параметра `theme`.
      // Тема по-прежнему не зависит от системной у машины прогона:
      // `prefers-color-scheme` выставлен той же темы.
      //
      // Тем же способом подсевается и СЕССИЯ мастера (находка второго
      // боевого прогона 29.09.2026, маршрут `generate-ready`): у
      // мастера нет URL с идентификатором сессии, вернуться к ней
      // умеет только `localStorage.sessionId` — ровно так возвращается
      // и человек, открывший приложение назавтра. Пустая строка здесь
      // означает «чистый мастер», и ключ тогда УДАЛЯЕТСЯ, а не
      // пропускается: страница могла остаться от предыдущего сценария,
      // и молча унаследованная сессия была бы хуже отсутствия подсева —
      // экран открылся бы не тот, а причина не назвалась бы нигде.
      await page.evaluateOnNewDocument(
        (
          locale: string,
          localeKey: string,
          themeKey: string,
          sessionId: string,
          sessionKey: string,
        ) => {
          try {
            window.localStorage.setItem(localeKey, locale);
            window.localStorage.removeItem(themeKey);
            if (sessionId) {
              window.localStorage.setItem(sessionKey, sessionId);
            } else {
              window.localStorage.removeItem(sessionKey);
            }
          } catch {
            // хранилище недоступно — SPA откроется в умолчаниях, и
            // сценарий чужой локали честно упадёт на `assertText`.
            // Ронять из-за этого весь прогон нечего.
          }
        },
        scenario.locale,
        SPA_LOCALE_STORAGE_KEY,
        SPA_THEME_STORAGE_KEY,
        seededSessionId,
        SPA_SESSION_STORAGE_KEY,
      );

      // Тема «как внутри Telegram» — отдельным подсевом и в своём
      // `try`: `sessionStorage` бывает недоступен там, где
      // `localStorage` есть, и сбой здесь не должен отменять локаль и
      // сессию выше. Параметры кладутся ДО загрузки SDK — он читает их
      // при подключении скрипта.
      await page.evaluateOnNewDocument(
        (
          params: Record<string, string>,
          initKey: string,
          themeParamsKey: string,
        ) => {
          try {
            const raw = window.sessionStorage.getItem(initKey);
            const init = (raw ? JSON.parse(raw) : {}) as Record<
              string,
              unknown
            >;
            init.tgWebAppThemeParams = JSON.stringify(params);
            window.sessionStorage.setItem(initKey, JSON.stringify(init));
            window.sessionStorage.setItem(
              themeParamsKey,
              JSON.stringify(params),
            );
          } catch {
            // Нет `sessionStorage` — останется `prefers-color-scheme`
            // ниже, а замер после прогона скажет, какой путь сработал.
          }
        },
        { ...TELEGRAM_THEME_PARAMS[theme] },
        TELEGRAM_SDK_INIT_PARAMS_KEY,
        TELEGRAM_SDK_THEME_PARAMS_KEY,
      );
      // Запасной путь — системная тема страницы той же темы. Метода у
      // поддельной страницы может не быть — тогда без него.
      const emulateMedia = (
        page as unknown as {
          emulateMediaFeatures?: (
            f: { name: string; value: string }[],
          ) => Promise<void>;
        }
      ).emulateMediaFeatures;
      if (typeof emulateMedia === 'function') {
        await emulateMedia.call(page, [
          { name: 'prefers-color-scheme', value: theme },
        ]);
      }

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
      // Метаданные съёмки для строки ролика (заход 1 метаданных,
      // 06.10.2026): когда сняты кадры и какой сборкой фронтенда.
      // Версию читаем на ещё открытой странице — после `finally` её
      // уже нет.
      const capture = {
        capturedAt: new Date(),
        captureBuild: await readCaptureBuild(page),
      };
      // Какой темой на деле нарисованы кадры — тоже на открытой
      // странице. `null` — замерить не удалось: решения нет, ролик
      // собирается как прежде (замер — страховка, не условие).
      const themeVia = captureThemeVia(theme, await readCaptureTheme(page));
      return await this.finishScenarioRun(scenario, result, {
        capture,
        themeVia,
        theme,
        budget,
        userId,
      });
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
        theme,
        ok: false,
        error,
      };
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  /**
   * Всё, что происходит ПОСЛЕ шагов сценария: журнал пропавших кадров,
   * запись regression-результата в строку, сборка ролика и исход для
   * журнала крона. Общее у TMA (`runOne`) и витрины демо обучающего
   * лендинга (`runPolygonOne`) — два пути съёмки, одна сборка: тот же
   * отпечаток, озвучка, подписи и счёт провалов по паре с темой.
   *
   * Бросает только то, что бросает запись в базу, — вызывающий ловит
   * это своим `catch` и пишет провал прогона.
   */
  private async finishScenarioRun(
    scenario: {
      id: string;
      subjectKey: string;
      locale: string;
      steps: unknown;
      narrationReviewedAt?: Date | null;
      lastRunError?: string | null;
    },
    result: Awaited<ReturnType<typeof runScenario>>,
    opts: {
      capture: { capturedAt: Date; captureBuild: string | null };
      themeVia: CaptureThemeVia | null;
      theme: ScenarioTheme;
      budget: TutorialBudget;
      /** Владелец расхода; `null` — ролик не собирается (см. выше). */
      userId: string | null;
      /** Провал, найденный после шагов (страница ушла с полигона). */
      forcedError?: string;
    },
  ): Promise<TutorialScenarioRunOutcome> {
    const { capture, themeVia, theme, budget, userId } = opts;
    if (themeVia === 'mismatch') {
      this.logger.warn(
        `сценарий ${scenario.subjectKey} (${scenario.locale}): заказана тема ${theme}, а страница нарисована другой — ролик не собирается`,
      );
    }

    // Кадр не снялся — прогон прошёл, а ролик будет короче
    // сценария. В журнал поимённо: это единственный след частичного
    // успеха, и до сквозного аудита 29.09.2026 его не было вовсе.
    for (const miss of result.skippedFrames) {
      this.logger.warn(
        `сценарий ${scenario.subjectKey} (${scenario.locale}): кадр шага ${miss.stepIndex + 1} не снялся (${miss.error}) — в ролике его не будет`,
      );
    }

    const failedStep = result.steps.find((s) => !s.ok);
    // Провал, найденный ПОСЛЕ шагов (страница ушла с полигона), важнее
    // зелёных шагов: кадры такого прогона снимали не наш сайт.
    const error =
      opts.forcedError ??
      (failedStep
        ? `шаг ${failedStep.index + 1} (${failedStep.step.kind}): ${failedStep.error}`
        : undefined);
    const ok = result.ok && !opts.forcedError;

    await this.prisma.tutorialScenario.update({
      where: { id: scenario.id },
      data: {
        lastRunAt: new Date(),
        lastRunStatus: ok ? 'ok' : 'failed',
        lastRunError: error ?? null,
      },
    });

    // Видео — необязательный побочный продукт успешного прогона
    // (см. доккомментарий модуля): best-effort, никогда не бросает и
    // не меняет уже записанный regression-результат выше.
    const assemblyNotes: {
      narrationFallback?: true;
      noFrames?: true;
      lostRace?: true;
      assemblyTimedOut?: true;
    } = {};
    // Владельца расхода нет (демо витрины без тестовой фикстуры, см.
    // `polygonSpendOwner`) — платного не начинаем вовсе: строка расхода
    // без владельца выбрала бы общий потолок анонимных посетителей.
    // Regression-результат при этом записан выше.
    const noSpendOwner = ok && themeVia !== 'mismatch' && userId === null;
    if (noSpendOwner) {
      this.logger.warn(
        `сценарий ${scenario.subjectKey} (${scenario.locale}, ${theme}): прошёл, но владельца расхода нет (FIXTURE_TELEGRAM_ID не указывает на тестовый аккаунт) — ролик не собирается`,
      );
    }
    if (ok && themeVia !== 'mismatch' && userId !== null) {
      // Дедлайн — снаружи метода, а не внутри: обрывать надо всю
      // отправку целиком, а не каждый её вызов по отдельности.
      // Десять заливок по пять секунд укладываются в любой
      // повызовный таймаут и всё равно уводят тик за потолок.
      //
      // `catch` обязателен и не является проглатыванием ошибки:
      // метод объявлен best-effort и сам не бросает, а брошенное
      // ЗДЕСЬ — это только наш собственный таймаут. Дать ему уйти
      // выше значило бы перекрасить уже записанный успешный
      // regression-результат в провал из-за необязательного
      // побочного продукта.
      //
      // И сигнал отмены ВНУТРЬ (аудит кронов 06.10.2026): `withTimeout`
      // только перестаёт ждать, а сама отправка продолжалась в фоне —
      // синтез, заливки и ОПЛАЧЕННЫЙ `ffmpeg.submit` уже после того,
      // как тик объявил «ролика не будет». Теперь метод проверяет
      // сигнал перед каждой заливкой, синтезом и submit и по отмене
      // закрывает строку `failed` с инфраструктурной причиной, не
      // отправляя задачу. Уже начатый вызов сигнал не прерывает — он
      // доходит, и следующий шаг не начинается.
      const abort = new AbortController();
      await withTimeout(
        this.submitVideoAssembly(
          scenario,
          result.frames,
          budget,
          userId,
          assemblyNotes,
          capture,
          abort.signal,
          theme,
        ),
        ASSEMBLY_SUBMIT_TIMEOUT_MS,
        `сборка не уложилась в ${Math.round(ASSEMBLY_SUBMIT_TIMEOUT_MS / 1000)}с`,
      ).catch((e: unknown) => {
        abort.abort();
        assemblyNotes.assemblyTimedOut = true;
        this.logger.warn(
          `сценарий ${scenario.subjectKey} (${scenario.locale}): отправка сборки оборвана по времени (${e instanceof Error ? e.message : String(e)}) — прогон засчитан, ролика не будет`,
        );
      });
    }

    return {
      id: scenario.id,
      subjectKey: scenario.subjectKey,
      locale: scenario.locale,
      theme,
      ok,
      error,
      ...(noSpendOwner ? { assemblySkipped: 'no-spend-owner' as const } : {}),
      ...(themeVia && themeVia !== 'mismatch' ? { themeVia } : {}),
      ...(themeVia === 'mismatch' ? { themeMismatch: true as const } : {}),
      ...(result.skippedPaidClicks.length > 0
        ? { paidClicksSkipped: result.skippedPaidClicks.length }
        : {}),
      ...(assemblyNotes.narrationFallback
        ? { narrationFallback: true as const }
        : {}),
      ...(result.skippedFrames.length > 0
        ? { framesMissed: result.skippedFrames.length }
        : {}),
      ...(assemblyNotes.noFrames ? { noFrames: true as const } : {}),
      ...(assemblyNotes.lostRace ? { lostRace: true as const } : {}),
      ...(assemblyNotes.assemblyTimedOut
        ? { assemblyTimedOut: true as const }
        : {}),
      // Та же причина, что в прошлую ночь — значит поломка
      // известная, и поимённая тревога о ней уже была. Сличение —
      // обрезанных текстов: в карте тем ошибка хранится обрезанной.
      ...(error && clipRunError(error) === clipRunError(scenario.lastRunError)
        ? { repeatFailure: true as const }
        : {}),
    };
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
    const [
      project,
      clientSiteProject,
      greetingProjects,
      item,
      manifest,
      session,
      promptPending,
      readyToRender,
    ] = await Promise.all([
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
      /*
       * Проекты-поздравления — ВСЕ, вместе с последней сессией каждого.
       *
       * Не три запроса «проект в таком-то состоянии»: состояние экрана
       * задаёт ПОСЛЕДНЯЯ сессия проекта (мастер читает `sessions[0]`),
       * и запрос «есть сессия со статусом X» отвечал бы на другой
       * вопрос — «была когда-нибудь». Для фикстуры с одной сессией на
       * проект разницы нет, для проекта, созданного оператором руками,
       * есть, и молчаливая: сценарий открыл бы экран не того состояния
       * и ждал бы элемент, которого там нет.
       */
      this.prisma.project.findMany({
        where: {
          userId,
          deletedAt: null,
          type: ProjectType.GREETING_VIDEO,
        },
        orderBy: { createdAt: 'desc' },
        include: {
          sessions: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 1,
            // `generationStatus` — ради четвёртого состояния, «ролик
            // готов» (этап I ТЗ Greeting 2.0): рендер поздравления
            // `status` сессии не двигает, готовность видна только здесь.
            select: { status: true, generationStatus: true },
          },
        },
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
      /*
       * Сессия — только с ГОТОВЫМ роликом, а не «самая свежая»
       * (находка сквозного аудита 29.09.2026).
       *
       * У фикстурного пользователя сессий несколько, и штатно самая
       * свежая из них — НЕ та, что нужна. `ui-snapshot-runner`
       * держит служебную сессию (`data.qaFixture`, статус `created`,
       * без ролика), чтобы обход мастера не плодил пустые строки
       * каждый тик; её `createdAt` новее фикстурной. Плюс
       * каждый сценарий, идущий на ЧИСТЫЙ мастер, заводит ещё одну
       * пустую сессию — таков сам мастер.
       *
       * Отбор «по свежести» поэтому отдавал пустую сессию обоим
       * потребителям: `generate-ready` подсевал её в `localStorage`,
       * мастер честно её восстанавливал и открывался на первом шаге
       * — то есть правка второго боевого прогона (§11-сексиес) на
       * проде не работала вовсе, а выглядела сделанной. То же и с
       * `postprod-video`: экран открывался у сессии без ролика.
       *
       * `generationStatus: COMPLETE` — признак по СОДЕРЖАНИЮ, а не
       * фиксированный id из `seed-fixture-user.ts`: резолвер должен
       * работать и для фикстуры, донастроенной руками (тот же довод,
       * что у остальных полей этого метода). Служебная сессия обхода
       * под него не попадает по построению — у неё статус `created`.
       */
      this.prisma.session.findFirst({
        where: {
          userId,
          deletedAt: null,
          generationStatus: GenerationStatus.COMPLETE,
          project: { type: { in: AD_TYPES } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      /*
       * Сессия ДО промпта и сессия ПЕРЕД рендером — разбор
       * достижимости хуков 29.09.2026.
       *
       * Отбор по `status`, а не по `generationStatus`: вторая
       * колонка ведёт статус РЕНДЕРА, а состояние мастера живёт в
       * `status` — по нему же его читает `stepFromSession` во
       * фронтенде. Признак по СОДЕРЖАНИЮ, а не фиксированный id из
       * `fixture-seed.ts`, по тому же доводу, что у сессии выше:
       * резолвер обязан работать и для фикстуры, донастроенной
       * руками.
       *
       * `generationStatus: null` у третьей — существенно, а не для
       * полноты: карточку запуска рендера прячет ЛЮБОЙ готовый
       * ролик, и сессия с рендером в любом состоянии, кроме «его
       * нет», показала бы ровно тот же пустой экран, ради ухода от
       * которого она и заводится.
       *
       * ## `project.type` — и вот почему он тут появился
       *
       * Шестой боевой прогон 29.09.2026: `7/ru` упал на
       * `aspect-ratio-picker`. Победителем запроса «одобренный промпт,
       * рендера нет» оказалась `fixture-tutorial-greeting-ready-session`
       * — сессия ПОЗДРАВЛЕНИЯ, заведённая в тот же день пятью часами
       * позже фикстурной рекламной. Признак по содержанию описывал её
       * так же верно: промпт собран, ролика нет. Мастер товарки честно
       * восстановил чужую сессию, и формы запуска рендера на экране,
       * разумеется, не оказалось.
       *
       * Урок шире этих трёх строк: **«признак по содержанию»
       * перестаёт различать ровно в тот день, когда в данных
       * появляется новый ВИД сущности.** Довод в пользу содержания
       * (резолвер работает и для фикстуры, донастроенной руками) не
       * отменяется — добавляется рамка: искать внутри рекламных
       * проектов, как этажом выше уже ищется товар. Отбор по
       * фиксированному id прошёл бы этот прогон и не пережил бы
       * ручную донастройку; рамка переживает оба.
       *
       * Сессии без проекта под рамку не попадают намеренно: у
       * анонимной нет ни товара, ни разбора, ни промпта, и ни один
       * из трёх экранов на ней не собрался бы.
       */
      this.prisma.session.findFirst({
        where: {
          userId,
          deletedAt: null,
          status: SessionStatus.PRODUCT_INFO_ADDED,
          project: { type: { in: AD_TYPES } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.session.findFirst({
        where: {
          userId,
          deletedAt: null,
          status: SessionStatus.PROMPT_GENERATED,
          generationStatus: null,
          project: { type: { in: AD_TYPES } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      projectId: project?.id,
      itemId: item?.id,
      manifestId: manifest?.id,
      sessionId: session?.id,
      promptPendingSessionId: promptPending?.id,
      readyToRenderSessionId: readyToRender?.id,
      clientSiteProjectId: clientSiteProject?.id,
      ...greetingContext(greetingProjects),
    };
  }

  /**
   * Прогон не состоялся целиком — и об этом ОБЯЗАТЕЛЬНО узнаёт человек
   * (сквозной аудит 29.09.2026).
   *
   * До правки все четыре причины пропуска (нет фикстурного входа, нет
   * `TMA_PUBLIC_URL`, нет `API_PUBLIC_URL`, фикстурный пользователь не
   * заведён) писали только `logger.warn`. Асимметрия была ровно в
   * опасную сторону: провал ЗАПУСКА БРАУЗЕРА тревогу слал, а «не за
   * что было браться» — нет, хотя второе и чаще, и тише.
   *
   * Тише потому, что при пропуске НЕ ТРОГАЕТСЯ ни одна строка
   * `TutorialScenario`: `lastRunAt`/`lastRunStatus` остаются от
   * последней удачной ночи, и витрина сценариев показывает зелёное
   * «ok» недельной давности. То есть «не запускалось» неотличимо от
   * «прошло» — на той самой витрине, ради которой регресс-раннер и
   * существует. `API_PUBLIC_URL` при этом требование этапа I,
   * добавленное последним: забыть его при выкате легче всего.
   *
   * Ключ дедупликации — без причины: разные причины одного и того же
   * («прогона не было») не должны давать четыре разных сообщения.
   *
   * И одна тревога на ВИД причины, а не на тик (аудит кронов
   * 06.10.2026): см. `RUN_SKIP_ALERT_SETTING_KEY`. Каждый пропуск
   * по-прежнему виден в журнале крона — исходом SKIPPED.
   */
  private async skipLoudly(
    /** Вид причины — стабильный ключ, без переменных частей текста. */
    kind: string,
    reason: string,
  ): Promise<TutorialScenarioRunResult> {
    this.logger.warn(reason);
    const alerted = await this.settings
      .get(RUN_SKIP_ALERT_SETTING_KEY)
      .catch(() => null);
    if (alerted === kind) return this.skip(reason);
    await this.notify.alert(
      'tutorial-scenario-run:skipped',
      `Сценарии обучающего видео: прогон не состоялся — ${reason}. Витрина сценариев показывает результат ПРОШЛОГО прогона, не сегодняшнего. Пока причина та же, следующие пропуски тревог не дают — смотрите журнал крона.`,
    );
    try {
      await this.settings.set(RUN_SKIP_ALERT_SETTING_KEY, kind);
    } catch (e) {
      // Не запомнили — значит следующий тик скажет ещё раз. Громче, а
      // не тише: это безопасная сторона.
      this.logger.warn(
        `отметка о тревоге пропуска не записана: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return this.skip(reason);
  }

  /** Пропуск кончился — следующий снова поднимет тревогу. */
  private async forgetSkipAlert(): Promise<void> {
    try {
      const alerted = await this.settings.get(RUN_SKIP_ALERT_SETTING_KEY);
      if (alerted) await this.settings.set(RUN_SKIP_ALERT_SETTING_KEY, '');
    } catch {
      // Не стёрли — следующий пропуск той же причины промолчит. Журнал
      // крона его всё равно покажет; ронять прогон из-за этого нечего.
    }
  }

  private skip(reason: string): TutorialScenarioRunResult {
    return {
      skipped: reason,
      total: 0,
      passed: 0,
      failed: 0,
      paidClicksSkipped: 0,
      narrationFallbacks: 0,
      framesMissed: 0,
      withoutFrames: 0,
      lostRaces: 0,
      assemblyTimeouts: 0,
      repeatFailures: 0,
      outcomes: [],
    };
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
    /** Суточный потолок тика: проверяется и перед синтезом каждой
     *  дорожки, и перед отправкой сборки. */
    budget: TutorialBudget,
    /** Фикстурный пользователь — владелец расхода (см.
     *  `synthesizeNarration`). */
    userId: string,
    /** Куда сложить замеченное по дороге, чтобы оно доехало до журнала
     *  крона. Объект, а не возвращаемое значение: метод объявлен
     *  best-effort и выходит из себя в полудюжине мест. */
    assemblyNotes: {
      narrationFallback?: true;
      noFrames?: true;
      lostRace?: true;
    },
    /** Когда и какой сборкой фронтенда сняты кадры — в строку ролика. */
    capture: { capturedAt: Date; captureBuild: string | null } = {
      capturedAt: new Date(),
      captureBuild: null,
    },
    /** Отмена извне — дедлайн отправки (`ASSEMBLY_SUBMIT_TIMEOUT_MS`)
     *  в `runOne`. Проверяется перед каждым синтезом, заливкой и submit. */
    signal?: AbortSignal,
    /** Тема съёмки — часть пары: отпечаток, счёт провалов, строка и
     *  имена кадров — по (subjectKey, locale, theme). */
    theme: ScenarioTheme = 'light',
  ): Promise<void> {
    if (frames.length === 0) {
      // Молчать тут нельзя (сквозной аудит 29.09.2026). Сценарий из
      // одних `assertVisible`, отвалившийся на каждом шаге
      // `page.screenshot`, мок без `screenshot` — во всех случаях
      // `lastRunStatus: 'ok'`, зелёная строка в админке и НИ ОДНОЙ
      // строки в журнале. Оператор видит зелёное и отсутствие ролика, и
      // объяснения не находит нигде: соседняя ветка «не изменилось,
      // сборка не нужна» хотя бы пишется.
      this.logger.log(
        `сценарий ${scenario.subjectKey} (${scenario.locale}): кадров не снято — собирать нечего`,
      );
      assemblyNotes.noFrames = true;
      return;
    }
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
    const {
      plan: narration,
      captionTexts,
      narrationFallback,
    } = await this.buildNarration(
      scenario,
      frames.map((f) => f.stepIndex),
      userId,
      budget,
      signal,
    );
    if (narrationFallback) assemblyNotes.narrationFallback = true;
    // Отменено ещё до строки — заводить её незачем: ни заливок, ни
    // задачи не было, и сирот нет.
    if (signal?.aborted) {
      this.logger.warn(
        `сценарий ${scenario.subjectKey} (${scenario.locale}): отправка сборки отменена по времени до заведения строки — ничего не залито и не отправлено`,
      );
      return;
    }
    // Подписи включены по умолчанию, в отличие от самой озвучки:
    // ролик смотрят без звука чаще, чем со звуком, и подпись —
    // единственное, что в этом случае объясняет кадр (§5 ТЗ).
    // Выключается независимо от звука — четвёртый уровень отката §9.
    // Сбой чтения настройки не должен ронять сборку: без подписей
    // ролик получается, без ролика — нет.
    const captionsOn = parseTutorialCaptionsSetting(
      await this.settings.get(TUTORIAL_CAPTIONS_SETTING_KEY).catch(() => null),
    );
    // Движение (этап G). Читается ОДИН раз и одной переменной уходит
    // во все три места, которые считают время: подписи, отпечаток и
    // план. Прочитанное дважды, оно могло бы разойтись между
    // чтениями (оператор переключил посреди прогона) — и подписи
    // легли бы на ролик другой длины. Сбой чтения — без движения:
    // это улучшение, а не условие сборки.
    const motion = parseTutorialMotionSetting(
      await this.settings.get(TUTORIAL_MOTION_SETTING_KEY).catch(() => null),
    );
    // Указатель клика (этап H). Замер делается всегда — он дешёвый и
    // уже лежит на кадре, — а рисуется только по выключателю.
    // Выключенный указатель СНИМАЕТСЯ с кадров здесь, до отпечатка:
    // иначе отпечаток зависел бы от замера, которого на картинке нет,
    // и дрожание вёрстки между ночами заказывало бы пересборку.
    const pointerOn = parseTutorialPointerSetting(
      await this.settings.get(TUTORIAL_POINTER_SETTING_KEY).catch(() => null),
    );
    // Длительность кадра назначается по-разному в двух вариантах, и
    // это не деталь реализации, а разница между ними (§3/§3-бис).
    // Вариант А: речь одна на весь ролик, делим поровну. Вариант Б:
    // каждый кадр висит ровно столько, сколько звучит ЕГО реплика, а
    // кадр без реплики — минимум. Вариант А на покадровых репликах
    // дал бы кадр, который меняется посреди фразы.
    //
    // Третье правило — у кадра, где подпись ЕСТЬ, а измеренной речи
    // НЕТ (озвучка выключена, дорожка не синтезировалась или не
    // измерилась): он держится столько, сколько читается подпись
    // (`captionReadingSeconds`, правка сквозного аудита A–G). Прежнее
    // число остаётся нижней границей. Кадры без подписи — и все кадры
    // при выключенных подписях — получают ровно то, что и раньше, так
    // что отпечатки таких роликов не меняются.
    const planFrames = frames.map((frame) => {
      const track =
        narration.mode === 'perFrame'
          ? (narration.tracks.get(frame.stepIndex) ?? null)
          : null;
      const baseSeconds =
        narration.mode === 'perFrame'
          ? narrationFrameSeconds(track?.seconds ?? null)
          : evenFrameSeconds(
              narration.mode === 'whole' ? narration.speechSeconds : null,
              frames.length,
              motion,
            );
      const measuredSpeech =
        (narration.mode === 'perFrame' &&
          track?.seconds != null &&
          Number.isFinite(track.seconds)) ||
        narration.mode === 'whole';
      const reading =
        captionsOn && !measuredSpeech
          ? captionReadingSeconds(captionTexts.get(frame.stepIndex) ?? null)
          : null;
      return {
        stepIndex: frame.stepIndex,
        bytes: frame.bytes,
        seconds:
          reading === null ? baseSeconds : Math.max(baseSeconds, reading),
        audioUrl: track?.url ?? null,
        pointer: pointerOn ? (frame.pointer ?? null) : null,
        // Текст подписи — та же реплика, что синтезирована, и берётся
        // она из того же места (§11 п.16 требует дословного
        // совпадения). Кадр без реплики подписи не получает.
        // Подпись берётся из ТЕКСТА ШАГА, а не из синтезированной
        // дорожки. Иначе подписи не появлялись бы, пока озвучка
        // выключена, — а выключена она по умолчанию, то есть не
        // появлялись бы никогда (находка аудита этапа E). Кадр,
        // чья дорожка не синтезировалась, подпись всё равно
        // получает: текст-то цел.
        narration: captionTexts.get(frame.stepIndex) ?? null,
      };
    });

    // Подписи (§5 ТЗ, этап E). Строятся ДО отпечатка и входят в
    // него: правка реплики меняет и звук, и подпись, а выключение
    // настройки меняет картинку — и то и другое обязано заказать
    // пересборку, иначе исправленный текст не появится на экране
    // никогда.
    const captionsAss = captionsOn
      ? buildTutorialCaptionsAss(
          planFrames.map((f) => ({
            seconds: f.seconds,
            narration: f.narration,
          })),
          motion,
        )
      : '';

    // §7.2 ТЗ: «ролики пересобираются, когда меняется интерфейс или
    // текст шага, а не по расписанию». До этой проверки обещание не
    // выполнялось: ночной прогон отправлял платную задачу на КАЖДЫЙ
    // успешный сценарий каждую ночь, получая побайтово тот же mp4, а
    // подметальщик той же ночью выносил вчерашний. Теперь вход
    // сравнивается с отпечатком последнего СОБРАННОГО ролика пары.
    //
    // Пары — С ТЕМОЙ (заход 3 «Актуального демо»): без неё темы,
    // чередуясь, сличались бы каждая с роликом другой, отпечаток не
    // совпадал бы никогда, и каждый прогон заказывал бы платную сборку.
    const contentHash = slideshowFingerprint(
      planFrames,
      narration.mode === 'whole' ? narration.url : null,
      captionsAss,
      motion,
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
          AND: [assetThemeWhere(theme)],
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, contentHash: true },
      })
      .catch(() => null)) as { id: string; contentHash: string | null } | null;
    // Сличение перцептивное по кадрам и точное по всему остальному
    // (`sameSlideshowContent`): побайтовое совпадение кадров живой
    // страницы не повторялось почти никогда — прод 30.09.2026 собирал
    // заново половину набора каждый час.
    const { sensitivity, invalid } = resolveChangeSensitivity(
      process.env,
      TUTORIAL_FRAME_SENSITIVITY_ENV,
      TUTORIAL_FRAME_SENSITIVITY,
    );
    if (invalid.length > 0) {
      this.logger.warn(
        `чувствительность кадров обучалки: неверные ${invalid.join(', ')} — взяты умолчания`,
      );
    }
    if (sameSlideshowContent(previous?.contentHash, contentHash, sensitivity)) {
      // Ни строки, ни файлов: новая строка с тем же роликом — это
      // лишний mp4 в Blob и лишняя работа подметальщику, а не
      // история. Regression-результат прогона уже записан выше по
      // стеку, он от сборки не зависит.
      this.logger.log(
        `сценарий ${scenario.subjectKey} (${scenario.locale}, ${theme}): кадры и озвучка не изменились с ролика ${previous?.id} — сборка не нужна`,
      );
      return;
    }

    // Столько же раз, сколько и ПРОВАЛИВШИХСЯ на том же содержимом
    // (сквозной аудит 29.09.2026).
    //
    // Предпроверка выше сличает отпечаток только с СОБРАННЫМ роликом
    // (`assemblyStatus: 'complete'`) — и это правильно для своей
    // задачи. Но строка со статусом `failed` в сличении не
    // участвовала вовсе, а счётчика попыток не было нигде. Кадр, на
    // котором внешний сервис стабильно спотыкается (или `.ass` с
    // символом, ломающим libass), давал так вечный цикл: каждую ночь
    // одна и та же задача отправлялась заново, оплачивалась и падала.
    // Тридцать строк — это ≈$0.30 за ночь за ролики, которых не будет,
    // и один и тот же алерт каждое утро, который перестают читать
    // примерно на третий раз.
    //
    // Потолок именно на ОДНО содержимое: поправили реплику, сменился
    // отпечаток — счёт начинается заново, и починка не требует
    // трогать базу руками. Это и есть выход из отказа, который иначе
    // пришлось бы описывать в инструкции.
    //
    // «То же содержимое» — в том же смысле, что и у предпроверки выше:
    // точное равенство при дрожащих байтах кадров не повторялось бы, и
    // потолок не наступал бы никогда. Кандидаты — провалы с теми же
    // входами, кроме картинки (средняя часть отпечатка), их сличает
    // `sameSlideshowContent`.
    //
    // Тревога об остановке — НЕ здесь (аудит кронов 06.10.2026): здесь
    // она шла каждый прогон пары, то есть до пяти раз в сутки об одном
    // и том же. Её поднимает `failAssembly` ровно в момент перехода —
    // когда записан провал, ставший `MAX_ASSEMBLY_ATTEMPTS`-м.
    const failedSameContent = await this.failedSameContentCount(
      scenario.subjectKey,
      scenario.locale,
      theme,
      contentHash,
    );
    if (failedSameContent >= MAX_ASSEMBLY_ATTEMPTS) {
      this.logger.warn(
        `сценарий ${scenario.subjectKey} (${scenario.locale}): сборка этого содержимого проваливалась ${failedSameContent} раз(а) — больше не пробуем, пока не изменятся кадры или реплики`,
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
          // Метаданные ролика (заход 1, 06.10.2026) — для плеера
          // помощника и лендинга: размер холста (кадр приводится к нему
          // планом `planSlideshow`), тема съёмки, когда и какой сборкой
          // фронтенда сняты кадры. Постер дописывает опрос при `complete`.
          width: CANVAS.width,
          height: CANVAS.height,
          theme,
          capturedAt: capture.capturedAt,
          captureBuild: capture.captureBuild,
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
      // Монтажный manifest (темп в постпродакшене, 06.10.2026) — те же
      // кадры, длительности, дорожки и подписи, что уходят в план. Пока
      // ролик не собран, кадры в нём транзитные; при `complete` сервис
      // версий переносит их в постоянный префикс исходников.
      const manifestFrames: ManifestFrame[] = [];
      for (const frame of planFrames) {
        if (signal?.aborted) {
          await this.abortedAssembly(asset.id, scenario, 'заливки кадров');
          return;
        }
        // Тема — в имени кадра (заход 3): по пути в консоли хранилища
        // видно, какой темы кадр, не открывая строку ролика.
        const { url } = await this.blob.uploadBuffer(
          `${scenarioFramePrefix(asset.id)}${scenarioFrameName(frame.stepIndex, theme)}`,
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
          ...(frame.pointer ? { pointer: frame.pointer } : {}),
        });
        const track =
          narration.mode === 'perFrame'
            ? (narration.tracks.get(frame.stepIndex) ?? null)
            : null;
        manifestFrames.push({
          frameId: `step-${frame.stepIndex}`,
          stepIndex: frame.stepIndex,
          image: {
            url,
            pathname: `${scenarioFramePrefix(asset.id)}${scenarioFrameName(frame.stepIndex, theme)}`,
          },
          baseSeconds: frame.seconds,
          speech: track
            ? {
                url: track.url,
                pathname: pathnameFromBlobUrl(track.url, ''),
                seconds: track.seconds,
                text: track.text,
                provenance: {
                  provider: track.provider ?? '',
                  voiceId: track.voiceId ?? null,
                  locale: scenario.locale,
                  textSha: textSha(track.text),
                },
              }
            : null,
          caption: captionsOn ? frame.narration : null,
          readingSeconds:
            captionsOn && frame.narration
              ? captionReadingSeconds(frame.narration)
              : null,
          pointer: frame.pointer ?? null,
        });
      }

      // `.ass` — под тем же префиксом актива, что и кадры: файл
      // транзитный (внешний сервис скачивает его один раз), и уборка
      // кадров уносит его вместе с ними. Шов «все транзитные заливки
      // обучалки под одним убираемым префиксом» это и сторожит.
      //
      // Свой `try`: подписи — необязательное улучшение, и их сбой не
      // должен стоить ролика. Ровно эту находку аудит этапа D закрыл
      // у дорожек озвучки, а этап E завёл заново, положив заливку в
      // общий `try` сборки: икота Blob уводила задачу в
      // `abandonAssembly`, и mp4 не появлялся вовсе.
      let captionsUrl: string | null = null;
      if (signal?.aborted) {
        await this.abortedAssembly(asset.id, scenario, 'заливки подписей');
        return;
      }
      try {
        if (captionsAss) {
          const { url } = await this.blob.uploadBuffer(
            captionsPathname(scenarioFramePrefix(asset.id)),
            Buffer.from(captionsAss, 'utf8'),
            // `text/x-ssa` — тип, под которым отдают `.ass`. Сам
            // libass определяет формат пробой СОДЕРЖИМОГО, а не по
            // типу и не по расширению; тип важен по дороге —
            // отдавать текстовый файл как
            // `application/octet-stream` значит полагаться на то,
            // что ни один промежуточный сервис его не тронет.
            'text/x-ssa; charset=utf-8',
          );
          captionsUrl = url;
        }
      } catch (e) {
        this.logger.warn(
          `сценарий ${scenario.subjectKey}: подписи не залились (${
            e instanceof Error ? e.message : String(e)
          }) — ролик соберётся без них`,
        );
      }

      const plan = planSlideshow(slides, {
        voiceoverUrl: narration.mode === 'whole' ? narration.url : null,
        captionsUrl,
        motion,
      });
      const manifest = buildTutorialManifest({
        sourceAssetId: asset.id,
        owner: {
          kind: 'scenario',
          scenarioId: scenario.id,
          subjectKey: scenario.subjectKey,
        },
        assetContentHash: contentHash,
        locale: scenario.locale,
        theme,
        motion,
        // Подписи — только если они действительно легли в ролик: не
        // залились — исходник без них, и версия темпа их не добавит.
        captions: !!captionsUrl,
        narration:
          narration.mode === 'perFrame'
            ? 'per-frame'
            : narration.mode === 'whole'
              ? 'whole'
              : 'none',
        storage: 'transit',
        frames: manifestFrames,
      });
      if (!plan) {
        this.logger.warn(
          `сценарий ${scenario.subjectKey}: ${frames.length} кадров не годятся для сборки (больше потолка слайд-шоу или у кадра неположительная длительность) — пропуск`,
        );
        // Кадры уже залиты — снимаем их и строку за собой, иначе
        // получили бы ровно ту сироту, ради которой всё это и
        // переставлено.
        await this.abandonAssembly(
          asset.id,
          'кадры не годятся для сборки',
          'content',
        );
        return;
      }

      if (plan.motion !== motion) {
        // Зум снят планом у слишком длинного ролика (`ZOOM_MAX_SECONDS`
        // — иначе сборка рискует не уложиться в потолок внешнего
        // сервиса). Молча — это «включил, а зума нет».
        this.logger.log(
          `сценарий ${scenario.subjectKey} (${scenario.locale}): ролик длиннее потолка зума (${ZOOM_MAX_SECONDS} с) — собирается только с переходами`,
        );
      }

      // Последняя из трёх трат — и последняя точка, где ещё можно не
      // потратить. Синтез мог выбрать потолок сам, пока шёл по
      // тридцати репликам; отправлять сборку после этого значило бы
      // перешагнуть потолок ровно на ту сумму, ради которой он стоит.
      if (budgetExhausted(budget)) {
        this.logger.warn(
          `сценарий ${scenario.subjectKey} (${scenario.locale}): суточный потолок расхода обучалки выбран — сборка отложена до завтра`,
        );
        await this.abandonAssembly(
          asset.id,
          'суточный потолок расхода обучалки выбран',
          'infra',
        );
        return;
      }

      // Последняя проверка отмены — прямо перед ОПЛАЧИВАЕМЫМ вызовом:
      // после неё задача уйдёт и будет оплачена, что бы ни случилось.
      if (signal?.aborted) {
        await this.abortedAssembly(asset.id, scenario, 'отправки задачи');
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
      budget.spentMicroUsd += estimateCost('ffmpeg-api', {}).costMicroUsd;
      await this.aiUsage.record({
        operation: 'tutorial-video-assembly',
        model: 'ffmpeg-api',
        userId,
      });

      // Тот же compare-and-set, что у `abandonAssembly` (сквозной
      // аудит 29.09.2026): если подметальщик успел забрать строку,
      // пока шли заливки и синтез, воскрешать её из `failed` нельзя —
      // её кадры уже стёрты, и `pending` указывал бы на входы,
      // которых нет. Задача у подрядчика при этом оплачена; вернуть
      // деньги нечем, но строить на них ложное состояние не надо.
      const taken = (await this.prisma.tutorialVideoAsset.updateMany({
        where: { id: asset.id, assemblyStatus: 'preparing' },
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
          // Подписи заказаны, но не залились — ролик соберётся без них,
          // а отпечаток, записанный при создании строки, говорит «с
          // подписями». Оставь его, и следующая ночь сочла бы ролик
          // готовым: вход тот же, отпечаток совпал, сборка не нужна —
          // и подписи не появились бы НИКОГДА, пока не поменяется
          // что-нибудь ещё (правка сквозного аудита A–G: этап E сделал
          // заливку подписей необязательной, отпечаток §11-тер об этом
          // не знал). Без отпечатка строка не совпадает ни с чем, и
          // следующий прогон собирает заново.
          ...(captionsAss && !captionsUrl ? { contentHash: null } : {}),
          tempoManifest: manifest as unknown as Prisma.InputJsonValue,
        },
      })) as { count: number };

      if (taken.count === 0) {
        this.logger.warn(
          `сценарий ${scenario.subjectKey}: строку ролика успел забрать подметальщик, пока шла подготовка — задача ${job.jobId} отправлена и оплачена, но её результат подобрать некому`,
        );
        // Наружу, а не только в лог: это ОПЛАЧЕННАЯ задача, результат
        // которой некому подобрать. Если такое случается регулярно,
        // значит подготовка систематически не укладывается в
        // `ASSEMBLY_DEADLINE_MS`, и это видно по счётчику в журнале, а
        // не по чтению логов функции.
        assemblyNotes.lostRace = true;
        return;
      }

      this.logger.log(
        `сценарий ${scenario.subjectKey}: слайд-шоу отправлено на сборку (задача ${job.jobId}, ${frames.length} кадров)`,
      );
    } catch (err) {
      // Заливки и submit — сеть и хранилище, а не содержимое: такой
      // провал в счёт попыток одного содержимого не идёт.
      await this.abandonAssembly(
        asset.id,
        err instanceof Error ? err.message : String(err),
        'infra',
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
    this.failedThisTick = 0;
    const tickStartedAt = Date.now();
    try {
      // Счётчик — ПОСЛЕ опроса и по факту: сколько строк осталось
      // висеть. Прежняя редакция считала до опроса, и в журнале после
      // успешного тика, закрывшего все сборки, всё равно стояло
      // `pending=N` — число, по которому нельзя было понять, сделал
      // тик что-нибудь или нет.
      const abandoned = await this.abandonStalePreparing();
      const polled = await this.pollPendingVideoAssets();
      // Версии с другим темпом (постпродакшен, 06.10.2026) — тем же тиком
      // и под тем же замком: та же задача ffmpeg-api, тот же срок.
      // Никогда не бросает (см. `pollVersions`).
      if (this.versions) await this.versions.pollVersions();
      // Подметальщик — ПОСЛЕ опроса, а не до: строка, которая вот
      // сейчас доехала до `complete`, обязана попасть в расчёт
      // «кого оставляем» этим же тиком, иначе на один тик в паре
      // числится на ролик больше, чем есть.
      const swept = await this.sweepOldAssets();
      const pending = await this.prisma.tutorialVideoAsset.count({
        where: { assemblyStatus: 'pending' },
      });
      // Одна тревога на тик, а не на строку (сквозной аудит
      // 29.09.2026).
      //
      // До неё во ВСЕЙ ветке сборки не было ни одной тревоги: отказ
      // Resemble, отказ Blob, 5xx от ffmpeg-api, задача, не уложившаяся
      // в срок, — всё это давало `logger.warn` в логи функции и цветной
      // бейдж на вкладке, которую надо пойти и открыть. Подсистема,
      // чей смысл — узнать о поломке, о своей собственной молчала.
      //
      // Агрегатом, потому что тик идёт каждые две минуты: тревога на
      // каждую провалившуюся строку превратила бы канал в фон уже к
      // обеду, а фон не читают (см. `ALERT_DETAIL_LIMIT` — тот же урок
      // на прогоне сценариев). Поимённый разбор — на вкладке
      // «Видео-контент», здесь только «пойдите посмотрите».
      const failedThisTick = this.failedThisTick;
      if (failedThisTick > 0) {
        await this.notify.alert(
          'tutorial-assembly-poll:failed',
          `Сборка роликов обучалки: за этот тик провалилось ${failedThisTick}. Причины — во вкладке «ИИ-консультант» → «Видео-контент».`,
        );
      }
      const failed = this.failedThisTick;
      // Проверка качества демо — ПОСЛЕДНЕЙ и ограниченным куском: опрос
      // сборок уже сделан, очередь получает остаток бюджета функции, но
      // не больше своего потолка (`TICK_BUDGET_MS`). Никогда не бросает.
      const quality = this.quality
        ? await this.quality.processQueue({
            budgetMs: Math.min(
              QUALITY_TICK_BUDGET_MS,
              ASSEMBLY_TICK_TOTAL_MS - (Date.now() - tickStartedAt),
            ),
          })
        : null;
      return {
        polled,
        pending,
        abandoned,
        swept,
        failed,
        ...(quality && !quality.skipped
          ? {
              qualityProcessed: quality.processed,
              qualityCompleted: quality.completed,
            }
          : {}),
      };
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
      await this.abandonAssembly(row.id, reason, 'infra');
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
   * На пару (шаг, локаль, тема) остаются до трёх строк, и каждая держится
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
        // Роли «проигрываемый» и «одобренный» считаются по `blobUrl` —
        // ровно по тому, что читают потребители ролика (см.
        // `SweepableAsset.blobUrl`). Статус нужен только роли «свежие
        // провалы»: без неё потолок попыток не набирался никогда
        // (аудит 01.10.2026).
        blobUrl: true,
        assemblyStatus: true,
        // Тема — часть пары (заход 3): светлый и тёмный ролики держат
        // роли каждый в своей теме и не вытесняют друг друга.
        theme: true,
      },
    })) as {
      id: string;
      subjectKey: string;
      locale: string;
      reviewed: boolean;
      blobUrl: string | null;
      assemblyStatus: string;
      theme: string | null;
    }[];

    // Прежний одобренный ролик держится сутки после одобрения нового —
    // см. пятую роль `selectSweepableAssets`. Сбой чтения карты —
    // поведение прежнее, а не отказ подметальщика.
    const approvals = parseApprovalStamps(
      await this.settings.get(APPROVAL_STAMPS_SETTING_KEY).catch(() => null),
    );
    // Ролики, отмеченные в демо обучающего лендинга, не удаляются вовсе
    // (решение: «не удалять отмеченное», а не «переносить отметку на
    // преемника»). Перенос значил бы, что в публичное демо без человека
    // попадает ролик, которого оператор не видел; удаление — что слот
    // молча становится «скоро». Отмеченный ролик живёт, пока оператор
    // не снимет галочку. Отметка не прочиталась или не разобралась —
    // строки семейства в этот тик не трогаем вовсе: не знаем, какие
    // отмечены, значит, не удаляем ни одну.
    const demoMarks = await this.readDemoMarks();
    const sweepRows =
      demoMarks === null
        ? rows.filter((r) => !isSiteTutorialDemoFamilyKey(r.subjectKey))
        : rows;
    const doomed = selectSweepableAssets(
      sweepRows,
      MAX_ASSEMBLY_ATTEMPTS,
      pairsInApprovalGrace(sweepRows, approvals, Date.now()),
      demoMarks ?? new Set<string>(),
    ).slice(0, ASSET_DELETE_LIMIT);
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
    let approvedGone = 0;
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
        // Версии темпа и исходники для них — ДО строки: после её удаления
        // каскад снесёт строки версий, и пути их файлов взять будет
        // неоткуда (страховка — метла сирот по префиксам).
        if (this.versions) await this.versions.deleteAssetExtras(row.id);
        if (pathname) await this.blob.deleteBlob(pathname);
        // Постер — по пути из id, а не из `posterUrl`: копия могла
        // залиться, а запись ссылки — нет. Только у собранного (постер
        // заводится на `complete`). Не удалился — его подберёт метла
        // `sweep-orphans`, когда строки не станет.
        if (row.blobUrl) {
          await this.blob.deleteBlob(tutorialPosterPathname(row.id));
        }
        await this.prisma.tutorialVideoAsset.delete({ where: { id: row.id } });
        deleted++;
        if (
          row.reviewed &&
          row.blobUrl &&
          !isSiteTutorialDemoFamilyKey(row.subjectKey)
        ) {
          approvedGone++;
        }
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
    // Ш5 (12): ушёл одобренный ролик (он мог быть в наборе тенанта
    // лендинга) — переслать набор: один раз за тик, с дебаунсом,
    // best-effort (`requestSync` не бросает; сбой — следующий повод).
    if (approvedGone > 0 && this.landingVideos) {
      await this.landingVideos.requestSync().catch(() => false);
    }
    return deleted;
  }

  /**
   * Отметка оператора «в демо обучающего лендинга» — множество id, или
   * `null`, если отметку нельзя прочесть уверенно: чтение упало, или
   * значение непустое, а разбор (закрытый по умолчанию) не дал ни одного
   * id. Пустое множество — отметки честно нет.
   */
  private async readDemoMarks(): Promise<Set<string> | null> {
    let raw: string | null;
    try {
      raw = await this.settings.get(SITE_TUTORIAL_DEMO_ASSETS_SETTING_KEY);
    } catch {
      return null;
    }
    const ids = parseSiteTutorialDemoAssetIds(raw);
    const trimmed = raw?.trim() ?? '';
    if (ids.length === 0 && trimmed !== '' && trimmed !== '[]') return null;
    return new Set(ids);
  }

  /** @returns сколько строк успели опросить. */
  private async pollPendingVideoAssets(): Promise<number> {
    const pending = await this.prisma.tutorialVideoAsset.findMany({
      where: { assemblyStatus: 'pending' },
      take: RUN_BATCH_LIMIT,
    });
    if (pending.length === 0) return 0;

    // Ключа сервиса нет — спрашивать статус не у кого, но и бросать
    // строки в `pending` навсегда нельзя (сквозной аудит 29.09.2026).
    //
    // Раньше проверка `configured()` стояла ПЕРВОЙ строкой метода, до
    // выборки и до дедлайна. Ключ снят или ротирован (второй уровень
    // отката §9 прямо предлагает «синтез не настроен» как штатное
    // состояние) — и уже отправленные строки висели вечно: опрос
    // выходил на нулевой строке, `abandonStalePreparing` ходит только
    // по `preparing`, а подметальщик намеренно не трогает ни
    // `preparing`, ни `pending`. Оператор видел бессрочное
    // «собирается», а в журнале — `polled=0, pending=N` с растущим N и
    // без единого слова о причине.
    //
    // Дедлайн сборки применяется и без ключа: он про время, а не про
    // ответ сервиса. Задача, не уложившаяся в него, закрывается
    // названной причиной, и пара пересоберётся следующей ночью.
    if (!this.ffmpeg.configured()) {
      let closed = 0;
      for (const asset of pending) {
        if (!this.assemblyOverdue(asset)) continue;
        await this.failAssembly(
          asset,
          'ключ внешнего сервиса сборки не настроен, а срок задачи истёк',
          'infra',
        );
        closed++;
      }
      if (closed > 0) {
        this.logger.warn(
          `опрос сборок: ключ ffmpeg-api не настроен — ${closed} просроченных задач(и) закрыто, пара пересоберётся после настройки`,
        );
      }
      return 0;
    }

    const deadline = Date.now() + POLL_DEADLINE_MS;
    let polled = 0;
    for (const asset of pending) {
      if (Date.now() >= deadline) break;
      await this.pollOneVideoAsset(asset);
      polled++;
    }
    return polled;
  }

  /** Срок задачи внешнего сервиса истёк. Одно место на обе ветки
   *  опроса — с ключом и без него. */
  private assemblyOverdue(asset: { assemblyStartedAt?: Date | null }): boolean {
    return (
      !!asset.assemblyStartedAt &&
      Date.now() - asset.assemblyStartedAt.getTime() > ASSEMBLY_DEADLINE_MS
    );
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
    /** Для счёта попыток одного содержимого (см. `failAssembly`). */
    locale?: string;
    contentHash?: string | null;
    width?: number | null;
    height?: number | null;
    /** Тема ролика — в путь mp4 и в пару счёта попыток. */
    theme?: string | null;
  }): Promise<void> {
    if (!asset.assemblyJobId) {
      await this.failAssembly(
        asset,
        'сборка помечена ожидающей, но задача не была отправлена (процесс оборвался между записью строки и submit)',
        'infra',
      );
      return;
    }

    if (this.assemblyOverdue(asset)) {
      // Содержимое, а не инфраструктура: задача принята и оплачена, и
      // ролик, на котором внешний сервис стабильно зависает, иначе
      // оплачивался бы каждый прогон без конца.
      await this.failAssembly(
        asset,
        `сборка не завершилась за ${ASSEMBLY_DEADLINE_MS / 60000} мин`,
        'content',
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
        'content',
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
        'content',
      );
      return;
    }

    // Байты собранного ролика — для ключа дедупликации проверки качества
    // (sha содержимого), чтобы не скачивать его второй раз.
    let assembledBytes: Buffer | null = null;
    try {
      const bytes = await this.downloadBytes(url);
      // Пустой или обрезанный ответ — НЕ готовый ролик (сквозной аудит
      // 29.09.2026). Раньше размер не проверялся вовсе: нулевой mp4
      // давал `complete`, рабочую кнопку «Просмотр» и сломанный плеер,
      // а единственным следом было «собрано (0 байт)» в логах функции.
      //
      // Потолок снизу, а не точное число: настоящий ролик обучалки —
      // сотни килобайт (первый боевой прогон дал 0.99 и 1.24 МБ), и
      // всё, что меньше килобайта, заведомо не видео. Верхнего потолка
      // нет намеренно: слишком большой файл — это работающий ролик,
      // просто дорогой в хранении, и ронять из-за этого сборку незачем.
      if (bytes.length < MIN_ASSEMBLED_VIDEO_BYTES) {
        await this.failAssembly(
          asset,
          `ffmpeg-api отдал ${bytes.length} байт — это не готовый ролик`,
          'content',
        );
        return;
      }
      // Тема — в пути (заход 3): `tutorial-videos/{шаг}/{тема}/{id}.mp4`.
      // Строки без темы (до тем, обучалка по сайту заказчика) — без
      // сегмента, как раньше. Обратно путь читают только по префиксу
      // `tutorial-videos/` (публикация и подметальщик) — сегмент им не
      // мешает.
      const { url: ourUrl } = await this.blob.uploadBuffer(
        `tutorial-videos/${asset.subjectKey}/${isScenarioTheme(asset.theme) ? `${asset.theme}/` : ''}${asset.id}.mp4`,
        bytes,
        'video/mp4',
      );
      await this.prisma.tutorialVideoAsset.update({
        where: { id: asset.id },
        data: {
          assemblyStatus: 'complete',
          blobUrl: ourUrl,
          assemblyError: null,
          // Размер холста — у строк, которые его не записали при
          // отправке: путь обучалки по сайту заказчика
          // (`client-site-tutorial-admin.service.ts`) собирает тем же
          // `planSlideshow`, то есть в тот же `CANVAS`, и строки,
          // отправленные до заведения полей.
          ...(asset.width == null || asset.height == null
            ? { width: CANVAS.width, height: CANVAS.height }
            : {}),
          // `durationMs` здесь НЕ пишется: он записан при отправке, из
          // `plan.durationMs` — того самого плана, по которому собран
          // файл. До этапа A он вычислялся тут заново, произведением
          // `frameCount × SECONDS_PER_FRAME`, и это сходилось ровно
          // пока все кадры были одной длины. С этапа B длины разные, и
          // повторное вычисление разошлось бы молча.
          //
          // Кто это число читает: на сценарном пути — никто (уточнено
          // сквозным аудитом 29.09.2026, см. доккомментарий
          // `slideshowDurationMs`). Прежняя редакция ссылалась на
          // экран мастера («Длительность — около N с»), но это экран
          // обучалки по САЙТУ ЗАКАЗЧИКА, у которого длительность
          // считается иначе.
          //
          // Строки, отправленные до этой правки, досчитывать задним
          // числом не пытаемся: `durationMs` необязателен, экран
          // мастера без него просто не показывает строку.
        },
      });
      this.logger.log(
        `сценарий ${asset.subjectKey}: слайд-шоу собрано (${bytes.length} байт)`,
      );
      assembledBytes = bytes;
    } catch (err) {
      // Задача у сервиса УДАЛАСЬ — сбой у нас, на скачивании или в
      // Blob. В счёт попыток содержимого не идёт.
      await this.failAssembly(
        asset,
        `не удалось скачать/перезалить готовое видео: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'infra',
      );
      return;
    }

    // Постер — ДО уборки кадров: первый кадр берётся из них же, а
    // после `cleanupFrames` брать его неоткуда. Сбой — без последствий
    // для ролика: плеер покажет первый кадр самого видео.
    await this.savePoster(asset);

    // Исходники для темпа (06.10.2026) — тоже ДО уборки кадров: manifest
    // ссылается на транзит, и после `cleanupFrames` переносить нечего.
    // Только сценарный путь: у обучалки клиента кадры — черновика.
    // Никогда не бросает: без исходников темп недоступен, ролик цел.
    if (asset.scenarioId && this.versions) {
      await this.versions.captureScenarioSources(asset.id);
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

    // «Одноразово» (Ш0.5 аудита 02.10.2026, риск В-1): ролик по сайту
    // заказчика собран — данные входа больше не нужны, стираем сразу.
    // Отдельной обёрткой по той же причине, что уборка кадров выше:
    // сбой здесь не делает собранный ролик несобранным, а пропущенное
    // подберёт крон `client-site-retention`.
    if (asset.clientSiteDraftId) {
      try {
        // Э-С Ш2: данные входа в хранилище sites-backend — стереть там
        // (личная запись B целиком, секреты учётки A); колонки и ссылки —
        // обнулить. Без записи хранилища — как до Ш2, только колонки.
        const draft = (await this.prisma.clientSiteTutorialDraft.findFirst({
          where: { id: asset.clientSiteDraftId, secretsOneShot: true },
          select: {
            id: true,
            projectId: true,
            baseUrl: true,
            siteTestAccountId: true,
            userSiteSessionId: true,
            project: { select: { userId: true } },
          },
        })) as {
          id: string;
          projectId: string;
          baseUrl: string;
          siteTestAccountId: string | null;
          userSiteSessionId: string | null;
          project: { userId: string } | null;
        } | null;
        if (
          draft?.project &&
          (draft.siteTestAccountId || draft.userSiteSessionId)
        ) {
          const store = defaultDraftSecretsStore(this.prisma);
          await store.forget(await store.userOf(draft.project.userId), {
            ...draft,
            credentialsEnc: null,
            cookiesEnc: null,
          });
        }
        await this.prisma.clientSiteTutorialDraft.updateMany({
          where: { id: asset.clientSiteDraftId, secretsOneShot: true },
          data: {
            credentialsEnc: null,
            cookiesEnc: null,
            siteTestAccountId: null,
            userSiteSessionId: null,
            storeHasCredentials: false,
          },
        });
      } catch (e) {
        this.logger.warn(
          `черновик ${asset.clientSiteDraftId}: данные входа «одноразово» не стёрлись (${
            e instanceof Error ? e.message : String(e)
          }) — подберёт крон client-site-retention`,
        );
      }
    }

    // Э6 помощника: собранный ролик привязанного к сайту помощника черновика
    // — полный набор роликов сайта уходит в sites-backend. `syncForDraft`
    // не бросает: сбой сети не делает собранный ролик несобранным.
    if (asset.clientSiteDraftId && this.siteMedia) {
      await this.siteMedia.syncForDraft(asset.clientSiteDraftId);
    }

    // Проверка качества демо (06.10.2026): новый собранный ролик — в
    // очередь Gemini. Только демо продукта: обучалки по сайту заказчика
    // одобряются на своей вкладке. Никогда не бросает — ошибка
    // постановки не меняет статус успешной сборки.
    if (!asset.clientSiteDraftId && this.quality && assembledBytes) {
      await this.quality.enqueueAssembled(asset.id, assembledBytes);
    }
  }

  private async failAssembly(
    asset: {
      id: string;
      subjectKey: string;
      scenarioId?: string | null;
      clientSiteDraftId?: string | null;
      locale?: string;
      contentHash?: string | null;
      theme?: string | null;
    },
    reason: string,
    /** Инфраструктурный провал в счёт попыток содержимого не идёт —
     *  см. `INFRA_ERROR_PREFIX`. */
    kind: AssemblyFailureKind,
  ): Promise<void> {
    this.logger.warn(
      `сценарий ${asset.subjectKey}: сборка видео провалилась — ${reason}`,
    );
    this.failedThisTick++;
    await this.prisma.tutorialVideoAsset.update({
      where: { id: asset.id },
      data:
        kind === 'infra'
          ? {
              assemblyStatus: 'failed',
              assemblyError: `${INFRA_ERROR_PREFIX}${reason}`,
              contentHash: null,
            }
          : { assemblyStatus: 'failed', assemblyError: reason },
    });
    if (kind === 'content') await this.alertOnGiveUp(asset);
    // Уборка кадров и откат черновика — НЕЗАВИСИМЫЕ шаги, и ни один не
    // вправе отменить другой (сквозной аудит 29.09.2026).
    //
    // До этой правки все три операции шли подряд без защиты. Икота
    // Blob в `cleanupFrames` — после того, как строка уже помечена
    // `failed`, — давала сразу три последствия, и каждое хуже
    // предыдущего: (1) `releaseClientSiteDraft` не вызывался вовсе, и
    // черновик обучалки заказчика оставался в `APPROVED` НАВСЕГДА (из
    // `APPROVED` выхода нет ни у кого — ровно та яма, которую закрывал
    // аудит 27.09.2026, открытая заново через путь исключения);
    // (2) исключение улетало вверх и рушило весь тик опроса — остальные
    // `pending`-строки в эту минуту не опрашивались, крон отвечал 500;
    // (3) повторялось это каждые две минуты, пока Blob икает.
    //
    // Порядок тоже важен: откат черновика идёт ПЕРВЫМ, потому что он
    // про состояние, которое видит человек, а уборка кадров — про
    // место в хранилище. Если выбирать, что потерять при отказе, —
    // теряем место, а не выход из состояния.
    await this.releaseClientSiteDraft(asset, reason).catch((err) => {
      this.logger.warn(
        `сценарий ${asset.subjectKey}: черновик обучалки заказчика не вернулся на одобрение: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    await this.cleanupFrames(asset).catch((err) => {
      this.logger.warn(
        `сценарий ${asset.subjectKey}: кадры провалившейся сборки не убрались: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
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
    /** См. `INFRA_ERROR_PREFIX`: денежный потолок, зависшая подготовка,
     *  сеть и Blob — `infra`; кадры, негодные для плана, — `content`. */
    kind: AssemblyFailureKind,
  ): Promise<void> {
    // Сначала ЗАБИРАЕМ строку, и только потом трогаем её кадры
    // (сквозной аудит 29.09.2026).
    //
    // Гонка была такая: `abandonStalePreparing` берёт строку, висящую в
    // `preparing` дольше десяти минут, стирает её кадры и помечает
    // провалившейся — а `submitVideoAssembly` в это время всё ещё
    // работает над ней (до тридцати заливок кадров плюс синтез могут не
    // уложиться в десять минут на медленном Blob) и следом пишет
    // `pending` с `assemblyJobId`. Получалась оплаченная задача на уже
    // стёртые входы и строка, воскресшая из `failed`.
    //
    // `updateMany` с условием по статусу — это compare-and-set: строку
    // забирает тот, кто успел первым, второй получает `count: 0` и
    // отходит. Кадры стираются только выигравшим.
    const claimed = (await this.prisma.tutorialVideoAsset
      .updateMany({
        where: { id: assetId, assemblyStatus: 'preparing' },
        data:
          kind === 'infra'
            ? {
                assemblyStatus: 'failed',
                assemblyError: `${INFRA_ERROR_PREFIX}${reason}`.slice(0, 500),
                contentHash: null,
              }
            : { assemblyStatus: 'failed', assemblyError: reason.slice(0, 500) },
      })
      .catch(() => ({ count: 0 }))) as { count: number };
    if (claimed.count === 0) {
      this.logger.log(
        `актив ${assetId}: строку уже забрал другой путь — кадры не трогаем`,
      );
      return;
    }
    try {
      await this.wipeScenarioFrames(assetId);
    } catch (e) {
      this.logger.warn(
        `кадры актива ${assetId} не убрались: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Отправка отменена по дедлайну посреди подготовки: строка —
   *  `failed` с инфраструктурной причиной, кадры — прочь, задачи нет. */
  private async abortedAssembly(
    assetId: string,
    scenario: { subjectKey: string; locale: string },
    stage: string,
  ): Promise<void> {
    this.logger.warn(
      `сценарий ${scenario.subjectKey} (${scenario.locale}): отправка сборки отменена по времени до ${stage} — задача не отправлена`,
    );
    await this.abandonAssembly(
      assetId,
      `отправка не уложилась в ${Math.round(ASSEMBLY_SUBMIT_TIMEOUT_MS / 1000)}с и отменена до ${stage}`,
      'infra',
    );
  }

  /**
   * Сколько раз проваливалась сборка ЭТОГО содержимого пары — в том же
   * смысле «того же», что у предпроверки отпечатка (`sameSlideshowContent`).
   *
   * Инфраструктурные провалы не считаются дважды защищённо: у них стёрт
   * `contentHash` (в выборку по нему они не попадают), и их причина
   * начинается с `INFRA_ERROR_PREFIX` (отсеиваются здесь же — на случай
   * строки, где отпечаток уцелел).
   */
  private async failedSameContentCount(
    subjectKey: string,
    locale: string,
    /** Пара — с темой: провалы тёмного ролика не останавливают светлый. */
    theme: ScenarioTheme,
    contentHash: string,
  ): Promise<number> {
    const rest = fingerprintRest(contentHash);
    if (!rest) return 0;
    const { sensitivity } = resolveChangeSensitivity(
      process.env,
      TUTORIAL_FRAME_SENSITIVITY_ENV,
      TUTORIAL_FRAME_SENSITIVITY,
    );
    const failedRows = (await this.prisma.tutorialVideoAsset
      .findMany({
        where: {
          subjectKey,
          locale,
          assemblyStatus: 'failed',
          contentHash: { contains: `|${rest}|` },
          AND: [assetThemeWhere(theme)],
        },
        orderBy: { createdAt: 'desc' },
        take: FAILED_CANDIDATES_TAKE,
        select: { contentHash: true, assemblyError: true },
      })
      .catch(() => [])) as {
      contentHash: string | null;
      assemblyError?: string | null;
    }[];
    return failedRows.filter(
      (r) =>
        !r.assemblyError?.startsWith(INFRA_ERROR_PREFIX) &&
        sameSlideshowContent(r.contentHash, contentHash, sensitivity),
    ).length;
  }

  /**
   * Тревога «попытки остановлены» — ровно один раз, в момент записи
   * провала, ставшего `MAX_ASSEMBLY_ATTEMPTS`-м (аудит кронов
   * 06.10.2026). Прежде она шла из `submitVideoAssembly` на каждом
   * прогоне пары после остановки — до пяти одинаковых в сутки.
   *
   * Только штатная обучалка: у роликов по сайту заказчика потолок
   * попыток свой (`approve` в админке), а не этот.
   */
  private async alertOnGiveUp(asset: {
    subjectKey: string;
    clientSiteDraftId?: string | null;
    locale?: string;
    contentHash?: string | null;
    theme?: string | null;
  }): Promise<void> {
    if (asset.clientSiteDraftId || !asset.locale || !asset.contentHash) return;
    const theme = assetTheme(asset.theme);
    try {
      const failed = await this.failedSameContentCount(
        asset.subjectKey,
        asset.locale,
        theme,
        asset.contentHash,
      );
      if (failed !== MAX_ASSEMBLY_ATTEMPTS) return;
      await this.notify.alert(
        `tutorial-assembly:giveup:${asset.subjectKey}:${asset.locale}:${theme}`,
        `Сборка ролика обучалки ${asset.subjectKey}/${asset.locale} (тема ${theme}) провалилась ${failed} раз(а) на одном и том же содержимом — попытки остановлены, пока не изменятся кадры или реплики. Посмотрите последнюю ошибку во вкладке «Видео-контент».`,
      );
    } catch (e) {
      this.logger.warn(
        `сценарий ${asset.subjectKey}: счёт попыток сборки не удался: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Постер собранного ролика: кадр с НАИМЕНЬШИМ номером шага из
   * транзитов актива — копией в постоянный `tutorial-video-posters/`.
   *
   * Только штатная обучалка (`scenarioId`). У роликов по сайту
   * заказчика кадры — снимки его кабинета под ключом черновика со своим
   * сроком хранения (`draft-retention.ts`), и постоянная публичная копия
   * вывела бы кадр из-под этого срока; посетителям лендинга эти ролики не
   * выдаются, постер им не нужен.
   */
  private async savePoster(asset: {
    id: string;
    subjectKey: string;
    scenarioId: string | null;
  }): Promise<void> {
    if (!asset.scenarioId) return;
    try {
      const prefix = scenarioFramePrefix(asset.id);
      let first: { pathname: string; step: number } | null = null;
      let cursor: string | undefined;
      do {
        const page = await this.blob.listByPrefix(prefix, { cursor });
        for (const b of page.blobs) {
          // Только `<номер шага>.png` прямо под префиксом — не подписи.
          const m = SCENARIO_FRAME_NAME_RE.exec(
            b.pathname.slice(prefix.length),
          );
          if (!m) continue;
          const step = Number(m[1]);
          if (!first || step < first.step)
            first = { pathname: b.pathname, step };
        }
        cursor = page.cursor ?? undefined;
      } while (cursor);
      if (!first) {
        this.logger.warn(
          `сценарий ${asset.subjectKey}: кадров собранного ролика ${asset.id} нет — постера не будет`,
        );
        return;
      }
      const posterUrl = await this.blob.copyBlob(
        first.pathname,
        tutorialPosterPathname(asset.id),
        'image/png',
      );
      if (!posterUrl) return;
      await this.prisma.tutorialVideoAsset.update({
        where: { id: asset.id },
        data: { posterUrl },
      });
    } catch (e) {
      this.logger.warn(
        `сценарий ${asset.subjectKey}: постер ролика ${asset.id} не сохранён: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Скачивание готового mp4 у внешнего сервиса.
   *
   * Таймаут обязателен (сквозной аудит 29.09.2026): без него зависшее
   * соединение съедает весь тик опроса и джоб-замок вместе с ним —
   * `POLL_DEADLINE_MS` проверяется только МЕЖДУ строками, а не внутри
   * сетевого вызова. Приём в проекте уже известен (`AbortSignal.timeout`
   * у TTS), просто сюда не дошёл.
   */
  private async downloadBytes(url: string): Promise<Buffer> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`скачивание результата: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

/**
 * Состояния мастера поздравления — по последней сессии каждого проекта
 * (29.09.2026; четвёртое — этап I ТЗ Greeting 2.0, 30.09.2026).
 *
 * Чистая функция, а не запрос: решение здесь одно и то же для фикстуры
 * и для проекта, заведённого оператором руками, и проверяется оно без
 * базы. Состояние читается ровно так же, как его читает сам мастер, —
 * по ПОСЛЕДНЕЙ сессии проекта:
 *
 *   - сессий нет вовсе → экран брифа с кнопкой «начать»;
 *   - последняя сессия без сценария → кнопка «собрать сценарий»;
 *   - последняя сессия со сценарием и БЕЗ ролика → все девять карточек
 *     и кнопка запуска рендера;
 *   - ролик готов (`generationStatus: complete`) → экран готового
 *     ролика, кадр 4 лендинга.
 *
 * `PROMPT_GENERATED` и всё, что после него, — это «сценарий собран»:
 * статус сессии только растёт. Но рендер поздравления `status` не
 * двигает вовсе (`GreetingVideoService` пишет только `generatedVideo`),
 * поэтому готовый ролик различим лишь по `generationStatus`. Без этого
 * различия проект с роликом — самый свежий, фикстурный «готовый» —
 * побеждал бы в `greetingReadyProjectId`, и сценарий хука
 * `greeting-render` ждал бы кнопку, которую готовый ролик прячет.
 *
 * Сессия с рендером В ПУТИ или с упавшим рендером не попадает никуда:
 * кнопки запуска на ней уже нет, а готового ролика ещё нет. Такой
 * проект честнее пропустить, чем открыть сценарию не тот экран.
 *
 * Проект, чьё состояние не опознано, просто не попадает в контекст:
 * маршрут тогда честно откажет «нет фикстурных данных» вместо того,
 * чтобы открыть не тот экран.
 */
export function greetingContext(
  projects: ReadonlyArray<{
    id: string;
    // `string`, а не `SessionStatus`: колонка `status` в схеме — обычная
    // строка, и Prisma отдаёт её строкой. Обещать здесь перечисление
    // значило бы обещать то, чего база не гарантирует; неизвестное
    // значение просто не попадёт ни в одно из состояний.
    //
    // `generationStatus` необязателен: вызывающий, который его не
    // выбирает, получает прежние три состояния, а не молчаливое «ролика
    // нет ни у кого».
    sessions: ReadonlyArray<{
      status: string;
      generationStatus?: string | null;
    }>;
  }>,
): {
  greetingProjectId?: string;
  greetingDraftingProjectId?: string;
  greetingReadyProjectId?: string;
  greetingDoneProjectId?: string;
} {
  const WITH_SCRIPT: readonly string[] = [
    SessionStatus.PROMPT_GENERATED,
    SessionStatus.GENERATING_VIDEO,
    SessionStatus.VIDEO_COMPLETE,
  ];
  const out: {
    greetingProjectId?: string;
    greetingDraftingProjectId?: string;
    greetingReadyProjectId?: string;
    greetingDoneProjectId?: string;
  } = {};
  for (const project of projects) {
    const latest = project.sessions[0];
    // Фикстурный проект под кадр «готовый ролик» — только в своё поле и
    // никогда в три других (аудит этапа I). Он заведён последним, значит
    // при отборе «самый свежий первым» забирал бы «сценария нет», пока
    // его сессия `created`, и «сессии нет», когда крон уборки её снёс
    // (`cleanupExpiredSessions` щадит только готовые ролики). Ночные
    // сценарии хуков тогда писали бы в ту самую сессию, из которой
    // рендерится ролик лендинга. Исключение по id, а не по содержанию:
    // по содержанию до рендера он неотличим от остальных — в этом и беда.
    if (project.id === FIXTURE_IDS.greetingDoneProject) {
      if (latest?.generationStatus === GenerationStatus.COMPLETE) {
        out.greetingDoneProjectId ??= project.id;
      }
      continue;
    }
    if (!latest) {
      out.greetingProjectId ??= project.id;
    } else if (latest.generationStatus === GenerationStatus.COMPLETE) {
      out.greetingDoneProjectId ??= project.id;
    } else if (latest.generationStatus) {
      // Рендер в пути или упал — см. доккомментарий: ни одно из
      // состояний, которые умеют открывать сценарии.
      continue;
    } else if (WITH_SCRIPT.includes(latest.status)) {
      out.greetingReadyProjectId ??= project.id;
    } else {
      out.greetingDraftingProjectId ??= project.id;
    }
  }
  return out;
}

/**
 * Версия фронтенда, на которой сняты кадры (заход 1 метаданных,
 * 06.10.2026): фронтенд кладёт её в `<meta name="app-build">`. Нет
 * тега, страница не умеет `evaluate` или чтение зависло — `null`:
 * метаданные не должны стоить прогона.
 */
const CAPTURE_BUILD_READ_TIMEOUT_MS = 5_000;
const CAPTURE_BUILD_MAX_LENGTH = 100;

/**
 * Какой темой на деле нарисована страница (заход 3 «Актуального демо»):
 * класс `dark` на `<html>` и что о теме знает SDK Telegram. `null` —
 * страница не умеет `evaluate`, чтение зависло или ответ не того вида.
 */
async function readCaptureTheme(
  page: unknown,
): Promise<CaptureThemeProbe | null> {
  const evaluate = (page as { evaluate?: unknown } | null)?.evaluate;
  if (typeof evaluate !== 'function') return null;
  try {
    const raw: unknown = await withTimeout(
      (evaluate as (fn: () => unknown) => Promise<unknown>).call(page, () => {
        const w = window as unknown as {
          Telegram?: {
            WebApp?: {
              colorScheme?: unknown;
              themeParams?: { bg_color?: unknown };
            };
          };
        };
        const tg = w.Telegram?.WebApp;
        return {
          dark: document.documentElement.classList.contains('dark'),
          tgColorScheme:
            typeof tg?.colorScheme === 'string' ? tg.colorScheme : null,
          tgBgColor:
            typeof tg?.themeParams?.bg_color === 'string'
              ? tg.themeParams.bg_color
              : null,
        };
      }),
      CAPTURE_BUILD_READ_TIMEOUT_MS,
      'тема страницы не прочиталась',
    );
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.dark !== 'boolean') return null;
    return {
      dark: r.dark,
      tgColorScheme:
        typeof r.tgColorScheme === 'string' ? r.tgColorScheme : null,
      tgBgColor: typeof r.tgBgColor === 'string' ? r.tgBgColor : null,
    };
  } catch {
    return null;
  }
}

async function readCaptureBuild(page: unknown): Promise<string | null> {
  const evaluate = (page as { evaluate?: unknown } | null)?.evaluate;
  if (typeof evaluate !== 'function') return null;
  try {
    const raw: unknown = await withTimeout(
      (evaluate as (fn: () => string | null) => Promise<unknown>).call(
        page,
        () => {
          const meta = document.querySelector('meta[name=app-build]');
          return meta?.getAttribute('content') ?? null;
        },
      ),
      CAPTURE_BUILD_READ_TIMEOUT_MS,
      'версия фронтенда не прочиталась',
    );
    if (typeof raw !== 'string') return null;
    const build = raw.trim();
    return build && build.length <= CAPTURE_BUILD_MAX_LENGTH ? build : null;
  } catch {
    return null;
  }
}

/** Строка сценария в том виде, в каком её читают оба прохода. */
interface ScenarioRunRow {
  id: string;
  subjectKey: string;
  locale: string;
  steps: unknown;
  createdAt?: Date | null;
  lastRunAt?: Date | null;
  lastRunStatus?: string | null;
  lastRunError?: string | null;
  narrationReviewedAt?: Date | null;
}

/** Проход витрины: сводка для журнала и результат в общей форме. */
interface PolygonPass {
  summary: PolygonPassSummary;
  result: TutorialScenarioRunResult;
}

/**
 * Результат тика = TMA + витрина. `skipped` остаётся от TMA: пропуск
 * прохода TMA (фикстура не настроена) — то, о чём журнал крона и сводка
 * демо обязаны сказать, даже когда витрина отработала; её итог — в
 * `polygon`.
 */
export function mergePolygonPass(
  tma: TutorialScenarioRunResult,
  pass: PolygonPass,
): TutorialScenarioRunResult {
  const poly = pass.result;
  const mismatches =
    tma.themeMismatches === undefined && poly.themeMismatches === undefined
      ? undefined
      : (tma.themeMismatches ?? 0) + (poly.themeMismatches ?? 0);
  return {
    ...tma,
    total: tma.total + poly.total,
    executed: (tma.executed ?? 0) + (poly.executed ?? 0),
    passed: tma.passed + poly.passed,
    failed: tma.failed + poly.failed,
    paidClicksSkipped: tma.paidClicksSkipped + poly.paidClicksSkipped,
    narrationFallbacks: tma.narrationFallbacks + poly.narrationFallbacks,
    framesMissed: tma.framesMissed + poly.framesMissed,
    withoutFrames: tma.withoutFrames + poly.withoutFrames,
    lostRaces: tma.lostRaces + poly.lostRaces,
    repeatFailures: tma.repeatFailures + poly.repeatFailures,
    assemblyTimeouts: tma.assemblyTimeouts + poly.assemblyTimeouts,
    ...(mismatches === undefined ? {} : { themeMismatches: mismatches }),
    outcomes: [...tma.outcomes, ...poly.outcomes],
    polygon: pass.summary,
  };
}

/**
 * Системная тема, которой на деле нарисована витрина, — тот же
 * медиазапрос, по которому она красится. `null` — страница не умеет
 * `evaluate` или чтение не удалось: решения нет, ролик собирается.
 */
async function readPolygonColorScheme(
  page: unknown,
): Promise<'light' | 'dark' | null> {
  const evaluate = (page as { evaluate?: unknown } | null)?.evaluate;
  if (typeof evaluate !== 'function') return null;
  try {
    const raw: unknown = await withTimeout(
      (evaluate as (fn: () => unknown) => Promise<unknown>).call(page, () =>
        typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
          : null,
      ),
      CAPTURE_BUILD_READ_TIMEOUT_MS,
      'тема витрины не прочиталась',
    );
    if (typeof raw !== 'boolean') return null;
    return raw ? 'dark' : 'light';
  } catch {
    return null;
  }
}

/** Замер темы витрины → `media-query` | `mismatch` | `null` (нет замера). */
export function polygonThemeVia(
  wanted: ScenarioTheme,
  measured: 'light' | 'dark' | null,
): CaptureThemeVia | null {
  if (measured === null) return null;
  return measured === wanted ? 'media-query' : 'mismatch';
}

/** Origin страницы после прогона, или `null` — страница не говорит. */
function pageOrigin(page: unknown): string | null {
  const url = (page as { url?: unknown } | null)?.url;
  if (typeof url !== 'function') return null;
  try {
    const raw: unknown = (url as () => unknown).call(page);
    if (typeof raw !== 'string' || !raw) return null;
    const u = new URL(raw);
    // `about:blank` и прочие не-веб схемы — не «ушла на другой сайт», а
    // «страница не открылась»; это ловят сами шаги.
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}
