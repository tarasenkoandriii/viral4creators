jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { TesterOnboardingService } from './tester-onboarding.service';

/**
 * Этап 155. Активация — единственное место, где тестовый доступ
 * выдаётся не руками оператора, поэтому каждый отказ отдельной строкой.
 */
const NOW = new Date('2026-09-25T12:00:00Z');

function build(
  over: {
    invite?: Record<string, unknown> | null;
    user?: Record<string, unknown>;
    subscription?: { status: string } | null;
  } = {},
) {
  const prisma = {
    testerInvite: {
      findUnique: jest.fn().mockResolvedValue(
        'invite' in over
          ? over.invite
          : {
              id: 'inv1',
              token: 'TOKEN',
              label: 'Тестер',
              freeScenarios: ['PRODUCT_VIDEO'],
              expiresAt: null,
              revokedAt: null,
              userId: null,
            },
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      upsert: jest.fn().mockResolvedValue({
        id: 'u1',
        isBlocked: false,
        ...over.user,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    subscription: {
      findUnique: jest.fn().mockResolvedValue(over.subscription ?? null),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const notify = { dm: jest.fn().mockResolvedValue(true) };
  return {
    service: new TesterOnboardingService(prisma as never, notify as never),
    prisma,
    notify,
  };
}

const input = {
  token: 'TOKEN',
  telegramId: '777',
  username: 'tester',
  firstName: 'Тест',
  languageCode: 'ru',
};

const said = (notify: { dm: jest.Mock }) =>
  String(notify.dm.mock.calls[0]?.[1] ?? '');

describe('активация', () => {
  it('свежее приглашение открывает доступ и отвечает человеку', async () => {
    const { service, prisma, notify } = build();
    await service.activate(input);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(said(notify)).toContain('Тестовый доступ открыт');
  });

  it('диалог помечается открытым даже при ОТКАЗЕ по известному приглашению', async () => {
    // `botChatOpenedAt` — это факт «диалог существует», и он верен
    // независимо от того, дали мы доступ или отказали. Потерять его
    // из-за отказа значило бы не уметь написать человеку ровно тогда,
    // когда объяснить надо больше всего.
    const { service, prisma } = build({ user: { isBlocked: true } });
    await service.activate(input);
    const call = prisma.user.upsert.mock.calls[0][0] as {
      update: { botChatOpenedAt: Date };
    };
    expect(call.update.botChatOpenedAt).toBeInstanceOf(Date);
  });

  it('незнакомый токен пользователя НЕ заводит', async () => {
    // Иначе строку в `users` заводит любой, кто нажал START по
    // случайной ссылке, — а знакомство с нами у него на этом и
    // заканчивается.
    const { service, prisma } = build({ invite: null });
    await service.activate(input);
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('незнакомый токен — нейтральный ответ и никакого доступа', async () => {
    const { service, prisma, notify } = build({ invite: null });
    await service.activate(input);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(said(notify)).toBe('Ссылка недействительна.');
  });

  it('отозванное и просроченное отвечают ТЕМ ЖЕ, что незнакомое', async () => {
    // Разные ответы рассказали бы постороннему, что стало с чужой
    // ссылкой, а человеку это одинаково означает «не работает».
    for (const invite of [
      {
        id: 'i',
        token: 'T',
        freeScenarios: [],
        expiresAt: null,
        revokedAt: NOW,
        userId: null,
      },
      {
        id: 'i',
        token: 'T',
        freeScenarios: [],
        expiresAt: new Date('2020-01-01'),
        revokedAt: null,
        userId: null,
      },
    ]) {
      const { service, prisma, notify } = build({ invite });
      await service.activate(input);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(said(notify)).toBe('Ссылка недействительна.');
    }
  });

  it('заблокированный не обходит блокировку по пересланной ссылке', async () => {
    // Блокировка сильнее тестового доступа — тот же порядок, что в
    // `PlanService.assertSpend`.
    const { service, prisma, notify } = build({ user: { isBlocked: true } });
    await service.activate(input);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(said(notify)).toContain('ограничен');
  });

  it('платящему клиенту тестовый доступ поверх подписки не выдаётся', async () => {
    // Это молча изменило бы человеку правила списания; решение
    // принимает оператор, а не пересланная ссылка.
    for (const status of ['ACTIVE', 'RENEWING']) {
      const { service, prisma, notify } = build({ subscription: { status } });
      await service.activate(input);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(said(notify)).toContain('подписка');
    }
  });

  it('отменённая подписка активации не мешает', async () => {
    const { service, prisma } = build({ subscription: { status: 'CANCELED' } });
    await service.activate(input);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('повтор тем же человеком — то же приветствие, без второй записи', async () => {
    const { service, prisma, notify } = build({
      invite: {
        id: 'inv1',
        token: 'TOKEN',
        freeScenarios: ['PRODUCT_VIDEO'],
        expiresAt: null,
        revokedAt: null,
        userId: 'u1',
      },
    });
    await service.activate(input);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(said(notify)).toContain('Тестовый доступ открыт');
  });

  it('чужая ссылка — отказ, отличимый от незнакомой только для своего', async () => {
    const { service, prisma, notify } = build({
      invite: {
        id: 'inv1',
        token: 'TOKEN',
        freeScenarios: [],
        expiresAt: null,
        revokedAt: null,
        userId: 'somebody-else',
      },
    });
    await service.activate(input);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(said(notify)).toBe('Эта ссылка уже использована.');
  });

  it('мусор в сценариях приглашения не доезжает до пользователя', async () => {
    const { service, prisma } = build({
      invite: {
        id: 'inv1',
        token: 'TOKEN',
        freeScenarios: ['PRODUCT_VIDEO', 'НЕЧТО', 'PRODUCT_VIDEO'],
        expiresAt: null,
        revokedAt: null,
        userId: null,
      },
    });
    await service.activate(input);
    const update = prisma.user.update.mock.calls[0][0] as {
      data: { freeScenarios: string[] };
    };
    expect(update.data.freeScenarios).toEqual(['PRODUCT_VIDEO']);
  });

  it('приветствие не обещает того, чего ещё нет', async () => {
    // Потолок и операции вне проекта появятся вместе со своими
    // проверками (этап 5 ТЗ). Обещать их первым же сообщением человеку,
    // который пришёл искать наши ошибки, — худший способ начать.
    const { service, notify } = build();
    await service.activate(input);
    expect(said(notify)).not.toContain('потолок');
    expect(said(notify)).not.toContain('$');
  });
});
