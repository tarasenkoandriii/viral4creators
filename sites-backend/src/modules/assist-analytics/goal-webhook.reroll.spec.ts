/**
 * Возврат по вебхуку пересчитывает день ЗАКАЗА (§5-тер.16 п.4): кроны
 * трогают только последние 3 дня, без `rerollDay()` вычет не случился бы
 * никогда. Заход 12, аудит P2-1: из-за цикла импортов `rollup` в проде был
 * `undefined`, и `rerollDay()` сразу выходил. Подключение через DI проверяет
 * `app.module.spec` (rollup injected), сам вычет в свёртке — приёмка
 * `acceptance/e3/webhook.spec` (п.4, возврат через 10 дней). Здесь — что
 * вебхук зовёт свёртку нужного дня и не падает без неё.
 */
import type { PrismaService } from '../../prisma/prisma.service';
import { GoalWebhookService } from './goal-webhook.service';
import type { IntegrationsService } from './integrations.service';
import type { AnalyticsRollup } from './system/analytics-rollup.service';

type ApplyArgs = {
  timezone: string;
  accountId: string;
  siteId: string;
  goalId: string;
  source: 's2s' | 'crm';
  ev: {
    goalKey: string;
    orderId: string;
    value: number | null;
    currency: string | null;
    status: 'completed' | 'refunded' | 'cancelled';
    occurredAt: string;
    assistRef: string | null;
  };
  occurredAt: Date;
  value: number | null;
  currency: string | null;
  now: Date;
};

function harness(rollup?: Pick<AnalyticsRollup, 'rollupDay'>) {
  // Заказ 31.12 в 23:30 UTC — по Киеву уже 01.01: день берётся в поясе сайта.
  const placed = new Date('2026-12-31T23:30:00Z');
  const update = jest.fn().mockResolvedValue({ id: 'e1' });
  const prisma = {
    assistSiteGoalEvent: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'e1',
        trust: 'verified',
        status: 'completed',
        occurredAt: placed,
      }),
      update,
    },
  } as unknown as PrismaService;
  const svc = new GoalWebhookService(
    prisma,
    {} as IntegrationsService,
    rollup as AnalyticsRollup | undefined,
  );
  const apply = (status: ApplyArgs['ev']['status']) =>
    (svc as unknown as { apply(p: ApplyArgs): Promise<string> }).apply({
      timezone: 'Europe/Kyiv',
      accountId: 'acc',
      siteId: 'site-1',
      goalId: 'g1',
      source: 's2s',
      ev: {
        goalKey: 'purchase',
        orderId: 'R-77',
        value: null,
        currency: null,
        status,
        occurredAt: new Date().toISOString(),
        assistRef: null,
      },
      occurredAt: new Date(),
      value: null,
      currency: null,
      now: new Date(),
    });
  return { apply, update };
}

describe('GoalWebhookService: возврат пересчитывает день заказа (rerollDay)', () => {
  it('refunded по учтённому заказу — rollupDay(сайт, день заказа в поясе сайта)', async () => {
    const rollupDay = jest.fn().mockResolvedValue(undefined);
    const h = harness({ rollupDay });
    await expect(h.apply('refunded')).resolves.toBe('updated');
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'refunded' } }),
    );
    expect(rollupDay).toHaveBeenCalledTimes(1);
    expect(rollupDay).toHaveBeenCalledWith('site-1', '2027-01-01');
  });

  it('cancelled — тоже пересчёт дня заказа', async () => {
    const rollupDay = jest.fn().mockResolvedValue(undefined);
    const h = harness({ rollupDay });
    await expect(h.apply('cancelled')).resolves.toBe('updated');
    expect(rollupDay).toHaveBeenCalledTimes(1);
  });

  it('сбой свёртки — событие всё равно учтено (updated), ошибка только в лог', async () => {
    const rollupDay = jest.fn().mockRejectedValue(new Error('db down'));
    const h = harness({ rollupDay });
    await expect(h.apply('refunded')).resolves.toBe('updated');
    expect(rollupDay).toHaveBeenCalledTimes(1);
  });

  it('без свёртки (unit-сборка) — updated, без исключения', async () => {
    const h = harness(undefined);
    await expect(h.apply('refunded')).resolves.toBe('updated');
  });
});
