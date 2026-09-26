/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ForbiddenException } from '@nestjs/common';
import { PlanService } from './plan.service';
import { DailySpendLimitExceededException } from '../../common/spend-limits';

function build(user: Record<string, unknown> | null = { plan: 'PREMIUM' }) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue({ plan: 'STANDARD' }),
    },
    // Подписка/кредиты (этап 62) — по умолчанию у пользователя ничего
    // нет, стандартный случай для тестов, не завязанных на биллинг.
    subscription: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    // Последний платёж Stars за подписку (Г-2.2, этап 64) — по умолчанию
    // не найден, тесты STARS-отмены переопределяют.
    payment: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    // Тип проекта (TODO §III п.37) — по нему определяется сценарий
    // тестового доступа. По умолчанию обычный товарный проект.
    project: {
      findUnique: jest.fn().mockResolvedValue({ type: 'SINGLE' }),
    },
  };
  const sessions = { getSession: jest.fn() };
  // Учёт расходов (§26.4): по умолчанию лимит не выбран.
  const aiUsage = {
    budget: jest.fn().mockResolvedValue({
      allowed: true,
      limitMicroUsd: 2_000_000,
      spentMicroUsd: 0,
      remainingMicroUsd: 2_000_000,
    }),
    spentToday: jest.fn().mockResolvedValue(0),
  };
  const creditLedger = {
    balanceOf: jest.fn().mockResolvedValue(0),
  };
  // Г-2.2 (аудит round4, этап 64): немедленная отмена подписки Stars в
  // Telegram — по умолчанию заглушка, тесты, которым важен именно этот
  // вызов, переопределяют мок и/или прокидывают user.telegramId/payment.
  const stars = {
    cancelSubscription: jest.fn().mockResolvedValue(true),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    svc: new PlanService(
      prisma as any,
      sessions as any,
      aiUsage as any,
      creditLedger as any,
      stars as any,
    ),
    prisma,
    sessions,
    aiUsage,
    creditLedger,
    stars,
  };
}

