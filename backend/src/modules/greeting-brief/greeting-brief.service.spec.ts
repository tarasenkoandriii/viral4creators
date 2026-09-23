/**
 * Серверная проверка пары (повод, тон) на пути правки брифа — этап 2,
 * фича №3 компаньон-ТЗ.
 *
 * §3 ТЗ требует, чтобы недопустимый тон «валидировался серверно (не
 * просто скрывался в UI)». Тесты проверяют именно это: не то, что
 * интерфейс не покажет кнопку, а то, что запрос с таким телом получит
 * 400 — визард обходится прямым вызовом API, эта проверка не обходится.
 */
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { GreetingBriefService } from './greeting-brief.service';

const brief = (over: Record<string, unknown> = {}) => ({
  id: 'gb1',
  projectId: 'p1',
  occasion: 'BIRTHDAY',
  customOccasionText: null,
  recipientName: 'Аня',
  senderName: null,
  tone: 'FUNNY',
  personalMessage: null,
  presenterProvider: 'grok',
  resolution: '720p',
  brandManifestId: null,
  occasionDate: null,
  createdAt: new Date('2026-09-22T10:00:00Z'),
  updatedAt: new Date('2026-09-22T10:00:00Z'),
  ...over,
});

function build(current = brief()) {
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
    brandManifest: { findFirst: jest.fn().mockResolvedValue({ id: 'bm1' }) },
  };
  const plans = { planOfUser: jest.fn().mockResolvedValue('PREMIUM') };
  return {
    service: new GreetingBriefService(prisma as never, plans as never),
    prisma,
  };
}

describe('GreetingBriefService.updateBrief — пара (повод, тон)', () => {
  it('отвергает шутливый тон, выставленный для соболезнования', async () => {
    const { service, prisma } = build(
      brief({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL' }),
    );
    await expect(
      service.updateBrief('u1', 'p1', { tone: 'FUNNY' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.greetingBrief.update).not.toHaveBeenCalled();
  });

  /**
   * Второй, менее очевидный путь: тон не трогают, меняют ПОВОД. Тон
   * остался с прошлой правки и стал неуместным. Без проверки пары (а не
   * каждого поля по отдельности) это прошло бы молча.
   */
  it('отвергает смену повода, при которой уже выбранный тон становится неуместным', async () => {
    const { service, prisma } = build(
      brief({ occasion: 'BIRTHDAY', tone: 'FUNNY' }),
    );
    await expect(
      service.updateBrief('u1', 'p1', { occasion: 'CONDOLENCE' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.greetingBrief.update).not.toHaveBeenCalled();
  });

  it('сообщение отказа называет допустимые тоны, а не просто «нельзя»', async () => {
    const { service } = build(brief({ occasion: 'BIRTHDAY', tone: 'FUNNY' }));
    await expect(
      service.updateBrief('u1', 'p1', { occasion: 'GET_WELL' }),
    ).rejects.toThrow(/SUPPORTIVE/);
  });

  it('допустимая пара проходит и сохраняется', async () => {
    const { service, prisma } = build(
      brief({ occasion: 'BIRTHDAY', tone: 'WARM' }),
    );
    await service.updateBrief('u1', 'p1', {
      occasion: 'CONDOLENCE',
      tone: 'RESPECTFUL',
    });
    const data = prisma.greetingBrief.update.mock.calls[0][0].data;
    expect(data.occasion).toBe('CONDOLENCE');
    expect(data.tone).toBe('RESPECTFUL');
  });

  it('новый повод этапа 2 принимается', async () => {
    const { service, prisma } = build(brief({ tone: 'WARM' }));
    await service.updateBrief('u1', 'p1', { occasion: 'HOUSEWARMING' });
    expect(prisma.greetingBrief.update.mock.calls[0][0].data.occasion).toBe(
      'HOUSEWARMING',
    );
  });
});
