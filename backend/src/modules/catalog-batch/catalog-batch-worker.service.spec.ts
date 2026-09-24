import { CatalogBatchWorkerService } from './catalog-batch-worker.service';
import { RenderAccessService } from '../render-access/render-access.service';
import { DailySpendLimitExceededException } from '../../common/spend-limits';
import { VeoOperationOrphanedError } from '../generation/generation.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

const configState = { cronBatch: 5, maxAttempts: 3 };
jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({ catalogBatch: configState }),
}));

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item1',
    batchId: 'batch1',
    productItemId: 'pi1',
    sessionId: null,
    attempts: 0,
    // Этап 78 — из какой ветки OR (`PENDING`/просроченный `FAILED`)
    // пришла строка, нужно как fromStage событию воронки.
    status: 'PENDING',
    ...overrides,
  };
}

function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'batch1',
    projectId: 'proj1',
    userId: 'user1',
    libraryEntryId: 'entry1',
    quality: 'fast',
    aspectRatio: '9:16',
    locale: 'ru',
    ...overrides,
  };
}

/** Тот же класс, что реальный `ForbiddenException` из `@nestjs/common` в
 * плане имени: сервис отличает временные сбои от «не повторять» по
 * `error.constructor.name` (см. `NON_RETRYABLE_NAMES` в самом сервисе),
 * а не по `.name` — `Object.assign(new Error(...), {name: ...})`
 * подделывает только `.name`, `.constructor.name` у него остаётся
 * `'Error'`, и тест был бы неверным индикатором реального поведения. */
class ForbiddenException extends Error {}

function generatingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gitem1',
    batchId: 'batch1',
    productItemId: 'gpi1',
    sessionId: 'sess-generating',
    ...overrides,
  };
}

