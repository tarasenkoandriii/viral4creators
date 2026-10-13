/**
 * [AT-CORE-13] Валюта и полная цена (P-C, проектный документ §6.4, §7.2;
 * ТЗ §17): цена без комиссий не окончательная (`PUB_PRICE_INCOMPLETE`);
 * иная валюта без курса, источника и времени — `PUB_FX_REQUIRED`; с ними —
 * итоговая сумма в валюте лимита (пересчёт целочисленный, вверх), исходная
 * цена и курс сохраняются рядом; закупка «в долларах» мимо лимита в гривне
 * не записывается.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  apiAs,
  distStack,
  seedTd08,
  type DistStack,
  type Td08,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(120_000);

ciDescribe('[AT-CORE-13] валюта и полная цена', () => {
  let s: DistStack;
  let w: Td08;
  beforeAll(async () => {
    s = await distStack();
    w = await seedTd08(s.prisma, s.budget);
  });
  afterAll(async () => {
    await s.close();
  });

  const body = (over: Record<string, unknown>) => ({
    venueId: w.venueId,
    versionId: w.versionId,
    priceSource: 'Лист від майданчика',
    terms: 'Публікація 5 днів',
    ...over,
  });

  it('цена без комиссий — PUB_PRICE_INCOMPLETE; без источника цены — тоже', async () => {
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    const noFees = await op.post(
      `${P}/placements`,
      body({ price: { currency: 'UAH', baseMinor: '100000' } }),
    );
    expect(noFees.status).toBe(400);
    expect(noFees.body.error).toMatchObject({
      code: 'PUB_PRICE_INCOMPLETE',
      details: { missing: ['feesMinor'] },
    });
    const noSource = await op.post(
      `${P}/placements`,
      body({
        price: { currency: 'UAH', baseMinor: '100000', feesMinor: '0' },
        priceSource: undefined,
      }),
    );
    expect(noSource.body.error.code).toBe('PUB_PRICE_INCOMPLETE');
    expect(
      await s.prisma.pubPlacement.count({ where: { productId: w.product.id } }),
    ).toBe(0);
  });

  it('цена в USD без курса/источника/времени — PUB_FX_REQUIRED; с ними — итог в UAH, исходная цена и курс сохранены', async () => {
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    const noFx = await op.post(
      `${P}/placements`,
      body({ price: { currency: 'USD', baseMinor: '3000', feesMinor: '500' } }),
    );
    expect(noFx.status).toBe(400);
    expect(noFx.body.error).toMatchObject({
      code: 'PUB_FX_REQUIRED',
      details: { currency: 'USD', limitCurrency: 'UAH' },
    });
    const partial = await op.post(
      `${P}/placements`,
      body({
        price: { currency: 'USD', baseMinor: '3000', feesMinor: '500' },
        fx: { rate: '41.5' },
      }),
    );
    expect(partial.status).toBe(400);
    const at = '2026-10-13T09:00:00.000Z';
    const ok = await op.post(
      `${P}/placements`,
      body({
        price: { currency: 'USD', baseMinor: '3000', feesMinor: '500' },
        fx: { rate: '41.5', source: 'НБУ, офіційний курс', at },
      }),
    );
    expect(ok.status).toBe(201);
    // 30 USD × 41.5 = 1 245 грн; 5 USD × 41.5 = 207.50 грн → 1 452.50 грн.
    expect(ok.body.data).toMatchObject({
      currency: 'UAH',
      basePriceMinor: '124500',
      feesMinor: '20750',
      totalPriceMinor: '145250',
      orig: {
        currency: 'USD',
        amountMinor: '3500',
        fxRate: '41.5',
        fxSource: 'НБУ, офіційний курс',
        fxAt: at,
      },
    });
  });

  it('пересчёт округляется вверх (лимит не меньше фактической цены)', async () => {
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    const tools = await op.post(`${P}/expenses`, {
      category: 'tools',
      description: 'Підписка на сервіс аналітики',
      amount: { currency: 'EUR', minor: '1001' },
      fx: {
        rate: '45.12345678',
        source: 'НБУ',
        at: '2026-10-13T09:00:00.000Z',
      },
    });
    // Гейт spend открыт (бюджетные параметры утверждены, лимит собран).
    expect(tools.status).toBe(201);
    // 10.01 EUR × 45.12345678 = 451.6857… грн → 451.69 грн (вверх).
    expect(tools.body.data).toMatchObject({
      currency: 'UAH',
      amountTotalMinor: '45169',
      orig: { currency: 'EUR', amountMinor: '1001', fxRate: '45.12345678' },
    });
    const noFx = await op.post(`${P}/expenses`, {
      category: 'tools',
      description: 'Ще один сервіс',
      amount: { currency: 'EUR', minor: '1000' },
    });
    expect(noFx.body.error.code).toBe('PUB_FX_REQUIRED');
  });
});
