/**
 * Инвариант «Админка → Сайт» на хостах (ТЗ §10, §3.3; аудит Э6-бис (б)
 * (8)): хост, отмеченный хостом «Админки» (`adminHostIds`, Э7), для
 * публичного виджета «Сайта» НЕ существует — даже если владелец включил его
 * в `hosts[]` опубликованного вида. По HTTP, под логин-ролью виджета
 * (`assist_widget_ci` ∈ assist_public):
 *  - роль видит только колонку `site_hosts.assistRole` (зеркало, которое
 *    держит триггер), а настройки «Админки» — нет (42501);
 *  - конфиг (`hosts`), CSP `frame-ancestors`, сессия, предпросмотр, пинг —
 *    хоста нет; отказ тот же, что у чужого origin (не выдаёт «это админка»);
 *  - живой visitor-token, выданный до отметки, — ORIGIN_DENIED на каждом
 *    маршруте (state, чат, план и его шаги, highlight-miss/-seen, голос,
 *    мастер Т-2, связанный режим `visit`);
 *  - запросы СО СТРАНИЦЫ admin-хоста (`event`, `goal`, `pv`, `exp`, `ref`) —
 *    тот же отказ, что у чужого сайта;
 *  - снимок/адрес шага на admin-хосте из сессии хоста «Сайта» — не адрес
 *    сайта (`bad_request`);
 *  - кабинет: список хостов вида и публикуемый `hosts[]` admin-хост не
 *    содержат; снятие отметки возвращает хост «Сайту».
 */
import * as request from 'supertest';
import { createHash, randomBytes } from 'crypto';
import { WIDGET_VISITOR_TOKEN_HEADER } from '../../brand';
import { SitesDb } from '../../prisma/sites-db.service';
import { ChatStack } from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { visitKey } from '../../modules/assist-analytics/testing/ai-stack.testing';
import {
  uiElementId,
  uiMapKey,
  uiMapPageRef,
} from '../../modules/site-core/ui-map/ui-map';
import { ingestUiSnapshot } from '../../modules/site-core/ui-map/ui-map-store';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { WidgetSettingsService } from '../../modules/assist-site-setup/widget-settings.service';
import { InstallCheckService } from '../../modules/assist-site-setup/install-check.service';
import { VoiceControlSettingsService } from '../../modules/assist-site-voice-control/cabinet/voice-control-settings.service';
import { readPublishedConfig } from '../../modules/assist-site-chat/published-config';
import {
  describeDb,
  randomV6Prefix,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  OWNER_PRODUCT_ROLES,
  type AccountMembership,
} from '../../modules/site-core/account/roles';
import {
  W_ORIGIN,
  domain,
  newRequestId,
  startWidgetStack,
  widgetFixture,
  type WidgetFixture,
  type WidgetStack,
} from '../../modules/assist-widget/testing/widget-stack.testing';

jest.setTimeout(180_000);

