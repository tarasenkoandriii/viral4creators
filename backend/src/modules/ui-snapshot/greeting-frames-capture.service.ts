/**
 * Съёмка четырёх настоящих кадров «Как это работает» страницы
 * поздравлений (этап I ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`, §5.3; порядок
 * работы — `doc/GREETING-FRAMES-CAPTURE.md`).
 *
 * Близнец `tutorial-frames-capture.service.ts`, и по той же причине
 * отдельный сервис, а не «оператор шлёт параметры руками»: знание
 * «какой кадр — с какого маршрута и какой секции» иначе жило бы
 * таблицей в документе и разошлось бы с мастером при первой правке.
 *
 * ## Чем съёмка отличается от кадров обучалки
 *
 * - **Шагов нет.** Все четыре состояния лежат в базе: бриф, собранный
 *   сценарий и готовый ролик — это разные фикстурные проекты
 *   (`FIXTURE_IDS.greeting*`), и состояние задаёт адрес. Мгновенных
 *   состояний браузера, ради которых обучалке понадобились `steps`,
 *   здесь нет.
 * - **Есть прокрутка.** Мастер — одна лента из девяти карточек, кадр —
 *   окно телефона. Каждый кадр ставит экран к своей секции
 *   (`UiSnapshotRunOptions.scrollTo`), иначе все четыре показали бы бриф.
 * - **Личный текст скрыт.** Имена, пожелание и текст сценария помечены
 *   `data-qa-mask="personal-…"` и размываются в любом режиме
 *   (`PERSONAL_TEXT_MASK_PREFIX`): выдуманное имя на маркетинговом кадре
 *   запрещено (§5.5 образца), а кадр мастера без имён не снять.
 * - **Ролик — только фикстурный.** Кадр 4 снимается с проекта
 *   `greetingDoneProject`, ролик в нём рендерит оператор
 *   (`fixtureVideo` ниже). Роликов пользователей съёмка не касается ни
 *   одним запросом: маршрут резолвится по проектам фикстурного
 *   пользователя.
 *
 * ## Где автоматизация заканчивается
 *
 * Как и у обучалки: отбор кадра глазами (§3 документа) и коммит файлов
 * в `landing/public/illustrations/` плюс локаль в
 * `GREETING_REAL_FRAME_LOCALES` — это решение человека, а не сервера.
 */

import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { sessionData } from '../../common/session.service';
import {
  GenerationStatus,
  type GeneratedVideo,
} from '../../common/types/generation.types';
import { GreetingPromptService } from '../greeting-prompt/greeting-prompt.service';
import { GreetingVideoService } from '../greeting-video/greeting-video.service';
import { GreetingSessionEditService } from '../greeting-session-edit/greeting-session-edit.service';
import { PostProductionService } from '../postprod/postprod.service';
import { FIXTURE_IDS } from '../tutorial-runner/fixture-seed';
import { CAPTURE_DEVICE_SCALE_FACTOR } from '../tutorial-runner/tutorial-video-assembly';
import {
  UiSnapshotRunnerService,
  type SnapshotTheme,
} from './ui-snapshot-runner.service';
import type {
  CaptureResult,
  CapturedLocale,
} from './tutorial-frames-capture.service';

export interface GreetingFrameShot {
  /** Номер кадра на странице (1…4) — он же `<n>` в `greet-shot-<locale>-<n>.avif`. */
  card: number;
  routeKey: string;
  /** Секция, с которой начинается кадр. `data-qa` — не текст: кадры
   *  снимаются в пяти локалях. */
  scrollTo: string;
}

/**
 * Что на каком кадре. Порядок и число — сюжеты §5.2 п.3 ТЗ: повод и
 * бриф → «Характер ролика» → сценарий → готовый ролик
 * (`GREETING_FRAME_COUNT` лендинга; сверяет спек).
 *
 * Кадры 2 и 3 — один проект («сценарий собран»), разные секции: блок
 * «Характер ролика» рисуется только при собранном сценарии, а сценарий
 * на экране готового ролика уже не правится — снимать его там значило
 * бы показать выключенное.
 */
export const GREETING_FRAME_SHOTS: readonly GreetingFrameShot[] = [
  {
    card: 1,
    routeKey: 'greeting-video',
    scrollTo: '[data-qa="greeting-brief-card"]',
  },
  {
    card: 2,
    routeKey: 'greeting-video-ready',
    scrollTo: '[data-qa="greeting-character-block"]',
  },
  {
    card: 3,
    routeKey: 'greeting-video-ready',
    scrollTo: '[data-qa="greeting-script-card"]',
  },
  {
    card: 4,
    routeKey: 'greeting-video-done',
    scrollTo: '[data-qa="greeting-video-card"]',
  },
];

