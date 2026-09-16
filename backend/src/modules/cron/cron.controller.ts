import { Controller, Get, Headers, Query } from '@nestjs/common';
import { CronJobsService, VERCEL_CRON_TRIGGERED_BY } from './cron-jobs.service';
import { assertCronSecret } from './cron-secret';

/**
 * CronController
 *
 * Endpoints meant to be invoked by Vercel Cron Jobs (see backend/vercel.json's
 * "crons" array) rather than by the frontend or any human-facing client.
 *
 * Закрыты `CRON_SECRET`: Vercel при вызове крона сам присылает
 * `Authorization: Bearer <CRON_SECRET>` — см.
 * https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
 * Правило проверки (без секрета — закрыто, кроме dev-стенда; сравнение
 * constant-time; почему GET) — в `cron-secret.ts` (этап 54, Б-3.3).
 *
 * Этап 69: вся бизнес-логика переехала в `CronJobsService` — этот
 * контроллер теперь только проверяет секрет и делегирует. Так же
 * `runX()` вызывает и `AdminCronController` (ручной запуск оператором
 * из админки, `POST /admin/cron/:jobKey/run`, закрыт `AdminSessionGuard`
 * вместо секрета) — единственный источник истины на оба вызывающих, см.
 * доккомментарий `cron-jobs.service.ts`.
 *
 * Пятый аудит, Д-4.3: каждый маршрут ниже теперь оборачивает свой
 * `runX()` в `this.jobs.runAndLog(...)` — настоящий Vercel Cron тоже
 * пишет строку в `CronRunLog` (раньше это делал только ручной запуск
 * оператором из админки), и вкладка «Кроны» получает историю реальных
 * автоматических прогонов, а не только ручных.
 */
@Controller('cron')
export class CronController {
  constructor(private readonly jobs: CronJobsService) {}

  /**
   * GET /api/cron/report — суточный отчёт в канал статистики (ТЗ §28).
   *
   * По понедельникам к нему добавляется недельная часть: отдельного
   * расписания под неё заводить незачем — Vercel Hobby считает кроны, а
   * разница между отчётами в одном числе.
   *
   * Ничего не удаляет и ничего не меняет: если Telegram недоступен,
   * маршрут всё равно отвечает 200 с теми же числами — по ним можно
   * посмотреть отчёт руками.
   */
  @Get('report')
  async report(
    @Headers('authorization') authHeader?: string,
  ): Promise<{ sent: boolean; text: string }> {
    assertCronSecret(authHeader);
    return this.jobs.runAndLog('report', VERCEL_CRON_TRIGGERED_BY, false, () =>
      this.jobs.runReport(),
    );
  }

  /**
   * GET /api/cron/blog — суточный крон блога (doc/TODO.md §II.3, ТЗ §36,
   * этап 57): генерация черновиков из YouTube-трендов + очередь перевода
   * xAI Grok Batch API, ОДНИМ маршрутом, а не двумя.
   *
   * Причина одного маршрута, а не отдельных `/cron/blog-generate` и
   * `/cron/blog-translate`: Vercel Hobby считает кроны поштучно, и
   * лимит плана на их число НЕ проверен (ПРОВЕРИТЬ перед добавлением
   * следующего крона — см. doc/PRODUCT-PROJECT-SPEC.md §36) — экономить
   * слоты стоит уже сейчас. Генерация и перевод независимы по данным
   * (перевод обрабатывает то, что УЖЕ одобрено, а не то, что только что
   * сгенерировано в этом же прогоне) и оба сами следят за собственным
   * бюджетом времени, так что последовательный вызов ничем не хуже двух
   * расписаний.
   */
  @Get('blog')
  async blog(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.jobs.runAndLog('blog', VERCEL_CRON_TRIGGERED_BY, false, () =>
      this.jobs.runBlog(),
    );
  }