describeDb(
  'Инвариант «Админка → Сайт»: публичный виджет на хосте «Админки»',
  () => {
    let stack: WidgetStack;
    let f: WidgetFixture;
    const srv = () => stack.app.getHttpServer();
    const saved = process.env.SONIOX_API_KEY;
    let pub: WidgetFixture['hosts'][number];
    let adm: WidgetFixture['hosts'][number];
    const evil = () => `https://${domain('evil')}`;

    beforeAll(async () => {
      process.env.SONIOX_API_KEY = 'sx-admin-host-test';
      stack = await startWidgetStack();
      f = await widgetFixture(stack, [
        { host: domain('pub') },
        { host: domain('adm') },
      ]);
      [pub, adm] = f.hosts;
      await setPlan(stack.prisma, f.accountId, 'business');
      await stack.prisma.assistSite.update({
        where: { siteId: f.siteId },
        data: {
          voiceConfig: { schema: 1, input: true, output: false, voiceId: null },
          voiceControlSiteState: 'on',
          voiceControlSiteRules: { schema: 1, denySelectors: [] },
          analytics: { linked: true, behavior: true, linkedWindowDays: 7 },
        },
      });
    });
    afterAll(async () => {
      await stack?.close();
      if (saved === undefined) delete process.env.SONIOX_API_KEY;
      else process.env.SONIOX_API_KEY = saved;
    });

    const markAdmin = (ids: string[]) =>
      stack.prisma.assistAdminSettings.upsert({
        where: { siteId: f.siteId },
        create: { accountId: f.accountId, siteId: f.siteId, adminHostIds: ids },
        update: { adminHostIds: ids },
      });

    const session = (parentOrigin: string) =>
      request(srv())
        .post('/widget/v1/session')
        .set('Origin', W_ORIGIN)
        .set('X-Forwarded-For', `${randomV6Prefix()}::1`)
        .send({ pk: f.pk, parentOrigin });

    const token = async (origin: string): Promise<string> =>
      (await session(origin).expect(200)).body.data.visitorToken as string;

    const snapshot = (url: string) => ({
      url,
      elements: [
        {
          ref: 'e1',
          role: 'link',
          tag: 'a',
          text: 'Доставка',
          href: `${new URL(url).origin}/delivery`,
        },
      ],
    });
    const planBody = (url: string) => ({
      text: 'відкрий доставку',
      source: 'typed',
      lang: 'uk',
      snapshot: snapshot(url),
    });

    /** Маршруты по visitor-token: [метод, путь, тело]. */
    const tokenRoutes = (): Array<['get' | 'post', string, object | null]> => [
      ['get', '/widget/v1/state', null],
      [
        'post',
        '/widget/v1/chat',
        {
          conversationId: null,
          clientRequestId: newRequestId(),
          question: 'Сколько стоит доставка?',
          page: { url: `${adm.origin}/delivery`, title: 'Доставка' },
          context: null,
          uiLang: 'ru',
        },
      ],
      ['post', '/widget/v1/ui-plan', planBody(`${adm.origin}/`)],
      ['get', '/widget/v1/ui-plan/active', null],
      ['get', '/widget/v1/ui-plan/skills', null],
      ['post', '/widget/v1/ui-plan/p1/step', { index: 0, result: 'done' }],
      [
        'post',
        '/widget/v1/highlight-miss',
        { elementId: uiElementId('#buy'), pageUrl: `${adm.origin}/` },
      ],
      [
        'post',
        '/widget/v1/highlight-seen',
        { elementId: uiElementId('#buy'), pageUrl: `${adm.origin}/` },
      ],
      ['post', '/widget/v1/voice-test/session', { token: 'x'.repeat(40) }],
      ['post', '/widget/v1/tts', { messageId: 'm1' }],
      ['post', '/widget/v1/video', { videoId: 'v1' }],
      ['post', '/widget/v1/feedback', { messageId: 'm1', rating: 1 }],
      ['post', '/widget/v1/forget', {}],
      ['post', '/widget/v1/visit', { v: visitKey() }],
    ];

    const pageRoutes = (): Array<[string, object]> => [
      ['/widget/v1/event', { pk: f.pk, events: [{ kind: 'open', key: null }] }],
      [
        '/widget/v1/goal',
        {
          pk: f.pk,
          goalKey: 'purchase',
          detector: 'js',
          docId: 'doc_loader0001',
          path: '/thanks',
        },
      ],
      [
        '/widget/v1/pv',
        {
          pk: f.pk,
          pv: `pv${Date.now()}`,
          v: visitKey(),
          p: '/',
          d: 'm',
          sc: 1,
          ac: 1,
          to: 1,
          ck: 0,
        },
      ],
      ['/widget/v1/exp', { pk: f.pk, x: 'e1', v: visitKey() }],
      ['/widget/v1/ref', { pk: f.pk, v: visitKey() }],
    ];
    const fromPage = (path: string, origin: string, body: object) =>
      request(srv())
        .post(path)
        .set('Origin', origin)
        .set('X-Forwarded-For', `${randomV6Prefix()}::7`)
        .send(body);

    const frameAncestors = async (): Promise<string> => {
      const r = await request(srv()).get(`/w/v1/frame?pk=${f.pk}`).expect(200);
      const csp = String(r.headers['content-security-policy']);
      return /frame-ancestors ([^;]*)/.exec(csp)?.[1] ?? '';
    };

    const configHosts = async (): Promise<string[]> =>
      (
        (await request(srv()).get(`/widget/v1/config?pk=${f.pk}`).expect(200))
          .body.data.hosts as Array<{ origin: string }>
      ).map((h) => h.origin);

    const sansRequestId = (b: { error?: Record<string, unknown> }) => {
      const { requestId: _r, ...rest } = b.error ?? {};
      return rest;
    };

    it('до отметки (контроль): admin-хост — обычный хост «Сайта» (иначе отказы ниже ничего не доказывают)', async () => {
      expect(await configHosts()).toEqual(
        expect.arrayContaining([pub.origin, adm.origin]),
      );
      expect(await frameAncestors()).toContain(adm.origin);
      const t = await token(adm.origin);
      await request(srv())
        .get('/widget/v1/state')
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t)
        .expect(200);
      await fromPage('/widget/v1/event', adm.origin, pageRoutes()[0][1]).expect(
        204,
      );
    });

    it('отметка «Админки» → роль хоста `admin` триггером; роль виджета читает только её, не настройки «Админки»', async () => {
      await markAdmin([adm.id]);
      const rows = await stack.publicDb.$queryRawUnsafe<
        Array<{ id: string; assistRole: string }>
      >(
        `SELECT "id", "assistRole" FROM "sites"."site_hosts" WHERE "siteId" = $1`,
        f.siteId,
      );
      expect(Object.fromEntries(rows.map((r) => [r.id, r.assistRole]))).toEqual(
        {
          [pub.id]: 'public',
          [adm.id]: 'admin',
        },
      );
      await expect(
        stack.publicDb.$queryRawUnsafe(
          `SELECT "adminHostIds" FROM "sites"."assist_admin_settings" LIMIT 1`,
        ),
      ).rejects.toThrow(/permission denied|42501/);
      // Роль хоста не пишется мимо настроек «Админки» (триггер пересчитывает).
      await stack.prisma.siteHost.update({
        where: { id: pub.id },
        data: { assistRole: 'admin' },
      });
      await stack.prisma.siteHost.update({
        where: { id: adm.id },
        data: { assistRole: 'public' },
      });
      expect(
        (
          await stack.prisma.siteHost.findMany({
            where: { siteId: f.siteId },
            orderBy: { createdAt: 'asc' },
          })
        ).map((h) => h.assistRole),
      ).toEqual(['public', 'admin']);
      // Роль виджета не может сама «назначить» хосту роль (UPDATE не выдан).
      await expect(
        stack.publicDb.$executeRawUnsafe(
          `UPDATE "sites"."site_hosts" SET "assistRole" = 'public' WHERE "id" = $1`,
          adm.id,
        ),
      ).rejects.toThrow(/permission denied|42501/);
    });

    it('конфиг, frame-ancestors, сессия, предпросмотр, пинг: admin-хоста нет, отказ — как у чужого origin', async () => {
      await markAdmin([adm.id]);
      expect(await configHosts()).toEqual([pub.origin]);
      const fa = await frameAncestors();
      expect(fa).toContain(pub.origin);
      expect(fa).not.toContain(adm.origin);

      const a = await session(adm.origin).expect(403);
      const e = await session(evil()).expect(403);
      expect(a.body.error.code).toBe('ORIGIN_DENIED');
      expect(sansRequestId(a.body)).toEqual(sansRequestId(e.body));
      // Хост «Сайта» работает как раньше.
      await token(pub.origin);

      // «Посмотреть на сайте» по ссылке на admin-хост — недействительна.
      const raw = randomBytes(24).toString('base64url');
      await stack.prisma.assistSitePreviewToken.create({
        data: {
          accountId: f.accountId,
          siteId: f.siteId,
          tokenHash: createHash('sha256').update(raw).digest('hex'),
          purpose: 'site',
          origin: adm.origin,
          createdByTelegramId: f.owner,
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      const pv = await request(srv())
        .post('/widget/v1/preview/exchange')
        .set('Origin', W_ORIGIN)
        .send({ pk: f.pk, parentOrigin: adm.origin, token: raw })
        .expect(403);
      expect(pv.body.error.code).toBe('PREVIEW_INVALID');

      // Пинг загрузчика с admin-хоста не пишет строку установки.
      await request(srv())
        .get(`/widget/v1/ping?pk=${f.pk}&v=1.0.0&c=1`)
        .set('Referer', `${adm.origin}/orders`)
        .expect(200);
      expect(
        await stack.prisma.assistSiteInstallPing.count({
          where: { siteId: f.siteId, origin: adm.origin },
        }),
      ).toBe(0);
    });

    it('живой visitor-token admin-хоста: ORIGIN_DENIED на каждом маршруте по токену', async () => {
      await markAdmin([]);
      const t = await token(adm.origin);
      await markAdmin([adm.id]);
      for (const [method, path, body] of tokenRoutes()) {
        const req = request(srv())
          [method](path)
          .set('Origin', W_ORIGIN)
          .set(WIDGET_VISITOR_TOKEN_HEADER, t)
          .set('Accept', 'application/json');
        const r = await (body ? req.send(body) : req);
        expect([path, r.status, r.body?.error?.code]).toEqual([
          path,
          403,
          'ORIGIN_DENIED',
        ]);
      }
    });

    it('запросы со страницы admin-хоста (event, goal, pv, exp, ref) — тот же отказ, что у чужого сайта', async () => {
      await markAdmin([adm.id]);
      for (const [path, body] of pageRoutes()) {
        const a = await fromPage(path, adm.origin, body);
        const e = await fromPage(path, evil(), body);
        expect([path, a.status, a.body?.error?.code]).toEqual([
          path,
          403,
          'ORIGIN_DENIED',
        ]);
        expect([path, a.status, sansRequestId(a.body)]).toEqual([
          path,
          e.status,
          sansRequestId(e.body),
        ]);
      }
    });

    it('снимок с адресом admin-хоста из сессии «Сайта» — не адрес сайта (400); тот же снимок на хосте «Сайта» — план', async () => {
      await markAdmin([adm.id]);
      const t = await token(pub.origin);
      const plan = (url: string) =>
        request(srv())
          .post('/widget/v1/ui-plan')
          .set('Origin', W_ORIGIN)
          .set(WIDGET_VISITOR_TOKEN_HEADER, t)
          .send(planBody(url));
      const bad = await plan(`${adm.origin}/orders`).expect(400);
      expect(bad.body.error.code).toBe('BAD_REQUEST');
      const ok = await plan(`${pub.origin}/`).expect(200);
      expect(ok.body.data).toMatchObject({ kind: 'plan' });
    });

    it('подсветка: промах на странице admin-хоста из сессии «Сайта» не засчитывается (карта «Админки» — не карта сайта)', async () => {
      await markAdmin([adm.id]);
      const el = uiElementId('#buy');
      const key = uiMapKey(`${adm.origin}/cart`)!;
      await ingestUiSnapshot(
        new SitesDb(stack.prisma).forAccount(f.accountId),
        {
          accountId: f.accountId,
          siteId: f.siteId,
          hostId: adm.id,
          host: key.host,
          path: key.path,
          source: 'crawl',
          viewport: 'any',
          elements: [{ selector: '#buy', tag: 'button', label: 'Купити' }],
        },
      );
      const t = await token(pub.origin);
      const { visitorId } = JSON.parse(
        Buffer.from(t.split('.')[0], 'base64url').toString('utf8'),
      ) as { visitorId: string };
      const conv = await stack.prisma.assistSiteConversation.create({
        data: {
          accountId: f.accountId,
          siteId: f.siteId,
          visitorId,
          ipHash: 'ip',
          parentOrigin: pub.origin,
        },
      });
      await stack.prisma.assistSiteMessage.create({
        data: {
          accountId: f.accountId,
          siteId: f.siteId,
          conversationId: conv.id,
          role: 'assistant',
          text: 'Ось кнопка.',
          flags: [],
          actions: [
            {
              kind: 'highlight',
              label: 'Показати',
              elementId: el,
              selector: '#buy',
              caption: 'Купити',
              page: uiMapPageRef(key),
            },
          ],
        },
      });
      const r = await request(srv())
        .post('/widget/v1/highlight-miss')
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t)
        .send({ elementId: el, pageUrl: `${adm.origin}/cart` })
        .expect(200);
      expect(r.body.data).toEqual({ ok: true, recorded: false });
      const map = await stack.prisma.siteUiMap.findFirst({
        where: { siteId: f.siteId, host: key.host },
      });
      expect(map!.staleSignals).toBe(0);
      // Ш4 (4): и «найдено» на странице admin-хоста — не голос и не «видели».
      await stack.prisma.siteUiElement.updateMany({
        where: { siteId: f.siteId, host: key.host },
        data: { staleDesktopAt: new Date(), lastSeenAt: new Date(0) },
      });
      const seen = await request(srv())
        .post('/widget/v1/highlight-seen')
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t)
        .send({ elementId: el, pageUrl: `${adm.origin}/cart` })
        .expect(200);
      expect(seen.body.data).toEqual({ ok: true, recorded: false });
      const row = await stack.prisma.siteUiElement.findFirstOrThrow({
        where: { siteId: f.siteId, host: key.host, elementId: el },
      });
      expect([row.seenCountDesktop, row.lastSeenAt]).toEqual([0, new Date(0)]);
    });

    it('кабинет: проверка установки и ссылка мастера Т-2 — без admin-хоста', async () => {
      await markAdmin([adm.id]);
      const owner = await stack.prisma.siteAccountMember.findFirstOrThrow({
        where: { accountId: f.accountId },
      });
      const m: AccountMembership = {
        accountId: f.accountId,
        memberId: owner.id,
        telegramId: f.owner,
        role: 'owner',
        productRoles: OWNER_PRODUCT_ROLES,
      };
      // Сеть не нужна: DNS-отказ — «страница не получена».
      const install = new InstallCheckService(new SitesDb(stack.prisma), {
        lookupAll: async () => {
          throw new Error('нет сети в тесте');
        },
      });
      const view = await install.check(m, f.siteId);
      expect(view.hosts.map((h) => h.hostId)).toEqual([pub.id]);

      const cab = new VoiceControlSettingsService(
        new SitesDb(stack.prisma),
        stack.prisma,
      );
      cab.env = {
        ...process.env,
        SONIOX_API_KEY: 'sx-admin-host-test',
        ASSIST_VOICE_ENABLED: 'true',
      };
      const onAdm = cab.testToken(m, f.siteId, { host: adm.host });
      await expect(onAdm).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'VOICE_CONTROL_HOST_REQUIRED',
        }),
      });
      const ok = await cab.testToken(m, f.siteId, { host: pub.host });
      expect(new URL(ok.url).host).toBe(pub.host);
    });

    it('кабинет: хосты вида и публикуемый hosts[] — без admin-хоста; снятие отметки возвращает хост «Сайту»', async () => {
      await markAdmin([adm.id]);
      const svc = new WidgetSettingsService(new SitesDb(stack.prisma));
      const owner = await stack.prisma.siteAccountMember.findFirstOrThrow({
        where: { accountId: f.accountId },
      });
      const m: AccountMembership = {
        accountId: f.accountId,
        memberId: owner.id,
        telegramId: f.owner,
        role: 'owner',
        productRoles: OWNER_PRODUCT_ROLES,
      };
      const view = await svc.get(m, f.siteId);
      expect(view.hosts.map((h) => h.hostId)).toEqual([pub.id]);
      // Явная ссылка на admin-хост в черновике — host_unknown.
      await expect(
        svc.saveDraft(m, f.siteId, {
          ...view.draft,
          hosts: [{ hostId: adm.id, enabled: true, pathMasks: [], hideOn: [] }],
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'WIDGET_CONFIG_INVALID' }),
      });
      const published = await svc.publish(m, f.siteId);
      const cfg = await readPublishedConfig(
        stack.publicDb,
        f.siteId,
        'widget',
        published.publishedVersion,
      );
      expect(
        (cfg?.hosts as Array<{ hostId: string }>).map((h) => h.hostId),
      ).toEqual([pub.id]);

      // Снятие отметки: хост снова public и снова работает (после публикации с ним).
      await markAdmin([]);
      expect(
        (
          await stack.prisma.siteHost.findUniqueOrThrow({
            where: { id: adm.id },
          })
        ).assistRole,
      ).toBe('public');
      expect((await svc.get(m, f.siteId)).hosts.map((h) => h.hostId)).toEqual([
        pub.id,
        adm.id,
      ]);
    });
  },
);