/** Подсказка к самой частой причине пустого кадра 4 — у фикстуры ещё нет
 *  ролика. Без неё оператор получил бы «нужны фикстурные данные
 *  (greetingDoneProjectId)» и пошёл бы пересевать фикстуру, а это не
 *  поможет: ролик заводит не сид, а рендер. */
export const FIXTURE_VIDEO_HINT =
  'у фикстуры нет готового ролика — сначала POST /api/admin/ui-snapshot/greeting-frames/fixture-video (повторять, пока stage не станет complete)';

/**
 * Что делать с роликом фикстуры по его текущему состоянию. Чистая
 * функция — ради того, чтобы «не платить дважды» проверялось без базы:
 * повторный вызов кнопки обязан опрашивать идущий рендер и возвращать
 * готовый, а не запускать новый.
 */
export type FixtureVideoAction =
  | 'none'
  | 'poll'
  | 'poll-post'
  | 'script-and-render'
  | 'render'
  /** Готовый ролик переснять: новая версия сессии и рендер её (CONTRACT6). */
  | 'new-version-render';

export function fixtureVideoAction(state: {
  hasPrompt: boolean;
  videoStatus: string | null | undefined;
  /** `postStatus` готового ролика: своя озвучка кладётся постобработкой
   *  ПОСЛЕ того, как рендер уже `complete` (аудит этапа I). */
  postStatus?: string | null;
  /** Готовый ролик не прошёл отбор глазами — снять заново, тем же
   *  сценарием. Только явным флагом: по умолчанию готовое не трогаем. */
  rerender?: boolean;
}): FixtureVideoAction {
  if (state.videoStatus === GenerationStatus.COMPLETE) {
    // Постобработка идёт — только опрос, и `rerender` её не перебивает:
    // новый рендер поверх идущей озвучки оплатил бы обе работы, а
    // слушать ролик до её конца бессмысленно — голоса в нём ещё нет.
    if (state.postStatus === 'pending') return 'poll-post';
    // Готовый ролик на месте не перерендеривается (409
    // GREETING_VIDEO_ALREADY_READY, §3.6 ТЗ): переснять — значит завести
    // новую версию сессии тем же сценарием и рендерить её.
    return state.rerender ? 'new-version-render' : 'none';
  }
  if (
    state.videoStatus === GenerationStatus.PENDING ||
    state.videoStatus === GenerationStatus.PROCESSING
  ) {
    return 'poll';
  }
  // Ролика нет или он упал. Сценарий — настоящим конвейером, а не
  // текстом из сида: написанный руками текст ушёл бы в ролик, который
  // показывает лендинг.
  return state.hasPrompt ? 'render' : 'script-and-render';
}

export interface FixtureVideoResult {
  /** Заполнено — ничего не делалось: фикстура не настроена или не заведена. */
  skipped?: string;
  sessionId?: string;
  /**
   * `started` — рендер запущен (платно), дальше повторять вызов;
   * `rendering` — идёт, опрошен; `post-processing` — картинка готова,
   * но постобработка (своя озвучка) ещё идёт: слушать рано, повторять
   * вызов; `complete` — готов вместе с постобработкой, кадр 4 можно
   * снимать (если постобработка упала — см. `postError`); `failed` —
   * провайдер отказал, следующий вызов запустит рендер заново (и снова
   * платно).
   */
  stage?: 'started' | 'rendering' | 'post-processing' | 'complete' | 'failed';
  /** Постобработка упала: ролик есть, но без своей озвучки — на отборе
   *  его, скорее всего, придётся переснять (`rerender`). */
  postError?: string;
  video?: GeneratedVideo;
}

/**
 * Стадия по итоговому ролику. Отдельно и чисто — ради того, что аудит
 * этапа I нашёл здесь: `complete` отдавался, как только рендер Grok
 * готов, а постобработка (`postprod.start`) ещё только поставила
 * `postStatus: 'pending'`. Оператор слушал ролик без своего голоса и
 * отбраковывал годный.
 */
export function fixtureVideoStage(
  video: GeneratedVideo | undefined,
  started: boolean,
): NonNullable<FixtureVideoResult['stage']> {
  if (video?.status === GenerationStatus.COMPLETE) {
    return video.postStatus === 'pending' ? 'post-processing' : 'complete';
  }
  if (video?.status === GenerationStatus.FAILED) return 'failed';
  return started ? 'started' : 'rendering';
}

