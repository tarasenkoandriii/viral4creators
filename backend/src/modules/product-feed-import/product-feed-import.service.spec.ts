import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProductFeedImportService } from './product-feed-import.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

jest.mock('../../common/external-url-guard', () => {
  const actual = jest.requireActual('../../common/external-url-guard');
  return {
    ...actual,
    assertPubliclyRoutableUrl: jest.fn().mockResolvedValue(undefined),
  };
});

import { assertPubliclyRoutableUrl } from '../../common/external-url-guard';

const guardMock = assertPubliclyRoutableUrl as jest.Mock;

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run1',
    projectId: 'proj1',
    userId: 'user1',
    sourceUrl: 'https://seller.test/feed.yml',
    status: 'PENDING',
    error: null,
    totalRows: 0,
    importedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function setup(
  opts: {
    project?: unknown;
    run?: unknown;
    runs?: unknown[];
  } = {},
) {
  const prisma = {
    project: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.project === undefined
            ? { id: 'proj1', type: 'LINE' }
            : opts.project,
        ),
    },
    productFeedImportRun: {
      create: jest.fn().mockResolvedValue({ id: 'run1' }),
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.run === undefined ? runRow() : opts.run),
      findMany: jest.fn().mockResolvedValue(opts.runs ?? [runRow()]),
    },
  };
  const plans = { assertUser: jest.fn().mockResolvedValue(undefined) };
  const service = new ProductFeedImportService(prisma as never, plans as never);
  return { service, prisma, plans };
}

beforeEach(() => {
  guardMock.mockReset().mockResolvedValue(undefined);
});

describe('ProductFeedImportService.create', () => {
  it('гейт плана проверяется первым — тот же признак, что у пакетной генерации', async () => {
    const { service, plans } = setup();
    await service.create('user1', 'proj1', {
      sourceUrl: 'https://seller.test/feed.yml',
    });
    expect(plans.assertUser).toHaveBeenCalledWith('user1', 'library');
  });

  it('проект не найден/не свой — 404', async () => {
    const { service } = setup({ project: null });
    await expect(
      service.create('user1', 'proj1', {
        sourceUrl: 'https://seller.test/feed.yml',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('проект не LINE — 400, импорт только для линейки товаров', async () => {
    const { service } = setup({ project: { id: 'proj1', type: 'SINGLE' } });
    await expect(
      service.create('user1', 'proj1', {
        sourceUrl: 'https://seller.test/feed.yml',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('небезопасная/недоступная ссылка (SSRF-отказ) — 400 с понятным текстом, запуск не создаётся', async () => {
    const { service, prisma } = setup();
    const { UnsafeExternalUrlError } = jest.requireActual(
      '../../common/external-url-guard',
    );
    guardMock.mockRejectedValue(new UnsafeExternalUrlError('nope'));
    await expect(
      service.create('user1', 'proj1', {
        sourceUrl: 'https://internal.test/feed.yml',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.productFeedImportRun.create).not.toHaveBeenCalled();
  });

  it('успешное создание — запуск с projectId/userId/sourceUrl, возвращает runId', async () => {
    const { service, prisma } = setup();
    const result = await service.create('user1', 'proj1', {
      sourceUrl: 'https://seller.test/feed.yml',
    });
    expect(result).toEqual({ runId: 'run1' });
    expect(prisma.productFeedImportRun.create).toHaveBeenCalledWith({
      data: {
        projectId: 'proj1',
        userId: 'user1',
        sourceUrl: 'https://seller.test/feed.yml',
      },
    });
  });
});

describe('ProductFeedImportService.getStatus', () => {
  it('запуск не найден — 404', async () => {
    const { service } = setup({ run: null });
    await expect(
      service.getStatus('user1', 'proj1', 'run1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('запуск принадлежит другому пользователю — 404, а не 403', async () => {
    const { service } = setup({ run: runRow({ userId: 'someone-else' }) });
    await expect(
      service.getStatus('user1', 'proj1', 'run1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('запуск из другого проекта — 404', async () => {
    const { service } = setup({ run: runRow({ projectId: 'other-proj' }) });
    await expect(
      service.getStatus('user1', 'proj1', 'run1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('успех — сводка и строки в ответе, счётчики берутся как есть из строки запуска', async () => {
    const { service } = setup({
      run: runRow({
        totalRows: 3,
        importedCount: 2,
        skippedCount: 1,
        items: [
          {
            rowIndex: 0,
            title: 'Товар 1',
            status: 'IMPORTED',
            reason: null,
            productItemId: 'pi1',
          },
        ],
      }),
    });
    const result = await service.getStatus('user1', 'proj1', 'run1');
    expect(result.totalRows).toBe(3);
    expect(result.importedCount).toBe(2);
    expect(result.items).toEqual([
      {
        rowIndex: 0,
        title: 'Товар 1',
        status: 'IMPORTED',
        reason: null,
        productItemId: 'pi1',
      },
    ]);
  });
});

describe('ProductFeedImportService.list', () => {
  it('проект не найден/не свой — 404', async () => {
    const { service } = setup({ project: null });
    await expect(service.list('user1', 'proj1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('возвращает сводки запусков проекта, отсортированные сервером (createdAt desc в запросе)', async () => {
    const { service, prisma } = setup({
      runs: [runRow({ id: 'run2' }), runRow({ id: 'run1' })],
    });
    const result = await service.list('user1', 'proj1');
    expect(result.map((r) => r.runId)).toEqual(['run2', 'run1']);
    expect(prisma.productFeedImportRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'proj1', userId: 'user1' },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });
});
