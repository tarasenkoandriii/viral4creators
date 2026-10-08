/**
 * Приёмка Э6-бис (а) «Голосовое управление — режим Сайт» на реальном
 * Postgres: публичный код — под ролью assist_public (как в проде), посев —
 * владельцем схемы, модель плана — подделка (GeminiText с фейковым
 * клиентом), Soniox — подделка (как Э5). ТЗ §5-бис.10 (серверная часть):
 *
 *  п.6  чекбокс: выключено (переключатель, микрофон, тариф) — 0 планов,
 *       0 вызовов модели, отказ VOICE_CONTROL_OFF;
 *  п.8  источник команды: без речи (билета) или набора — плана нет;
 *       билет на другой текст — нет;
 *  п.3, 11, 7 инъекции/невидимая подпись/вне хоста — код вычёркивает или
 *       понижает до «нажмите сами» даже то, что «предложила» модель;
 *  п.5  `dispatched` до клика, ровно один раз; «не та страница» — стоп;
 *  подтверждение (60 с, отпечаток шагов, «да» голосом с билетом, «нет»),
 *  стоп, продолжение после перехода, журнал (маскирование), единицы и
 *  деньги (операция assist-ui-plan, резерв снят), «два тенанта».
 * Браузерная часть (снимок, исполнитель, стоп, Esc, клик человека) — e2e
 * виджета `voice-control*.spec.ts`.
 */
import { randomUUID } from 'crypto';
import { voiceTicketKey } from '../../config/voice-env';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { utcDay } from '../../modules/assist-site-chat/budget';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { SiteVoiceService } from '../../modules/assist-site-voice/public/site-voice.service';
import { SiteSonioxStt } from '../../modules/assist-site-voice/public/soniox-stt.client';
import { SiteSonioxTts } from '../../modules/assist-site-voice/public/soniox-tts.client';
import { issueVoiceTicket } from '../../modules/assist-site-voice/public/voice-ticket';
import { FakeSoniox } from '../../modules/assist-site-voice/testing/fake-soniox.testing';
import type { UiPlanRequest } from '../../modules/assist-site-voice-control/api-types';
import {
  liveKeysFrom,
  openLive,
} from '../../modules/assist-site-voice-control/public/live-crypto';
import {
  SiteUiPlanService,
  UiPlanError,
  stepsHash,
  type UiPlanCtx,
} from '../../modules/assist-site-voice-control/public/ui-plan.service';
import { GeminiText } from '../../modules/site-ai/text-model';
import { estimateCost } from '../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../shared/gemini-model';
import { uiMapKey } from '../../modules/site-core/ui-map/ui-map';
import { ingestUiSnapshot } from '../../modules/site-core/ui-map/ui-map-store';
import { SitesDb } from '../../prisma/sites-db.service';
import { awaitUtcDayHeadroom } from '../window-headroom';

jest.setTimeout(180_000);

