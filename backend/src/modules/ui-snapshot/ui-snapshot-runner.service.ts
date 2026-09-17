/**
 * UiSnapshotRunnerService — крон-воркер `ui-snapshot-run` (Часть А ТЗ,
 * §3 doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 100 — «Фаза 1»
 * дорожной карты §6.1).
 *
 * Обходит фиксированный список маршрутов TMA (§3.8 ТЗ — MVP: `ru`/
 * `light`, 5 маршрутов) настоящим headless-браузером против фикстурного
 * пользователя, снимает скриншот, маскирует заведомо переменные зоны
 * (`[data-qa-mask]`, см. ниже), считает перцептивный хэш
 * (`perceptual-hash.ts`) и сравнивает с хэшем предыдущего снимка ТОЙ ЖЕ
 * комбинации (routeKey × locale × theme). При расхождении — пишет
 * `UiSnapshot.changed = true` и шлёт тревогу через уже существующий
 * `TelegramNotifyService` (§3.7 ТЗ).
 *
 * ## Явный, сознательный пропуск Фазы 0 (§10, пункт 1 аудита; §6.1 ТЗ)
 *
 * §6.1 дорожной карты и пункт 1 аудита (§10) рекомендуют СНАЧАЛА один
 * ручной/разовый прогон (без крона, без прода) — убедиться, что подход
 * вообще ловит что-то полезное чаще, чем шумит, и только потом заводить
 * постоянный крон. Этот шаг здесь СОЗНАТЕЛЬНО пропущен по прямому
 * указанию владельца продукта («реализовать фазу 1 по ТЗ за один
 * проход») — та же модель принятия решений, что действует во всём этом
 * журнале правок (прямое указание — приоритет над собственными
 * рекомендациями ТЗ, см. `## Сделано (этап 100 — ...)` в
 * `PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md`). Практическое следствие:
 * первые несколько прогонов будут больше похожи на ту самую "ручную
 * проверку" (снимки без предыдущей базы для сравнения — `comparedToUrl:
 * null`, `changed: false` по построению, см. `compareToLatest` ниже) —
 * реальная ценность сравнения появится начиная со второго снимка каждого
 * маршрута.
 *
 * ## Общая инфраструктура с Частью Б (§5 ТЗ) — переиспользование, не дублирование
 *
 * `common/headless-chromium.ts` (`launchHeadlessBrowser`/`withTimeout`,
 * этап 95) и `tutorial-runner/route-templates.ts`
 * (`resolveScenarioRoute`/`FixtureRouteContext`, этап 97) — уже готовая,
 * ничем не изменённая здесь общая инфраструктура, ровно то, о чём просит
 * §5 ТЗ («один общий модуль... часть А и часть Б вызывают один и тот же
 * модуль»). Отдельный полноценный «водитель»-модуль (`ui-crawler/`, как
 * дословно предлагает §5) не заведён — вместо этого прямой импорт двух
 * уже существующих чистых функций: не хватает третьей, содержательно
 * общей операции (скриншот-снятие в Части А не нужно Части Б, а
 * интерпретатор шагов `scenario-runner.ts` не нужен Части А), чтобы
 * оправдать отдельный модуль-обёртку поверх них.
 *
 * ## Разрешение фикстуры — сознательное дублирование, не общий сервис
 *
 * Чтение `FIXTURE_TELEGRAM_ID`/`FIXTURE_USER_TOKEN`/`TMA_PUBLIC_URL` и
 * `resolveFixtureContext()` ниже — тот же код, что уже есть в
 * `tutorial-scenario-runner.service.ts`. Не вынесено в общий сервис
 * сознательно: `tutorial-scenario-runner.service.ts` уже отгружен и
 * покрыт полным набором тестов (§5/§6.1 ТЗ, этапы 97/98), рефакторинг
 * его ради переиспользования двадцати строк создал бы риск регресса
 * уже проверенного кода Фазы 2 ради экономии дублирования в новом,
 * независимом от неё коде — тот же принцип "осознанное дублирование, не
 * оплошность", что уже документирует `route-templates.ts` про
 * собственную копию таблицы маршрутов фронтенда.
 *
 * ## Маскирование переменных зон — `data-qa-mask`, не список CSS-селекторов в бэкенде
 *
 * §3.5 ТЗ предлагает "список масок по маршруту" как конфиг на стороне
 * бэкенда; пункт 3 аудита (§10) прямо предупреждает, что такой список
 * незаметно устареет ("маски — это не разовая настройка... такой же
 * пункт чек-листа, как «обнови README»"). Вместо отдельного конфига —
 * единая HTML-разметка `data-qa-mask="<имя>"` прямо на элементах
 * фронтенда, которые реально показывают недетерминированный контент
 * (миниатюра/постер ролика, метка времени — см. `PostprodScreen.tsx`/
 * `VideoPlayer.tsx`, этап 100): перед скриншотом маскируется ВСЁ,
 * подходящее под один универсальный селектор `[data-qa-mask]`, а список
 * того, что именно маскируется, живёт рядом с самим кодом экрана, а не
 * в отдельном файле, который никто не помнит поддерживать.
 *
 * ## §10, пункт 6 аудита — "маршрут не изменился" ≠ "маршрут не удалось проверить"
 *
 * Каждый маршрут обрабатывается в собственном try/catch: сбой навигации/
 * скриншота/Blob-загрузки для ОДНОГО маршрута пишет строку с `error`
 * заполненным и `blobUrl`/`diffScore`/`changed` пустыми/false — НЕ
 * трактуется как "не изменилось" и не прерывает обход остальных
 * маршрутов батча.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import { BlobService } from '../storage/blob.service';
import {
  launchHeadlessBrowser,
  withTimeout,
} from '../../common/headless-chromium';
import {
  FixtureRouteContext,
  resolveScenarioRoute,
} from '../tutorial-runner/route-templates';
import { computeDHash, hasChanged, diffScore } from './perceptual-hash';

/** MVP §3.8 ТЗ — одна локаль, одна тема; поля `UiSnapshot.locale/theme`
 * остаются свободной строкой (не enum) именно для будущего расширения
 * за пределы этой единственной пары. */
