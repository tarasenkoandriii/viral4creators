import { AbTestWorkerService } from './ab-test-worker.service';
import { DailySpendLimitExceededException } from '../../common/spend-limits';
import { VeoOperationOrphanedError } from '../generation/generation.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

const configState = { cronBatch: 5, maxAttempts: 3 };
jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({ abTest: configState }),
}));

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'variant1',
    runId: 'run1',
    variantIndex: 0,
    promptText: 'alt prompt text',
    voiceoverScript: 'alt voiceover',
    sessionId: null,
    attempts: 0,
    ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run1',
    userId: 'user1',
    projectId: 'proj1',
    productItemId: 'pi1',
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
    id: 'gvariant1',
    runId: 'run1',
    variantIndex: 0,
    sessionId: 'sess-generating',
    ...overrides,
  };
}

function setup(
  opts: {
    rows?: unknown[];
    claimCount?: number;
    run?: unknown;
    /** Строки Д-1.1-досмотра (`status: 'GENERATING'`) — по умолчанию
     * пусто, чтобы существующие тесты выборки новых строк не задевали
     * этот путь вовсе. */
    generatingRows?: unknown[];
    generatingClaimCount?: number;
    /** Что вернёт `generation.getVideoStatus` для строк из
     * `generatingRows` — по умолчанию нейтральное «всё ещё идёт». */
    videoStatus?: unknown;
    /** Состояние сессии, которое видит `processOne` (Д-2.5) — по
     * умолчанию пустое, так что все существующие тесты полного пути
     * проходят все шаги как раньше. */
    sessionState?: unknown;
    /** Джоб-уровневый замок (Д-3.3) уже удерживается другим прогоном —
     * по умолчанию `false`. */
    jobLockHeld?: boolean;
  } = {},
) {
  const generatingIds = new Set(
    (opts.generatingRows ?? []).map((r) => (r as { id: string }).id),
  );
  const prisma = {
    abTestVariant: {
      // Два РАЗНЫХ запроса делят один мок: Д-1.1-досмотр
      // (`where.status === 'GENERATING'`) и выборка новых/просроченных
      // строк (`where.OR`) — различаем по форме `where`, а не по
      // порядку вызова.
      findMany: jest.fn((args: { where?: { status?: string } } = {}) =>
        Promise.resolve(
          args?.where?.status === 'GENERATING'
            ? (opts.generatingRows ?? [])
            : (opts.rows ?? []),
        ),
      ),
      // Claim, тот же приём, что у CatalogBatchWorkerService (этап 65) —
      // по умолчанию всегда успешно захвачена; различаем по id строки,
      // чтобы досмотр и обработка новых строк могли независимо получать
      // разные claimCount в одном тесте.
      updateMany: jest.fn((args: { where?: { id?: string } } = {}) =>
        Promise.resolve({
          count: generatingIds.has(args?.where?.id ?? '')
            ? (opts.generatingClaimCount ?? 1)
            : (opts.claimCount ?? 1),
        }),
      ),
      update: jest.fn().mockResolvedValue(undefined),
    },
    abTestRun: {
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.run === undefined ? runRow() : opts.run),
    },
    // Джоб-уровневый замок (Д-3.3) — по умолчанию свободен, см.
    // аналогичный мок в catalog-batch-worker.service.spec.ts.
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
  };
  const library = {
    applyToSession: jest.fn().mockResolvedValue(undefined),
  };
  const prompt = {
    seedPrompt: jest.fn().mockResolvedValue(undefined),
    approvePrompt: jest.fn().mockResolvedValue(undefined),
  };
  const generation = {
    generateVideo: jest.fn().mockResolvedValue(undefined),
    getVideoStatus: jest
      .fn()
      .mockResolvedValue(opts.videoStatus ?? { status: 'processing' }),
  };
  const service = new AbTestWorkerService(
    prisma as never,
    projectSession as never,
    sessions as never,
    library as never,
    prompt as never,
    generation as never,
  );
  return {
    service,
    prisma,
    projectSession,
    sessions,
    library,
    prompt,
    generation,
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

describe('AbTestWorkerService', () => {
  describe('runBatch — выборка', () => {
    it('пустая очередь — processed: 0 без обращений к сессиям', async () => {
      const { service, library } = setup({ rows: [] });
      const result = await service.runBatch();
      expect(result).toEqual({
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
      expect(prisma.abTestVariant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: configState.cronBatch }),
      );
    });
  });

  describe('успешная обработка строки — четыре шага подряд, без остановки', () => {
    it('без sessionId: создаёт сессию, переносит разбор, сеет уже готовый текст (без GPT-5), одобряет, стартует рендер', async () => {
      const { service, prisma, projectSession, library, prompt, generation } =
        setup({ rows: [row()] });
      const result = await service.runBatch();

      expect(result).toEqual({
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
      // повторный тик после сбоя на шаге 2-3 создал бы вторую сессию.
      expect(prisma.abTestVariant.update).toHaveBeenCalledWith({
        where: { id: 'variant1' },
        data: { sessionId: 'sess-new' },
      });
      expect(library.applyToSession).toHaveBeenCalledWith('sess-new', 'entry1');
      // Ключевое отличие от CatalogBatchWorkerService: seedPrompt, не
      // generatePrompt — текст уже готов, второй вызов GPT-5 не нужен.
      expect(prompt.seedPrompt).toHaveBeenCalledWith(
        'sess-new',
        'alt prompt text',
        'alt voiceover',
      );
      expect(prompt.approvePrompt).toHaveBeenCalledWith('sess-new');
      expect(generation.generateVideo).toHaveBeenCalledWith(
        'sess-new',
        'fast',
        '9:16',
      );
      expect(prisma.abTestVariant.update).toHaveBeenCalledWith({
        where: { id: 'variant1' },
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

    it('Д-2.5: промпт уже одобрен на сессии (retry после сбоя записи статуса) — не сеет промпт заново', async () => {
      const { service, library, prompt, generation } = setup({
        rows: [row({ sessionId: 'sess-existing' })],
        sessionState: { generationPrompt: { approvedAt: new Date() } },
      });
      const result = await service.runBatch();
      expect(result.started).toBe(1);
      expect(library.applyToSession).not.toHaveBeenCalled();
      expect(prompt.seedPrompt).not.toHaveBeenCalled();
      expect(prompt.approvePrompt).not.toHaveBeenCalled();
      expect(generation.generateVideo).toHaveBeenCalledWith(
        'sess-existing',
        'fast',
        '9:16',
      );
    });

    it('Д-2.5: рендер уже стартован на сессии — не вызывает generateVideo повторно, только фиксирует статус строки', async () => {
      const { service, prompt, generation, prisma } = setup({
        rows: [row({ sessionId: 'sess-existing' })],
        sessionState: {
          generationPrompt: { approvedAt: new Date() },
          generatedVideo: { status: 'processing' },
        },
      });
      const result = await service.runBatch();
      expect(result.started).toBe(1);
      expect(prompt.seedPrompt).not.toHaveBeenCalled();
      expect(generation.generateVideo).not.toHaveBeenCalled();
      expect(prisma.abTestVariant.update).toHaveBeenCalledWith({
        where: { id: 'variant1' },
        data: { status: 'GENERATING', lockedUntil: null, error: null },
      });
    });

    it('снимок запуска читается один раз на прогон, даже если строк несколько (кэш по runId)', async () => {
      const { service, prisma } = setup({
        rows: [
          row({ id: 'variant1', variantIndex: 0 }),
          row({ id: 'variant2', variantIndex: 1 }),
        ],
      });
      const result = await service.runBatch();
      expect(result.started).toBe(2);
      expect(prisma.abTestRun.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('claim перед обработкой', () => {
    it('строка уже захвачена другим (перекрывающимся) тиком — пропускается без обращения к сессии', async () => {
      const { service, prisma, library } = setup({
        rows: [row()],
        claimCount: 0,
      });
      const result = await service.runBatch();
      expect(result).toEqual({
        processed: 1,
        started: 0,
        failed: 0,
        stillPending: 1,
        ...NO_RENDER_ADVANCE,
      });
      expect(library.applyToSession).not.toHaveBeenCalled();
      expect(prisma.abTestVariant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'variant1' }),
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
      expect(result).toEqual({
        processed: 1,
        started: 0,
        failed: 1,
        stillPending: 0,
        ...NO_RENDER_ADVANCE,
      });
      expect(prisma.abTestVariant.update).toHaveBeenCalledWith({
        where: { id: 'variant1' },
        data: {
          attempts: 1,
          error: 'network drop',
          // Критично: FAILED, а не PENDING — иначе findMany следующего
          // тика (который отбирает ВСЕ status:'PENDING' без учёта
          // nextAttemptAt) подхватил бы строку немедленно, до истечения
          // задержки бэкоффа.
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
      expect(prisma.abTestVariant.update).toHaveBeenCalledWith({
        where: { id: 'variant1' },
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
      expect(prisma.abTestVariant.update).toHaveBeenCalledWith({
        where: { id: 'variant1' },
        data: {
          attempts: 1,
          error: 'plan downgraded',
          status: 'FAILED',
          nextAttemptAt: null,
          lockedUntil: null,
        },
      });
    });

    it('Е-1.4 шестого аудита: VeoOperationOrphanedError (Veo уже реально стартовала, деньги потрачены) — сразу терминальный FAILED, без бэкоффа', async () => {
      // Тот же повод, что у CatalogBatchWorkerService: `videoStarted`
      // остаётся false (запись в сессию как раз и не удалась), обычный
      // бэкофф вызвал бы generateVideo() заново — второй настоящий
      // платный рендер поверх уже идущего первого.
      const { service, prisma, generation } = setup({ rows: [row()] });
      generation.generateVideo.mockRejectedValueOnce(
        new VeoOperationOrphanedError(
          'Рендер уже стартовал (operations/veo-1), но сохранить состояние не удалось',
          'operations/veo-1',
        ),
      );
      const result = await service.runBatch();
      expect(result.failed).toBe(1);
      expect(prisma.abTestVariant.update).toHaveBeenCalledWith({
        where: { id: 'variant1' },
        data: {
          attempts: 1,
          error: expect.stringContaining('operations/veo-1'),
          status: 'FAILED',
          nextAttemptAt: null,
          lockedUntil: null,
        },
      });
    });

    it('Е-1.2 шестого аудита: суточный лимит расхода — FAILED с nextAttemptAt ЗАВТРА (UTC), а не терминально и не обычным бэкоффом минут', async () => {
      const { service, prisma, library } = setup({
        rows: [row({ attempts: configState.maxAttempts })],
      });
      library.applyToSession.mockRejectedValueOnce(
        new DailySpendLimitExceededException('дневной лимит исчерпан'),
      );
      const before = Date.now();
      const result = await service.runBatch();
      expect(result.failed).toBe(1);
      expect(prisma.abTestVariant.update).toHaveBeenCalledWith({
        where: { id: 'variant1' },
        data: {
          attempts: configState.maxAttempts + 1,
          error: 'дневной лимит исчерпан',
          status: 'FAILED',
          nextAttemptAt: expect.any(Date),
          lockedUntil: null,
        },
      });
      const [[call]] = (
        prisma.abTestVariant.update as jest.Mock
      ).mock.calls.slice(-1);
      const nextAttemptAt = call.data.nextAttemptAt as Date;
      expect(nextAttemptAt.getTime()).toBeGreaterThan(before);
      expect(nextAttemptAt.getTime() - before).toBeLessThanOrEqual(
        24 * 60 * 60 * 1000 + 5000,
      );
    });

    it('AbTestRun пропал (снимок не найден) — строка проваливается, не роняет весь прогон', async () => {
      const { service, prisma } = setup({ rows: [row()], run: null });
      const result = await service.runBatch();
      expect(result.failed).toBe(1);
      expect(prisma.abTestVariant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'variant1' },
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });
  });

  describe('изоляция ошибок между строками', () => {
    it('одна упавшая строка не мешает следующей в том же тике', async () => {
      const { service, library } = setup({
        rows: [
          row({ id: 'a', variantIndex: 0 }),
          row({ id: 'b', variantIndex: 1 }),
        ],
      });
      library.applyToSession.mockRejectedValueOnce(new Error('boom on a'));
      const result = await service.runBatch();
      expect(result).toEqual({
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
      expect(prisma.abTestVariant.update).toHaveBeenCalledWith({
        where: { id: 'gvariant1' },
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
      expect(prisma.abTestVariant.update).toHaveBeenCalledWith({
        where: { id: 'gvariant1' },
        data: { lockedUntil: null },
      });
      expect(prisma.abTestVariant.update).not.toHaveBeenCalledWith(
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
      expect(prisma.abTestVariant.update).toHaveBeenCalledWith({
        where: { id: 'gvariant1' },
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
      expect(prisma.abTestVariant.update).toHaveBeenCalledWith({
        where: { id: 'gvariant1' },
        data: { lockedUntil: null },
      });
      // Обработка новой PENDING-строки в том же тике не пострадала.
      expect(result.started).toBe(1);
    });
  });

  describe('джоб-уровневый замок (Д-3.3, пятый аудит)', () => {
    it('замок уже удерживает другой прогон — тик пропускается целиком', async () => {
      const { service, prisma, generation, library } = setup({
        jobLockHeld: true,
        rows: [row()],
        generatingRows: [generatingRow()],
      });
      const result = await service.runBatch();
      expect(result).toEqual({
        processed: 0,
        started: 0,
        failed: 0,
        stillPending: 0,
        ...NO_RENDER_ADVANCE,
      });
      expect(prisma.abTestVariant.findMany).not.toHaveBeenCalled();
      expect(generation.getVideoStatus).not.toHaveBeenCalled();
      expect(library.applyToSession).not.toHaveBeenCalled();
    });

    it('замок свободен — захватывается и снимается явно по завершении тика', async () => {
      const { service, prisma } = setup({ rows: [] });
      await service.runBatch();
      expect(prisma.cronJobLock.create).toHaveBeenCalledWith({
        data: { jobKey: 'ab-test-run', lockedUntil: expect.any(Date) },
      });
      expect(prisma.cronJobLock.updateMany).toHaveBeenCalledWith({
        where: { jobKey: 'ab-test-run' },
        data: { lockedUntil: null },
      });
    });
  });
});
