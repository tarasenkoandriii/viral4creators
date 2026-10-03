/**
 * Приёмка Э6-бис (г) на реальном Postgres (ТЗ помощника §5-бис.10 п.14–16
 * в части Т-2/Т-4; решения владельца 03.10.2026 п.1–2): публичный код — под
 * ролью assist_public (как в проде), кабинет и монитор — основной ролью,
 * модель плана — подделка (команды мастера идут прямым путём без модели).
 *
 *  п.14 состояния: `on` без годного отчёта мастера — 409; `test` —
 *       голосовое управление только у тестовой сессии; `off` — всегда;
 *       выход из `degraded` — только отчётом новее деградации;
 *  п.15 мастер Т-2: одноразовая ссылка (сайт, origin, срок, один обмен),
 *       сухой прогон — 0 исполнений, запреты без звука — 100%, вердикт
 *       сервером по планам сессии, отчёт сдаётся один раз; годность отчёта
 *       (30 дней, выпуск загрузчика, разметка Ш4, partial + подтверждение);
 *  п.16 Т-4: поток ≥ 50 планов с done < 40% → `degraded` за один проход
 *       монитора; имитация нарушения запрета → `off` сразу (предохранитель
 *       базы), инцидент, служебный канал; на ≥ 2 сайтах — рубильник
 *       платформы; тревога — раз в сутки; откат канарейки;
 *  решение п.1 переходный период: `on` без отчёта 14 дней, затем `test`;
 *  решение п.2 ручной потолок планов оператора.
 * Т-3 (автотест на общем QA-воркере) — отложен до воркера (TODO I-П).
 */
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  readVoiceControlPlatform,
  readWidgetRelease,
  resetVoiceControlPlatformCache,
  writePlatformSetting,
} from '../../common/voice-control-platform';
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
import {
  VOICE_CONTROL_RISKS_VERSION,
  type UiPlanRequest,
} from '../../modules/assist-site-voice-control/api-types';
import { defaultVoiceControlRules } from '../../modules/assist-ui-core/rules';
import { VoiceControlSettingsService } from '../../modules/assist-site-voice-control/cabinet/voice-control-settings.service';
import {
  SiteUiPlanService,
  UiPlanError,
  type UiPlanCtx,
} from '../../modules/assist-site-voice-control/public/ui-plan.service';
import { VoiceTestService } from '../../modules/assist-site-voice-control/public/voice-test.service';
import { VoiceMonitorService } from '../../modules/assist-site-voice-control/system/voice-monitor.service';
import { GeminiText } from '../../modules/site-ai/text-model';
import type { AccountMembership } from '../../modules/site-core/account/roles';
import { SitesDb } from '../../prisma/sites-db.service';

jest.setTimeout(240_000);