const MVP_LOCALE = 'ru';
const MVP_THEME = 'light';

/** Пять маршрутов §3.8 ТЗ — те же, что нужны Части Б для сценариев
 * обучающих видео (§4.5 ТЗ), фикстуры и обоснование выбора не
 * дублируются, см. доккомментарий `route-templates.ts`. */
const MVP_ROUTE_KEYS = [
  'generate',
  'projects',
  'manifests',
  'postprod',
  'postprod-video',
] as const;

/** Общий бюджет времени на весь тик — тот же приём, что
 * `CLEANUP_TIME_BUDGET_MS`/`SWEEP_TIME_BUDGET_MS`
 * (`cron-jobs.service.ts`) и `RUN_DEADLINE_MS`
 * (`tutorial-scenario-runner.service.ts`): пять маршрутов — секунды
 * каждый, но общий бюджет всё равно нужен на случай зависшей навигации.
 */
const RUN_TIME_BUDGET_MS = 2 * 60 * 1000;

/** Таймаут одного маршрута (навигация + маскирование + скриншот) — тот
 * же порядок величины, что у шага сценария в `scenario-runner.ts`
 * (`DEFAULT_STEP_TIMEOUT_MS`), не общий таймаут сценария: здесь на
 * маршрут ровно одна операция, не до тридцати шагов. */
const ROUTE_TIMEOUT_MS = 20_000;

/** Вьюпорт — фиксированный размер мобильного экрана: TMA открывается
 * внутри Telegram на телефоне (§0 ТЗ), а сравнение отпечатков имеет
 * смысл только при одинаковом размере кадра между прогонами. */
const VIEWPORT = { width: 390, height: 844 };

export interface UiSnapshotRouteOutcome {
  routeKey: string;
  changed: boolean;
  error?: string;
}

export interface UiSnapshotRunResult {
  /** Заполнено, если прогон пропущен целиком (фикстура не настроена/не
   * заведена, браузер недоступен) — тот же приём, что
   * `TutorialScenarioRunResult.skipped`. */
  skipped?: string;
  total: number;
  changed: number;
  failed: number;
  outcomes: UiSnapshotRouteOutcome[];
}

@Injectable()
export class UiSnapshotRunnerService {
  private readonly logger = new Logger(UiSnapshotRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: TelegramNotifyService,
    private readonly blob: BlobService,
  ) {}

