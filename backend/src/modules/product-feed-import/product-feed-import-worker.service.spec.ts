import { ProductFeedImportWorkerService } from './product-feed-import-worker.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

// ProjectService реально не используется — тест подставляет свой лёгкий
// мок (см. `setup()` ниже). Модуль всё равно нужно замокать: настоящий
// project.service.ts тянет за собой рантайм-импорт `@prisma/client`
// (`import { Prisma } from '@prisma/client'`, не только типы), а
// сгенерированного клиента в песочнице нет (см. doc/PRODUCT-PROJECT-
// SPEC.md — известное ограничение), поэтому require настоящего файла
// падает ДО того, как jest успевает замокать сам PrismaService.
jest.mock('../project/project.service', () => ({ ProjectService: class {} }));

const configState = {
  cronBatch: 5,
  maxAttempts: 3,
  maxFeedBytes: 8 * 1024 * 1024,
};
jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({ productFeedImport: configState }),
}));

// Воркер вызывает ТОЛЬКО `fetchPubliclyRoutable` (Д-3.1, пятый аудит) —
// сама `assertPubliclyRoutableUrl` внутри неё вызывается как локальная
// ссылка внутри модуля external-url-guard.ts, а не через экспорт, так
// что подмена одной `assertPubliclyRoutableUrl` здесь никак не повлияла
// бы на поведение `fetchPubliclyRoutable` (классическая ловушка
// jest.mock + `...actual`-спред). Мокаем сразу ту функцию, которую
// реально дёргает воркер; по умолчанию она просто зовёт замоканный
// `global.fetch` один раз, без редиректной логики — редиректная логика
// самой `fetchPubliclyRoutable` уже подробно проверена отдельно в
// `external-url-guard.spec.ts`.
jest.mock('../../common/external-url-guard', () => {
  const actual = jest.requireActual('../../common/external-url-guard');
  return {
    ...actual,
    fetchPubliclyRoutable: jest.fn((url: string, init?: RequestInit) =>
      (global.fetch as typeof fetch)(url, init),
    ),
  };
});

jest.mock('../../common/product-feed', () => ({
  parseFeed: jest.fn(),
}));

jest.mock('../product-analog/product-analog.service', () => ({
  photoPathname: jest.fn(() => 'projects/proj1/items/newpi1/photo.jpg'),
  hashPhoto: jest.fn(() => 'hash123'),
}));

import { fetchPubliclyRoutable } from '../../common/external-url-guard';
import { parseFeed } from '../../common/product-feed';

const guardMock = fetchPubliclyRoutable as jest.Mock;
const parseFeedMock = parseFeed as jest.Mock;

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run1',
    sourceUrl: 'https://seller.test/feed.yml',
    attempts: 0,
    ...overrides,
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item1',
    runId: 'run1',
    rowIndex: 0,
    title: 'Товар',
    price: 100,
    currency: null,
    description: null,
    photoUrl: null,
    categoryText: null,
    attempts: 0,
    productItemId: null,
    ...overrides,
  };
}

function jsonHeaders(map: Record<string, string | null> = {}) {
  return { get: (key: string) => map[key.toLowerCase()] ?? null };
}

function setup(
  opts: {
    runs?: unknown[];
    runClaimCount?: number;
    items?: unknown[];
    itemClaimCount?: number;
    runContext?: unknown;
    project?: unknown;
    remaining?: number;
    /** Джоб-уровневый замок (Д-3.3) уже удерживается другим прогоном —
     * по умолчанию `false`. */
    jobLockHeld?: boolean;
  } = {},
) {
  const txCreateMany = jest.fn().mockResolvedValue(undefined);
  const txRunUpdate = jest.fn().mockResolvedValue(undefined);
  const prisma = {
    productFeedImportRun: {
      findMany: jest.fn().mockResolvedValue(opts.runs ?? []),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: opts.runClaimCount ?? 1 }),
      update: jest.fn().mockResolvedValue(undefined),
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.runContext === undefined
            ? { id: 'run1', projectId: 'proj1', userId: 'user1' }
            : opts.runContext,
        ),
    },
    productFeedImportItem: {
      findMany: jest.fn().mockResolvedValue(opts.items ?? []),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: opts.itemClaimCount ?? 1 }),
      update: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(opts.remaining ?? 0),
    },
    project: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.project === undefined ? { currency: 'UAH' } : opts.project,
        ),
    },
    productItem: {
      update: jest.fn().mockResolvedValue(undefined),
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
    $transaction: jest.fn((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => unknown)({
          productFeedImportItem: { createMany: txCreateMany },
          productFeedImportRun: { update: txRunUpdate },
        });
      }
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };
  const projectService = { addItem: jest.fn() };
  const blob = { uploadBuffer: jest.fn() };
  const service = new ProductFeedImportWorkerService(
    prisma as never,
    projectService as never,
    blob as never,
  );
  return { service, prisma, projectService, blob, txCreateMany, txRunUpdate };
}

