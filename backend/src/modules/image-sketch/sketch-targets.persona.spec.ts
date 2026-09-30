/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../storage/blob.service', () => ({ BlobService: class {} }));
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SketchTargetsService } from './sketch-targets';

/**
 * Адаптер слота `persona-look` (ТЗ TZ-Greeting-2.0 §4.5, Т-3): своё лицо —
 * только проверенной персоне с действующим согласием.
 */

const VERIFIED = {
  id: 'p1',
  userId: 'u1',
  consentGivenAt: new Date('2026-09-01'),
  revokedAt: null,
  livenessCheckedAt: new Date('2026-09-01'),
  verifyResult: { status: 'ok', reasons: [] },
  ageMin: 28,
  ageMax: 34,
};

function lookRow(over: Record<string, unknown> = {}) {
  return {
    id: 'look1',
    photoUrl: 'https://blob/users/u1/personas/p1/looks/look1.png',
    photoPathname: 'users/u1/personas/p1/looks/look1.png',
    status: 'ready',
    description: null,
    activeSketchId: null,
    activeSketch: null,
    originalDeletedAt: null,
    persona: VERIFIED,
    ...over,
  };
}

function build(row: unknown) {
  const prisma = {
    personaLook: {
      findFirst: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const svc = new SketchTargetsService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { svc, prisma };
}

const TARGET = { type: 'persona-look' as const, id: 'look1' };

describe('SketchTargetsService: слот persona-look', () => {
  const saved = process.env.PERSONA_ENABLED;
  beforeEach(() => {
    process.env.PERSONA_ENABLED = 'true';
  });
  afterAll(() => {
    process.env.PERSONA_ENABLED = saved;
  });

  it('проверенная персона — likeness self, файл образа, владелец в запросе', async () => {
    const { svc, prisma } = build(lookRow());
    const slot = await svc.load(TARGET, 'u1');
    expect(slot.likeness).toBe('self');
    expect(slot.kind).toBe('character');
    expect(slot.originalPathname).toBe('users/u1/personas/p1/looks/look1.png');
    expect(slot.ownsOriginalFile).toBe(false);
    expect(slot.description).toBeNull();
    expect(prisma.personaLook.findFirst.mock.calls[0][0].where).toEqual({
      id: 'look1',
      deletedAt: null,
      persona: { userId: 'u1', revokedAt: null },
    });
  });

  it('персона без действующего допуска — 403, а не тихое обезличивание', async () => {
    const broken = [
      { consentGivenAt: null },
      { revokedAt: new Date() },
      { livenessCheckedAt: null },
      { verifyResult: { status: 'refused', reasons: ['no-face'] } },
      { verifyResult: null },
      { ageMin: 17 },
      { ageMin: null },
    ];
    for (const patch of broken) {
      const { svc } = build(lookRow({ persona: { ...VERIFIED, ...patch } }));
      await expect(svc.load(TARGET, 'u1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
  });

  it('чужой/удалённый образ — 404; образ без фото — 400', async () => {
    await expect(build(null).svc.load(TARGET, 'u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      build(lookRow({ status: 'pending', photoPathname: null })).svc.load(
        TARGET,
        'u1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('режим выключен — 404 PERSONA_DISABLED, в базу не ходим', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const { svc, prisma } = build(lookRow());
    await expect(svc.load(TARGET, 'u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.personaLook.findFirst).not.toHaveBeenCalled();
  });

  it('применение пишет activeSketchId образа', async () => {
    const { svc, prisma } = build(lookRow());
    const slot = await svc.load(TARGET, 'u1');
    await svc.writeActive(slot, {
      sketchId: 'sk1',
      url: 'https://blob/sketches/u1/sk1.png',
      pathname: 'sketches/u1/sk1.png',
      mimeType: 'image/png',
      style: 'pencil',
      sketchRendering: 'realistic',
      appliedAt: new Date().toISOString(),
    });
    expect(prisma.personaLook.update).toHaveBeenCalledWith({
      where: { id: 'look1' },
      data: { activeSketchId: 'sk1' },
    });
  });
});