describeDb('Приёмка Э6-бис (г) — мастер Т-2, монитор Т-4, состояния', () => {
  const st = new ChatStack();
  const fake = new FakeSoniox();
  let plans: SiteUiPlanService;
  let tests: VoiceTestService;
  let cab: VoiceControlSettingsService;
  let mon: VoiceMonitorService;
  let env: NodeJS.ProcessEnv;
  const accounts: string[] = [];
  const sent: Array<{ chat: string; text: string }> = [];
  const modelCalls: string[] = [];
  // Свои ключи настроек платформы: рубильник и выпуски — общие для всех
  // наборов на базе (кэш 30 с в процессе); монитор этого набора пишет сюда.
  const PKEY = `voice-control-t-${randomUUID().slice(0, 8)}`;
  const RKEY = `widget-release-t-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await st.init();
    env = {
      ...st.env,
      SONIOX_API_KEY: 'sx-test',
      ASSIST_VOICE_ENABLED: 'true',
      ASSIST_BOT_TOKEN: 'bot-test',
      ASSIST_TMA_URL: 'https://tma.example.invalid',
      ASSIST_OPS_CHAT_ID: '-1001',
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
          return {
            text: '{"command": true, "steps": []}',
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
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
    tests = new VoiceTestService(st.publicDb, plans);
    cab = new VoiceControlSettingsService(new SitesDb(st.owner), st.owner);
    cab.env = env;
    mon = new VoiceMonitorService(new SitesDb(st.owner), st.owner);
    mon.env = env;
    mon.onlyAccountIds = accounts;
    mon.platformKey = PKEY;
    mon.releaseKey = RKEY;
    mon.fetchImpl = async (url, init) => {
      const b = JSON.parse(init.body) as { chat_id: string; text: string };
      sent.push({ chat: b.chat_id, text: b.text });
      return { ok: true, status: 200 };
    };
  });
  afterAll(async () => {
    await st.owner.assistPlatformSetting.deleteMany({
      where: { key: { in: [PKEY, RKEY] } },
    });
    await st.close();
  });
  beforeEach(() => {
    sent.length = 0;
    modelCalls.length = 0;
    resetVoiceControlPlatformCache();
  });

  async function vcSite(state = 'test'): Promise<ChatSite> {
    const s = await st.site({ name: 'Магазин' });
    accounts.push(s.accountId);
    await setPlan(st.owner, s.accountId, 'business');
    // Подтверждение хоста — со сроком (ссылка мастера — только на годный хост).
    await st.owner.siteHost.updateMany({
      where: { siteId: s.siteId },
      data: { expiresAt: new Date(Date.now() + 30 * 86_400_000) },
    });
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: {
        voiceConfig: { schema: 1, input: true, output: false, voiceId: null },
        voiceControlSiteState: state,
      },
    });
    return s;
  }

  const owner = (s: ChatSite): AccountMembership => ({
    accountId: s.accountId,
    memberId: `m-${s.accountId.slice(0, 6)}`,
    telegramId: s.ownerTelegramId,
    role: 'owner',
    productRoles: { qa: 'admin', assist: 'manager', assistAdmin: 'owner' },
  });

  const snapshot = (s: ChatSite, path = '/') => ({
    url: s.url(path),
    title: 'Футболки магазин',
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
        role: 'link',
        tag: 'a',
        text: 'Контакти',
        href: s.url('/contacts'),
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
        text: 'Видалити акаунт',
        inView: true,
      },
      {
        ref: 'e6',
        role: 'searchbox',
        tag: 'input',
        inputType: 'search',
        text: 'Пошук',
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

  async function failure(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      if (e instanceof UiPlanError) return e.failure;
      if (e instanceof HttpException)
        return (e.getResponse() as { code: string }).code;
      throw e;
    }
    return 'ok';
  }

  async function cabCode(
    p: Promise<unknown>,
  ): Promise<[number, string, string?]> {
    try {
      await p;
    } catch (e) {
      if (e instanceof HttpException) {
        const r = e.getResponse() as {
          code: string;
          errors?: Array<{ code: string }>;
        };
        return [e.getStatus(), r.code, r.errors?.[0]?.code];
      }
      throw e;
    }
    return [200, 'ok'];
  }

  /** Ссылка мастера → тестовая сессия посетителя (как iframe после `?v4c_voicetest=`). */
  async function session(s: ChatSite, visitor = st.visitor()) {
    const link = await cab.testToken(owner(s), s.siteId, {});
    const token = new URL(link.url).searchParams.get('v4c_voicetest')!;
    const base: UiPlanCtx = { site: s.ctx(), visitor };
    const sess = await tests.exchange(base, { token });
    const ctx: UiPlanCtx = {
      ...base,
      voiceTest: { testId: sess.testId, testHost: sess.testHost },
    };
    return { link, token, sess, ctx };
  }

  /** Прогон «с нажатием» на безопасном: dispatched → done (как исполнитель). */
  async function runSafe(
    ctx: UiPlanCtx,
    s: ChatSite,
    text: string,
    path: string,
  ) {
    const v = await plans.create(ctx, typed(s, text), async () => true);
    expect(v.status).toBe('confirmed');
    await plans.step(ctx, v.planId!, { index: 0, result: 'dispatched' });
    await plans.step(ctx, v.planId!, {
      index: 0,
      result: 'done',
      url: s.url(path),
    });
    return v.planId!;
  }

  /** Полный «зелёный» мастер: сухой прогон 3 шага «верно», 2 из 2 с нажатием, запреты. */
  async function passWizard(s: ChatSite) {
    const w = await session(s);
    const dry: Array<{ planId: string; ok: number }> = [];
    for (const t of [
      'відкрий доставку',
      'відкрий контакти',
      'знайди футболки',
    ]) {
      const v = await plans.create(
        w.ctx,
        typed(s, t, { dryRun: true }),
        async () => true,
      );
      dry.push({ planId: v.planId!, ok: 1 });
    }
    await runSafe(w.ctx, s, 'відкрий доставку', '/delivery');
    await runSafe(w.ctx, s, 'відкрий контакти', '/contacts');
    const r = await tests.report(w.ctx, w.sess.testId, {
      lang: 'uk',
      snapshot: snapshot(s),
      env: { widget: true, chunks: true, csp: 0, tt: 0, micPolicy: 'allowed' },
      mic: 'ok',
      markup: {
        total: 6,
        withId: 0,
        unnamed: [],
        closedShadow: 0,
        extIframes: 0,
        duplicates: [],
        denied: 0,
      },
      suspicious: [
        {
          key: 's1',
          why: 'icon_trash',
          tag: 'button',
          label: '',
          selector: 'button.trash',
        },
      ],
      reviewed: { s1: 'deny' },
      dry,
    });
    return { ...w, report: r };
  }

  // ── п.14: состояния ──────────────────────────────────────────────────────

  it('п.14: `on` без отчёта — 409 (none); `test` — режим только у тестовой сессии; обычный посетитель — off', async () => {
    const s = await vcSite('off');
    expect(
      await cabCode(
        cab.save(owner(s), s.siteId, {
          state: 'on',
          risksVersion: VOICE_CONTROL_RISKS_VERSION,
        }),
      ),
    ).toEqual([409, 'VOICE_CONTROL_TEST_REQUIRED', 'none']);
    const v = await cab.save(owner(s), s.siteId, {
      state: 'test',
      risksVersion: VOICE_CONTROL_RISKS_VERSION,
    });
    expect(v.state).toBe('test');
    // Причина для кабинета — именно «только тест», не «выключено».
    expect(v.reason).toBe('state_test');
    // Обычный посетитель в `test` — режима нет, 0 планов.
    expect(
      await failure(
        plans.create(
          { site: s.ctx(), visitor: st.visitor() },
          typed(s, 'відкрий доставку'),
          async () => true,
        ),
      ),
    ).toBe('off');
    // Тестовая сессия — план есть, помечен тестом, диалогов тарифа не тратит.
    const { ctx, sess } = await session(s);
    expect(sess.voiceControl.mode).toBe('on');
    let dayHits = 0;
    const p = await plans.create(
      ctx,
      typed(s, 'відкрий доставку'),
      async () => {
        dayHits++;
        return true;
      },
    );
    expect(p.status).toBe('confirmed');
    expect(dayHits).toBe(0);
    const row = await st.owner.assistSiteUiPlan.findUnique({
      where: { id: p.planId! },
    });
    expect(row!.voiceTestId).toBe(sess.testId);
    const usage = await st.owner.assistAccountUsage.findMany({
      where: { accountId: s.accountId },
    });
    expect(usage.reduce((a, u) => a + Number(u.units), 0)).toBe(0);
  });

  it('п.15: ссылка мастера одноразовая, только этот сайт и origin, со сроком; сессия — своему посетителю', async () => {
    const s = await vcSite();
    const other = await vcSite();
    const link = await cab.testToken(owner(s), s.siteId, {});
    expect(link.url.startsWith(`${s.origin}/?v4c_voicetest=`)).toBe(true);
    const token = new URL(link.url).searchParams.get('v4c_voicetest')!;
    const row = await st.owner.assistSiteVoiceTest.findUnique({
      where: { id: link.testId },
    });
    // В базе — только хеш.
    expect(row!.tokenHash).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token);
    const v = st.visitor();
    // Чужой сайт, чужой origin — недействительна.
    expect(
      await failure(
        tests.exchange({ site: other.ctx(), visitor: v }, { token }),
      ),
    ).toBe('not_found');
    expect(
      await failure(
        tests.exchange(
          {
            site: s.ctx({ parentOrigin: 'https://evil.example.org' }),
            visitor: v,
          },
          { token },
        ),
      ),
    ).toBe('not_found');
    const ok = await tests.exchange({ site: s.ctx(), visitor: v }, { token });
    expect(ok.testId).toBe(link.testId);
    // Второй обмен — нет.
    expect(
      await failure(
        tests.exchange({ site: s.ctx(), visitor: st.visitor() }, { token }),
      ),
    ).toBe('not_found');
    // Сессия — только своему посетителю.
    expect(
      await tests.session({ site: s.ctx(), visitor: v }, ok.session),
    ).toEqual({
      testId: link.testId,
      testHost: false,
    });
    expect(
      await tests.session({ site: s.ctx(), visitor: st.visitor() }, ok.session),
    ).toBeNull();
    expect(
      await tests.session({ site: s.ctx(), visitor: v }, 'x'.repeat(43)),
    ).toBeNull();
    // Истёкшая ссылка.
    const late = await cab.testToken(owner(s), s.siteId, {});
    await st.owner.assistSiteVoiceTest.update({
      where: { id: late.testId },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      await failure(
        tests.exchange(
          { site: s.ctx(), visitor: st.visitor() },
          { token: new URL(late.url).searchParams.get('v4c_voicetest')! },
        ),
      ),
    ).toBe('not_found');
  });

  it('п.15: сухой прогон — только мастеру; план проверен, статус done, исполнить нельзя (0 событий)', async () => {
    const s = await vcSite();
    expect(
      await failure(
        plans.create(
          { site: s.ctx(), visitor: st.visitor() },
          typed(s, 'відкрий доставку', { dryRun: true }),
          async () => true,
        ),
      ),
    ).toBe('off');
    const { ctx } = await session(s);
    const v = await plans.create(
      ctx,
      typed(s, 'відкрий доставку', { dryRun: true }),
      async () => true,
    );
    expect(v).toMatchObject({ status: 'done', needsConfirm: false });
    expect(v.steps[0].target!.text).toBe('Доставка');
    expect(
      await failure(
        plans.step(ctx, v.planId!, { index: 0, result: 'dispatched' }),
      ),
    ).toBe('conflict');
    const row = await st.owner.assistSiteUiPlan.findUnique({
      where: { id: v.planId! },
    });
    expect(row).toMatchObject({
      dryRun: true,
      liveValues: null,
      status: 'done',
    });
  });

  it('п.15: анализ — команды мастера безопасные, запреты без звука 100%, список 1', async () => {
    const s = await vcSite();
    const { ctx, sess } = await session(s);
    const a = await tests.analyze(ctx, sess.testId, {
      snapshot: snapshot(s),
      lang: 'uk',
    });
    expect(a.commands.map((c) => c.text)).toEqual(
      expect.arrayContaining([
        'відкрий «Доставка»',
        'відкрий «Контакти»',
        'знайди Футболки',
      ]),
    );
    expect(a.commands.map((c) => c.text).join()).not.toMatch(
      /Партнер|Оплатити|Видалити/,
    );
    expect(a.forbidden).toHaveLength(5);
    expect(a.forbidden.every((f) => f.blocked)).toBe(true);
    expect(a.never.map((n) => n.text)).toEqual(
      expect.arrayContaining(['Оплатити', 'Видалити акаунт']),
    );
    // Чужой тест — недействителен.
    expect(
      await failure(tests.analyze(ctx, 'other', { snapshot: snapshot(s) })),
    ).toBe('not_found');
    expect(
      await failure(
        tests.analyze({ ...ctx, voiceTest: null }, sess.testId, {
          snapshot: snapshot(s),
        }),
      ),
    ).toBe('not_found');
  });

  it('п.15 + решение п.1: «зелёный» мастер → отчёт pass (вердикт по планам сессии в базе), один раз; `on` — можно', async () => {
    const s = await vcSite();
    const w = await passWizard(s);
    expect(w.report.result).toBe('pass');
    expect(w.report.report.safe.map((x) => x.done)).toEqual([true, true]);
    expect(w.report.report.dry.reduce((a, d) => a + d.ok, 0)).toBe(3);
    expect(w.report.report.denySuggestions).toEqual(['button.trash']);
    expect(w.report.report.fragment).toContain('data-assist="never"');
    // Сессия закрыта сдачей: заголовок больше не даёт тестовой сессии, а
    // повторная сдача (даже со «старым» контекстом) — конфликт, отчёт прежний.
    expect(
      await tests.session(
        { site: s.ctx(), visitor: w.ctx.visitor },
        w.sess.session,
      ),
    ).toBeNull();
    expect(
      await failure(
        tests.report(w.ctx, w.sess.testId, {
          snapshot: snapshot(s),
          env: {},
          mic: 'ok',
          markup: {},
          suspicious: [],
          reviewed: {},
          dry: [],
        }),
      ),
    ).toBe('conflict');
    const v = await cab.save(owner(s), s.siteId, {
      state: 'on',
      risksVersion: VOICE_CONTROL_RISKS_VERSION,
    });
    expect(v).toMatchObject({ state: 'on', reason: null, checkDeadline: null });
    expect(v.lastTest).toMatchObject({ result: 'pass', problem: null });
    const row = await st.owner.assistSite.findUnique({
      where: { siteId: s.siteId },
    });
    expect(row!.voiceControlSiteTestId).toBe(w.sess.testId);
  });

  it('п.15: «не тот» сухой прогон, утечка и недопросмотр — partial; partial включается только с подтверждением; fail — нет', async () => {
    const s = await vcSite();
    const w = await session(s);
    const r = await tests.report(w.ctx, w.sess.testId, {
      lang: 'uk',
      snapshot: snapshot(s),
      env: { widget: true, chunks: true, csp: 0, tt: 0, micPolicy: 'allowed' },
      mic: 'ok',
      markup: {},
      suspicious: [
        {
          key: 's1',
          why: 'class_danger',
          tag: 'a',
          label: '',
          selector: 'a.remove',
        },
      ],
      reviewed: {},
      dry: [],
    });
    expect(r.result).toBe('partial');
    expect(
      await cabCode(
        cab.save(owner(s), s.siteId, {
          state: 'on',
          risksVersion: VOICE_CONTROL_RISKS_VERSION,
        }),
      ),
    ).toEqual([409, 'VOICE_CONTROL_TEST_REQUIRED', 'partial_ack']);
    const v = await cab.save(owner(s), s.siteId, {
      state: 'on',
      partialAck: true,
    });
    expect(v.state).toBe('on');
    expect(v.lastTest!.partialAck).toBe(true);
    // Политика сайта запрещает микрофон — fail, включить нельзя.
    const s2 = await vcSite();
    const w2 = await session(s2);
    const r2 = await tests.report(w2.ctx, w2.sess.testId, {
      snapshot: snapshot(s2),
      env: { widget: true, chunks: true, csp: 0, tt: 0, micPolicy: 'denied' },
      mic: 'denied_policy',
      markup: {},
      suspicious: [],
      reviewed: {},
      dry: [],
    });
    expect(r2.result).toBe('fail');
    expect(
      r2.report.items.find((i) => i.code === 'mic_policy_denied'),
    ).toBeTruthy();
    expect(
      await cabCode(
        cab.save(owner(s2), s2.siteId, { state: 'on', partialAck: true }),
      ),
    ).toEqual([409, 'VOICE_CONTROL_TEST_REQUIRED', 'failed']);
  });

  it('решение п.1: отчёт годен 30 дней, до смены загрузчика и разметки проверенных страниц', async () => {
    const s = await vcSite();
    const w = await passWizard(s);
    const id = w.sess.testId;
    const prob = async () =>
      (await cab.get(owner(s), s.siteId)).lastTest!.problem;
    expect(await prob()).toBeNull();
    // Разметка: элемент проверенной страницы устарел (Ш4) после отчёта.
    const host = await st.owner.siteHost.findFirst({
      where: { siteId: s.siteId },
    });
    await st.owner.siteUiElement.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        hostId: host!.id,
        host: s.host,
        path: '/',
        viewport: 'desktop',
        elementKey: 'text:кошик',
        elementId: 'el-cart',
        tag: 'button',
        label: 'Кошик',
        selector: 'button.cart',
        candidates: [],
        stability: 'medium',
        confidence: 50,
        sources: ['crawl'],
        sourceRank: 4,
        position: 0,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        staleDesktopAt: new Date(Date.now() + 1000),
      },
    });
    expect(await prob()).toBe('markup_changed');
    await st.owner.siteUiElement.deleteMany({ where: { siteId: s.siteId } });
    // Загрузчик: отчёт снят на другом выпуске.
    await st.owner.assistSiteVoiceTest.update({
      where: { id },
      data: { release: '2026.09.01-1' },
    });
    expect(await prob()).toBe('loader_changed');
    await st.owner.assistSiteVoiceTest.update({
      where: { id },
      data: { release: null },
    });
    // 30 дней.
    await st.owner.assistSiteVoiceTest.update({
      where: { id },
      data: { validUntil: new Date(Date.now() - 1) },
    });
    expect(await prob()).toBe('expired');
    expect(
      await cabCode(
        cab.save(owner(s), s.siteId, {
          state: 'on',
          risksVersion: VOICE_CONTROL_RISKS_VERSION,
        }),
      ),
    ).toEqual([409, 'VOICE_CONTROL_TEST_REQUIRED', 'expired']);
  });

  // ── решение п.1: переходный период ──────────────────────────────────────

  it('решение п.1: `on` без отчёта (до мастера) — 14 дней баннера, затем монитор → `test`, уведомление', async () => {
    const s = await vcSite('on');
    const later = await vcSite('on');
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: { voiceControlCheckDeadline: new Date(Date.now() - 1000) },
    });
    await st.owner.assistSite.update({
      where: { siteId: later.siteId },
      data: { voiceControlCheckDeadline: new Date(Date.now() + 86_400_000) },
    });
    expect(
      (await cab.get(owner(later), later.siteId)).checkDeadline,
    ).not.toBeNull();
    const r = await mon.run();
    expect(r.transitions).toBeGreaterThanOrEqual(1);
    const a = await st.owner.assistSite.findUnique({
      where: { siteId: s.siteId },
    });
    expect(a).toMatchObject({
      voiceControlSiteState: 'test',
      voiceControlSiteStateBy: 'transition',
      voiceControlCheckDeadline: null,
    });
    const b = await st.owner.assistSite.findUnique({
      where: { siteId: later.siteId },
    });
    expect(b!.voiceControlSiteState).toBe('on');
    expect(sent.some((m) => m.text.includes('«Тест»'))).toBe(true);
    const inc = await st.owner.assistSiteVoiceIncident.findMany({
      where: { siteId: s.siteId },
    });
    expect(inc.map((i) => i.kind)).toEqual(['transition']);
  });

  // ── п.16: нарушение запрета ─────────────────────────────────────────────

  it('п.16: имитация нарушения запрета → шаг не подтверждён, сайт `off` сразу (функция базы), инцидент и служебный канал; ≥ 2 сайта — рубильник платформы', async () => {
    const victims: ChatSite[] = [];
    for (let k = 0; k < 2; k++) {
      const s = await vcSite('on');
      victims.push(s);
      const ctx: UiPlanCtx = { site: s.ctx(), visitor: st.visitor() };
      const v = await plans.create(
        ctx,
        typed(s, 'відкрий доставку'),
        async () => true,
      );
      // Тест-хук стенда: «дефект кода» подменил цель шага на кнопку оплаты.
      const row = await st.owner.assistSiteUiPlan.findUnique({
        where: { id: v.planId! },
      });
      const steps = row!.steps as Array<Record<string, unknown>>;
      steps[0] = {
        ...steps[0],
        target: {
          ref: 'e3',
          assistId: null,
          role: 'button',
          text: 'Оплатити',
          selector: null,
          href: null,
        },
        nav: false,
      };
      await st.owner.assistSiteUiPlan.update({
        where: { id: v.planId! },
        data: { steps: steps as never },
      });
      expect(
        await failure(
          plans.step(ctx, v.planId!, { index: 0, result: 'dispatched' }),
        ),
      ).toBe('off');
      const site = await st.owner.assistSite.findUnique({
        where: { siteId: s.siteId },
      });
      expect(site).toMatchObject({
        voiceControlSiteState: 'off',
        voiceControlSiteStateBy: 'violation',
      });
      const plan = await st.owner.assistSiteUiPlan.findUnique({
        where: { id: v.planId! },
      });
      expect(plan!.status).toBe('stopped');
      expect((plan!.steps as Array<{ state: string }>)[0].state).toBe(
        'pending',
      );
      const log = await st.owner.assistSiteUiActionLog.findMany({
        where: { planId: v.planId!, action: 'violation' },
      });
      expect(log.map((l) => l.reason)).toEqual(['payment']);
    }
    const r = await mon.run();
    expect(r.violations).toBe(2);
    expect(r.platformOff).toBe(true);
    expect(
      sent.filter((m) => m.chat === '-1001').length,
    ).toBeGreaterThanOrEqual(3);
    for (const s of victims) {
      const inc = await st.owner.assistSiteVoiceIncident.findMany({
        where: { siteId: s.siteId },
      });
      expect(inc).toEqual([
        expect.objectContaining({ kind: 'off', code: 'violation' }),
      ]);
    }
    resetVoiceControlPlatformCache();
    expect(
      (await readVoiceControlPlatform(st.owner, Date.now(), PKEY)).enabled,
    ).toBe(false);
    // Повторный проход — без новых инцидентов.
    const again = await mon.run();
    expect(again.violations).toBe(0);
    // Аудит (г) 03.10: оператор включил платформу после разбора — те же
    // нарушения окна её снова не выключают.
    await writePlatformSetting(
      st.owner,
      PKEY,
      { enabled: true, reason: null, at: new Date().toISOString() },
      'operator',
    );
    resetVoiceControlPlatformCache();
    expect((await mon.run()).platformOff).toBe(false);
    resetVoiceControlPlatformCache();
    expect(
      (await readVoiceControlPlatform(st.owner, Date.now(), PKEY)).enabled,
    ).toBe(true);
    // Включить обратно — только новым мастером (отчёт новее выключения).
    const s = victims[0];
    expect(
      await cabCode(
        cab.save(owner(s), s.siteId, {
          state: 'on',
          risksVersion: VOICE_CONTROL_RISKS_VERSION,
        }),
      ),
    ).toEqual([409, 'VOICE_CONTROL_TEST_REQUIRED', 'none']);
  });

  it('рубильник платформы в базе выключает режим у всех (как env)', async () => {
    const s = await vcSite('on');
    await writePlatformSetting(
      st.owner,
      'voice-control',
      { enabled: false, reason: 'operator', at: null },
      't',
    );
    try {
      expect(
        await failure(
          plans.create(
            { site: s.ctx(), visitor: st.visitor() },
            typed(s, 'відкрий доставку'),
            async () => true,
          ),
        ),
      ).toBe('off');
    } finally {
      await writePlatformSetting(
        st.owner,
        'voice-control',
        { enabled: true, reason: null, at: null },
        't',
      );
      resetVoiceControlPlatformCache();
    }
  });

  // ── аудит (г) 03.10 ─────────────────────────────────────────────────────

  it('аудит: запрет кабинета, введённый во время плана, — шаг не исполняется, но это не «нарушение»: сайт не выключается, рубильник не трогается', async () => {
    const s = await vcSite('on');
    const ctx: UiPlanCtx = { site: s.ctx(), visitor: st.visitor() };
    const v = await plans.create(
      ctx,
      typed(s, 'відкрий доставку'),
      async () => true,
    );
    expect(v.status).toBe('confirmed');
    // Владелец (мастер подсказал) запретил слово — пока план идёт.
    await cab.save(owner(s), s.siteId, {
      state: 'on',
      rules: { ...defaultVoiceControlRules(), denyWords: ['доставка'] },
    });
    expect(
      await failure(
        plans.step(ctx, v.planId!, { index: 0, result: 'dispatched' }),
      ),
    ).toBe('conflict');
    const site = await st.owner.assistSite.findUnique({
      where: { siteId: s.siteId },
    });
    expect(site!.voiceControlSiteState).toBe('on');
    const plan = await st.owner.assistSiteUiPlan.findUnique({
      where: { id: v.planId! },
    });
    expect(plan!.status).toBe('failed');
    expect((plan!.steps as Array<{ state: string }>)[0].state).toBe('failed');
    const logs = await st.owner.assistSiteUiActionLog.findMany({
      where: { planId: v.planId! },
    });
    expect(logs.some((l) => l.action === 'violation')).toBe(false);
    expect(
      logs.some((l) => l.result === 'failed' && l.reason === 'denied'),
    ).toBe(true);
    const r = await mon.run();
    expect(r.violations).toBe(0);
    expect(r.platformOff).toBe(false);
  });

  it('аудит: после понижения `test` → `on` старым отчётом — нельзя (нужен отчёт новее понижения)', async () => {
    const s = await vcSite();
    await passWizard(s);
    await cab.save(owner(s), s.siteId, {
      state: 'on',
      risksVersion: VOICE_CONTROL_RISKS_VERSION,
    });
    // Монитор понизил (журнал + состояние), владелец ушёл в `test`.
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: {
        voiceControlSiteState: 'degraded',
        voiceControlSiteStateAt: new Date(),
        voiceControlSiteStateBy: 'monitor',
      },
    });
    await st.owner.assistSiteVoiceIncident.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        kind: 'degraded',
        code: 'done_low',
      },
    });
    expect((await cab.save(owner(s), s.siteId, { state: 'test' })).state).toBe(
      'test',
    );
    expect(
      await cabCode(cab.save(owner(s), s.siteId, { state: 'on' })),
    ).toEqual([409, 'VOICE_CONTROL_TEST_REQUIRED', 'older_than_state']);
    await passWizard(s);
    expect((await cab.save(owner(s), s.siteId, { state: 'on' })).state).toBe(
      'on',
    );
  });

  it('аудит: гонка — сайт понижен между проверкой отчёта и записью `on` — 409, понижение не затёрто', async () => {
    const s = await vcSite();
    await passWizard(s);
    const c = cab as unknown as {
      usableReport: (...a: unknown[]) => Promise<unknown>;
    };
    const orig = c.usableReport.bind(cab);
    c.usableReport = async (...a: unknown[]) => {
      const t = await orig(...a);
      // «Предохранитель» выключил сайт, пока кабинет проверял отчёт.
      await st.owner.assistSite.update({
        where: { siteId: s.siteId },
        data: {
          voiceControlSiteState: 'off',
          voiceControlSiteStateAt: new Date(),
          voiceControlSiteStateBy: 'violation',
        },
      });
      return t;
    };
    try {
      expect(
        await cabCode(
          cab.save(owner(s), s.siteId, {
            state: 'on',
            risksVersion: VOICE_CONTROL_RISKS_VERSION,
          }),
        ),
      ).toEqual([409, 'VOICE_CONTROL_TEST_REQUIRED', 'older_than_state']);
    } finally {
      c.usableReport = orig;
    }
    const site = await st.owner.assistSite.findUnique({
      where: { siteId: s.siteId },
    });
    expect(site).toMatchObject({
      voiceControlSiteState: 'off',
      voiceControlSiteStateBy: 'violation',
    });
  });

  it('аудит: метка выпуска плана — только выпуск этого сайта (чужую канарейку посетитель не подставит)', async () => {
    const s = await vcSite('on');
    const ctx: UiPlanCtx = { site: s.ctx(), visitor: st.visitor() };
    const v = await plans.create(
      ctx,
      typed(s, 'відкрий доставку', { release: 'r9-canary' }),
      async () => true,
    );
    const row = await st.owner.assistSiteUiPlan.findUnique({
      where: { id: v.planId! },
    });
    expect(row!.release).toBeNull();
  });

  // ── п.16: деградация и тревога по потоку ────────────────────────────────

  /**
   * Поток планов боя: `done` исполненных и `failed` (цель не найдена); каждый
   * план — свой посетитель (как в бою), `oneVisitor` — все от одного
   * (накрутка, аудит (г) 03.10).
   */
  async function stream(
    s: ChatSite,
    done: number,
    notFound: number,
    release: string | null = null,
    oneVisitor = false,
  ) {
    let seq = 0;
    const conv = await st.owner.assistSiteConversation.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        visitorId: 'v-stream',
        ipHash: 'ip',
        parentOrigin: s.origin,
        lastMessageAt: new Date(),
      },
    });
    const mk = async (ok: boolean) => {
      const p = await st.owner.assistSiteUiPlan.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          conversationId: conv.id,
          visitorId: oneVisitor ? 'v-stream' : `v-stream-${seq++}`,
          utteranceMasked: ok ? 'відкрий доставку' : 'відкрий кошик',
          source: 'typed',
          pageUrl: s.url('/'),
          steps: [
            {
              kind: 'click',
              risk: 'auto',
              state: ok ? 'done' : 'failed',
              target: { text: 'Доставка', role: 'link', assistId: null },
            },
          ],
          status: ok ? 'done' : 'failed',
          needsConfirm: false,
          confirmedBy: 'auto',
          confirmBefore: new Date(),
          expiresAt: new Date(),
          release,
        },
      });
      await st.owner.assistSiteUiActionLog.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          planId: p.id,
          stepIndex: 0,
          action: 'click',
          risk: 'auto',
          result: ok ? 'done' : 'failed',
          reason: ok ? null : 'no_target',
        },
      });
    };
    for (let i = 0; i < done; i++) await mk(true);
    for (let i = 0; i < notFound; i++) await mk(false);
  }

  it('п.16: ≥ 50 планов и done < 40% → `degraded` за один проход; подсказка вместо нажатий; выход — только новым pass', async () => {
    const s = await vcSite();
    await passWizard(s);
    await cab.save(owner(s), s.siteId, {
      state: 'on',
      risksVersion: VOICE_CONTROL_RISKS_VERSION,
    });
    await stream(s, 15, 35);
    const r = await mon.run();
    expect(r.degraded).toBeGreaterThanOrEqual(1);
    const row = await st.owner.assistSite.findUnique({
      where: { siteId: s.siteId },
    });
    expect(row).toMatchObject({
      voiceControlSiteState: 'degraded',
      voiceControlSiteStateBy: 'monitor',
      voiceControlSiteStateReason: 'done_low',
    });
    const inc = await st.owner.assistSiteVoiceIncident.findMany({
      where: { siteId: s.siteId },
    });
    expect(inc.map((i) => i.kind)).toEqual(['degraded']);
    expect(sent.some((m) => m.text.includes('режим підказки'))).toBe(true);
    // В `degraded` — только подсветка и «нажмите сами», 0 исполнимых шагов.
    const v = await plans.create(
      { site: s.ctx(), visitor: st.visitor() },
      typed(s, 'відкрий доставку'),
      async () => true,
    );
    expect(v.steps.every((x) => x.risk === 'manual')).toBe(true);
    // Кабинет: метрики видны владельцу.
    const view = await cab.get(owner(s), s.siteId);
    expect(view.monitor!.metrics).toMatchObject({
      plans: 50,
      done: 15,
      notFound: 35,
    });
    // Выход из деградации старым отчётом — нет; новым pass — да.
    expect(
      await cabCode(cab.save(owner(s), s.siteId, { state: 'on' })),
    ).toEqual([409, 'VOICE_CONTROL_TEST_REQUIRED', 'older_than_state']);
    await passWizard(s);
    expect((await cab.save(owner(s), s.siteId, { state: 'on' })).state).toBe(
      'on',
    );
  });

  it('п.16: ≥ 20 планов и done < 60% — тревога владельцу, раз в сутки; деградации нет', async () => {
    const s = await vcSite();
    await passWizard(s);
    await cab.save(owner(s), s.siteId, {
      state: 'on',
      risksVersion: VOICE_CONTROL_RISKS_VERSION,
    });
    await stream(s, 10, 10);
    const r = await mon.run();
    expect(r.alerts).toBeGreaterThanOrEqual(1);
    expect(
      (await st.owner.assistSite.findUnique({ where: { siteId: s.siteId } }))!
        .voiceControlSiteState,
    ).toBe('on');
    const before = await st.owner.assistSiteVoiceIncident.count({
      where: { siteId: s.siteId },
    });
    await mon.run();
    expect(
      await st.owner.assistSiteVoiceIncident.count({
        where: { siteId: s.siteId },
      }),
    ).toBe(before);
  });

  it('канарейка выпусков: done канарейки на > 10 п.п. ниже стабильного (≥ 50 планов) — откат, служебный канал', async () => {
    const a = await vcSite('on');
    const b = await vcSite('on');
    await writePlatformSetting(
      st.owner,
      RKEY,
      {
        stable: 'r1-test',
        canary: 'r2-test',
        canaryPercent: 10,
        canarySince: new Date(Date.now() - 3_600_000).toISOString(),
        rolledBack: null,
      },
      't',
    );
    // Метрики канарейки — по всем планам выпуска (не только кабинеты набора);
    // выпуски этого набора уникальны.
    await stream(a, 20, 30, 'r2-test');
    await stream(b, 45, 5, 'r1-test');
    const r = await mon.run();
    expect(r.rolledBack).toBe(true);
    resetVoiceControlPlatformCache();
    const rel = await readWidgetRelease(st.owner, Date.now(), RKEY);
    expect(rel).toMatchObject({ stable: 'r1-test', canary: null });
    expect(rel.rolledBack).toMatchObject({
      release: 'r2-test',
      reason: 'done_drop',
    });
    expect(
      sent.some((m) => m.chat === '-1001' && m.text.includes('r2-test')),
    ).toBe(true);
  });

  // ── решение п.2: потолок планов ─────────────────────────────────────────

  it('решение п.2: потолок планов сайта — тариф (Business 300) или ручной оверрайд оператора', async () => {
    const s = await vcSite('on');
    const limits: number[] = [];
    const hit = async (l: number) => {
      limits.push(l);
      return true;
    };
    const ctx: UiPlanCtx = { site: s.ctx(), visitor: st.visitor() };
    await plans.create(ctx, typed(s, 'відкрий доставку'), hit);
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: { voiceControlPlansPerDay: 5000 },
    });
    await plans.create(ctx, typed(s, 'відкрий доставку'), hit);
    expect(limits).toEqual([300, 5000]);
    expect((await cab.get(owner(s), s.siteId)).plansPerDay).toBe(5000);
  });

  it('контрольные команды: из отчёта мастера (дескрипторы, без значений) — монитором', async () => {
    const s = await vcSite();
    await passWizard(s);
    await cab.save(owner(s), s.siteId, {
      state: 'on',
      risksVersion: VOICE_CONTROL_RISKS_VERSION,
    });
    await mon.run();
    const cmds = await st.owner.assistSiteVoiceControlCommand.findMany({
      where: { siteId: s.siteId },
    });
    expect(cmds.length).toBeGreaterThanOrEqual(2);
    expect(cmds.every((c) => c.origin === 'wizard')).toBe(true);
    expect(
      cmds.map((c) => (c.expected as Array<{ text: string }>)[0].text),
    ).toEqual(expect.arrayContaining(['Доставка', 'Контакти']));
  });

  it('два тенанта: отчёты и журнал монитора чужого кабинета не видны', async () => {
    const a = await vcSite();
    const b = await vcSite();
    const w = await session(a);
    expect(await cabCode(cab.test(owner(b), b.siteId, w.sess.testId))).toEqual([
      404,
      'VOICE_CONTROL_TEST_NOT_FOUND',
    ]);
    expect((await cab.tests(owner(b), b.siteId)).items).toEqual([]);
  });
});