beforeEach(() => {
  configState.cronBatch = 5;
  configState.maxAttempts = 3;
  configState.maxFeedBytes = 8 * 1024 * 1024;
  global.fetch = jest.fn() as unknown as typeof fetch;
  // По умолчанию — прозрачная передача в замоканный global.fetch, без
  // редиректной логики (см. комментарий у jest.mock выше).
  guardMock
    .mockReset()
    .mockImplementation((url: string, init?: RequestInit) =>
      (global.fetch as typeof fetch)(url, init),
    );
  parseFeedMock.mockReset();
});

describe('runTick — фаза 1 (забрать фид)', () => {
  it('нет claimable-запусков — fetchedRuns: 0, к сети не обращается', async () => {
    const { service } = setup({ runs: [] });
    const result = await service.runTick();
    expect(result.fetchedRuns).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('claim не удался (перекрывающийся тик) — строка пропускается без обращения к сети', async () => {
    const { service } = setup({ runs: [runRow()], runClaimCount: 0 });
    const result = await service.runTick();
    expect(result.fetchedRuns).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('успех: скачивает, разбирает, заводит строки, переводит запуск в IMPORTING', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: jsonHeaders({ 'content-length': null }),
      text: () => Promise.resolve('<yml_catalog/>'),
      arrayBuffer: () => Promise.resolve(Buffer.from('<yml_catalog/>', 'utf8')),
    });
    parseFeedMock.mockReturnValue({
      format: 'yml',
      rows: [
        {
          title: 'Товар 1',
          price: 100,
          currency: 'UAH',
          description: undefined,
          photoUrl: undefined,
          categoryText: undefined,
        },
      ],
    });
    const { service, txCreateMany, txRunUpdate } = setup({ runs: [runRow()] });
    const result = await service.runTick();

    expect(result.fetchedRuns).toBe(1);
    // Воркер зовёт редирект-safe `fetchPubliclyRoutable` (Д-3.1, пятый
    // аудит), а не «голый» `fetch` — редиректная логика самой функции
    // подробно проверена отдельно, в external-url-guard.spec.ts.
    expect(guardMock).toHaveBeenCalledWith(
      'https://seller.test/feed.yml',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(txCreateMany).toHaveBeenCalledWith({
      data: [
        {
          runId: 'run1',
          rowIndex: 0,
          title: 'Товар 1',
          price: 100,
          currency: 'UAH',
          description: null,
          photoUrl: null,
          categoryText: null,
        },
      ],
    });
    expect(txRunUpdate).toHaveBeenCalledWith({
      where: { id: 'run1' },
      data: {
        status: 'IMPORTING',
        totalRows: 1,
        lockedUntil: null,
        error: null,
      },
    });
  });

  it('SSRF-отказ, в том числе через редирект (адрес небезопасен) — сразу терминальный FAILED, без бэкоффа', async () => {
    // На этом уровне неважно, отказала ли `fetchPubliclyRoutable` на
    // исходном адресе или на адресе редиректа (Д-3.1) — воркер видит
    // только итоговое исключение; то, что редирект-хопы ДЕЙСТВИТЕЛЬНО
    // перепроверяются, покрыто отдельно в external-url-guard.spec.ts.
    const { UnsafeExternalUrlError } = jest.requireActual(
      '../../common/external-url-guard',
    );
    guardMock.mockRejectedValue(new UnsafeExternalUrlError('nope'));
    const { service, prisma } = setup({ runs: [runRow()] });
    await service.runTick();
    expect(prisma.productFeedImportRun.update).toHaveBeenCalledWith({
      where: { id: 'run1' },
      data: expect.objectContaining({
        attempts: 1,
        status: 'FAILED',
        nextAttemptAt: null,
      }),
    });
  });

  it('пустой фид (0 строк) — терминальный FAILED, ретраить нечего', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: jsonHeaders(),
      text: () => Promise.resolve('name,price\n'),
      arrayBuffer: () => Promise.resolve(Buffer.from('name,price\n', 'utf8')),
    });
    parseFeedMock.mockReturnValue({ format: 'csv', rows: [] });
    const { service, prisma } = setup({ runs: [runRow()] });
    await service.runTick();
    expect(prisma.productFeedImportRun.update).toHaveBeenCalledWith({
      where: { id: 'run1' },
      data: expect.objectContaining({ status: 'FAILED', nextAttemptAt: null }),
    });
  });

  it('фид превышает лимит по Content-Length — терминальный FAILED (быстрый отказ, тело не читается)', async () => {
    configState.maxFeedBytes = 100;
    const arrayBuffer = jest.fn();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: jsonHeaders({ 'content-length': '999999' }),
      text: () => Promise.resolve(''),
      arrayBuffer,
    });
    const { service, prisma } = setup({ runs: [runRow()] });
    await service.runTick();
    expect(prisma.productFeedImportRun.update).toHaveBeenCalledWith({
      where: { id: 'run1' },
      data: expect.objectContaining({ status: 'FAILED', nextAttemptAt: null }),
    });
    // Быстрый отказ по заголовку — тело даже не запрашивается.
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('Д-3.2: фид БЕЗ Content-Length, но фактическое тело превышает предел — терминальный FAILED (потоковая проверка, а не только по заголовку)', async () => {
    configState.maxFeedBytes = 10;
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      // Заголовка нет вовсе (chunked-ответ) — старая постфактум-проверка
      // по Content-Length ничего бы не поймала на этом шаге.
      headers: jsonHeaders({ 'content-length': null }),
      text: () => Promise.resolve('a'.repeat(1000)),
      arrayBuffer: () => Promise.resolve(Buffer.from('a'.repeat(1000), 'utf8')),
    });
    const { service, prisma } = setup({ runs: [runRow()] });
    await service.runTick();
    expect(prisma.productFeedImportRun.update).toHaveBeenCalledWith({
      where: { id: 'run1' },
      data: expect.objectContaining({ status: 'FAILED', nextAttemptAt: null }),
    });
  });

  it('сетевой сбой (HTTP не ok) — временная ошибка: бэкофф, НЕ терминальный сразу', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 503,
      headers: jsonHeaders(),
      text: () => Promise.resolve(''),
    });
    const { service, prisma } = setup({ runs: [runRow()] });
    await service.runTick();
    expect(prisma.productFeedImportRun.update).toHaveBeenCalledWith({
      where: { id: 'run1' },
      data: expect.objectContaining({
        attempts: 1,
        status: 'FAILED',
        nextAttemptAt: expect.any(Date),
      }),
    });
  });

  it('попытки исчерпаны — терминальный FAILED без nextAttemptAt, даже для временной ошибки', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 503,
      headers: jsonHeaders(),
      text: () => Promise.resolve(''),
    });
    const { service, prisma } = setup({
      runs: [runRow({ attempts: configState.maxAttempts - 1 })],
    });
    await service.runTick();
    expect(prisma.productFeedImportRun.update).toHaveBeenCalledWith({
      where: { id: 'run1' },
      data: expect.objectContaining({
        attempts: configState.maxAttempts,
        status: 'FAILED',
        nextAttemptAt: null,
      }),
    });
  });
});

