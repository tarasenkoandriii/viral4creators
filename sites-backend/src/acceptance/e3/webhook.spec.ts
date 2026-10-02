/**
 * Приёмка Э3 (A) — вебхук целей s2s (ТЗ §5-тер.16 п.4, п.5, п.18 частично):
 * по HTTP через настоящее приложение (сырое тело app.setup, конверт,
 * @PublicRoute под глобальным гвардом): неверная/старая/чужая подпись — 401
 * одинаково; нет Idempotency-Key — 400; повтор ключа — без дубля;
 * `refunded` вычитает сумму и конверсию в свёртке; URL «спасибо» + вебхук
 * одного заказа — одна конверсия `verified` (оба порядка прихода); цели
 * сайта A не принимаются для сайта B. Формат подписи — общие векторы
 * (webhook-signature.spec). Логи — без orderId, сумм и секретов.
 */
import { Global, INestApplication, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { GOAL_WEBHOOK_SIGNATURE_HEADER } from '../../brand';
import { loadConfiguration } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { GoalWebhookController } from '../../modules/assist-analytics/goal-webhook.controller';
import { GoalWebhookService } from '../../modules/assist-analytics/goal-webhook.service';
import { IntegrationsService } from '../../modules/assist-analytics/integrations.service';
import { addDays, dayInTz } from '../../modules/assist-analytics/site-time';
import { AnalyticsRollup } from '../../modules/assist-analytics/system/analytics-rollup.service';
import {
  AnalyticsStack,
  LogCapture,
} from '../../modules/assist-analytics/testing/analytics-stack.testing';
import { signGoalWebhook } from '../../modules/assist-analytics/webhook-signature';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import type { ChatSite } from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { TelegramAuthModule } from '../../modules/telegram-auth/telegram-auth.module';

jest.setTimeout(90_000);

@Global()
@Module({})
class A3Infra {
  static with(prisma: PrismaService): DynamicModule {
    return {
      module: A3Infra,
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: SitesDb, useValue: new SitesDb(prisma) },
      ],
      exports: [PrismaService, SitesDb],
    };
  }
}

