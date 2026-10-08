/**
 * Приёмка Э3-бис (а) — находки недели, выводы модели с проверкой чисел,
 * «Сделано» → до/после, калибровка score (ТЗ §5-тер.4–5, §5-тер.16 п.11).
 */
import { randomUUID } from 'crypto';
import type { ChatSite } from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  RUN_CODE,
  lastWeekStart,
  rawFirstDay,
} from '../../modules/assist-analytics/ai/insights.service';
import {
  addDays,
  dayInTz,
  dayRangeUtc,
} from '../../modules/assist-analytics/site-time';
import {
  dryFindingLine,
  type Finding,
} from '../../modules/assist-analytics/ai/findings';
import { AiStack } from '../../modules/assist-analytics/testing/ai-stack.testing';
import { TextModelError } from '../../modules/site-ai/text-model';
import { estimateCost } from '../../shared/ai-pricing';

jest.setTimeout(120_000);

const TZ = 'Europe/Kyiv';

describeDb('Приёмка Э3-бис (а): выводы недели и калибровка', () => {
  const st = new AiStack();
  beforeAll(async () => {
    await st.init();
  });
  afterAll(async () => {
    await st.close();
  });

  const now = new Date();
  const week = lastWeekStart(now, TZ);
  const midWeek = new Date(
    dayRangeUtc(addDays(week, 2), TZ).start.getTime() + 12 * 3600_000,
  );

  /** Размеченный диалог прошедшей недели (основной ролью, как после крона). */
  async function labeled(
    s: ChatSite,
    p: {
      page?: string;
      failureReason?: string | null;
      score?: number;
      visitHash?: string | null;
      createdAt?: Date;
      question?: string;
      /** Заход 10: темы разметки, «не по теме», время ответа помощника. */
      topics?: string[];
      intent?: string;
      answeredAt?: Date;
    } = {},
  ): Promise<string> {
    const createdAt = p.createdAt ?? midWeek;
    const c = await st.owner.assistSiteConversation.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        visitorId: `v-${randomUUID()}`,
        ipHash: 'ip',
        parentOrigin: s.origin,
        pageUrl: s.url(p.page ?? '/product/sneakers'),
        createdAt,
        lastMessageAt: new Date(createdAt.getTime() + 60_000),
        visitHash: p.visitHash ?? null,
      },
    });
    await st.owner.assistSiteMessage.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        conversationId: c.id,
        role: 'visitor',
        text: p.question ?? 'Є 44 розмір? Мій номер +380671234567',
        createdAt,
      },
    });
    if (p.answeredAt) {
      await st.owner.assistSiteMessage.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          conversationId: c.id,
          role: 'assistant',
          text: 'Так, є.',
          // Строка ответа создаётся вместе с вопросом, готов — позже
          // (время ответа N1 — завершение, аудит P3-4).
          createdAt,
          updatedAt: p.answeredAt,
          streamState: 'complete',
        },
      });
    }
    const score = p.score ?? 40;
    await st.owner.assistSiteConversationLabel.create({
      data: {
        conversationId: c.id,
        accountId: s.accountId,
        siteId: s.siteId,
        status: 'ok',
        promptVersion: 'label-v1',
        intent: p.intent ?? 'availability',
        stage: 'decide',
        outcome: p.failureReason ? 'unresolved' : 'resolved',
        failureReason: p.failureReason ?? null,
        leadScore: score,
        leadBucket: score >= 60 ? 'hot' : score >= 30 ? 'warm' : 'cold',
        buyingSignals: [],
        qualityFlags: [],
        topics: p.topics ?? [],
        entities: [],
      },
    });
    return c.id;
  }

  async function site(plan: 'business' | 'start' | 'pro'): Promise<ChatSite> {
    const s = await st.site();
    await st.plan(s, plan);
    await st.analytics(s, { linked: true, linkedWindowDays: 7 });
    return s;
  }

  async function seedN3(s: ChatSite): Promise<void> {
    for (let i = 0; i < 40; i++) {
      await labeled(s, {
        failureReason:
          i < 10 ? 'out_of_stock' : i < 14 ? 'price_too_high' : null,
      });
    }
  }

  it('Business: находка N3 кодом + вывод модели с числами находки; повторный тик недели не зовёт модель', async () => {
    const s = await site('business');
    await seedN3(s);
    st.text.queue.push((req) => {
      // Примеры — только замаскированные (вход модели).
      expect(req.user).not.toMatch(/380671234567/);
      const f = JSON.parse(/<findings>(.*)<\/findings>/s.exec(req.user)![1]);
      const n3 = f.findIndex(
        (x: { code: string; reason: string }) =>
          x.code === 'N3' && x.reason === 'out_of_stock',
      );
      return JSON.stringify({
        insights: [
          {
            findingIds: [n3],
            title: 'Нет нужного размера',
            what: `На /product/sneakers 10 из 40 диалогов без конверсии (25%) — нет в наличии.`,
            action: 'Покажите наличие размеров на карточке товара.',
          },
        ],
      });
    });
    const before = st.text.calls.length;
    const r = await st.weekly.tick({
      now,
      deadline: Date.now() + 30_000,
      maxSites: 5,
      scope: st.scope(s),
    });
    expect(r.sites).toBe(1);
    expect(st.text.calls.length - before).toBe(1);
    const rows = await st.owner.assistSiteInsight.findMany({
      where: { siteId: s.siteId, weekStart: week },
    });
    const n3 = rows.find(
      (x) =>
        x.code === 'N3' &&
        (x.finding as { reason: string }).reason === 'out_of_stock',
    );
    expect(n3).toBeDefined();
    expect(n3!.finding).toMatchObject({
      n: 40,
      x: 10,
      share: 0.25,
      page: '/product/sneakers',
    });
    expect(n3!.text).toMatchObject({ title: 'Нет нужного размера' });
    expect(rows.some((x) => x.code === RUN_CODE)).toBe(true);
    const usage = await st.owner.siteAiUsage.count({
      where: { siteId: s.siteId, operation: 'assist-insight' },
    });
    expect(usage).toBe(1);
    // Повтор — неделя уже обработана: ни модели, ни новых строк.
    await st.weekly.tick({
      now,
      deadline: Date.now() + 30_000,
      maxSites: 5,
      scope: st.scope(s),
    });
    expect(st.text.calls.length - before).toBe(1);
  });

  it('подменённый ответ с числом, которого нет в находках, — вывод выброшен, находка сухой строкой', async () => {
    const s = await site('business');
    await seedN3(s);
    st.text.queue.push(
      JSON.stringify({
        insights: [
          {
            findingIds: [0],
            title: 'Рост',
            what: 'Конверсия вырастет на 37%',
            action: 'Сделайте X',
          },
        ],
      }),
    );
    await st.weekly.runSite(s.accountId, s.siteId, week, now);
    const rows = await st.owner.assistSiteInsight.findMany({
      where: { siteId: s.siteId, weekStart: week, code: { not: RUN_CODE } },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.text === null)).toBe(true);
    expect(rows.some((x) => x.textSkipped === 'numbers')).toBe(true);
    const m = await st.member(s, 'owner');
    const view = await st.cabinet.insights(m, s.siteId, week);
    expect(view.items.every((i) => i.code !== RUN_CODE)).toBe(true);
    expect(view.items[0].text).toBeNull();
  });

  it('оплаченный сбой (truncated со spent) — расход assist-insight фактом, резерв закрыт им; timeout — без расхода; находки сухие в обоих', async () => {
    const run = async (fail: 'truncated' | 'timeout') => {
      const s = await site('business');
      await seedN3(s);
      let model = '';
      if (fail === 'timeout') st.text.queue.push('timeout');
      else
        st.text.queue.push((req) => {
          model = req.model ?? '';
          throw new TextModelError('truncated', {
            model,
            inputTokens: 2500,
            cachedInputTokens: 0,
            outputTokens: 1300,
          });
        });
      await st.weekly.runSite(s.accountId, s.siteId, week, now);
      const rows = await st.owner.assistSiteInsight.findMany({
        where: { siteId: s.siteId, weekStart: week, code: { not: RUN_CODE } },
      });
      // Для владельца — как при любом сбое модели: находки без текста.
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((x) => x.text === null)).toBe(true);
      expect(rows.every((x) => x.textSkipped === 'model')).toBe(true);
      const usage = await st.owner.siteAiUsage.findMany({
        where: { siteId: s.siteId, operation: 'assist-insight' },
      });
      const status = await st.budget.status(s.accountId, s.siteId, now);
      return { model, usage, spent: status.spentMicroUsd };
    };
    const paid = await run('truncated');
    expect(paid.model).toBeTruthy();
    const fact = estimateCost(paid.model, {
      inputTokens: 2500,
      outputTokens: 1300,
    }).costMicroUsd;
    expect(fact).toBeGreaterThan(0);
    expect(paid.usage).toHaveLength(1);
    expect(paid.usage[0]).toMatchObject({
      model: paid.model,
      inputTokens: 2500,
      outputTokens: 1300,
      costMicroUsd: fact,
    });
    expect(paid.spent).toBe(fact);
    const free = await run('timeout');
    expect(free.usage).toHaveLength(0);
    expect(free.spent).toBe(0);
  });

  it('аудит: e-mail/номер заказа в пути — во вход модели путь :id (страницы склеены); внешняя ссылка в выводе — сухая строка', async () => {
    const s = await site('business');
    for (let i = 0; i < 40; i++) {
      await labeled(s, {
        page: `/orders/${7_000_000 + i}/ivan${i}@example.com`,
        failureReason: i < 10 ? 'out_of_stock' : null,
      });
    }
    st.text.queue.push((req) => {
      expect(req.user).not.toMatch(/7000\d{3}|@example|ivan/);
      const f = JSON.parse(/<findings>(.*)<\/findings>/s.exec(req.user)![1]);
      const n3 = f.findIndex(
        (x: { code: string; page: string | null }) =>
          x.code === 'N3' && x.page === '/orders/:id/:id',
      );
      expect(n3).toBeGreaterThanOrEqual(0);
      expect(f[n3]).toMatchObject({ n: 40, x: 10 });
      // Примеры вопросов к находке страницы — нашлись по нормализованному пути.
      expect(f[n3].examples.length).toBeGreaterThan(0);
      return JSON.stringify({
        insights: [
          {
            findingIds: [n3],
            title: 'Нет в наличии',
            what: 'На /orders/:id/:id 10 из 40 диалогов — нет в наличии.',
            action: 'Подробная инструкция — на evil-helper.com',
          },
        ],
      });
    });
    await st.weekly.runSite(s.accountId, s.siteId, week, now);
    const rows = await st.owner.assistSiteInsight.findMany({
      where: { siteId: s.siteId, weekStart: week, code: 'N3' },
    });
    const n3 = rows.find(
      (x) => (x.finding as { page: string | null }).page === '/orders/:id/:id',
    );
    expect(n3).toMatchObject({ text: null, textSkipped: 'links' });
  });

  it('Start: находки кодом без модели (textSkipped = plan)', async () => {
    const s = await site('start');
    await seedN3(s);
    const before = st.text.calls.length;
    await st.weekly.runSite(s.accountId, s.siteId, week, now);
    expect(st.text.calls.length).toBe(before);
    const rows = await st.owner.assistSiteInsight.findMany({
      where: { siteId: s.siteId, weekStart: week, code: { not: RUN_CODE } },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.textSkipped === 'plan')).toBe(true);
  });

  it('«Сделано» → через 14 дней сравнение до/после; 👍 и неверная отметка', async () => {
    const s = await site('business');
    await seedN3(s);
    await st.weekly.runSite(s.accountId, s.siteId, week, now);
    const m = await st.member(s, 'manager');
    const [first] = (await st.cabinet.insights(m, s.siteId, week)).items;
    await st.cabinet.patchInsight(m, s.siteId, first.id, {
      status: 'done',
      feedback: 1,
    });
    await expect(
      st.cabinet.patchInsight(m, s.siteId, first.id, { status: 'archived' }),
    ).rejects.toMatchObject({ status: 400 });
    await st.owner.assistSiteInsight.update({
      where: { id: first.id },
      data: { doneAt: new Date(now.getTime() - 15 * 86_400_000) },
    });
    const n = await st.weekly.followUps(s.accountId, s.siteId, TZ, now);
    expect(n).toBe(1);
    const row = await st.owner.assistSiteInsight.findUnique({
      where: { id: first.id },
    });
    expect(row!.feedback).toBe(1);
    expect(row!.followUp).toMatchObject({
      note: 'coincidence_not_proof',
      before: expect.anything(),
    });
  });

  it('Pro: калибровка Platt на известных исходах (≥ 50 конверсий, ≥ 200 диалогов); без согласия «не купил» не идёт', async () => {
    const s = await site('pro');
    const goal = await st.goal(s, {
      key: 'order',
      detectors: [{ kind: 'js', config: {} }],
    });
    const old = new Date(now.getTime() - 20 * 86_400_000);
    for (let i = 0; i < 260; i++) {
      const positive = i < 60;
      const score = positive ? 50 + (i % 40) : 10 + (i % 50);
      const cid = await labeled(s, {
        score,
        createdAt: old,
        // Отрицательные — только связанный режим (иначе «не купил» ненадёжно).
        visitHash: positive || i < 220 ? `vh-${i}` : null,
      });
      if (positive) {
        await st.owner.assistSiteGoalEvent.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            goalId: goal,
            occurredAt: old,
            source: 'iframe',
            trust: 'page',
            attribution: 'direct',
            conversationId: cid,
            clientEventId: `cal-${cid}`,
          },
        });
      }
    }
    const ok = await st.weekly.calibrate(
      s.accountId,
      s.siteId,
      { linked: true, linkedWindowDays: 7 },
      now,
    );
    expect(ok).toBe(true);
    const cal = await st.owner.assistSiteLeadCalibration.findFirst({
      where: { siteId: s.siteId },
    });
    expect(cal).toMatchObject({ method: 'platt', positives: 60, total: 220 });
    expect(cal!.auc).toBeGreaterThan(0.7);
    const m = await st.member(s, 'owner');
    const sum = await st.cabinet.summary(m, s.siteId, {
      from: addDays(week, -30),
      to: addDays(week, 13),
    });
    expect(sum.calibration).toMatchObject({ method: 'platt', version: 1 });
    expect(sum.plan.leadCalibration).toBe(true);
  });

  it('заход 9 (Р-З9-7): выводы — на языке владельца + переводы для участников; каждый язык — своя проверка чисел; экран — на языке читателя', async () => {
    const s = await site('business');
    await seedN3(s);
    const lang = (telegramId: bigint, languageCode: string) =>
      st.owner.assistBotUser.upsert({
        where: { telegramId },
        create: { telegramId, languageCode },
        update: { languageCode },
      });
    const owner = await st.member(s, 'owner');
    const en = await st.member(s, 'manager');
    const ru = await st.member(s, 'manager');
    await lang(owner.telegramId, 'uk');
    await lang(en.telegramId, 'en-GB');
    await lang(ru.telegramId, 'ru');
    let system = '';
    st.text.queue.push((req) => {
      system = req.system;
      const f = JSON.parse(/<findings>(.*)<\/findings>/s.exec(req.user)![1]);
      const n3 = f.findIndex(
        (x: { code: string; reason: string }) =>
          x.code === 'N3' && x.reason === 'out_of_stock',
      );
      return JSON.stringify({
        insights: [
          {
            findingIds: [n3],
            title: 'Немає потрібного розміру',
            what: 'На /product/sneakers 10 із 40 діалогів без конверсії (25%).',
            action: 'Покажіть наявність розмірів на картці товару.',
            i18n: {
              en: {
                title: 'Size out of stock',
                what: 'On /product/sneakers 10 of 40 dialogs had no conversion (25%).',
                action: 'Show size availability on the product card.',
              },
              // Число, которого нет в находках, — перевод выброшен.
              ru: {
                title: 'Нет размера',
                what: 'На /product/sneakers 17 из 40 диалогов без конверсии.',
                action: 'Покажите наличие размеров.',
              },
            },
          },
        ],
      });
    });
    await st.weekly.tick({
      now,
      deadline: Date.now() + 30_000,
      maxSites: 5,
      scope: st.scope(s),
    });
    expect(system).toContain('Write in Ukrainian');
    expect(system).toContain('English ("en")');
    expect(system).toContain('Russian ("ru")');
    // Три языка в одном ответе — потолок ответа втрое (иначе обрезка).
    expect(st.text.calls.at(-1)!.maxOutputTokens).toBe(3600);
    const row = (
      await st.owner.assistSiteInsight.findMany({
        where: { siteId: s.siteId, weekStart: week, code: 'N3' },
      })
    ).find((x) => (x.finding as { reason: string }).reason === 'out_of_stock')!;
    expect(row.text).toMatchObject({
      lang: 'uk',
      title: 'Немає потрібного розміру',
      i18n: { en: { title: 'Size out of stock' } },
    });
    expect(
      (row.text as { i18n: Record<string, unknown> }).i18n.ru,
    ).toBeUndefined();
    const view = async (m: typeof owner, q?: string) =>
      (await st.cabinet.insights(m, s.siteId, week, q)).items.find(
        (x) => x.id === row.id,
      )!;
    expect((await view(owner)).text?.title).toBe('Немає потрібного розміру');
    expect((await view(en)).text?.title).toBe('Size out of stock');
    const r = await view(ru);
    expect(r.text).toBeNull();
    expect(r.textSkipped).toBe('lang');
    // Явный язык экрана важнее языка Telegram.
    expect((await view(ru, 'en')).text?.title).toBe('Size out of stock');
  });

  it('заход 9 (Р-З9-26): visitHash диалогов старше 31 дня обнуляется, флаг «связан» — в разметке; калибровка та же', async () => {
    const s = await site('pro');
    const goal = await st.goal(s, {
      key: 'order',
      detectors: [{ kind: 'js', config: {} }],
    });
    const old = new Date(now.getTime() - 40 * 86_400_000);
    for (let i = 0; i < 260; i++) {
      const positive = i < 60;
      const score = positive ? 50 + (i % 40) : 10 + (i % 50);
      const cid = await labeled(s, {
        score,
        createdAt: old,
        visitHash: positive || i < 220 ? `vh31-${i}` : null,
      });
      if (positive) {
        await st.owner.assistSiteGoalEvent.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            goalId: goal,
            occurredAt: old,
            source: 'iframe',
            trust: 'page',
            attribution: 'direct',
            conversationId: cid,
            clientEventId: `cal31-${cid}`,
          },
        });
      }
    }
    // Свежий связанный диалог (10 дней) — хеш остаётся.
    const fresh = await labeled(s, {
      createdAt: new Date(now.getTime() - 10 * 86_400_000),
      visitHash: 'vh31-fresh',
    });
    const cfg = { linked: true, linkedWindowDays: 7 };
    expect(await st.weekly.calibrate(s.accountId, s.siteId, cfg, now)).toBe(
      true,
    );
    await st.behavior.daily(now, st.scope(s));
    const convs = await st.owner.assistSiteConversation.findMany({
      where: { siteId: s.siteId },
      select: { id: true, visitHash: true },
    });
    expect(convs.filter((c) => c.visitHash !== null).map((c) => c.id)).toEqual([
      fresh,
    ]);
    expect(
      await st.owner.assistSiteConversationLabel.count({
        where: { siteId: s.siteId, linked: true },
      }),
    ).toBe(220);
    expect(await st.weekly.calibrate(s.accountId, s.siteId, cfg, now)).toBe(
      true,
    );
    const cals = await st.owner.assistSiteLeadCalibration.findMany({
      where: { siteId: s.siteId },
      orderBy: { version: 'asc' },
    });
    expect(cals).toHaveLength(2);
    expect(cals[1]).toMatchObject({
      positives: cals[0].positives,
      total: cals[0].total,
      params: cals[0].params,
    });
    expect(cals[0].total).toBe(221);
  });

  // ── заход 10: N1, N9 (сырые просмотры), N11 (версии базы) ─────────────

  /** Итог просмотра (основной ролью, как пишет `/widget/v1/pv`). */
  async function view(
    s: ChatSite,
    p: {
      path: string;
      startedAt: Date;
      totalMs: number;
      chatOpened?: boolean;
      utmCampaign?: string | null;
      prevPath?: string | null;
      scrollMax?: number;
      device?: string;
    },
  ): Promise<void> {
    await st.owner.assistSitePageView.create({
      data: {
        id: `pv-${randomUUID()}`,
        siteId: s.siteId,
        day: p.startedAt.toISOString().slice(0, 10),
        startedAt: p.startedAt,
        path: p.path,
        prevPath: p.prevPath ?? null,
        source: p.utmCampaign ? 'ads' : 'direct',
        utmCampaign: p.utmCampaign ?? null,
        device: p.device ?? 'mobile',
        os: 'ios',
        browser: 'safari',
        scrollMax: p.scrollMax ?? 50,
        totalMs: p.totalMs,
        activeMs: Math.min(p.totalMs, 30_000),
        chatOpened: p.chatOpened ?? false,
      },
    });
  }

  it('заход 10: N1 и N9 — диалог сопоставлен с просмотром (путь, время, чат); «ушёл ≤ 60 с без перехода», кампания UTM; ссылка в названии кампании отброшена', async () => {
    const s = await site('start');
    const SEC = 1000;
    const base = midWeek.getTime();
    // 30 диалогов о доставке на /product/sneakers, все из кампании autumn_sale:
    // 14 закончили просмотр через 20 с после ответа, 2 из них перешли дальше
    // по сайту (не уход) → ушло 12 из 30 (40%); 9 из 30 — «не тот товар».
    for (let i = 0; i < 30; i++) {
      const at = new Date(base + i * 10 * 60 * SEC);
      // Ответ готов через 50 с после вопроса: уход через 20 с после ответа
      // — это 70 с от вопроса (по времени вопроса «ушёл» бы не засчитался).
      const answeredAt = new Date(at.getTime() + 50 * SEC);
      const fast = i < 14;
      const viewStart = new Date(at.getTime() - 30 * SEC);
      const end = fast
        ? answeredAt.getTime() + 20 * SEC
        : answeredAt.getTime() + 5 * 60 * SEC;
      await labeled(s, {
        page: '/product/sneakers?utm_campaign=autumn_sale',
        createdAt: at,
        answeredAt,
        topics: ['доставка'],
        failureReason: i % 10 < 3 ? 'product_mismatch' : null,
      });
      await view(s, {
        path: '/product/sneakers',
        startedAt: viewStart,
        totalMs: end - viewStart.getTime(),
        chatOpened: true,
        utmCampaign: 'autumn_sale',
      });
      if (i < 2) {
        await view(s, {
          path: '/cart',
          prevPath: '/product/sneakers',
          startedAt: new Date(end + 3 * SEC),
          totalMs: 60 * SEC,
        });
      }
    }
    // Диалог без просмотра с чатом — не в выборке N1/N9.
    await labeled(s, {
      createdAt: new Date(base - 3 * 3600 * SEC),
      answeredAt: new Date(base - 3 * 3600 * SEC + 10 * SEC),
      topics: ['доставка'],
    });
    // 80 просмотров кампании без прокрутки и без перехода (уход), один — с
    // переходом дальше (не уход): 30 + 80 = 110 просмотров, 79 уходов (72%).
    for (let i = 0; i < 80; i++) {
      const at = new Date(base + 6 * 3600 * SEC + i * 60 * SEC);
      await view(s, {
        path: '/landing',
        startedAt: at,
        totalMs: 8 * SEC,
        scrollMax: 0,
        utmCampaign: 'autumn_sale',
        device: 'desktop',
      });
      if (i === 0) {
        await view(s, {
          path: '/catalog',
          prevPath: '/landing',
          startedAt: new Date(at.getTime() + 9 * SEC),
          totalMs: 30 * SEC,
          device: 'desktop',
        });
      }
    }
    // Кампания-ссылка (ввод посетителя `?utm_campaign=`) с теми же
    // признаками — не находка: домен не доходит ни до модели, ни до отчёта.
    for (let i = 0; i < 25; i++) {
      const at = new Date(base + 30 * 3600 * SEC + i * 10 * 60 * SEC);
      await labeled(s, {
        page: '/promo',
        createdAt: at,
        answeredAt: new Date(at.getTime() + 10 * SEC),
        failureReason: 'product_mismatch',
      });
      await view(s, {
        path: '/promo',
        startedAt: new Date(at.getTime() - 5 * SEC),
        totalMs: 30 * SEC,
        chatOpened: true,
        scrollMax: 0,
        utmCampaign: 'go.evil.com',
      });
    }
    for (let i = 0; i < 100; i++) {
      await view(s, {
        path: '/promo',
        startedAt: new Date(base + 60 * 3600 * SEC + i * 60 * SEC),
        totalMs: 5 * SEC,
        scrollMax: 0,
        utmCampaign: 'go.evil.com',
      });
    }

    const inp = await st.weekly.inputs(
      s.accountId,
      s.siteId,
      TZ,
      week,
      addDays(week, 6),
      { visits: true },
    );
    expect(inp.afterAnswer).toEqual([
      { page: '/product/sneakers', topic: 'доставка', n: 30, x: 12 },
    ]);
    expect(inp.campaigns).toEqual([
      {
        campaign: 'autumn_sale',
        dialogs: 30,
        mismatch: 9,
        views: 110,
        bounces: 79,
      },
    ]);

    await st.weekly.runSite(s.accountId, s.siteId, week, now);
    const rows = await st.owner.assistSiteInsight.findMany({
      where: { siteId: s.siteId, weekStart: week, code: { in: ['N1', 'N9'] } },
    });
    const n1 = rows.find((r) => r.code === 'N1')!;
    const n9 = rows.find((r) => r.code === 'N9')!;
    expect(n1.finding).toMatchObject({
      n: 30,
      x: 12,
      share: 0.4,
      page: '/product/sneakers',
      topic: 'доставка',
    });
    expect(n9.finding).toMatchObject({
      n: 30,
      x: 9,
      share: 0.3,
      campaign: 'autumn_sale',
      value: 72,
    });
    expect(rows).toHaveLength(2);
    expect(dryFindingLine(n9.finding as unknown as Finding, 'uk')).toBe(
      'Кампанія «autumn_sale»: 9 з 30 діалогів — не той товар або не за темою (30%), 72% переглядів — відхід без прокрутки',
    );
  });

  it('заход 10: N11 — страница, изменённая версией базы прошлой недели: доля просмотров с чатом до/после; первая версия и неизменённые страницы — нет', async () => {
    const s = await site('start');
    const src = await st.owner.assistSiteSource.create({
      data: { accountId: s.accountId, siteId: s.siteId, kind: 'crawl' },
    });
    // Версия опубликована в среду недели ДО анализируемой.
    const pubDay = addDays(week, -5);
    const created = new Date(
      dayRangeUtc(pubDay, TZ).start.getTime() + 9 * 3600_000,
    );
    const published = new Date(created.getTime() + 20 * 60_000);
    await st.owner.assistSiteKnowledgeVersion.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        number: 1001,
        parentNumber: 1000,
        trigger: 'crawl',
        status: 'published',
        createdAt: created,
        publishedAt: published,
      },
    });
    // Первая версия сайта (без родителя) той же недели — не «изменение».
    await st.owner.assistSiteKnowledgeVersion.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        number: 999,
        trigger: 'crawl',
        status: 'published',
        createdAt: new Date(created.getTime() - 3 * 86_400_000),
        publishedAt: new Date(created.getTime() - 3 * 86_400_000 + 60_000),
      },
    });
    const doc = (ref: string, indexedAt: Date) =>
      st.owner.assistSiteDocument.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          sourceId: src.id,
          ref,
          kind: 'page',
          url: s.url(ref),
          status: 'active',
          indexedAt,
        },
      });
    await doc('/oplata', new Date(created.getTime() + 5 * 60_000));
    await doc('/dostavka', new Date(created.getTime() + 6 * 60_000));
    // Переиндексирована первой версией — к версии 1001 отношения не имеет.
    await doc(
      '/kontakty',
      new Date(created.getTime() - 3 * 86_400_000 + 30_000),
    );
    const daily = async (
      path: string,
      from: string,
      to: string,
      views: number,
      chats: number,
    ) => {
      for (let d = from; d <= to; d = addDays(d, 1)) {
        await st.owner.assistSiteDailyPage.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            day: d,
            path,
            views,
            chatOpens: chats,
          },
        });
      }
    };
    const weekEnd = addDays(week, 6);
    // /oplata: до — 14 × 30 просмотров, по 1 чату (≈ 3.3%); после — по 5.
    await daily('/oplata', addDays(pubDay, -14), addDays(pubDay, -1), 30, 1);
    await daily('/oplata', addDays(pubDay, 1), weekEnd, 30, 5);
    // /dostavka изменилась, но доля чата та же — не находка.
    await daily('/dostavka', addDays(pubDay, -14), addDays(pubDay, -1), 30, 3);
    await daily('/dostavka', addDays(pubDay, 1), weekEnd, 30, 3);
    // /kontakty — тот же сдвиг, но страница не менялась этой версией.
    await daily('/kontakty', addDays(pubDay, -14), addDays(pubDay, -1), 30, 1);
    await daily('/kontakty', addDays(pubDay, 1), weekEnd, 30, 5);

    const inp = await st.weekly.inputs(
      s.accountId,
      s.siteId,
      TZ,
      week,
      weekEnd,
      {
        changes: true,
      },
    );
    const after = 11; // четверг–воскресенье прошлой недели + 7 дней
    expect(
      inp.pageChanges?.sort((a, b) => a.page.localeCompare(b.page)),
    ).toEqual([
      {
        page: '/dostavka',
        changedAt: dayInTz(published, TZ),
        version: 1001,
        before: { views: 420, chatOpens: 42 },
        after: { views: 30 * after, chatOpens: 3 * after },
      },
      {
        page: '/oplata',
        changedAt: dayInTz(published, TZ),
        version: 1001,
        before: { views: 420, chatOpens: 14 },
        after: { views: 30 * after, chatOpens: 5 * after },
      },
    ]);

    await st.weekly.runSite(s.accountId, s.siteId, week, now);
    const rows = await st.owner.assistSiteInsight.findMany({
      where: { siteId: s.siteId, weekStart: week, code: 'N11' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].findingKey).toBe('N11:/oplata:v1001');
    expect(rows[0].finding).toMatchObject({
      page: '/oplata',
      changedAt: pubDay,
      n: 330,
      x: 55,
      base: 0.0333,
    });
    // Неделя спустя та же версия уже не «прошлой недели» — повтора нет.
    const next = addDays(week, 7);
    const later = await st.weekly.inputs(
      s.accountId,
      s.siteId,
      TZ,
      next,
      addDays(next, 6),
      {
        changes: true,
      },
    );
    expect(later.pageChanges).toEqual([]);
  });

  it('аудит P2-3: сверка N1/N9 через 14 дней — фактическое окно (сырые просмотры 7 дней) и n; мало данных — after: null с причиной', async () => {
    const s = await site('start');
    const row = await st.owner.assistSiteInsight.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        weekStart: week,
        code: 'N1',
        findingKey: 'N1:/product/sneakers:доставка',
        finding: {
          code: 'N1',
          n: 30,
          x: 12,
          share: 0.4,
          page: '/product/sneakers',
          topic: 'доставка',
        },
        impact: 'high',
        status: 'done',
        doneAt: new Date(now.getTime() - 15 * 86_400_000),
      },
    });
    expect(await st.weekly.followUps(s.accountId, s.siteId, TZ, now)).toBe(1);
    const got = await st.owner.assistSiteInsight.findUniqueOrThrow({
      where: { id: row.id },
    });
    const doneDay = dayInTz(new Date(now.getTime() - 15 * 86_400_000), TZ);
    expect(got.followUp).toMatchObject({
      from: rawFirstDay(now, TZ),
      to: addDays(doneDay, 13),
      n: null,
      after: null,
      reason: 'insufficient_data',
      before: { x: 12, n: 30, share: 0.4 },
    });
    expect((got.followUp as { from: string }).from > doneDay).toBe(true);
  });
});
