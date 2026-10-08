/**
 * Приёмка Э3-бис (в) — согласие и эксперименты (ТЗ §5-тер.2, §5-тер.9,
 * §5-тер.16 п.14–15; решение Э3-бис: эксперименты — только на посетителях
 * с согласием). Публичная часть — под ролью assist_public.
 *  - связанный режим: цель на другой странице с ключом визита → «с
 *    участием» диалога визита; без согласия/без тарифа — документ;
 *  - ref для вебхука заказа; подделанный ref — без связи;
 *  - запуск: только владелец, Business+, связанный режим, мощность;
 *  - группа считается сервером (FNV-1a как в загрузчике), повтор — без
 *    дубля; конверсия основной цели отмечает единицу;
 *  - без подглядывания: до горизонта итога нет, после — есть; SRM —
 *    «испорчен»; тариф снят — стоп; остановка владельцем — без итога.
 */
import { randomUUID } from 'crypto';
import type { GoalHit } from '../../modules/assist-analytics/public/goal-intake.service';
import {
  issueRef,
  verifyRef,
  visitHashOf,
} from '../../modules/assist-analytics/public/ai-intake.service';
import { armOf } from '../../modules/assist-analytics/exp/experiment-math';
import { analyticsCodeOf } from '../../modules/assist-analytics/analytics-errors';
import type { ChatSite } from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import type { VisitorContext } from '../../modules/assist-widget/widget-session.service';
import { WidgetStateService } from '../../modules/assist-widget/widget-state.service';
import {
  AiStack,
  visitKey,
} from '../../modules/assist-analytics/testing/ai-stack.testing';

jest.setTimeout(120_000);