/** Все шаги `fixtureVideo` — для разбора `expect` в контроллере. */
export const FIXTURE_VIDEO_ACTIONS: readonly FixtureVideoAction[] = [
  'none',
  'poll',
  'poll-post',
  'script-and-render',
  'render',
  'new-version-render',
];

/** Шаги `fixtureVideo`, которые платят (сценарий и/или рендер Grok). */
export const PAID_FIXTURE_VIDEO_ACTIONS: readonly FixtureVideoAction[] = [
  'script-and-render',
  'render',
  'new-version-render',
];

/**
 * `GET …/greeting-frames/fixture-video/state` — состояние ролика фикстуры
 * ТОЛЬКО ЧТЕНИЕМ базы (заход 8, страница админки «Кадры лендинга
 * поздравлений»). Провайдера не опрашивает и ничего не двигает: ради
 * этого `POST` остался единственным, кто двигает состояние, а странице
 * нужно знать до нажатия, заплатит ли нажатие.
 */
export interface FixtureVideoState {
  /** Заполнено — смотреть нечего: фикстура не настроена или не заведена. */
  skipped?: string;
  sessionId?: string;
  /** Когда заведена текущая (последняя) версия сессии проекта. */
  sessionCreatedAt?: string;
  /** Версий сессии у проекта: каждая «переснять» заводит новую. */
  versions?: number;
  hasPrompt?: boolean;
  /** `missing` — ролика ещё нет; остальное — как у `POST` (без `started`). */
  stage?: 'missing' | NonNullable<FixtureVideoResult['stage']>;
  video?: {
    status: string;
    postStatus: string | null;
    postError: string | null;
    error: string | null;
    downloadUrl: string | null;
    initiatedAt: string | null;
    completedAt: string | null;
    resolution: string | null;
  };
  /** Что сделает `POST` без `rerender` и заплатит ли. */
  next?: { action: FixtureVideoAction; paid: boolean };
  /** Что сделает `POST {rerender: true}`; `null` — переснимать нечего/рано. */
  rerender?: { action: FixtureVideoAction; paid: boolean } | null;
  /**
   * Сколько стоил последний прогон с рендером — по журналу расходов
   * (`ai_usage`, все операции той версии сессии: сценарий, рендер,
   * постобработка). `null` — записей нет (рендера не было или месяц уже
   * свёрнут): оценку тогда называть без числа.
   */
  lastRun?: {
    sessionId: string;
    costMicroUsd: number;
    /** Часть вызовов без ставки в прайсе — сумма занижена. */
    unpriced: boolean;
    at: string;
  } | null;
}

function isoOrNull(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'string' && v ? v : null;
}

@Injectable()
export class GreetingFramesCaptureService {
  private readonly logger = new Logger(GreetingFramesCaptureService.name);

  constructor(
    private readonly runner: UiSnapshotRunnerService,
    private readonly prisma: PrismaService,
    private readonly prompt: GreetingPromptService,
    private readonly video: GreetingVideoService,
    // `@Global()` — модуль импортировать не нужно. Опрос постобработки
    // ничего не запускает и не оплачивает: он забирает результат уже
    // идущей задачи, как это делает опрос статуса у товарки.
    private readonly postprod: PostProductionService,
    // Новая версия сессии под перерендер готового ролика (CONTRACT6).
    private readonly edits: GreetingSessionEditService,
  ) {}

  async capture(options: {
    locales: readonly string[];
    theme?: SnapshotTheme;
  }): Promise<CaptureResult> {
    const theme: SnapshotTheme = options.theme ?? 'dark';
    const user = await this.runner.findFixtureUser();
    if (!user) {
      return { skipped: 'фикстурный вход не настроен', locales: [] };
    }

    const locales: CapturedLocale[] = [];
    for (const locale of options.locales) {
      const cards: Record<number, string> = {};
      const problems: string[] = [];
      for (const shot of GREETING_FRAME_SHOTS) {
        const result = await this.runner.run({
          routeKeys: [shot.routeKey],
          locale,
          theme,
          unmasked: true,
          deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
          scrollTo: shot.scrollTo,
          alerts: false,
        });
        if (result.skipped) {
          // Прогон не начинался (браузера нет, фикстурный вход не
          // настроен) — следующие кадры упрутся в то же самое, и
          // четыре одинаковых строки ничего не добавят.
          problems.push(result.skipped);
          break;
        }
        const outcome = result.outcomes[0];
        if (outcome?.error) {
          const hint =
            shot.card === 4 && outcome.error.includes('greetingDoneProjectId')
              ? ` — ${FIXTURE_VIDEO_HINT}`
              : '';
          problems.push(`кадр ${shot.card}: ${outcome.error}${hint}`);
        } else if (outcome?.blobUrl) {
          cards[shot.card] = outcome.blobUrl;
        }
      }
      const missing = GREETING_FRAME_SHOTS.map((s) => s.card).filter(
        (n) => !cards[n],
      );
      if (missing.length > 0) {
        problems.push(`не сняты карточки: ${missing.join(', ')}`);
      }
      this.logger.log(
        `кадры поздравлений (${locale}): снято ${
          GREETING_FRAME_SHOTS.length - missing.length
        } из ${GREETING_FRAME_SHOTS.length}` +
          (problems.length > 0 ? `; ${problems.join('; ')}` : ''),
      );
      locales.push({ locale, cards, problems });
    }
    return { locales };
  }

