/**
 * Приёмка Э6-тер (к) «Мемо: источники» и хвост (11) на реальном Postgres:
 * кабинет — основной ролью с тенантом, план посетителя — под ролью
 * assist_public (как в проде), модель — подделка. ТЗ помощника §5-бис.17
 * п.3 (условия цели «счётчик ±N», «поле = слот»), п.6 (шаблоны платформ,
 * импорт/экспорт), п.15 п.7 (опасные шаги импорта — отказ в отчёте), п.14
 * (публикация пакетом после прогона); хвост аудита Э6-тер (4) — тело
 * импорта карты до 1 МБ только на этом маршруте (HTTP).
 * Браузерная часть проверки цели (чанк undo.js, ответ `ui-goal`) — unit
 * виджета `scripts/memo-goal.test.ts`.
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  type INestApplication,
  Param,
  Post,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { loadConfiguration } from '../../config/configuration';
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
import { MemoTemplatesController } from '../../modules/assist-site-voice-control/cabinet/memo-templates.controller';
import { MemoTemplatesService } from '../../modules/assist-site-voice-control/cabinet/memo-templates.service';
import { MemoService } from '../../modules/assist-site-voice-control/cabinet/memo.service';
import {
  SiteUiPlanService,
  type UiPlanCtx,
} from '../../modules/assist-site-voice-control/public/ui-plan.service';
import { VoiceTestService } from '../../modules/assist-site-voice-control/public/voice-test.service';
import { VoiceMapService } from '../../modules/assist-site-voice-map/voice-map.service';
import { GeminiText } from '../../modules/site-ai/text-model';
import type { AccountMembership } from '../../modules/site-core/account/roles';
import {
  PRODUCT_ROLES_KEY,
  SiteAccountGuard,
} from '../../modules/site-core/account/site-account.guard';
import { ALLOW_APPS_KEY } from '../../modules/telegram-auth/allow-apps.decorator';
import { SitesDb } from '../../prisma/sites-db.service';

jest.setTimeout(300_000);

describeDb(
  'Приёмка Э6-тер (к) — мемо: шаблоны, импорт/экспорт, цель «счётчик/поле»',
  () => {
    const st = new ChatStack();
    const fake = new FakeSoniox();
    let plans: SiteUiPlanService;
    let tests: VoiceTestService;
    let memos: MemoService;
    let templates: MemoTemplatesService;
    let maps: VoiceMapService;
    let env: NodeJS.ProcessEnv;
    const modelCalls: string[] = [];

    beforeAll(async () => {
      await st.init();
      env = {
        ...st.env,
        SONIOX_API_KEY: 'sx-test',
        ASSIST_VOICE_ENABLED: 'true',
        ASSIST_VOICE_MAP_EXPORT_KEY: 'export-key-test',
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
              usageMetadata: {
                promptTokenCount: 900,
                candidatesTokenCount: 30,
              },
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
      const db = new SitesDb(st.owner);
      memos = new MemoService(db, st.owner);
      templates = new MemoTemplatesService(db, memos);
      maps = new VoiceMapService(db);
      maps.env = env;
    });
    afterAll(async () => {
      await st.close();
    });
    beforeEach(() => {
      modelCalls.length = 0;
    });

    async function vcSite(plan: 'business' | 'start' = 'business') {
      const s = await st.site({ name: 'Магазин' });
      await setPlan(st.owner, s.accountId, plan);
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

    /** Карта интерфейса Ш4 знает разметку плагина и кнопку поиска. */
    async function shopUi(s: ChatSite) {
      const host = await st.owner.siteHost.findFirstOrThrow({
        where: { siteId: s.siteId },
      });
      const rows: Array<[string, string, string | null, string, string]> = [
        [
          'a:add',
          'В кошик',
          '[data-assist-id="add-to-cart"]',
          'button',
          '/product/1',
        ],
        [
          'a:cart',
          'Кошик 1',
          'a[data-assist-id="nav-cart"]',
          'link',
          '/product/1',
        ],
        [
          'a:search',
          'Пошук товарів',
          '[data-assist-id="search"]',
          'searchbox',
          '/',
        ],
        ['b:go', 'Пошук', null, 'button', '/'],
      ];
      for (const [key, label, selector, role, path] of rows)
        await st.owner.siteUiElement.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            hostId: host.id,
            host: s.host,
            path,
            viewport: 'any',
            elementKey: key,
            elementId: `u${key.replace(/\W/g, '').padEnd(8, '0').slice(0, 8)}`,
            tag:
              role === 'link' ? 'a' : role === 'searchbox' ? 'input' : 'button',
            label,
            role,
            selector,
            candidates: [],
            stability: 'strong',
            confidence: 90,
            sources: ['crawl'],
            sourceRank: 3,
            position: 0,
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
          },
        });
    }

    /** Страница товара: «В кошик», ссылка «Кошик N» в шапке. */
    const product = (s: ChatSite, cart: string | null = 'Кошик 1') => ({
      url: s.url('/product/1'),
      title: 'Футболка',
      elements: [
        {
          ref: 'e1',
          role: 'button',
          tag: 'button',
          text: 'В кошик',
          assistId: 'add-to-cart',
          inView: true,
        },
        ...(cart === null
          ? []
          : [
              {
                ref: 'e2',
                role: 'link',
                tag: 'a',
                text: cart,
                assistId: 'nav-cart',
                href: s.url('/cart/'),
                inView: true,
              },
            ]),
      ],
    });

    const typed = (snapshot: unknown, text: string): UiPlanRequest => ({
      text,
      source: 'typed',
      lang: 'uk',
      snapshot,
    });

    async function code(p: Promise<unknown>): Promise<string> {
      try {
        await p;
      } catch (e) {
        if (e instanceof HttpException)
          return `${e.getStatus()}:${(e.getResponse() as { code?: string }).code}`;
        throw e;
      }
      return 'ok';
    }

    async function run(
      ctx: UiPlanCtx,
      v: UiPlanView,
      idx: number,
      url: string,
      result: 'done' | 'failed' = 'done',
    ): Promise<UiPlanView> {
      const s = v.steps[idx];
      if (s.nav || ['click', 'fill', 'select', 'check'].includes(s.kind))
        v = await plans.step(ctx, v.planId!, {
          index: idx,
          result: 'dispatched',
          url,
        });
      return plans.step(ctx, v.planId!, {
        index: idx,
        result,
        url,
        ...(result === 'failed' ? { reason: 'expect' } : {}),
      });
    }

    /** Прогон версии мемо мастером (страница товара) и отчёт. */
    async function dryRun(s: ChatSite, n: number) {
      const m = owner(s);
      const link = await memos.checkToken(m, s.siteId, String(n), {});
      const token = new URL(link.url).searchParams.get('v4c_voicetest')!;
      const visitor = st.visitor();
      await tests.exchange({ site: s.ctx(), visitor }, { token });
      const tctx: UiPlanCtx = {
        site: s.ctx(),
        visitor,
        voiceTest: { testId: link.testId, testHost: false },
      };
      const p = await tests.memoPage(tctx, link.testId, {
        snapshot: product(s),
      });
      return tests.memoReport(tctx, link.testId, { tokens: [p.token] });
    }

    it('маршруты: только владелец/менеджер Помічника, гвард кабинета', () => {
      const meta = (k: string) =>
        Reflect.getMetadata(k, MemoTemplatesController);
      expect(meta(ALLOW_APPS_KEY)).toEqual(['assist']);
      expect(meta(PRODUCT_ROLES_KEY)).toEqual({ assist: ['manager'] });
      expect(
        Reflect.getMetadata('__guards__', MemoTemplatesController),
      ).toEqual([SiteAccountGuard]);
    });

    it('шаблон WooCommerce: черновики `template` с подписями сайта, ворота ok; прогон → публикация пакетом; «счётчик +1» → честное «готово»', async () => {
      const s = await vcSite();
      const m = owner(s);
      expect((await templates.list(m, s.siteId)).platform).toBeNull();
      await shopUi(s);
      const map = await maps.draft(m, s.siteId);
      await maps.platformTemplate(m, s.siteId, {
        platform: 'woocommerce',
        expectedRevision: map.revision,
      });
      const list = await templates.list(m, s.siteId);
      expect(list.platform).toBe('woocommerce');
      expect(list.templates.map((t) => t.key)).toEqual([
        'add-and-open-cart',
        'put-in-cart',
        'open-cart',
        'find-product',
      ]);
      expect(list.templates[0].names).toMatchObject({
        uk: 'Покласти в кошик і відкрити кошик',
        ru: 'Положить в корзину и открыть корзину',
        en: 'Add to cart and open the cart',
      });
      const r = await templates.apply(m, s.siteId, { platform: 'woocommerce' });
      expect(r.rejected).toEqual([]);
      expect(r.unresolved).toEqual([]);
      expect(r.created.map((c) => [c.key, c.gates])).toEqual([
        ['add-and-open-cart', 'ok'],
        ['put-in-cart', 'ok'],
        ['open-cart', 'ok'],
        ['find-product', 'ok'],
      ]);
      const rows = await st.owner.assistSiteMemo.findMany({
        where: { siteId: s.siteId },
        orderBy: { number: 'asc' },
      });
      expect(rows.map((x) => [x.number, x.origin, x.status])).toEqual([
        [1, 'template', 'checking'],
        [2, 'template', 'checking'],
        [3, 'template', 'checking'],
        [4, 'template', 'checking'],
      ]);
      const changes = await st.owner.assistSiteMemoChange.findMany({
        where: { siteId: s.siteId, source: 'template' },
      });
      expect(changes).toHaveLength(4);
      const put = await memos.get(m, s.siteId, 2);
      expect(put.draft.steps[0].target?.pin.text).toBe('В кошик');
      expect(put.draft.goal.expect).toEqual([
        {
          kind: 'counter',
          target: { assistId: 'nav-cart', text: '' },
          delta: 1,
        },
      ]);
      const find = await memos.get(m, s.siteId, 4);
      expect(find.draft.steps[1].target?.pin.text).toBe('Пошук');
      // Повтор шаблона — новые ключи `-2` (имена заняты — отказ name_taken).
      const again = await templates.apply(m, s.siteId, {
        platform: 'woocommerce',
        keys: ['open-cart'],
      });
      expect(again.created).toEqual([]);
      expect(again.rejected).toEqual([
        { key: 'open-cart', code: 'name_taken' },
      ]);

      // Публикация пакетом — только после прогона: без отчёта — отказ.
      const before = await templates.publishBatch(m, s.siteId, {});
      expect(before.results.map((x) => [x.number, x.ok, x.code])).toEqual([
        [1, false, 'MEMO_CHECK_REQUIRED'],
        [2, false, 'MEMO_CHECK_REQUIRED'],
        [3, false, 'MEMO_CHECK_REQUIRED'],
        [4, false, 'MEMO_CHECK_REQUIRED'],
      ]);
      const rep = await dryRun(s, 2);
      expect(rep.result).toBe('pass');
      const pub = await templates.publishBatch(m, s.siteId, {
        numbers: [2, 999],
      });
      expect(pub.results).toEqual([
        { number: 2, version: 1, ok: true, code: null },
        { number: 999, version: null, ok: false, code: 'MEMO_NOT_FOUND' },
      ]);
      expect((await memos.get(m, s.siteId, 2)).status).toBe('published');
      expect(
        await code(
          templates.publishBatch(m, s.siteId, {
            numbers: Array.from({ length: 51 }, (_, i) => i + 1),
          }),
        ),
      ).toBe('422:MEMO_INVALID');

      // Бой: «поклади в кошик» прямым путём; ожидаемое = «Кошик 1» + 1.
      const ctx: UiPlanCtx = { site: s.ctx(), visitor: st.visitor() };
      let v = await plans.create(
        ctx,
        typed(product(s), 'поклади в кошик'),
        async () => true,
      );
      expect(modelCalls).toHaveLength(0);
      expect(v.steps.map((x) => x.kind)).toEqual(['click', 'wait']);
      expect(v.steps[1].expect).toEqual({
        count: { id: 'nav-cart', t: '', eq: 2 },
      });
      expect(v.goalFrom).toBe(1);
      if (v.status === 'proposed')
        v = await plans.confirm(ctx, v.planId!, {
          by: 'button',
          stepsHash: v.stepsHash!,
        });
      v = await run(ctx, v, 0, s.url('/product/1'));
      v = await run(ctx, v, 1, s.url('/product/1'));
      expect(v).toMatchObject({ status: 'done', goalStatus: 'reached' });

      // Счётчик не изменился (iframe: `ui-goal` ok=false → шаг цели failed).
      const ctx2: UiPlanCtx = { site: s.ctx(), visitor: st.visitor() };
      let w = await plans.create(
        ctx2,
        typed(product(s, 'Кошик 3'), 'поклади в кошик'),
        async () => true,
      );
      expect(w.steps[1].expect).toEqual({
        count: { id: 'nav-cart', t: '', eq: 4 },
      });
      if (w.status === 'proposed')
        w = await plans.confirm(ctx2, w.planId!, {
          by: 'button',
          stepsHash: w.stepsHash!,
        });
      w = await run(ctx2, w, 0, s.url('/product/1'));
      w = await run(ctx2, w, 1, s.url('/product/1'), 'failed');
      expect(w.goalStatus).toBe('not_reached');

      // Счётчика в снимке нет — проверить нечем: `unknown`, не «готово».
      const ctx3: UiPlanCtx = { site: s.ctx(), visitor: st.visitor() };
      let u = await plans.create(
        ctx3,
        typed(product(s, null), 'поклади в кошик'),
        async () => true,
      );
      expect(u.goalFrom).toBeNull();
      expect(u.steps[1].expect).toBeNull();
      if (u.status === 'proposed')
        u = await plans.confirm(ctx3, u.planId!, {
          by: 'button',
          stepsHash: u.stepsHash!,
        });
      u = await run(ctx3, u, 0, s.url('/product/1'));
      u = await run(ctx3, u, 1, s.url('/product/1'));
      expect(u).toMatchObject({ status: 'done', goalStatus: 'unknown' });
    });

    it('шаблон: лимит тарифа — в транзакции (параллельно не больше лимита), Start — 0; неизвестная платформа — 422', async () => {
      const s = await vcSite();
      const m = owner(s);
      // Business — 20: 17 уже есть, места на 3.
      await st.owner.assistSite.update({
        where: { siteId: s.siteId },
        data: { memoCounter: 17 },
      });
      await st.owner.assistSiteMemo.createMany({
        data: Array.from({ length: 17 }, (_, i) => ({
          accountId: s.accountId,
          siteId: s.siteId,
          number: i + 1,
          key: `m-${i + 1}`,
          status: 'draft',
          draft: { names: { uk: `Мемо ${i + 1}` } },
          origin: 'manual',
          createdBy: 'x',
          updatedBy: 'x',
        })),
      });
      const [a, b] = await Promise.all([
        templates.apply(m, s.siteId, {
          platform: 'woocommerce',
          keys: ['open-cart', 'put-in-cart'],
        }),
        templates.apply(m, s.siteId, {
          platform: 'woocommerce',
          keys: ['find-product', 'add-and-open-cart'],
        }),
      ]);
      const made = [...a.created, ...b.created];
      expect(made).toHaveLength(3);
      expect([...a.rejected, ...b.rejected].map((x) => x.code)).toEqual([
        'limit',
      ]);
      expect(
        await st.owner.assistSiteMemo.count({ where: { siteId: s.siteId } }),
      ).toBe(20);
      // Номера подряд, без дыр от отказа.
      expect(made.map((x) => x.number).sort((x, y) => x - y)).toEqual([
        18, 19, 20,
      ]);
      const start = await vcSite('start');
      const z = await templates.apply(owner(start), start.siteId, {
        platform: 'woocommerce',
      });
      expect(z.created).toEqual([]);
      expect(z.rejected.map((x) => x.code)).toEqual([
        'limit',
        'limit',
        'limit',
        'limit',
      ]);
      expect(
        await code(templates.apply(m, s.siteId, { platform: 'shopify' })),
      ).toBe('422:MEMO_INVALID');
      // Чужой сайт — как несуществующий.
      expect(
        await code(
          templates.apply(owner(start), s.siteId, { platform: 'woocommerce' }),
        ),
      ).toMatch(/^404:/);
    });

    it('экспорт → импорт на другом сайте: мемо в черновики с новыми номерами, без pin/id; опасные — отказ в отчёте', async () => {
      const a = await vcSite();
      const ma = owner(a);
      await shopUi(a);
      const mapA = await maps.draft(ma, a.siteId);
      await maps.platformTemplate(ma, a.siteId, {
        platform: 'woocommerce',
        expectedRevision: mapA.revision,
      });
      await templates.apply(ma, a.siteId, {
        platform: 'woocommerce',
        keys: ['put-in-cart', 'open-cart'],
      });
      const exp = await maps.exportFile(ma, a.siteId);
      const memosOut = exp.file.memos as Array<Record<string, unknown>>;
      expect(memosOut.map((x) => x.key)).toEqual(['put-in-cart', 'open-cart']);
      const json = JSON.stringify(exp.file);
      for (const bad of [
        '"pin"',
        'uiElementId',
        '"number"',
        'memoId',
        'runs30',
        'suggested',
      ])
        expect(json).not.toContain(bad);

      const b = await vcSite();
      const mb = owner(b);
      // На сайте B уже есть М-1 (номера B — свои).
      await memos.create(mb, b.siteId, { name: 'Своє мемо' });
      const dangerous = {
        ...memosOut[0],
        key: 'pay-now',
        names: { uk: 'Оплатити замовлення' },
        triggers: {},
        steps: [
          {
            page: '/checkout',
            action: 'click',
            risk: 'auto',
            target: { role: 'button', text: 'Оплатити', tag: 'button' },
          },
        ],
      };
      const file = { ...exp.file, memos: [...memosOut, dangerous] };
      const mapB = await maps.draft(mb, b.siteId);
      const imp = await maps.importFile(mb, b.siteId, {
        expectedRevision: mapB.revision,
        file,
      });
      // Подпись — не над исходным файлом (добавили мемо) — «не наш файл».
      expect(imp.signed).toBe(false);
      expect(imp.accepted).toBe(3);
      expect(imp.memos.created.map((x) => [x.number, x.key])).toEqual([
        [2, 'put-in-cart'],
        [3, 'open-cart'],
      ]);
      expect(imp.memos.rejected).toEqual([
        { index: 2, key: 'pay-now', code: 'never_step', path: 'steps[0]' },
      ]);
      const rows = await st.owner.assistSiteMemo.findMany({
        where: { siteId: b.siteId, origin: 'import' },
        orderBy: { number: 'asc' },
      });
      expect(rows.map((x) => [x.number, x.status])).toEqual([
        [2, 'draft'],
        [3, 'draft'],
      ]);
      const put = await memos.get(mb, b.siteId, 2);
      // Цель карты есть в карте B (импорт целей) — привязка осталась.
      expect(put.draft.steps[0].target).toMatchObject({
        uiElementId: null,
        key: null,
        mapKey: 'add-to-cart',
        pin: { assistId: 'add-to-cart', text: 'В кошик', stability: null },
      });
      expect(
        await st.owner.assistSiteMemoChange.count({
          where: { siteId: b.siteId, source: 'import' },
        }),
      ).toBe(2);
      // Исходный файл без правок — «наш», мемо B не задеты (имена заняты).
      const again = await maps.importFile(mb, b.siteId, {
        expectedRevision: (await maps.draft(mb, b.siteId)).revision,
        file: exp.file,
      });
      expect(again.signed).toBe(true);
      expect(again.memos.created).toEqual([]);
      expect(again.memos.rejected.map((x) => x.code)).toEqual([
        'name_taken',
        'name_taken',
      ]);
    });

    describe('HTTP: тело импорта карты — до 1 МБ только на этом маршруте', () => {
      let app: INestApplication;
      let who: AccountMembership;
      let siteId = '';

      @Controller('assist/sites')
      class ImportProbe {
        @Post(':id/voice-map/site/import')
        @HttpCode(200)
        importFile(@Param('id') id: string, @Body() body: unknown) {
          return maps.importFile(who, id, body);
        }
        @Post(':id/voice-map/site/other')
        other(@Body() body: unknown) {
          return { size: JSON.stringify(body).length };
        }
      }

      beforeAll(async () => {
        const mod = await Test.createTestingModule({
          controllers: [ImportProbe],
        }).compile();
        app = mod.createNestApplication({ logger: false });
        configureApp(
          app,
          loadConfiguration({
            CORS_ORIGIN: 'https://tma.example',
            ASSIST_WIDGET_ORIGIN: 'https://w.widget.example',
          } as NodeJS.ProcessEnv),
        );
        await app.init();
        const s = await vcSite();
        who = owner(s);
        siteId = s.siteId;
      });
      afterAll(async () => {
        await app?.close();
      });

      it('файл ≈ 0,6 МБ (500 целей) — импортируется; соседний маршрут — 413; больше 1 МБ — 413 VOICE_MAP_IMPORT_TOO_LARGE', async () => {
        const targets = Array.from({ length: 500 }, (_, i) => ({
          key: `t-${i + 1}`,
          scope: 'site',
          descriptor: {
            tag: 'button',
            role: 'button',
            text: `Кнопка ${i + 1} ${'опис '.repeat(12)}`.slice(0, 80),
            assistId: `t-${i + 1}`,
            unique: true,
          },
          names: { uk: `Кнопка номер ${i + 1}` },
          synonyms: { uk: [{ text: `натисни ${i + 1}` }] },
          pagePath: null,
          semanticType: null,
          riskOwner: null,
          denylisted: false,
          control: false,
          undo: null,
          padding: 'x'.repeat(700),
        }));
        const file = {
          schemaVersion: 1,
          kind: 'site',
          templates: [],
          targets,
          terms: [],
        };
        const map = await maps.draft(who, siteId);
        const body = { expectedRevision: map.revision, file };
        const size = Buffer.byteLength(JSON.stringify(body));
        expect(size).toBeGreaterThan(400 * 1024);
        expect(size).toBeLessThan(1024 * 1024);
        const ok = await request(app.getHttpServer())
          .post(`/assist/sites/${siteId}/voice-map/site/import`)
          .send(body);
        expect([ok.status, ok.body.error ?? null]).toEqual([200, null]);
        expect(ok.body.data.accepted).toBe(500);
        expect(ok.body.data.memos).toEqual({ created: [], rejected: [] });
        const other = await request(app.getHttpServer())
          .post(`/assist/sites/${siteId}/voice-map/site/other`)
          .send(body);
        expect(other.status).toBe(413);
        const huge = await request(app.getHttpServer())
          .post(`/assist/sites/${siteId}/voice-map/site/import`)
          .send({
            expectedRevision: 0,
            file: { pad: 'x'.repeat(1100 * 1024) },
          });
        expect(huge.status).toBe(413);
        expect(huge.body.error.code).toBe('VOICE_MAP_IMPORT_TOO_LARGE');
      });
    });
  },
);
