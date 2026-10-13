/**
 * AI Publisher — приёмка P-E: неполная аналитика (AT-CORE-12, часть P-E;
 * закупка при неполном измерении — гейт `purchases` P-A1/P-C). Статусы
 * интеграций connected/degraded/disconnected с последней успешной
 * синхронизацией; устаревание; отчёт показывает `lastSyncedAt` и неполный
 * период, не подставляя нули.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { PubPorts } from '../../modules/publisher/core/ports';
import { asMember } from '../../modules/publisher/core/testing/core-stack.testing';
import { IntegrationsStalenessJob } from '../../modules/publisher/reports/integrations.service';
import { ReportsService } from '../../modules/publisher/reports/reports.service';
import {
  reportsStack,
  type ReportsStack,
} from '../../modules/publisher/reports/testing/reports-stack.testing';
import {
  seedMembers,
  seedTwoAccounts,
  type SeededMembers,
  type TwoAccounts,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(90_000);
const HOUR = 3_600_000;

ciDescribe(
  '[AT-CORE-12] Неполная аналитика: статус и свежесть интеграций закрывают закупку; отчёт без нулей',
  () => {
    let s: ReportsStack;
    let w: TwoAccounts;
    let team: SeededMembers;
    const srv = () => s.app!.getHttpServer();
    const as = (k: keyof SeededMembers) =>
      asMember(team[k].telegramId, w.a.accountId);
    const pid = () => w.a.product!.id;
    const put = (
      kind: string,
      b: Record<string, unknown>,
      who: keyof SeededMembers = 'analyst',
    ) =>
      request(srv())
        .put(`/publisher/products/${pid()}/integrations/${kind}`)
        .set(as(who))
        .send({ opKey: randomUUID(), ...b });
    const missingIntegrations = async () => {
      const r = await s.db
        .forAccount(w.a.accountId)
        .$transaction((tx) =>
          s.mod
            .get(PubPorts)
            .gates()
            .evaluate(
              tx,
              { id: pid(), accountId: w.a.accountId },
              'purchases',
              new Date(),
            ),
        );
      return r.missing
        .filter((m) => m.kind === 'integration')
        .map((m) => `${m.key}:${m.detail}`)
        .sort();
    };

    beforeAll(async () => {
      s = await reportsStack({ http: true });
      w = await seedTwoAccounts(s.prisma, { withProducts: true });
      team = await seedMembers(s.prisma, w.a.product!, w.a.owner);
    });
    afterAll(async () => {
      await s?.close();
    });

    it('строки нет — экран видит disconnected (не «подключено»); гейт закупки — missing', async () => {
      const r = await request(srv())
        .get(`/publisher/products/${pid()}/integrations`)
        .set(as('analyst'));
      expect(r.status).toBe(200);
      expect(
        r.body.data.items.find(
          (x: { kind: string }) => x.kind === 'web_analytics',
        ),
      ).toMatchObject({
        exists: false,
        status: 'disconnected',
        lastSuccessAt: null,
      });
      expect(await missingIntegrations()).toEqual([
        'events_collector:missing',
        'web_analytics:missing',
      ]);
      // Viewer и sales статус не ставят.
      expect(
        (await put('web_analytics', { status: 'connected' }, 'viewer')).status,
      ).toBe(403);
    });

    it('connected обеих интеграций измерения открывает этот пункт гейта; degraded/disconnected закрывают его', async () => {
      const a = await put('events_collector', {
        status: 'connected',
        staleAfterHours: 48,
      });
      const b = await put('web_analytics', {
        status: 'connected',
        staleAfterHours: 48,
      });
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(b.body.data).toMatchObject({
        exists: true,
        status: 'connected',
        manual: true,
        stale: false,
        revision: 1,
      });
      expect(b.body.data.lastSuccessAt).not.toBeNull();
      expect(await missingIntegrations()).toEqual([]);
      const deg = await put('web_analytics', {
        status: 'degraded',
        expectedRevision: 1,
        note: 'Затримка вивантаження',
      });
      expect(deg.status).toBe(200);
      expect(await missingIntegrations()).toEqual(['web_analytics:degraded']);
      // Без expectedRevision — 400; устаревшая — 409.
      expect((await put('web_analytics', { status: 'connected' })).status).toBe(
        400,
      );
      const stale = await put('web_analytics', {
        status: 'connected',
        expectedRevision: 1,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatchObject({
        code: 'PUB_CONFLICT',
        details: { currentRevision: 2 },
      });
    });

    it('устаревание: connected с синхронизацией старше staleAfterHours — stale и закрытый гейт; крон переводит в degraded с аудитом', async () => {
      const old = new Date(Date.now() - 3 * HOUR).toISOString();
      const r = await put('web_analytics', {
        status: 'connected',
        expectedRevision: 2,
        lastSuccessAt: old,
        staleAfterHours: 1,
      });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        status: 'connected',
        stale: true,
        lastSuccessAt: old,
      });
      expect(await missingIntegrations()).toEqual(['web_analytics:stale']);
      const job = new IntegrationsStalenessJob(s.db, s.mod.get(PubPorts));
      const out = await job.run({
        now: new Date(),
        scope: { siteIds: [w.a.siteId] },
        deadline: new Date(Date.now() + 30_000),
      });
      expect(out.processed).toBe(1);
      const row = await s.prisma.pubIntegration.findFirstOrThrow({
        where: { productId: pid(), kind: 'web_analytics' },
      });
      expect(row.status).toBe('degraded');
      const audit = await s.prisma.pubAuditEvent.findFirst({
        where: {
          productId: pid(),
          objectId: row.id,
          actor: 'system:integrations-staleness',
          toStatus: 'degraded',
        },
      });
      expect(audit).not.toBeNull();
    });

    it('отчёт: lastSyncedAt каждого источника и неполный период; пропущенные сутки импорта — «неизвестно», не 0', async () => {
      const imp = await request(srv())
        .post(`/publisher/products/${pid()}/metric-imports`)
        .set(as('analyst'))
        .send({
          opKey: randomUUID(),
          source: 'web_analytics',
          periodStart: '2026-09-01T00:00:00.000Z',
          periodEnd: '2026-09-03T00:00:00.000Z',
          payload: {
            days: [
              { date: '2026-09-01', sessions: 4 },
              { date: '2026-09-03', sessions: 2 },
            ],
          },
          fileRef: 'ga-export-2026-09.csv',
        });
      expect(imp.status).toBe(201);
      expect(imp.body.data).toMatchObject({
        source: 'web_analytics',
        days: 2,
        granularity: 'kyiv_day',
      });
      const rep = await request(srv())
        .post(`/publisher/products/${pid()}/reports`)
        .set(as('analyst'))
        .send({
          opKey: randomUUID(),
          kind: 'ad_hoc',
          periodStart: '2026-08-31T21:00:00.000Z',
          periodEnd: '2026-09-03T21:00:00.000Z',
        });
      expect(rep.status).toBe(201);
      const data = rep.body.data;
      // 01–03.09 по Kyiv: 02.09 не импортированы → сессии неизвестны (null), показатель не рассчитан.
      expect(data.metrics.sessions).toMatchObject({
        mode: 'imported_aggregate',
        value: null,
        missingDays: ['2026-09-02'],
      });
      expect(data.metrics.qualifiedPer100Sessions.value).toMatchObject({
        kind: 'not_computable',
        reason: 'unknown_input',
      });
      expect(data.sources.completeness.state).toBe('unknown');
      expect(data.sources.completeness.missing).toEqual(
        expect.arrayContaining([
          'integration:web_analytics',
          'web_analytics_day:2026-09-02',
        ]),
      );
      const wa = data.sources.integrations.find(
        (x: { kind: string }) => x.kind === 'web_analytics',
      );
      expect(wa).toMatchObject({
        status: 'degraded',
        lastSyncedAt: expect.any(String),
      });
      expect(data.assumptions).toMatch(/Дані неповні/);
    });

    it('импорт: другая метрика — только под своим именем (не подменяет sessions); отрицательные/дробные — 400', async () => {
      const bad = await request(srv())
        .post(`/publisher/products/${pid()}/metric-imports`)
        .set(as('analyst'))
        .send({
          opKey: randomUUID(),
          source: 'web_analytics',
          periodStart: '2026-09-01T00:00:00.000Z',
          periodEnd: '2026-09-01T23:00:00.000Z',
          payload: {
            days: [
              { date: '2026-09-01', sessions: -1, extra: { sessions: 5 } },
            ],
          },
        });
      expect(bad.status).toBe(400);
      expect(bad.body.error.details.fields).toEqual(
        expect.arrayContaining([
          { field: 'payload.days.0.sessions', code: 'range' },
          { field: 'payload.days.0.extra.sessions', code: 'name' },
        ]),
      );
    });

    it('импорт по страницам: сессии суток — только строка итога дня (без page); сутки только из строк страниц — неизвестны, не сумма', async () => {
      const imp = await request(srv())
        .post(`/publisher/products/${pid()}/metric-imports`)
        .set(as('analyst'))
        .send({
          opKey: randomUUID(),
          source: 'web_analytics',
          periodStart: '2026-08-10T00:00:00.000Z',
          periodEnd: '2026-08-12T00:00:00.000Z',
          payload: {
            days: [
              // 10.08: итог дня 5 + три страницы (сессия видела 3 страницы).
              { date: '2026-08-10', sessions: 5 },
              { date: '2026-08-10', page: '/a', sessions: 3 },
              { date: '2026-08-10', page: '/b', sessions: 3 },
              { date: '2026-08-10', page: '/c', sessions: 2 },
              // 11.08: только страницы — итога нет.
              { date: '2026-08-11', page: '/a', sessions: 4 },
              { date: '2026-08-12', sessions: 7 },
            ],
          },
        });
      expect(imp.status).toBe(201);
      const inputs = await s.db.forAccount(w.a.accountId).$transaction((tx) =>
        s.mod.get(ReportsService).buildInputs(
          tx,
          {
            id: pid(),
            accountId: w.a.accountId,
          },
          {
            kind: 'ad_hoc',
            periodStart: new Date('2026-08-09T21:00:00.000Z'),
            periodEnd: new Date('2026-08-12T21:00:00.000Z'),
            snapshotAt: new Date(),
            experiment: null,
          },
        ),
      );
      const agg = new Map(inputs.aggregates.map((a) => [a.date, a.sessions]));
      // Не 5 + 3 + 3 + 2 = 13 и не 4 за 11.08.
      expect([
        agg.get('2026-08-10'),
        agg.get('2026-08-11'),
        agg.get('2026-08-12'),
      ]).toEqual([5, null, 7]);
    });

    it('свежесть: staleAfterHours > 168 — 400; импорт прошлого периода не делает источник свежим (lastSuccessAt = конец периода); сутки и конец периода в будущем — 400', async () => {
      const cap = await put('search_console', {
        status: 'connected',
        staleAfterHours: 169,
      });
      expect(cap.status).toBe(400);
      expect(cap.body.error.details.fields).toEqual([
        { field: 'staleAfterHours', code: 'range' },
      ]);
      expect(
        (
          await put('search_console', {
            status: 'connected',
            staleAfterHours: 168,
          })
        ).status,
      ).toBe(200);
      const periodEnd = '2026-07-31T21:00:00.000Z';
      const old = await request(srv())
        .post(`/publisher/products/${pid()}/metric-imports`)
        .set(as('analyst'))
        .send({
          opKey: randomUUID(),
          source: 'search_console',
          periodStart: '2026-07-01T00:00:00.000Z',
          periodEnd,
          payload: { days: [{ date: '2026-07-15', page: '/a', clicks: 1 }] },
        });
      expect(old.status).toBe(201);
      const row = await s.prisma.pubIntegration.findFirstOrThrow({
        where: { productId: pid(), kind: 'search_console' },
      });
      // Подтверждение человеком (connected) — сейчас; импорт июля его не «освежил».
      expect(row.lastSuccessAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect(row.lastSuccessAt!.toISOString()).not.toBe(periodEnd);
      const tomorrow = new Date(Date.now() + 36 * HOUR);
      const future = await request(srv())
        .post(`/publisher/products/${pid()}/metric-imports`)
        .set(as('analyst'))
        .send({
          opKey: randomUUID(),
          source: 'web_analytics',
          periodStart: new Date(Date.now() - 24 * HOUR).toISOString(),
          periodEnd: tomorrow.toISOString(),
          payload: {
            days: [{ date: tomorrow.toISOString().slice(0, 10), sessions: 1 }],
          },
        });
      expect(future.status).toBe(400);
      expect(future.body.error.details.fields).toEqual(
        expect.arrayContaining([{ field: 'periodEnd', code: 'future' }]),
      );
    });

    it('импорт без строки интеграции: lastSuccessAt — конец периода данных, а не момент загрузки', async () => {
      const w2 = await seedTwoAccounts(s.prisma, { withProducts: true });
      const t2 = await seedMembers(s.prisma, w2.a.product!, w2.a.owner);
      const periodEnd = '2026-07-31T21:00:00.000Z';
      const r = await request(srv())
        .post(`/publisher/products/${w2.a.product!.id}/metric-imports`)
        .set(asMember(t2.analyst.telegramId, w2.a.accountId))
        .send({
          opKey: randomUUID(),
          source: 'web_analytics',
          periodStart: '2026-07-01T00:00:00.000Z',
          periodEnd,
          payload: { days: [{ date: '2026-07-15', sessions: 3 }] },
        });
      expect(r.status).toBe(201);
      const row = await s.prisma.pubIntegration.findFirstOrThrow({
        where: { productId: w2.a.product!.id, kind: 'web_analytics' },
      });
      expect(row.status).toBe('degraded');
      expect(row.lastSuccessAt!.toISOString()).toBe(periodEnd);
    });
  },
);