  async run(): Promise<UiSnapshotRunResult> {
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

    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) {
      this.logger.warn(
        `фикстурный пользователь telegramId=${telegramId} не найден — запустите npm run seed:fixture-user`,
      );
      return this.skip('фикстурный пользователь не заведён');
    }

    const ctx = await this.resolveFixtureContext(user.id);
    const wizardSessionId = await this.ensureWizardSession(user.id);

    const launched = await launchHeadlessBrowser();
    if ('error' in launched) {
      this.logger.warn(`headless-браузер недоступен: ${launched.error}`);
      await this.notify.alert(
        'ui-snapshot-run:browser',
        `Крон-обход UI-снимков: браузер не запустился. ${launched.error}`,
      );
      return {
        total: MVP_ROUTE_KEYS.length,
        changed: 0,
        failed: MVP_ROUTE_KEYS.length,
        outcomes: MVP_ROUTE_KEYS.map((routeKey) => ({
          routeKey,
          changed: false,
          error: launched.error,
        })),
      };
    }

    const { browser } = launched;
    const outcomes: UiSnapshotRouteOutcome[] = [];
    const deadline = Date.now() + RUN_TIME_BUDGET_MS;
    try {
      for (const routeKey of MVP_ROUTE_KEYS) {
        if (Date.now() >= deadline) {
          this.logger.warn(
            `тик исчерпал бюджет времени — ${MVP_ROUTE_KEYS.length - outcomes.length} маршрутов отложено до следующего прогона`,
          );
          break;
        }
        const outcome = await this.captureOne(
          browser,
          routeKey,
          ctx,
          token,
          tmaBaseUrl,
          wizardSessionId,
        );
        outcomes.push(outcome);
        if (outcome.error) {
          await this.notify.alert(
            `ui-snapshot-run:${routeKey}:error`,
            `Крон-обход UI-снимков: маршрут «${routeKey}» не удалось проверить: ${outcome.error}`,
          );
        } else if (outcome.changed) {
          await this.notify.alert(
            `ui-snapshot-run:${routeKey}:changed`,
            `Крон-обход UI-снимков: внешний вид маршрута «${routeKey}» изменился (locale=${MVP_LOCALE}, theme=${MVP_THEME}).`,
          );
        }
      }
    } finally {
      await browser.close().catch(() => undefined);
    }