describeDb('Приёмка Э6-бис (а) — голосовое управление «Сайтом»', () => {
  const st = new ChatStack();
  const fake = new FakeSoniox();
  let plans: SiteUiPlanService;
  let env: NodeJS.ProcessEnv;
  /** Ответ «модели плана» на следующий вызов; вызовы — в modelCalls. */
  let modelReply: string = '{"command": true, "steps": []}';
  const modelCalls: string[] = [];
  /** finishReason ответа модели (MAX_TOKENS — обрезан/пуст); бросить — сбой сети. */
  let modelFinish: string | null = null;
  let modelThrows = false;
  let dayAllowed = true;

  beforeAll(async () => {
    await st.init();
    env = {
      ...st.env,
      SONIOX_API_KEY: 'sx-test',
      ASSIST_VOICE_ENABLED: 'true',
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
        generateContent: async (req: {
          contents: Array<{ parts: Array<{ text: string }> }>;
        }) => {
          modelCalls.push(req.contents[0].parts[0].text);
          if (modelThrows) throw new Error('провайдер недоступен (фейк)');
          return {
            text: modelReply,
            usageMetadata: {
              promptTokenCount: 3000,
              candidatesTokenCount: 120,
            },
            ...(modelFinish
              ? { candidates: [{ finishReason: modelFinish }] }
              : {}),
          };
        },
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
  });
  afterAll(async () => {
    await st.close();
  });
  beforeEach(() => {
    modelCalls.length = 0;
    modelReply = '{"command": true, "steps": []}';
    modelFinish = null;
    modelThrows = false;
    dayAllowed = true;
    plans.now = () => new Date();
  });

  async function vcSite(
    o: {
      plan?: 'business' | 'start' | 'trial';
      state?: string;
      input?: boolean;
      rules?: unknown;
    } = {},
  ): Promise<ChatSite> {
    const s = await st.site({ name: 'Магазин' });
    if (o.plan !== 'trial')
      await setPlan(st.owner, s.accountId, o.plan ?? 'business');
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: {
        voiceConfig: {
          schema: 1,
          input: o.input ?? true,
          output: false,
          voiceId: null,
        },
        voiceControlSiteState: o.state ?? 'on',
        voiceControlSiteRules: (o.rules ?? null) as never,
      },
    });
    return s;
  }

  const ctxOf = (s: ChatSite, visitor = st.visitor()): UiPlanCtx => ({
    site: s.ctx(),
    visitor,
  });

  /** Снимок стенда: ссылка «Доставка», поиск, кнопка «Оплатити», чужая ссылка, форма. */
  const snapshot = (s: ChatSite, path = '/') => ({
    url: s.url(path),
    title: 'Магазин',
    elements: [
      {
        ref: 'e1',
        role: 'link',
        tag: 'a',
        text: 'Доставка',
        href: s.url('/delivery'),
        inView: true,
      },
      {
        ref: 'e2',
        role: 'searchbox',
        tag: 'input',
        inputType: 'search',
        text: 'Пошук',
        inView: true,
      },
      {
        ref: 'e3',
        role: 'button',
        tag: 'button',
        text: 'Оплатити',
        inView: true,
      },
      {
        ref: 'e4',
        role: 'link',
        tag: 'a',
        text: 'Партнер',
        href: 'https://evil.example.org/',
        inView: true,
      },
      {
        ref: 'e5',
        role: 'button',
        tag: 'button',
        text: 'Надіслати заявку',
        submit: true,
        inForm: true,
        inView: true,
      },
      {
        ref: 'e6',
        role: 'textbox',
        tag: 'input',
        inputType: 'email',
        text: 'E-mail',
        pd: true,
        inView: true,
      },
      {
        ref: 'e7',
        role: 'button',
        tag: 'button',
        text: 'Детальніше',
        hiddenLabel: 'Оформити замовлення',
        inView: true,
      },
    ],
  });

  const typed = (
    s: ChatSite,
    text: string,
    over: Partial<UiPlanRequest> = {},
  ): UiPlanRequest => ({
    text,
    source: 'typed',
    lang: 'uk',
    snapshot: snapshot(s),
    ...over,
  });

  const create = (ctx: UiPlanCtx, body: UiPlanRequest) =>
    plans.create(ctx, body, async () => dayAllowed);

  async function failure(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      if (e instanceof UiPlanError) return e.failure;
      throw e;
    }
    return 'ok';
  }

  const planRows = (siteId: string) =>
    st.owner.assistSiteUiPlan.findMany({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
    });
  const logRows = (siteId: string) =>
    st.owner.assistSiteUiActionLog.findMany({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
    });

  // ── п.6: выключено — ничего не нажимается и не строится ────────────────

  it('п.6: переключатель off, микрофон выключен, тариф без голоса, битые правила — VOICE_CONTROL_OFF, 0 планов, 0 вызовов модели', async () => {
    for (const o of [
      { state: 'off' },
      { state: 'test' },
      { input: false },
      { plan: 'start' as const },
      { rules: { denyWords: 'не список' } },
    ]) {
      const s = await vcSite(o);
      expect(
        await failure(create(ctxOf(s), typed(s, 'відкрий доставку'))),
      ).toBe('off');
      expect(await planRows(s.siteId)).toHaveLength(0);
    }
    expect(modelCalls).toHaveLength(0);
  });

  it('рубильник платформы ASSIST_VOICE_CONTROL_ENABLED=false — режим выключен у всех', async () => {
    const s = await vcSite();
    plans.env = { ...env, ASSIST_VOICE_CONTROL_ENABLED: 'false' };
    try {
      expect(
        await failure(create(ctxOf(s), typed(s, 'відкрий доставку'))),
      ).toBe('off');
    } finally {
      plans.env = env;
    }
  });

  // ── п.8: источник команды ───────────────────────────────────────────────

  it('п.8: без источника, с источником «ask», голос без билета или с билетом на ДРУГОЙ текст — 0 планов; набранная команда — план', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const key = voiceTicketKey(env)!;
    const other = issueVoiceTicket(key, {
      siteId: s.siteId,
      visitorId: ctx.visitor.visitorId,
      text: 'скільки коштує доставка',
      now: new Date(),
      ttlMs: 60_000,
    });
    for (const body of [
      typed(s, 'відкрий доставку', { source: undefined as never }),
      typed(s, 'відкрий доставку', { source: 'ask' as never }),
      typed(s, 'відкрий доставку', { source: 'voice' }),
      typed(s, 'відкрий доставку', { source: 'voice', voiceTicket: other }),
    ])
      expect(await failure(create(ctx, body))).toBe('bad_request');
    expect(await planRows(s.siteId)).toHaveLength(0);
    const ticket = issueVoiceTicket(key, {
      siteId: s.siteId,
      visitorId: ctx.visitor.visitorId,
      text: 'відкрий доставку',
      now: new Date(),
      ttlMs: 60_000,
    });
    const v = await create(
      ctx,
      typed(s, 'відкрий доставку', { source: 'voice', voiceTicket: ticket }),
    );
    expect(v.kind).toBe('plan');
    const rows = await planRows(s.siteId);
    expect(rows.map((r) => r.source)).toEqual(['voice']);
    // Голосовая команда — диалог весом 2 (§7.1).
    const conv = await st.owner.assistSiteConversation.findUnique({
      where: { id: rows[0].conversationId },
    });
    expect(conv!.voice).toBe(true);
  });

  // ── прямой путь, запись плана, единицы ─────────────────────────────────

  it('прямой путь без модели: «відкрий доставку» → клик по ссылке своего хоста, навигация, без карточки; единица засчитана, журнал «plan»', async () => {
    const s = await vcSite();
    const v = await create(ctxOf(s), typed(s, 'Відкрий доставку'));
    expect(modelCalls).toHaveLength(0);
    expect(v).toMatchObject({
      kind: 'plan',
      status: 'confirmed',
      needsConfirm: false,
    });
    expect(v.steps).toEqual([
      expect.objectContaining({
        kind: 'click',
        risk: 'auto',
        nav: true,
        state: 'pending',
        expect: { path: '/delivery' },
      }),
    ]);
    const [row] = await planRows(s.siteId);
    expect(row).toMatchObject({
      status: 'confirmed',
      confirmedBy: 'auto',
      utteranceMasked: 'Відкрий доставку',
    });
    const usage = await st.owner.$queryRawUnsafe<
      Array<{ units: number; dialogs: number }>
    >(
      `SELECT "units", "dialogs" FROM "sites"."assist_account_usage" WHERE "accountId" = $1`,
      s.accountId,
    );
    expect(usage[0]).toMatchObject({ units: 1, dialogs: 1 });
    expect((await logRows(s.siteId)).map((r) => [r.action, r.result])).toEqual([
      ['plan', 'proposed'],
    ]);
  });

  it('предпросмотр конфигуратора — без единиц; потолок планов сайта в сутки — отказ site_limit', async () => {
    const s = await vcSite();
    await create(
      { site: s.ctx({ preview: true }), visitor: st.visitor() },
      typed(s, 'відкрий доставку'),
    );
    const usage = await st.owner.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM "sites"."assist_account_usage" WHERE "accountId" = $1 AND "units" > 0`,
      s.accountId,
    );
    expect(usage).toHaveLength(0);
    dayAllowed = false;
    expect(await failure(create(ctxOf(s), typed(s, 'відкрий доставку')))).toBe(
      'site_limit',
    );
  });

  it('вопрос, а не команда (модель: command=false) — kind not_command, плана нет', async () => {
    const s = await vcSite();
    modelReply = '{"command": false, "steps": []}';
    const v = await create(ctxOf(s), typed(s, 'а доставка платна?'));
    expect(v.kind).toBe('not_command');
    expect(await planRows(s.siteId)).toHaveLength(0);
  });

  // ── проверки кодом против «злой» модели (п.3, 7, 11) ───────────────────

  it('модель «предлагает» оплату, чужой домен, невидимую подпись, придуманное значение — код: никогда/нажмите сами/вычеркнуть; журнал отказов; деньги — операция assist-ui-plan, резерв снят', async () => {
    const s = await vcSite();
    modelReply = JSON.stringify({
      command: true,
      steps: [
        {
          kind: 'fill',
          target: 'e6',
          value: 'attacker@evil.example.org',
          risk: 'auto',
        },
        { kind: 'click', target: 'e3', risk: 'auto' },
        { kind: 'click', target: 'e4' },
      ],
    });
    const v = await create(ctxOf(s), typed(s, 'введи пошту і оплати'));
    expect(modelCalls).toHaveLength(1);
    // Подписи — блоком данных; ни одна инструкция модели не исполнилась.
    expect(modelCalls[0]).toMatch(/<page_elements note=/);
    expect(v.steps.map((x) => [x.kind, x.risk, x.reason])).toEqual([
      ['click', 'never', 'payment'],
    ]);
    expect(v.notes.map((n) => n.code)).toEqual(['value_not_said', 'payment']);
    const log = await logRows(s.siteId);
    expect(
      log.filter((r) => r.action === 'refused').map((r) => r.reason),
    ).toEqual(['value_not_said', 'payment']);
    const usage = await st.owner.siteAiUsage.findMany({
      where: { siteId: s.siteId, operation: 'assist-ui-plan' },
    });
    expect(usage).toHaveLength(1);
    const day = await st.budgetRow('site', s.siteId, utcDay(new Date()));
    expect(day?.reserved).toBe(0);

    modelReply = JSON.stringify({
      command: true,
      steps: [{ kind: 'click', target: 'e4' }],
    });
    const off = await create(ctxOf(s), typed(s, 'відкрий партнера'));
    expect(off.steps[0]).toMatchObject({ risk: 'manual', reason: 'offhost' });

    modelReply = JSON.stringify({
      command: true,
      steps: [{ kind: 'click', target: 'e7' }],
    });
    const hidden = await create(ctxOf(s), typed(s, 'оформи замовлення'));
    expect(hidden.steps[0]).toMatchObject({ risk: 'never' });
    expect(hidden.steps[0].target!.text).toBe('Детальніше');
  });

  it('оплаченный сбой модели плана (MAX_TOKENS: обрезан/пуст) — upstream как раньше, расход assist-ui-plan фактом, резерв дня закрыт им; сбой сети — без расхода', async () => {
    // Строка бюджета — день UTC резерва: полночь посередине — чужой день.
    await awaitUtcDayHeadroom(15_000);
    const s = await vcSite();
    const day = () => st.budgetRow('site', s.siteId, utcDay(new Date()));
    const usage = () =>
      st.owner.siteAiUsage.findMany({
        where: { siteId: s.siteId, operation: 'assist-ui-plan' },
      });
    const fact = estimateCost(GEMINI_MODEL, {
      inputTokens: 3000,
      outputTokens: 120,
    }).costMicroUsd;
    expect(fact).toBeGreaterThan(0);

    // Обрезан (текст есть) и пуст (текста нет) — оба оплачены.
    modelFinish = 'MAX_TOKENS';
    modelReply = '{"command": true, "steps": [{"kind": "cli';
    expect(
      await failure(create(ctxOf(s), typed(s, 'відкрий доставку і пошук'))),
    ).toBe('upstream');
    modelReply = '';
    expect(
      await failure(create(ctxOf(s), typed(s, 'введи пошту і оплати'))),
    ).toBe('upstream');
    expect(modelCalls).toHaveLength(2);
    const rows = await usage();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({
        model: GEMINI_MODEL,
        inputTokens: 3000,
        outputTokens: 120,
        costMicroUsd: fact,
      });
    }
    expect(await day()).toMatchObject({ spent: 2 * fact, reserved: 0 });
    expect(await planRows(s.siteId)).toHaveLength(0);

    // Сбой сети (unavailable) — провайдер денег не взял: как раньше.
    modelFinish = null;
    modelThrows = true;
    expect(await failure(create(ctxOf(s), typed(s, 'оформи замовлення')))).toBe(
      'upstream',
    );
    expect(await usage()).toHaveLength(2);
    expect(await day()).toMatchObject({ spent: 2 * fact, reserved: 0 });
  });

  it('снимок не со своего хоста — отказ; страница вне зоны владельца — план без шагов и без денег', async () => {
    const s = await vcSite({ rules: { schema: 1, allowPaths: ['/catalog*'] } });
    const evil = { ...snapshot(s), url: 'https://evil.example.org/' };
    expect(
      await failure(
        create(ctxOf(s), typed(s, 'відкрий доставку', { snapshot: evil })),
      ),
    ).toBe('bad_request');
    const v = await create(ctxOf(s), typed(s, 'відкрий доставку'));
    expect(v).toMatchObject({
      kind: 'plan',
      planId: null,
      steps: [],
      notes: [{ code: 'denied' }],
    });
    expect(await planRows(s.siteId)).toHaveLength(0);
  });

  it('снимок не сохраняется: в плане нет ни подписей чужих элементов, ни адреса страницы с query; команда маскирована', async () => {
    const s = await vcSite();
    const snap = { ...snapshot(s), url: s.url('/?email=ivan@example.com') };
    const v = await create(
      ctxOf(s),
      typed(s, 'знайди ivan@example.com', { snapshot: snap }),
    );
    const [row] = await planRows(s.siteId);
    const dump = JSON.stringify(row);
    expect(dump).not.toContain('Партнер');
    expect(dump).not.toContain('Оплатити');
    expect(row.pageUrl).toBe(s.url('/'));
    expect(row.utteranceMasked).not.toContain('ivan@example.com');
    expect(v.steps[0]).toMatchObject({
      kind: 'fill',
      value: 'ivan@example.com',
    });
  });

  // ── подтверждение ──────────────────────────────────────────────────────

  it('подтверждение: шаг до «Да» — конфликт; чужой отпечаток — PLAN_CHANGED; «Да» кнопкой; повтор «Да» — тот же ответ; журнал «confirm»', async () => {
    const s = await vcSite();
    modelReply = JSON.stringify({
      command: true,
      steps: [{ kind: 'click', target: 'e5' }],
    });
    const ctx = ctxOf(s);
    const v = await create(ctx, typed(s, 'надішли заявку'));
    expect(v).toMatchObject({ status: 'proposed', needsConfirm: true });
    expect(
      await failure(
        plans.step(ctx, v.planId!, { index: 0, result: 'dispatched' }),
      ),
    ).toBe('conflict');
    expect(
      await failure(
        plans.confirm(ctx, v.planId!, { by: 'button', stepsHash: 'x' }),
      ),
    ).toBe('changed');
    const c = await plans.confirm(ctx, v.planId!, {
      by: 'button',
      stepsHash: v.stepsHash!,
    });
    expect(c.status).toBe('confirmed');
    const again = await plans.confirm(ctx, v.planId!, {
      by: 'button',
      stepsHash: v.stepsHash!,
    });
    expect(again).toMatchObject({
      status: 'confirmed',
      stepsHash: v.stepsHash,
    });
    expect((await planRows(s.siteId))[0].confirmedBy).toBe('button');
    expect(
      (await logRows(s.siteId)).filter((r) => r.action === 'confirm'),
    ).toHaveLength(1);
  });

  it('аудит: выключение режима после построения плана — сервер не принимает ни «Да», ни следующий шаг (dispatched/done); стоп — принимает', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    modelReply = JSON.stringify({
      command: true,
      steps: [{ kind: 'click', target: 'e5' }],
    });
    const proposed = await create(ctx, typed(s, 'надішли заявку'));
    expect(proposed.status).toBe('proposed');
    const nav = await create(ctx, typed(s, 'відкрий доставку'));
    expect(nav.status).toBe('confirmed');
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: { voiceControlSiteState: 'off' },
    });
    expect(
      await failure(
        plans.confirm(ctx, proposed.planId!, {
          by: 'button',
          stepsHash: proposed.stepsHash!,
        }),
      ),
    ).toBe('off');
    expect(
      await failure(
        plans.step(ctx, nav.planId!, { index: 0, result: 'dispatched' }),
      ),
    ).toBe('off');
    const rows = await planRows(s.siteId);
    expect(rows.map((r) => r.status)).toEqual(['proposed', 'confirmed']);
    expect((await plans.stop(ctx, nav.planId!, { by: 'button' })).status).toBe(
      'stopped',
    );
  });

  it('подтверждение голосом: «так» с билетом — да; без билета/фраза не из списка — нет; «ні» — стоп', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const key = voiceTicketKey(env)!;
    const ticket = (text: string) =>
      issueVoiceTicket(key, {
        siteId: s.siteId,
        visitorId: ctx.visitor.visitorId,
        text,
        now: new Date(),
        ttlMs: 60_000,
      });
    modelReply = JSON.stringify({
      command: true,
      steps: [{ kind: 'click', target: 'e5' }],
    });
    const v = await create(ctx, typed(s, 'надішли заявку'));
    expect(
      await failure(
        plans.confirm(ctx, v.planId!, {
          by: 'voice',
          stepsHash: v.stepsHash!,
          text: 'так',
        }),
      ),
    ).toBe('bad_request');
    expect(
      await failure(
        plans.confirm(ctx, v.planId!, {
          by: 'voice',
          stepsHash: v.stepsHash!,
          text: 'так, і оплати',
          voiceTicket: ticket('так, і оплати'),
        }),
      ),
    ).toBe('bad_request');
    const yes = await plans.confirm(ctx, v.planId!, {
      by: 'voice',
      stepsHash: v.stepsHash!,
      text: 'Так',
      voiceTicket: ticket('Так'),
    });
    expect(yes.status).toBe('confirmed');
    const w = await create(ctx, typed(s, 'надішли заявку'));
    const no = await plans.confirm(ctx, w.planId!, {
      by: 'voice',
      stepsHash: w.stepsHash!,
      text: 'ні',
      voiceTicket: ticket('ні'),
    });
    expect(no.status).toBe('stopped');
  });

  it('окно подтверждения 60 с: позже — PLAN_EXPIRED, план «expired», повтор «Да» не исполняет', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    modelReply = JSON.stringify({
      command: true,
      steps: [{ kind: 'click', target: 'e5' }],
    });
    const v = await create(ctx, typed(s, 'надішли заявку'));
    plans.now = () => new Date(Date.now() + 61_000);
    expect(
      await failure(
        plans.confirm(ctx, v.planId!, {
          by: 'button',
          stepsHash: v.stepsHash!,
        }),
      ),
    ).toBe('expired');
    expect((await planRows(s.siteId))[0].status).toBe('expired');
    expect(
      await failure(
        plans.confirm(ctx, v.planId!, {
          by: 'button',
          stepsHash: v.stepsHash!,
        }),
      ),
    ).toBe('conflict');
  });

  // ── п.5: dispatched — до клика и один раз ──────────────────────────────

  it('п.5: навигационный шаг — done без dispatched нельзя; dispatched дважды нельзя; done на ожидаемой странице — готово; на чужой — стоп', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const v = await create(ctx, typed(s, 'відкрий доставку'));
    const id = v.planId!;
    expect(
      await failure(
        plans.step(ctx, id, {
          index: 0,
          result: 'done',
          url: s.url('/delivery'),
        }),
      ),
    ).toBe('conflict');
    const d = await plans.step(ctx, id, { index: 0, result: 'dispatched' });
    expect(d.steps[0].state).toBe('dispatched');
    expect(
      await failure(plans.step(ctx, id, { index: 0, result: 'dispatched' })),
    ).toBe('conflict');
    const done = await plans.step(ctx, id, {
      index: 0,
      result: 'done',
      url: s.url('/delivery/'),
      durationMs: 420,
    });
    expect(done).toMatchObject({ status: 'done', currentStep: 1 });
    // Повтор отчёта после перезагрузки — конфликт, ничего не меняется.
    expect(
      await failure(plans.step(ctx, id, { index: 0, result: 'done' })),
    ).toBe('conflict');

    const w = await create(ctx, typed(s, 'відкрий доставку'));
    await plans.step(ctx, w.planId!, { index: 0, result: 'dispatched' });
    const wrong = await plans.step(ctx, w.planId!, {
      index: 0,
      result: 'done',
      url: s.url('/login'),
    });
    expect(wrong.status).toBe('failed');
    const log = await logRows(s.siteId);
    expect(log.filter((r) => r.result === 'dispatched')).toHaveLength(2);
  });

  it('стоп: план остановлен; отчёт шага после стопа — конфликт; повтор стопа — тот же ответ', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const v = await create(ctx, typed(s, 'відкрий доставку'));
    const stopped = await plans.stop(ctx, v.planId!, { by: 'esc' });
    expect(stopped.status).toBe('stopped');
    expect(
      await failure(
        plans.step(ctx, v.planId!, { index: 0, result: 'dispatched' }),
      ),
    ).toBe('conflict');
    expect((await plans.stop(ctx, v.planId!, { by: 'click' })).status).toBe(
      'stopped',
    );
    expect(
      (await logRows(s.siteId))
        .filter((r) => r.action === 'stop')
        .map((r) => r.reason),
    ).toEqual(['esc']);
  });

  it('продолжение после перехода: активный план находится; шаг «после» получает цель из нового снимка; опасная — никогда', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    modelReply = JSON.stringify({
      command: true,
      steps: [
        { kind: 'click', target: 'e1' },
        { kind: 'click', target: { text: 'Нова Пошта', role: 'tab' } },
      ],
    });
    const v = await create(
      ctx,
      typed(s, 'відкрий доставку і вибери нова пошта'),
    );
    await plans.step(ctx, v.planId!, { index: 0, result: 'dispatched' });
    await plans.step(ctx, v.planId!, {
      index: 0,
      result: 'done',
      url: s.url('/delivery'),
    });
    const active = await plans.active(ctx);
    expect(active).toMatchObject({
      planId: v.planId,
      currentStep: 1,
      status: 'running',
    });
    const next = {
      url: s.url('/delivery'),
      elements: [
        {
          ref: 'e1',
          role: 'tab',
          tag: 'button',
          text: 'Нова Пошта',
          toggle: true,
        },
      ],
    };
    const r = await plans.resume(ctx, v.planId!, { snapshot: next });
    expect(r.steps[1]).toMatchObject({
      risk: 'auto',
      target: { ref: 'e1', text: 'Нова Пошта' },
    });
    // Клик — шаг с побочным эффектом: `dispatched` до действия (аудит).
    await plans.step(ctx, v.planId!, { index: 1, result: 'dispatched' });
    const done = await plans.step(ctx, v.planId!, { index: 1, result: 'done' });
    expect(done.status).toBe('done');

    const w = await create(
      ctx,
      typed(s, 'відкрий доставку і вибери нова пошта'),
    );
    await plans.step(ctx, w.planId!, { index: 0, result: 'dispatched' });
    await plans.step(ctx, w.planId!, {
      index: 0,
      result: 'done',
      url: s.url('/delivery'),
    });
    const evil = {
      url: s.url('/delivery'),
      elements: [
        {
          ref: 'e1',
          role: 'tab',
          tag: 'button',
          text: 'Нова Пошта',
          hiddenLabel: 'Оплатити',
        },
      ],
    };
    const r2 = await plans.resume(ctx, w.planId!, { snapshot: evil });
    expect(r2.steps[1].risk).toBe('never');
    expect(
      await failure(plans.step(ctx, w.planId!, { index: 1, result: 'done' })),
    ).toBe('conflict');
  });

  it('журнал: значение поля маскировано, описание цели — без значений; цель шага — путь, не адрес с query', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const v = await create(ctx, typed(s, 'знайди ivan@example.com'));
    await plans.step(ctx, v.planId!, { index: 0, result: 'dispatched' });
    await plans.step(ctx, v.planId!, {
      index: 0,
      result: 'done',
      url: s.url('/?q=ivan@example.com'),
    });
    const row = (await logRows(s.siteId)).find(
      (r) => r.action === 'fill' && r.result === 'done',
    )!;
    expect(row.valueMasked).not.toContain('ivan@example.com');
    expect(row.url).toBe(s.url('/'));
    expect(row.target).toMatchObject({ role: 'searchbox', text: 'Пошук' });
  });

  // ── «два тенанта» (§10 инвариант) ──────────────────────────────────────

  it('два тенанта: план сайта A не виден/не исполним/не останавливается от имени сайта B и другого посетителя', async () => {
    const a = await vcSite();
    const b = await vcSite();
    const visitor = st.visitor();
    const v = await create(
      { site: a.ctx(), visitor },
      typed(a, 'відкрий доставку'),
    );
    const asB = { site: b.ctx(), visitor };
    const other = ctxOf(a);
    for (const ctx of [asB, other]) {
      expect(
        await failure(
          plans.step(ctx, v.planId!, { index: 0, result: 'dispatched' }),
        ),
      ).toBe('not_found');
      expect(await failure(plans.stop(ctx, v.planId!, { by: 'button' }))).toBe(
        'not_found',
      );
      expect(
        await failure(
          plans.confirm(ctx, v.planId!, {
            by: 'button',
            stepsHash: v.stepsHash!,
          }),
        ),
      ).toBe('not_found');
      expect(await plans.active(ctx)).toBeNull();
    }
    expect((await plans.active({ site: a.ctx(), visitor }))!.planId).toBe(
      v.planId,
    );
    // Снимок сайта A под сайтом B — чужой хост.
    expect(await failure(create(asB, typed(a, 'відкрий доставку')))).toBe(
      'bad_request',
    );
    expect(stepsHash(v.steps)).toBe(v.stepsHash);
  });

  it('Ш4: снимок плана — голос «найден» элементам карты своего вида (порог разных посетителей и IP — промахи и «устарел» сняты); без вида — не трогает; чужой вид — не трогает', async () => {
    const s = await vcSite();
    const host = await st.owner.siteHost.findFirst({
      where: { siteId: s.siteId, host: s.host },
    });
    const key = uiMapKey(s.url('/'))!;
    await ingestUiSnapshot(new SitesDb(st.owner).forAccount(s.accountId), {
      accountId: s.accountId,
      siteId: s.siteId,
      hostId: host!.id,
      host: key.host,
      path: key.path,
      source: 'crawl',
      viewport: 'any',
      elements: [{ tag: 'a', label: 'Доставка', assistId: 'nav-delivery' }],
      now: new Date(),
    });
    const stale = new Date(Date.now() - 60_000);
    const spoil = () =>
      st.owner.siteUiElement.updateMany({
        where: { siteId: s.siteId },
        data: {
          missCountDesktop: 3,
          staleDesktopAt: stale,
          missCountMobile: 3,
          staleMobileAt: stale,
        },
      });
    await spoil();
    const marked = (path = '/') => {
      const snap = snapshot(s, path);
      snap.elements[0] = {
        ...snap.elements[0],
        assistId: 'nav-delivery',
      } as never;
      return snap;
    };
    const row = async () =>
      (
        await st.owner.siteUiElement.findMany({ where: { siteId: s.siteId } })
      )[0];
    // Без вида посетителя (старый вызов) — карта не трогается.
    await create(
      ctxOf(s),
      typed(s, 'відкрий доставку', { snapshot: marked() }),
    );
    expect((await row()).staleDesktopAt).not.toBeNull();
    // Компьютер: снимок посетителя — голос «найден», а не сброс (аудит Ш4);
    // три разных посетителя с разных IP (хеш на окно) — сброс вида
    // компьютера, телефонный — нет.
    const desktop = (ip: string): UiPlanCtx => ({
      ...ctxOf(s),
      viewport: 'desktop',
      voteIpHash: ip,
    });
    await create(
      desktop('w-1'),
      typed(s, 'відкрий доставку', { snapshot: marked() }),
    );
    let r = await row();
    expect([r.staleDesktopAt, r.missCountDesktop, r.seenCountDesktop]).toEqual([
      stale,
      3,
      1,
    ]);
    expect(r.lastSeenAt).not.toBeNull();
    // Тот же IP (хеш окна) с другим посетителем — не голос.
    await create(
      desktop('w-1'),
      typed(s, 'відкрий доставку', { snapshot: marked() }),
    );
    expect((await row()).seenCountDesktop).toBe(1);
    await create(
      desktop('w-2'),
      typed(s, 'відкрий доставку', { snapshot: marked() }),
    );
    await create(
      desktop('w-3'),
      typed(s, 'відкрий доставку', { snapshot: marked() }),
    );
    r = await row();
    expect([r.staleDesktopAt, r.missCountDesktop]).toEqual([null, 0]);
    expect([r.staleMobileAt, r.missCountMobile]).toEqual([stale, 3]);
    // Снимок без разметки (подпись не единственный ключ) — ничего.
    await spoil();
    await create(
      { ...ctxOf(s), viewport: 'mobile' },
      typed(s, 'відкрий доставку'),
    );
    r = await row();
    expect(r.staleMobileAt).toEqual(stale);
  });

  // ── аудит Э6-бис (03.10.2026): хвосты ─────────────────────────────────

  it('аудит: шаг с побочным эффектом — не более одного исполнения: done без dispatched нельзя; после перезагрузки повторный dispatched — конфликт; шаг «мог выполниться» — skipped/interrupted, план стоп', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const v = await create(ctx, typed(s, 'знайди ivan@example.com'));
    expect(v.steps[0]).toMatchObject({ kind: 'fill', nav: false });
    const id = v.planId!;
    expect(
      await failure(plans.step(ctx, id, { index: 0, result: 'done' })),
    ).toBe('conflict');
    const d = await plans.step(ctx, id, { index: 0, result: 'dispatched' });
    expect(d.steps[0].state).toBe('dispatched');
    // Страница перезагрузилась между действием и `done`: новый исполнитель
    // видит шаг `dispatched` и второй раз его не отметит (и не исполнит).
    expect(
      await failure(plans.step(ctx, id, { index: 0, result: 'dispatched' })),
    ).toBe('conflict');
    const active = await plans.active(ctx);
    expect(active!.steps[0].state).toBe('dispatched');
    const skipped = await plans.step(ctx, id, {
      index: 0,
      result: 'skipped',
      reason: 'interrupted',
    });
    expect(skipped).toMatchObject({ status: 'failed' });
    const log = await logRows(s.siteId);
    expect(
      log.filter((r) => r.action === 'fill').map((r) => [r.result, r.reason]),
    ).toEqual([
      ['dispatched', null],
      ['skipped', 'interrupted'],
    ]);
    // Подсветка — без эффекта: `dispatched` не нужен и не принимается.
    modelReply = JSON.stringify({
      command: true,
      steps: [{ kind: 'highlight', target: 'e1' }],
    });
    const h = await create(ctx, typed(s, 'покажи де доставка'));
    expect(h.steps[0]).toMatchObject({ kind: 'highlight', risk: 'auto' });
    expect(
      await failure(
        plans.step(ctx, h.planId!, { index: 0, result: 'dispatched' }),
      ),
    ).toBe('conflict');
    expect(
      (await plans.step(ctx, h.planId!, { index: 0, result: 'done' })).status,
    ).toBe('done');
  });

  it('аудит: done навигационного шага с expect.path без адреса — отказ (сверять нечего), план не продвинут', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const v = await create(ctx, typed(s, 'відкрий доставку'));
    await plans.step(ctx, v.planId!, { index: 0, result: 'dispatched' });
    for (const url of [undefined, null, 'не адрес'])
      expect(
        await failure(
          plans.step(ctx, v.planId!, { index: 0, result: 'done', url }),
        ),
      ).toBe('bad_request');
    expect((await planRows(s.siteId))[0]).toMatchObject({
      status: 'running',
      currentStep: 0,
    });
    const ok = await plans.step(ctx, v.planId!, {
      index: 0,
      result: 'done',
      url: s.url('/delivery'),
    });
    expect(ok.status).toBe('done');
  });

  it('аудит: продолжение после перехода сверяет значение с СЫРОЙ командой — телефон в шаге «после» находит цель', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    modelReply = JSON.stringify({
      command: true,
      steps: [
        { kind: 'click', target: 'e1' },
        {
          kind: 'fill',
          target: { text: 'Телефон', role: 'textbox' },
          value: '+380501234567',
        },
      ],
    });
    const v = await create(
      ctx,
      typed(s, 'відкрий доставку і введи телефон +380501234567'),
    );
    // Телефон — поле ПД: карточка «Да» до исполнения.
    expect(v.status).toBe('proposed');
    await plans.confirm(ctx, v.planId!, {
      by: 'button',
      stepsHash: v.stepsHash!,
    });
    await plans.step(ctx, v.planId!, { index: 0, result: 'dispatched' });
    await plans.step(ctx, v.planId!, {
      index: 0,
      result: 'done',
      url: s.url('/delivery'),
    });
    const r = await plans.resume(ctx, v.planId!, {
      snapshot: {
        url: s.url('/delivery'),
        elements: [
          {
            ref: 'e1',
            role: 'textbox',
            tag: 'input',
            inputType: 'tel',
            text: 'Телефон',
            inView: true,
          },
        ],
      },
    });
    expect(r.status).not.toBe('failed');
    expect(r.steps[1]).toMatchObject({
      kind: 'fill',
      value: '+380501234567',
      state: 'pending',
      target: { ref: 'e1', text: 'Телефон' },
    });
  });

  it('аудит: сырые значения — только пока план живой (liveValues); в шагах и журнале — маска; завершение, истечение (визит) и крон ретенции обнуляют', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const v = await create(ctx, typed(s, 'знайди ivan@example.com'));
    expect(v.steps[0].value).toBe('ivan@example.com');
    let [row] = await planRows(s.siteId);
    expect(JSON.stringify(row.steps)).not.toContain('ivan@example.com');
    // (заход 9, Р-З9-13) В базе — шифротекст: ни команды, ни значения.
    expect(row.liveValues).toEqual({
      v: 1,
      kv: 'v1',
      ct: expect.stringMatching(/^[\w-]+\.[\w-]+\.[\w-]+$/),
    });
    expect(JSON.stringify(row.liveValues)).not.toContain('ivan');
    expect(
      openLive(liveKeysFrom(st.env), row.liveValues, {
        planId: v.planId!,
        siteId: s.siteId,
      }),
    ).toEqual({ u: 'знайди ivan@example.com', v: ['ivan@example.com'] });
    // Шифротекст, переставленный в чужой план, не открывается.
    expect(
      openLive(liveKeysFrom(st.env), row.liveValues, {
        planId: 'other',
        siteId: s.siteId,
      }),
    ).toBeNull();
    // Отпечаток карточки и исполнитель — по сырому значению.
    expect((await plans.active(ctx))!.steps[0].value).toBe('ivan@example.com');
    await plans.step(ctx, v.planId!, { index: 0, result: 'dispatched' });
    [row] = await planRows(s.siteId);
    expect(row.liveValues).not.toBeNull();
    const done = await plans.step(ctx, v.planId!, {
      index: 0,
      result: 'done',
      url: s.url('/'),
    });
    expect(done.status).toBe('done');
    [row] = await planRows(s.siteId);
    expect(row.liveValues).toBeNull();
    expect(JSON.stringify(row)).not.toContain('ivan@example.com');
    expect(JSON.stringify(await logRows(s.siteId))).not.toContain(
      'ivan@example.com',
    );

    // Истёк без визита: следующий запрос посетителя обнуляет.
    const w = await create(ctx, typed(s, 'знайди ivan@example.com'));
    await st.owner.assistSiteUiPlan.update({
      where: { id: w.planId! },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await plans.active(ctx)).toBeNull();
    expect(
      (await st.owner.assistSiteUiPlan.findUnique({
        where: { id: w.planId! },
      }))!.liveValues,
    ).toBeNull();

    // Посетитель не вернулся — крон ретенции помощника.
    const x = await create(ctxOf(s), typed(s, 'знайди ivan@example.com'));
    await st.owner.assistSiteUiPlan.update({
      where: { id: x.planId! },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const ret = await st.retention.run();
    expect(ret.uiPlanValuesCleared).toBeGreaterThanOrEqual(1);
    expect(
      (await st.owner.assistSiteUiPlan.findUnique({
        where: { id: x.planId! },
      }))!.liveValues,
    ).toBeNull();
  });

  it('(заход 9, P2-1) значения плана не открылись (смена ключа) — план не исполняет маску: `failed`, `live_lost`, значения обнулены; без значений впереди — доисполняется', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    // План без значений (переход по ссылке) — другой посетитель.
    const other = ctxOf(s);
    const nav = await create(other, typed(s, 'відкрий доставку'));
    expect(nav.steps.every((x) => x.value === null)).toBe(true);
    const v = await create(ctx, typed(s, 'знайди ivan@example.com'));
    expect(v.steps[0].value).toBe('ivan@example.com');
    // Ключ сменили без ASSIST_SECRETS_KEYS_OLD (или откатили код/ключ).
    plans.env = { ...plans.env, ASSIST_SECRETS_KEY: 'другий-ключ' };
    try {
      expect(await plans.active(ctx)).toBeNull();
      expect(
        await failure(
          plans.step(ctx, v.planId!, { index: 0, result: 'dispatched' }),
        ),
      ).toBe('conflict');
      const row = await st.owner.assistSiteUiPlan.findUnique({
        where: { id: v.planId! },
      });
      expect(row).toMatchObject({ status: 'failed', liveValues: null });
      expect(JSON.stringify(row!.steps)).not.toContain('ivan@example.com');
      const lost = (await logRows(s.siteId)).filter(
        (l) => l.reason === 'live_lost',
      );
      expect(lost).toHaveLength(1);
      // Ни одного `dispatched` — исполнения не было.
      expect(
        (await logRows(s.siteId)).some(
          (l) => l.planId === v.planId && l.result === 'dispatched',
        ),
      ).toBe(false);
      // Масок впереди нет — план живёт и исполняется.
      expect((await plans.active(other))?.planId).toBe(nav.planId);
      const d = await plans.step(other, nav.planId!, {
        index: 0,
        result: 'dispatched',
      });
      expect(d.status).not.toBe('failed');
    } finally {
      plans.env = env;
    }
  });

  it('(заход 9, P3-4) без ASSIST_SECRETS_KEY — отказ `off` ДО модели и записи плана; битый ASSIST_SECRETS_KEYS_OLD — не роняет: работает текущий ключ', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    modelReply = JSON.stringify({ command: true, steps: [] });
    plans.env = { ...env, ASSIST_SECRETS_KEY: '' };
    try {
      expect(await failure(create(ctx, typed(s, 'покажи кошик')))).toBe('off');
      expect(modelCalls).toHaveLength(0);
      expect(await planRows(s.siteId)).toHaveLength(0);
      plans.env = { ...env, ASSIST_SECRETS_KEYS_OLD: 'мусор без двокрапки' };
      const v = await create(ctx, typed(s, 'знайди ivan@example.com'));
      expect((await plans.active(ctx))!.steps[0].value).toBe(
        'ivan@example.com',
      );
      expect(v.planId).toBeTruthy();
    } finally {
      plans.env = env;
    }
  });

  it('аудит: снимок больше SNAPSHOT_LIMITS.bodyChars — too_large до любой работы (0 планов, 0 вызовов модели)', async () => {
    const s = await vcSite();
    const big = {
      url: s.url('/'),
      title: 'Магазин',
      elements: Array.from({ length: 150 }, (_, i) => ({
        ref: `e${i + 1}`,
        role: 'button',
        tag: 'button',
        text: `Кнопка ${i} ${'х'.repeat(420)}`,
      })),
    };
    expect(
      await failure(
        create(ctxOf(s), typed(s, 'натисни кнопку', { snapshot: big })),
      ),
    ).toBe('too_large');
    expect(await planRows(s.siteId)).toHaveLength(0);
    expect(modelCalls).toHaveLength(0);
  });

  it('аудит: путь страницы с ПД — маской в плане, диалоге и журнале (e-mail, телефон, длинные цифры); даты не трогаются', async () => {
    const s = await vcSite();
    const ctx = ctxOf(s);
    const snap = {
      ...snapshot(s),
      url: s.url('/account/ivan@example.com/orders/1234567890123'),
    };
    const v = await create(
      ctx,
      typed(s, 'відкрий доставку', { snapshot: snap }),
    );
    const [row] = await planRows(s.siteId);
    expect(row.pageUrl).toBe(s.url('/account/:email/orders/:n'));
    const conv = await st.owner.assistSiteConversation.findUnique({
      where: { id: v.conversationId! },
    });
    expect(conv!.pageUrl).not.toContain('ivan@example.com');
    await plans.step(ctx, v.planId!, {
      index: 0,
      result: 'failed',
      reason: 'expect',
      url: s.url('/u/+380501234567/2026-10-03'),
    });
    const log = await logRows(s.siteId);
    expect(log.map((r) => r.url)).toEqual([
      s.url('/account/:email/orders/:n'),
      s.url('/u/:phone/2026-10-03'),
    ]);
    expect(JSON.stringify(log)).not.toContain('ivan@example.com');
    expect(JSON.stringify(log)).not.toContain('380501234567');
  });

  it('аудит (стык с Ш4): карта в промпте плана — своего вида вёрстки: снятое на телефоне компьютеру не предлагается', async () => {
    const s = await vcSite();
    const host = await st.owner.siteHost.findFirst({
      where: { siteId: s.siteId, host: s.host },
    });
    const key = uiMapKey(s.url('/'))!;
    await ingestUiSnapshot(new SitesDb(st.owner).forAccount(s.accountId), {
      accountId: s.accountId,
      siteId: s.siteId,
      hostId: host!.id,
      host: key.host,
      path: key.path,
      source: 'tutorial',
      viewport: 'mobile',
      elements: [{ selector: '#burger', tag: 'button', label: 'Бургер-меню' }],
      now: new Date(),
    });
    await create(
      { ...ctxOf(s), viewport: 'desktop' },
      typed(s, 'відкрий бургер меню'),
    );
    expect(modelCalls[0]).not.toContain('Бургер-меню');
    await create(
      { ...ctxOf(s), viewport: 'mobile' },
      typed(s, 'відкрий бургер меню'),
    );
    expect(modelCalls[1]).toContain('Бургер-меню');
  });

  it('план удаляется каскадом с диалогом (ретенция §6.3, «удалить мой диалог»)', async () => {
    const s = await vcSite();
    const v = await create(ctxOf(s), typed(s, 'відкрий доставку'));
    await st.owner.assistSiteConversation.delete({
      where: { id: v.conversationId! },
    });
    expect(await planRows(s.siteId)).toHaveLength(0);
    expect(await logRows(s.siteId)).toHaveLength(0);
    expect(randomUUID()).toBeTruthy();
  });
});