describeDb(
  'Приёмка Э3 (A): вебхук целей s2s — §5-тер.16 п.4, п.5, п.18',
  () => {
    const st = new AnalyticsStack();
    const logs = new LogCapture();
    let app: INestApplication;
    const savedKey = process.env.ASSIST_SECRETS_KEY;

    beforeAll(async () => {
      logs.install();
      await st.init();
      process.env.ASSIST_SECRETS_KEY = st.chat.env.ASSIST_SECRETS_KEY;
      const mod = await Test.createTestingModule({
        imports: [A3Infra.with(st.owner), TelegramAuthModule],
        controllers: [GoalWebhookController],
        providers: [GoalWebhookService, IntegrationsService, AnalyticsRollup],
      }).compile();
      app = mod.createNestApplication();
      configureApp(app, loadConfiguration({}));
      await app.init();
    });
    afterAll(async () => {
      await app?.close();
      await st.close();
      if (savedKey === undefined) delete process.env.ASSIST_SECRETS_KEY;
      else process.env.ASSIST_SECRETS_KEY = savedKey;
      jest.restoreAllMocks();
    });

    async function shop(): Promise<{
      s: ChatSite;
      secret: string;
      goalId: string;
    }> {
      const s = await st.site();
      const m = await st.member(s);
      const goalId = await st.goal(s, {
        key: 'purchase',
        template: 'purchase',
        detectors: [
          {
            kind: 'url',
            config: { pathMask: '/checkout/success*', fromPathMask: null },
          },
          { kind: 's2s', config: {} },
        ],
        valueMode: 'event',
        currency: 'UAH',
      });
      const { secret } = await st.integrations.issue(
        m,
        s.siteId,
        'goal_webhook',
      );
      expect(secret).toMatch(/^whsec_/);
      return { s, secret, goalId };
    }

    function post(
      siteId: string,
      body: Record<string, unknown> | string,
      p: {
        secret?: string;
        t?: number;
        key?: string | null;
        header?: string;
      } = {},
    ) {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      const t = p.t ?? Math.floor(Date.now() / 1000);
      const req = request(app.getHttpServer())
        .post(`/assist/v1/sites/${siteId}/goal-events`)
        .set('Content-Type', 'application/json');
      const sig =
        p.header ?? (p.secret ? signGoalWebhook(p.secret, raw, t) : undefined);
      if (sig) req.set(GOAL_WEBHOOK_SIGNATURE_HEADER, sig);
      const key =
        p.key === undefined
          ? typeof body === 'string'
            ? undefined
            : body.orderId
          : p.key;
      if (typeof key === 'string') req.set('Idempotency-Key', key);
      return req.send(raw);
    }

    const order = (orderId: string, over: Record<string, unknown> = {}) => ({
      goalKey: 'purchase',
      orderId,
      value: 1299,
      currency: 'UAH',
      status: 'completed',
      occurredAt: new Date().toISOString(),
      ...over,
    });

    it('п.4: неверная / старая / отсутствующая / чужая подпись и неизвестный сайт — 401 одним ответом', async () => {
      const a = await shop();
      const b = await shop();
      const body = order('A-1');
      const rs = [
        await post(a.s.siteId, body, {}),
        await post(a.s.siteId, body, { header: 't=1,v1=zz' }),
        await post(a.s.siteId, body, {
          secret: a.secret,
          t: Math.floor(Date.now() / 1000) - 301,
        }),
        // п.18: подпись секретом сайта B — для сайта A не годится.
        await post(a.s.siteId, body, { secret: b.secret }),
        await post('no-such-site', body, { secret: a.secret }),
      ];
      for (const r of rs) {
        expect(r.status).toBe(401);
        expect(r.body).toMatchObject({
          success: false,
          error: { code: 'SIGNATURE_INVALID' },
        });
      }
      expect(new Set(rs.map((r) => JSON.stringify(r.body.error))).size).toBe(1);
      expect(
        await st.owner.assistSiteGoalEvent.count({
          where: { siteId: a.s.siteId },
        }),
      ).toBe(0);
    });

    it('п.4: Idempotency-Key обязателен и = orderId; тело — белый список; e-mail в orderId — 422', async () => {
      const { s, secret } = await shop();
      const r1 = await post(s.siteId, order('A-2'), { secret, key: null });
      expect([r1.status, r1.body.error?.code]).toEqual([
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
      ]);
      const r2 = await post(s.siteId, order('A-2'), { secret, key: 'A-3' });
      expect([r2.status, r2.body.error?.code]).toEqual([
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
      ]);
      const r3 = await post(s.siteId, order('A-2', { phone: '+380' }), {
        secret,
      });
      expect([r3.status, r3.body.error?.code]).toEqual([
        400,
        'WEBHOOK_BODY_INVALID',
      ]);
      const r4 = await post(s.siteId, order('A-2', { goalKey: 'nope' }), {
        secret,
      });
      expect([r4.status, r4.body.error?.code]).toEqual([
        400,
        'WEBHOOK_BODY_INVALID',
      ]);
      const r5 = await post(s.siteId, order('ivan@example.com'), { secret });
      expect([r5.status, r5.body.error?.code]).toEqual([
        422,
        'GOAL_ORDER_ID_INVALID',
      ]);
      const r6 = await post(s.siteId, '{"goalKey":', { secret, key: 'A-2' });
      expect([r6.status, r6.body.error?.code]).toEqual([
        400,
        'WEBHOOK_BODY_INVALID',
      ]);
      expect(
        await st.owner.assistSiteGoalEvent.count({
          where: { siteId: s.siteId },
        }),
      ).toBe(0);
    });

    it('п.4: повтор того же ключа — без дубля; refunded вычитает конверсию и сумму в свёртке', async () => {
      const { s, secret, goalId } = await shop();
      const ok = await post(s.siteId, order('A-1042'), { secret });
      expect([ok.status, ok.body.data]).toEqual([200, { result: 'created' }]);
      const again = await post(s.siteId, order('A-1042'), { secret });
      expect(again.body.data).toEqual({ result: 'duplicate' });
      const other = await post(s.siteId, order('A-1043', { value: 501 }), {
        secret,
      });
      expect(other.body.data).toEqual({ result: 'created' });
      expect(
        await st.owner.assistSiteGoalEvent.count({
          where: { siteId: s.siteId },
        }),
      ).toBe(2);
      const day = dayInTz(new Date(), 'Europe/Kyiv');
      const conv = async () => {
        await st.rollup.rollupDay(s.siteId, day);
        const row = await st.owner.assistSiteDailyTotal.findUniqueOrThrow({
          where: { siteId_day_group: { siteId: s.siteId, day, group: 'all' } },
        });
        return (row.conversions as Record<string, Record<string, unknown>>)[
          goalId
        ];
      };
      expect(await conv()).toMatchObject({
        unknown: 2,
        refunds: 0,
        value: { verified: 1800, page: 0 },
        currency: 'UAH',
      });
      const refund = await post(
        s.siteId,
        order('A-1042', { status: 'refunded', value: undefined }),
        {
          secret,
        },
      );
      expect(refund.body.data).toEqual({ result: 'updated' });
      const refundAgain = await post(
        s.siteId,
        order('A-1042', { status: 'refunded', value: undefined }),
        { secret },
      );
      expect(refundAgain.body.data).toEqual({ result: 'duplicate' });
      expect(await conv()).toMatchObject({
        unknown: 1,
        refunds: 1,
        value: { verified: 501, page: 0 },
      });
      // Повторная свёртка не удваивает (§5-тер.16 п.17).
      expect(await conv()).toMatchObject({ unknown: 1, refunds: 1 });
      expect(logs.text()).not.toMatch(/A-1042|A-1043|1299|whsec_/);
    });

    it('п.4: возврат через 10 дней после заказа вычитается из дня заказа (кроны тот день уже не пересчитывают)', async () => {
      const { s, secret, goalId } = await shop();
      const placed = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const day = dayInTz(placed, 'Europe/Kyiv');
      const ok = await post(
        s.siteId,
        order('R-77', { occurredAt: placed.toISOString() }),
        { secret },
      );
      expect(ok.body.data).toEqual({ result: 'created' });
      // Свёртка дня заказа — как её сделал крон в тот день.
      await st.rollup.rollupDay(s.siteId, day);
      const totals = async () =>
        (
          (
            await st.owner.assistSiteDailyTotal.findUniqueOrThrow({
              where: {
                siteId_day_group: { siteId: s.siteId, day, group: 'all' },
              },
            })
          ).conversions as Record<string, Record<string, unknown>>
        )[goalId];
      expect(await totals()).toMatchObject({ unknown: 1, refunds: 0 });
      const refund = await post(
        s.siteId,
        order('R-77', { status: 'refunded', value: undefined }),
        { secret },
      );
      expect(refund.body.data).toEqual({ result: 'updated' });
      // Без ручной свёртки: обычные кроны этот день уже не трогают.
      expect(day < addDays(dayInTz(new Date(), 'Europe/Kyiv'), -2)).toBe(true);
      expect(await totals()).toMatchObject({
        unknown: 0,
        refunds: 1,
        value: { verified: 0, page: 0 },
      });
    });

    it('п.5: URL «спасибо» (без orderId) + вебхук того же заказа — одна конверсия verified; атрибуция — со страницы', async () => {
      const { s, secret } = await shop();
      const conv = await st.conversation(s, {});
      const now = new Date();
      expect(
        await st.intake.fromIframe({
          site: s.ctx(),
          visitor: st.chat.visitor({ visitorId: conv.visitorId }),
          conversationId: conv.id,
          lastAssistClickAt: new Date(now.getTime() - 60_000),
          assist: { proactive: null, scenario: null, link: true },
          hit: {
            goalKey: 'purchase',
            detector: 'url',
            docId: `p5-${Date.now()}`,
            path: '/checkout/success',
            orderId: null,
            value: null,
            currency: null,
            occurredAt: now,
          },
          rawIp: null,
        }),
      ).toBe('recorded');
      const r = await post(
        s.siteId,
        order('M-1', {
          occurredAt: new Date(now.getTime() + 20_000).toISOString(),
        }),
        { secret },
      );
      expect(r.body.data).toEqual({ result: 'merged' });
      const ev = await st.owner.assistSiteGoalEvent.findMany({
        where: { siteId: s.siteId },
      });
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({
        trust: 'verified',
        orderId: 'M-1',
        attribution: 'direct',
        conversationId: conv.id,
        path: '/checkout/success',
      });
    });

    it('п.5: обратный порядок (вебхук раньше страницы) — свёртка сливает в одну verified; вне окна 30 мин — две', async () => {
      const { s, secret } = await shop();
      const now = new Date();
      const r = await post(
        s.siteId,
        order('M-2', { occurredAt: now.toISOString() }),
        { secret },
      );
      expect(r.body.data).toEqual({ result: 'created' });
      const page = (docId: string, at: Date) =>
        st.intake.fromLoader({
          site: s.ctx(),
          hit: {
            goalKey: 'purchase',
            detector: 'url',
            docId,
            path: '/checkout/success',
            orderId: null,
            value: null,
            currency: null,
            occurredAt: at,
          },
          rawIp: null,
        });
      expect(
        await page(`p5r-${Date.now()}`, new Date(now.getTime() + 5_000)),
      ).toBe('recorded');
      await st.rollup.run(new Date(), { siteIds: [s.siteId] });
      let ev = await st.owner.assistSiteGoalEvent.findMany({
        where: { siteId: s.siteId },
      });
      expect(ev.map((e) => [e.trust, e.attribution])).toEqual([
        ['verified', 'unassisted'],
      ]);
      // Страница через 40 мин после заказа — уже не тот заказ.
      st.intake.now = () => new Date(now.getTime() + 40 * 60_000);
      expect(
        await page(`p5r2-${Date.now()}`, new Date(now.getTime() + 40 * 60_000)),
      ).toBe('recorded');
      st.intake.now = () => new Date();
      const r2 = await post(
        s.siteId,
        order('M-3', { occurredAt: now.toISOString() }),
        { secret },
      );
      expect(r2.body.data).toEqual({ result: 'created' });
      await st.rollup.run(new Date(), { siteIds: [s.siteId] });
      ev = await st.owner.assistSiteGoalEvent.findMany({
        where: { siteId: s.siteId },
      });
      expect(ev.map((e) => e.trust).sort()).toEqual([
        'page',
        'verified',
        'verified',
      ]);
    });

    it('п.18: цель сайта A по вебхуку сайта B не принимается (ключ цели ищется только в своём сайте)', async () => {
      const a = await shop();
      const b = await st.site();
      const mb = await st.member(b);
      const bSecret = (
        await st.integrations.issue(mb, b.siteId, 'goal_webhook')
      ).secret;
      const r = await post(b.siteId, order('X-1'), { secret: bSecret });
      expect([r.status, r.body.error?.code]).toEqual([
        400,
        'WEBHOOK_BODY_INVALID',
      ]);
      expect(
        await st.owner.assistSiteGoalEvent.count({
          where: { siteId: a.s.siteId },
        }),
      ).toBe(0);
    });

    it('лимит 120 событий в минуту на сайт — 429 RATE_LIMITED', async () => {
      const { s, secret } = await shop();
      const fixed = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 1000);
      st.webhook.now = () => fixed;
      const t = Math.floor(fixed.getTime() / 1000);
      const statuses: number[] = [];
      for (let i = 0; i < 121; i++) {
        const raw = JSON.stringify(
          order(`R-${i}`, { occurredAt: fixed.toISOString() }),
        );
        statuses.push(
          await st.webhook
            .receive({
              siteId: s.siteId,
              rawBody: raw,
              signature: signGoalWebhook(secret, raw, t),
              idempotencyKey: `R-${i}`,
            })
            .then(
              () => 200,
              (e: { getStatus(): number }) => e.getStatus(),
            ),
        );
      }
      st.webhook.now = () => new Date();
      expect(statuses.filter((x) => x === 200)).toHaveLength(120);
      expect(statuses[120]).toBe(429);
    });
  },
);
