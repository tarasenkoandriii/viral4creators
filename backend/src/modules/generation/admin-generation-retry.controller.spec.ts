/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники: подставляем заглушки на месте зависимостей, форму которых тест не проверяет */
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
    generateVideo: jest
      .fn()
      .mockResolvedValue({ status: GenerationStatus.PROCESSING }),
    getVideoStatus: jest
      .fn()
      .mockResolvedValue({ status: GenerationStatus.PROCESSING }),
  };
  const videoAudit = {
    run: jest.fn().mockResolvedValue({
      history: [{ verdict: 'clean', summary: 'ок' }],
      appliedFixes: 0,
      limit: 5,
      overLimit: false,
    }),
    applyFix: jest.fn().mockResolvedValue({
      prompt: { finalText: 'исправленный текст' },
      state: { history: [], appliedFixes: 1, limit: 5, overLimit: false },
    }),
  };
  const prompt = {
    approvePrompt: jest.fn().mockResolvedValue({ approvedAt: new Date() }),
  };
  // findFirst, не findUnique (этап 89, доп. аудит) — контроллер теперь
  // фильтрует `deletedAt: null` тем же приёмом, что и AdminPanelService.
  const prisma = {
    session: { findFirst: jest.fn().mockResolvedValue(sessionRow) },
  };
  const controller = new AdminGenerationRetryController(
    adminPanel as any,
    generation as any,
    videoAudit as any,
    prompt as any,
    prisma as any,
  );
  const req = { userId: 'op-1' } as AdminAuthenticatedRequest;
  return {
    controller,
    adminPanel,
    generation,
    videoAudit,
    prompt,
    prisma,
    req,
  };
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
      undefined,
      undefined,
      undefined,
    );
  });

  // Доп. запрос владельца продукта (ТЗ §10–11, найдено при аудите):
  // повтор проваленного Grok-рендера не должен тихо уезжать на Veo —
  // тот же принцип, что уже применён к quality/aspectRatio выше.
  it('проваленный Grok-рендер — повтор с тем же provider/resolution, не тихий переход на Veo', async () => {
    const { controller, generation, req } = build({
      data: {
        generatedVideo: {
          status: GenerationStatus.FAILED,
          provider: 'grok',
          resolution: '480p',
        },
      },
    });
    await controller.retry(req, 's1');
    expect(generation.generateVideo).toHaveBeenCalledWith(
      's1',
      undefined,
      undefined,
      'grok',
      '480p',
      undefined,
    );
  });

  // Доп. запрос владельца продукта (ТЗ §9, этап 4 плана §14) — найдено
  // при ПОВТОРНОМ аудите: та же находка, что уже была для
  // provider/resolution, но для поля, добавленного в другом заходе —
  // без него повтор упавшего НА СЕРЕДИНЕ цепочки сегмента тихо
  // откатывался бы на обычную однократную 8-секундную генерацию.
  it('проваленный сегмент цепочки — повтор с тем же chainTargetDurationSeconds, не откат на обычную генерацию', async () => {
    const { controller, generation, req } = build({
      data: {
        generatedVideo: {
          status: GenerationStatus.FAILED,
          provider: 'veo',
          chainSegmentsDone: 3,
          chainSegmentsTotal: 7,
          chainTargetDurationSeconds: 56,
        },
      },
    });
    await controller.retry(req, 's1');
    expect(generation.generateVideo).toHaveBeenCalledWith(
      's1',
      undefined,
      undefined,
      'veo',
      undefined,
      56,
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

describe('AdminGenerationRetryController.pollStatus (без него запущенный из админки рендер не продвинется)', () => {
  it('требует assertOperator до опроса', async () => {
    const { controller, adminPanel, req } = build({ data: {} });
    const order: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      order.push('assertOperator');
    });
    await controller.pollStatus(req, 's1');
    order.push('after');
    expect(order[0]).toBe('assertOperator');
  });

  it('зовёт getVideoStatus (не просто читает строку) и возвращает свежую сводку', async () => {
    const { controller, adminPanel, generation, req } = build({ data: {} });
    const result = await controller.pollStatus(req, 's1');
    expect(generation.getVideoStatus).toHaveBeenCalledWith('s1');
    expect(adminPanel.getSession).toHaveBeenCalledWith('s1');
    expect(result).toEqual({ sessionId: 's1' });
  });
});

describe('AdminGenerationRetryController.audit (доп. запрос владельца продукта: аудит виден и клиенту)', () => {
  it('требует assertOperator до запуска проверки', async () => {
    const { controller, adminPanel, videoAudit, req } = build({ data: {} });
    const order: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      order.push('assertOperator');
    });
    videoAudit.run.mockImplementation(async () => {
      order.push('run');
      return { history: [], appliedFixes: 0, limit: 5, overLimit: false };
    });
    await controller.audit(req, 's1');
    expect(order).toEqual(['assertOperator', 'run']);
  });

  it('зовёт VideoAuditService.run напрямую — не публичный /sessions/:id/audit — с пустым DTO', async () => {
    const { controller, videoAudit, req } = build({ data: {} });
    await controller.audit(req, 's1');
    expect(videoAudit.run).toHaveBeenCalledWith('s1', {});
  });

  it('возвращает состояние аудита как есть — та же запись, что читает визард пользователя', async () => {
    const { controller, req } = build({ data: {} });
    const result = await controller.audit(req, 's1');
    expect(result).toEqual({
      history: [{ verdict: 'clean', summary: 'ок' }],
      appliedFixes: 0,
      limit: 5,
      overLimit: false,
    });
  });
});

