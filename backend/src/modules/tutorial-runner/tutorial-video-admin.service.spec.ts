/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { NotFoundException } from '@nestjs/common';
import { TutorialVideoAdminService } from './tutorial-video-admin.service';

function build() {
  const prisma = {
    tutorialVideoAsset: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn(),
      update: jest.fn(),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    cronRunLog: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const service = new TutorialVideoAdminService(prisma as any);
  return { service, prisma };
}

describe('TutorialVideoAdminService.list (§4.9, этап 99)', () => {
  it('передаёт фильтры в findMany/count как есть и считает пагинацию', async () => {
    const { service, prisma } = build();
    await service.list({
      subjectKey: 'plan-upgrade',
      locale: 'ru',
      reviewed: true,
      page: 2,
      pageSize: 20,
    });
    const expectedWhere = {
      subjectKey: 'plan-upgrade',
      locale: 'ru',
      reviewed: true,
      // Ролики обучалки по сайту заказчика в эту таблицу не попадают
      // (сквозной аудит 29.09.2026) — у них своя витрина и своё
      // одобрение, а одна кнопка отсюда отдавала бы их посетителям
      // лендинга.
      clientSiteDraftId: null,
    };
    expect(prisma.tutorialVideoAsset.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      orderBy: { createdAt: 'desc' },
      skip: 20,
      take: 20,
    });
    expect(prisma.tutorialVideoAsset.count).toHaveBeenCalledWith({
      where: expectedWhere,
    });
  });

  it('без фильтров — subjectKey/locale/reviewed уходят undefined', async () => {
    const { service, prisma } = build();
    await service.list({ page: 1, pageSize: 10 });
    expect(prisma.tutorialVideoAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clientSiteDraftId: null,
          subjectKey: undefined,
          locale: undefined,
          reviewed: undefined,
        },
      }),
    );
  });

  it('возвращает total/page/pageSize вместе со строками', async () => {
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findMany.mockResolvedValue([{ id: 'tva-1' }]);
    prisma.tutorialVideoAsset.count.mockResolvedValue(3);
    const result = await service.list({ page: 1, pageSize: 10 });
    expect(result).toEqual({
      rows: [{ id: 'tva-1' }],
      total: 3,
      page: 1,
      pageSize: 10,
    });
  });
});

describe('TutorialVideoAdminService.setReviewed', () => {
  it('несуществующий id — NotFoundException', async () => {
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue(null);
    await expect(service.setReviewed('missing', true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.tutorialVideoAsset.update).not.toHaveBeenCalled();
  });

  it('ставит reviewed:true', async () => {
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({ id: 'tva-1' });
    prisma.tutorialVideoAsset.update.mockResolvedValue({
      id: 'tva-1',
      reviewed: true,
    });
    const result = await service.setReviewed('tva-1', true);
    expect(prisma.tutorialVideoAsset.update).toHaveBeenCalledWith({
      where: { id: 'tva-1' },
      data: { reviewed: true },
    });
    expect(result).toEqual({ id: 'tva-1', reviewed: true });
  });

  it('позволяет снять reviewed обратно в false (не идемпотентно-необратимо, в отличие от approve сценариев)', async () => {
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({
      id: 'tva-1',
      reviewed: true,
    });
    prisma.tutorialVideoAsset.update.mockResolvedValue({
      id: 'tva-1',
      reviewed: false,
    });
    const result = await service.setReviewed('tva-1', false);
    expect(prisma.tutorialVideoAsset.update).toHaveBeenCalledWith({
      where: { id: 'tva-1' },
      data: { reviewed: false },
    });
    expect(result.reviewed).toBe(false);
  });
});

describe('TutorialVideoAdminService.dataStatus', () => {
  it('собирает знания/шаги/покрытие видео/последние прогоны в одну сводку', async () => {
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.groupBy.mockResolvedValue([
      { subjectKey: 'plan-upgrade', locale: 'ru', _count: { _all: 2 } },
    ]);
    prisma.cronRunLog.findFirst.mockResolvedValue({
      jobKey: 'tutorial-scenario-run',
      status: 'SUCCESS',
      startedAt: new Date('2026-09-01'),
      finishedAt: new Date('2026-09-01'),
      summary: 'ok',
      errorMessage: null,
    });

    const result = await service.dataStatus();

    expect(result.knowledge).toEqual(
      expect.objectContaining({
        builtAt: expect.any(String),
        commit: expect.any(String),
      }),
    );
    expect(result.stepCounts.ru).toBeGreaterThan(0);
    expect(result.videoCoverage).toEqual([
      { subjectKey: 'plan-upgrade', locale: 'ru', reviewedCount: 2 },
    ]);
    // Четыре, а не три: с 27.09.2026 в сводке есть и
    // `tutorial-assembly-poll` — именно он теперь решает судьбу
    // сборок, и молчать о нём значило бы прятать тот крон, от которого
    // зависит, появится ли у человека ссылка на ролик.
    expect(result.lastRuns).toHaveLength(4);
    expect(result.lastRuns.map((r) => r.jobKey)).toContain(
      'tutorial-assembly-poll',
    );
    expect(prisma.tutorialVideoAsset.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['subjectKey', 'locale'],
        where: { reviewed: true },
      }),
    );
  });

  it('без прогонов в истории — lastRuns со статусом null, не падает', async () => {
    const { service } = build();
    const result = await service.dataStatus();
    expect(result.lastRuns.every((r) => r.status === null)).toBe(true);
  });
});

describe('ролики обучалки по сайту заказчика (сквозной аудит 29.09.2026)', () => {
  it('одобрить через API нельзя — барьер не только в витрине', async () => {
    // Прямой вызов мимо экрана отдал бы посетителям ролик по чужому
    // сайту так же, как ошибочное нажатие.
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({
      id: 'tva-1',
      clientSiteDraftId: 'draft-7',
    });

    await expect(service.setReviewed('tva-1', true)).rejects.toThrow(
      /сайту заказчика/,
    );
    expect(prisma.tutorialVideoAsset.update).not.toHaveBeenCalled();
  });

  it('штатный ролик одобряется по-прежнему', async () => {
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({
      id: 'tva-2',
      clientSiteDraftId: null,
    });

    await service.setReviewed('tva-2', true);
    expect(prisma.tutorialVideoAsset.update).toHaveBeenCalled();
  });
});
