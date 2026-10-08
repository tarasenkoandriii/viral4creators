/**
 * Приёмка Э3-бис (б) — поведенческие факторы агрегатами (ТЗ §5-тер.8,
 * §5-тер.10, §5-тер.16 п.13, п.17; решение Э3-бис — только с согласием):
 * приём итога просмотра под assist_public (связанный режим + поведение у
 * владельца + тариф + квота), исключённые пути, перезапись итога pvId;
 * суточная свёртка совпадает с прямым подсчётом, повтор не удваивает,
 * сырые > 7 дней удаляются; экран «Поведение» читает свёртку.
 * Заход 9: сверх квоты — выборка с весом (Р-З9-25), агрегаты Pro — 25 мес.
 */
import { WIDGET_PK_LIVE_PREFIX } from '../../brand';
import { randomUUID } from 'crypto';
import type { ChatSite } from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { parsePageView } from '../../modules/assist-analytics/public/page-view';
import {
  BEHAVIOR_HARD_CAP_FACTOR,
  BEHAVIOR_OVER_QUOTA_SAMPLE_RATE,
  inBehaviorSample,
} from '../../modules/assist-analytics/public/ai-intake.service';
import {
  addDays,
  dayInTz,
  siteTz,
} from '../../modules/assist-analytics/site-time';
import {
  AiStack,
  visitKey,
} from '../../modules/assist-analytics/testing/ai-stack.testing';

jest.setTimeout(120_000);