describe('runTick — фаза 2 (завести позиции)', () => {
  it('нет claimable-строк — нулевые счётчики, запуск не завершается', async () => {
    const { service, prisma } = setup({ items: [] });
    const result = await service.runTick();
    expect(result).toEqual(
      expect.objectContaining({
        importedItems: 0,
        skippedItems: 0,
        failedItems: 0,
      }),
    );
    expect(prisma.productFeedImportItem.count).not.toHaveBeenCalled();
  });

  it('claim строки не удался — пропускается без чтения контекста запуска', async () => {
    const { service, prisma } = setup({
      items: [itemRow()],
      itemClaimCount: 0,
    });
    await service.runTick();
    expect(prisma.productFeedImportRun.findUnique).not.toHaveBeenCalled();
  });

  it('нет обязательных полей (нет цены) — SKIPPED с понятной причиной', async () => {
    const { service, prisma } = setup({
      items: [itemRow({ price: null })],
    });
    const result = await service.runTick();
    expect(result.skippedItems).toBe(1);
    expect(prisma.productFeedImportItem.update).toHaveBeenCalledWith({
      where: { id: 'item1' },
      data: expect.objectContaining({
        status: 'SKIPPED',
        reason: expect.stringContaining('обязательных полей'),
      }),
    });
  });

  it('валюта строки не совпадает с валютой проекта — SKIPPED', async () => {
    const { service, prisma } = setup({
      items: [itemRow({ currency: 'USD' })],
      runContext: { id: 'run1', projectId: 'proj1', userId: 'user1' },
      project: { currency: 'UAH' },
    });
    const result = await service.runTick();
    expect(result.skippedItems).toBe(1);
    expect(prisma.productFeedImportItem.update).toHaveBeenCalledWith({
      where: { id: 'item1' },
      data: expect.objectContaining({
        status: 'SKIPPED',
        reason: expect.stringContaining('Валюта строки фида'),
      }),
    });
  });

  it('успешный импорт с категорией — addItem, затем category дописывается напрямую, IMPORTED', async () => {
    const { service, prisma, projectService } = setup({
      items: [itemRow({ categoryText: 'Обувь' })],
    });
    projectService.addItem.mockResolvedValue({ id: 'newpi1' });
    const result = await service.runTick();
    expect(result.importedItems).toBe(1);
    expect(projectService.addItem).toHaveBeenCalledWith('user1', 'proj1', {
      title: 'Товар',
      price: 100,
      description: undefined,
      priceSource: 'MANUAL',
    });
    expect(prisma.productItem.update).toHaveBeenCalledWith({
      where: { id: 'newpi1' },
      data: { category: 'Обувь' },
    });
    expect(prisma.productFeedImportItem.update).toHaveBeenCalledWith({
      where: { id: 'item1' },
      data: expect.objectContaining({
        status: 'IMPORTED',
        productItemId: 'newpi1',
      }),
    });
  });

  it('Д-2.4: прикрепление категории/фото упало — товар всё равно IMPORTED (мягкая деградация), но причина не пропадает бесследно', async () => {
    const { service, prisma, projectService } = setup({
      items: [itemRow({ categoryText: 'Обувь' })],
    });
    projectService.addItem.mockResolvedValue({ id: 'newpi1' });
    prisma.productItem.update.mockRejectedValue(new Error('DB timeout'));
    const result = await service.runTick();

    expect(result.importedItems).toBe(1); // товар всё равно импортирован
    // Раньше .catch(() => undefined) здесь молчал НАВСЕГДА — строка уже
    // IMPORTED (терминальный статус), воркер к ней больше не вернётся, а
    // "попробуем на следующем опросе" здесь не работает в принципе.
    // Теперь причина остаётся на самой строке фида — видна оператору.
    expect(prisma.productFeedImportItem.update).toHaveBeenCalledWith({
      where: { id: 'item1' },
      data: expect.objectContaining({
        reason: expect.stringContaining('категория/фото'),
      }),
    });
    // ...и штатное завершение строки (IMPORTED) всё равно происходит —
    // сбой этого второстепенного шага не отменяет уже созданную позицию.
    expect(prisma.productFeedImportItem.update).toHaveBeenCalledWith({
      where: { id: 'item1' },
      data: expect.objectContaining({
        status: 'IMPORTED',
        productItemId: 'newpi1',
      }),
    });
  });

  it('Д-2.1: успешный addItem() — productItemId фиксируется на строке СРАЗУ, отдельно от финального resolveItem', async () => {
    const { service, prisma, projectService } = setup({
      items: [itemRow()],
    });
    projectService.addItem.mockResolvedValue({ id: 'newpi1' });
    await service.runTick();
    expect(prisma.productFeedImportItem.update).toHaveBeenCalledWith({
      where: { id: 'item1' },
      data: { productItemId: 'newpi1' },
    });
  });

  it('Д-2.1: строка уже заводила товар в прошлой попытке (productItemId уже проставлен) — addItem() НЕ вызывается повторно, товар не дублируется', async () => {
    const { service, prisma, projectService } = setup({
      items: [itemRow({ productItemId: 'existing-pi' })],
    });
    const result = await service.runTick();
    expect(result.importedItems).toBe(1);
    expect(projectService.addItem).not.toHaveBeenCalled();
    expect(prisma.productFeedImportItem.update).toHaveBeenCalledWith({
      where: { id: 'item1' },
      data: expect.objectContaining({
        status: 'IMPORTED',
        productItemId: 'existing-pi',
      }),
    });
  });

  it('лимит товаров проекта достигнут — SKIPPED, а остальные PENDING-строки запуска пропускаются одним заходом', async () => {
    const { BadRequestException } = jest.requireActual('@nestjs/common');
    const { service, prisma, projectService } = setup({
      items: [itemRow()],
    });
    projectService.addItem.mockRejectedValue(
      new BadRequestException('Line limit reached'),
    );
    const result = await service.runTick();
    expect(result.skippedItems).toBe(1);
    expect(prisma.productFeedImportItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runId: 'run1',
          id: { not: 'item1' },
        }),
        data: expect.objectContaining({ status: 'SKIPPED' }),
      }),
    );
  });

  it('addItem отказал по другой причине (не лимит) — SKIPPED, остальные строки не трогает массово', async () => {
    const { BadRequestException } = jest.requireActual('@nestjs/common');
    const { service, prisma, projectService } = setup({
      items: [itemRow()],
    });
    projectService.addItem.mockRejectedValue(
      new BadRequestException('Некорректная цена'),
    );
    const result = await service.runTick();
    expect(result.skippedItems).toBe(1);
    const massSkip = prisma.productFeedImportItem.updateMany.mock.calls.find(
      (call) => call[0]?.data?.status === 'SKIPPED',
    );
    expect(massSkip).toBeUndefined();
  });

  it('непредвиденная ошибка при заведении — временный FAILED с бэкоффом (не SKIPPED)', async () => {
    const { service, prisma, projectService } = setup({
      items: [itemRow()],
    });
    projectService.addItem.mockRejectedValue(new Error('DB hiccup'));
    const result = await service.runTick();
    expect(result.failedItems).toBe(1);
    expect(prisma.productFeedImportItem.update).toHaveBeenCalledWith({
      where: { id: 'item1' },
      data: expect.objectContaining({
        attempts: 1,
        status: 'FAILED',
        nextAttemptAt: expect.any(Date),
      }),
    });
  });

  it('после обработки всех строк запуска — переводит запуск в DONE', async () => {
    const { service, prisma, projectService } = setup({
      items: [itemRow()],
      remaining: 0,
    });
    projectService.addItem.mockResolvedValue({ id: 'newpi1' });
    await service.runTick();
    expect(prisma.productFeedImportRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run1', status: 'IMPORTING' },
      data: { status: 'DONE', completedAt: expect.any(Date) },
    });
  });

  it('остались необработанные строки запуска — DONE не выставляется', async () => {
    const { service, prisma, projectService } = setup({
      items: [itemRow()],
      remaining: 2,
    });
    projectService.addItem.mockResolvedValue({ id: 'newpi1' });
    await service.runTick();
    expect(prisma.productFeedImportRun.updateMany).not.toHaveBeenCalled();
  });
});