  /**
   * Состояние ролика фикстуры без единого внешнего вызова (см.
   * `FixtureVideoState`). Та же цель, что у `fixtureVideo`: последняя
   * сессия проекта `FIXTURE_IDS.greetingDoneProject` фикстурного
   * пользователя.
   */
  async fixtureVideoState(): Promise<FixtureVideoState> {
    const user = await this.runner.findFixtureUser();
    if (!user) return { skipped: 'фикстурный вход не настроен' };
    const rows = (await this.prisma.session.findMany({
      where: {
        userId: user.id,
        projectId: FIXTURE_IDS.greetingDoneProject,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, data: true, liveData: true },
    })) as Array<{
      id: string;
      createdAt: Date;
      data: unknown;
      liveData: unknown;
    }>;
    const row = rows[0];
    if (!row) {
      return {
        skipped:
          'у проекта под кадр «готовый ролик» нет сессии — заведите фикстуру (seed-fixture-user)',
      };
    }
    const data = sessionData(row);
    const current = data.generatedVideo as GeneratedVideo | undefined;
    const base = {
      hasPrompt: !!data.generationPrompt,
      videoStatus: current?.status ?? null,
      postStatus: current?.postStatus ?? null,
    };
    const next = fixtureVideoAction(base);
    const again = fixtureVideoAction({ ...base, rerender: true });
    const paid = (a: FixtureVideoAction) =>
      PAID_FIXTURE_VIDEO_ACTIONS.includes(a);
    return {
      sessionId: row.id,
      sessionCreatedAt: row.createdAt.toISOString(),
      versions: rows.length,
      hasPrompt: base.hasPrompt,
      stage: current ? fixtureVideoStage(current, false) : 'missing',
      ...(current
        ? {
            video: {
              status: String(current.status),
              postStatus: current.postStatus ?? null,
              postError: current.postError ?? null,
              error: current.error?.message ?? null,
              downloadUrl: current.downloadUrl ?? null,
              initiatedAt: isoOrNull(current.initiatedAt),
              completedAt: isoOrNull(current.completedAt),
              resolution: current.resolution ?? null,
            },
          }
        : {}),
      next: { action: next, paid: paid(next) },
      // `rerender` меняет что-то только у готового ролика без идущей
      // постобработки — иначе тот же шаг, что и без него.
      rerender: again !== next ? { action: again, paid: paid(again) } : null,
      lastRun: await this.lastRunCost(rows.map((r) => r.id)),
    };
  }

