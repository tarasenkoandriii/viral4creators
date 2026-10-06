/**
 * Приёмка Э6-тер (и) «Компенсации» на реальном Postgres (ТЗ помощника
 * §5-бис.15 п.6, п.8, п.13 п.2–4, 7 — серверная часть; Р-59, Р-64…Р-66):
 * публичный код — под ролью assist_public (как в проде), кабинет карты —
 * основной ролью, модель — подделка.
 *  - стек компенсаций — в шагах плана (обратная цель, страница, строка —
 *    без значений; виджету в плане не уходит);
 *  - «Вернуть» — по одному шагу в обратном порядке: компенсация сначала
 *    `dispatched` (один раз), затем итог; продолжение после перехода на
 *    страницу отмены (`next`); сбой — стоп остальных
 *    (`partially_compensated`); отданная без итога — `unknown`, без повтора;
 *  - пара — только объявленная: стандартная разметка или «Как отменить»
 *    карты; «Видалити» без разметки — не компенсация; после ТН — ничего;
 *  - окно — 10 мин (+60 с на отчёт), `degraded` — 0 компенсаций;
 *  - мастер Т-2 предупреждает о неразрешимых обратных целях.
 * Браузерная часть (поиск строки того же товара, стоп-лист живой цели,
 * переход на страницу отмены, «Повернути/Залишити») — e2e виджета
 * `voice-control-compensations.spec.ts` и `widget/scripts/comp.test.ts`.
 * Глобальных проходов по базе нет — без `serializeDbTests`.
 */
import { HttpException } from '@nestjs/common';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { SiteVoiceService } from '../../modules/assist-site-voice/public/site-voice.service';
import { SiteSonioxStt } from '../../modules/assist-site-voice/public/soniox-stt.client';
import { SiteSonioxTts } from '../../modules/assist-site-voice/public/soniox-tts.client';
import { FakeSoniox } from '../../modules/assist-site-voice/testing/fake-soniox.testing';
import type {
  UiPlanRequest,
  UiPlanView,
} from '../../modules/assist-site-voice-control/api-types';
import { VoiceControlSettingsService } from '../../modules/assist-site-voice-control/cabinet/voice-control-settings.service';
import {
  SiteUiPlanService,
  UiPlanError,
  UNDO_REPORT_WINDOW_MS,
  type UiPlanCtx,
} from '../../modules/assist-site-voice-control/public/ui-plan.service';
import { clearVoiceMapCache } from '../../modules/assist-site-voice-control/public/voice-map-store';
import { VoiceTestService } from '../../modules/assist-site-voice-control/public/voice-test.service';
import { VoiceMapService } from '../../modules/assist-site-voice-map/voice-map.service';
import { GeminiText } from '../../modules/site-ai/text-model';
import type { AccountMembership } from '../../modules/site-core/account/roles';
import { SitesDb } from '../../prisma/sites-db.service';

jest.setTimeout(300_000);

