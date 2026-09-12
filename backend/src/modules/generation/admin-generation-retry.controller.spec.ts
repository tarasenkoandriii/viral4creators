jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminGenerationRetryController } from './admin-generation-retry.controller';
import type { AdminAuthenticatedRequest } from '../admin-auth/admin-session.guard';
import { GenerationStatus } from '../../common/types/generation.types';

function build(sessionRow: { data: unknown } | null) {
  const adminPanel = {
    assertOperator: jest.fn().mockResolvedValue(undefined),
    getSession: jest.fn().mockResolvedValue({ sessionId: 's1' }),
  };
  const generation = {
    generateVideo: jest.fn().mockResolvedValue({ status: GenerationStatus.PROCESSING }),
  };
  const prisma = {
    session: { findUnique: jest.fn().mockResolvedValue(sessionRow) },
  };
  const controller = new AdminGenerationRetryController(
    adminPanel as any,
    generation as any,
    prisma as any,
  );
  const req = { userId: 'op-1' } as AdminAuthenticatedRequest;
  return { controller, adminPanel, generation, prisma, req };
}

describe('AdminGenerationRetryController', () => {
  it('требует assertOperator до обращения к данным', async () => {
    const { controller, adminPanel, req } = build({
      data: { generatedVideo: { status: GenerationStatus.FAILED } },
    });
    const order: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      order.push('assertOperator');
    });
    await controller.retry(req, 's1');
    order.push('after');
    expect(order[0]).toBe('assertOperator');
  });

  it('сессия не найдена — 404, generateVideo не зовётся', async () => {
    const { controller, generation, req } = build(null);
    await expect(controller.retry(req, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(generation.generateVideo).not.toHaveBeenCalled();
  });

  it('рендер не проваленный (processing/complete) — 403, повтор не запускается', async () => {
    const { controller, generation, req } = build({
      data: { generatedVideo: { status: GenerationStatus.PROCESSING } },
    });
    await expect(controller.retry(req, 's1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(generation.generateVideo).not.toHaveBeenCalled();
  });

  it('нет рендера вовсе — тоже 403, а не попытка повторить несуществующее', async () => {
    const { controller, generation, req } = build({ data: {} });
    await expect(controller.retry(req, 's1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(generation.generateVideo).not.toHaveBeenCalled();
  });

  it('проваленный рендер — повтор с теми же качеством/форматом, что были', async () => {
    const { controller, generation, req } = build({
      data: {
        generatedVideo: {
          status: GenerationStatus.FAILED,
          quality: 'standard',
          aspectRatio: '9:16',
        },
      },
    });
    await controller.retry(req, 's1');
    expect(generation.generateVideo).toHaveBeenCalledWith(
      's1',
      'standard',
      '9:16',
    );
  });

  it('успешный повтор возвращает свежую сводку сессии', async () => {
    const { controller, adminPanel, req } = build({
      data: { generatedVideo: { status: GenerationStatus.FAILED } },
    });
    const result = await controller.retry(req, 's1');
    expect(adminPanel.getSession).toHaveBeenCalledWith('s1');
    expect(result).toEqual({ sessionId: 's1' });
  });
});
