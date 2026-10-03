/**
 * Приёмка Э3-бис (б) — поведенческие факторы агрегатами (ТЗ §5-тер.8,
 * §5-тер.10, §5-тер.16 п.13, п.17; решение Э3-бис — только с согласием):
 * приём итога просмотра под assist_public (связанный режим + поведение у
 * владельца + тариф + квота), исключённые пути, перезапись итога pvId;
 * суточная свёртка совпадает с прямым подсчётом, повтор не удваивает,
 * сырые > 7 дней удаляются; экран «Поведение» читает свёртку.
 */
import { WIDGET_PK_LIVE_PREFIX } from '../../brand';
import { randomUUID } from 'crypto';
import type { ChatSite } from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { parsePageView } from '../../modules/assist-analytics/public/page-view';
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

  it('квота тарифа: сверх — не принимается', async () => {
    const s = await site('business');
    await st.owner.assistSiteEventCount.create({
      data: {
        siteId: s.siteId,
        day: new Date().toISOString().slice(0, 10),
        kind: 'bf_pv',
        key: '',
        hour: 0,
        count: 100_000,
      },
    });
    expect(
      await st.ai.pageView({
        site: await row(s),
        ownHost: null,
        input: pv(),
        userAgent: undefined,
        now: new Date(),
      }),
    ).toBe('ignored');
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