    return {
      total: MVP_ROUTE_KEYS.length,
      changed: outcomes.filter((o) => o.changed).length,
      failed: outcomes.filter((o) => o.error).length,
      outcomes,
    };
  }

  private async captureOne(
    browser: import('puppeteer-core').Browser,
    routeKey: string,
    ctx: FixtureRouteContext,
    token: string,
    tmaBaseUrl: string,
    wizardSessionId: string | undefined,
  ): Promise<UiSnapshotRouteOutcome> {
    let page: import('puppeteer-core').Page | undefined;
    try {
      const resolved = resolveScenarioRoute(routeKey, ctx);
      if (!resolved.ok) {
        return this.recordFailure(routeKey, resolved.reason);
      }

      page = await browser.newPage();
      await page.setViewport(VIEWPORT);
      // Тот же приём, что `TutorialScenarioRunnerService.runOne` — заголовок
      // уходит со всеми запросами страницы (CDP `Network.setExtraHTTPHeaders`),
      // включая XHR/fetch самого SPA к API бэкенда.
      await page.setExtraHTTPHeaders({ 'X-Fixture-Token': token });
      // Мастер (`useWorkflow`) при пустом `localStorage['sessionId']`
      // создаёт НОВУЮ сессию на каждом монтировании. У свежего
      // headless-браузера хранилище всегда пустое, поэтому каждый тик
      // крона (раз в 2 минуты) оставлял у фикстурного пользователя
      // пустую сессию `created` — в админке это выглядело как поток
      // фейковых сессий. Подкладываем одну постоянную служебную сессию
      // ДО загрузки SPA: мастер её восстанавливает и ничего не создаёт.
      if (wizardSessionId) {
        await page.evaluateOnNewDocument((id: string) => {
          try {
            window.localStorage.setItem('sessionId', id);
          } catch {
            // хранилище недоступно — мастер создаст сессию, как раньше
          }
        }, wizardSessionId);
      }

      const base = tmaBaseUrl.replace(/\/+$/, '');
      const url = `${base}/#${resolved.path}`;

      await withTimeout(
        page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: ROUTE_TIMEOUT_MS,
        }),
        ROUTE_TIMEOUT_MS,
        `навигация не уложилась в ${Math.round(ROUTE_TIMEOUT_MS / 1000)}с`,
      );

      // Маскирование заведомо переменных зон (см. доккомментарий модуля)
      // ПЕРЕД скриншотом — `visibility: hidden`, не `display: none`,
      // чтобы не сдвигать раскладку остального экрана (иначе маскирование
      // само стало бы источником ложных "изменилось").
      await page.evaluate(() => {
        document.querySelectorAll('[data-qa-mask]').forEach((el) => {
          (el as HTMLElement).style.visibility = 'hidden';
        });
      });

      const screenshot = await page.screenshot({ type: 'png' });
      const buffer = Buffer.from(screenshot);
      const hash = await computeDHash(buffer);

      const previous = await this.prisma.uiSnapshot.findFirst({
        where: {
          routeKey,
          locale: MVP_LOCALE,
          theme: MVP_THEME,
          error: null,
        },
        orderBy: { createdAt: 'desc' },
      });

      const pathname = `qa-snapshots/${routeKey}/${MVP_LOCALE}/${MVP_THEME}/${Date.now()}.png`;
      const { url: blobUrl } = await this.blob.uploadBuffer(
        pathname,
        buffer,
        'image/png',
      );

      const changed = previous ? this.compareToLatest(hash, previous) : false;
      const score =
        previous?.diffHash != null ? diffScore(hash, previous.diffHash) : null;

      await this.prisma.uiSnapshot.create({
        data: {
          routeKey,
          locale: MVP_LOCALE,
          theme: MVP_THEME,
          blobUrl,
          comparedToUrl: previous?.blobUrl ?? null,
          diffScore: score,
          changed,
          diffHash: hash,
        },
      });

      return { routeKey, changed };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return this.recordFailure(routeKey, error);
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  private compareToLatest(
    hash: string,
    previous: { diffHash: string | null },
  ): boolean {
    if (!previous.diffHash) return false;
    return hasChanged(hash, previous.diffHash);
  }

  private async recordFailure(
    routeKey: string,
    error: string,
  ): Promise<UiSnapshotRouteOutcome> {
    this.logger.warn(`маршрут ${routeKey}: ${error}`);
    await this.prisma.uiSnapshot
      .create({
        data: {
          routeKey,
          locale: MVP_LOCALE,
          theme: MVP_THEME,
          error,
        },
      })
      .catch(() => undefined);
    return { routeKey, changed: false, error };
  }

  /**
   * ID фикстурных данных (§3.3 ТЗ) — та же логика, что
   * `TutorialScenarioRunnerService.resolveFixtureContext`, сознательно
   * продублированная (см. доккомментарий модуля).
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
      // Экрану готового ролика нужен ГОТОВЫЙ ролик: «последняя сессия
      // пользователя» раньше почти всегда оказывалась пустой, созданной
      // этим же кроном, и снимок `postprod-video` был бессмысленным.
      this.prisma.session.findFirst({
        where: { userId, deletedAt: null, status: 'video_complete' },
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

  /**
   * Одна постоянная служебная сессия для снимка мастера (см. комментарий в
   * `captureOne`). Помечена `data.qaFixture`, чтобы переиспользоваться
   * между тиками; если её удалит `cleanup-sessions` по TTL — заводится
   * заново, то есть не чаще одной за срок жизни сессии, а не 720 в сутки.
   * Сбой здесь не роняет прогон: без неё будет прежнее поведение.
   */
  private async ensureWizardSession(
    userId: string,
  ): Promise<string | undefined> {
    try {
      const existing = await this.prisma.session.findFirst({
        where: {
          userId,
          deletedAt: null,
          data: { path: ['qaFixture'], equals: true },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (existing) return existing.id;
      const created = await this.prisma.session.create({
        data: {
          userId,
          status: 'created',
          data: { locale: MVP_LOCALE, qaFixture: true },
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      this.logger.warn(
        `служебная сессия мастера не заведена: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  private skip(reason: string): UiSnapshotRunResult {
    return { skipped: reason, total: 0, changed: 0, failed: 0, outcomes: [] };
  }
}