describeDb('Приёмка Э6-тер (и) — компенсации', () => {
  const st = new ChatStack();
  const fake = new FakeSoniox();
  let plans: SiteUiPlanService;
  let tests: VoiceTestService;
  let cab: VoiceControlSettingsService;
  let maps: VoiceMapService;
  let env: NodeJS.ProcessEnv;
  let modelReply = '{"command": true, "steps": []}';

  beforeAll(async () => {
    await st.init();
    env = {
      ...st.env,
      SONIOX_API_KEY: 'sx-test',
      ASSIST_VOICE_ENABLED: 'true',
      ASSIST_BOT_TOKEN: 'bot-test',
      ASSIST_TMA_URL: 'https://tma.example.invalid',
    };
    const stt = new SiteSonioxStt();
    stt.fetch = fake.fetch;
    stt.env = env;
    const tts = new SiteSonioxTts();
    tts.fetch = fake.fetch;
    tts.env = env;
    const voice = new SiteVoiceService(
      st.publicDb,
      st.budget,
      st.usage,
      stt,
      tts,
    );
    voice.env = env;
    const model = new GeminiText().useClient({
      models: {
        generateContent: async () => ({
          text: modelReply,
          usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 30 },
        }),
      },
    } as never);
    plans = new SiteUiPlanService(
      st.publicDb,
      st.budget,
      st.usage,
      model,
      voice,
    );
    plans.env = env;
    tests = new VoiceTestService(st.publicDb, plans);
    cab = new VoiceControlSettingsService(new SitesDb(st.owner), st.owner);
    cab.env = env;
    maps = new VoiceMapService(new SitesDb(st.owner));
  });
  afterAll(async () => {
    await st.close();
  });
  beforeEach(() => {
    modelReply = '{"command": true, "steps": []}';
    plans.now = () => new Date();
    clearVoiceMapCache();
  });

  async function vcSite(): Promise<ChatSite> {
    const s = await st.site({ name: 'Магазин' });
    await setPlan(st.owner, s.accountId, 'business');
    await st.owner.siteHost.updateMany({
      where: { siteId: s.siteId },
      data: { expiresAt: new Date(Date.now() + 30 * 86_400_000) },
    });
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: {
        voiceConfig: { schema: 1, input: true, output: false, voiceId: null },
        voiceControlSiteState: 'on',
      },
    });
    return s;
  }

  async function owner(s: ChatSite): Promise<AccountMembership> {
    const m = await st.owner.siteAccountMember.findFirst({
      where: { accountId: s.accountId, role: 'owner' },
      orderBy: { createdAt: 'asc' },
    });
    return {
      accountId: s.accountId,
      memberId: m!.id,
      telegramId: m!.telegramId,
      role: 'owner',
      productRoles: m!.productRoles as AccountMembership['productRoles'],
    };
  }

  const ctxOf = (s: ChatSite, visitor = st.visitor()): UiPlanCtx => ({
    site: s.ctx(),
    visitor,
  });

  const TITLE = 'Футболка синя';
  /** Страница товара: размер (в форме), «В кошик», «Кошик», подарунок, заявка, «Видалити» без разметки. */
  const product = (s: ChatSite, o: { heading?: string | null } = {}) => {
    const heading = o.heading === undefined ? TITLE : o.heading;
    return {
      url: s.url('/product/1'),
      title: 'Футболка — Магазин',
      elements: [
        {
          ref: 'e1',
          role: 'combobox',
          tag: 'select',
          text: 'Розмір',
          options: ['S', 'M', 'L'],
          inForm: true,
          heading,
          inView: true,
        },
        {
          ref: 'e2',
          role: 'button',
          tag: 'button',
          text: 'В кошик',
          assistId: 'add-to-cart',
          heading,
          inView: true,
        },
        {
          ref: 'e3',
          role: 'link',
          tag: 'a',
          text: 'Кошик',
          assistId: 'nav-cart',
          href: s.url('/cart/'),
          inView: true,
        },
        {
          ref: 'e4',
          role: 'button',
          tag: 'button',
          text: 'Додати подарунок',
          assistId: 'gift',
          heading,
          inView: true,
        },
        {
          ref: 'e5',
          role: 'link',
          tag: 'a',
          text: 'Залишити заявку',
          href: s.url('/request'),
          inView: true,
        },
        {
          ref: 'e6',
          role: 'button',
          tag: 'button',
          text: 'Надіслати заявку',
          submit: true,
          inForm: true,
          inView: true,
        },
        {
          ref: 'e7',
          role: 'button',
          tag: 'button',
          text: 'Видалити',
          heading,
          inView: true,
        },
      ],
    };
  };

  const typed = (snapshot: unknown, text: string): UiPlanRequest => ({
    text,
    source: 'typed',
    lang: 'uk',
    snapshot,
  });
  const create = (ctx: UiPlanCtx, body: UiPlanRequest) =>
    plans.create(ctx, body, async () => true);

  async function failure(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      if (e instanceof UiPlanError) return e.failure;
      if (e instanceof HttpException) return String(e.getStatus());
      throw e;
    }
    return 'ok';
  }

  async function run(
    ctx: UiPlanCtx,
    v: UiPlanView,
    idx: number,
    url: string,
  ): Promise<UiPlanView> {
    const s = v.steps[idx];
    const effect =
      s.nav || ['click', 'fill', 'select', 'check'].includes(s.kind);
    let r = v;
    if (effect) {
      r = await plans.step(ctx, v.planId!, {
        index: idx,
        result: 'dispatched',
        url,
      });
      if (r.status === 'proposed') return r;
    }
    return plans.step(ctx, v.planId!, { index: idx, result: 'done', url });
  }

  /** «Розмір M → В кошик → (сбой на 3-м)»: цепочка `kept` с полем и корзиной. */
  async function brokenChain(
    s: ChatSite,
    ctx: UiPlanCtx,
    o: { heading?: string | null; second?: string } = {},
  ): Promise<UiPlanView> {
    modelReply = JSON.stringify({
      command: true,
      steps: [
        { kind: 'select', target: 'e1', value: 'M' },
        { kind: 'click', target: o.second ?? 'e2' },
        { kind: 'click', target: 'e5' },
      ],
    });
    let v = await create(
      ctx,
      typed(product(s, o), 'вибери розмір M, додай в кошик і відкрий заявку'),
    );
    if (v.status === 'proposed')
      v = await plans.confirm(ctx, v.planId!, {
        by: 'button',
        stepsHash: v.stepsHash!,
      });
    v = await run(ctx, v, 0, s.url('/product/1'));
    v = await run(ctx, v, 1, s.url('/product/1'));
    v = await plans.step(ctx, v.planId!, {
      index: 2,
      result: 'failed',
      reason: 'no_target',
      url: s.url('/product/1'),
    });
    expect(v).toMatchObject({ status: 'failed', chainStatus: 'kept' });
    return v;
  }

  const logs = (siteId: string) =>
    st.owner.assistSiteUiActionLog.findMany({
      where: { siteId, action: 'undo' },
      orderBy: { createdAt: 'asc' },
    });
  const units = async (accountId: string) =>
    (
      await st.owner.assistAccountUsage.findMany({ where: { accountId } })
    ).reduce((a, u) => a + u.units, 0);

  it('п.2/п.3: «Вернуть» → корзина компенсацией (стандартная разметка, страница отмены `/cart/`, после перехода — `next`), `dispatched` один раз, затем поле → compensated; журнал без значений; единицы не тратятся', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const v = await brokenChain(s, ctx);
    // Стек — на сервере: виджету в плане обратная цель не уходит.
    expect(v.steps[1]).not.toHaveProperty('comp');
    const row = await st.owner.assistSiteUiPlan.findUniqueOrThrow({
      where: { id: v.planId! },
    });
    expect((row.steps as Array<Record<string, unknown>>)[1].comp).toEqual({
      assistId: 'remove-from-cart',
      at: '/cart/',
      row: TITLE,
      src: 'standard',
    });
    const before = await units(s.accountId);

    const u = await plans.undo(ctx, v.planId!, { by: 'offer' });
    expect(u.refused).toBeNull();
    // Обратный порядок: сначала корзина (шаг 1), поле (шаг 0) — потом.
    expect(u.fields).toEqual([]);
    expect(u.manual).toEqual([]);
    expect(u.comp).toEqual({
      i: 1,
      text: 'В кошик',
      row: TITLE,
      assistId: 'remove-from-cart',
      at: '/cart/',
      variant: ['M'],
      allow: ['remove'],
      dispatched: false,
    });
    // Итог до отметки «начат» — не принимается (действия ещё не было).
    expect(
      await failure(
        plans.undoReport(ctx, v.planId!, {
          results: [{ i: 1, result: 'done' }],
        }),
      ),
    ).toBe('bad_request');
    // Переход на страницу отмены: на новой странице — та же компенсация.
    const nx = await plans.undoReport(ctx, v.planId!, { next: true });
    expect(nx.comp).toMatchObject({ i: 1, dispatched: false });
    // Чужой номер / поле вместо компенсации — конфликт.
    expect(
      await failure(plans.undoReport(ctx, v.planId!, { dispatch: 0 })),
    ).toBe('conflict');
    const d = await plans.undoReport(ctx, v.planId!, { dispatch: 1 });
    expect(d.comp).toMatchObject({ i: 1, dispatched: true });
    // Второй раз «начат» не записывается (§4-бис.5).
    expect(
      await failure(plans.undoReport(ctx, v.planId!, { dispatch: 1 })),
    ).toBe('conflict');
    const r1 = await plans.undoReport(ctx, v.planId!, {
      results: [{ i: 1, result: 'done' }],
    });
    expect(r1.comp).toBeNull();
    expect(r1.fields).toEqual([{ i: 0, text: 'Розмір' }]);
    expect(r1.chainStatus).toBe('kept');
    const r2 = await plans.undoReport(ctx, v.planId!, {
      results: [{ i: 0, result: 'done' }],
    });
    expect(r2.chainStatus).toBe('compensated');
    // Журнал: предложено → «начат» → итог корзины → итог поля; без значений.
    const l = await logs(s.siteId);
    expect(l.map((x) => [x.result, x.reason, x.undoOf, x.stepIndex])).toEqual([
      ['proposed', 'fields:1,manual:0,comp:1', null, 2],
      ['dispatched', 'comp', 1, 1],
      ['done', null, 1, 1],
      ['done', null, 0, 0],
    ]);
    expect(l.every((x) => x.valueMasked === null)).toBe(true);
    expect(JSON.stringify(l)).not.toContain('"M"');
    expect(await units(s.accountId)).toBe(before);
    // Повтор — нечего / конфликт.
    expect((await plans.undo(ctx, v.planId!, { by: 'offer' })).refused).toBe(
      'nothing',
    );
    expect(
      await failure(plans.undoReport(ctx, v.planId!, { next: true })),
    ).toBe('conflict');
  });

  it('п.7: сбой компенсации (обратной кнопки нет) — стоп остальных: поле не возвращается, partially_compensated, повторов нет', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const v = await brokenChain(s, ctx);
    await plans.undo(ctx, v.planId!, { by: 'offer' });
    await plans.undoReport(ctx, v.planId!, { dispatch: 1 });
    const r = await plans.undoReport(ctx, v.planId!, {
      results: [{ i: 1, result: 'gone' }],
    });
    expect(r).toMatchObject({
      fields: [],
      comp: null,
      chainStatus: 'partially_compensated',
    });
    expect(
      await failure(plans.undoReport(ctx, v.planId!, { dispatch: 1 })),
    ).toBe('conflict');
    const l = await logs(s.siteId);
    expect(l.map((x) => [x.result, x.reason, x.undoOf])).toEqual([
      ['proposed', 'fields:1,manual:0,comp:1', null],
      ['dispatched', 'comp', 1],
      ['skipped', 'gone', 1],
    ]);
  });

  it('п.6/п.8: компенсация отдана, итога нет (перезагрузка) — повторное «Вернуть» её не повторяет: unknown', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const v = await brokenChain(s, ctx);
    await plans.undo(ctx, v.planId!, { by: 'offer' });
    await plans.undoReport(ctx, v.planId!, { dispatch: 1 });
    const again = await plans.undo(ctx, v.planId!, { by: 'command' });
    expect(again).toMatchObject({
      comp: null,
      fields: [],
      chainStatus: 'unknown',
    });
    expect(
      await failure(plans.undoReport(ctx, v.planId!, { dispatch: 1 })),
    ).toBe('conflict');
    const l = await logs(s.siteId);
    expect(l.filter((x) => x.result === 'dispatched')).toHaveLength(1);
    expect(l.at(-1)).toMatchObject({ result: 'skipped', reason: 'unknown' });
  });

  it('п.4 (серверная часть): «Видалити» без разметки — не компенсация (стоп-лист); «В кошик» без описания строки — «уберите сами», 0 компенсаций', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    modelReply = JSON.stringify({
      command: true,
      steps: [{ kind: 'click', target: 'e7' }],
    });
    const del = await create(ctx, typed(product(s), 'видали з кошика'));
    expect(del.steps[0]).toMatchObject({ risk: 'never' });
    const v = await brokenChain(s, ctx, { heading: null });
    const u = await plans.undo(ctx, v.planId!, { by: 'offer' });
    expect(u.comp).toBeNull();
    expect(u.manual).toEqual([{ i: 1, text: 'В кошик' }]);
    expect(u.fields).toEqual([{ i: 0, text: 'Розмір' }]);
  });

  it('«Как отменить» карты: кнопка без стандартной разметки — ⇄ (не ТН), компенсация по объявленной паре; обратная из стоп-листа — пары нет (ТН)', async () => {
    const s = await vcSite();
    const m = await owner(s);
    const publish = async (undo: unknown) => {
      const d = await maps.draft(m, s.siteId);
      await maps.patch(
        m,
        s.siteId,
        {
          expectedRevision: d.revision,
          ops: [
            {
              op: 'upsert-target',
              target: {
                key: 'gift',
                scope: 'site',
                descriptor: {
                  tag: 'button',
                  role: 'button',
                  text: 'Додати подарунок',
                  assistId: 'gift',
                  unique: true,
                },
                names: { uk: 'Подарунок' },
                undo,
              },
            },
          ],
        },
        'tma',
      );
      const ver = await maps.buildVersion(m, s.siteId, 'tma');
      await maps.publish(m, s.siteId, String(ver.number));
      clearVoiceMapCache();
    };
    await publish({ assistId: 'remove-gift', at: null });
    const ctx = ctxOf(s);
    const v = await brokenChain(s, ctx, { second: 'e4' });
    expect(v.marks?.[1]).toBe('comp');
    expect(v.pnr).toBeNull();
    const u = await plans.undo(ctx, v.planId!, { by: 'offer' });
    expect(u.comp).toMatchObject({
      i: 1,
      assistId: 'remove-gift',
      at: null,
      allow: ['remove'],
    });
    // Обратная цель «оплатить» — пары нет: шаг — точка невозврата.
    await publish({ assistId: 'pay-now', at: null });
    modelReply = JSON.stringify({
      command: true,
      steps: [{ kind: 'click', target: 'e4' }],
    });
    const bad = await create(ctx, typed(product(s), 'додай подарунок'));
    expect(bad.marks).toEqual(['irrev']);
    expect(bad.pnr).toBe(0);
  });

  it('окно: «Вернуть» — 10 мин; отчёт компенсации — 10 мин + 60 с; после — expired', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const v = await brokenChain(s, ctx);
    await plans.undo(ctx, v.planId!, { by: 'offer' });
    await plans.undoReport(ctx, v.planId!, { dispatch: 1 });
    const t0 = Date.now();
    plans.now = () => new Date(t0 + UNDO_REPORT_WINDOW_MS - 5_000);
    const ok = await plans.undoReport(ctx, v.planId!, {
      results: [{ i: 1, result: 'done' }],
    });
    expect(ok.fields).toEqual([{ i: 0, text: 'Розмір' }]);
    plans.now = () => new Date(t0 + UNDO_REPORT_WINDOW_MS + 5_000);
    expect(
      await failure(
        plans.undoReport(ctx, v.planId!, {
          results: [{ i: 0, result: 'done' }],
        }),
      ),
    ).toBe('expired');
    expect((await plans.undo(ctx, v.planId!, { by: 'offer' })).refused).toBe(
      'expired',
    );
  });

  it('`degraded` — компенсаций 0: корзина — в «уберите сами»; после выполненной ТН — ничего, даже при паре', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const v = await brokenChain(s, ctx);
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: { voiceControlSiteState: 'degraded' },
    });
    const u = await plans.undo(ctx, v.planId!, { by: 'offer' });
    expect(u).toMatchObject({ refused: 'degraded', comp: null });
    expect(u.manual.map((x) => x.i).sort()).toEqual([0, 1]);
    expect(
      (await logs(s.siteId)).filter((x) => x.result === 'dispatched'),
    ).toHaveLength(0);

    const s2 = await vcSite();
    const ctx2 = ctxOf(s2);
    modelReply = JSON.stringify({
      command: true,
      steps: [
        { kind: 'click', target: 'e2' },
        { kind: 'click', target: 'e6' },
      ],
    });
    let p = await create(
      ctx2,
      typed(product(s2), 'додай в кошик і надішли заявку'),
    );
    p = await plans.confirm(ctx2, p.planId!, {
      by: 'button',
      stepsHash: p.stepsHash!,
    });
    p = await run(ctx2, p, 0, s2.url('/product/1'));
    p = await run(ctx2, p, 1, s2.url('/product/1'));
    expect(p.chainStatus).toBe('committed');
    expect((await plans.undo(ctx2, p.planId!, { by: 'command' })).refused).toBe(
      'after_pnr',
    );
  });

  it('мастер Т-2: обратные цели проверяются — без описания строки и без страницы отмены — предупреждение `undo_unresolved` (итог не меняет)', async () => {
    const s = await vcSite();
    const link = await cab.testToken(await owner(s), s.siteId, {});
    const token = new URL(link.url).searchParams.get('v4c_voicetest')!;
    const base: UiPlanCtx = { site: s.ctx(), visitor: st.visitor() };
    const sess = await tests.exchange(base, { token });
    const ctx: UiPlanCtx = {
      ...base,
      voiceTest: { testId: sess.testId, testHost: sess.testHost },
    };
    const page = product(s);
    // Вторая карточка без заголовка; «Кошик» шапки есть — страница отмены известна.
    page.elements.push({
      ref: 'e8',
      role: 'button',
      tag: 'button',
      text: 'В кошик',
      assistId: 'add-to-cart',
      heading: null,
      inView: true,
    } as (typeof page.elements)[number]);
    const r = await tests.report(ctx, sess.testId, {
      lang: 'uk',
      snapshot: page,
      env: { widget: true, chunks: true, csp: 0, tt: 0, micPolicy: 'allowed' },
      mic: 'ok',
      markup: {
        total: 8,
        withId: 4,
        unnamed: [],
        closedShadow: 0,
        extIframes: 0,
        duplicates: [],
        denied: 0,
      },
      suspicious: [],
      reviewed: {},
      dry: [],
    });
    expect(r.report.items).toContainEqual({
      step: 3,
      level: 'warn',
      code: 'undo_unresolved',
      data: { n: 1, of: 2 },
    });
    expect(r.report.undo).toEqual({
      pairs: 2,
      unresolved: [
        { text: 'В кошик', reverse: 'remove-from-cart', problem: 'no_row' },
      ],
    });
  });
});