function setup(
  opts: {
    rows?: unknown[];
    claimCount?: number;
    batch?: unknown;
    /** Строки Д-1.1-досмотра (`status: 'GENERATING'`) — по умолчанию
     * пусто, чтобы существующие тесты выборки новых строк не задевали
     * этот путь вовсе. */
    generatingRows?: unknown[];
    generatingClaimCount?: number;
    /** Что вернёт `generation.getVideoStatus` для строк из
     * `generatingRows` — по умолчанию нейтральное «всё ещё идёт». */
    videoStatus?: unknown;
    /** Состояние сессии, которое видит `processOne` (Д-2.5) — по
     * умолчанию пустое (ни промпт не одобрен, ни рендер не стартован),
     * так что все существующие тесты полного пути проходят все шаги
     * как раньше. */
    sessionState?: unknown;
    /** Джоб-уровневый замок (Д-3.3) уже удерживается другим прогоном —
     * по умолчанию `false` (замок свободен, `runBatch()` выполняется как
     * раньше для всех существующих тестов). */
    jobLockHeld?: boolean;
    /** Доп. запрос владельца продукта (ТЗ §13, этап 2 плана §14) —
     * партии с `provider: 'grok'`, готовые к подаче/уже поданные в xAI
     * Batch API — по умолчанию пусто, существующие Veo-тесты не видят
     * разницы. */
    grokRuns?: unknown[];
    /** Партии provider='grok' с уже поданной пачкой (`xaiBatchId` не
     * null) и хотя бы одной GENERATING-строкой — для
     * `pollInFlightGrokBatches()`, отдельно от `grokRuns` выше (та
     * ветка ищет партии БЕЗ поданной пачки). */
    grokInFlightRuns?: unknown[];
    /** М-3.6: партии с оборвавшейся подачей (`xaiBatchId` = `pending:<ts>`). */
    grokPendingRuns?: unknown[];
    /** Счётчик `catalogBatchItem.count` (используется
     * `submitReadyGrokBatches()` для проверки готовности партии к
     * подаче) — по умолчанию 0, партия сразу отсекается как «нет строк
     * в очереди», существующие тесты не задевают этот путь. */
    /** `submitReadyGrokBatches()` — сколько строк уже `BATCH_QUEUED`
     * для партии по умолчанию (0 — партия не готова, путь не идёт
     * дальше). */
    grokQueuedCount?: number;
    /** То же — сколько строк ещё НЕ дошли до готовности (PENDING или
     * ожидающий повтора FAILED); ненулевое значение блокирует подачу
     * даже при непустой очереди. */
    grokNotReadyCount?: number;
    grokSubmitResult?: unknown;
    grokBatchStatus?: unknown;
    grokBatchResults?: Record<string, string>;
    grokBatchResultsComplete?: boolean;
    /** Строки в `submitReadyGrokBatches()` (полные данные для подачи —
     * id/sessionId/productItemId), возвращаемые вторым `findMany`
     * (после проверки `count`, см. выше). */
    grokQueuedItems?: unknown[];
    /** Строки в `pollInFlightGrokBatches()` (уже `GENERATING`,
     * пришедшие через Grok-пачку, отличаются от `generatingRows`
     * наличием `batchId` в запросе). */
    grokGeneratingItems?: unknown[];
    /** Найдено при аудите (ТЗ §13, этап 2 плана §14) — переопределяет
     * щедрый дефолт `aiUsage.budget()` для теста, который проверяет
     * саму находку (бюджет не покрывает партию → все строки FAILED). */
    aiUsageBudget?: {
      allowed: boolean;
      limitMicroUsd: number;
      spentMicroUsd: number;
      remainingMicroUsd: number;
    };
  } = {},
) {
  const generatingIds = new Set(
    (opts.generatingRows ?? []).map((r) => (r as { id: string }).id),
  );
  const prisma = {
    catalogBatchItem: {
      // Три-четыре РАЗНЫХ запроса делят один мок: Д-1.1-досмотр
      // (`where.status === 'GENERATING'`, без `batchId` — весь проект),
      // выборка новых/просроченных строк (`where.OR`), подача Grok-
      // пачки (`where.status === 'BATCH_QUEUED'`) и опрос Grok-пачки
      // (`where.status === 'GENERATING'` СО `batchId` — одна партия,
      // §13 ТЗ, этап 2 плана §14) — различаем по форме `where`, а не по
      // порядку вызова.
      findMany: jest.fn(
        (args: { where?: { status?: string; batchId?: string } } = {}) => {
          if (args?.where?.status === 'BATCH_QUEUED') {
            return Promise.resolve(opts.grokQueuedItems ?? []);
          }
          if (args?.where?.status === 'GENERATING' && args?.where?.batchId) {
            return Promise.resolve(opts.grokGeneratingItems ?? []);
          }
          return Promise.resolve(
            args?.where?.status === 'GENERATING'
              ? (opts.generatingRows ?? [])
              : (opts.rows ?? []),
          );
        },
      ),
      // Claim, тот же приём, что у PublishWorkerService (Г-2.11) — по
      // умолчанию всегда успешно захвачена; различаем по id строки, а
      // не по вызову, чтобы досмотр и обработка новых строк могли
      // независимо получать разные claimCount в одном тесте.
      updateMany: jest.fn((args: { where?: { id?: string } } = {}) =>
        Promise.resolve({
          count: generatingIds.has(args?.where?.id ?? '')
            ? (opts.generatingClaimCount ?? 1)
            : (opts.claimCount ?? 1),
        }),
      ),
      update: jest.fn().mockResolvedValue(undefined),
      // Доп. запрос владельца продукта (ТЗ §13, этап 2 плана §14) —
      // безопасный дефолт для существующих тестов, которые не знают
      // про Grok-пачки: ноль строк «не готовы к подаче» и ноль
      // «в очереди» — `submitReadyGrokBatches()` сразу отсекается по
      // `queuedCount === 0` и не идёт дальше, не трогая остальные моки.
      // Различаем два разных запроса по форме `where`, тот же приём,
      // что у `findMany` выше.
      count: jest.fn((args: { where?: { status?: string } } = {}) =>
        Promise.resolve(
          args?.where?.status === 'BATCH_QUEUED'
            ? (opts.grokQueuedCount ?? 0)
            : (opts.grokNotReadyCount ?? 0),
        ),
      ),
    },
    catalogBatchRun: {
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.batch === undefined ? batchRow() : opts.batch),
      // Доп. запрос владельца продукта (ТЗ §13) — по умолчанию нет
      // Grok-партий вовсе, `submitReadyGrokBatches()`/
      // `pollInFlightGrokBatches()` сразу возвращают пустой список и
      // не делают ничего — существующие Veo-сценарии не видят разницы.
      // Различаем два запроса по форме `where.xaiBatchId`: `null` —
      // подача (ищет партии БЕЗ поданной пачки), объект `{not: null}` —
      // опрос (партии С уже поданной пачкой).
      findMany: jest.fn((args: { where?: { xaiBatchId?: unknown } } = {}) => {
        const key = args?.where?.xaiBatchId as
          | null
          | { not?: unknown; startsWith?: string }
          | undefined;
        // М-3.6: третья форма — `{ startsWith: 'pending:' }` (поиск
        // оборвавшихся подач) — по умолчанию пусто.
        if (key && typeof key === 'object' && 'startsWith' in key) {
          return Promise.resolve(opts.grokPendingRuns ?? []);
        }
        return Promise.resolve(
          key === null ? (opts.grokRuns ?? []) : (opts.grokInFlightRuns ?? []),
        );
      }),
      update: jest.fn().mockResolvedValue(undefined),
      // М-3.6: метка «подача начата» — по умолчанию захватывается.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // Этап 78 (doc/WORKFLOW-FUNNEL-SPEC.md) — событие воронки, best-effort.
    workflowStageEvent: { create: jest.fn().mockResolvedValue({}) },
    // Джоб-уровневый замок (Д-3.3) — по умолчанию всегда свободен:
    // `create` успешен на первом же вызове, `runBatch()` идёт обычным
    // путём. `jobLockHeld: true` эмулирует уже занятый замок (`create`
    // падает P2002, `updateMany` не находит просроченную строку).
    cronJobLock: {
      create: jest.fn(() =>
        opts.jobLockHeld
          ? Promise.reject(
              Object.assign(new Error('unique'), { code: 'P2002' }),
            )
          : Promise.resolve(undefined),
      ),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: opts.jobLockHeld ? 0 : 1 }),
    },
  };
  const projectSession = {
    createFromItem: jest.fn().mockResolvedValue({ sessionId: 'sess-new' }),
  };
  const sessions = {
    getSession: jest
      .fn()
      .mockResolvedValue(
        opts.sessionState === undefined ? {} : opts.sessionState,
      ),
    // Доп. запрос владельца продукта (ТЗ §13, этап 2 плана §14) —
    // используется `finalizeGrokBatchItem()` при завершении строки,
    // пришедшей через Grok-пачку.
    updateSession: jest.fn().mockResolvedValue(undefined),
    // М-5.3 седьмого аудита: опрос пачки продлевает жизнь дочерним сессиям.
    touchSessions: jest.fn().mockResolvedValue(undefined),
  };
  const library = {
    applyToSession: jest.fn().mockResolvedValue(undefined),
  };
  const prompt = {
    generatePrompt: jest.fn().mockResolvedValue(undefined),
    approvePrompt: jest.fn().mockResolvedValue(undefined),
  };
  const generation = {
    generateVideo: jest.fn().mockResolvedValue(undefined),
    getVideoStatus: jest
      .fn()
      .mockResolvedValue(opts.videoStatus ?? { status: 'processing' }),
  };
  // Доп. запрос владельца продукта (ТЗ §13, этап 2 плана §14).
  const grokBatch = {
    isConfigured: jest.fn().mockReturnValue(false),
    submitBatch: jest
      .fn()
      .mockResolvedValue(opts.grokSubmitResult ?? { xaiBatchId: 'batch1' }),
    getBatchStatus: jest.fn().mockResolvedValue(opts.grokBatchStatus ?? null),
    getBatchResults: jest.fn().mockResolvedValue(opts.grokBatchResults ?? {}),
    // М-3.2/М-6.2 седьмого аудита: воркер читает подробный результат с
    // флагом полноты; по умолчанию — «прочитано полностью».
    getBatchResultsDetailed: jest.fn().mockResolvedValue({
      urlsByRequestId: opts.grokBatchResults ?? {},
      errorsByRequestId: {},
      complete: opts.grokBatchResultsComplete ?? true,
    }),
    modelName: 'grok-imagine-video-1.5',
  };
  const blob = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ url: 'https://blob.test/video.mp4' }),
  };
  // Найдено при аудите (ТЗ §13, этап 2 плана §14) — без проверки
  // бюджета и записи расхода Grok-партии по каталогу могли уйти в xAI
  // без единого взгляда на дневной лимит. По умолчанию — щедрый лимит,
  // существующие тесты (не про Grok-подачу вовсе) не видят разницы;
  // тесты на саму находку переопределяют `aiUsageBudget` явно.
  const plans = {
    // Полная форма UserAccess, а не один `spendPlan`: воркер читает
    // отсюда ещё и `plan` — для `resolveTargetAspectRatio`, где решает
    // не потолок расхода, а доступность формата кадра по тарифу
    // (`plan` — функции, `spendPlan` — деньги, см. доккомментарий
    // UserAccess). Пока здесь лежал только `spendPlan`, `PLANS[undefined]`
    // ронял подачу Grok-пачек с TypeError.
    // Полная форма UserAccess, а не один `spendPlan`: воркер читает
    // отсюда ОБА поля, и они означают разное — `plan` решает доступность
    // формата кадра (`resolveTargetAspectRatio`), `spendPlan` — суточный
    // потолок расхода (см. доккомментарий UserAccess). Значения
    // намеренно РАЗНЫЕ, чтобы подмена одного другим не прошла молча.
    // Пока здесь лежал только `spendPlan`, `PLANS[undefined]` ронял
    // подачу Grok-пачек с TypeError.
    accessOf: jest.fn().mockResolvedValue({
      plan: 'PREMIUM',
      spendPlan: 'LITE',
      isBlocked: false,
      blockedReason: null,
    }),
    // М-3.10: блокировка владельца проверяется перед подачей пачки.
    assertUserNotBlocked: jest.fn().mockResolvedValue(undefined),
  };
  const aiUsage = {
    budget: jest.fn().mockResolvedValue(
      opts.aiUsageBudget ?? {
        allowed: true,
        limitMicroUsd: 100_000_000,
        spentMicroUsd: 0,
        remainingMicroUsd: 100_000_000,
      },
    ),
    record: jest.fn().mockResolvedValue(undefined),
  };
  const service = new CatalogBatchWorkerService(
    prisma as never,
    projectSession as never,
    sessions as never,
    library as never,
    prompt as never,
    generation as never,
    grokBatch as never,
    blob as never,
    // Этап 132: настоящий сервис права с теми же двойниками — тот же
    // приём, что в спеках товарки и поздравления. Рубильник выключен по
    // умолчанию, партия кредитов не касается, поэтому прежние проверки
    // видят прежнее поведение: суточный бюджет и ничего сверх.
    new RenderAccessService(
      { user: { findUnique: jest.fn().mockResolvedValue(null) } } as never,
      plans as never,
      { reserveForGeneration: jest.fn().mockResolvedValue(false) } as never,
    ),
    plans as never,
    aiUsage as never,
  );
  return {
    service,
    prisma,
    projectSession,
    sessions,
    library,
    prompt,
    generation,
    grokBatch,
    blob,
    plans,
    aiUsage,
  };
}

