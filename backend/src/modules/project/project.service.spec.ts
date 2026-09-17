/**
 * ProjectService unit tests — Prisma is mocked, so these cover the
 * service's own decisions (doc/PRODUCT-PROJECT-SPEC.md §7.1–§7.4, §7.8,
 * §12 ownership), not the database. FK/cascade semantics were verified
 * against a real Postgres in Stage 2 (doc/DATABASE-AUDIT.md).
 *
 * Run: `npm test -- project.service` (backend/). In the sandbox where
 * `prisma generate` can't run, ts-jest's type diagnostics must be off —
 * see doc/TELEGRAM-ADMIN.md §5; locally with a generated client the
 * default config type-checks these too.
 */

// PrismaService is only a DI token here — the real class pulls in the
// generated @prisma/client, which doesn't exist until `prisma generate`
// has run (never, in the sandbox). Stub the module so the test doesn't
// depend on generation at all; the service gets a hand-made mock below.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ProjectService,
  isItemComplete,
  itemDataFromDto,
  toProjectSummaryView,
} from './project.service';

const USER = 'user-1';
const NOW = new Date('2026-09-05T12:00:00.000Z');

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    type: 'LINE' as const,
    title: 'Кроссовки',
    countryCode: 'UA',
    currency: 'UAH',
    brandManifestId: null,
    createdAt: NOW,
    updatedAt: NOW,
    items: [],
    ...overrides,
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    projectId: 'p1',
    title: null,
    photoUrl: null,
    description: null,
    category: null,
    price: null,
    priceSource: 'MANUAL' as const,
    createdAt: NOW,
    updatedAt: NOW,
    analogs: [],
    ...overrides,
  };
}

/** Prisma Decimal stand-in — the service only ever calls toString() on it. */
const decimal = (s: string) => ({ toString: () => s });

function makePrisma() {
  return {
    project: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue(projectRow()),
      delete: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ currency: 'UAH' }),
    },
    // Этап 116: уборка мягко удалённого проекта читает черновик
    // обучалки по сайту заказчика, чтобы узнать его id ДО каскадного
    // удаления строки — иначе кадры в Blob осиротеют навсегда.
    clientSiteTutorialDraft: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    productAnalog: {
      findMany: jest.fn().mockResolvedValue([
        { price: decimal('19.00'), currency: 'USD' },
        { price: decimal('790.00'), currency: 'UAH' },
        { price: decimal('5.00'), currency: null },
      ]),
      count: jest.fn().mockResolvedValue(0),
    },
    productItem: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    // Этап 89 — «умный» алерт перед удалением проекта считает эти три
    // счётчика (только .count(), больше сервис у них ничего не читает).
    catalogBatchRun: { count: jest.fn().mockResolvedValue(0) },
    catalogBatchItem: { count: jest.fn().mockResolvedValue(0) },
    abTestRun: { count: jest.fn().mockResolvedValue(0) },
    productFeedImportRun: { count: jest.fn().mockResolvedValue(0) },
    brandManifest: { findFirst: jest.fn() },
  };
}

