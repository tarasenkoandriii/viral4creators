/**
 * [AT-CORE-12] (часть P-C) Новая платная закупка останавливается при
 * неполном измерении — гейт `purchases` (проектный документ §10): интеграция
 * `degraded`/`disconnected` или устаревшая → `PUB_GATE_CLOSED` на
 * согласование и резерв; после восстановления — проходит.
 * Плюс условия предложения закупки (§7.2): гейт `spend` для инструментов
 * до D0, 7 дней наблюдения (тестовая публикация рабочего продукта их не
 * даёт), выбранные материалы `pilot`, последовательность закупок, отчёт с
 * решением для 3-й.
 */
import { randomBytes } from 'crypto';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  apiAs,
  approveParam,
  approvedPlacementDirect,
  distStack,
  seedArticle,
  seedTd08,
  seedTestPublication,
  type DistStack,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(120_000);

ciDescribe('[AT-CORE-12] закупка закрыта гейтом при неполном измерении', () => {
  let s: DistStack;
  beforeAll(async () => {
    s = await distStack();
  });
  afterAll(async () => {
    await s.close();
  });

  it('интеграция degraded → PUB_GATE_CLOSED на резерв; устаревшая connected — тоже; восстановление → резерв проходит', async () => {
    const w = await seedTd08(s.prisma, s.budget, { integrations: 'degraded' });
    const x = await approvedPlacementDirect(s.prisma, w, {
      seq: 1,
      totalUah: 1_000,
    });
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    const r1 = await op.post(`${P}/placements/${x.placementId}/reserve`, {
      expectedRevision: x.revision,
    });
    expect(r1.status).toBe(409);
    expect(r1.body.error).toMatchObject({
      code: 'PUB_GATE_CLOSED',
      details: { gate: 'purchases' },
    });
    expect(r1.body.error.details.missing).toEqual(
      expect.arrayContaining([
        { kind: 'integration', key: 'events_collector', detail: 'degraded' },
      ]),
    );
    // «connected», но последний успех старше staleAfterHours — тоже закрыто.
    await s.prisma.pubIntegration.updateMany({
      where: { productId: w.product.id },
      data: {
        status: 'connected',
        lastSuccessAt: new Date(Date.now() - 49 * 3_600_000),
      },
    });
    const r2 = await op.post(`${P}/placements/${x.placementId}/reserve`, {
      expectedRevision: x.revision,
    });
    expect(r2.body.error.details.missing).toEqual(
      expect.arrayContaining([
        { kind: 'integration', key: 'web_analytics', detail: 'stale' },
      ]),
    );
    expect(
      await s.prisma.pubExpense.count({ where: { productId: w.product.id } }),
    ).toBe(0);
    await s.prisma.pubIntegration.updateMany({
      where: { productId: w.product.id },
      data: { lastSuccessAt: new Date() },
    });
    const r3 = await op.post(`${P}/placements/${x.placementId}/reserve`, {
      expectedRevision: x.revision,
    });
    expect(r3.status).toBe(200);
  });

  it('оплата закупки при закрытом гейте purchases — 409; оплата инструментов — проходит (§10, аудит S3-1)', async () => {
    const w = await seedTd08(s.prisma, s.budget);
    const x = await approvedPlacementDirect(s.prisma, w, {
      seq: 1,
      totalUah: 1_000,
    });
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    const rs = await op.post(`${P}/placements/${x.placementId}/reserve`, {
      expectedRevision: x.revision,
    });
    expect(rs.status).toBe(200);
    const tools = await op.post(`${P}/expenses`, {
      category: 'tools',
      description: 'Хостинг',
      amount: { currency: 'UAH', minor: '30000' },
    });
    expect(tools.status).toBe(201);
    // Измерение деградировало — гейт закупок закрыт.
    await s.prisma.pubIntegration.updateMany({
      where: { productId: w.product.id },
      data: { status: 'degraded' },
    });
    const pay = await op.post(
      `${P}/expenses/${rs.body.data.expenseId}/entries`,
      {
        kind: 'pay',
        amountMinor: '100000',
        status: 'confirmed',
        externalRef: 'PAY-G',
      },
    );
    expect(pay.status).toBe(409);
    expect(pay.body.error).toMatchObject({
      code: 'PUB_GATE_CLOSED',
      details: { gate: 'purchases' },
    });
    const payTools = await op.post(
      `${P}/expenses/${tools.body.data.id}/entries`,
      {
        kind: 'pay',
        amountMinor: '30000',
        status: 'confirmed',
        externalRef: 'PAY-T',
      },
    );
    expect(payTools.status).toBe(201);
  });

  it('согласование закупки тоже закрыто гейтом (не только резерв)', async () => {
    const w = await seedTd08(s.prisma, s.budget, { integrations: 'none' });
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const po = apiAs(
      s.app!.getHttpServer(),
      w.acc.accountId,
      w.team.product_owner,
    );
    const P = `/publisher/products/${w.product.id}`;
    const pl = (
      await op.post(`${P}/placements`, {
        venueId: w.venueId,
        versionId: w.versionId,
        price: { currency: 'UAH', baseMinor: '50000', feesMinor: '0' },
        priceSource: 'Прайс',
        terms: 'Умови',
      })
    ).body.data;
    const ap = await po.post(`${P}/placements/${pl.id}/approve`, {
      maxAmountMinor: '50000',
      currency: 'UAH',
      versionHash: w.versionHash,
      priceSnapshotHash: pl.priceSnapshotHash,
      expectedRevision: pl.revision,
    });
    expect(ap.status).toBe(409);
    expect(ap.body.error.details.missing).toEqual(
      expect.arrayContaining([
        { kind: 'integration', key: 'events_collector', detail: 'missing' },
      ]),
    );
  });
});