  /**
   * GET /api/cron/publish — крон-воркер выгрузки одобренных заявок в
   * YouTube/TikTok (этап 61, ТЗ §14.5). Каждый прогон обрабатывает до
   * `publishing.cronBatch` заявок `APPROVED` с назначенным каналом.
   *
   * Расписание «каждые 2 минуты» (см. `backend/vercel.json`) требует, чтобы
   * backend-проект был на плане Vercel Pro — Hobby разрешает крон-задачи
   * не чаще раза в сутки (см. doc/DEPLOYMENT.md, решение владельца
   * продукта зафиксировано в doc/PRODUCT-PROJECT-SPEC.md §14).
   *
   * Best-effort в том же смысле, что у остальных крон-маршрутов: без
   * настроенных `GOOGLE_OAUTH_CLIENT_ID`/`TIKTOK_CLIENT_KEY` и т.п.
   * выборка просто не находит заявок с назначенным каналом (подключить
   * канал без ключей нельзя) — воркер честно отвечает нулями, а не 500.
   */
  @Get('publish')
  async publish(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.jobs.runAndLog('publish', VERCEL_CRON_TRIGGERED_BY, false, () =>
      this.jobs.runPublish(),
    );
  }

  /**
   * GET /api/cron/billing-renew — крон-воркер продления подписок (этап
   * 62, ТЗ §41.4). Раз в сутки (`backend/vercel.json`) — продление
   * помесячное, точность в часы не нужна; в отличие от `/cron/publish`,
   * укладывается в лимиты Vercel Hobby, апгрейд плана для НЕГО не
   * требуется.
   *
   * Best-effort: без настроенных `WAYFORPAY_MERCHANT_*`/бота выборка
   * просто не находит подписок с истёкшим периодом (купить подписку без
   * ключей нельзя) — воркер честно отвечает нулями, а не 500.
   */
  @Get('billing-renew')
  async billingRenew(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.jobs.runAndLog(
      'billing-renew',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      () => this.jobs.runBillingRenew(),
    );
  }

  /**
   * GET /api/cron/marketing-broadcast — рассылка подборки удачных
   * роликов подписчикам рекламного канала (этап 63, ТЗ §42, TODO
   * §III.4). Раз в сутки (`backend/vercel.json`) — сборка нового
   * выпуска (не чаще раза в `marketing.frequencyDays`) и доставка
   * очередной партии, ОДНИМ маршрутом: тот же приём экономии крон-слота,
   * что у `/cron/blog`.
   *
   * Best-effort: без `TELEGRAM_BOT_TOKEN` доставка честно отвечает
   * нулями, а не 500. Ответ Telegram «бот заблокирован» на попытке
   * отправки снимает согласие пользователя в этом же прогоне — см.
   * MarketingBroadcastService.
   */
  @Get('marketing-broadcast')
  async marketingBroadcastCron(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.jobs.runAndLog(
      'marketing-broadcast',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      () => this.jobs.runMarketingBroadcast(),
    );
  }

  /**
   * GET /api/cron/catalog-batch-run — обработка партий пакетной
   * генерации по каталогу (этап 65, ТЗ §44, TODO §III.5). Каждые 1-2
   * минуты (`backend/vercel.json`) — восьмой крон-слот подряд, лимит
   * числа кронов на плане Vercel Hobby не проверен в этой песочнице
   * (тот же прецедент, что у `/cron/publish`/`/cron/blog` и остальных).
   *
   * Один тик обрабатывает до `catalogBatch.cronBatch` товаров партии:
   * создаёт дочернюю сессию, переносит разбор, генерирует и одобряет
   * промпт, стартует рендер — см. CatalogBatchWorkerService.
   */
  @Get('catalog-batch-run')
  async catalogBatchRunCron(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.jobs.runAndLog(
      'catalog-batch-run',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      () => this.jobs.runCatalogBatchRun(),
    );
  }

