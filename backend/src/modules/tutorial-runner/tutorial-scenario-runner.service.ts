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
 * `scenario-runner.ts` с `captureFrames: true` снимает по JPEG-скриншоту
 * после каждого успешного шага, этот сервис грузит их как транзитные
 * файлы в Blob (`tutorial-video-frames/{scenarioId}/{n}.jpg`, тот же
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
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import { BlobService } from '../storage/blob.service';
import { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import {
  launchHeadlessBrowser,
  withTimeout,
} from '../../common/headless-chromium';
import { runScenario, ScenarioPage } from './scenario-runner';
import { FixtureRouteContext, resolveScenarioRoute } from './route-templates';
import { planSlideshow } from './tutorial-video-assembly';
import { ScenarioStep } from '../tutorial-scenario/scenario-steps.types';
import { ASSISTANT_STEPS } from '../assistant/knowledge/generated';

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

/** Заголовок для subjectKey вне диапазона шагов обучалки (свободный
 * ключ воркфлоу, §4.4 ТЗ) — сам ключ, раз человекочитаемого заголовка
 * взять неоткуда. */
function resolveTutorialVideoTitle(subjectKey: string, locale: string): string {
  const steps = ASSISTANT_STEPS[locale] ?? [];
  const index = Number(subjectKey);
  if (Number.isInteger(index) && index >= 1 && index <= steps.length) {
    return steps[index - 1].title;
  }
  return subjectKey;
}

export interface TutorialScenarioRunOutcome {
  id: string;
  subjectKey: string;
  ok: boolean;
  error?: string;
}

export interface TutorialScenarioRunResult {
  /** Заполнено, если прогон пропущен целиком (фикстура не настроена/не
   * заведена, браузер недоступен) — total/passed/failed тогда 0. */
  skipped?: string;
  total: number;
  passed: number;
  failed: number;
  outcomes: TutorialScenarioRunOutcome[];
}

@Injectable()
export class TutorialScenarioRunnerService {
  private readonly logger = new Logger(TutorialScenarioRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: TelegramNotifyService,
    private readonly blob: BlobService,
    private readonly ffmpeg: FfmpegApiService,
  ) {}

  async run(): Promise<TutorialScenarioRunResult> {
    // Опрос сборок прошлых тиков — до фикстурного входа и запуска
    // браузера намеренно: сборка видео не завязана ни на фикстуру, ни
    // на сегодняшний регресс-прогон, и должна продвигаться независимо
    // от того, настроен ли ещё сам фикстурный вход. См. доккомментарий
    // модуля.
    await this.pollPendingVideoAssets();

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
    const scenarios = await this.prisma.tutorialScenario.findMany({
      where: { OR: [{ costly: false }, { approved: true }] },
      orderBy: { createdAt: 'asc' },
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
        outcomes: scenarios.map((s) => ({
          id: s.id,
          subjectKey: s.subjectKey,
          ok: false,
          error: launched.error,
        })),
      };
    }

    const { browser } = launched;
    const outcomes: TutorialScenarioRunOutcome[] = [];
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
          token,
          tmaBaseUrl,
        );
        outcomes.push(outcome);
        if (!outcome.ok) {
          await this.notify.alert(
            `tutorial-scenario-run:${scenario.subjectKey}`,
            `Сценарий обучающего видео «${scenario.subjectKey}» провалился на regression-прогоне: ${outcome.error}`,
          );
        }
      }
    } finally {
      await browser.close().catch(() => undefined);
    }

    return {
      total: scenarios.length,
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
    },
    ctx: FixtureRouteContext,
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
        await this.submitVideoAssembly(scenario, result.frames);
      }

      return {
        id: scenario.id,
        subjectKey: scenario.subjectKey,
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
    const [project, item, manifest, session] = await Promise.all([
      this.prisma.project.findFirst({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.productItem.findFirst({
        where: { project: { userId }, deletedAt: null },
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
    scenario: { id: string; subjectKey: string; locale: string },
    frames: Uint8Array[],
  ): Promise<void> {
    if (frames.length === 0) return;
    if (!this.ffmpeg.configured()) {
      this.logger.warn(
        `сценарий ${scenario.subjectKey}: FFMPEG_API_KEY не настроен — слайд-шоу не собирается (regression-результат уже учтён)`,
      );
      return;
    }

    try {
      const frameUrls: string[] = [];
      for (let i = 0; i < frames.length; i++) {
        const pathname = `tutorial-video-frames/${scenario.id}/${i}.jpg`;
        const { url } = await this.blob.uploadBuffer(
          pathname,
          Buffer.from(frames[i]),
          'image/jpeg',
        );
        frameUrls.push(url);
      }

      const plan = planSlideshow(frameUrls);
      if (!plan) {
        this.logger.warn(
          `сценарий ${scenario.subjectKey}: ${frames.length} кадров не годятся для сборки (0 или больше потолка) — пропуск`,
        );
        return;
      }

      const job = await this.ffmpeg.submit({
        inputs: plan.inputs,
        outputs: plan.outputs,
        commands: plan.commands,
      });

      await this.prisma.tutorialVideoAsset.create({
        data: {
          subjectKey: scenario.subjectKey,
          locale: scenario.locale,
          title: resolveTutorialVideoTitle(
            scenario.subjectKey,
            scenario.locale,
          ),
          scenarioId: scenario.id,
          frameCount: frames.length,
          assemblyStatus: 'pending',
          assemblyJobId: job.jobId,
          assemblyStartedAt: new Date(),
        },
      });

      this.logger.log(
        `сценарий ${scenario.subjectKey}: слайд-шоу отправлено на сборку (задача ${job.jobId}, ${frames.length} кадров)`,
      );
    } catch (err) {
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
  private async pollPendingVideoAssets(): Promise<void> {
    if (!this.ffmpeg.configured()) return;

    const pending = await this.prisma.tutorialVideoAsset.findMany({
      where: { assemblyStatus: 'pending' },
      take: RUN_BATCH_LIMIT,
    });
    if (pending.length === 0) return;

    const deadline = Date.now() + POLL_DEADLINE_MS;
    for (const asset of pending) {
      if (Date.now() >= deadline) break;
      await this.pollOneVideoAsset(asset);
    }
  }

  private async pollOneVideoAsset(asset: {
    id: string;
    subjectKey: string;
    scenarioId: string | null;
    frameCount: number | null;
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
      const pathname = `tutorial-videos/${asset.subjectKey}/${asset.id}.mp4`;
      const { url: ourUrl } = await this.blob.uploadBuffer(
        pathname,
        bytes,
        'video/mp4',
      );
      await this.prisma.tutorialVideoAsset.update({
        where: { id: asset.id },
        data: {
          assemblyStatus: 'complete',
          blobUrl: ourUrl,
          assemblyError: null,
        },
      });
      this.logger.log(
        `сценарий ${asset.subjectKey}: слайд-шоу собрано (${bytes.length} байт)`,
      );
      await this.cleanupFrames(asset);
    } catch (err) {
      await this.failAssembly(
        asset,
        `не удалось скачать/перезалить готовое видео: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async failAssembly(
    asset: {
      id: string;
      subjectKey: string;
      scenarioId?: string | null;
      frameCount?: number | null;
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
  }

  /** Транзитные кадры (см. `submitVideoAssembly`) удаляются, как только
   * их судьба решена (собрано или провалено) — держать их в Blob дальше
   * этого момента незачем, тот же принцип, что уже применяет
   * `BlobService`'s доккомментарий к референсному видео анализа. */
  private async cleanupFrames(asset: {
    id: string;
    scenarioId?: string | null;
    frameCount?: number | null;
  }): Promise<void> {
    const owner = asset.scenarioId;
    const count = asset.frameCount;
    if (!owner || !count) return;
    for (let i = 0; i < count; i++) {
      await this.blob.deleteBlob(`tutorial-video-frames/${owner}/${i}.jpg`);
    }
  }

  private async downloadBytes(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`скачивание результата: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