  /** Расход последней версии сессии, в которой был рендер (`generation`). */
  private async lastRunCost(
    sessionIds: string[],
  ): Promise<FixtureVideoState['lastRun']> {
    if (sessionIds.length === 0) return null;
    const usage = (await this.prisma.aiUsage.findMany({
      where: { sessionId: { in: sessionIds } },
      select: {
        sessionId: true,
        operation: true,
        costMicroUsd: true,
        unpriced: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })) as Array<{
      sessionId: string | null;
      operation: string;
      costMicroUsd: number;
      unpriced: boolean;
      createdAt: Date;
    }>;
    const render = usage.find((u) => u.operation === 'generation');
    if (!render?.sessionId) return null;
    const same = usage.filter((u) => u.sessionId === render.sessionId);
    return {
      sessionId: render.sessionId,
      costMicroUsd: same.reduce((sum, u) => sum + u.costMicroUsd, 0),
      unpriced: same.some((u) => u.unpriced),
      at: render.createdAt.toISOString(),
    };
  }

  /**
   * Довести ролик фикстуры до готового — по шагу за вызов (платно).
   *
   * Цель — строго проект `FIXTURE_IDS.greetingDoneProject` фикстурного
   * пользователя, а не «самый свежий проект в таком-то состоянии»:
   * признак по содержанию годится, чтобы ОТКРЫТЬ экран, но платное
   * действие должно попадать ровно туда, куда задумано.
   *
   * Сессия — последняя сессия проекта, как её читает мастер: правка
   * брифа могла увести в новую версию, и ролик в старой кадр не показал
   * бы.
   *
   * Ролик рендерится с ТЕМИ ЖЕ проверками, что по кнопке человека
   * (`GreetingVideoService.startVideo`: сценарий, модерация, правила
   * повода, лимиты фикстуры) — обходного пути мимо них здесь нет.
   */
  async fixtureVideo(
    options: {
      rerender?: boolean;
      /**
       * Какой шаг ждёт вызывающий (по `fixtureVideoState`). Между его
       * чтением и этим вызовом рендер мог упасть — и «опросить» стало бы
       * платным повтором без вопроса (TOCTOU, аудит захода 8). Задан, а
       * фактический шаг платный и другой — 409
       * `GREETING_FIXTURE_ACTION_CHANGED`, ничего не делается. Не задан —
       * как раньше (ручной вызов по документу).
       */
      expect?: FixtureVideoAction;
    } = {},
  ): Promise<FixtureVideoResult> {
    const user = await this.runner.findFixtureUser();
    if (!user) return { skipped: 'фикстурный вход не настроен' };
    const row = (await this.prisma.session.findFirst({
      where: {
        userId: user.id,
        projectId: FIXTURE_IDS.greetingDoneProject,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, data: true, liveData: true },
    })) as { id: string; data: unknown; liveData: unknown } | null;
    if (!row) {
      return {
        // Сессии нет в двух случаях: фикстуру не заводили, или крон
        // уборки снёс сессию до рендера (`cleanupExpiredSessions` удаляет
        // физически всё, кроме готовых роликов). Лекарство одно —
        // пересев: он заводит сессию заново тем же `greetingBriefSnapshotFrom`.
        // Здесь её НЕ воссоздаём сознательно — второй способ завести
        // фикстурную сессию разошёлся бы с сидом на первой его правке.
        skipped:
          'у проекта под кадр «готовый ролик» нет сессии (фикстуру не заводили или крон уборки снёс сессию до рендера) — POST /api/admin/tutorial-runner/seed-fixture-user и повторите',
      };
    }
    const data = sessionData(row);
    const current = data.generatedVideo as GeneratedVideo | undefined;
    const action = fixtureVideoAction({
      hasPrompt: !!data.generationPrompt,
      videoStatus: current?.status ?? null,
      postStatus: current?.postStatus ?? null,
      rerender: options.rerender === true,
    });
    if (
      options.expect !== undefined &&
      action !== options.expect &&
      PAID_FIXTURE_VIDEO_ACTIONS.includes(action)
    ) {
      throw new ConflictException({
        code: 'GREETING_FIXTURE_ACTION_CHANGED',
        message: `Состояние ролика изменилось: сервер выполнил бы платный шаг «${action}» вместо ожидаемого «${options.expect}». Ничего не запущено — обновите состояние и подтвердите платный шаг.`,
      });
    }
    this.logger.log(`ролик фикстуры (${row.id}): ${action}`);

    let video: GeneratedVideo | undefined = current;
    let started = false;
    let sessionId = row.id;
    switch (action) {
      case 'none':
        break;
      case 'poll':
        video = (await this.video.pollVideo(row.id)) ?? current;
        break;
      case 'poll-post':
        video = current ? await this.postprod.poll(row.id, current) : current;
        break;
      case 'script-and-render':
        await this.prompt.generateGreetingPrompt(row.id);
        video = await this.video.startVideo(row.id);
        started = true;
        break;
      case 'render':
        video = await this.video.startVideo(row.id);
        started = true;
        break;
      case 'new-version-render': {
        // Новая версия — последняя сессия проекта: следующий вызов (опрос)
        // и мастер найдут именно её, а прежний ролик останется в старой.
        const fork = await this.edits.forkForRerender(row.id);
        sessionId = fork.sessionId;
        if (!fork.promptKept) {
          await this.prompt.generateGreetingPrompt(sessionId);
        }
        video = await this.video.startVideo(sessionId);
        started = true;
        break;
      }
    }
    const stage = fixtureVideoStage(video, started);
    return {
      sessionId,
      stage,
      video,
      ...(stage === 'complete' && video?.postStatus === 'failed'
        ? { postError: video.postError ?? 'постобработка упала без причины' }
        : {}),
    };
  }
}
