import { TestingBriefService } from './testing-brief.service';

const NOW = new Date('2026-09-26T12:00:00.000Z');

function build(
  over: {
    user?: Record<string, unknown> | null;
    tickets?: Array<Record<string, unknown>>;
    total?: number;
    spent?: Record<string, number>;
  } = {},
) {
  const user =
    over.user === undefined
      ? {
          id: 'u1',
          isTestUser: true,
          testAccessUntil: new Date('2026-10-01T00:00:00.000Z'),
          freeScenarios: ['PRODUCT_VIDEO'],
          freeOutsideProject: true,
          testDailyLimitUsd: 5,
          testerInvites: [{ brief: 'Проверьте поздравления на iPhone.' }],
        }
      : over.user;
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    testTicket: {
      findMany: jest.fn().mockResolvedValue(over.tickets ?? []),
      count: jest
        .fn()
        .mockResolvedValue(over.total ?? (over.tickets ?? []).length),
    },
  };
  const aiUsage = {
    spentTodayByUsers: jest.fn().mockResolvedValue(over.spent ?? {}),
  };
  return {
    service: new TestingBriefService(prisma as never, aiUsage as never),
    prisma,
    aiUsage,
  };
}

describe('бриф тестировщика', () => {
  it('говорит, что открыто и до какого числа', async () => {
    const { service } = build({ spent: { u1: 1_200_000 } });
    const brief = await service.of('42');
    expect(brief.scenarios).toEqual(['PRODUCT_VIDEO']);
    expect(brief.freeOutsideProject).toBe(true);
    expect(brief.accessUntil).toBe('2026-10-01T00:00:00.000Z');
    expect(brief.spentTodayMicroUsd).toBe(1_200_000);
    expect(brief.dailyLimitMicroUsd).toBe(5_000_000);
  });

  it('без своего потолка показывает общий', async () => {
    const { service } = build({
      user: {
        id: 'u1',
        isTestUser: true,
        testAccessUntil: null,
        freeScenarios: [],
        freeOutsideProject: false,
        testDailyLimitUsd: null,
        testerInvites: [],
      },
    });
    const brief = await service.of('42');
    expect(brief.dailyLimitMicroUsd).toBeGreaterThan(0);
    expect(brief.accessUntil).toBeNull();
  });

  it('мусор в колонке сценариев не доезжает до экрана', async () => {
    // Значение могло попасть туда мимо формы — через psql.
    const { service } = build({
      user: {
        id: 'u1',
        isTestUser: true,
        testAccessUntil: null,
        freeScenarios: ['PRODUCT_VIDEO', 'НЕЧТО'],
        freeOutsideProject: false,
        testDailyLimitUsd: null,
        testerInvites: [],
      },
    });
    expect((await service.of('42')).scenarios).toEqual(['PRODUCT_VIDEO']);
  });

  it('свои находки — свежие сверху, с признаком «ждут нас»', async () => {
    const { service, prisma } = build({
      tickets: [
        {
          number: 21,
          createdAt: NOW,
          status: 'NEW',
          source: 'APP',
          text: 'кнопка\nне нажимается',
          replySentAt: null,
        },
        {
          number: 9,
          createdAt: NOW,
          status: 'FIXED',
          source: 'BOT',
          text: 'старое',
          replySentAt: NOW,
        },
      ],
    });
    const brief = await service.of('42');
    expect(prisma.testTicket.findMany.mock.calls[0][0].orderBy).toEqual({
      createdAt: 'desc',
    });
    expect(brief.tickets[0]).toMatchObject({
      number: 21,
      open: true,
      answered: false,
      preview: 'кнопка не нажимается',
    });
    expect(brief.tickets[1]).toMatchObject({ open: false, answered: true });
  });

  it('только свои — чужих находок здесь нет', async () => {
    const { service, prisma } = build();
    await service.of('42');
    expect(prisma.testTicket.findMany.mock.calls[0][0].where).toEqual({
      userId: 'u1',
    });
  });

  it('текста ответа оператора на экране нет', async () => {
    // Ответ приходит в личку, и второе его место разошлось бы с
    // первым — тот же довод, что у переписки в админке (§5.2).
    const { service, prisma } = build();
    await service.of('42');
    const select = prisma.testTicket.findMany.mock.calls[0][0].select;
    expect(select.comments).toBeUndefined();
    expect(select.replySentAt).toBe(true);
  });

  it('длинную находку в списке узнают по началу', async () => {
    const { service } = build({
      tickets: [
        {
          number: 1,
          createdAt: NOW,
          status: 'NEW',
          source: 'BOT',
          text: 'я'.repeat(300),
          replySentAt: null,
        },
      ],
    });
    expect((await service.of('42')).tickets[0].preview).toHaveLength(81);
  });

  it('говорит, ЧТО проверять — текстом из приглашения', async () => {
    // Аудит этапа 161: экран называется брифом, и первым пунктом §2.3
    // стоит «что проверять» — а отвечать было нечем, текста этого
    // нигде не существовало.
    const { service } = build();
    expect((await service.of('42')).brief).toBe(
      'Проверьте поздравления на iPhone.',
    );
  });

  it('брифа не написали — поле пустое, а не выдуманное', async () => {
    const { service } = build({
      user: {
        id: 'u1',
        isTestUser: true,
        testAccessUntil: null,
        freeScenarios: [],
        freeOutsideProject: false,
        testDailyLimitUsd: null,
        testerInvites: [],
      },
    });
    expect((await service.of('42')).brief).toBeNull();
  });

  it('полное число находок едет рядом с обрезанным списком', async () => {
    // Длина обрезанного списка, выданная за общее число, — ровно та
    // ошибка, которую аудит этапа 158 нашёл на вкладке админки.
    const { service } = build({
      tickets: [
        {
          number: 1,
          createdAt: NOW,
          status: 'NEW',
          source: 'BOT',
          text: 'раз',
          replySentAt: null,
        },
      ],
      total: 47,
    });
    const brief = await service.of('42');
    expect(brief.ticketsTotal).toBe(47);
    expect(brief.tickets).toHaveLength(1);
  });

  it('не тестировщику брифа нет', async () => {
    const { service } = build({
      user: { id: 'u2', isTestUser: false, testAccessUntil: null },
    });
    await expect(service.of('42')).rejects.toThrow(/Тестовый доступ/);
  });

  it('истёкшему доступу — тоже', async () => {
    // Иначе экран обещал бы то, чего нет в проверке (аудит этапа 159).
    const { service } = build({
      user: {
        id: 'u3',
        isTestUser: true,
        testAccessUntil: new Date(Date.now() - 1000),
        freeScenarios: ['PRODUCT_VIDEO'],
        freeOutsideProject: true,
        testDailyLimitUsd: null,
        testerInvites: [],
      },
    });
    await expect(service.of('42')).rejects.toThrow(/Тестовый доступ/);
  });

  it('незнакомому человеку — тоже', async () => {
    const { service } = build({ user: null });
    await expect(service.of('42')).rejects.toThrow(/Тестовый доступ/);
  });
});