describe('ProjectService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let blob: { deleteMany: jest.Mock; listByPrefix: jest.Mock };
  let service: ProjectService;

  beforeEach(() => {
    delete process.env.PROJECT_LINE_ITEM_LIMIT;
    process.env.GEMINI_API_KEY = 'x';
    prisma = makePrisma();
    blob = {
      deleteMany: jest.fn().mockResolvedValue(0),
      // Уборка товара идёт по префиксу: голосовые записи описания
      // названы отметкой времени и в базе не хранятся (этап 39, А-2.14).
      listByPrefix: jest.fn().mockResolvedValue({ blobs: [], cursor: null }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new ProjectService(prisma as any, blob as any);
  });

  describe('createProject — §7.1/§7.2 currency from country', () => {
    it('derives currency from countryCode and never trusts the client', async () => {
      prisma.project.create.mockResolvedValue(projectRow());
      await service.createProject(USER, {
        type: 'LINE',
        title: '  Кроссовки ',
        countryCode: 'ua',
      });
      const call = prisma.project.create.mock.calls[0][0];
      expect(call.data).toMatchObject({
        userId: USER,
        type: 'LINE',
        title: 'Кроссовки',
        countryCode: 'UA',
        currency: 'UAH',
        brandManifestId: null,
      });
    });

    it('uses the CLDR override for Bulgaria (EUR since 2026-01-01)', async () => {
      prisma.project.create.mockResolvedValue(projectRow());
      await service.createProject(USER, {
        type: 'SINGLE',
        title: 'x',
        countryCode: 'BG',
      });
      expect(prisma.project.create.mock.calls[0][0].data.currency).toBe('EUR');
    });

    it('rejects an unknown country with 400 before touching the DB', async () => {
      await expect(
        service.createProject(USER, {
          type: 'SINGLE',
          title: 'x',
          countryCode: 'XX',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.project.create).not.toHaveBeenCalled();
    });

    it("rejects a brand manifest that isn't the caller's (§12)", async () => {
      prisma.brandManifest.findFirst.mockResolvedValue(null);
      await expect(
        service.createProject(USER, {
          type: 'SINGLE',
          title: 'x',
          countryCode: 'UA',
          brandManifestId: 'someone-elses',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.brandManifest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'someone-elses', userId: USER },
        }),
      );
      expect(prisma.project.create).not.toHaveBeenCalled();
    });

    it('links an owned brand manifest', async () => {
      prisma.brandManifest.findFirst.mockResolvedValue({ id: 'bm1' });
      prisma.project.create.mockResolvedValue(
        projectRow({ brandManifestId: 'bm1' }),
      );
      const view = await service.createProject(USER, {
        type: 'SINGLE',
        title: 'x',
        countryCode: 'UA',
        brandManifestId: 'bm1',
      });
      expect(view.brandManifestId).toBe('bm1');
    });
  });

  describe('ownership scoping — every lookup filters by userId', () => {
    it('getProject queries { id, userId, deletedAt: null } and 404s on a miss', async () => {
      prisma.project.findFirst.mockResolvedValue(null);
      await expect(service.getProject(USER, 'p-other')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // deletedAt: null (этап 89) — мягко удалённый чужой не видней, чем
      // несуществующий: тот же 404 и до, и в грейс-период.
      expect(prisma.project.findFirst.mock.calls[0][0].where).toEqual({
        id: 'p-other',
        userId: USER,
        deletedAt: null,
      });
    });

    it('item lookups go through the parent project owner, both deletedAt: null', async () => {
      prisma.productItem.findFirst.mockResolvedValue(null);
      await expect(
        service.updateItem(USER, 'p1', 'i9', { price: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.productItem.findFirst.mock.calls[0][0].where).toEqual({
        id: 'i9',
        projectId: 'p1',
        deletedAt: null,
        project: { userId: USER, deletedAt: null },
      });
      expect(prisma.productItem.update).not.toHaveBeenCalled();
    });

    it('цена «из аналога» принимается только в валюте проекта (этап 54, В-4.7)', async () => {
      prisma.productItem.findFirst.mockResolvedValue(itemRow());
      prisma.productItem.update.mockResolvedValue(itemRow());
      // $19 в проект с UAH — число без пересчёта, отказ.
      await expect(
        service.updateItem(USER, 'p1', 'i1', {
          price: 19,
          priceSource: 'ANALOG',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.productItem.update).not.toHaveBeenCalled();
      // Та же валюта — проходит; валюта неизвестна — считается валютой проекта.
      await service.updateItem(USER, 'p1', 'i1', {
        price: 790,
        priceSource: 'ANALOG',
      });
      await service.updateItem(USER, 'p1', 'i1', {
        price: 5,
        priceSource: 'ANALOG',
      });
      expect(prisma.productItem.update).toHaveBeenCalledTimes(2);
      // Ручная цена никаких аналогов не требует.
      await service.updateItem(USER, 'p1', 'i1', { price: 19 });
      expect(prisma.productAnalog.findMany).toHaveBeenCalledTimes(3);
    });

    it('listProjects is scoped to the caller, live rows only, newest-edited first', async () => {
      prisma.project.findMany.mockResolvedValue([]);
      await service.listProjects(USER);
      const arg = prisma.project.findMany.mock.calls[0][0];
      // deletedAt: null (этап 89) — мягко удалённый проект не должен
      // всплывать в списке своего же владельца в грейс-период.
      expect(arg.where).toEqual({ userId: USER, deletedAt: null });
      expect(arg.orderBy).toEqual({ updatedAt: 'desc' });
      expect(arg.include.items.where).toEqual({ deletedAt: null });
    });
  });

  describe('addItem — §7.3 line limit / SINGLE holds one', () => {
    const items = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `i${i}` }));

    it('allows the 500th item and rejects the 501st in a LINE project (default limit)', async () => {
      // Дефолт поднят с 20 до 500 продуктовым решением на этапе импорта
      // фида (doc/PRODUCT-PROJECT-SPEC.md §47.6, `PROJECT_LINE_ITEM_LIMIT=500`
      // в `backend/.env.example`) — этот тест проверял старое число 20,
      // разошедшееся с кодом ещё тогда; расхождение не ловилось до
      // первого честного прогона jest в песочнице (этап 78).
      prisma.project.findFirst.mockResolvedValue(
        projectRow({ items: items(499) }),
      );
      prisma.productItem.create.mockResolvedValue(itemRow());
      await expect(service.addItem(USER, 'p1', {})).resolves.toBeDefined();

      prisma.project.findFirst.mockResolvedValue(
        projectRow({ items: items(500) }),
      );
      await expect(service.addItem(USER, 'p1', {})).rejects.toThrow(
        /at most 500 items/,
      );
      expect(prisma.productItem.create).toHaveBeenCalledTimes(1);
    });

    it('honours PROJECT_LINE_ITEM_LIMIT from the environment', async () => {
      process.env.PROJECT_LINE_ITEM_LIMIT = '2';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const small = new ProjectService(prisma as any, blob as any);
      prisma.project.findFirst.mockResolvedValue(
        projectRow({ items: items(2) }),
      );
      await expect(small.addItem(USER, 'p1', {})).rejects.toThrow(
        /at most 2 items/,
      );
    });

    it('a SINGLE project refuses a second item', async () => {
      prisma.project.findFirst.mockResolvedValue(
        projectRow({ type: 'SINGLE', items: items(1) }),
      );
      await expect(service.addItem(USER, 'p1', {})).rejects.toThrow(
        /SINGLE project holds exactly one/,
      );
    });

    it('creates the item and bumps the parent updatedAt', async () => {
      prisma.project.findFirst.mockResolvedValue(projectRow({ items: [] }));
      prisma.productItem.create.mockResolvedValue(
        itemRow({ title: 'Размер 42' }),
      );
      const view = await service.addItem(USER, 'p1', {
        title: ' Размер 42 ',
        price: 1999.99,
        priceSource: 'ANALOG',
      });
      expect(prisma.productItem.create.mock.calls[0][0].data).toEqual({
        projectId: 'p1',
        title: 'Размер 42',
        price: 1999.99,
        priceSource: 'ANALOG',
      });
      expect(prisma.project.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'p1' } }),
      );
      expect(view.title).toBe('Размер 42');
    });
  });

  describe('updateProject — guarded transitions', () => {
    it('refuses LINE → SINGLE while more than one item exists', async () => {
      prisma.project.findFirst.mockResolvedValue(
        projectRow({ items: [itemRow(), itemRow({ id: 'i2' })] }),
      );
      await expect(
        service.updateProject(USER, 'p1', { type: 'SINGLE' }),
      ).rejects.toThrow(/Cannot change to SINGLE/);
    });

    it('refuses a country change once any item has a price (would re-denominate)', async () => {
      prisma.project.findFirst.mockResolvedValue(
        projectRow({ items: [itemRow({ price: decimal('10.00') })] }),
      );
      await expect(
        service.updateProject(USER, 'p1', { countryCode: 'PL' }),
      ).rejects.toThrow(/Cannot change country/);
    });

    it('allows a country change while no prices exist and re-derives currency', async () => {
      prisma.project.findFirst.mockResolvedValue(
        projectRow({ items: [itemRow()] }),
      );
      prisma.project.update.mockResolvedValue(
        projectRow({ countryCode: 'PL', currency: 'PLN' }),
      );
      const view = await service.updateProject(USER, 'p1', {
        countryCode: 'pl',
      });
      expect(prisma.project.update.mock.calls[0][0].data).toEqual({
        countryCode: 'PL',
        currency: 'PLN',
      });
      expect(view.currency).toBe('PLN');
    });

    it('brandManifestId: null detaches without a manifest lookup', async () => {
      prisma.project.findFirst.mockResolvedValue(
        projectRow({ brandManifestId: 'bm1' }),
      );
      prisma.project.update.mockResolvedValue(projectRow());
      await service.updateProject(USER, 'p1', { brandManifestId: null });
      expect(prisma.brandManifest.findFirst).not.toHaveBeenCalled();
      expect(prisma.project.update.mock.calls[0][0].data).toEqual({
        brandManifestId: null,
      });
    });

    it('an empty PATCH returns the current project without writing', async () => {
      prisma.project.findFirst.mockResolvedValue(projectRow());
      const view = await service.updateProject(USER, 'p1', {});
      expect(prisma.project.update).not.toHaveBeenCalled();
      expect(view.id).toBe('p1');
    });
  });

  describe('isComplete — §7.4', () => {
    it('requires price AND a non-blank description, nothing else', () => {
      expect(isItemComplete({ price: null, description: 'x' })).toBe(false);
      expect(isItemComplete({ price: decimal('1'), description: '   ' })).toBe(
        false,
      );
      expect(isItemComplete({ price: decimal('1'), description: null })).toBe(
        false,
      );
      expect(
        isItemComplete({ price: decimal('0.00'), description: 'ok' }),
      ).toBe(true); // photo/analogs/category irrelevant
    });

    it('summary counts complete items and converts Decimal prices', () => {
      const summary = toProjectSummaryView(
        projectRow({
          items: [
            itemRow({ price: decimal('5.50'), description: 'a' }),
            itemRow({ id: 'i2', price: null, description: 'b' }),
            itemRow({ id: 'i3', price: decimal('1'), description: '' }),
          ],
        }),
      );
      expect(summary.itemCount).toBe(3);
      expect(summary.completeItemCount).toBe(1);
    });
  });

  describe('itemDataFromDto — partial-update semantics', () => {
    it('only includes keys that were sent', () => {
      expect(itemDataFromDto({ price: 25 })).toEqual({ price: 25 });
      expect(itemDataFromDto({})).toEqual({});
    });

    it('explicit null clears a field; clearing price resets priceSource', () => {
      expect(itemDataFromDto({ description: null })).toEqual({
        description: null,
      });
      expect(itemDataFromDto({ price: null, priceSource: 'ANALOG' })).toEqual({
        price: null,
        priceSource: 'MANUAL',
      });
    });

    it('audience (§18): user edit is stamped source=user and cleaned; null → DbNull', () => {
      expect(
        itemDataFromDto({
          audience: {
            ageRange: ' 25-34 ',
            gender: 'women',
            interests: [' бег ', ''],
            summary: null,
          },
        }),
      ).toEqual({
        audience: {
          ageRange: '25-34',
          gender: 'women',
          interests: ['бег'],
          summary: null,
          source: 'user',
        },
      });
      expect(itemDataFromDto({ audience: null }).audience).toBe(
        Symbol.for('Prisma.DbNull'),
      );
    });

    it('trims strings', () => {
      expect(itemDataFromDto({ title: '  a  ', description: ' b ' })).toEqual({
        title: 'a',
        description: 'b',
      });
    });
  });

  describe('view mapping', () => {
    it('turns Decimal into number and dates into ISO strings', async () => {
      prisma.project.findFirst.mockResolvedValue(
        projectRow({
          items: [
            itemRow({
              price: decimal('1999.99'),
              description: 'd',
              analogs: [
                {
                  id: 'a1',
                  title: 't',
                  sourceUrl: 'https://s',
                  price: decimal('1899.00'),
                  currency: 'UAH',
                  thumbnailUrl: null,
                  relevanceRank: 1,
                },
              ],
            }),
          ],
        }),
      );
      const view = await service.getProject(USER, 'p1');
      expect(view.items[0].price).toBe(1999.99);
      expect(view.items[0].isComplete).toBe(true);
      expect(view.items[0].analogs[0].price).toBe(1899);
      expect(view.createdAt).toBe('2026-09-05T12:00:00.000Z');
    });
  });

  describe('deleteProject / deleteItem — софт-delete (этап 89)', () => {
    const PHOTO =
      'https://x.public.blob.vercel-storage.com/projects/p1/items/i1/photo.jpg';

    it('deleteProject лишь ставит deletedAt — строка и файлы остаются нетронутыми до крона', async () => {
      prisma.project.findFirst.mockResolvedValue(projectRow());
      await service.deleteProject(USER, 'p1');
      expect(prisma.project.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.project.delete).not.toHaveBeenCalled();
      expect(prisma.productItem.findMany).not.toHaveBeenCalled();
      expect(blob.listByPrefix).not.toHaveBeenCalled();
    });

    it('deleteProject 404s на чужой/уже мягко удалённый проект и ничего не пишет', async () => {
      prisma.project.findFirst.mockResolvedValue(null);
      await expect(service.deleteProject(USER, 'p1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.project.update).not.toHaveBeenCalled();
    });

    it('deleteItem лишь ставит deletedAt и трогает updatedAt проекта — файлы уносит крон, не этот запрос', async () => {
      prisma.productItem.findFirst.mockResolvedValue({
        id: 'i1',
        projectId: 'p1',
        photoUrl: PHOTO,
        deletedAt: null,
        project: { userId: USER, deletedAt: null },
      });
      await service.deleteItem(USER, 'p1', 'i1');
      expect(prisma.productItem.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.productItem.delete).not.toHaveBeenCalled();
      expect(blob.listByPrefix).not.toHaveBeenCalled();
      expect(blob.deleteMany).not.toHaveBeenCalled();
      expect(prisma.project.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'p1' } }),
      );
    });
  });

  describe('getProjectDeletePreview / getItemDeletePreview — «умный» алерт (этап 89)', () => {
    it('getProjectDeletePreview считает ровно то, что унесёт DB-каскад проекта (без sessions — SetNull)', async () => {
      prisma.project.findFirst.mockResolvedValue(projectRow());
      prisma.productItem.count.mockResolvedValue(3);
      prisma.catalogBatchRun.count.mockResolvedValue(2);
      prisma.abTestRun.count.mockResolvedValue(1);
      prisma.productFeedImportRun.count.mockResolvedValue(0);

      const preview = await service.getProjectDeletePreview(USER, 'p1');

      expect(preview).toEqual({
        items: 3,
        catalogBatchRuns: 2,
        abTestRuns: 1,
        feedImportRuns: 0,
      });
      expect(prisma.productItem.count).toHaveBeenCalledWith({
        where: { projectId: 'p1', deletedAt: null },
      });
      expect(prisma.catalogBatchRun.count).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
      });
    });

    it('getProjectDeletePreview 404s на чужой проект', async () => {
      prisma.project.findFirst.mockResolvedValue(null);
      await expect(
        service.getProjectDeletePreview(USER, 'p-other'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getItemDeletePreview считает аналоги и позиции пакетной генерации товара', async () => {
      prisma.productItem.findFirst.mockResolvedValue(itemRow());
      prisma.productAnalog.count.mockResolvedValue(4);
      prisma.catalogBatchItem.count.mockResolvedValue(1);

      const preview = await service.getItemDeletePreview(USER, 'p1', 'i1');

      expect(preview).toEqual({ analogs: 4, catalogBatchItems: 1 });
      expect(prisma.catalogBatchItem.count).toHaveBeenCalledWith({
        where: { productItemId: 'i1' },
      });
    });
  });

  describe('purgeSoftDeletedProjects / purgeSoftDeletedItems — крон спустя грейс-период (этап 89, doc/STORAGE-AUDIT.md)', () => {
    const PHOTO =
      'https://x.public.blob.vercel-storage.com/projects/p1/items/i1/photo.jpg';

    it('пустая партия — ничего не трогает', async () => {
      prisma.project.findMany.mockResolvedValue([]);
      await expect(service.purgeSoftDeletedProjects()).resolves.toEqual({
        count: 0,
        hasMore: false,
      });
      expect(prisma.project.delete).not.toHaveBeenCalled();
    });

    it('purgeSoftDeletedProjects собирает фото товаров ДО каскадного удаления строки проекта', async () => {
      prisma.project.findMany.mockResolvedValue([{ id: 'p1' }]);
      const order: string[] = [];
      prisma.productItem.findMany.mockImplementation(async () => {
        order.push('read');
        return [{ id: 'i1', photoUrl: PHOTO }];
      });
      prisma.project.delete.mockImplementation(async () => {
        order.push('delete');
        return {};
      });

      const result = await service.purgeSoftDeletedProjects();

      expect(order).toEqual(['read', 'delete']);
      expect(prisma.project.delete).toHaveBeenCalledWith({
        where: { id: 'p1' },
      });
      expect(blob.deleteMany).toHaveBeenCalledWith([
        'projects/p1/items/i1/photo.jpg',
      ]);
      expect(result).toEqual({ count: 1, hasMore: false });
    });

    it('кадры обучалки по сайту заказчика уносятся вместе с проектом', async () => {
      // Черновик уходит каскадом FK, а файлы в Blob — нет: после
      // удаления строки `draftId` взять больше неоткуда, и префикс
      // осиротел бы навсегда (аудит этапа 116).
      prisma.project.findMany.mockResolvedValue([{ id: 'p1' }]);
      prisma.productItem.findMany.mockResolvedValue([]);
      prisma.project.delete.mockResolvedValue({});
      prisma.clientSiteTutorialDraft.findUnique.mockResolvedValue({
        id: 'draft1',
      });
      blob.listByPrefix.mockResolvedValue({
        blobs: [{ pathname: 'tutorial-video-frames/draft1/0.jpg' }],
        cursor: null,
      });

      await service.purgeSoftDeletedProjects();

      expect(blob.listByPrefix).toHaveBeenCalledWith(
        'tutorial-video-frames/draft1/',
        expect.anything(),
      );
      expect(blob.deleteMany).toHaveBeenCalledWith([
        'tutorial-video-frames/draft1/0.jpg',
      ]);
    });

    it('идентификатор черновика читается ДО удаления строки проекта', async () => {
      prisma.project.findMany.mockResolvedValue([{ id: 'p1' }]);
      prisma.productItem.findMany.mockResolvedValue([]);
      const order: string[] = [];
      prisma.clientSiteTutorialDraft.findUnique.mockImplementation(async () => {
        order.push('read-draft');
        return { id: 'draft1' };
      });
      prisma.project.delete.mockImplementation(async () => {
        order.push('delete');
        return {};
      });

      await service.purgeSoftDeletedProjects();

      expect(order).toEqual(['read-draft', 'delete']);
    });

    it('purgeSoftDeletedItems уносит и фото, и голосовые записи товара, удалённого поодиночке', async () => {
      // Голосовые записи (§6.2) лежат под тем же префиксом с именем из
      // отметки времени — перечислить их по базе нельзя.
      prisma.productItem.findMany.mockResolvedValue([
        { id: 'i1', projectId: 'p1', photoUrl: PHOTO },
      ]);
      blob.listByPrefix.mockResolvedValue({
        blobs: [
          { pathname: 'projects/p1/items/i1/photo.jpg' },
          { pathname: 'projects/p1/items/i1/voice-1757000000000.webm' },
        ],
        cursor: null,
      });

      const result = await service.purgeSoftDeletedItems();

      expect(prisma.productItem.delete).toHaveBeenCalledWith({
        where: { id: 'i1' },
      });
      const deleted = blob.deleteMany.mock.calls[0][0] as string[];
      expect(deleted).toContain('projects/p1/items/i1/photo.jpg');
      expect(deleted).toContain(
        'projects/p1/items/i1/voice-1757000000000.webm',
      );
      expect(result).toEqual({ count: 1, hasMore: false });
    });

    it('P2025 (родителя уже унёс purgeSoftDeletedProjects этим же прогоном) — тихий пропуск, не сбой', async () => {
      prisma.productItem.findMany.mockResolvedValue([
        { id: 'i1', projectId: 'p1', photoUrl: null },
      ]);
      prisma.productItem.delete.mockRejectedValue({ code: 'P2025' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const warnSpy = jest.spyOn((service as any).logger, 'warn');

      const result = await service.purgeSoftDeletedItems();

      expect(result).toEqual({ count: 0, hasMore: false });
      expect(blob.listByPrefix).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('сбой хранилища не роняет крон-уборку — строка товара уже удалена, это best-effort', async () => {
      prisma.productItem.findMany.mockResolvedValue([
        { id: 'i1', projectId: 'p1', photoUrl: PHOTO },
      ]);
      blob.listByPrefix.mockRejectedValue(new Error('blob недоступен'));

      await expect(service.purgeSoftDeletedItems()).resolves.toEqual({
        count: 1,
        hasMore: false,
      });
      expect(prisma.productItem.delete).toHaveBeenCalled();
    });
  });
});
