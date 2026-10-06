/**
 * Хвосты аудита Э6-бис (е) «Мемо — ядро» и Э8-хвоста (а) на реальном
 * Postgres (06.10.2026): кабинет — основной ролью, публичный код — ролью
 * assist_public, модель — подделка. Всё — в своих кабинетах/сайтах
 * (монитор — `onlyAccountIds`): параллельные файлы jest на той же базе не
 * мешают.
 *  - ссылка сухого прогона и хост ворот — только хост «Сайта» (не «Админки»);
 *  - лимит тарифа: гонка параллельных созданий, «сверх тарифа» после
 *    понижения (TMA — `overPlan`, бой — первые N по номеру);
 *  - `needs_review` после публикации голосовой карты (цель «никогда»);
 *  - `no_target` (цель шага не найдена) — сбой шага для монитора;
 *  - хеш IP плана — соль на окно: один адрес у разных посетителей — один IP;
 *  - отчёт о возврате полей — только в окне «Вернуть».
 */
import { HttpException } from '@nestjs/common';
import { setPlan } from '../../assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../assist-sandbox/testing/k3-stack.testing';
import {
  ChatStack,
  type ChatSite,
} from '../../assist-site-chat/testing/chat-stack.testing';
import { SiteVoiceService } from '../../assist-site-voice/public/site-voice.service';
import { SiteSonioxStt } from '../../assist-site-voice/public/soniox-stt.client';
import { SiteSonioxTts } from '../../assist-site-voice/public/soniox-tts.client';
import { FakeSoniox } from '../../assist-site-voice/testing/fake-soniox.testing';
import { VoiceMapService } from '../../assist-site-voice-map/voice-map.service';
import { MEMO_DECISIONS } from '../../assist-ui-core/decisions';
import { GeminiText } from '../../site-ai/text-model';
import type { AccountMembership } from '../../site-core/account/roles';
import { markAdminHosts } from '../../site-core/testing/admin-hosts.testing';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { UiPlanRequest, UiPlanView } from '../api-types';
import {
  SiteUiPlanService,
  UiPlanError,
  type UiPlanCtx,
} from '../public/ui-plan.service';
import { VoiceTestService } from '../public/voice-test.service';
import { VoiceMonitorService } from '../system/voice-monitor.service';
import { MemoService } from './memo.service';
import { serializeDbTests } from '../../../prisma/serial-lock.testing';

jest.setTimeout(300_000);