  /**
   * GET /api/cron/ab-test-run — обработка A/B-вариантов одного ролика
   * (этап 66, TODO §III.6). Каждые 1-2 минуты (`backend/vercel.json`) —
   * девятый крон-слот подряд, тот же непроверенный в этой песочнице
   * лимит числа кронов, что у `/cron/catalog-batch-run` и остальных;
   * работает на уже действующем плане Vercel Pro (тот же, что требует
   * `/cron/publish`), не отдельное новое требование — то же расписание,
   * что у catalog-batch-run (раз в 2 минуты).
   *
   * Один тик обрабатывает до `abTest.cronBatch` вариантов: создаёт
   * дочернюю сессию, переносит разбор, сеет уже готовый текст промпта
   * (без нового вызова GPT-5 — он был один, при создании запуска),
   * одобряет, стартует рендер — см. AbTestWorkerService.
   */
  @Get('ab-test-run')
  async abTestRunCron(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.jobs.runAndLog(
      'ab-test-run',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      () => this.jobs.runAbTestRun(),
    );
  }

  /**
   * GET /api/cron/feed-import-run — импорт товарного фида по ссылке
   * (этап 68, TODO §Уровень 2 п.8, §47). Каждые 1-2 минуты
   * (`backend/vercel.json`) — десятый крон-слот подряд, тот же
   * непроверенный в этой песочнице лимит числа кронов, что у
   * `/cron/catalog-batch-run`/`/cron/ab-test-run` и остальных.
   *
   * Один тик обрабатывает и «забрать фид» (по одному разу на запуск —
   * скачать ссылку, разобрать YML/CSV, завести строки), и «завести
   * позиции» (по пакету строк — превратить разобранную строку в
   * ProductItem через ProjectService.addItem) — см.
   * ProductFeedImportWorkerService.runTick.
   */
  @Get('feed-import-run')
  async feedImportRunCron(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.jobs.runAndLog(
      'feed-import-run',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      () => this.jobs.runFeedImportRun(),
    );
  }

  /**
   * GET /api/cron/export-sync-run — крон-аналог `advanceGenerating()` для
   * автоэкспорта яруса B (этап 76, Е-2.3 шестого аудита). Каждые 1-2
   * минуты (`backend/vercel.json`) — одиннадцатый крон-слот подряд, тот
   * же непроверенный в этой песочнице лимит числа кронов, что у
   * `/cron/catalog-batch-run`/`/cron/ab-test-run`/`/cron/feed-import-run`.
   *
   * Досматривает статус дочерних рендеров яруса B независимо от того,
   * открыт ли у пользователя экран прогресса — см. доккомментарий
   * `ExportService.runSyncTick`.
   */
  @Get('export-sync-run')
  async exportSyncRunCron(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.jobs.runAndLog(
      'export-sync-run',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      () => this.jobs.runExportSyncRun(),
    );
  }

  /**
   * GET /api/cron/tutorial-scenario-generate — генерация сценариев для
   * будущей автозаписи обучающих видео (этап 94,
   * doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §4.10). Раз в сутки
   * (`backend/vercel.json`), а не «каждые 1-2 минуты», как у
   * `/cron/catalog-batch-run` и соседей: §4.11 того же ТЗ прямо просит
   * сценарии генерировать заметно реже, чем идёт бесплатная съёмка —
   * это десять последовательных вызовов Gemini за один прогон, торопиться
   * некуда, а прикидка стоимости платных сценариев только копится в базе
   * до отдельного одобрения оператором.
   *
   * Best-effort в том же смысле, что у остальных крон-маршрутов: без
   * `GEMINI_API_KEY`/`GOOGLE_GEMINI_API_KEY` воркер бросит исключение при
   * создании клиента — прогон целиком считается неудачным (в отличие от
   * «нашли ноль подходящих строк» у большинства соседей, тут нечего
   * найти без самого вызова ИИ).
   */
  @Get('tutorial-scenario-generate')
  async tutorialScenarioGenerateCron(
    @Headers('authorization') authHeader?: string,
  ) {
    assertCronSecret(authHeader);
    return this.jobs.runAndLog(
      'tutorial-scenario-generate',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      () => this.jobs.runTutorialScenarioGenerate(),
    );
  }

