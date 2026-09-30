/**
 * «Кто в кадре» в брифе (этап G ТЗ Greeting 2.0 §4.8): выбор образа
 * персоны проверяется на сервере — свой, не удалён, готов, скетч только со
 * скетчем, скетч не на Hedra, режим включён.
 */
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GreetingBriefService } from './greeting-brief.service';
import {
  HEDRA_SKETCH_PRESENTER_REFUSAL,
  PRESENTER_LOOK_NOT_FOUND,
  PRESENTER_LOOK_NOT_READY,
  PRESENTER_SKETCH_MISSING,
} from '../../common/greeting-persona';

const brief = (over: Record<string, unknown> = {}) => ({
  id: 'gb1',
  projectId: 'p1',
  occasion: 'BIRTHDAY',
  customOccasionText: null,
  recipientName: 'Аня',
  senderName: null,
  tone: 'WARM',
  personalMessage: null,
  presenterProvider: 'grok',
  resolution: '720p',
  brandManifestId: null,
  occasionDate: null,
  presenterLookId: null,
  presenterVariant: null,
  createdAt: new Date('2026-09-30T10:00:00Z'),
  updatedAt: new Date('2026-09-30T10:00:00Z'),
  ...over,
});

const look = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  label: 'Деловой',
  status: 'ready',
  deletedAt: null,
  photoUrl: 'https://blob/l1.png',
  photoPathname: 'users/u1/personas/p1/looks/l1.png',
  activeSketch: { url: 'https://blob/s.png', pathname: 'sketches/u1/s.png' },
  persona: { userId: 'u1', revokedAt: null },
  ...over,
});

function build(current = brief(), lookRow: unknown = look()) {
  const prisma = {
    greetingBrief: {
      findFirst: jest.fn().mockResolvedValue(current),
      update: jest
        .fn()
        .mockImplementation(
          async ({ data }: { data: Record<string, unknown> }) =>
            brief({ ...current, ...data }),
        ),
    },
    personaLook: { findFirst: jest.fn().mockResolvedValue(lookRow) },
    brandManifest: { findFirst: jest.fn().mockResolvedValue({ id: 'bm1' }) },
  };
  const plans = { planOfUser: jest.fn().mockResolvedValue('PREMIUM') };
  return {
    service: new GreetingBriefService(prisma as never, plans as never),
    prisma,
  };
}

const OLD_FLAG = process.env.PERSONA_ENABLED;
beforeEach(() => {
  process.env.PERSONA_ENABLED = 'true';
});
afterAll(() => {
  process.env.PERSONA_ENABLED = OLD_FLAG;
});