ciDescribe('Гейт spend и условия предложения закупки (§7.2, §10)', () => {
  let s: DistStack;
  beforeAll(async () => {
    s = await distStack();
  });
  afterAll(async () => {
    await s.close();
  });

  it('расход tools до D0: без утверждённого бюджета — PUB_GATE_CLOSED spend; после — проходит при mode=closed', async () => {
    const w = await seedTd08(s.prisma, s.budget, {
      approve: false,
      integrations: 'none',
    });
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    const body = {
      category: 'tools',
      description: 'Домен і хостинг',
      amount: { currency: 'UAH', minor: '50000' },
    };
    const closed = await op.post(`${P}/expenses`, body);
    expect(closed.status).toBe(409);
    expect(closed.body.error.details).toMatchObject({ gate: 'spend' });
    expect(closed.body.error.details.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'parameter', key: 'budget_total' }),
      ]),
    );
    await approveParam(s.prisma, w.ref, 'budget_total');
    await approveParam(s.prisma, w.ref, 'budget_split');
    // Лимит собран из прежних версий — гейт видит «устарел» до пересборки.
    const stale = await op.post(`${P}/expenses`, body);
    expect(stale.body.error.details.missing).toEqual([
      { kind: 'budget', key: 'pub_budget_limits', detail: 'stale' },
    ]);
    await s.prisma.$transaction((tx) =>
      s.budget.build(tx as never, w.ref, 'system:test'),
    );
    const ok = await op.post(`${P}/expenses`, body);
    expect(ok.status).toBe(201);
    // Закупки при этом закрыты (другие ключи не утверждены).
    expect((await op.get(`${P}/gates`)).body.data.purchases.open).toBe(false);
  });

  it('рабочий продукт: тестовая публикация не даёт 7 дней наблюдения — PUB_OBSERVATION_PENDING', async () => {
    const w = await seedTd08(s.prisma, s.budget, {
      kind: 'working',
      mode: 'live',
    });
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    const body = {
      venueId: w.venueId,
      versionId: w.versionId,
      price: { currency: 'UAH', baseMinor: '50000', feesMinor: '0' },
      priceSource: 'Прайс',
      terms: 'Умови',
    };
    const r = await op.post(`${P}/placements`, body);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PUB_OBSERVATION_PENDING');
    // Первая live-публикация 6 дней назад — ещё рано; 8 дней — можно.
    s.content.overrides.set(w.versionId, {
      firstLivePublishedAt: new Date(Date.now() - 6 * 86_400_000),
    });
    expect((await op.post(`${P}/placements`, body)).body.error.code).toBe(
      'PUB_OBSERVATION_PENDING',
    );
    s.content.overrides.set(w.versionId, {
      firstLivePublishedAt: new Date(Date.now() - 8 * 86_400_000),
    });
    expect((await op.post(`${P}/placements`, body)).status).toBe(201);
  });

  it('материал вне эксперимента pilot — закрыто; критически устаревший — PUB_CONTENT_STALE', async () => {
    const w = await seedTd08(s.prisma, s.budget);
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    const other = await seedArticle(s.prisma, w.ref);
    await seedTestPublication(s.prisma, w.ref, {
      versionId: other.versionId,
      channelId: w.siteChannelId,
      slug: other.slug,
      daysAgo: 10,
    });
    const r = await op.post(`${P}/placements`, {
      venueId: w.venueId,
      versionId: other.versionId,
      price: { currency: 'UAH', baseMinor: '50000', feesMinor: '0' },
      priceSource: 'Прайс',
      terms: 'Умови',
    });
    expect(r.body.error).toMatchObject({ code: 'PUB_GATE_CLOSED' });
    expect(r.body.error.details.missing[0]).toMatchObject({
      key: 'pilot_experiment_contents',
    });
    s.content.overrides.set(w.versionId, { criticalStale: true });
    const stale = await op.post(`${P}/placements`, {
      venueId: w.venueId,
      versionId: w.versionId,
      price: { currency: 'UAH', baseMinor: '50000', feesMinor: '0' },
      priceSource: 'Прайс',
      terms: 'Умови',
    });
    expect(stale.body.error.code).toBe('PUB_CONTENT_STALE');
    s.content.overrides.delete(w.versionId);
  });

  it('вторая закупка кампании — только после публикации первой; площадка не verified — закрыто', async () => {
    const w = await seedTd08(s.prisma, s.budget);
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    const body = {
      venueId: w.venueId,
      versionId: w.versionId,
      price: { currency: 'UAH', baseMinor: '50000', feesMinor: '0' },
      priceSource: 'Прайс',
      terms: 'Умови',
    };
    const first = await op.post(`${P}/placements`, body);
    expect(first.status).toBe(201);
    const second = await op.post(`${P}/placements`, body);
    expect(second.status).toBe(409);
    expect(second.body.error.details.missing[0]).toMatchObject({
      key: 'previous_purchase',
      detail: 'proposed',
    });
    // Первая отклонена — следующая снова допустима.
    await op.post(`${P}/placements/${first.body.data.id}/reject`, {
      reason: 'Майданчик відмовив',
      expectedRevision: first.body.data.revision,
    });
    const venue2 = await s.prisma.pubVenue.create({
      data: {
        accountId: w.ref.accountId,
        productId: w.ref.id,
        name: 'Кандидат',
        url: 'https://candidate.example',
        formats: [],
        criteria: {},
        createdBy: 'system:test',
      },
    });
    const notVerified = await op.post(`${P}/placements`, {
      ...body,
      venueId: venue2.id,
    });
    expect(notVerified.body.error.details.missing[0]).toMatchObject({
      key: 'venue',
    });
    const again = await op.post(`${P}/placements`, body);
    expect(again.status).toBe(201);
    expect(again.body.data.purchaseSeq).toBe(2);
  });

  it('третья закупка кампании: без снимка отчёта с решением согласование закрыто', async () => {
    const w = await seedTd08(s.prisma, s.budget);
    const campaign = await s.prisma.pubCampaign.findFirst({
      where: { productId: w.product.id, code: 'pilot' },
    });
    // Две опубликованные закупки кампании (предыстория).
    for (const seq of [1, 2]) {
      const x = await approvedPlacementDirect(s.prisma, w, {
        seq,
        totalUah: 500,
      });
      await s.prisma.pubPlacement.update({
        where: { id: x.placementId },
        data: {
          status: 'published',
          externalOrderId: `ORD-${seq}-${randomBytes(2).toString('hex')}`,
          publishedAt: new Date(),
        },
      });
    }
    expect(campaign).toBeTruthy();
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const po = apiAs(
      s.app!.getHttpServer(),
      w.acc.accountId,
      w.team.product_owner,
    );
    const P = `/publisher/products/${w.product.id}`;
    const third = (
      await op.post(`${P}/placements`, {
        venueId: w.venueId,
        versionId: w.versionId,
        price: { currency: 'UAH', baseMinor: '50000', feesMinor: '0' },
        priceSource: 'Прайс',
        terms: 'Умови',
      })
    ).body.data;
    expect(third.purchaseSeq).toBe(3);
    const ap = await po.post(`${P}/placements/${third.id}/approve`, {
      maxAmountMinor: '50000',
      currency: 'UAH',
      versionHash: w.versionHash,
      priceSnapshotHash: third.priceSnapshotHash,
      expectedRevision: third.revision,
    });
    expect(ap.status).toBe(409);
    expect(ap.body.error.details.missing).toEqual([
      { kind: 'report_decision', key: 'reportDecisionId', detail: 'required' },
    ]);
  });
});