describe('PlanService (ТЗ §23)', () => {
  afterEach(() => delete process.env.PLANS_BILLING_ENABLED);

  it('анонимная сессия работает в Lite и в базу не ходит', async () => {
    const { svc, prisma } = build();
    expect(await svc.planOfUser(null)).toBe('LITE');
    expect(await svc.planOfUser(undefined)).toBe('LITE');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('неизвестное значение в колонке читается как Lite, а не как ошибка', async () => {
    const { svc } = build({ plan: 'GOLD' });
    expect(await svc.planOfUser('u1')).toBe('LITE');
    expect(await build(null).svc.planOfUser('u1')).toBe('LITE');
  });

  it('режим берётся у владельца сессии — открытые маршруты не понижают Premium', async () => {
    const { svc, sessions, prisma } = build({ plan: 'PREMIUM' });
    sessions.getSession.mockResolvedValue({ sessionId: 's1', userId: 'u1' });
    expect(await svc.planOfSession('s1')).toBe('PREMIUM');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      // Режим, его происхождение и блокировка — одним запросом (§25.3, Б-3.8).
      select: {
        plan: true,
        planSelfService: true,
        isBlocked: true,
        blockedReason: true,
        isTestUser: true,
        freeScenarios: true,
        freeOutsideProject: true,
        testAccessUntil: true,
        testDailyLimitUsd: true,
      },
    });
    sessions.getSession.mockResolvedValue({ sessionId: 's2', userId: null });
    expect(await svc.planOfSession('s2')).toBe('LITE');
  });

  it('assert пропускает разрешённое и бросает 403 с человеческим текстом', async () => {
    const { svc } = build();
    expect(() => svc.assert('PREMIUM', 'library')).not.toThrow();
    expect(() => svc.assert('LITE', 'library')).toThrow(ForbiddenException);
    // Через `toThrow`, а не try/catch: если `assert` перестанет бросать,
    // блок `catch` просто не выполнится — и тест пройдёт молча, унеся с
    // собой заодно и проверку текста отказа.
    expect(() => svc.assert('LITE', 'audit')).toThrow(/Standard/);
    expect(() => svc.assert('LITE', 'audit')).toThrow(/бесплатны/);
  });

  it('assertUser для анонима запрещает премиальное, но пропускает базовое', async () => {
    const { svc } = build();
    await expect(svc.assertUser(null, 'library')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.assertUser(null, 'customAspectRatio')).rejects.toThrow();
  });

  it('пока оплаты нет — переключение свободное; с включённой оплатой повышение запрещено', async () => {
    const { svc, prisma } = build();
    expect(await svc.setPlan('u1', 'STANDARD')).toBe('STANDARD');
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({
      plan: 'STANDARD',
    });
    expect(prisma.user.update.mock.calls[0][0].data.planSince).toBeInstanceOf(
      Date,
    );

    process.env.PLANS_BILLING_ENABLED = 'true';
    await expect(svc.setPlan('u1', 'PREMIUM')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.setPlan('u1', 'PREMIUM')).rejects.toThrow(
      /checkout\/subscription/,
    );
  });

  it('с включённой оплатой понижение до LITE — это запрос отмены, не мгновенное понижение (этап 62)', async () => {
    process.env.PLANS_BILLING_ENABLED = 'true';
    const { svc, prisma } = build({ plan: 'STANDARD' });
    prisma.subscription.findUnique.mockResolvedValue({
      id: 'sub1',
      status: 'ACTIVE',
    });
    expect(await svc.setPlan('u1', 'LITE')).toBe('STANDARD'); // доступ не изменился прямо сейчас
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub1' },
      data: { cancelAtPeriodEnd: true },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('отмена подписки Stars сразу сообщается Telegram (Г-2.2, этап 64)', async () => {
    process.env.PLANS_BILLING_ENABLED = 'true';
    const { svc, prisma, stars } = build({
      plan: 'STANDARD',
      telegramId: 'tg-1',
    });
    prisma.subscription.findUnique.mockResolvedValue({
      id: 'sub1',
      status: 'ACTIVE',
      method: 'STARS',
    });
    prisma.payment.findFirst.mockResolvedValue({ providerRef: 'charge-1' });
    expect(await svc.setPlan('u1', 'LITE')).toBe('STANDARD');
    expect(stars.cancelSubscription).toHaveBeenCalledWith('tg-1', 'charge-1');
  });

  it('WayForPay-подписку отменяем локально, Telegram не трогаем', async () => {
    process.env.PLANS_BILLING_ENABLED = 'true';
    const { svc, prisma, stars } = build({ plan: 'STANDARD' });
    prisma.subscription.findUnique.mockResolvedValue({
      id: 'sub1',
      status: 'ACTIVE',
      method: 'WAYFORPAY',
    });
    expect(await svc.setPlan('u1', 'LITE')).toBe('STANDARD');
    expect(stars.cancelSubscription).not.toHaveBeenCalled();
  });

  it('запрос отмены без активной подписки — идемпотентный no-op', async () => {
    process.env.PLANS_BILLING_ENABLED = 'true';
    const { svc, prisma } = build({ plan: 'LITE' });
    prisma.subscription.findUnique.mockResolvedValue(null);
    expect(await svc.setPlan('u1', 'LITE')).toBe('LITE');
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  it('applyPurchasedPlan пишет режим без самостоятельного флага', async () => {
    const { svc, prisma } = build();
    await svc.applyPurchasedPlan('u1', 'PREMIUM');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        plan: 'PREMIUM',
        planSince: expect.any(Date),
        planSelfService: false,
      },
    });
  });
});

describe('PlanService — блокировка (ТЗ §25.3)', () => {
  it('незаблокированный проходит', async () => {
    const { svc } = build({ plan: 'LITE', isBlocked: false });
    await expect(svc.assertUserNotBlocked('u1')).resolves.toBeUndefined();
  });

  it('заблокированному платные вызовы запрещены, причина попадает в текст', async () => {
    const { svc } = build({
      plan: 'PREMIUM',
      isBlocked: true,
      blockedReason: 'подозрение на накрутку',
    });
    await expect(svc.assertUserNotBlocked('u1')).rejects.toThrow(
      /подозрение на накрутку/,
    );
  });

  it('без причины текст всё равно человеческий и не пустой', async () => {
    const { svc } = build({ plan: 'LITE', isBlocked: true });
    await expect(svc.assertUserNotBlocked('u1')).rejects.toThrow(
      /Платные операции приостановлены/,
    );
  });

  it('анонимный путь не блокируется и в базу не ходит', async () => {
    const { svc, prisma } = build();
    await expect(svc.assertUserNotBlocked(null)).resolves.toBeUndefined();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('блокировка не меняет режим — это разные оси', async () => {
    // Заблокированный Premium остаётся Premium: на Lite он переедет сам,
    // когда закончится оплаченный период (решение владельца продукта).
    const { svc } = build({ plan: 'PREMIUM', isBlocked: true });
    expect((await svc.accessOf('u1')).plan).toBe('PREMIUM');
  });

  it('блокировка у владельца СЕССИИ, а не у звонящего', async () => {
    const { svc, sessions, prisma } = build({ plan: 'LITE', isBlocked: true });
    sessions.getSession.mockResolvedValue({ sessionId: 's1', userId: 'u9' });
    await expect(svc.assertSessionNotBlocked('s1')).rejects.toThrow();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u9' },
      select: {
        plan: true,
        planSelfService: true,
        isBlocked: true,
        blockedReason: true,
        isTestUser: true,
        freeScenarios: true,
        freeOutsideProject: true,
        testAccessUntil: true,
        testDailyLimitUsd: true,
      },
    });
  });
});

describe('PlanService — дневной лимит расхода (ТЗ §26.4)', () => {
  const spent = (over: Partial<Record<string, unknown>> = {}) => ({
    allowed: false,
    limitMicroUsd: 2_000_000,
    spentMicroUsd: 2_100_000,
    remainingMicroUsd: 0,
    ...over,
  });

  it('в пределах лимита вызов проходит', async () => {
    const { svc } = build({ plan: 'LITE', isBlocked: false });
    await expect(svc.assertCanSpendUser('u1')).resolves.toBeUndefined();
  });

  it('исчерпанный лимит отказывает без упоминания долларов', async () => {
    const { svc, aiUsage } = build({ plan: 'LITE', isBlocked: false });
    aiUsage.budget.mockResolvedValue(spent());
    await expect(svc.assertCanSpendUser('u1')).rejects.toThrow(
      /Дневной лимит генераций исчерпан/,
    );
    await expect(svc.assertCanSpendUser('u1')).rejects.not.toThrow(/\$/);
  });

  it('Е-1.2 шестого аудита: исчерпанный лимит — отдельный класс ошибки, отличимый от блокировки/плана', async () => {
    // Воркеры партии/A-B классифицируют отказ по имени класса — обычный
    // ForbiddenException был бы неотличим от "пользователь заблокирован",
    // хотя суточный лимит временный (сбрасывается завтра), а блокировка —
    // нет.
    const { svc, aiUsage } = build({ plan: 'LITE', isBlocked: false });
    aiUsage.budget.mockResolvedValue(spent());
    await expect(svc.assertCanSpendUser('u1')).rejects.toBeInstanceOf(
      DailySpendLimitExceededException,
    );
    await expect(svc.assertCanSpendUser('u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('анонимному предлагают войти — у вошедших лимит свой и больше', async () => {
    const { svc, aiUsage } = build();
    aiUsage.budget.mockResolvedValue(spent());
    await expect(svc.assertCanSpendUser(null)).rejects.toThrow(
      /Войдите через Telegram/,
    );
  });

  it('блокировка проверяется РАНЬШЕ лимита', async () => {
    // Блокировка — решение оператора и объясняет себя причиной; лимит
    // временный. Показать заблокированному «попробуйте завтра» значило бы
    // соврать ему о том, что произойдёт завтра.
    const { svc, aiUsage } = build({
      plan: 'LITE',
      isBlocked: true,
      blockedReason: 'накрутка',
    });
    aiUsage.budget.mockResolvedValue(spent());
    await expect(svc.assertCanSpendUser('u1')).rejects.toThrow(/накрутка/);
    expect(aiUsage.budget).not.toHaveBeenCalled();
  });

  it('интерфейсу отдаются признаки, а не суммы расхода', async () => {
    // «Сколько именно потрачено» — дело оператора; у пользователя вопрос
    // другой: «можно ли мне сейчас работать». Утечка сумм наружу сделала
    // бы из ответа API отчёт о деньгах сервиса.
    const { svc } = build({ plan: 'STANDARD', isBlocked: false });
    const state = await svc.stateOf('u1');
    expect(state.plan).toBe('STANDARD');
    expect(state.blocked).toEqual({ isBlocked: false, reason: null });
    expect(state.budget).toEqual({ exhausted: false, nearlyExhausted: false });
    expect(JSON.stringify(state)).not.toMatch(/MicroUsd|spent|remaining/);
  });

  it('о близком исчерпании лимита предупреждают ЗАРАНЕЕ', async () => {
    // Отказать на кнопке «сгенерировать» после разбора и промпта — значит
    // потратить время человека впустую: к этому моменту он уже прошёл
    // весь путь. Порог — последняя пятая часть лимита.
    const { svc, aiUsage } = build({ plan: 'LITE', isBlocked: false });
    aiUsage.budget.mockResolvedValue({
      allowed: true,
      limitMicroUsd: 2_000_000,
      spentMicroUsd: 1_700_000,
      remainingMicroUsd: 300_000, // 15 % — уже мало
    });
    expect((await svc.stateOf('u1')).budget).toEqual({
      exhausted: false,
      nearlyExhausted: true,
    });
  });

  it('исчерпанный лимит — это «исчерпан», а не «почти исчерпан»', async () => {
    // Два признака взаимоисключающи: показать оба сразу значило бы
    // предложить поторопиться там, где работать уже нельзя.
    const { svc, aiUsage } = build({ plan: 'LITE', isBlocked: false });
    aiUsage.budget.mockResolvedValue({
      allowed: false,
      limitMicroUsd: 2_000_000,
      spentMicroUsd: 2_100_000,
      remainingMicroUsd: 0,
    });
    expect((await svc.stateOf('u1')).budget).toEqual({
      exhausted: true,
      nearlyExhausted: false,
    });
  });

  it('состояние блокировки доходит до интерфейса с причиной', async () => {
    // Заблокированный должен понимать, ЧТО случилось, иначе он идёт в
    // поддержку с вопросом «почему кнопка не работает».
    const { svc } = build({
      plan: 'PREMIUM',
      isBlocked: true,
      blockedReason: 'накрутка',
    });
    expect((await svc.stateOf('u1')).blocked).toEqual({
      isBlocked: true,
      reason: 'накрутка',
    });
  });

  it('возможность на открытом маршруте спрашивается у владельца сессии', async () => {
    // §7.8: предъявитель — UUID сессии. Спроси мы «текущего
    // пользователя», Premium терял бы свои возможности на каждом
    // открытом маршруте, а аноним получал бы чужие.
    const { svc, sessions } = build({ plan: 'LITE' });
    sessions.getSession.mockResolvedValue({ sessionId: 's1', userId: 'u9' });
    await expect(svc.assertSession('s1', 'library')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const premium = build({ plan: 'PREMIUM' });
    premium.sessions.getSession.mockResolvedValue({
      sessionId: 's1',
      userId: 'u9',
    });
    await expect(
      premium.svc.assertSession('s1', 'library'),
    ).resolves.toBeUndefined();
  });

  it('лимит берётся по режиму владельца сессии', async () => {
    const { svc, sessions, aiUsage } = build({
      plan: 'PREMIUM',
      isBlocked: false,
    });
    sessions.getSession.mockResolvedValue({ sessionId: 's1', userId: 'u9' });
    await svc.assertCanSpendSession('s1');
    expect(aiUsage.budget).toHaveBeenCalledWith(
      'u9',
      'PREMIUM',
      expect.any(Date),
      // Четвёртый аргумент — потолок тестового доступа; у обычного
      // пользователя его нет, и потолок берётся по режиму.
      undefined,
    );
  });
});

describe('PlanService — самостоятельный выбор режима не поднимает потолок (этап 54, Б-3.8)', () => {
  const prev = process.env.PLANS_BILLING_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.PLANS_BILLING_ENABLED;
    else process.env.PLANS_BILLING_ENABLED = prev;
  });

  it('режим, выбранный самим пользователем: функции Premium, деньги — по Lite', async () => {
    delete process.env.PLANS_BILLING_ENABLED;
    const { svc, aiUsage } = build({
      plan: 'PREMIUM',
      planSelfService: true,
      isBlocked: false,
    });
    const access = await svc.accessOf('u1');
    expect(access.plan).toBe('PREMIUM');
    expect(access.spendPlan).toBe('LITE');
    await svc.assertCanSpendUser('u1');
    expect(aiUsage.budget).toHaveBeenCalledWith(
      'u1',
      'LITE',
      expect.any(Date),
      // Четвёртый аргумент — потолок тестового доступа; у обычного
      // пользователя его нет, и потолок берётся по режиму.
      undefined,
    );
  });

  it('режим, назначенный оператором, считается по своему потолку', async () => {
    delete process.env.PLANS_BILLING_ENABLED;
    const { svc, aiUsage } = build({
      plan: 'PREMIUM',
      planSelfService: false,
      isBlocked: false,
    });
    await svc.assertCanSpendUser('u1');
    expect(aiUsage.budget).toHaveBeenCalledWith(
      'u1',
      'PREMIUM',
      expect.any(Date),
      // Четвёртый аргумент — потолок тестового доступа; у обычного
      // пользователя его нет, и потолок берётся по режиму.
      undefined,
    );
  });

  it('с включённой оплатой флаг ничего не значит — оплаченный режим по своему потолку', async () => {
    process.env.PLANS_BILLING_ENABLED = 'true';
    const { svc } = build({
      plan: 'STANDARD',
      planSelfService: true,
      isBlocked: false,
    });
    expect((await svc.accessOf('u1')).spendPlan).toBe('STANDARD');
  });

  it('setPlan помечает выбор как самостоятельный', async () => {
    delete process.env.PLANS_BILLING_ENABLED;
    const { svc, prisma } = build();
    await svc.setPlan('u1', 'PREMIUM');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          plan: 'PREMIUM',
          planSelfService: true,
        }),
      }),
    );
  });
});

