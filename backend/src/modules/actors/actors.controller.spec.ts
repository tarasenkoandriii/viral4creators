/**
 * ActorsController — тонкий слой поверх ActorsService, тот же контракт,
 * что AdminCronController: валидная admin-сессия (AdminSessionGuard,
 * проверяется декоратором на уровне маршрута, не здесь) сама по себе не
 * значит «оператор» — assertOperator обязан быть вызван ДО делегирования
 * в сервис на каждом маршруте.
 */

// Тот же приём, что в actors.service.spec.ts — см. комментарий там.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ForbiddenException } from '@nestjs/common';
import { ActorsController } from './actors.controller';

function build() {
  const actors = {
    generateAvatarVideo: jest.fn().mockResolvedValue({ status: 'processing' }),
    getAvatarVideoStatus: jest.fn().mockResolvedValue({ status: 'complete' }),
    getSoundCheckState: jest.fn().mockResolvedValue({ history: [] }),
    runSoundCheck: jest
      .fn()
      .mockResolvedValue({ history: [{ checkId: 'c1' }] }),
  };
  const adminPanel = { assertOperator: jest.fn().mockResolvedValue(undefined) };
  const controller = new ActorsController(actors as never, adminPanel as never);
  return { controller, actors, adminPanel };
}

const req = { userId: 'admin-1' } as never;

describe('ActorsController', () => {
  it('generate: проверяет оператора ДО вызова сервиса', async () => {
    const { controller, actors, adminPanel } = build();
    await controller.generate(req, 's1', { characterIndex: 0 } as never);
    expect(adminPanel.assertOperator).toHaveBeenCalledWith('admin-1');
    expect(actors.generateAvatarVideo).toHaveBeenCalledWith(
      's1',
      0,
      undefined,
      undefined,
      undefined,
      false,
    );
  });

  it('generate: не-оператор получает отказ, сервис не вызывается вовсе', async () => {
    const { controller, actors, adminPanel } = build();
    adminPanel.assertOperator.mockRejectedValue(
      new ForbiddenException('Operator access required'),
    );
    await expect(
      controller.generate(req, 's1', { characterIndex: 0 } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(actors.generateAvatarVideo).not.toHaveBeenCalled();
  });

  it('generate: параметры DTO пробрасываются как есть', async () => {
    const { controller, actors } = build();
    await controller.generate(req, 's1', {
      characterIndex: 2,
      prompt: 'своя сцена',
      aspectRatio: '16:9',
      resolution: '1080p',
      subtitles: true,
    } as never);
    expect(actors.generateAvatarVideo).toHaveBeenCalledWith(
      's1',
      2,
      'своя сцена',
      '16:9',
      '1080p',
      true,
    );
  });

  it('status: проверяет оператора ДО вызова сервиса', async () => {
    const { controller, actors, adminPanel } = build();
    await controller.status(req, 's1');
    expect(adminPanel.assertOperator).toHaveBeenCalledWith('admin-1');
    expect(actors.getAvatarVideoStatus).toHaveBeenCalledWith('s1');
  });

  it('status: не-оператор получает отказ, сервис не вызывается', async () => {
    const { controller, actors, adminPanel } = build();
    adminPanel.assertOperator.mockRejectedValue(
      new ForbiddenException('Operator access required'),
    );
    await expect(controller.status(req, 's1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(actors.getAvatarVideoStatus).not.toHaveBeenCalled();
  });

  // Этап 73 — те же два маршрута (GET состояние / POST запуск), что у
  // audit/sound-check на Veo-стороне, но admin-only, тем же гейтом, что
  // и остальные маршруты этого контроллера.
  it('soundCheckState: проверяет оператора ДО вызова сервиса', async () => {
    const { controller, actors, adminPanel } = build();
    const result = await controller.soundCheckState(req, 's1');
    expect(adminPanel.assertOperator).toHaveBeenCalledWith('admin-1');
    expect(actors.getSoundCheckState).toHaveBeenCalledWith('s1');
    expect(result).toEqual({ history: [] });
  });

  it('soundCheckState: не-оператор получает отказ, сервис не вызывается', async () => {
    const { controller, actors, adminPanel } = build();
    adminPanel.assertOperator.mockRejectedValue(
      new ForbiddenException('Operator access required'),
    );
    await expect(controller.soundCheckState(req, 's1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(actors.getSoundCheckState).not.toHaveBeenCalled();
  });

  it('soundCheck: проверяет оператора ДО вызова сервиса', async () => {
    const { controller, actors, adminPanel } = build();
    const result = await controller.soundCheck(req, 's1');
    expect(adminPanel.assertOperator).toHaveBeenCalledWith('admin-1');
    expect(actors.runSoundCheck).toHaveBeenCalledWith('s1');
    expect(result).toEqual({ history: [{ checkId: 'c1' }] });
  });

  it('soundCheck: не-оператор получает отказ, платный Gemini-вызов не запускается', async () => {
    const { controller, actors, adminPanel } = build();
    adminPanel.assertOperator.mockRejectedValue(
      new ForbiddenException('Operator access required'),
    );
    await expect(controller.soundCheck(req, 's1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(actors.runSoundCheck).not.toHaveBeenCalled();
  });
});