describe('джоб-уровневый замок (Д-3.3, пятый аудит)', () => {
  it('замок уже удерживает другой прогон — весь тик (обе фазы) пропускается', async () => {
    const { service, prisma } = setup({
      jobLockHeld: true,
      runs: [runRow()],
      items: [itemRow()],
    });
    const result = await service.runTick();
    expect(result).toEqual({
      fetchedRuns: 0,
      importedItems: 0,
      skippedItems: 0,
      failedItems: 0,
    });
    expect(prisma.productFeedImportRun.findMany).not.toHaveBeenCalled();
    expect(prisma.productFeedImportItem.findMany).not.toHaveBeenCalled();
  });

  it('замок свободен — захватывается и снимается явно по завершении тика', async () => {
    const { service, prisma } = setup({ runs: [], items: [] });
    await service.runTick();
    expect(prisma.cronJobLock.create).toHaveBeenCalledWith({
      data: {
        jobKey: 'feed-import-run',
        lockedUntil: expect.any(Date),
        ownerToken: expect.any(String),
      },
    });
    expect(prisma.cronJobLock.updateMany).toHaveBeenCalledWith({
      where: { jobKey: 'feed-import-run', ownerToken: expect.any(String) },
      data: { lockedUntil: null, ownerToken: null },
    });
  });
});