describe('AdminGenerationRetryController.applyFixAndRetry (реальный случай: аудит нашёл артефакты, тупое «Повторить» воспроизвело бы их снова)', () => {
  const withAudit = (over: Record<string, unknown> = {}) => ({
    data: {
      videoAudit: {
        history: [
          {
            auditId: 'audit-1',
            promptFix: { suggestedText: 'исправленный текст' },
          },
        ],
      },
      generatedVideo: { quality: 'standard', aspectRatio: '9:16' },
      ...over,
    },
  });

  it('нет аудита с promptFix вовсе — 403, ничего не запускается', async () => {
    const { controller, videoAudit, prompt, generation, req } = build({
      data: {},
    });
    await expect(controller.applyFixAndRetry(req, 's1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(videoAudit.applyFix).not.toHaveBeenCalled();
    expect(prompt.approvePrompt).not.toHaveBeenCalled();
    expect(generation.generateVideo).not.toHaveBeenCalled();
  });

  it('аудит есть, но без promptFix (чистый вердикт) — тоже 403', async () => {
    const { controller, req } = build({
      data: { videoAudit: { history: [{ auditId: 'a1' }] } },
    });
    await expect(controller.applyFixAndRetry(req, 's1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('три шага по порядку: применить фикс → одобрить → перегенерировать', async () => {
    const { controller, videoAudit, prompt, generation, req } =
      build(withAudit());
    const order: string[] = [];
    videoAudit.applyFix.mockImplementation(async () => {
      order.push('applyFix');
      return { prompt: {}, state: {} };
    });
    prompt.approvePrompt.mockImplementation(async () => {
      order.push('approvePrompt');
      return {};
    });
    generation.generateVideo.mockImplementation(async () => {
      order.push('generateVideo');
      return {};
    });

    await controller.applyFixAndRetry(req, 's1');

    expect(order).toEqual(['applyFix', 'approvePrompt', 'generateVideo']);
  });

  it('берёт auditId САМОГО СВЕЖЕГО аудита (первый в history), не первый по времени', async () => {
    const { controller, videoAudit, req } = build({
      data: {
        videoAudit: {
          history: [
            { auditId: 'newest', promptFix: { suggestedText: 'x' } },
            { auditId: 'older', promptFix: { suggestedText: 'y' } },
          ],
        },
        generatedVideo: {},
      },
    });
    await controller.applyFixAndRetry(req, 's1');
    expect(videoAudit.applyFix).toHaveBeenCalledWith('s1', {
      auditId: 'newest',
    });
  });

  it('перегенерация — с тем же качеством/форматом, что были у проваленной/исходной записи', async () => {
    const { controller, generation, req } = build(withAudit());
    await controller.applyFixAndRetry(req, 's1');
    expect(generation.generateVideo).toHaveBeenCalledWith(
      's1',
      'standard',
      '9:16',
      undefined,
      undefined,
      undefined,
    );
  });

  it('успешный прогон возвращает свежую сводку сессии', async () => {
    const { controller, adminPanel, req } = build(withAudit());
    const result = await controller.applyFixAndRetry(req, 's1');
    expect(adminPanel.getSession).toHaveBeenCalledWith('s1');
    expect(result).toEqual({ sessionId: 's1' });
  });
});

describe('AdminGenerationRetryController.versions (доп. запрос владельца продукта: кнопка на каждую версию)', () => {
  it('требует assertOperator до чтения данных', async () => {
    const { controller, adminPanel, req } = build({ data: {} });
    const order: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      order.push('assertOperator');
    });
    await controller.versions(req, 's1');
    order.push('after');
    expect(order[0]).toBe('assertOperator');
  });

  it('сессия не найдена — 404', async () => {
    const { controller, req } = build(null);
    await expect(controller.versions(req, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('текущая попытка первая и помечена isCurrent, история — за ней в её собственном порядке', async () => {
    const { controller, req } = build({
      data: {
        generatedVideo: { generatedVideoId: 'v3', status: 'complete' },
        videoHistory: [
          { generatedVideoId: 'v2', status: 'failed' },
          { generatedVideoId: 'v1', status: 'complete' },
        ],
      },
    });
    const result = await controller.versions(req, 's1');
    expect(result.map((v) => [v.generatedVideoId, v.isCurrent])).toEqual([
      ['v3', true],
      ['v2', false],
      ['v1', false],
    ]);
  });

  it('нет generatedVideo и нет истории — пустой список, не падение', async () => {
    const { controller, req } = build({ data: {} });
    await expect(controller.versions(req, 's1')).resolves.toEqual([]);
  });

  it('аудиты подставляются к своей версии по generatedVideoId, не все подряд', async () => {
    const { controller, req } = build({
      data: {
        generatedVideo: { generatedVideoId: 'v2', status: 'complete' },
        videoHistory: [{ generatedVideoId: 'v1', status: 'failed' }],
        videoAudit: {
          history: [
            {
              auditId: 'a2',
              generatedVideoId: 'v2',
              verdict: 'clean',
              summary: 'ок',
              promptFix: null,
            },
            {
              auditId: 'a1',
              generatedVideoId: 'v1',
              verdict: 'issues',
              summary: 'артефакты',
              promptFix: { suggestedText: 'x' },
            },
          ],
        },
      },
    });
    const result = await controller.versions(req, 's1');
    const v2 = result.find((v) => v.generatedVideoId === 'v2')!;
    const v1 = result.find((v) => v.generatedVideoId === 'v1')!;
    expect(v2.audits).toEqual([
      { auditId: 'a2', verdict: 'clean', summary: 'ок', hasPromptFix: false },
    ]);
    expect(v1.audits).toEqual([
      {
        auditId: 'a1',
        verdict: 'issues',
        summary: 'артефакты',
        hasPromptFix: true,
      },
    ]);
  });
});