  /**
   * GET /api/cron/tutorial-scenario-run — исполнение уже сгенерированных
   * сценариев (этап 97, §5 ТЗ) headless-браузером против фикстурного
   * пользователя (§3.3 ТЗ). Свой крон-слот, через час после `/tutorial-
   * scenario-generate` (`backend/vercel.json`) — то самое окно между
   * генерацией и первым исполнением, за которое платный сценарий должен
   * успеть получить (или не получить) одобрение оператора; запускать их
   * одним проходом обесценило бы это одобрение.
   *
   * Best-effort в другом смысле, чем у соседей: без `FIXTURE_USER_TOKEN`/
   * `FIXTURE_TELEGRAM_ID`/`TMA_PUBLIC_URL` или незаведённого фикстурного
   * пользователя воркер не бросает — отдаёт `{skipped: string}` и
   * логирует предупреждение (см. `TutorialScenarioRunnerService`): это
   * ожидаемое состояние стенда до того, как оператор один раз настроит
   * фикстуру, а не поломка, достойная 500 и записи FAILED на каждом
   * ночном прогоне.
   */
  @Get('tutorial-scenario-run')
  async tutorialScenarioRunCron(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.jobs.runAndLog(
      'tutorial-scenario-run',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      () => this.jobs.runTutorialScenarioRun(),
    );
  }

  /**
   * GET /api/cron/ui-snapshot-run — крон-обход интерфейса TMA (этап 100,
   * §3 doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, «Фаза 1»).
   * Расписание — раз в две минуты (`backend/vercel.json`) — тот же темп,
   * что у `/cron/catalog-batch-run` и соседей (§3.6 ТЗ: батчинг по
   * времени, а не по числу маршрутов за раз).
   *
   * Best-effort в том же смысле, что `/tutorial-scenario-run`: без
   * `FIXTURE_USER_TOKEN`/`FIXTURE_TELEGRAM_ID`/`TMA_PUBLIC_URL` или
   * незаведённого фикстурного пользователя воркер не бросает — отдаёт
   * `{skipped: string}` (см. `UiSnapshotRunnerService`), а не 500 на
   * каждом прогоне стенда до однократной настройки фикстуры оператором.
   */
  @Get('ui-snapshot-run')
  async uiSnapshotRunCron(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.jobs.runAndLog(
      'ui-snapshot-run',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      () => this.jobs.runUiSnapshotRun(),
    );
  }

  /**
   * GET /api/cron/cleanup-sessions
   *
   * Deletes sessions older than SESSION_TTL_HOURS. Also prunes expired
   * `AdminSession`/`UserSession` rows, unused library entries, and (этап 89)
   * physically purges Project/ProductItem/Session soft-deleted past their
   * grace period — см. доккомментарий на `CronJobsService.runCleanupSessions`.
   *
   * Scheduled to run once daily via Vercel Cron (backend/vercel.json) — the
   * fastest interval Hobby allows, and it matches the default 24h TTL.
   */
  @Get('cleanup-sessions')
  async cleanupSessions(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    return this.jobs.runAndLog(
      'cleanup-sessions',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      () => this.jobs.runCleanupSessions(),
    );
  }

  /**
   * GET /api/cron/sweep-orphans?cursor=&limit=
   *
   * Метла по префиксу `sessions/` и ещё трём областям (doc/
   * STORAGE-AUDIT.md, этап 27, 41, 47) — см. доккомментарий на
   * `CronJobsService.runSweepOrphans`. `dryRun=1` по-прежнему показывает,
   * что БЫЛО БЫ удалено, ничего не трогая.
   */
  @Get('sweep-orphans')
  async sweepOrphans(
    @Headers('authorization') authHeader?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('minAgeHours') minAgeHours?: string,
    @Query('dryRun') dryRun?: string,
  ) {
    assertCronSecret(authHeader);
    // debugMode здесь отражает РЕАЛЬНЫЙ dryRun query-параметра — тот же
    // смысл, что у ручного запуска из админки, где debug тоже маппится
    // на dryRun (см. AdminCronService.dispatch).
    const debugMode = dryRun === '1' || dryRun === 'true';
    return this.jobs.runAndLog(
      'sweep-orphans',
      VERCEL_CRON_TRIGGERED_BY,
      debugMode,
      () => this.jobs.runSweepOrphans({ cursor, limit, minAgeHours, dryRun }),
    );
  }
}