describeDb('Приёмка Э3-бис (б): поведение страниц', () => {
  const st = new AiStack();
  beforeAll(async () => {
    await st.init();
  });
  afterAll(async () => {
    await st.close();
  });

  async function site(
    plan: 'business' | 'start',
    cfg: Record<string, unknown> = { linked: true, behavior: true },
  ): Promise<ChatSite> {
    const s = await st.site();
    await st.plan(s, plan);
    await st.analytics(s, cfg);
    return s;
  }
  const row = (s: ChatSite) =>
    st.owner.assistSite.findUniqueOrThrow({
      where: { siteId: s.siteId },
      select: { siteId: true, accountId: true, analytics: true },
    });
  const pv = (over: Record<string, unknown> = {}) =>
    parsePageView({
      pk: `${WIDGET_PK_LIVE_PREFIX}x`,
      pv: `pv${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      v: visitKey(),
      p: '/catalog',
      d: 'd',
      sc: 50,
      ac: 10_000,
      to: 20_000,
      ck: 3,
      ...over,
    })!;

  it('приём: только связанный режим + поведение + Business; исключённый путь — мимо; повтор pvId — перезапись', async () => {
    const off = await site('business', { linked: true, behavior: false });
    const start = await site('start');
    const s = await site('business');
    const now = new Date();
    const send = async (x: ChatSite, input = pv()) =>
      st.ai.pageView({
        site: await row(x),
        ownHost: new URL(x.origin).hostname,
        input,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
        now,
      });
    expect(await send(off)).toBe('ignored');
    expect(await send(start)).toBe('ignored');
    expect(await send(s, pv({ p: '/account/orders' }))).toBe('ignored');
    const first = pv({ sc: 40 });
    expect(await send(s, first)).toBe('recorded');
    expect(await send(s, { ...first, scrollMax: 90, activeMs: 22_000 })).toBe(
      'updated',
    );
    const rows = await st.owner.assistSitePageView.findMany({
      where: { siteId: s.siteId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scrollMax: 90,
      activeMs: 22_000,
      os: 'windows',
      browser: 'chrome',
      path: '/catalog',
    });
    // Ни UA целиком, ни ключа визита, ни IP — колонок для них просто нет.
    expect(Object.keys(rows[0]).sort()).not.toEqual(
      expect.arrayContaining(['ua', 'ip', 'visit']),
    );
  });

  const quotaUsed = (s: ChatSite, count: number) => {
    const key = {
      siteId: s.siteId,
      day: new Date().toISOString().slice(0, 10),
      kind: 'bf_pv',
      key: '',
      hour: 0,
    };
    return st.owner.assistSiteEventCount.upsert({
      where: { siteId_day_kind_key_hour: key },
      create: { ...key, count },
      update: { count: { increment: count } },
    });
  };

  it('заход 9 (Р-З9-25): сверх квоты — выборка по pvId с долей в строке; за потолком ×2 — ничего, bf.js не грузится', async () => {
    const s = await site('business');
    await quotaUsed(s, 100_000);
    const r = await row(s);
    const now = new Date();
    const inputs = Array.from({ length: 120 }, (_, i) =>
      pv({ pv: `pvsample${i.toString().padStart(4, '0')}` }),
    );
    const want = inputs.filter((x) =>
      inBehaviorSample(s.siteId, x.pv, BEHAVIOR_OVER_QUOTA_SAMPLE_RATE),
    );
    expect(want.length).toBeGreaterThan(0);
    expect(want.length).toBeLessThan(inputs.length);
    const results = [];
    for (const input of inputs) {
      results.push(
        await st.ai.pageView({
          site: r,
          ownHost: null,
          input,
          userAgent: undefined,
          now,
        }),
      );
    }
    expect(results.filter((x) => x === 'recorded')).toHaveLength(want.length);
    const rows = await st.owner.assistSitePageView.findMany({
      where: { siteId: s.siteId },
    });
    expect(rows.map((x) => x.id).sort()).toEqual(want.map((x) => x.pv).sort());
    expect(
      rows.every((x) => x.sampleRate === BEHAVIOR_OVER_QUOTA_SAMPLE_RATE),
    ).toBe(true);
    // Повтор итога того же просмотра решается так же (вне выборки — мимо).
    const out = inputs.find((x) => !want.includes(x))!;
    expect(
      await st.ai.pageView({
        site: r,
        ownHost: null,
        input: out,
        userAgent: undefined,
        now,
      }),
    ).toBe('ignored');
    // Чанк bf.js сверх квоты грузится (выборка решает сервер)…
    const cfg = await st.ai.publicAnalytics(r, now);
    expect(cfg?.behavior).toBe(true);
    // …а за жёстким потолком — нет, и итоги не принимаются.
    const capped = await site('business');
    await quotaUsed(capped, 100_000 * BEHAVIOR_HARD_CAP_FACTOR);
    const rc = await row(capped);
    expect((await st.ai.publicAnalytics(rc, now))?.behavior).toBe(false);
    for (const input of want.slice(0, 3)) {
      expect(
        await st.ai.pageView({
          site: rc,
          ownHost: null,
          input,
          userAgent: undefined,
          now,
        }),
      ).toBe('ignored');
    }
    // Кабинет показывает долю выборки.
    const m = await st.member(s, 'manager');
    const today = new Date().toISOString().slice(0, 10);
    const view = await st.cabinet.behavior(m, s.siteId, {
      from: today,
      to: today,
    });
    expect(view.quota.sampleRate).toBe(BEHAVIOR_OVER_QUOTA_SAMPLE_RATE);
  });

  it('аудит P3-10: выборка решает только вставку — итог просмотра, принятого в квоте, перезаписывается и сверх неё', async () => {
    const s = await site('business');
    const r = await row(s);
    const now = new Date();
    // Просмотр вне будущей выборки, но принятый, пока квота не кончилась.
    let input = pv();
    while (
      inBehaviorSample(s.siteId, input.pv, BEHAVIOR_OVER_QUOTA_SAMPLE_RATE)
    ) {
      input = pv();
    }
    const send = (x: typeof input, at: Date) =>
      st.ai.pageView({
        site: r,
        ownHost: null,
        input: x,
        userAgent: undefined,
        now: at,
      });
    expect(await send(input, now)).toBe('recorded');
    await quotaUsed(s, 100_000);
    // Кэш квоты — 60 с: через минуту сервер уже знает про выборку.
    const later = new Date(now.getTime() + 61_000);
    expect(await send({ ...input, scrollMax: 95 }, later)).toBe('updated');
    expect(await send(pv({ pv: input.pv + 'x' }), later)).not.toBe('updated');
    const row1 = await st.owner.assistSitePageView.findFirstOrThrow({
      where: { siteId: s.siteId, id: input.pv },
    });
    expect(row1).toMatchObject({ scrollMax: 95, sampleRate: 1 });
  });

  it('аудит P2-3: после Pro — 90 дней льготы (истёкшая подписка, платёж Pro при переходе на Business), дальше — 13 мес', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 430 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const seeded = async (setup: (s: ChatSite) => Promise<unknown>) => {
      const s = await site('business');
      await setup(s);
      await st.owner.assistSiteDailyPage.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          day: old,
          path: '/',
          views: 1,
        },
      });
      return s;
    };
    const expiredPro = (daysAgo: number) => (s: ChatSite) =>
      st.owner.assistSubscription.update({
        where: { accountId: s.accountId },
        data: {
          planId: 'pro',
          status: 'expired',
          paidThrough: new Date(now.getTime() - daysAgo * 86_400_000),
        },
      });
    const lapsed30 = await seeded(expiredPro(30));
    const lapsed100 = await seeded(expiredPro(100));
    const paidPro = await seeded((s) =>
      st.owner.assistPayment.create({
        data: {
          id: `pay-${randomUUID()}`,
          accountId: s.accountId,
          kind: 'renewal',
          planId: 'pro',
          method: 'wayforpay',
          status: 'succeeded',
          currency: 'UAH',
          amountMinor: 100,
          paidAt: new Date(now.getTime() - 40 * 86_400_000),
        },
      }),
    );
    const oldPayment = await seeded((s) =>
      st.owner.assistPayment.create({
        data: {
          id: `pay-${randomUUID()}`,
          accountId: s.accountId,
          kind: 'renewal',
          planId: 'pro',
          method: 'wayforpay',
          status: 'succeeded',
          currency: 'UAH',
          amountMinor: 100,
          paidAt: new Date(now.getTime() - 200 * 86_400_000),
        },
      }),
    );
    const all = [lapsed30, lapsed100, paidPro, oldPayment];
    await st.behavior.daily(now, st.scope(...all));
    const kept = async (s: ChatSite) =>
      (await st.owner.assistSiteDailyPage.count({
        where: { siteId: s.siteId, day: old },
      })) === 1;
    expect(await kept(lapsed30)).toBe(true);
    expect(await kept(lapsed100)).toBe(false);
    expect(await kept(paidPro)).toBe(true);
    expect(await kept(oldPayment)).toBe(false);
  });

  it('заход 9 (Р-З9-25): свёртка делит счётчики выборки на долю — итог на весь трафик', async () => {
    const s = await site('business');
    const tz = siteTz('Europe/Kyiv');
    const now = new Date();
    const yesterday = addDays(dayInTz(now, tz), -1);
    const at = new Date(`${yesterday}T10:00:00Z`);
    const mk = (sampleRate: number, over: Record<string, unknown> = {}) =>
      st.owner.assistSitePageView.create({
        data: {
          id: `pv-${randomUUID()}`,
          siteId: s.siteId,
          day: at.toISOString().slice(0, 10),
          startedAt: at,
          path: '/catalog',
          source: 'direct',
          device: 'desktop',
          os: 'windows',
          browser: 'chrome',
          scrollMax: 80,
          activeMs: 5000,
          sampleRate,
          ...over,
        },
      });
    // 2 просмотра в квоте + 3 выборки 10% (каждый — за 10).
    await mk(1, { rageClicks: 1 });
    await mk(1, { formStarted: true, formAbandonField: 'email' });
    await mk(0.1, { rageClicks: 2, chatOpened: true });
    await mk(0.1, { formStarted: true, formAbandonField: 'email' });
    await mk(0.1, { backNav: true });
    await st.behavior.daily(now, st.scope(s));
    const d = await st.owner.assistSiteDailyPage.findUniqueOrThrow({
      where: {
        siteId_day_path: { siteId: s.siteId, day: yesterday, path: '/catalog' },
      },
    });
    expect(d).toMatchObject({
      views: 32,
      rage: 21,
      formStarts: 11,
      formAbandons: 11,
      abandonFields: { email: 11 },
      backNav: 10,
      chatOpens: 10,
      deepScroll: 32,
    });
  });

  it('заход 9 (хвост (4)): агрегаты Pro — 25 мес, остальные — 13; срок по тарифу на момент уборки', async () => {
    const pro = await site('business');
    await st.plan(pro, 'pro');
    const biz = await site('business');
    const now = new Date();
    const ago = (months: number) =>
      new Date(now.getTime() - Math.round(months * 30.4375 + 2) * 86_400_000)
        .toISOString()
        .slice(0, 10);
    for (const s of [pro, biz]) {
      for (const day of [ago(14), ago(26)]) {
        await st.owner.assistSiteDailyPage.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            day,
            path: '/',
            views: 1,
          },
        });
        await st.owner.assistSiteDailyTotal.create({
          data: { accountId: s.accountId, siteId: s.siteId, day },
        });
        await st.owner.assistSiteEventCount.create({
          data: {
            siteId: s.siteId,
            day,
            kind: 'open',
            key: '',
            hour: 0,
            count: 1,
          },
        });
      }
    }
    await st.behavior.daily(now, st.scope(pro, biz));
    await st.rollup.daily(now, st.scope(pro, biz));
    const days = async (s: ChatSite) => ({
      pages: (
        await st.owner.assistSiteDailyPage.findMany({
          where: { siteId: s.siteId },
          select: { day: true },
        })
      ).map((x) => x.day),
      totals: (
        await st.owner.assistSiteDailyTotal.findMany({
          where: { siteId: s.siteId, day: { lt: ago(13) } },
          select: { day: true },
        })
      ).map((x) => x.day),
      counts: (
        await st.owner.assistSiteEventCount.findMany({
          where: { siteId: s.siteId, kind: 'open' },
          select: { day: true },
        })
      ).map((x) => x.day),
    });
    expect(await days(pro)).toEqual({
      pages: [ago(14)],
      totals: [ago(14)],
      counts: [ago(14)],
    });
    expect(await days(biz)).toEqual({ pages: [], totals: [], counts: [] });
    // Pro → Business: при следующей уборке — общий срок.
    await st.plan(pro, 'business');
    await st.behavior.daily(now, st.scope(pro));
    await st.rollup.daily(now, st.scope(pro));
    expect(await days(pro)).toEqual({ pages: [], totals: [], counts: [] });
  });

  it('свёртка суток = прямой подсчёт; повтор не удваивает; p75 CWV; сырые > 7 дней удалены', async () => {
    const s = await site('business');
    const tz = siteTz('Europe/Kyiv');
    const now = new Date();
    const yesterday = addDays(dayInTz(now, tz), -1);
    const at = new Date(`${yesterday}T10:00:00Z`);
    const views = [
      {
        path: '/checkout',
        lcpMs: 1000,
        formStarted: true,
        formSubmitted: false,
        formAbandonField: 'phone',
        rageClicks: 2,
      },
      {
        path: '/checkout',
        lcpMs: 2000,
        formStarted: true,
        formSubmitted: true,
        formAbandonField: null,
        rageClicks: 0,
      },
      {
        path: '/checkout',
        lcpMs: 3000,
        formStarted: true,
        formSubmitted: false,
        formAbandonField: 'phone',
        rageClicks: 1,
      },
      {
        path: '/checkout',
        lcpMs: 4000,
        formStarted: false,
        formSubmitted: false,
        formAbandonField: null,
        rageClicks: 0,
      },
      {
        path: '/',
        lcpMs: 900,
        formStarted: false,
        formSubmitted: false,
        formAbandonField: null,
        rageClicks: 0,
      },
    ];
    for (const v of views) {
      await st.owner.assistSitePageView.create({
        data: {
          id: `pv-${randomUUID()}`,
          siteId: s.siteId,
          day: at.toISOString().slice(0, 10),
          startedAt: at,
          source: 'direct',
          device: 'desktop',
          os: 'windows',
          browser: 'chrome',
          scrollMax: 80,
          activeMs: 5000,
          ...v,
        },
      });
    }
    // Старый сырой (8 дней) — уйдёт уборкой.
    await st.owner.assistSitePageView.create({
      data: {
        id: `pv-old-${randomUUID()}`,
        siteId: s.siteId,
        day: '2000-01-01',
        startedAt: new Date(now.getTime() - 8 * 86_400_000),
        path: '/',
        source: 'direct',
        device: 'desktop',
        os: 'windows',
        browser: 'chrome',
      },
    });
    await st.behavior.daily(now, st.scope(s));
    await st.behavior.daily(now, st.scope(s));
    const daily = await st.owner.assistSiteDailyPage.findMany({
      where: { siteId: s.siteId, day: yesterday },
    });
    const checkout = daily.find((d) => d.path === '/checkout')!;
    expect(checkout).toMatchObject({
      views: 4,
      formStarts: 3,
      formAbandons: 2,
      rage: 3,
      abandonFields: { phone: 2 },
      lcpP75: 3250,
    });
    expect(daily.reduce((a, d) => a + d.views, 0)).toBe(5);
    expect(
      await st.owner.assistSitePageView.count({
        where: { siteId: s.siteId, day: '2000-01-01' },
      }),
    ).toBe(0);
    const m = await st.member(s, 'manager');
    const view = await st.cabinet.behavior(m, s.siteId, {
      from: yesterday,
      to: yesterday,
    });
    expect(view.enabled).toBe(true);
    expect(view.pages[0]).toMatchObject({
      path: '/checkout',
      views: 4,
      topAbandonField: 'phone',
    });
  });

  it('аудит: выводы недели и калибровки старше 13 мес удаляются; последняя калибровка сайта остаётся', async () => {
    const s = await site('business');
    const now = new Date();
    const old = new Date(now.getTime() - 400 * 86_400_000);
    const base = { accountId: s.accountId, siteId: s.siteId };
    await st.owner.assistSiteInsight.create({
      data: {
        ...base,
        weekStart: old.toISOString().slice(0, 10),
        code: 'N3',
        findingKey: 'old',
        finding: {},
        impact: 'low',
      },
    });
    await st.owner.assistSiteInsight.create({
      data: {
        ...base,
        weekStart: addDays(now.toISOString().slice(0, 10), -7),
        code: 'N3',
        findingKey: 'fresh',
        finding: {},
        impact: 'low',
      },
    });
    for (const version of [1, 2]) {
      await st.owner.assistSiteLeadCalibration.create({
        data: {
          ...base,
          version,
          method: 'platt',
          params: { a: 1, b: 0 },
          positives: 50,
          total: 200,
          createdAt: old,
        },
      });
    }
    await st.behavior.daily(now, st.scope(s));
    const ins = await st.owner.assistSiteInsight.findMany({
      where: { siteId: s.siteId },
    });
    expect(ins.map((i) => i.findingKey)).toEqual(['fresh']);
    const cal = await st.owner.assistSiteLeadCalibration.findMany({
      where: { siteId: s.siteId },
    });
    expect(cal.map((c) => c.version)).toEqual([2]);
  });
});