describe('GreetingBriefService — ведущий-образ', () => {
  it('свой готовый образ → колонки брифа; ответ отдаёт выбор', async () => {
    const { service, prisma } = build();
    const view = await service.updateBrief('u1', 'p1', {
      presenter: { kind: 'persona', lookId: 'l1', variant: 'photo' },
    });
    expect(prisma.personaLook.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'l1', persona: { userId: 'u1' } },
      }),
    );
    expect(prisma.greetingBrief.update.mock.calls[0][0].data).toMatchObject({
      presenterLookId: 'l1',
      presenterVariant: 'photo',
    });
    expect(view.presenter).toEqual({
      kind: 'persona',
      lookId: 'l1',
      variant: 'photo',
    });
  });

  it('`ai` сбрасывает образ и не читает образы', async () => {
    const { service, prisma } = build(
      brief({ presenterLookId: 'l1', presenterVariant: 'photo' }),
    );
    const view = await service.updateBrief('u1', 'p1', {
      presenter: { kind: 'ai' } as never,
    });
    expect(prisma.personaLook.findFirst).not.toHaveBeenCalled();
    expect(prisma.greetingBrief.update.mock.calls[0][0].data).toMatchObject({
      presenterLookId: null,
      presenterVariant: null,
    });
    expect(view.presenter).toEqual({ kind: 'ai' });
  });

  it('не передан — прежний выбор остаётся', async () => {
    const { service, prisma } = build(
      brief({ presenterLookId: 'l1', presenterVariant: 'sketch' }),
    );
    await service.updateBrief('u1', 'p1', { recipientName: 'Оля' });
    expect(prisma.personaLook.findFirst).not.toHaveBeenCalled();
    expect(prisma.greetingBrief.update.mock.calls[0][0].data).toMatchObject({
      presenterLookId: 'l1',
      presenterVariant: 'sketch',
    });
  });

  it.each([
    [
      'чужой',
      look({ persona: { userId: 'u2', revokedAt: null } }),
      'photo',
      PRESENTER_LOOK_NOT_FOUND,
    ],
    [
      'удалён',
      look({ deletedAt: new Date() }),
      'photo',
      PRESENTER_LOOK_NOT_FOUND,
    ],
    ['нет', null, 'photo', PRESENTER_LOOK_NOT_FOUND],
    [
      'не готов',
      look({ status: 'pending' }),
      'photo',
      PRESENTER_LOOK_NOT_READY,
    ],
    [
      'скетча нет',
      look({ activeSketch: null }),
      'sketch',
      PRESENTER_SKETCH_MISSING,
    ],
  ])('образ %s — 400, бриф не пишется', async (_n, row, variant, message) => {
    const { service, prisma } = build(brief(), row);
    await expect(
      service.updateBrief('u1', 'p1', {
        presenter: { kind: 'persona', lookId: 'l1', variant: variant as never },
      }),
    ).rejects.toThrow(message as string);
    expect(prisma.greetingBrief.update).not.toHaveBeenCalled();
  });

  it('режим выключен — 404 PERSONA_DISABLED', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const { service, prisma } = build();
    const err = await service
      .updateBrief('u1', 'p1', {
        presenter: { kind: 'persona', lookId: 'l1', variant: 'photo' },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toMatchObject({
      code: 'PERSONA_DISABLED',
    });
    expect(prisma.greetingBrief.update).not.toHaveBeenCalled();
  });

  it('скетч на Hedra — отказ и при выборе, и при смене одного провайдера', async () => {
    const { service } = build(brief({ presenterProvider: 'hedra' }));
    await expect(
      service.updateBrief('u1', 'p1', {
        presenter: { kind: 'persona', lookId: 'l1', variant: 'sketch' },
      }),
    ).rejects.toThrow(HEDRA_SKETCH_PRESENTER_REFUSAL);

    const second = build(
      brief({ presenterLookId: 'l1', presenterVariant: 'sketch' }),
    );
    await expect(
      second.service.updateBrief('u1', 'p1', { presenterProvider: 'hedra' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(second.prisma.greetingBrief.update).not.toHaveBeenCalled();
  });

  it('writeResolved: образ, которого уже нет, пишется как ИИ-ведущий, а не 500 по внешнему ключу', async () => {
    const { service, prisma } = build(brief(), null);
    const next = await service.resolveNext('u1', brief() as never, {});
    await service.writeResolved('u1', 'p1', {
      ...next,
      presenterLookId: 'gone',
      presenterVariant: 'photo',
    });
    expect(prisma.greetingBrief.update.mock.calls[0][0].data).toMatchObject({
      presenterLookId: null,
      presenterVariant: null,
    });
  });

  it('presenterSnapshot — копия выбранного варианта; удалённый образ — 400', async () => {
    const { service } = build();
    await expect(
      service.presenterSnapshot('u1', 'l1', 'sketch'),
    ).resolves.toMatchObject({
      lookId: 'l1',
      url: 'https://blob/s.png',
      variant: 'sketch',
    });
    const gone = build(brief(), look({ deletedAt: new Date() }));
    await expect(
      gone.service.presenterSnapshot('u1', 'l1', 'photo'),
    ).rejects.toThrow(PRESENTER_LOOK_NOT_FOUND);
  });
});
