/**
 * UiSnapshotAdminController — разовый прогон снимков по требованию
 * оператора (этап H ТЗ `docs-tz/TZ-Enterprise-Tutorial-Landing.md`).
 *
 * Тот же приём, что у `FixtureSeedAdminController`: собственный
 * контроллер внутри фиче-модуля, `AdminSessionGuard` плюс
 * `assertOperator`, работа делается уже подключённым сервисом
 * работающего процесса — оператору не нужен доступ к серверу.
 *
 * ## Зачем он, если крон и так ходит каждые две минуты
 *
 * Крон ходит по ОДНОЙ комбинации (пять маршрутов, `ru`, светлая тема, с
 * масками) — это его работа, и менять её под разовую задачу нельзя.
 * Здесь нужна другая: снять мастер обучалки в тёмной теме, в нужной
 * локали и БЕЗ масок, чтобы кадр сайта был виден. До этого этапа такая
 * комбинация требовала правки констант в коде и деплоя.
 *
 * ## Чего эндпоинт НЕ делает
 *
 * Не пишет строк `UiSnapshot` при `unmasked` и не шлёт тревогу
 * «изменилось» — иначе снимок «на показ» подменил бы базовый отпечаток
 * и следующий тик крона закричал бы на собственную же картинку (см.
 * `UiSnapshotRunOptions.unmasked`). Адреса файлов возвращаются в
 * `outcomes[].blobUrl`.
 *
 * Тревог в служебный канал не шлёт (`alerts: false`): вызывающий
 * получает и сбои, и адреса файлов синхронно, в ответе. Если прогон не
 * успел обойти все маршруты за бюджет времени, в ответе будет
 * `deferred` — сколько осталось.
 *
 * Джоб-лок крона он тоже не берёт: это разовое действие человека, а не
 * вторая копия расписания. Два одновременных прогона по одним маршрутам
 * друг другу не мешают — каждый пишет свой файл со своей меткой
 * времени.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { SUPPORTED_LOCALES } from '../../common/locale';
import {
  MAX_SCENARIO_STEPS,
  type ScenarioStep,
} from '../tutorial-scenario/scenario-steps.types';
import {
  UiSnapshotRunnerService,
  type SnapshotTheme,
  type UiSnapshotRunResult,
} from './ui-snapshot-runner.service';
import {
  TutorialFramesCaptureService,
  type CaptureResult,
} from './tutorial-frames-capture.service';

interface RunSnapshotBody {
  locale?: unknown;
  theme?: unknown;
  routeKeys?: unknown;
  unmasked?: unknown;
  deviceScaleFactor?: unknown;
  steps?: unknown;
}

@Controller('admin/ui-snapshot')
@UseGuards(AdminSessionGuard)
export class UiSnapshotAdminController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly runner: UiSnapshotRunnerService,
    private readonly frames: TutorialFramesCaptureService,
  ) {}

  @Post('run')
  async run(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: RunSnapshotBody,
  ): Promise<UiSnapshotRunResult> {
    await this.adminPanel.assertOperator(req.userId);

    // Локаль проверяется по списку продукта, а не принимается любой
    // строкой: `UiSnapshot.locale` — свободное поле, и опечатка «rи»
    // завела бы отдельную ветку истории сравнений, которую никто
    // никогда не увидит, потому что крон в неё не ходит.
    let locale: string | undefined;
    if (body.locale !== undefined) {
      if (
        typeof body.locale !== 'string' ||
        !(SUPPORTED_LOCALES as readonly string[]).includes(body.locale)
      ) {
        throw new BadRequestException(
          `locale должен быть одним из: ${SUPPORTED_LOCALES.join(', ')}`,
        );
      }
      locale = body.locale;
    }

    let theme: SnapshotTheme | undefined;
    if (body.theme !== undefined) {
      if (body.theme !== 'light' && body.theme !== 'dark') {
        throw new BadRequestException('theme должен быть light или dark');
      }
      theme = body.theme;
    }

    let routeKeys: string[] | undefined;
    if (body.routeKeys !== undefined) {
      if (
        !Array.isArray(body.routeKeys) ||
        body.routeKeys.length === 0 ||
        body.routeKeys.some((k) => typeof k !== 'string' || k.trim() === '')
      ) {
        throw new BadRequestException(
          'routeKeys — непустой массив имён маршрутов (см. ROUTE_DESCRIPTIONS в route-templates.ts)',
        );
      }
      routeKeys = (body.routeKeys as string[]).map((k) => k.trim());
    }

    // Плотность пикселей. Нужна лендингу: вьюпорт прогона — 390 CSS-
    // пикселей, а кадру на странице нужно 780 растровых, и растянуть
    // одно до другого постобработкой значит подделать резкость.
    // Разрешены только 1 и 2: промежуточные дают дробные размеры кадра,
    // а больше 2 — файл, который всё равно ужимать.
    const unmasked = body.unmasked === true;
    let deviceScaleFactor: number | undefined;
    if (body.deviceScaleFactor !== undefined) {
      if (body.deviceScaleFactor !== 1 && body.deviceScaleFactor !== 2) {
        throw new BadRequestException('deviceScaleFactor должен быть 1 или 2');
      }
      // Тот же запрет стоит и в сервисе — там он последняя линия для
      // любого вызывающего, здесь он даёт 400 с объяснением вместо 500.
      if (body.deviceScaleFactor === 2 && !unmasked) {
        throw new BadRequestException(
          'deviceScaleFactor: 2 допустим только с unmasked: true — иначе прогон подменит базовый отпечаток крона',
        );
      }
      deviceScaleFactor = body.deviceScaleFactor;
    }

    // Шаги — довести экран до нужного состояния перед съёмкой (этап I,
    // doc/TUTORIAL-FRAMES-CAPTURE.md). Проверяем здесь, а не только в
    // сервисе, по той же причине, что и плотность: 400 с объяснением
    // вместо 500 из глубины прогона.
    //
    // Словарь намеренно уже, чем `ScenarioStep`: съёмочный сценарий
    // ДЕЙСТВУЕТ на уже открытом экране. `goto` увёл бы кадр с
    // маршрута, которым он подписан, а `triggerPaidOperation` — это
    // декларативный маркер оценки стоимости, здесь он не значит
    // ничего и молча ничего бы не сделал.
    const CAPTURE_STEP_KINDS = [
      'fill',
      'click',
      'waitFor',
      'assertVisible',
      'assertText',
    ] as const;
    let steps: ScenarioStep[] | undefined;
    if (body.steps !== undefined) {
      if (!Array.isArray(body.steps) || body.steps.length === 0) {
        throw new BadRequestException(
          'steps должен быть непустым массивом шагов',
        );
      }
      if (body.steps.length > MAX_SCENARIO_STEPS) {
        throw new BadRequestException(
          `шагов не больше ${MAX_SCENARIO_STEPS}: столько же, сколько у сценария обучалки`,
        );
      }
      if (!unmasked) {
        throw new BadRequestException(
          'steps допустимы только с unmasked: true — шаги меняют состояние продукта, а сравниваемый прогон обязан быть наблюдателем',
        );
      }
      if (!routeKeys || routeKeys.length !== 1) {
        throw new BadRequestException(
          'steps требуют ровно одного маршрута в routeKeys: шаги пишутся под конкретный экран',
        );
      }
      for (const [i, raw] of (body.steps as unknown[]).entries()) {
        const step = raw as { kind?: unknown; selector?: unknown };
        if (
          typeof step?.kind !== 'string' ||
          !(CAPTURE_STEP_KINDS as readonly string[]).includes(step.kind)
        ) {
          throw new BadRequestException(
            `шаг ${i + 1}: kind должен быть одним из: ${CAPTURE_STEP_KINDS.join(', ')}`,
          );
        }
        if (typeof step.selector !== 'string' || step.selector.trim() === '') {
          throw new BadRequestException(`шаг ${i + 1}: нужен selector`);
        }
      }
      steps = body.steps as ScenarioStep[];
    }

    // Неизвестное имя маршрута сюда не проверяем специально: резолвер
    // ответит на него понятной причиной в `outcomes[].error`, и это
    // лучше, чем 400 без указания, какой именно из пяти переданных
    // ключей плох.
    // `alerts: false` — правка аудита. Первая редакция слала тревоги в
    // служебный канал и при ручном вызове, рассуждая, что «молчание —
    // худший ответ». Молчания здесь нет: весь результат уходит
    // вызывающему синхронно, ответом на этот запрос. А канал засорялся
    // сообщениями о сбоях, которые человек уже видит перед собой.
    return this.runner.run({
      locale,
      theme,
      routeKeys,
      unmasked,
      deviceScaleFactor,
      steps,
      alerts: false,
    });
  }

  /**
   * POST /api/admin/ui-snapshot/tutorial-frames — все четыре кадра
   * секции «Как это выглядит», по одному вызову на все запрошенные
   * локали (этап I, `doc/TUTORIAL-FRAMES-CAPTURE.md`).
   *
   * Отдельный маршрут, а не набор параметров у `run`: тот снимает
   * ЧТО ПРОСЯТ, а этот знает, ЧТО НУЖНО — порядок кадров, сброс
   * черновика между локалями, второй прогон под готовый ролик. Раньше
   * это знание жило таблицей в документе, то есть в голове у того, кто
   * документ недавно читал.
   */
  @Post('tutorial-frames')
  async tutorialFrames(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: { locales?: unknown; theme?: unknown; siteUrl?: unknown },
  ): Promise<CaptureResult> {
    await this.adminPanel.assertOperator(req.userId);

    let locales: string[] = ['ru'];
    if (body.locales !== undefined) {
      if (
        !Array.isArray(body.locales) ||
        body.locales.length === 0 ||
        body.locales.some(
          (l) =>
            typeof l !== 'string' ||
            !(SUPPORTED_LOCALES as readonly string[]).includes(l),
        )
      ) {
        throw new BadRequestException(
          `locales — непустой массив из: ${SUPPORTED_LOCALES.join(', ')}`,
        );
      }
      locales = body.locales as string[];
    }

    let theme: SnapshotTheme | undefined;
    if (body.theme !== undefined) {
      if (body.theme !== 'light' && body.theme !== 'dark') {
        throw new BadRequestException('theme должен быть light или dark');
      }
      theme = body.theme;
    }

    // Чужой сайт в кадре запрещён (§9 ТЗ), и проверить это машиной
    // можно ровно здесь: дальше адрес просто печатается в поле.
    let siteUrl: string | undefined;
    if (body.siteUrl !== undefined) {
      if (
        typeof body.siteUrl !== 'string' ||
        !/^https:\/\//.test(body.siteUrl)
      ) {
        throw new BadRequestException('siteUrl должен быть https-адресом');
      }
      siteUrl = body.siteUrl;
    }

    return this.frames.capture({ locales, theme, siteUrl });
  }
}