describe('PlanService — тестовые пользователи (TODO §III п.37)', () => {
  /**
   * Потолок теперь ДРУГОЙ, а не снятый (TODO §III п.37, пункт
   * «Лимиты»), поэтому двойник считает по тому потолку, который ему
   * передали: иначе тест «бесплатно» проходил бы и на безлимите, и на
   * потолке, то есть не проверял бы ничего.
   */
  const budgetFor = (spentMicroUsd: number) =>
    jest.fn(
      async (
        _userId: unknown,
        _plan: unknown,
        _now?: unknown,
        override?: number,
      ) => {
        const limitMicroUsd = override ?? 2_000_000;
        return {
          allowed: spentMicroUsd < limitMicroUsd,
          limitMicroUsd,
          spentMicroUsd,
          remainingMicroUsd: Math.max(limitMicroUsd - spentMicroUsd, 0),
        };
      },
    );

  /** Тарифный потолок выбран, тестовый ($20) — нет. */
  const OVER_PLAN_LIMIT = 2_100_000;

  const testUser = (
    freeScenarios: string[],
    over: Record<string, unknown> = {},
  ) => ({
    plan: 'LITE',
    isBlocked: false,
    isTestUser: true,
    freeScenarios,
    freeOutsideProject: false,
    testAccessUntil: null,
    testDailyLimitUsd: null,
    ...over,
  });

  it('отмеченный сценарий поднимает потолок до тестового', async () => {
    const { svc, aiUsage, prisma } = build(testUser(['PRODUCT_VIDEO']));
    aiUsage.budget.mockImplementation(budgetFor(OVER_PLAN_LIMIT));
    await expect(
      svc.assertCanSpendUser('u1', { projectId: 'p1' }),
    ).resolves.toBeUndefined();
    expect(prisma.project.findUnique).toHaveBeenCalledWith({
      where: { id: 'p1' },
      select: { type: true },
    });
  });

  it('линейка идёт по тому же чекбоксу, что и одиночный товар', async () => {
    // Решение владельца продукта: типы 1 и 2 — один сценарий.
    const { svc, aiUsage, prisma } = build(testUser(['PRODUCT_VIDEO']));
    aiUsage.budget.mockImplementation(budgetFor(OVER_PLAN_LIMIT));
    prisma.project.findUnique.mockResolvedValue({ type: 'LINE' });
    await expect(
      svc.assertCanSpendUser('u1', { projectId: 'p1' }),
    ).resolves.toBeUndefined();
  });

  it('неотмеченный сценарий остаётся под потолком', async () => {
    const { svc, aiUsage, prisma } = build(testUser(['GREETING_VIDEO']));
    aiUsage.budget.mockImplementation(budgetFor(OVER_PLAN_LIMIT));
    prisma.project.findUnique.mockResolvedValue({ type: 'SINGLE' });
    await expect(
      svc.assertCanSpendUser('u1', { projectId: 'p1' }),
    ).rejects.toBeInstanceOf(DailySpendLimitExceededException);
  });

  it('блокировка сильнее тестового доступа', async () => {
    // Иначе заблокировать тестировщика было бы нечем: галочка сценария
    // отменяла бы решение оператора.
    const { svc } = build({
      ...testUser(['PRODUCT_VIDEO']),
      isBlocked: true,
      blockedReason: 'накрутка',
    });
    await expect(
      svc.assertCanSpendUser('u1', { projectId: 'p1' }),
    ).rejects.toThrow(/накрутка/);
  });

  it('галочки без флага тестового пользователя не действуют', async () => {
    const { svc, aiUsage } = build({
      plan: 'LITE',
      isBlocked: false,
      isTestUser: false,
      freeScenarios: ['PRODUCT_VIDEO'],
    });
    aiUsage.budget.mockImplementation(budgetFor(OVER_PLAN_LIMIT));
    await expect(
      svc.assertCanSpendUser('u1', { projectId: 'p1' }),
    ).rejects.toBeInstanceOf(DailySpendLimitExceededException);
  });

  it('тип проекта не читается у обычных пользователей', async () => {
    // Через эту проверку проходит каждый платный вызов продукта; лишняя
    // поездка в базу ради единиц тестовых аккаунтов — плохой обмен.
    const { svc, prisma } = build({ plan: 'LITE', isBlocked: false });
    await svc.assertCanSpendUser('u1', { projectId: 'p1' });
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
  });

  it('операция вне проекта — по своей галочке, а не по трём другим', async () => {
    // Этап 159 (§4.1 ТЗ на работу с тестировщиком): «все три» было
    // неявным условием и стало явным выбором оператора.
    const { svc, aiUsage } = build(testUser(['PRODUCT_VIDEO']));
    aiUsage.budget.mockImplementation(budgetFor(OVER_PLAN_LIMIT));
    await expect(svc.assertCanSpendUser('u1')).rejects.toBeInstanceOf(
      DailySpendLimitExceededException,
    );

    const all = build(
      testUser(['PRODUCT_VIDEO', 'CLIENT_SITE', 'GREETING_VIDEO']),
    );
    all.aiUsage.budget.mockImplementation(budgetFor(OVER_PLAN_LIMIT));
    await expect(all.svc.assertCanSpendUser('u1')).rejects.toBeInstanceOf(
      DailySpendLimitExceededException,
    );

    const own = build(testUser([], { freeOutsideProject: true }));
    own.aiUsage.budget.mockImplementation(budgetFor(OVER_PLAN_LIMIT));
    await expect(own.svc.assertCanSpendUser('u1')).resolves.toBeUndefined();
  });

  it('истёкший срок гасит доступ, не доходя до типа проекта', async () => {
    // Истёкший доступ — это обычный пользователь, и лишняя поездка в
    // базу ради него не нужна (§4.2).
    const { svc, aiUsage, prisma } = build(
      testUser(['PRODUCT_VIDEO'], {
        testAccessUntil: new Date(Date.now() - 1000),
      }),
    );
    aiUsage.budget.mockImplementation(budgetFor(OVER_PLAN_LIMIT));
    await expect(
      svc.assertCanSpendUser('u1', { projectId: 'p1' }),
    ).rejects.toBeInstanceOf(DailySpendLimitExceededException);
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
  });

  it('свой потолок приглашения сильнее общего', async () => {
    // Общий `DAILY_SPEND_LIMIT_USD_TEST_USER` — потолок НА КАЖДОГО:
    // трое тестировщиков это втрое больше денег в сутки (§4.3).
    const { svc, aiUsage } = build(
      testUser(['PRODUCT_VIDEO'], { testDailyLimitUsd: 5 }),
    );
    aiUsage.budget.mockResolvedValue({
      allowed: true,
      limitMicroUsd: 0,
      spentMicroUsd: 0,
      remainingMicroUsd: 0,
    });
    await svc.assertCanSpendUser('u1', { projectId: 'p1' });
    expect(aiUsage.budget.mock.calls[0][3]).toBe(5_000_000);
  });

  it('потолок в ноль означает ноль, а не «как у всех»', async () => {
    // Тестировщику можно временно закрыть трату, не снимая флага и не
    // теряя его галочек.
    const { svc, aiUsage } = build(
      testUser(['PRODUCT_VIDEO'], { testDailyLimitUsd: 0 }),
    );
    aiUsage.budget.mockResolvedValue({
      allowed: true,
      limitMicroUsd: 0,
      spentMicroUsd: 0,
      remainingMicroUsd: 0,
    });
    await svc.assertCanSpendUser('u1', { projectId: 'p1' });
    expect(aiUsage.budget.mock.calls[0][3]).toBe(0);
  });

  it('проект неизвестного типа не бесплатен даже с галочкой «вне проекта»', async () => {
    // Аудит этапа 159: «забыть добавить новый тип в
    // `scenarioOfProjectType` безопасно» — свойство, записанное там же.
    const { svc, aiUsage, prisma } = build(
      testUser(['PRODUCT_VIDEO', 'CLIENT_SITE', 'GREETING_VIDEO'], {
        freeOutsideProject: true,
      }),
    );
    aiUsage.budget.mockImplementation(budgetFor(OVER_PLAN_LIMIT));
    prisma.project.findUnique.mockResolvedValue({ type: 'ЧТО-ТО НОВОЕ' });
    await expect(
      svc.assertCanSpendUser('u1', { projectId: 'p1' }),
    ).rejects.toBeInstanceOf(DailySpendLimitExceededException);
  });

  it('сценарий берётся у проекта СЕССИИ на открытых маршрутах', async () => {
    const { svc, aiUsage, sessions, prisma } = build(
      testUser(['GREETING_VIDEO']),
    );
    aiUsage.budget.mockImplementation(budgetFor(OVER_PLAN_LIMIT));
    sessions.getSession.mockResolvedValue({
      sessionId: 's1',
      userId: 'u1',
      projectId: 'p7',
    });
    prisma.project.findUnique.mockResolvedValue({ type: 'GREETING_VIDEO' });
    await expect(svc.assertCanSpendSession('s1')).resolves.toBeUndefined();
    expect(prisma.project.findUnique).toHaveBeenCalledWith({
      where: { id: 'p7' },
      select: { type: true },
    });
  });

  it('новый тип проекта не становится бесплатным сам собой', async () => {
    // `scenarioOfProjectType` отвечает null на незнакомое значение, и
    // дальше действует строгое правило «только при всех галочках».
    const { svc, aiUsage, prisma } = build(testUser(['PRODUCT_VIDEO']));
    aiUsage.budget.mockImplementation(budgetFor(OVER_PLAN_LIMIT));
    prisma.project.findUnique.mockResolvedValue({ type: 'SOMETHING_NEW' });
    await expect(
      svc.assertCanSpendUser('u1', { projectId: 'p1' }),
    ).rejects.toBeInstanceOf(DailySpendLimitExceededException);
  });

  it('тестовый доступ не безлимит — свой потолок у него тоже есть', async () => {
    // TODO §III п.37, пункт «Лимиты»: провайдеру мы платим в любом
    // случае, и аккаунт, которому специально разрешили не считать
    // деньги, — последнее место, где стоит убирать край.
    const { svc, aiUsage } = build(testUser(['PRODUCT_VIDEO']));
    aiUsage.budget.mockImplementation(budgetFor(21_000_000));
    await expect(
      svc.assertCanSpendUser('u1', { projectId: 'p1' }),
    ).rejects.toThrow(/тестового доступа/);
  });

  it('отказ тестовому не выдаётся за обычный дневной лимит', async () => {
    // Общая фраза «дневной лимит генераций исчерпан» у тестировщика
    // читается как «бесплатный доступ сломался», и чинить он пойдёт не
    // то.
    const { svc, aiUsage } = build(testUser(['PRODUCT_VIDEO']));
    aiUsage.budget.mockImplementation(budgetFor(21_000_000));
    await expect(
      svc.assertCanSpendUser('u1', { projectId: 'p1' }),
    ).rejects.not.toThrow(/Дневной лимит генераций/);
  });

  it('интерфейс узнаёт о тестовом доступе и о том, что именно открыто', async () => {
    // Молчаливая отметка — половина фичи: тестировщик не отличит
    // бесплатный проход от сломанного биллинга.
    const { svc } = build(testUser(['GREETING_VIDEO', 'CLIENT_SITE']));
    const state = await svc.stateOf('u1');
    expect(state.testAccess.isTestUser).toBe(true);
    expect(state.testAccess.freeScenarios).toEqual([
      'CLIENT_SITE',
      'GREETING_VIDEO',
    ]);
  });

  it('галочки без флага наружу не уходят', async () => {
    // Иначе на экране появится обещание, которого нет в проверке.
    const { svc } = build({
      plan: 'LITE',
      isBlocked: false,
      isTestUser: false,
      freeScenarios: ['GREETING_VIDEO'],
    });
    const state = await svc.stateOf('u1');
    expect(state.testAccess).toEqual({ isTestUser: false, freeScenarios: [] });
  });

  it('у анонимного тестового доступа нет и быть не может', async () => {
    const { svc } = build(null);
    expect((await svc.stateOf(null)).testAccess).toEqual({
      isTestUser: false,
      freeScenarios: [],
    });
  });

  it('истёкший доступ не показывается интерфейсу как действующий', async () => {
    // Аудит этапа 159: иначе человек, у которого доступ вчера кончился,
    // читает «тестовый доступ, бесплатно: товарка», пока проверка
    // отвечает отказом. Предупреждение об этом стояло в комментарии
    // рядом с самим полем — и было нарушено им же.
    const { svc } = build(
      testUser(['PRODUCT_VIDEO'], {
        testAccessUntil: new Date(Date.now() - 1000),
      }),
    );
    const state = await svc.stateOf('u1');
    expect(state.testAccess.isTestUser).toBe(false);
    expect(state.testAccess.freeScenarios).toEqual([]);
  });

  it('действующий доступ показывается как есть', async () => {
    const { svc } = build(
      testUser(['PRODUCT_VIDEO'], {
        testAccessUntil: new Date(Date.now() + 60_000),
      }),
    );
    const state = await svc.stateOf('u1');
    expect(state.testAccess.isTestUser).toBe(true);
    expect(state.testAccess.freeScenarios).toEqual(['PRODUCT_VIDEO']);
  });

  it('интерфейс показывает тестовый потолок, а не тарифный', async () => {
    // Ответ общий на весь интерфейс, проекта в нём нет — значит и
    // вопрос к нему тот же, что у операции вне проекта: снят ли общий
    // потолок. С этапа 159 на это отвечает своя галочка, а не вывод из
    // трёх сценарных (§4.1). С одной сценарной предупреждение
    // остаётся, и это правда: на остальных сценариях потолок действует.
    const all = build(
      testUser(['PRODUCT_VIDEO'], { freeOutsideProject: true }),
    );
    all.aiUsage.budget.mockImplementation(budgetFor(OVER_PLAN_LIMIT));
    expect((await all.svc.stateOf('u1')).budget).toEqual({
      exhausted: false,
      nearlyExhausted: false,
    });

    const one = build(testUser(['PRODUCT_VIDEO']));
    one.aiUsage.budget.mockImplementation(budgetFor(OVER_PLAN_LIMIT));
    expect((await one.svc.stateOf('u1')).budget.exhausted).toBe(true);
  });
});

