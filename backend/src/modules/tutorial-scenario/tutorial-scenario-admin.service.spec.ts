/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TutorialScenarioAdminService } from './tutorial-scenario-admin.service';

function build() {
  const rows: Record<string, unknown>[] = [];
  const prisma = {
    tutorialScenario: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const service = new TutorialScenarioAdminService(prisma as any);
  return { service, prisma, rows };
}

describe('TutorialScenarioAdminService.list', () => {
  it('передаёт фильтры в findMany/count как есть и считает пагинацию', async () => {
    const { service, prisma } = build();
    await service.list({
      subjectKey: '3',
      locale: 'ru',
      costly: true,
      approved: false,
      page: 2,
      pageSize: 20,
    });
    const expectedWhere = {
      subjectKey: '3',
      locale: 'ru',
      costly: true,
      approved: false,
    };
    expect(prisma.tutorialScenario.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      orderBy: { createdAt: 'desc' },
      skip: 20,
      take: 20,
    });
    expect(prisma.tutorialScenario.count).toHaveBeenCalledWith({
      where: expectedWhere,
    });
  });

  it('без фильтров — subjectKey/locale/costly/approved уходят undefined, а не пустой строкой', async () => {
    const { service, prisma } = build();
    await service.list({ page: 1, pageSize: 10 });
    expect(prisma.tutorialScenario.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          subjectKey: undefined,
          locale: undefined,
          costly: undefined,
          approved: undefined,
        },
      }),
    );
  });

  it('возвращает total/page/pageSize вместе со строками', async () => {
    const { service, prisma } = build();
    prisma.tutorialScenario.findMany.mockResolvedValue([{ id: 'ts-1' }]);
    prisma.tutorialScenario.count.mockResolvedValue(7);
    const result = await service.list({ page: 1, pageSize: 10 });
    expect(result).toEqual({
      rows: [{ id: 'ts-1' }],
      total: 7,
      page: 1,
      pageSize: 10,
    });
  });
});

describe('TutorialScenarioAdminService.approve', () => {
  it('несуществующий id — NotFoundException', async () => {
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue(null);
    await expect(service.approve('missing', 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.tutorialScenario.update).not.toHaveBeenCalled();
  });

  it('бесплатный сценарий (costly=false) — BadRequestException, одобрение не требуется', async () => {
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      id: 'ts-1',
      costly: false,
      approved: false,
    });
    await expect(service.approve('ts-1', 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.tutorialScenario.update).not.toHaveBeenCalled();
  });

  it('costly и не одобрен — ставит approved/approvedBy/approvedAt', async () => {
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      id: 'ts-1',
      costly: true,
      approved: false,
    });
    prisma.tutorialScenario.update.mockResolvedValue({
      id: 'ts-1',
      approved: true,
    });
    const result = await service.approve('ts-1', 'admin-1');
    expect(prisma.tutorialScenario.update).toHaveBeenCalledWith({
      where: { id: 'ts-1' },
      data: {
        approved: true,
        approvedBy: 'admin-1',
        approvedAt: expect.any(Date),
      },
    });
    expect(result).toEqual({ id: 'ts-1', approved: true });
  });

  it('уже одобрен — идемпотентно возвращает текущую строку, update не зовётся повторно', async () => {
    const { service, prisma } = build();
    const existing = {
      id: 'ts-1',
      costly: true,
      approved: true,
      approvedBy: 'first-admin',
      approvedAt: new Date('2026-01-01'),
    };
    prisma.tutorialScenario.findUnique.mockResolvedValue(existing);
    const result = await service.approve('ts-1', 'second-admin');
    expect(prisma.tutorialScenario.update).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });
});