describeDb(
  'Инвариант «Админка → Сайт»: ссылки ответа чата «Сайта» на хост «Админки»',
  () => {
    const st = new ChatStack();
    beforeAll(async () => {
      await st.init();
    });
    afterAll(async () => {
      await st.close();
    });

    it('адрес admin-хоста в тексте ответа модели — вырезается, как чужой (пока хост не отмечен — остаётся)', async () => {
      const s = await st.site();
      const admHost = `adm-${s.host}`;
      const h = await st.owner.siteHost.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          host: admHost,
          status: 'verified',
          method: 'dns',
          verifiedAt: new Date(),
        },
      });
      await st.pages(s, [
        {
          path: '/delivery',
          title: 'Доставка',
          text: 'Доставка Новою поштою коштує 80 грн, відправка щодня.',
          lang: 'uk',
        },
      ]);
      const compose = st.model.compose.bind(st.model);
      st.model.compose = () =>
        `Доставка 80 грн [S1]. Замовлення: https://${admHost}/orders/new`;
      try {
        const text = async () =>
          (await st.ask(s, 'Скільки коштує доставка Новою поштою?')).text;
        // Контроль: хост «Сайта» — адрес остаётся.
        expect(await text()).toContain(`https://${admHost}/orders/new`);
        await st.owner.assistAdminSettings.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            adminHostIds: [h.id],
          },
        });
        const after = await text();
        expect(after).toContain('80 грн');
        expect(after).not.toContain(admHost);
      } finally {
        st.model.compose = compose;
      }
    });
  },
);
