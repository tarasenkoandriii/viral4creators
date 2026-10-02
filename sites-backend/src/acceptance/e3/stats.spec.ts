/**
 * Приёмка Э3 (A) — статистика (ТЗ §5-тер.6, §9.1, §5-тер.16 п.17): суточная
 * свёртка = прямой подсчёт по источникам; повтор не удваивает; «решённый
 * без человека» по §9.1 (а–г) и только закрытый диалог; счётчики виджета —
 * под ролью assist_public одним UPSERT; сутки — в поясе сайта; `scope`
 * крона трогает только свои сайты; экраны Обзор / Конверсии / Темы /
 * сводная сайтов кабинета — из свёртки.
 */
import { randomUUID } from 'crypto';
import { analyticsCodeOf } from '../../modules/assist-analytics/analytics-errors';
import {
  addDays,
  dayInTz,
  dayRangeUtc,
} from '../../modules/assist-analytics/site-time';
import { AnalyticsStack } from '../../modules/assist-analytics/testing/analytics-stack.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import type { ChatSite } from '../../modules/assist-site-chat/testing/chat-stack.testing';

jest.setTimeout(90_000);

const HOUR = 60 * 60 * 1000;
const TZ = 'Europe/Kyiv';

describeDb(
  'Приёмка Э3 (A): статистика и свёртки — §9.1, §5-тер.16 п.17',
  () => {
    const st = new AnalyticsStack();
    beforeAll(async () => {
      await st.init();
    });
    afterAll(async () => {
      await st.close();
    });

    // Прошлый день сайта: диалоги уже «закрыты», «будущего» времени нет.
    const day = addDays(dayInTz(new Date(), TZ), -3);
    const at = (h: number) =>
      new Date(dayRangeUtc(day, TZ).start.getTime() + h * HOUR);

    async function handoff(
      s: ChatSite,
      conversationId: string,
      state: string,
      h: number,
    ) {
      await st.owner.assistSiteHandoff.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          conversationId,
          state,
          reason: 'visitor',
          requestedAt: at(h),
          timeoutAt: at(h + 1),
          ...(state === 'missed' ? { missedAt: at(h + 1) } : {}),
        },
      });
    }
    async function lead(s: ChatSite, conversationId: string | null, h: number) {
      await st.owner.assistSiteLead.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          conversationId,
          fieldsEnc: 'v1.x.y.z',
          fieldNames: ['phone'],
          consentText: 'Згода',
          consentAt: at(h),
          createdAt: at(h),
        },
      });
    }

    it('§9.1: решённые без человека — (а) без передачи кроме cancelled, (б) без лида «не ответили», (в) без 👎, (г) без повтора за 24 ч; только закрытые; suspicious не считаются', async () => {
      const s = await st.site();
      const c = (
        h: number,
        over: Parameters<AnalyticsStack['conversation']>[1] = {},
      ) =>
        st.conversation(s, {
          createdAt: at(h),
          lastMessageAt: at(h + 0.1),
          ...over,
        });
      const resolved1 = await c(1);
      await c(2, { rating: -1 }); // (в) 👎
      const withHandoff = await c(3);
      await handoff(s, withHandoff.id, 'closed', 3); // (а)
      const cancelled = await c(4);
      await handoff(s, cancelled.id, 'cancelled', 4); // отмена — не передача
      const missedConv = await c(4.5);
      await handoff(s, missedConv.id, 'missed', 4.5);
      const unknownLead = await c(5, { answer: { sources: false } });
      await lead(s, unknownLead.id, 5); // (б) лид после «не знаю»
      const okLead = await c(6, { rating: 1 });
      await lead(s, okLead.id, 6);
      const first = await c(7, { question: 'Чи є доставка у Львів сьогодні?' });
      // (г) тот же посетитель через 2 ч — тот же вопрос (маскированный текст).
      await c(9, {
        visitorId: first.visitorId,
        question: 'Чи є доставка у Львів сьогодні??',
      });
      await c(10, { answer: null }); // без ответа — не решён
      await c(11, { suspicious: true }); // не считается вовсе
      await c(12, { lastMessageAt: new Date() }); // ещё не закрыт
      // Счётчики виджета — под ролью assist_public, двумя батчами.
      const ev = (kind: string, key: string | null = null) =>
        ({ kind, key }) as never;
      await st.counts.record({
        siteId: s.siteId,
        events: [
          ev('widget_view'),
          ev('widget_view'),
          ev('open'),
          ev('proactive_shown', 'cart'),
        ],
        now: at(13),
      });
      await st.counts.record({
        siteId: s.siteId,
        events: [
          ev('widget_view'),
          ev('proactive_accepted', 'cart'),
          ev('nope'),
          ev('open', 'bad key!'),
        ],
        now: at(13.5),
      });
      // Соседние сутки (пояс сайта) — не попадают.
      await st.counts.record({
        siteId: s.siteId,
        events: [ev('widget_view')],
        now: at(-0.5),
      });
      await st.owner.siteAiUsage.createMany({
        data: [
          {
            accountId: s.accountId,
            siteId: s.siteId,
            product: 'assist',
            provider: 'GEMINI',
            operation: 'assist-chat',
            model: 'm',
            costMicroUsd: 1500,
            pricingVersion: 't',
            createdAt: at(2),
          },
          {
            accountId: s.accountId,
            siteId: s.siteId,
            product: 'assist',
            provider: 'GEMINI',
            operation: 'assist-embed',
            model: 'm',
            costMicroUsd: 9999,
            pricingVersion: 't',
            createdAt: at(2),
          },
        ],
      });

      await st.rollup.rollupDay(s.siteId, day);
      const row1 = await st.owner.assistSiteDailyTotal.findUniqueOrThrow({
        where: { siteId_day_group: { siteId: s.siteId, day, group: 'all' } },
      });
      expect(row1).toMatchObject({
        dialogs: 11,
        // resolved1, cancelled, okLead и второй вопрос «повтора» (за ним повтора нет)
        resolved: 4,
        answers: 10,
        unknown: 1,
        handoffs: 2,
        handoffsMissed: 1,
        leads: 2,
        thumbsUp: 1,
        thumbsDown: 1,
        widgetViews: 3,
        opens: 1,
        proactiveShown: 1,
        proactiveAccepted: 1,
        costMicroUsd: BigInt(1500),
      });
      expect(row1.proactive).toEqual({
        cart: {
          shown: 1,
          accepted: 1,
          dismissed: 0,
          dialogs: 0,
          conversions: 0,
        },
      });
      // Повторная свёртка — те же суммы (п.17).
      await st.rollup.rollupDay(s.siteId, day);
      await st.rollup.rollupDay(s.siteId, day);
      const row2 = await st.owner.assistSiteDailyTotal.findUniqueOrThrow({
        where: { siteId_day_group: { siteId: s.siteId, day, group: 'all' } },
      });
      const strip = (r: typeof row1) => ({ ...r, computedAt: null });
      expect(strip(row2)).toEqual(strip(row1));
      expect(
        await st.owner.assistSiteDailyTotal.count({
          where: { siteId: s.siteId },
        }),
      ).toBe(1);
      void resolved1;
    });

    it('свёртка = прямой подсчёт: случайные диалоги и события целей дают те же суммы', async () => {
      const s = await st.site();
      const gid = await st.goal(s, {
        key: 'buy',
        detectors: [{ kind: 'js', config: {} }],
      });
      let dialogs = 0;
      let up = 0;
      const attr = { direct: 0, assisted: 0, unassisted: 0 } as Record<
        string,
        number
      >;
      for (let i = 0; i < 25; i++) {
        const rating = i % 3 === 0 ? 1 : null;
        await st.conversation(s, {
          createdAt: at(1 + i * 0.5),
          lastMessageAt: at(1 + i * 0.5 + 0.1),
          rating,
        });
        dialogs++;
        if (rating) up++;
        const a = (['direct', 'assisted', 'unassisted'] as const)[i % 3];
        attr[a]++;
        await st.owner.assistSiteGoalEvent.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            goalId: gid,
            occurredAt: at(1 + i * 0.5),
            source: 'iframe',
            trust: 'page',
            attribution: a,
            clientEventId: `sum-${randomUUID()}`,
            value: 10,
            currency: 'UAH',
          },
        });
      }
      await st.rollup.rollupDay(s.siteId, day);
      const row = await st.owner.assistSiteDailyTotal.findUniqueOrThrow({
        where: { siteId_day_group: { siteId: s.siteId, day, group: 'all' } },
      });
      expect(row.dialogs).toBe(dialogs);
      expect(row.thumbsUp).toBe(up);
      expect((row.conversions as Record<string, unknown>)[gid]).toEqual({
        ...attr,
        unknown: 0,
        refunds: 0,
        value: { verified: 0, page: 250 },
        currency: 'UAH',
      });
    });

    it('экраны: Обзор (Δ, шум, часы оператора), Конверсии, Темы (через LearningReadApi), сводная сайтов кабинета; период — STATS_RANGE_INVALID', async () => {
      const s = await st.site();
      const m = await st.member(s);
      await st.settings.patch(m, s.siteId, {
        config: {
          schema: 1,
          minutesPerQuestion: 6,
          officeCidrs: [],
          excludedPaths: [],
        },
      });
      const gid = await st.goal(s, {
        key: 'buy',
        detectors: [{ kind: 's2s', config: {} }],
        currency: 'UAH',
      });
      const c1 = await st.conversation(s, {
        createdAt: at(1),
        lastMessageAt: at(1.1),
        rating: 1,
      });
      const c2 = await st.conversation(s, {
        createdAt: at(2),
        lastMessageAt: at(2.1),
        answer: { sources: false },
      });
      await st.owner.assistSiteGoalEvent.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          goalId: gid,
          occurredAt: at(3),
          source: 's2s',
          trust: 'verified',
          orderId: 'S-1',
          attribution: 'direct',
          conversationId: c1.id,
          value: 1000,
          currency: 'UAH',
        },
      });
      await st.rollup.rollupDay(s.siteId, day);
      const q = { from: day, to: day, compare: 'prev' as const };
      const o = await st.stats.overview(m, s.siteId, q);
      expect(o.dialogs).toEqual({
        value: 2,
        prev: 0,
        deltaPct: null,
        noise: null,
      });
      expect(o.resolved.value).toBe(2);
      expect(o.resolvedShare.value).toBe(1);
      expect(o.operatorHoursSaved).toBe(0.2); // 2 × 6 мин
      expect(o.minutesPerQuestion).toBe(6);
      expect(o.conversions.direct.value).toBe(1);
      expect(o.thumbsUpShare.value).toBe(1);
      expect(o.series).toEqual([
        { day, dialogs: 2, resolved: 2, handoffs: 0, leads: 0, conversions: 1 },
      ]);
      expect(o.period).toMatchObject({
        from: day,
        to: day,
        timezone: TZ,
        attributionWindowOpenFrom: null,
      });
      const cv = await st.stats.conversions(m, s.siteId, q);
      expect(cv.goals.find((g) => g.goalId === gid)).toMatchObject({
        total: 1,
        direct: 1,
        value: { verified: 1000, page: 0, currency: 'UAH' },
        dialogConversion: 0.5,
      });
      st.learning.topicsOut = [
        {
          clusterId: 'cl1',
          label: 'доставка',
          kind: 'unknown',
          distinctVisitors: 3,
          size: 4,
          status: 'open',
          conversationIds: [c1.id, c2.id],
        },
      ];
      const tp = await st.stats.topics(m, s.siteId, q);
      expect(tp.topics).toEqual([
        {
          clusterId: 'cl1',
          label: 'доставка',
          kind: 'unknown',
          distinctVisitors: 3,
          dialogs: 2,
          conversions: 1,
          unknownShare: 0.5,
          status: 'open',
        },
      ]);
      expect(tp.uncovered).toBe(1);
      st.learning.topicsOut = [];
      // Второй сайт того же кабинета — в сводной.
      const site2 = await st.owner.site.create({
        data: { accountId: s.accountId, name: 'Другий' },
      });
      await st.owner.assistSite.create({
        data: { accountId: s.accountId, siteId: site2.id },
      });
      const all = await st.stats.sites(m, q);
      expect(all.sites.map((x) => [x.siteId, x.dialogs])).toEqual([
        [s.siteId, 2],
        [site2.id, 0],
      ]);
      const code = async (p: Promise<unknown>) =>
        p.then(
          () => null,
          (e) => analyticsCodeOf(e),
        );
      expect(
        await code(
          st.stats.overview(m, s.siteId, { ...q, from: '2026-13-01' }),
        ),
      ).toBe('STATS_RANGE_INVALID');
      expect(
        await code(
          st.stats.overview(m, s.siteId, { ...q, from: addDays(day, 1) }),
        ),
      ).toBe('STATS_RANGE_INVALID');
      expect(
        await code(
          st.stats.overview(m, s.siteId, { ...q, from: addDays(day, -400) }),
        ),
      ).toBe('STATS_RANGE_INVALID');
      const stranger = await st.member(await st.site());
      expect(await code(st.stats.overview(stranger, s.siteId, q))).toBe(
        'NOT_FOUND',
      );
    });

    it('крон run со scope: пересчитывает только свои сайты (сегодня и вчера)', async () => {
      const a = await st.site();
      const b = await st.site();
      await st.conversation(a, { createdAt: new Date(Date.now() - 60_000) });
      await st.conversation(b, { createdAt: new Date(Date.now() - 60_000) });
      const r = await st.rollup.run(new Date(), { siteIds: [a.siteId] });
      expect(r.sites).toBe(1);
      expect(
        await st.owner.assistSiteDailyTotal.count({
          where: { siteId: a.siteId },
        }),
      ).toBe(2);
      expect(
        await st.owner.assistSiteDailyTotal.count({
          where: { siteId: b.siteId },
        }),
      ).toBe(0);
    });

    it('настройки аналитики: ANALYTICS_CONFIG_INVALID; пояс и валюта; подписка на отчёты — своя', async () => {
      const s = await st.site();
      const m = await st.member(s);
      const mgr = await st.member(s, 'manager');
      const code = async (p: Promise<unknown>) =>
        p.then(
          () => null,
          (e) => analyticsCodeOf(e),
        );
      expect(
        await code(
          st.settings.patch(m, s.siteId, { config: { officeCidrs: ['x'] } }),
        ),
      ).toBe('ANALYTICS_CONFIG_INVALID');
      expect(
        await code(st.settings.patch(m, s.siteId, { timezone: 'Mars/Base' })),
      ).toBe('ANALYTICS_CONFIG_INVALID');
      const v = await st.settings.patch(m, s.siteId, {
        timezone: 'Europe/Warsaw',
        currency: 'PLN',
      });
      expect(v).toMatchObject({ timezone: 'Europe/Warsaw', currency: 'PLN' });
      expect(await st.settings.subscription(mgr, s.siteId)).toEqual({
        weekly: true,
        digest: true,
      });
      expect(
        await st.settings.patchSubscription(mgr, s.siteId, { weekly: false }),
      ).toEqual({
        weekly: false,
        digest: true,
      });
      expect(await st.settings.subscription(m, s.siteId)).toEqual({
        weekly: true,
        digest: true,
      });
    });
  },
);
