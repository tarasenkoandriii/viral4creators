import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CatalogBatchService } from './catalog-batch.service';
import { SessionStatus } from '../../common/types/session.types';
import { GenerationStatus } from '../../common/types/generation.types';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

// project.service.ts тянет за собой рантайм-импорт `@prisma/client`
// (`import { Prisma } from '@prisma/client'`, не только типы) —
// сгенерированного клиента в песочнице нет (известное ограничение, см.
// тот же приём в product-feed-import-worker.service.spec.ts). Мокаем
// только то, что реально используется здесь — чистую функцию
// `isItemComplete`, воспроизведённую 1:1 из настоящей реализации.
jest.mock('../project/project.service', () => ({
  isItemComplete: (item: { price: unknown; description: string | null }) =>
    item.price !== null && (item.description?.trim().length ?? 0) > 0,
}));

function sourceSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'src-session',
    userId: 'user1',
    projectId: 'proj1',
    productItemId: 'pi-source',
    status: SessionStatus.VIDEO_COMPLETE,
    librarySourceKey: 'lib-key-1',
    locale: 'ru',
    generatedVideo: {
      generatedVideoId: 'gv1',
      pathname: 'sessions/src-session/generated.mp4',
      fileName: 'generated.mp4',
      mimeType: 'video/mp4',
      status: GenerationStatus.COMPLETE,
      initiatedAt: new Date(),
      quality: 'fast',
      aspectRatio: '9:16',
    },
    ...overrides,
  };
}

function productItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    price: 100,
    description: 'Описание товара',
    photoUrl: 'https://blob.test/photo.png',
    ...overrides,
  };
}

function setup(
  opts: {
    source?: unknown;
    items?: unknown[];
    busy?: unknown[];
    /** Что видит проверка ВНУТРИ транзакции (Д-2.2) — по умолчанию то же
     * самое, что и предварительная (снаружи), если явно не задано другое
     * (симулирует конкурентную вставку между двумя проверками). */
    stillBusy?: unknown[];
    libraryEntry?: unknown;
    /** $transaction бросает {code:'P2034'} (сериализационный конфликт)
     * это число раз подряд перед тем, как выполниться успешно. */
    serializationFailuresBeforeSuccess?: number;
  } = {},
) {
  const sessions = {
    getSession: jest
      .fn()
      .mockResolvedValue(
        opts.source === undefined ? sourceSession() : opts.source,
      ),
  };
  // Отдельная переменная, а не self-reference внутри объекта `prisma` —
  // TS не может вывести тип `prisma` из инициализатора, ссылающегося на
  // саму себя (TS7022/TS7024).
  const catalogBatchRun = {
    create: jest.fn().mockResolvedValue({ id: 'batch1' }),
    findUnique: jest.fn(),
  };
  const txCatalogBatchItem = {
    findMany: jest
      .fn()
      .mockResolvedValue(
        opts.stillBusy === undefined ? (opts.busy ?? []) : opts.stillBusy,
      ),
    createMany: jest.fn().mockResolvedValue(undefined),
  };
  let remainingFailures = opts.serializationFailuresBeforeSuccess ?? 0;
  const prisma = {
    analysisLibraryEntry: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.libraryEntry === undefined
            ? { id: 'entry1' }
            : opts.libraryEntry,
        ),
    },
    productItem: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          opts.items === undefined
            ? [productItem('pi1'), productItem('pi2')]
            : opts.items,
        ),
    },
    catalogBatchItem: {
      findMany: jest.fn().mockResolvedValue(opts.busy ?? []),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    catalogBatchRun,
    $transaction: jest.fn(
      async (
        fn: (tx: unknown) => unknown,
        options?: { isolationLevel?: string },
      ) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          const err = new Error('could not serialize access');
          (err as { code?: string }).code = 'P2034';
          throw err;
        }
        expect(options).toEqual({ isolationLevel: 'Serializable' });
        return fn({
          catalogBatchRun,
          catalogBatchItem: txCatalogBatchItem,
        });
      },
    ),
  };
  const plans = {
    assertUser: jest.fn().mockResolvedValue(undefined),
  };
  const service = new CatalogBatchService(
    prisma as never,
    sessions as never,
    plans as never,
  );
  return { service, prisma, sessions, plans, txCatalogBatchItem };
}

