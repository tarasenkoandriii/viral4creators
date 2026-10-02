/**
 * Приёмка Э3 (A) — атрибуция (ТЗ §5-тер.16 п.7, §5-тер.2; режим «без
 * согласия» — в пределах документа): клик по `link` помощника → цель ≤ 30
 * мин в том же документе — `direct`; без клика — `assisted` (был ответ
 * модели в диалоге документа) или `unassisted`; загрузчик без живого iframe —
 * `unassisted`; чужой диалог (другой посетитель) — не связывается. Публичный
 * путь — под ролью assist_public; затем свёртка дня разносит их по
 * direct/assisted/unassisted.
 */
import type { GoalHit } from '../../modules/assist-analytics/public/goal-intake.service';
import { dayInTz } from '../../modules/assist-analytics/site-time';
import { AnalyticsStack } from '../../modules/assist-analytics/testing/analytics-stack.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';

jest.setTimeout(60_000);

describeDb('Приёмка Э3 (A): атрибуция — §5-тер.16 п.7', () => {
  const st = new AnalyticsStack();
  beforeAll(async () => {
    await st.init();
  });
  afterAll(async () => {
    await st.close();
  });

  let n = 0;
  const hit = (over: Partial<GoalHit> = {}): GoalHit => ({
    goalKey: 'order',
    detector: 'click',
    docId: `attr-doc-${Date.now()}-${n++}`,
    path: '/cart',
    orderId: null,
    value: null,
    currency: null,
    occurredAt: new Date(),
    ...over,
  });

  it('direct ≤ 30 мин после клика по действию помощника; позже — assisted; без ответа — unassisted; загрузчик — unassisted', async () => {
    const s = await st.site();
    await st.goal(s, {
      key: 'order',
      detectors: [
        {
          kind: 'click',
          config: {
            descriptor: {
              assistGoal: 'order',
              assistId: null,
              role: 'button',
              text: 'Замовити',
              tag: 'button',
            },
            pathMask: null,
          },
        },
      ],
    });
    const withAnswer = await st.conversation(s, { answer: { sources: true } });
    const noAnswer = await st.conversation(s, { answer: null });
    const now = new Date();
    st.intake.now = () => now;
    const iframe = (
      conv: { id: string; visitorId: string },
      lastAssistClickAt: Date | null,
      link = true,
    ) =>
      st.intake.fromIframe({
        site: s.ctx(),
        visitor: st.chat.visitor({ visitorId: conv.visitorId }),
        conversationId: conv.id,
        lastAssistClickAt,
        assist: { proactive: 'cart_exit', scenario: null, link },
        hit: hit({ occurredAt: now }),
        rawIp: null,
      });
    expect(
      await iframe(withAnswer, new Date(now.getTime() - 29 * 60_000)),
    ).toBe('recorded');
    expect(
      await iframe(withAnswer, new Date(now.getTime() - 31 * 60_000)),
    ).toBe('recorded');
    expect(await iframe(withAnswer, null, false)).toBe('recorded');
    expect(await iframe(noAnswer, null, false)).toBe('recorded');
    // Диалог другого посетителя — не связывается (unassisted, без conversationId).
    const stranger = st.chat.visitor();
    expect(
      await st.intake.fromIframe({
        site: s.ctx(),
        visitor: stranger,
        conversationId: withAnswer.id,
        lastAssistClickAt: null,
        assist: { proactive: null, scenario: null, link: false },
        hit: hit({ occurredAt: now }),
        rawIp: null,
      }),
    ).toBe('recorded');
    expect(
      await st.intake.fromLoader({
        site: s.ctx(),
        hit: hit({ occurredAt: now }),
        rawIp: null,
      }),
    ).toBe('recorded');
    st.intake.now = () => new Date();

    const ev = await st.owner.assistSiteGoalEvent.findMany({
      where: { siteId: s.siteId },
      orderBy: { receivedAt: 'asc' },
    });
    expect(ev.map((e) => [e.source, e.attribution, e.conversationId])).toEqual([
      ['iframe', 'direct', withAnswer.id],
      ['iframe', 'assisted', withAnswer.id],
      ['iframe', 'assisted', withAnswer.id],
      ['iframe', 'unassisted', noAnswer.id],
      ['iframe', 'unassisted', null],
      ['loader', 'unassisted', null],
    ]);
    expect(ev[0].assist).toEqual({
      proactive: 'cart_exit',
      scenario: null,
      link: true,
    });

    // Свёртка дня: по видам атрибуции, проактивный триггер — с конверсиями.
    const day = dayInTz(now, 'Europe/Kyiv');
    await st.rollup.rollupDay(s.siteId, day);
    const row = await st.owner.assistSiteDailyTotal.findUniqueOrThrow({
      where: { siteId_day_group: { siteId: s.siteId, day, group: 'all' } },
    });
    const gid = ev[0].goalId;
    expect((row.conversions as Record<string, unknown>)[gid]).toMatchObject({
      direct: 1,
      assisted: 2,
      unassisted: 3,
      unknown: 0,
      refunds: 0,
    });
    expect(
      (row.proactive as Record<string, { conversions: number }>).cart_exit
        .conversions,
    ).toBe(4);
  });
});