/** Базовые нулевые поля Д-1.1-досмотра — большинство тестов этого файла
 * не заводят `generatingRows`, так что этот блок в их результате всегда
 * такой. */
const NO_RENDER_ADVANCE = {
  renderChecked: 0,
  renderCompleted: 0,
  renderFailed: 0,
};

describe('CatalogBatchWorkerService', () => {
  describe('runBatch — выборка', () => {
    it('пустая очередь — processed: 0 без обращений к сессиям', async () => {
      const { service, library } = setup({ rows: [] });
      const result = await service.runBatch();
      expect(result).toMatchObject({
        processed: 0,
        started: 0,
        failed: 0,
        stillPending: 0,
        ...NO_RENDER_ADVANCE,
      });
      expect(library.applyToSession).not.toHaveBeenCalled();
    });

    it('берёт не больше cronBatch строк за прогон', async () => {
      const { service, prisma } = setup({ rows: [row()] });
      await service.runBatch();
      expect(prisma.catalogBatchItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: configState.cronBatch }),
      );
    });
  });

  describe('успешная обработка строки — пять шагов подряд, без остановки', () => {
    it('без sessionId: создаёт сессию, переносит разбор, генерирует и одобряет промпт, стартует рендер', async () => {
      const { service, prisma, projectSession, library, prompt, generation } =
        setup({ rows: [row()] });
      const result = await service.runBatch();

      expect(result).toMatchObject({
        processed: 1,
        started: 1,
        failed: 0,
        stillPending: 0,
        ...NO_RENDER_ADVANCE,
      });
      expect(projectSession.createFromItem).toHaveBeenCalledWith(
        'user1',
        'proj1',
        'pi1',
        'ru',
      );
      // sessionId дочерней сессии сохраняется в строку СРАЗУ после
      // создания, а не только по завершении всей цепочки — иначе
      // повторный тик после сбоя на шаге 3-4 создал бы вторую сессию.
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith({
        where: { id: 'item1' },
        data: { sessionId: 'sess-new' },
      });
      expect(library.applyToSession).toHaveBeenCalledWith('sess-new', 'entry1');
      expect(prompt.generatePrompt).toHaveBeenCalledWith('sess-new');
      expect(prompt.approvePrompt).toHaveBeenCalledWith('sess-new');
      expect(generation.generateVideo).toHaveBeenCalledWith(
        'sess-new',
        'fast',
        '9:16',
        'veo',
      );
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith({
        where: { id: 'item1' },
        data: { status: 'GENERATING', lockedUntil: null, error: null },
      });
    });

    it('sessionId уже есть (повторный тик после частичного сбоя) — сессию заново не создаёт', async () => {
      const { service, projectSession, library } = setup({
        rows: [row({ sessionId: 'sess-existing' })],
      });
      await service.runBatch();
      expect(projectSession.createFromItem).not.toHaveBeenCalled();
      expect(library.applyToSession).toHaveBeenCalledWith(
        'sess-existing',
        'entry1',
      );
    });

    it('Д-2.5: промпт уже одобрен на сессии (retry после сбоя записи статуса) — не пересобирает промпт заново, GPT-5 не списывается второй раз', async () => {
      const { service, library, prompt, generation } = setup({
        rows: [row({ sessionId: 'sess-existing' })],
        sessionState: { generationPrompt: { approvedAt: new Date() } },
      });
      const result = await service.runBatch();
      expect(result.started).toBe(1);
      expect(library.applyToSession).not.toHaveBeenCalled();
      expect(prompt.generatePrompt).not.toHaveBeenCalled();
      expect(prompt.approvePrompt).not.toHaveBeenCalled();
      // Рендер ещё не стартовал — этот шаг всё равно выполняется.
      expect(generation.generateVideo).toHaveBeenCalledWith(
        'sess-existing',
        'fast',
        '9:16',
        'veo',
      );
    });

    it('Д-2.5: рендер уже стартован на сессии (промпт одобрен и видео уже есть) — не вызывает generateVideo повторно, только фиксирует статус строки', async () => {
      const { service, prompt, generation, prisma } = setup({
        rows: [row({ sessionId: 'sess-existing' })],
        sessionState: {
          generationPrompt: { approvedAt: new Date() },
          generatedVideo: { status: 'processing' },
        },
      });
      const result = await service.runBatch();
      expect(result.started).toBe(1);
      expect(prompt.generatePrompt).not.toHaveBeenCalled();
      expect(generation.generateVideo).not.toHaveBeenCalled();
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith({
        where: { id: 'item1' },
        data: { status: 'GENERATING', lockedUntil: null, error: null },
      });
    });

    it('снимок партии читается один раз на прогон, даже если строк несколько (кэш по batchId)', async () => {
      const { service, prisma } = setup({
        rows: [
          row({ id: 'item1', productItemId: 'pi1' }),
          row({ id: 'item2', productItemId: 'pi2' }),
        ],
      });
      const result = await service.runBatch();
      expect(result.started).toBe(2);
      expect(prisma.catalogBatchRun.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('claim перед обработкой', () => {
    it('строка уже захвачена другим (перекрывающимся) тиком — пропускается без обращения к сессии', async () => {
      const { service, prisma, library } = setup({
        rows: [row()],
        claimCount: 0,
      });
      const result = await service.runBatch();
      expect(result).toMatchObject({
        processed: 1,
        started: 0,
        failed: 0,
        stillPending: 1,
        ...NO_RENDER_ADVANCE,
      });
      expect(library.applyToSession).not.toHaveBeenCalled();
      expect(prisma.catalogBatchItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'item1' }),
          data: { lockedUntil: expect.any(Date) },
        }),
      );
    });
  });

  describe('ошибки — backoff и терминальный FAILED', () => {
    it('временная ошибка (например, сеть) — attempts растёт, статус FAILED с nextAttemptAt в будущем (НЕ PENDING)', async () => {
      const { service, prisma, library } = setup({ rows: [row()] });
      library.applyToSession.mockRejectedValueOnce(new Error('network drop'));
      const result = await service.runBatch();
      expect(result).toMatchObject({
        processed: 1,
        started: 0,
        failed: 1,
        stillPending: 0,
        ...NO_RENDER_ADVANCE,
      });
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith({
        where: { id: 'item1' },
        data: {
          attempts: 1,
          error: 'network drop',
          // Критично: FAILED, а не PENDING — иначе findMany следующего
          // тика (который отбирает ВСЕ status:'PENDING' без учёта
          // nextAttemptAt) подхватил бы строку немедленно, до истечения
          // задержки бэкоффа. Различие retry/terminal — только через
          // nextAttemptAt (см. комментарий в самом сервисе).
          status: 'FAILED',
          nextAttemptAt: expect.any(Date),
          lockedUntil: null,
        },
      });
    });

    it('попытки исчерпаны — переводит в терминальный FAILED без nextAttemptAt', async () => {
      const { service, prisma, library } = setup({
        rows: [row({ attempts: configState.maxAttempts - 1 })],
      });
      library.applyToSession.mockRejectedValueOnce(new Error('boom'));
      const result = await service.runBatch();
      expect(result.failed).toBe(1);
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith({
        where: { id: 'item1' },
        data: {
          attempts: configState.maxAttempts,
          error: 'boom',
          status: 'FAILED',
          nextAttemptAt: null,
          lockedUntil: null,
        },
      });
    });

    it('не временная ошибка (план понижен, ForbiddenException) — сразу терминальный FAILED без пустых повторов', async () => {
      const { service, prisma, library } = setup({ rows: [row()] });
      library.applyToSession.mockRejectedValueOnce(
        new ForbiddenException('plan downgraded'),
      );
      const result = await service.runBatch();
      expect(result.failed).toBe(1);
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith({
        where: { id: 'item1' },
        data: {
          attempts: 1,
          error: 'plan downgraded',
          status: 'FAILED',
          nextAttemptAt: null,
          lockedUntil: null,
        },
      });
    });

    it('Е-1.2 шестого аудита: суточный лимит расхода — FAILED с nextAttemptAt ЗАВТРА (UTC), а не терминально и не обычным бэкоффом минут', async () => {
      // Даже с attempts на пороге maxAttempts — суточный лимит не должен
      // становиться терминальным: он гарантированно снимется на
      // следующие сутки, что бы ни говорил счётчик попыток.
      const { service, prisma, library } = setup({
        rows: [row({ attempts: configState.maxAttempts })],
      });
      library.applyToSession.mockRejectedValueOnce(
        new DailySpendLimitExceededException('дневной лимит исчерпан'),
      );
      const before = Date.now();
      const result = await service.runBatch();
      expect(result.failed).toBe(1);
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith({
        where: { id: 'item1' },
        data: {
          attempts: configState.maxAttempts + 1,
          error: 'дневной лимит исчерпан',
          status: 'FAILED',
          nextAttemptAt: expect.any(Date),
          lockedUntil: null,
        },
      });
      const [[call]] = (
        prisma.catalogBatchItem.update as jest.Mock
      ).mock.calls.slice(-1);
      const nextAttemptAt = call.data.nextAttemptAt as Date;
      // Начало следующих суток UTC — строго в будущем и не дальше чем
      // через 24ч + запас на выполнение теста.
      expect(nextAttemptAt.getTime()).toBeGreaterThan(before);
      expect(nextAttemptAt.getTime() - before).toBeLessThanOrEqual(
        24 * 60 * 60 * 1000 + 5000,
      );
    });

    it('Е-1.4 шестого аудита: VeoOperationOrphanedError (Veo уже реально стартовала, деньги потрачены) — сразу терминальный FAILED, без бэкоффа', async () => {
      // Обычный бэкофф здесь опасен: `videoStarted` в этой строке
      // остаётся false (запись в сессию как раз и не удалась), значит
      // следующий тик вызвал бы generateVideo() ЗАНОВО — второй
      // настоящий платный рендер поверх уже идущего первого. Только
      // терминальный FAILED и ручной разбор оператором.
      const { service, prisma, generation } = setup({ rows: [row()] });
      generation.generateVideo.mockRejectedValueOnce(
        new VeoOperationOrphanedError(
          'Рендер уже стартовал (operations/veo-1), но сохранить состояние не удалось',
          'operations/veo-1',
        ),
      );
      const result = await service.runBatch();
      expect(result.failed).toBe(1);
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith({
        where: { id: 'item1' },
        data: {
          attempts: 1,
          error: expect.stringContaining('operations/veo-1'),
          status: 'FAILED',
          nextAttemptAt: null,
          lockedUntil: null,
        },
      });
    });

    it('CatalogBatchRun пропал (снимок не найден) — строка проваливается, не роняет весь прогон', async () => {
      const { service, prisma } = setup({ rows: [row()], batch: null });
      const result = await service.runBatch();
      expect(result.failed).toBe(1);
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'item1' },
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });
  });

  describe('изоляция ошибок между строками', () => {
    it('одна упавшая строка не мешает следующей в том же тике', async () => {
      const { service, library } = setup({
        rows: [
          row({ id: 'a', productItemId: 'pi-a' }),
          row({ id: 'b', productItemId: 'pi-b' }),
        ],
      });
      library.applyToSession.mockRejectedValueOnce(new Error('boom on a'));
      const result = await service.runBatch();
      expect(result).toMatchObject({
        processed: 2,
        started: 1,
        failed: 1,
        stillPending: 0,
        ...NO_RENDER_ADVANCE,
      });
    });
  });

  describe('advanceGenerating — досмотр уже стартовавших рендеров (Д-1.1)', () => {
    it('рендер завершён и постобработка не идёт — переводит строку в DONE', async () => {
      const { service, prisma } = setup({
        generatingRows: [generatingRow()],
        videoStatus: { status: 'complete', postStatus: 'skipped' },
      });
      const result = await service.runBatch();
      expect(result.renderChecked).toBe(1);
      expect(result.renderCompleted).toBe(1);
      expect(result.renderFailed).toBe(0);
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith({
        where: { id: 'gitem1' },
        data: { status: 'DONE', lockedUntil: null },
      });
    });

    it('рендер завершён, но постобработка ещё pending — статус не трогает, только снимает замок', async () => {
      const { service, prisma } = setup({
        generatingRows: [generatingRow()],
        videoStatus: { status: 'complete', postStatus: 'pending' },
      });
      const result = await service.runBatch();
      expect(result.renderCompleted).toBe(0);
      expect(result.renderFailed).toBe(0);
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith({
        where: { id: 'gitem1' },
        data: { lockedUntil: null },
      });
      expect(prisma.catalogBatchItem.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'DONE' }),
        }),
      );
    });

    it('Veo вернул FAILED — переводит строку в FAILED с текстом ошибки', async () => {
      const { service, prisma } = setup({
        generatingRows: [generatingRow()],
        videoStatus: { status: 'failed', error: { message: 'Veo отказал' } },
      });
      const result = await service.runBatch();
      expect(result.renderFailed).toBe(1);
      expect(result.renderCompleted).toBe(0);
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith({
        where: { id: 'gitem1' },
        data: { status: 'FAILED', error: 'Veo отказал', lockedUntil: null },
      });
    });

    it('строка досмотра уже захвачена другим тиком — getVideoStatus не вызывается', async () => {
      const { service, generation } = setup({
        generatingRows: [generatingRow()],
        generatingClaimCount: 0,
      });
      const result = await service.runBatch();
      expect(result.renderChecked).toBe(1);
      expect(generation.getVideoStatus).not.toHaveBeenCalled();
    });

    it('getVideoStatus упал с ошибкой — замок снимается, тик не падает, остальные строки обрабатываются', async () => {
      const { service, prisma, generation } = setup({
        generatingRows: [generatingRow()],
        rows: [row()],
      });
      generation.getVideoStatus.mockRejectedValueOnce(new Error('сеть легла'));
      const result = await service.runBatch();
      expect(result.renderFailed).toBe(0);
      expect(result.renderCompleted).toBe(0);
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith({
        where: { id: 'gitem1' },
        data: { lockedUntil: null },
      });
      // Обработка новой PENDING-строки в том же тике не пострадала.
      expect(result.started).toBe(1);
    });
  });

  describe('джоб-уровневый замок (Д-3.3, пятый аудит)', () => {
    it('замок уже удерживает другой прогон — тик пропускается целиком, ни выборка, ни досмотр не выполняются', async () => {
      const { service, prisma, generation, library } = setup({
        jobLockHeld: true,
        rows: [row()],
        generatingRows: [generatingRow()],
      });
      const result = await service.runBatch();
      expect(result).toMatchObject({
        processed: 0,
        started: 0,
        failed: 0,
        stillPending: 0,
        ...NO_RENDER_ADVANCE,
      });
      expect(prisma.catalogBatchItem.findMany).not.toHaveBeenCalled();
      expect(generation.getVideoStatus).not.toHaveBeenCalled();
      expect(library.applyToSession).not.toHaveBeenCalled();
    });

    it('замок свободен — захватывается, а по завершении тика снимается явно (updateMany с lockedUntil: null)', async () => {
      const { service, prisma } = setup({ rows: [] });
      await service.runBatch();
      expect(prisma.cronJobLock.create).toHaveBeenCalledWith({
        data: {
          jobKey: 'catalog-batch-run',
          lockedUntil: expect.any(Date),
          ownerToken: expect.any(String),
        },
      });
      expect(prisma.cronJobLock.updateMany).toHaveBeenCalledWith({
        where: { jobKey: 'catalog-batch-run', ownerToken: expect.any(String) },
        data: { lockedUntil: null, ownerToken: null },
      });
    });

    it('замок снимается даже если обработка строки внутри тика упала', async () => {
      const { service, prisma, generation } = setup({ rows: [row()] });
      generation.generateVideo.mockRejectedValueOnce(
        new Error('Veo недоступен'),
      );
      await service.runBatch();
      // recordFailure сам по себе не бросает — но замок должен сняться
      // в любом случае, через finally, а не только на «счастливом» пути.
      expect(prisma.cronJobLock.updateMany).toHaveBeenCalledWith({
        where: { jobKey: 'catalog-batch-run', ownerToken: expect.any(String) },
        data: { lockedUntil: null, ownerToken: null },
      });
    });
  });

  describe('событие воронки (этап 78, doc/WORKFLOW-FUNNEL-SPEC.md §3.2)', () => {
    it('claim → GENERATING: fromStage берётся из status выбранной строки (PENDING)', async () => {
      const { service, prisma } = setup({ rows: [row({ status: 'PENDING' })] });
      await service.runBatch();
      expect(prisma.workflowStageEvent.create).toHaveBeenCalledWith({
        data: {
          workflow: 'CATALOG_BATCH_ITEM',
          entityId: 'item1',
          fromStage: 'PENDING',
          stage: 'GENERATING',
        },
      });
    });

    it('claim → GENERATING: строка пришла из просроченного FAILED — fromStage тоже FAILED', async () => {
      const { service, prisma } = setup({ rows: [row({ status: 'FAILED' })] });
      await service.runBatch();
      expect(prisma.workflowStageEvent.create).toHaveBeenCalledWith({
        data: {
          workflow: 'CATALOG_BATCH_ITEM',
          entityId: 'item1',
          fromStage: 'FAILED',
          stage: 'GENERATING',
        },
      });
    });

    it('claim не удался — событие не пишется (шаг вообще не выполнялся)', async () => {
      const { service, prisma } = setup({ rows: [row()], claimCount: 0 });
      await service.runBatch();
      expect(prisma.workflowStageEvent.create).not.toHaveBeenCalled();
    });

    it('recordFailure: fromStage берётся из status строки, а не всегда GENERATING', async () => {
      const { service, prisma, library } = setup({
        rows: [row({ status: 'FAILED' })],
      });
      library.applyToSession.mockRejectedValueOnce(new Error('boom'));
      await service.runBatch();
      expect(prisma.workflowStageEvent.create).toHaveBeenCalledWith({
        data: {
          workflow: 'CATALOG_BATCH_ITEM',
          entityId: 'item1',
          fromStage: 'FAILED',
          stage: 'FAILED',
        },
      });
      // Строка так и не дошла до claim→GENERATING (упала раньше) —
      // событие GENERATING для неё писаться не должно.
      expect(prisma.workflowStageEvent.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ stage: 'GENERATING' }),
        }),
      );
    });

    it('advanceGenerating: рендер завершён — событие GENERATING → DONE', async () => {
      const { service, prisma } = setup({
        generatingRows: [generatingRow()],
        videoStatus: { status: 'complete', postStatus: 'skipped' },
      });
      await service.runBatch();
      expect(prisma.workflowStageEvent.create).toHaveBeenCalledWith({
        data: {
          workflow: 'CATALOG_BATCH_ITEM',
          entityId: 'gitem1',
          fromStage: 'GENERATING',
          stage: 'DONE',
        },
      });
    });

    it('advanceGenerating: Veo вернул FAILED — событие GENERATING → FAILED', async () => {
      const { service, prisma } = setup({
        generatingRows: [generatingRow()],
        videoStatus: { status: 'failed', error: { message: 'Veo отказал' } },
      });
      await service.runBatch();
      expect(prisma.workflowStageEvent.create).toHaveBeenCalledWith({
        data: {
          workflow: 'CATALOG_BATCH_ITEM',
          entityId: 'gitem1',
          fromStage: 'GENERATING',
          stage: 'FAILED',
        },
      });
    });

    it('advanceGenerating: рендер ещё идёт — событие не пишется', async () => {
      const { service, prisma } = setup({
        generatingRows: [generatingRow()],
        videoStatus: { status: 'processing' },
      });
      await service.runBatch();
      expect(prisma.workflowStageEvent.create).not.toHaveBeenCalled();
    });

    it('getVideoStatus упал с ошибкой — событие не пишется (статус строки не изменился)', async () => {
      const { service, prisma, generation } = setup({
        generatingRows: [generatingRow()],
      });
      generation.getVideoStatus.mockRejectedValueOnce(new Error('сеть легла'));
      await service.runBatch();
      expect(prisma.workflowStageEvent.create).not.toHaveBeenCalled();
    });

    it('сбой самой записи события не роняет тик (logWorkflowStage проглатывает ошибку)', async () => {
      const { service, prisma } = setup({ rows: [row()] });
      prisma.workflowStageEvent.create.mockRejectedValueOnce(
        new Error('analytics db insert failed'),
      );
      await expect(service.runBatch()).resolves.toMatchObject({ started: 1 });
    });
  });

  // Доп. запрос владельца продукта (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md
  // §13, этап 2 плана реализации §14) — Grok идёт через xAI Batch API,
  // не через синхронный `generateVideo()`.
  describe('Grok-пачки (§13 ТЗ)', () => {
    it('processOne с provider=grok ставит строку в BATCH_QUEUED, не зовёт generateVideo()', async () => {
      const { service, prisma, generation } = setup({
        rows: [row()],
        batch: batchRow({ provider: 'grok', resolution: '480p' }),
        sessionState: { generationPrompt: { approvedAt: null } },
      });
      await service.runBatch();
      expect(generation.generateVideo).not.toHaveBeenCalled();
      expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'item1' },
          data: expect.objectContaining({ status: 'BATCH_QUEUED' }),
        }),
      );
    });

    it('уже стартованную (videoStarted) grok-строку не переставляет в очередь повторно', async () => {
      const { service, generation, prisma } = setup({
        rows: [row()],
        batch: batchRow({ provider: 'grok' }),
        sessionState: {
          generationPrompt: { approvedAt: new Date() },
          generatedVideo: { status: 'PROCESSING' },
        },
      });
      await service.runBatch();
      expect(generation.generateVideo).not.toHaveBeenCalled();
      expect(prisma.catalogBatchItem.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'BATCH_QUEUED' }),
        }),
      );
    });

    describe('submitReadyGrokBatches', () => {
      it('очередь пуста — ничего не подаёт', async () => {
        const { service, grokBatch } = setup({
          grokRuns: [{ id: 'run1', resolution: '480p', aspectRatio: '9:16' }],
          grokQueuedCount: 0,
        });
        await service.runBatch();
        expect(grokBatch.submitBatch).not.toHaveBeenCalled();
      });

      it('есть ещё не готовые (PENDING/retry-FAILED) строки — ждёт, не подаёт частично', async () => {
        const { service, grokBatch } = setup({
          grokRuns: [{ id: 'run1', resolution: '480p', aspectRatio: '9:16' }],
          grokQueuedCount: 2,
          grokNotReadyCount: 1,
        });
        await service.runBatch();
        expect(grokBatch.submitBatch).not.toHaveBeenCalled();
      });

      it('очередь готова целиком — подаёт одной пачкой, помечает строки GENERATING', async () => {
        const { service, grokBatch, prisma } = setup({
          grokRuns: [{ id: 'run1', resolution: '480p', aspectRatio: '9:16' }],
          grokQueuedCount: 1,
          grokNotReadyCount: 0,
          grokQueuedItems: [
            { id: 'item1', sessionId: 'sess1', productItemId: 'pi1' },
          ],
          sessionState: {
            generationPrompt: { finalText: 'a cat on a table' },
            productInformation: { productImageUrl: 'https://blob.test/p.png' },
          },
          grokSubmitResult: { xaiBatchId: 'batch_xai_1' },
        });

        await service.runBatch();

        expect(grokBatch.submitBatch).toHaveBeenCalledWith(
          'catalog-batch-run1',
          [
            expect.objectContaining({
              batchRequestId: 'item1',
              prompt: 'a cat on a table',
              imageUrl: 'https://blob.test/p.png',
              aspectRatio: '9:16',
              resolution: '480p',
            }),
          ],
        );
        // Вместе с id пачки теперь записывается и разрешённый режимом
        // формат кадра (этап 120): опрос результатов не знает ни
        // владельца, ни его режима, и без этого достраивал бы ролик по
        // исходному — возможно, закрытому для тарифа — формату.
        expect(prisma.catalogBatchRun.update).toHaveBeenCalledWith({
          where: { id: 'run1' },
          data: { xaiBatchId: 'batch_xai_1', aspectRatio: '9:16' },
        });
        expect(prisma.catalogBatchItem.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['item1'] } },
          data: { status: 'GENERATING' },
        });
      });

      // Доп. запрос владельца продукта (ТЗ §13, этап 2 плана §14) —
      // найдено при аудите: до исправления этот путь вызывал
      // `GrokVideoBatchService` напрямую, минуя `GenerationService`, где
      // для всех остальных путей проекта живёт и проверка бюджета, и
      // запись расхода — реальные деньги, потраченные у xAI, были бы
      // невидимы для отчёта о расходах.
      it('бюджет считается по spendPlan, формат кадра — по plan: поля не путаются местами', async () => {
        // Они разные по смыслу (функции против денег) и в моке специально
        // разные по значению. Раньше в этом моке лежал только `spendPlan`,
        // и чтение `plan` давало undefined — подача падала с TypeError.
        // Формат 1:1 разрешён на PREMIUM (`plan`) и закрыт на LITE
        // (`spendPlan`) — перепутанные поля дали бы здесь приведение к
        // родному формату вместо сохранения запрошенного.
        const { service, aiUsage, prisma } = setup({
          grokRuns: [{ id: 'run1', resolution: '480p', aspectRatio: '1:1' }],
          grokQueuedCount: 1,
          grokNotReadyCount: 0,
          grokQueuedItems: [
            { id: 'item1', sessionId: 'sess1', productItemId: 'pi1' },
          ],
          sessionState: {
            generationPrompt: { finalText: 'a cat on a table' },
            productInformation: { productImageUrl: 'https://blob.test/p.png' },
          },
          grokSubmitResult: { xaiBatchId: 'batch_xai_1' },
        });

        await service.runBatch();

        // Потолок расхода — по spendPlan (второй аргумент budget()).
        expect(aiUsage.budget.mock.calls[0][1]).toBe('LITE');
        // Формат кадра — по plan.
        expect(prisma.catalogBatchRun.update).toHaveBeenCalledWith({
          where: { id: 'run1' },
          data: { xaiBatchId: 'batch_xai_1', aspectRatio: '1:1' },
        });
      });

      it('успешная подача — расход записывается на всю партию одной записью', async () => {
        const { service, aiUsage } = setup({
          grokRuns: [{ id: 'run1', resolution: '480p', aspectRatio: '9:16' }],
          grokQueuedCount: 1,
          grokNotReadyCount: 0,
          grokQueuedItems: [
            { id: 'item1', sessionId: 'sess1', productItemId: 'pi1' },
          ],
          sessionState: {
            generationPrompt: { finalText: 'a cat on a table' },
            productInformation: { productImageUrl: 'https://blob.test/p.png' },
          },
          grokSubmitResult: { xaiBatchId: 'batch_xai_1' },
        });

        await service.runBatch();

        expect(aiUsage.record).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: 'generation',
            model: 'grok-imagine-video-1.5:480p',
            seconds: 8,
          }),
        );
      });

      it('бюджет не покрывает стоимость всей партии — все строки FAILED, submitBatch не вызывается', async () => {
        const { service, grokBatch, prisma } = setup({
          grokRuns: [
            {
              id: 'run1',
              userId: 'u1',
              resolution: '480p',
              aspectRatio: '9:16',
            },
          ],
          grokQueuedCount: 1,
          grokNotReadyCount: 0,
          grokQueuedItems: [
            { id: 'item1', sessionId: 'sess1', productItemId: 'pi1' },
          ],
          sessionState: {
            generationPrompt: { finalText: 'a cat on a table' },
            productInformation: { productImageUrl: 'https://blob.test/p.png' },
          },
          // 480p × 8с = $0.64 = 640_000 мкд за строку — остаток заведомо
          // меньше этого, партия не должна уйти ни частично, ни целиком.
          aiUsageBudget: {
            allowed: true,
            limitMicroUsd: 200_000,
            spentMicroUsd: 0,
            remainingMicroUsd: 200_000,
          },
        });

        await service.runBatch();

        expect(grokBatch.submitBatch).not.toHaveBeenCalled();
        expect(prisma.catalogBatchItem.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['item1'] } },
          data: expect.objectContaining({ status: 'FAILED' }),
        });
      });

      it('строка без одобренного промпта или фото товара — пропускается с FAILED, не блокирует остальные', async () => {
        const { service, grokBatch, prisma } = setup({
          grokRuns: [{ id: 'run1', resolution: '480p', aspectRatio: '9:16' }],
          grokQueuedCount: 1,
          grokNotReadyCount: 0,
          grokQueuedItems: [
            { id: 'item-no-prompt', sessionId: 'sess1', productItemId: 'pi1' },
          ],
          sessionState: { generationPrompt: null, productInformation: null },
        });

        await service.runBatch();

        expect(grokBatch.submitBatch).not.toHaveBeenCalled();
        expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'item-no-prompt' },
            data: expect.objectContaining({ status: 'FAILED' }),
          }),
        );
      });

      it('xAI отклоняет подачу — строки остаются в очереди для следующего тика, не FAILED', async () => {
        const { service, prisma } = setup({
          grokRuns: [{ id: 'run1', resolution: '480p', aspectRatio: '9:16' }],
          grokQueuedCount: 1,
          grokNotReadyCount: 0,
          grokQueuedItems: [
            { id: 'item1', sessionId: 'sess1', productItemId: 'pi1' },
          ],
          sessionState: {
            generationPrompt: { finalText: 'x' },
            productInformation: { productImageUrl: 'https://blob.test/p.png' },
          },
          grokSubmitResult: { error: 'xAI вернул статус 500' },
        });

        await service.runBatch();

        // М-3.6: метка подачи снята обратно в NULL — id пачки не записан.
        expect(prisma.catalogBatchRun.update).toHaveBeenCalledWith({
          where: { id: 'run1' },
          data: { xaiBatchId: null },
        });
        expect(prisma.catalogBatchRun.update).not.toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              xaiBatchId: expect.stringMatching(/^batch/),
            }),
          }),
        );
        expect(prisma.catalogBatchItem.updateMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ data: { status: 'GENERATING' } }),
        );
      });

      it('М-3.6: параллельный тик уже поставил метку подачи (count 0) — подача пропускается', async () => {
        const { service, prisma, grokBatch } = setup({
          grokRuns: [{ id: 'run1', resolution: '480p', aspectRatio: '9:16' }],
          grokQueuedCount: 1,
          grokNotReadyCount: 0,
          grokQueuedItems: [
            { id: 'item1', sessionId: 'sess1', productItemId: 'pi1' },
          ],
          sessionState: {
            generationPrompt: { finalText: 'x' },
            productInformation: { productImageUrl: 'https://blob.test/p.png' },
          },
        });
        prisma.catalogBatchRun.updateMany.mockResolvedValueOnce({ count: 0 });
        await service.runBatch();
        expect(grokBatch.submitBatch).not.toHaveBeenCalled();
      });
    });

    describe('pollInFlightGrokBatches', () => {
      it('пачка ещё не готова (pendingCount > 0) — ничего не делает', async () => {
        const { service, grokBatch } = setup({
          grokInFlightRuns: [
            { id: 'run1', xaiBatchId: 'batch_xai_1', aspectRatio: '9:16' },
          ],
          grokBatchStatus: {
            totalCount: 3,
            completedCount: 1,
            pendingCount: 2,
            errorCount: 0,
          },
        });
        await service.runBatch();
        expect(grokBatch.getBatchResultsDetailed).not.toHaveBeenCalled();
      });

      it('опрос статуса не удался (null) — не падает, пробует следующим тиком', async () => {
        const { service, grokBatch } = setup({
          grokInFlightRuns: [
            { id: 'run1', xaiBatchId: 'batch_xai_1', aspectRatio: '9:16' },
          ],
          grokBatchStatus: null,
        });
        await expect(service.runBatch()).resolves.toBeDefined();
        expect(grokBatch.getBatchResultsDetailed).not.toHaveBeenCalled();
      });

      it('М-3.2: результаты прочитаны не полностью (сбой /results) — строки НЕ помечаются FAILED, ждут следующего тика', async () => {
        const { service, prisma, grokBatch, sessions } = setup({
          grokInFlightRuns: [
            { id: 'run1', xaiBatchId: 'batch1', aspectRatio: '9:16' },
          ],
          grokBatchStatus: {
            totalCount: 1,
            completedCount: 1,
            pendingCount: 0,
            errorCount: 0,
          },
          grokBatchResults: {},
          grokBatchResultsComplete: false,
          grokGeneratingItems: [
            { id: 'item1', sessionId: 'sess1', productItemId: 'pi1' },
          ],
        });
        const r = await service.runBatch();
        expect(grokBatch.getBatchResultsDetailed).toHaveBeenCalledWith(
          'batch1',
        );
        expect(prisma.catalogBatchItem.update).not.toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: 'FAILED' }),
          }),
        );
        expect(r.grokBatchItemsFailed).toBe(0);
        expect(sessions.touchSessions).not.toHaveBeenCalled();
      });

      it('пачка готова, результат найден — скачивает, сохраняет в Blob, помечает DONE', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        });
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
          const { service, prisma, blob, sessions } = setup({
            grokInFlightRuns: [
              { id: 'run1', xaiBatchId: 'batch_xai_1', aspectRatio: '9:16' },
            ],
            grokGeneratingItems: [
              { id: 'item1', sessionId: 'sess1', productItemId: 'pi1' },
            ],
            grokBatchStatus: {
              totalCount: 1,
              completedCount: 1,
              pendingCount: 0,
              errorCount: 0,
            },
            grokBatchResults: { item1: 'https://vidgen.x.ai/done.mp4' },
            sessionState: { generatedVideo: undefined, videoHistory: [] },
          });

          const result = await service.runBatch();

          expect(fetchMock).toHaveBeenCalledWith(
            'https://vidgen.x.ai/done.mp4',
            expect.anything(),
          );
          expect(blob.uploadBuffer).toHaveBeenCalledWith(
            expect.stringContaining('sessions/sess1/generated-'),
            expect.any(Buffer),
            'video/mp4',
          );
          expect(sessions.updateSession).toHaveBeenCalledWith(
            'sess1',
            expect.objectContaining({
              generatedVideo: expect.objectContaining({
                status: 'complete',
                provider: 'grok',
                downloadUrl: 'https://blob.test/video.mp4',
              }),
            }),
          );
          expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith(
            expect.objectContaining({
              where: { id: 'item1' },
              data: expect.objectContaining({ status: 'DONE' }),
            }),
          );
          expect(result.grokBatchItemsCompleted).toBe(1);
        } finally {
          global.fetch = originalFetch;
        }
      });

      it('пачка готова, но результата для строки нет — FAILED, не падает на остальных', async () => {
        const { service, prisma } = setup({
          grokInFlightRuns: [
            { id: 'run1', xaiBatchId: 'batch_xai_1', aspectRatio: '9:16' },
          ],
          grokGeneratingItems: [
            { id: 'item-missing', sessionId: 'sess1', productItemId: 'pi1' },
          ],
          grokBatchStatus: {
            totalCount: 1,
            completedCount: 0,
            pendingCount: 0,
            errorCount: 1,
          },
          grokBatchResults: {},
        });

        const result = await service.runBatch();

        expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'item-missing' },
            data: expect.objectContaining({ status: 'FAILED' }),
          }),
        );
        expect(result.grokBatchItemsFailed).toBe(1);
      });
    });
  });
});