describe('CatalogBatchService.create', () => {
  it('план проверяется первым делом — тем же признаком, что и обычная библиотека', async () => {
    const { service, plans } = setup();
    await service.create('user1', 'proj1', {
      sourceSessionId: 'src-session',
      productItemIds: ['pi1', 'pi2'],
    });
    expect(plans.assertUser).toHaveBeenCalledWith('user1', 'library');
  });

  it('исходная сессия не найдена — 404', async () => {
    const { service, sessions } = setup();
    sessions.getSession.mockResolvedValue(undefined);
    await expect(
      service.create('user1', 'proj1', {
        sourceSessionId: 'missing',
        productItemIds: ['pi1'],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('исходная сессия принадлежит другому пользователю — 404, а не 403 (не подтверждаем существование)', async () => {
    const { service, sessions } = setup();
    sessions.getSession.mockResolvedValue(
      sourceSession({ userId: 'someone-else' }),
    );
    await expect(
      service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
        productItemIds: ['pi1'],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('исходный ролик ещё не готов — 400 с понятным текстом', async () => {
    const { service, sessions } = setup();
    sessions.getSession.mockResolvedValue(
      sourceSession({
        status: SessionStatus.PROMPT_GENERATED,
        generatedVideo: undefined,
      }),
    );
    await expect(
      service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
        productItemIds: ['pi1'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('у исходной сессии нет разбора в библиотеке — 400 (не должно случаться в обычном потоке)', async () => {
    const { service, sessions } = setup();
    sessions.getSession.mockResolvedValue(
      sourceSession({ librarySourceKey: null }),
    );
    await expect(
      service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
        productItemIds: ['pi1'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('исходный товар исключается из списка сам собой, если его прислали', async () => {
    const { service, prisma } = setup();
    const result = await service.create('user1', 'proj1', {
      sourceSessionId: 'src-session',
      productItemIds: ['pi-source', 'pi1', 'pi2'],
    });
    expect(result.itemCount).toBe(2);
    expect(prisma.productItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['pi1', 'pi2'] }, projectId: 'proj1' },
      }),
    );
  });

  it('список пуст после исключения источника — 400', async () => {
    const { service } = setup();
    await expect(
      service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
        productItemIds: ['pi-source'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('запрошен товар не из этого проекта — 404 с перечислением пропавших', async () => {
    const { service } = setup({ items: [productItem('pi1')] });
    await expect(
      service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
        productItemIds: ['pi1', 'pi-ghost'],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('незаполненный товар (нет цены/описания) — 400, партия не создаётся', async () => {
    const { service } = setup({
      items: [productItem('pi1', { price: null })],
    });
    await expect(
      service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
        productItemIds: ['pi1'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('товар без фото — 400, даже если isItemComplete (цена+описание) прошла: нет ручной остановки, значит нельзя ставить в очередь заведомо провальный товар', async () => {
    const { service } = setup({
      items: [productItem('pi1', { photoUrl: null })],
    });
    await expect(
      service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
        productItemIds: ['pi1'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('товар уже в очереди другой партии — пропускается (skipped), не дублируется', async () => {
    const { service, prisma } = setup({
      busy: [{ productItemId: 'pi1' }],
    });
    const result = await service.create('user1', 'proj1', {
      sourceSessionId: 'src-session',
      productItemIds: ['pi1', 'pi2'],
    });
    expect(result.skipped).toEqual(['pi1']);
    expect(result.itemCount).toBe(1);
    expect(prisma.catalogBatchRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: 'proj1',
          userId: 'user1',
          libraryEntryId: 'entry1',
          sourceSessionId: 'src-session',
          quality: 'fast',
          aspectRatio: '9:16',
          locale: 'ru',
        }),
      }),
    );
  });

  it('все выбранные товары заняты другой партией — 400, партия не создаётся вовсе', async () => {
    const { service, prisma } = setup({
      busy: [{ productItemId: 'pi1' }, { productItemId: 'pi2' }],
    });
    await expect(
      service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
        productItemIds: ['pi1', 'pi2'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.catalogBatchRun.create).not.toHaveBeenCalled();
  });

  it('Д-1.2: товар уже DONE в другой партии — тоже пропускается (skipped), не заводит повторный оплаченный рендер', async () => {
    const { service, prisma } = setup({
      busy: [{ productItemId: 'pi1' }],
    });
    const result = await service.create('user1', 'proj1', {
      sourceSessionId: 'src-session',
      productItemIds: ['pi1', 'pi2'],
    });
    expect(result.skipped).toEqual(['pi1']);
    expect(prisma.catalogBatchItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['PENDING', 'GENERATING', 'DONE'] },
        }),
      }),
    );
  });

  it('Д-2.2: транзакция Serializable — проверка "занят" повторяется ВНУТРИ транзакции по её собственному tx-клиенту', async () => {
    const { service, txCatalogBatchItem } = setup({ busy: [] });
    await service.create('user1', 'proj1', {
      sourceSessionId: 'src-session',
      productItemIds: ['pi1', 'pi2'],
    });
    expect(txCatalogBatchItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['PENDING', 'GENERATING', 'DONE'] },
        }),
      }),
    );
  });

  it('Д-2.2: конкурентная транзакция успела занять товар между предварительной проверкой и транзакцией — итог по tx-проверке, не по предварительной', async () => {
    const { service, prisma, txCatalogBatchItem } = setup({
      busy: [],
      stillBusy: [{ productItemId: 'pi1' }],
    });
    const result = await service.create('user1', 'proj1', {
      sourceSessionId: 'src-session',
      productItemIds: ['pi1', 'pi2'],
    });
    expect(result.skipped).toEqual(['pi1']);
    expect(result.itemCount).toBe(1);
    // Предварительная проверка (вне транзакции) видит пусто ("занятых"
    // нет) — конкурентная вставка происходит уже ПОСЛЕ нее, поэтому
    // именно проверка ВНУТРИ транзакции (по её собственному tx-клиенту)
    // обязана увидеть 'pi1' занятым — иначе Д-2.2 не была бы закрыта.
    expect(prisma.catalogBatchItem.findMany).toHaveBeenCalledTimes(1);
    expect(txCatalogBatchItem.findMany).toHaveBeenCalledTimes(1);
  });

  it('Д-2.2: конкурентная транзакция заняла ВСЕ товары к моменту tx-проверки — 400, транзакция откатывается', async () => {
    const { service, prisma } = setup({
      busy: [],
      stillBusy: [{ productItemId: 'pi1' }, { productItemId: 'pi2' }],
    });
    await expect(
      service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
        productItemIds: ['pi1', 'pi2'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.catalogBatchRun.create).not.toHaveBeenCalled();
  });

  it('Д-2.2: ошибка сериализации (P2034) — транзакция перезапускается автоматически и в итоге проходит', async () => {
    const { service, prisma } = setup({
      busy: [],
      serializationFailuresBeforeSuccess: 2,
    });
    const result = await service.create('user1', 'proj1', {
      sourceSessionId: 'src-session',
      productItemIds: ['pi1', 'pi2'],
    });
    expect(result.itemCount).toBe(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3); // 2 провала + 1 успех
  });

  it('Д-2.2: ошибка сериализации повторяется больше лимита ретраев — пробрасывается наружу', async () => {
    const { service } = setup({
      busy: [],
      serializationFailuresBeforeSuccess: 10,
    });
    await expect(
      service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
        productItemIds: ['pi1', 'pi2'],
      }),
    ).rejects.toMatchObject({ code: 'P2034' });
  });
});

describe('CatalogBatchService.retry', () => {
  function setupRetry(
    opts: {
      run?: unknown;
      /** FAILED-строки этой партии, подходящие под запрос. */
      candidates?: { id: string; productItemId: string }[];
      /** Что находит проверка busy В ДРУГИХ партиях (Е-2.4 шестого аудита). */
      busy?: { productItemId: string }[];
      serializationFailuresBeforeSuccess?: number;
    } = {},
  ) {
    const catalogBatchRun = {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.run === undefined
            ? { id: 'batch1', userId: 'user1', projectId: 'proj1' }
            : opts.run,
        ),
    };
    const candidates =
      opts.candidates === undefined
        ? [{ id: 'item1', productItemId: 'pi1' }]
        : opts.candidates;
    const busy = opts.busy ?? [];
    // Два разных findMany подряд внутри одной транзакции (кандидаты FAILED,
    // затем busy-check в других партиях) — различаем по наличию `not` в
    // where.batchId, тем же приёмом, что и другие моки этого файла.
    const txCatalogBatchItem = {
      findMany: jest.fn((args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          args.where.batchId && typeof args.where.batchId === 'object'
            ? busy
            : candidates,
        ),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    let remainingFailures = opts.serializationFailuresBeforeSuccess ?? 0;
    const prisma = {
      catalogBatchRun,
      catalogBatchItem: txCatalogBatchItem,
      $transaction: jest.fn(
        async (
          fn: (tx: unknown) => unknown,
          options?: { isolationLevel?: string },
        ) => {
          if (remainingFailures > 0) {
            remainingFailures -= 1;
            const err = new Error('could not serialize access');
            (err as { code?: string }).code = 'P2034';
            throw err;
          }
          expect(options).toEqual({ isolationLevel: 'Serializable' });
          return fn({ catalogBatchRun, catalogBatchItem: txCatalogBatchItem });
        },
      ),
    };
    const service = new CatalogBatchService(
      prisma as never,
      { getSession: jest.fn() } as never,
      { assertUser: jest.fn() } as never,
    );
    return { service, prisma, txCatalogBatchItem };
  }

  it('партия не найдена/не своя — 404', async () => {
    const { service } = setupRetry({ run: null });
    await expect(
      service.retry('user1', 'proj1', 'batch1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('без productItemId — повторяет ВСЕ FAILED-строки партии, сбрасывая попытки/ошибку/замок', async () => {
    const { service, txCatalogBatchItem } = setupRetry({
      candidates: [
        { id: 'item1', productItemId: 'pi1' },
        { id: 'item2', productItemId: 'pi2' },
        { id: 'item3', productItemId: 'pi3' },
      ],
    });
    const result = await service.retry('user1', 'proj1', 'batch1');
    expect(result).toEqual({ retried: 3, skippedBusy: [] });
    expect(txCatalogBatchItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['item1', 'item2', 'item3'] } },
      data: {
        status: 'PENDING',
        error: null,
        attempts: 0,
        nextAttemptAt: null,
        lockedUntil: null,
      },
    });
  });

  it('с productItemId — повторяет только одну строку (точечный повтор, Д-1.3)', async () => {
    const { service, txCatalogBatchItem } = setupRetry();
    const result = await service.retry('user1', 'proj1', 'batch1', 'pi1');
    expect(result).toEqual({ retried: 1, skippedBusy: [] });
    expect(txCatalogBatchItem.findMany).toHaveBeenNthCalledWith(1, {
      where: { batchId: 'batch1', status: 'FAILED', productItemId: 'pi1' },
      select: { id: true, productItemId: true },
    });
  });

  it('нет FAILED-строк, подходящих под запрос — 400, ничего не сброшено', async () => {
    const { service, txCatalogBatchItem } = setupRetry({ candidates: [] });
    await expect(
      service.retry('user1', 'proj1', 'batch1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(txCatalogBatchItem.updateMany).not.toHaveBeenCalled();
  });

  it('sessionId НЕ сбрасывается — воркер резюмирует обработку с той же дочерней сессии (см. Д-2.5)', async () => {
    const { service, txCatalogBatchItem } = setupRetry();
    await service.retry('user1', 'proj1', 'batch1', 'pi1');
    const call = txCatalogBatchItem.updateMany.mock.calls[0][0];
    expect(call.data).not.toHaveProperty('sessionId');
  });

  describe('Е-2.4 шестого аудита (рецидив класса Д-2.2): productItemId уже занят ДРУГОЙ активной партией', () => {
    it('точечный повтор занятого товара — 400, ничего не сброшено', async () => {
      const { service, txCatalogBatchItem } = setupRetry({
        candidates: [{ id: 'item1', productItemId: 'pi1' }],
        busy: [{ productItemId: 'pi1' }],
      });
      await expect(
        service.retry('user1', 'proj1', 'batch1', 'pi1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(txCatalogBatchItem.updateMany).not.toHaveBeenCalled();
    });

    it('массовый повтор — занятый товар исключается, остальные повторяются, оба видны в ответе', async () => {
      const { service, txCatalogBatchItem } = setupRetry({
        candidates: [
          { id: 'item1', productItemId: 'pi1' },
          { id: 'item2', productItemId: 'pi2' },
        ],
        busy: [{ productItemId: 'pi1' }],
      });
      const result = await service.retry('user1', 'proj1', 'batch1');
      expect(result).toEqual({ retried: 1, skippedBusy: ['pi1'] });
      expect(txCatalogBatchItem.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['item2'] } },
        data: expect.objectContaining({ status: 'PENDING' }),
      });
    });

    it('все кандидаты заняты другими партиями — 400, ничего не сброшено', async () => {
      const { service, txCatalogBatchItem } = setupRetry({
        candidates: [
          { id: 'item1', productItemId: 'pi1' },
          { id: 'item2', productItemId: 'pi2' },
        ],
        busy: [{ productItemId: 'pi1' }, { productItemId: 'pi2' }],
      });
      await expect(
        service.retry('user1', 'proj1', 'batch1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(txCatalogBatchItem.updateMany).not.toHaveBeenCalled();
    });

    it('busy-check ищет только в ДРУГИХ партиях (batchId: {not: batchId})', async () => {
      const { service, txCatalogBatchItem } = setupRetry();
      await service.retry('user1', 'proj1', 'batch1', 'pi1');
      expect(txCatalogBatchItem.findMany).toHaveBeenNthCalledWith(2, {
        where: {
          batchId: { not: 'batch1' },
          productItemId: { in: ['pi1'] },
          status: { in: ['PENDING', 'GENERATING', 'DONE'] },
        },
        select: { productItemId: true },
      });
    });
  });

  describe('Е-2.4/Д-2.2: сериализационный конфликт (P2034) — вся транзакция повторяется', () => {
    it('перезапускается после 2 конфликтов подряд и в итоге проходит', async () => {
      const { service, prisma } = setupRetry({
        serializationFailuresBeforeSuccess: 2,
      });
      const result = await service.retry('user1', 'proj1', 'batch1', 'pi1');
      expect(result).toEqual({ retried: 1, skippedBusy: [] });
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });
  });
});

describe('CatalogBatchService.getStatus', () => {
  function setupStatus(
    opts: {
      run?: unknown;
      session?: unknown;
    } = {},
  ) {
    const sessions = {
      getSession: jest.fn().mockResolvedValue(opts.session),
    };
    const prisma = {
      catalogBatchRun: {
        findUnique: jest.fn().mockResolvedValue(opts.run),
      },
      catalogBatchItem: {
        update: jest.fn().mockReturnValue({
          catch: jest.fn().mockResolvedValue(undefined),
        }),
      },
    };
    const service = new CatalogBatchService(
      prisma as never,
      sessions as never,
      { assertUser: jest.fn() } as never,
    );
    return { service, prisma, sessions };
  }

  it('партия не найдена/не своя — 404', async () => {
    const { service } = setupStatus({ run: null });
    await expect(
      service.getStatus('user1', 'proj1', 'batch1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('GENERATING со свежезавершённым рендером — статус в ответе становится DONE, живьём из сессии', async () => {
    const { service, prisma } = setupStatus({
      run: {
        id: 'batch1',
        userId: 'user1',
        projectId: 'proj1',
        items: [
          {
            id: 'item1',
            productItemId: 'pi1',
            sessionId: 'sess1',
            status: 'GENERATING',
            error: null,
            productItem: { title: 'Товар 1', photoUrl: null },
          },
        ],
      },
      session: {
        generatedVideo: { status: GenerationStatus.COMPLETE },
      },
    });
    const result = await service.getStatus('user1', 'proj1', 'batch1');
    expect(result.items[0].status).toBe('DONE');
    expect(result.summary).toEqual({
      pending: 0,
      generating: 0,
      done: 1,
      failed: 0,
    });
    expect(prisma.catalogBatchItem.update).toHaveBeenCalledWith({
      where: { id: 'item1' },
      data: { status: 'DONE' },
    });
  });

  it('GENERATING с провалившимся рендером — статус FAILED и текст ошибки из сессии', async () => {
    const { service } = setupStatus({
      run: {
        id: 'batch1',
        userId: 'user1',
        projectId: 'proj1',
        items: [
          {
            id: 'item1',
            productItemId: 'pi1',
            sessionId: 'sess1',
            status: 'GENERATING',
            error: null,
            productItem: { title: 'Товар 1', photoUrl: null },
          },
        ],
      },
      session: {
        generatedVideo: {
          status: GenerationStatus.FAILED,
          error: { message: 'Veo отказал' },
        },
      },
    });
    const result = await service.getStatus('user1', 'proj1', 'batch1');
    expect(result.items[0].status).toBe('FAILED');
    expect(result.items[0].error).toBe('Veo отказал');
  });

  it('PENDING без sessionId — не трогает сессии вовсе', async () => {
    const { service, sessions } = setupStatus({
      run: {
        id: 'batch1',
        userId: 'user1',
        projectId: 'proj1',
        items: [
          {
            id: 'item1',
            productItemId: 'pi1',
            sessionId: null,
            status: 'PENDING',
            error: null,
            productItem: { title: 'Товар 1', photoUrl: null },
          },
        ],
      },
    });
    const result = await service.getStatus('user1', 'proj1', 'batch1');
    expect(result.items[0].status).toBe('PENDING');
    expect(sessions.getSession).not.toHaveBeenCalled();
  });
});