describeDb(
  'Аудит Э6-бис (е): мемо — хосты, лимит, карта, монитор, IP, возврат',
  () => {
    serializeDbTests('voice-monitor');
    const st = new ChatStack();
    const fake = new FakeSoniox();
    let plans: SiteUiPlanService;
    let tests: VoiceTestService;
    let memos: MemoService;
    let mon: VoiceMonitorService;
    let maps: VoiceMapService;
    let modelReply = '{"command": true, "steps": []}';
    const accounts: string[] = [];

    beforeAll(async () => {
      await st.init();
      const env = {
        ...st.env,
        SONIOX_API_KEY: 'sx-test',
        ASSIST_VOICE_ENABLED: 'true',
        ASSIST_BOT_TOKEN: 'bot-test',
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
      memos = new MemoService(new SitesDb(st.owner), st.owner);
      mon = new VoiceMonitorService(new SitesDb(st.owner), st.owner);
      mon.env = env;
      mon.onlyAccountIds = accounts;
      mon.fetchImpl = async () => ({ ok: true, status: 200 });
      maps = new VoiceMapService(new SitesDb(st.owner));
    });
    afterAll(async () => {
      await st.close();
    });
    beforeEach(() => {
      modelReply = '{"command": true, "steps": []}';
      plans.now = () => new Date();
    });

    async function vcSite(): Promise<ChatSite> {
      const s = await st.site({ name: 'Магазин' });
      accounts.push(s.accountId);
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

    const owner = (s: ChatSite): AccountMembership => ({
      accountId: s.accountId,
      memberId: `m-${s.accountId.slice(0, 6)}`,
      telegramId: s.ownerTelegramId,
      role: 'owner',
      productRoles: { qa: 'admin', assist: 'manager', assistAdmin: 'owner' },
    });

    const ctxOf = (
      s: ChatSite,
      visitor = st.visitor(),
      voteIpHash?: string,
    ): UiPlanCtx => ({
      site: s.ctx(),
      visitor,
      ...(voteIpHash ? { voteIpHash } : {}),
    });

    const product = (
      s: ChatSite,
      over: { cart?: string | null; cartInForm?: boolean } = {},
    ) => ({
      url: s.url('/product/1'),
      title: 'Футболка',
      elements: [
        {
          ref: 'e1',
          role: 'combobox',
          tag: 'select',
          text: 'Розмір',
          options: ['S', 'M', 'L'],
          inForm: true,
          inView: true,
        },
        ...(over.cart === null
          ? []
          : [
              {
                ref: 'e2',
                role: 'button',
                tag: 'button',
                text: over.cart ?? 'В кошик',
                assistId: 'add-to-cart',
                inForm: over.cartInForm === true,
                inView: true,
              },
            ]),
        {
          ref: 'e3',
          role: 'link',
          tag: 'a',
          text: 'Кошик',
          assistId: 'nav-cart',
          href: s.url('/cart'),
          inView: true,
        },
        {
          ref: 'e5',
          role: 'textbox',
          tag: 'input',
          text: 'Місто',
          inForm: true,
          inView: true,
        },
      ],
    });
    const cartPage = (s: ChatSite) => ({
      url: s.url('/cart'),
      title: 'Кошик — товар у кошику',
      elements: [
        {
          ref: 'e1',
          role: 'button',
          tag: 'button',
          text: 'Оформити',
          inView: true,
        },
      ],
    });
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
        if (e instanceof HttpException) {
          const r = e.getResponse() as { code?: string };
          return `${e.getStatus()}:${r.code ?? ''}`;
        }
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
      let r = v;
      if (s.nav || ['click', 'fill', 'select', 'check'].includes(s.kind)) {
        r = await plans.step(ctx, v.planId!, {
          index: idx,
          result: 'dispatched',
          url,
        });
        if (r.status === 'proposed') return r;
      }
      return plans.step(ctx, v.planId!, { index: idx, result: 'done', url });
    }

    /** Мемо «размер → в кошик → кошик»; фраза — своя у каждого мемо. */
    const cartDraft = (name: string, trigger = 'у кошик і в кошик') => ({
      names: { uk: name },
      triggers: { uk: [trigger] },
      goal: {
        text: { uk: 'Товар у кошику, відкрито кошик' },
        expect: [{ kind: 'url', path: '/cart*' }],
      },
      slots: [
        {
          name: 'size',
          kind: 'option',
          options: [
            { value: 'M', say: { uk: ['медіум'] } },
            { value: 'L', say: { uk: ['ел'] } },
          ],
        },
      ],
      steps: [
        {
          page: '/product/*',
          action: 'select',
          target: {
            pin: {
              role: 'combobox',
              text: 'Розмір',
              tag: 'select',
              inForm: true,
            },
          },
          value: { slot: 'size' },
        },
        {
          page: '/product/*',
          action: 'click',
          target: {
            pin: { role: 'button', assistId: 'add-to-cart', text: 'В кошик' },
          },
        },
        {
          page: '/product/*',
          action: 'click',
          target: {
            pin: {
              role: 'link',
              assistId: 'nav-cart',
              text: 'Кошик',
              tag: 'a',
              href: '/cart',
            },
          },
        },
      ],
    });

    /** Черновик → версия → сухой прогон мастером → «Опубликовать». */
    async function publishedMemo(s: ChatSite, draft: unknown): Promise<number> {
      const m = owner(s);
      const d = await memos.create(m, s.siteId, { draft });
      const n = d.number;
      const built = await memos.buildVersion(m, s.siteId, String(n));
      const v = built.versions[0];
      expect(v.status).toBe('checking');
      const link = await memos.checkToken(m, s.siteId, String(n), {});
      const token = new URL(link.url).searchParams.get('v4c_voicetest')!;
      const visitor = st.visitor();
      await tests.exchange({ site: s.ctx(), visitor }, { token });
      const tctx: UiPlanCtx = {
        site: s.ctx(),
        visitor,
        voiceTest: { testId: link.testId, testHost: false },
      };
      const p1 = await tests.memoPage(tctx, link.testId, {
        snapshot: product(s),
      });
      const p2 = await tests.memoPage(tctx, link.testId, {
        snapshot: cartPage(s),
      });
      const rep = await tests.memoReport(tctx, link.testId, {
        tokens: [p1.token, p2.token],
      });
      expect(rep.result).toBe('pass');
      await memos.publish(m, s.siteId, String(n), String(v.number));
      return n;
    }

    // ── Э8-хвост (а): ссылка сухого прогона — не на хост «Админки» ─────────

    it('ссылка сухого прогона мемо — только хост «Сайта»: хост «Админки» (старше) не предлагается и не выбирается', async () => {
      const s = await vcSite();
      const m = owner(s);
      const admin = await st.owner.siteHost.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          host: `adm-${s.siteId.slice(-8).toLowerCase()}.example.com`,
          status: 'verified',
          method: 'dns',
          verifiedAt: new Date(),
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
          createdAt: new Date(Date.now() - 86_400_000),
        },
      });
      await markAdminHosts(st.owner, s, [admin.id]);
      expect(
        (await st.owner.siteHost.findUnique({ where: { id: admin.id } }))
          ?.assistRole,
      ).toBe('admin');
      const d = await memos.create(m, s.siteId, { draft: cartDraft('Кошик') });
      await memos.buildVersion(m, s.siteId, String(d.number));
      const link = await memos.checkToken(m, s.siteId, String(d.number), {});
      expect(new URL(link.url).origin).toBe(s.origin);
      expect(
        await failure(
          memos.checkToken(m, s.siteId, String(d.number), { host: admin.host }),
        ),
      ).toBe('409:VOICE_CONTROL_HOST_REQUIRED');
      const t = await st.owner.assistSiteVoiceTest.findUnique({
        where: { id: link.testId },
      });
      expect(t?.host).toBe(new URL(s.origin).hostname);
    });

    // ── (4) лимит тарифа ───────────────────────────────────────────────────

    it('лимит тарифа: 19 из 20 и 4 параллельных создания — проходит ровно одно (21 из 20 не бывает), счётчик номеров — без дыр отказов', async () => {
      const s = await vcSite();
      const m = owner(s);
      await st.owner.assistSiteMemo.createMany({
        data: Array.from({ length: 19 }, (_, i) => ({
          accountId: s.accountId,
          siteId: s.siteId,
          number: i + 1,
          key: `seed-${i + 1}`,
          status: 'draft',
          draft: { names: { uk: `Засів ${i + 1}` } },
          view: 'any',
          origin: 'manual',
          createdBy: m.memberId,
          updatedBy: m.memberId,
        })),
      });
      await st.owner.assistSite.update({
        where: { siteId: s.siteId },
        data: { memoCounter: 19 },
      });
      const res = await Promise.all(
        ['Перше', 'Друге', 'Третє', 'Четверте'].map((name) =>
          failure(memos.create(m, s.siteId, { name: `${name} паралельне` })),
        ),
      );
      expect(res.filter((r) => r === 'ok')).toHaveLength(1);
      expect(res.filter((r) => r === '402:MEMO_LIMIT')).toHaveLength(3);
      expect(
        await st.owner.assistSiteMemo.count({
          where: { siteId: s.siteId, status: { not: 'removed' } },
        }),
      ).toBe(20);
      const site = await st.owner.assistSite.findUnique({
        where: { siteId: s.siteId },
        select: { memoCounter: true },
      });
      expect(site?.memoCounter).toBe(20);
    });

    it('после понижения тарифа: опубликованные сверх лимита — `overPlan` в TMA и не исполняются; первые N по номеру — исполняются', async () => {
      const s = await vcSite();
      const m = owner(s);
      const n1 = await publishedMemo(
        s,
        cartDraft('Перший кошик', 'перший кошик'),
      );
      const n2 = await publishedMemo(
        s,
        cartDraft('Другий кошик', 'другий кошик'),
      );
      const limits = MEMO_DECISIONS.limitByPlan as { business: number };
      const saved = limits.business;
      limits.business = 1;
      try {
        const l = await memos.list(m, s.siteId);
        expect(l.items.map((x) => [x.number, x.status, x.overPlan])).toEqual([
          [n1, 'published', false],
          [n2, 'published', true],
        ]);
        expect((await memos.get(m, s.siteId, n2)).overPlan).toBe(true);
        expect((await memos.get(m, s.siteId, n1)).overPlan).toBe(false);
        // Бой: первое — мемо; второе — не мемо (фраза без глагола → не команда).
        const v1 = await create(
          ctxOf(s),
          typed(product(s), 'перший кошик медіум'),
        );
        expect(v1.memo?.name).toBe('Перший кошик');
        const v2 = await create(
          ctxOf(s),
          typed(product(s), 'другий кошик медіум'),
        );
        expect(v2.kind).toBe('not_command');
        // Ничего не удалено.
        expect((await memos.get(m, s.siteId, n2)).status).toBe('published');
      } finally {
        limits.business = saved;
      }
      const v3 = await create(
        ctxOf(s),
        typed(product(s), 'другий кошик медіум'),
      );
      expect(v3.memo?.name).toBe('Другий кошик');
      expect(
        (await memos.list(m, s.siteId)).items.every((x) => !x.overPlan),
      ).toBe(true);
    });

    // ── (2) карта: цель стала «никогда» → мемо «требует проверки» ──────────

    it('публикация голосовой карты, где цель шага мемо стала «никогда», — мемо `needs_review` (по разметке); карта без изменений — мемо работает', async () => {
      const s = await vcSite();
      const m = owner(s);
      const n = await publishedMemo(s, cartDraft('Кошик карти'));
      const cart = {
        tag: 'button',
        role: 'button',
        text: 'В кошик',
        assistId: 'add-to-cart',
        unique: true,
      };
      const publishMap = async (ops: unknown[]) => {
        const d = await maps.draft(m, s.siteId);
        await maps.patch(
          m,
          s.siteId,
          { expectedRevision: d.revision, ops },
          'tma',
        );
        const v = await maps.buildVersion(m, s.siteId, 'tma');
        expect(v.status).toBe('checking');
        return maps.publish(m, s.siteId, String(v.number));
      };
      const target = {
        key: 'cart',
        scope: 'page',
        pagePath: '/product/1',
        descriptor: cart,
      };
      await publishMap([{ op: 'upsert-target', target }]);
      expect((await memos.get(m, s.siteId, n)).status).toBe('published');
      // Черновик карты уже показывает затронутое мемо.
      const draft = await maps.draft(m, s.siteId);
      expect(
        draft.gates.warnings.filter((w) => w.code === 'memo_affected'),
      ).toEqual([]);
      await publishMap([
        { op: 'upsert-target', target: { ...target, denylisted: true } },
      ]);
      const after = await memos.get(m, s.siteId, n);
      expect(after.status).toBe('needs_review');
      expect(after.reviewReason).toMatchObject({
        code: 'voice_map',
        key: 'cart',
      });
      const v = await create(
        ctxOf(s),
        typed(product(s), 'у кошик і в кошик медіум'),
      );
      expect(v.kind).toBe('not_command');
    });

    // ── (6) переход после клика — как в `checkPlan` ────────────────────────

    it('«В кошик» в форме товара (обратимая разметка, команда её называет) — не переход: следующий шаг мемо не вычёркивается', async () => {
      const s = await vcSite();
      await publishedMemo(s, cartDraft('Кошик у формі'));
      const v = await create(
        ctxOf(s),
        typed(product(s, { cartInForm: true }), 'у кошик і в кошик медіум'),
      );
      expect(v.steps.map((x) => x.kind)).toEqual([
        'select',
        'click',
        'click',
        'wait',
      ]);
      expect(v.notes).toEqual([]);
    });

    it('цель карты удалена — мемо, шаг которого найден по ключу цели (`mapKey`, без разметки), `needs_review`', async () => {
      const s = await vcSite();
      const m = owner(s);
      const draft = cartDraft('Кошик за ключем');
      // Цель карты описана без разметки — шаг мемо связан с ней только
      // ключом цели (`mapKey`), не `assistId`.
      (draft.steps[2].target as Record<string, unknown>).mapKey = 'cart-link';
      const n = await publishedMemo(s, draft);
      const link = {
        tag: 'a',
        role: 'link',
        text: 'Кошик',
        hrefPath: '/cart',
        hrefHost: new URL(s.origin).hostname,
        unique: true,
      };
      const target = {
        key: 'cart-link',
        scope: 'page',
        pagePath: '/product/1',
        descriptor: link,
      };
      const other = {
        key: 'size',
        scope: 'page',
        pagePath: '/product/1',
        descriptor: {
          tag: 'select',
          role: 'combobox',
          text: 'Розмір',
          unique: true,
        },
      };
      const publishMap = async (ops: unknown[]) => {
        const d = await maps.draft(m, s.siteId);
        await maps.patch(
          m,
          s.siteId,
          { expectedRevision: d.revision, ops },
          'tma',
        );
        const v = await maps.buildVersion(m, s.siteId, 'tma');
        expect(v.status).toBe('checking');
        return maps.publish(m, s.siteId, String(v.number));
      };
      await publishMap([
        { op: 'upsert-target', target },
        { op: 'upsert-target', target: other },
      ]);
      expect((await memos.get(m, s.siteId, n)).status).toBe('published');
      await publishMap([{ op: 'remove-target', key: 'cart-link' }]);
      const after = await memos.get(m, s.siteId, n);
      expect(after.status).toBe('needs_review');
      expect(after.reviewReason).toMatchObject({
        code: 'voice_map',
        key: 'cart-link',
      });
    });

    // ── (5) `no_target` — сбой шага; (7) хеш IP плана — соль на окно ───────

    it('цель шага не найдена на странице (`no_target`) у 3 разных посетителей и IP — сбой шага, мемо `needs_review`', async () => {
      const s = await vcSite();
      const m = owner(s);
      const n = await publishedMemo(s, cartDraft('Без кнопки'));
      for (let i = 0; i < 3; i++) {
        const v = await create(
          ctxOf(s),
          typed(product(s, { cart: null }), 'у кошик і в кошик медіум'),
        );
        expect(v.notes.map((x) => x.code)).toContain('no_target');
      }
      const refused = await st.owner.assistSiteUiActionLog.findMany({
        where: { siteId: s.siteId, action: 'refused', reason: 'no_target' },
      });
      expect(refused.map((r) => r.stepIndex)).toEqual([1, 1, 1]);
      await mon.run();
      const after = await memos.get(m, s.siteId, n);
      expect(after.status).toBe('needs_review');
      expect(after.reviewReason).toMatchObject({ code: 'failures', step: 1 });
    });

    it('хеш IP плана — соль на окно: 3 посетителя с одного адреса (разные суточные хеши) — один IP, мемо не выключается; с 3 адресов — выключается', async () => {
      const s = await vcSite();
      const m = owner(s);
      const n = await publishedMemo(s, cartDraft('Підміна'));
      const swapped = () =>
        typed(
          product(s, { cart: 'Купити в 1 клік' }),
          'у кошик і в кошик медіум',
        );
      for (let i = 0; i < 3; i++)
        await create(ctxOf(s, st.visitor(), 'same-ip'), swapped());
      const planLogs = await st.owner.assistSiteUiActionLog.findMany({
        where: { siteId: s.siteId, action: 'plan' },
      });
      expect(planLogs.map((l) => (l.target as { ip?: string }).ip)).toEqual([
        'same-ip',
        'same-ip',
        'same-ip',
      ]);
      await mon.run();
      expect((await memos.get(m, s.siteId, n)).status).toBe('published');
      for (let i = 0; i < 3; i++)
        await create(ctxOf(s, st.visitor(), `ip-${i}`), swapped());
      await mon.run();
      expect((await memos.get(m, s.siteId, n)).reviewReason).toMatchObject({
        code: 'pin_mismatch',
      });
    });

    it('кандидаты из боя: 3 посетителя с одного адреса (соль на окно) — не кандидат; с разных — кандидат', async () => {
      const s = await vcSite();
      modelReply = JSON.stringify({
        command: true,
        steps: [
          { kind: 'select', target: 'e1', value: 'M' },
          { kind: 'click', target: 'e2' },
        ],
      });
      const done = async (ip: string) => {
        const ctx = ctxOf(s, st.visitor(), ip);
        let v = await create(
          ctx,
          typed(product(s), 'вибери розмір M і додай в кошик'),
        );
        if (v.status === 'proposed')
          v = await plans.confirm(ctx, v.planId!, {
            by: 'button',
            stepsHash: v.stepsHash!,
          });
        v = await run(ctx, v, 0, s.url('/product/1'));
        v = await run(ctx, v, 1, s.url('/product/1'));
        expect(v.status).toBe('done');
      };
      for (let i = 0; i < 3; i++) await done('one-ip');
      expect(await memos.suggestions(owner(s), s.siteId)).toEqual([]);
      await done('ip-b');
      await done('ip-c');
      expect(await memos.suggestions(owner(s), s.siteId)).toHaveLength(1);
    });

    // ── (1) отчёт о возврате полей — только в окне «Вернуть» ───────────────

    it('`undo-report` после окна «Вернуть» (10 мин + карточка) — expired, статус цепочки не меняется; в окне — принимается', async () => {
      const s = await vcSite();
      const ctx = ctxOf(s);
      modelReply = JSON.stringify({
        command: true,
        steps: [
          { kind: 'fill', target: 'e5', value: 'Київ' },
          { kind: 'click', target: 'e2' },
          { kind: 'click', target: 'e3' },
        ],
      });
      const kept = async () => {
        let v = await create(
          ctx,
          typed(product(s), 'заповни місто Київ, додай в кошик, відкрий кошик'),
        );
        if (v.status === 'proposed')
          v = await plans.confirm(ctx, v.planId!, {
            by: 'button',
            stepsHash: v.stepsHash!,
          });
        v = await run(ctx, v, 0, s.url('/product/1'));
        v = await run(ctx, v, 1, s.url('/product/1'));
        await plans.stop(ctx, v.planId!, { by: 'button' });
        return v.planId!;
      };
      const late = await kept();
      plans.now = () => new Date(Date.now() + 12 * 60_000);
      expect(
        await failure(
          plans.undoReport(ctx, late, { results: [{ i: 0, result: 'done' }] }),
        ),
      ).toBe('expired');
      plans.now = () => new Date();
      const row = await st.owner.assistSiteUiPlan.findUnique({
        where: { id: late },
      });
      expect(row?.chainStatus).not.toBe('compensated');
      expect(row?.chainStatus).not.toBe('partially_compensated');
      const fresh = await kept();
      const ok = await plans.undoReport(ctx, fresh, {
        results: [{ i: 0, result: 'done' }],
      });
      expect(ok.chainStatus).toBe('partially_compensated');
    });
  },
);