/**
 * Этап 144 (аудит): режим и суточный потолок для внешнего API.
 */
describe('PlanService.budgetOf', () => {
  it('отдаёт режим и три числа потолка', async () => {
    const { svc } = build({ plan: 'PREMIUM' });
    await expect(svc.budgetOf('u1')).resolves.toEqual({
      plan: 'PREMIUM',
      limitMicroUsd: 2_000_000,
      spentMicroUsd: 0,
      remainingMicroUsd: 2_000_000,
    });
  });

  it('считает потолок по режиму РАСХОДА, а не по выбранному', async () => {
    // Самостоятельно выбранный режим даёт функции, но потолок остаётся
    // тарифным (§23, plan.service.ts:207) — иначе переключатель режима
    // был бы переключателем чужого бюджета.
    const { svc, aiUsage } = build({
      plan: 'PREMIUM',
      planSelfService: true,
    });
    await svc.budgetOf('u1');
    const [, spendPlan] = aiUsage.budget.mock.calls[0] as [string, string];
    expect(spendPlan).toBe('LITE');
  });

  it('тестовый потолок — когда снят общий, вне проекта', async () => {
    // Тот же строгий приём, что в `stateOf`: тестировщик со сценарной
    // галочкой видит свой тарифный потолок, и это правда — вне проекта
    // действует он. С этапа 159 общий потолок снимает своя галочка.
    const partial = build({
      plan: 'LITE',
      isBlocked: false,
      isTestUser: true,
      freeScenarios: ['PRODUCT_VIDEO'],
      freeOutsideProject: false,
      testAccessUntil: null,
      testDailyLimitUsd: null,
    });
    await partial.svc.budgetOf('u1');
    expect(partial.aiUsage.budget.mock.calls[0][3]).toBeUndefined();

    const all = build({
      plan: 'LITE',
      isBlocked: false,
      isTestUser: true,
      freeScenarios: ['PRODUCT_VIDEO'],
      freeOutsideProject: true,
      testAccessUntil: null,
      testDailyLimitUsd: null,
    });
    await all.svc.budgetOf('u1');
    expect(all.aiUsage.budget.mock.calls[0][3]).toBeGreaterThan(0);
  });

  it('не тащит подписку и кредиты — это не экран', async () => {
    // `stateOf` собран для интерфейса: тарифы с текстами, подписка,
    // кредиты. Внешнему API нужны два числа, и платить за остальное
    // запросами в базу на каждом healthcheck незачем.
    const { svc, prisma, creditLedger } = build({ plan: 'PREMIUM' });
    await svc.budgetOf('u1');
    expect(prisma.subscription.findUnique).not.toHaveBeenCalled();
    expect(creditLedger.balanceOf).not.toHaveBeenCalled();
  });
});