describeDb('Приёмка Э3-бис (в): согласие и эксперименты', () => {
  const st = new AiStack();
  const saved = process.env.ASSIST_ANALYTICS_REF_SECRET;
  beforeAll(async () => {
    process.env.ASSIST_ANALYTICS_REF_SECRET = 'e3b-ref-secret-0123456789';
    await st.init();
  });
  afterAll(async () => {
    await st.close();
    if (saved === undefined) delete process.env.ASSIST_ANALYTICS_REF_SECRET;
    else process.env.ASSIST_ANALYTICS_REF_SECRET = saved;
  });

  let n = 0;
  const hit = (over: Partial<GoalHit> = {}): GoalHit => ({
    goalKey: 'order',
    detector: 'js',
    docId: `e3b-doc-${Date.now()}-${n++}`,
    path: '/checkout/success',
    orderId: null,
    value: null,
    currency: null,
    occurredAt: new Date(),
    ...over,
  });

  async function site(
    plan: 'business' | 'start' | 'pro',
    cfg: Record<string, unknown> = { linked: true },
  ): Promise<ChatSite> {
    const s = await st.site();
    await st.plan(s, plan);
    await st.analytics(s, cfg);
    await st.goal(s, { key: 'order', detectors: [{ kind: 'js', config: {} }] });
    return s;
  }

  const row = (s: ChatSite) =>
    st.owner.assistSite.findUniqueOrThrow({
      where: { siteId: s.siteId },
      select: { siteId: true, accountId: true, ipSalt: true, analytics: true },
    });

  it('связанный режим: цель на другой странице с ключом визита — «с участием» диалога визита', async () => {
    const s = await site('business');
    const conv = await st.conversation(s, { answer: { sources: true } });
    const v = visitKey();
    const visitor = (
      await st.owner.assistSiteConversation.findUniqueOrThrow({
        where: { id: conv.id },
        select: { visitorId: true },
      })
    ).visitorId;
    expect(
      await st.ai.linkVisit({
        site: await row(s),
        conversationId: conv.id,
        visitorId: visitor,
        v,
        now: new Date(),
      }),
    ).toBe(true);
    // Чужой посетитель не может привязать чужой диалог.
    expect(
      await st.ai.linkVisit({
        site: await row(s),
        conversationId: conv.id,
        visitorId: 'someone-else',
        v: visitKey(),
        now: new Date(),
      }),
    ).toBe(false);
    expect(
      await st.intake.fromLoader({
        site: s.ctx(),
        hit: hit({ visit: v }),
        rawIp: null,
      }),
    ).toBe('recorded');
    const ev = await st.owner.assistSiteGoalEvent.findFirst({
      where: { siteId: s.siteId },
      orderBy: { receivedAt: 'desc' },
    });
    expect(ev).toMatchObject({
      attribution: 'assisted',
      conversationId: conv.id,
      visitHash: visitHashOf(s.siteId, `salt-${s.siteId}`, v),
    });
  });

  it('без согласия (нет ключа), режим выключен или тариф Start — только документ (unassisted)', async () => {
    for (const [plan, cfg, withVisit] of [
      ['business', { linked: true }, false],
      ['business', { linked: false }, true],
      ['start', { linked: true }, true],
    ] as const) {
      const s = await site(plan, cfg);
      const conv = await st.conversation(s);
      const v = visitKey();
      await st.owner.assistSiteConversation.update({
        where: { id: conv.id },
        data: { visitHash: visitHashOf(s.siteId, `salt-${s.siteId}`, v) },
      });
      await st.intake.fromLoader({
        site: s.ctx(),
        hit: hit(withVisit ? { visit: v } : {}),
        rawIp: null,
      });
      const ev = await st.owner.assistSiteGoalEvent.findFirstOrThrow({
        where: { siteId: s.siteId },
      });
      expect(ev).toMatchObject({
        attribution: 'unassisted',
        conversationId: null,
        visitHash: null,
      });
    }
  });

  it('привязка диалога к визиту из iframe — только при связанном режиме и тарифе Business+', async () => {
    for (const [plan, cfg] of [
      ['business', { linked: false }],
      ['start', { linked: true }],
    ] as const) {
      const s = await site(plan, cfg);
      const c = await st.conversation(s);
      const { visitorId } =
        await st.owner.assistSiteConversation.findUniqueOrThrow({
          where: { id: c.id },
          select: { visitorId: true },
        });
      expect(
        await st.ai.linkVisit({
          site: await row(s),
          conversationId: c.id,
          visitorId,
          v: visitKey(),
          now: new Date(),
        }),
      ).toBe(false);
      const after = await st.owner.assistSiteConversation.findUniqueOrThrow({
        where: { id: c.id },
        select: { visitHash: true },
      });
      expect(after.visitHash).toBeNull();
    }
  });

  it('ref для вебхука: подпись сайта и срок; чужой сайт/подделка/просрочка — null', () => {
    const now = new Date();
    const vh = 'a'.repeat(32);
    const ref = issueRef('site-1', vh, now)!;
    expect(verifyRef('site-1', ref, now)).toBe(vh);
    expect(verifyRef('site-2', ref, now)).toBeNull();
    expect(
      verifyRef(
        'site-1',
        ref.replace(/.$/, ref.endsWith('A') ? 'B' : 'A'),
        now,
      ),
    ).toBeNull();
    expect(
      verifyRef('site-1', ref, new Date(now.getTime() + 3 * 86_400_000)),
    ).toBeNull();
  });

  async function trafficFor(s: ChatSite, visits: number, conversions: number) {
    const day = new Date(Date.now() - 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await st.owner.assistSiteEventCount.createMany({
      data: [
        {
          siteId: s.siteId,
          day,
          kind: 'visit_new',
          key: '',
          hour: 1,
          count: visits,
        },
        // Чат открывают все (варианты приветствия включают при открытии).
        {
          siteId: s.siteId,
          day,
          kind: 'widget_view',
          key: '',
          hour: 1,
          count: visits,
        },
        {
          siteId: s.siteId,
          day,
          kind: 'open',
          key: '',
          hour: 1,
          count: visits,
        },
      ],
    });
    const g = await st.owner.assistSiteGoal.findFirstOrThrow({
      where: { siteId: s.siteId, key: 'order' },
    });
    await st.owner.assistSiteGoalEvent.createMany({
      data: Array.from({ length: conversions }, (_, i) => ({
        id: randomUUID(),
        accountId: s.accountId,
        siteId: s.siteId,
        goalId: g.id,
        occurredAt: new Date(Date.now() - 2 * 86_400_000),
        source: 'loader',
        trust: 'page',
        attribution: 'unassisted',
        clientEventId: `tr-${s.siteId}-${i}`,
        visitHash: `tr-${i}`,
      })),
    });
  }

  it('запуск: только владелец, Business+, связанный режим, мощность; один эксперимент на сайт', async () => {
    const s = await site('business');
    const owner = await st.member(s, 'owner');
    const manager = await st.member(s, 'manager');
    const body = {
      kind: 'holdout',
      goalKey: 'order',
      share: 0.1,
      horizonDays: 28,
    };
    const code = async (p: Promise<unknown>) =>
      analyticsCodeOf(await p.catch((e: unknown) => e));
    expect(await code(st.experiments.start(manager, s.siteId, body))).toBe(
      'EXPERIMENT_OWNER_ONLY',
    );
    // Мало трафика с согласием — «не измерить».
    expect(await code(st.experiments.start(owner, s.siteId, body))).toBe(
      'EXPERIMENT_UNDERPOWERED',
    );
    await trafficFor(s, 8000, 1600);
    const preview = await st.experiments.preview(manager, s.siteId, body);
    expect(preview.ok).toBe(true);
    const e = await st.experiments.start(owner, s.siteId, body);
    expect(e).toMatchObject({
      status: 'running',
      kind: 'holdout',
      result: null,
    });
    expect(await code(st.experiments.start(owner, s.siteId, body))).toBe(
      'EXPERIMENT_RUNNING',
    );

    const start = await site('start');
    expect(
      await code(
        st.experiments.start(
          await st.member(start, 'owner'),
          start.siteId,
          body,
        ),
      ),
    ).toBe('EXPERIMENT_PLAN');
    const noConsent = await site('business', { linked: false });
    expect(
      await code(
        st.experiments.start(
          await st.member(noConsent, 'owner'),
          noConsent.siteId,
          body,
        ),
      ),
    ).toBe('EXPERIMENT_NEEDS_CONSENT');
    const lead = await site('business');
    await st.owner.assistSiteGoal.create({
      data: {
        accountId: lead.accountId,
        siteId: lead.siteId,
        key: 'lead',
        template: 'lead',
        name: 'Заявка',
        detectors: [{ kind: 'builtin', config: { event: 'lead' } }],
      },
    });
    expect(
      await code(
        st.experiments.start(await st.member(lead, 'owner'), lead.siteId, {
          ...body,
          goalKey: 'lead',
        }),
      ),
    ).toBe('EXPERIMENT_GOAL');
  });

  it('группа — сервером; повтор без дубля; конверсия единицы; до горизонта итога нет, после — есть', async () => {
    const s = await site('business');
    const owner = await st.member(s, 'owner');
    await trafficFor(s, 8000, 1600);
    const e = await st.experiments.start(owner, s.siteId, {
      kind: 'greeting',
      goalKey: 'order',
      horizonDays: 14,
      variant: {
        uk: 'Вітаю! Підкажу розмір і доставку',
        en: 'Hi! Need help with sizes?',
      },
    });
    const cfg = await st.ai.publicAnalytics(await row(s), new Date());
    expect(cfg?.experiment).toMatchObject({
      id: e.id,
      kind: 'greeting',
      share: 0.5,
    });
    const exp = await st.owner.assistSiteExperiment.findUniqueOrThrow({
      where: { id: e.id },
    });
    const keys = Array.from({ length: 30 }, () => visitKey());
    for (const v of keys) {
      await st.ai.enroll({
        site: await row(s),
        experimentId: e.id,
        v,
        now: new Date(),
      });
    }
    await st.ai.enroll({
      site: await row(s),
      experimentId: e.id,
      v: keys[0],
      now: new Date(),
    });
    expect(
      await st.ai.enroll({
        site: await row(s),
        experimentId: 'other',
        v: keys[1],
        now: new Date(),
      }),
    ).toBe('ignored');
    const units = await st.owner.assistSiteExperimentUnit.findMany({
      where: { experimentId: e.id },
    });
    expect(units).toHaveLength(30);
    for (const u of units) {
      const v = keys.find(
        (k) => visitHashOf(s.siteId, `salt-${s.siteId}`, k) === u.unitHash,
      )!;
      expect(u.arm).toBe(armOf(exp.salt, v, 0.5));
    }
    // Конверсия основной цели посетителем с согласием.
    await st.intake.fromLoader({
      site: s.ctx(),
      hit: hit({ visit: keys[0] }),
      rawIp: null,
    });
    const conv = await st.owner.assistSiteExperimentUnit.findFirstOrThrow({
      where: {
        experimentId: e.id,
        unitHash: visitHashOf(s.siteId, `salt-${s.siteId}`, keys[0]),
      },
    });
    expect(conv.converted).toBe(true);
    // Аудит: конверсия после горизонта (крон ещё не подвёл итог) — не в счёт.
    const late = {
      siteId: s.siteId,
      goalKey: 'order',
      visitHash: visitHashOf(s.siteId, `salt-${s.siteId}`, keys[1]),
    };
    expect(
      await st.ai.markConversion({
        ...late,
        at: new Date(exp.endsAt.getTime() + 1000),
      }),
    ).toBe(false);
    expect(await st.ai.markConversion({ ...late, at: new Date() })).toBe(true);
    // До горизонта — итога нет (без подглядывания), единицы видны.
    await st.experiments.tick(new Date(), st.scope(s));
    const [mid] = await st.experiments.list(owner, s.siteId);
    expect(mid).toMatchObject({ status: 'running', result: null });
    expect(mid.units.a + mid.units.b).toBe(30);
    // Заход 9: подтверждённое сервером срабатывание (вебхук s2s) за срок.
    const g = await st.owner.assistSiteGoal.findFirstOrThrow({
      where: { siteId: s.siteId, key: 'order' },
    });
    await st.owner.assistSiteGoalEvent.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        goalId: g.id,
        occurredAt: new Date(Date.now() + 60_000),
        source: 's2s',
        trust: 'verified',
        attribution: 'unknown',
        orderId: `trust-${e.id}`,
      },
    });
    // Горизонт.
    await st.experiments.tick(
      new Date(Date.now() + 15 * 86_400_000),
      st.scope(s),
    );
    const [done] = await st.experiments.list(owner, s.siteId);
    expect(done.status).toBe('done');
    // Заход 9: доля срабатываний цели «со страницы» за срок (1 из 2).
    expect(done.result!.goalTrust).toEqual({
      total: 2,
      page: 1,
      pageShare: 0.5,
    });
    expect(done.result).toMatchObject({
      nA: expect.any(Number),
      nB: expect.any(Number),
      verdict: 'insufficient_sample',
    });
    expect(done.result!.nA + done.result!.nB).toBe(30);
    expect(
      (await st.ai.publicAnalytics(await row(s), new Date()))?.experiment,
    ).toBeNull();
  });

  it('SRM → «испорчен»; тариф снят → стоп; остановка владельцем — без итога', async () => {
    const a = await site('business');
    await trafficFor(a, 8000, 1600);
    const ea = await st.experiments.start(
      await st.member(a, 'owner'),
      a.siteId,
      {
        kind: 'holdout',
        goalKey: 'order',
        share: 0.1,
      },
    );
    await st.owner.assistSiteExperimentUnit.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({
        experimentId: ea.id,
        unitHash: `srm-${i}`,
        arm: i < 199 ? 'a' : 'b',
      })),
    });
    const r = await st.experiments.tick(new Date(), st.scope(a));
    expect(r.invalid).toBe(1);
    const [inv] = await st.experiments.list(
      await st.member(a, 'owner'),
      a.siteId,
    );
    expect(inv).toMatchObject({
      status: 'invalid',
      stopReason: 'srm',
      result: null,
    });
    expect(inv.srmP!).toBeLessThan(0.001);

    const b = await site('business');
    await trafficFor(b, 8000, 1600);
    await st.experiments.start(await st.member(b, 'owner'), b.siteId, {
      kind: 'holdout',
      goalKey: 'order',
    });
    await st.plan(b, 'start');
    await st.experiments.tick(new Date(), st.scope(b));
    const [stopped] = await st.experiments.list(
      await st.member(b, 'owner'),
      b.siteId,
    );
    expect(stopped).toMatchObject({
      status: 'stopped',
      stopReason: 'plan',
      result: null,
    });

    const c = await site('business');
    await trafficFor(c, 8000, 1600);
    const ow = await st.member(c, 'owner');
    const ec = await st.experiments.start(ow, c.siteId, {
      kind: 'holdout',
      goalKey: 'order',
    });
    const st2 = await st.experiments.stop(ow, c.siteId, ec.id);
    expect(st2).toMatchObject({
      status: 'stopped',
      stopReason: 'owner',
      result: null,
    });
  });

  it('forget посетителя: его единицы экспериментов удаляются вместе с диалогами (§5-тер.15)', async () => {
    const s = await site('business');
    await trafficFor(s, 8000, 1600);
    const e = await st.experiments.start(
      await st.member(s, 'owner'),
      s.siteId,
      {
        kind: 'holdout',
        goalKey: 'order',
      },
    );
    const conv = await st.conversation(s);
    const v = visitKey();
    const vh = visitHashOf(s.siteId, `salt-${s.siteId}`, v);
    await st.owner.assistSiteConversation.update({
      where: { id: conv.id },
      data: { visitHash: vh },
    });
    await st.ai.enroll({
      site: await row(s),
      experimentId: e.id,
      v,
      now: new Date(),
    });
    await st.ai.enroll({
      site: await row(s),
      experimentId: e.id,
      v: visitKey(),
      now: new Date(),
    });
    expect(
      await st.owner.assistSiteExperimentUnit.count({
        where: { experimentId: e.id },
      }),
    ).toBe(2);
    const state = new WidgetStateService(
      st.chat.publicDb,
      {} as never,
      {} as never,
      {} as never,
      { enqueue: async () => undefined } as never,
    );
    const r = await state.forget({
      site: s.ctx(),
      visitor: { visitorId: conv.visitorId, ipHash: 'ip' },
    } as unknown as VisitorContext);
    expect(r.conversationsDeleted).toBe(1);
    const left = await st.owner.assistSiteExperimentUnit.findMany({
      where: { experimentId: e.id },
    });
    expect(left).toHaveLength(1);
    expect(left[0].unitHash).not.toBe(vh);
  });

  it('заход 9: forget с ключом визита удаляет и единицу без диалога (holdout a, не писал); чужой/битый ключ — ничего', async () => {
    const s = await site('business');
    await trafficFor(s, 8000, 1600);
    const e = await st.experiments.start(
      await st.member(s, 'owner'),
      s.siteId,
      { kind: 'holdout', goalKey: 'order' },
    );
    const mine = visitKey();
    const other = visitKey();
    for (const v of [mine, other]) {
      await st.ai.enroll({
        site: await row(s),
        experimentId: e.id,
        v,
        now: new Date(),
      });
    }
    const units = () =>
      st.owner.assistSiteExperimentUnit.findMany({
        where: { experimentId: e.id },
        select: { unitHash: true },
      });
    expect(await units()).toHaveLength(2);
    const state = new WidgetStateService(
      st.chat.publicDb,
      {} as never,
      {} as never,
      {} as never,
      { enqueue: async () => undefined } as never,
    );
    // Посетитель открыл чат (сессия есть), но не писал — диалога нет.
    const ctx = {
      site: s.ctx(),
      visitor: { visitorId: `v-${randomUUID()}`, ipHash: 'ip' },
    } as unknown as VisitorContext;
    expect((await state.forget(ctx, 'not a key')).conversationsDeleted).toBe(0);
    expect(await units()).toHaveLength(2);
    await state.forget(ctx, mine);
    expect((await units()).map((u) => u.unitHash)).toEqual([
      visitHashOf(s.siteId, `salt-${s.siteId}`, other),
    ]);
  });

  it('конфиг загрузчика: без связанного режима — нет поля; поведение — только при настройке и тарифе', async () => {
    const off = await site('business', { linked: false });
    expect(await st.ai.publicAnalytics(await row(off), new Date())).toBeNull();
    const start = await site('start', { linked: true, behavior: true });
    expect(
      await st.ai.publicAnalytics(await row(start), new Date()),
    ).toBeNull();
    const biz = await site('business', {
      linked: true,
      behavior: true,
      linkedGcm: true,
    });
    expect(await st.ai.publicAnalytics(await row(biz), new Date())).toEqual({
      consent: { gcm: true },
      behavior: true,
      experiment: null,
    });
  });
});
