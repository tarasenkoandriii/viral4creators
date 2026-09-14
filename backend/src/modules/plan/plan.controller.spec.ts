/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { PlanController } from './plan.controller';
import { TelegramIdentityGuard } from '../telegram-auth/telegram-identity.guard';
import { PLAN_IDS, PLANS } from '../../common/plans';

function build(plan = 'LITE') {
  // Контроллер стал тонким: всё состояние собирает PlanService.stateOf,
  // потому что иначе анонимный путь пришлось бы не забыть отдельно.
  const state = (p: string) => ({
    plan: p,
    plans: PLANS,
    billingEnabled: process.env.PLANS_BILLING_ENABLED === 'true',
    blocked: { isBlocked: false, reason: null },
    budget: { exhausted: false, nearlyExhausted: false },
  });
  const service = {
    stateOf: jest.fn().mockImplementation(async () => state(plan)),
    setPlan: jest.fn().mockResolvedValue('PREMIUM'),
  };
  return { ctrl: new PlanController(service as any), service };
}

describe('PlanController (ТЗ §23)', () => {
  afterEach(() => delete process.env.PLANS_BILLING_ENABLED);

  it('GET без идентичности отдаёт Lite и полную матрицу', async () => {
    const { ctrl, service } = build('LITE');
    const view = await ctrl.get({} as any);

    expect(service.stateOf).toHaveBeenCalledWith(null, expect.any(String));
    expect(view.plan).toBe('LITE');
    // Интерфейс рисует замки из этой матрицы — она должна приходить
    // целиком, включая режимы, которых у пользователя нет.
    expect(Object.keys(view.plans).sort()).toEqual([...PLAN_IDS].sort());
    expect(view.billingEnabled).toBe(false);
  });

  it('GET у вошедшего отдаёт его режим', async () => {
    const { ctrl, service } = build('PREMIUM');
    const view = await ctrl.get({ telegramUserId: 'u1' } as any);
    expect(service.stateOf).toHaveBeenCalledWith('u1', expect.any(String));
    expect(view.plan).toBe('PREMIUM');
  });

  it('PATCH закрыт гвардом идентичности, GET — нет', () => {
    // Замок стоит на методе, а не на контроллере: анонимный интерфейс
    // обязан узнавать границы пакетов, но менять режим ему негде.
    const onClass = Reflect.getMetadata('__guards__', PlanController) ?? [];
    const onPatch =
      Reflect.getMetadata('__guards__', PlanController.prototype.set) ?? [];
    const onGet =
      Reflect.getMetadata('__guards__', PlanController.prototype.get) ?? [];

    expect(onClass).toHaveLength(0);
    expect(onGet).toHaveLength(0);
    expect(onPatch).toContain(TelegramIdentityGuard);
  });

  it('PATCH возвращает уже применённый режим', async () => {
    const { ctrl, service } = build('LITE');
    const view = await ctrl.set(
      { telegramUserId: 'u1' } as any,
      { plan: 'PREMIUM' } as any,
    );
    expect(service.setPlan).toHaveBeenCalledWith('u1', 'PREMIUM');
    // Ответ пересобирается через stateOf — чтобы вместе с новым режимом
    // приехали и блокировка, и остаток лимита.
    expect(service.stateOf).toHaveBeenCalledWith('u1', expect.any(String));
    expect(view.plan).toBe('LITE');
  });

  it('billingEnabled приходит из окружения', async () => {
    process.env.PLANS_BILLING_ENABLED = 'true';
    const { ctrl } = build();
    expect((await ctrl.get({} as any)).billingEnabled).toBe(true);
  });
});
