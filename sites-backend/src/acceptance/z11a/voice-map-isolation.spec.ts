/**
 * Приёмка захода 11, пакет А — №62 в обратную сторону (К-9, У-28/У-31, ТЗ
 * §5-кватер.14 п.14): синоним опубликованной карты «Админки» в «Сайте» НЕ
 * действует. План посетителя — под ролью assist_public (как в проде),
 * карта «Админки» того же сайта — опубликована настоящим сервисом «Админки»
 * (основной ролью). Команда с синонимом «Админки» идёт обычным путём
 * (модель, `mapKey` пуст), канарейка имени «Админки» не встречается ни в
 * ответе виджета, ни в одной таблице карты/фраз/журнала «Сайта»; та же
 * механика со своей картой «Сайта» — прямой путь (контроль).
 */
import { randomUUID } from 'crypto';
import { AdminActionLogService } from '../../modules/assist-admin-mode/action-log.service';
import { AdminModeService } from '../../modules/assist-admin-mode/admin-mode.service';
import {
  actorOfMember,
  AdminVoiceMapService,
} from '../../modules/assist-admin-voice-map/admin-voice-map.service';
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
import type { UiPlanRequest } from '../../modules/assist-site-voice-control/api-types';
import {
  SiteUiPlanService,
  type UiPlanCtx,
} from '../../modules/assist-site-voice-control/public/ui-plan.service';
import {
  clearVoiceMapCache,
  readPublishedVoiceMap,
} from '../../modules/assist-site-voice-control/public/voice-map-store';
import { VoiceMapService } from '../../modules/assist-site-voice-map/voice-map.service';
import { GeminiText } from '../../modules/site-ai/text-model';
import type { AccountMembership } from '../../modules/site-core/account/roles';
import type { HostAccessService } from '../../modules/site-core/ownership/host-access.service';
import { SitesDb } from '../../prisma/sites-db.service';

jest.setTimeout(240_000);

const CANARY = 'КАНАРКА-АДМІНКИ';

describeDb(
  'Заход 11 (№62) — синоним карты «Админки» в «Сайте» не действует',
  () => {
    const st = new ChatStack();
    const fake = new FakeSoniox();
    let plans: SiteUiPlanService;
    let siteMaps: VoiceMapService;
    let adminMaps: AdminVoiceMapService;
    const modelCalls: string[] = [];

    beforeAll(async () => {
      await st.init();
      const env = {
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
      const db = new SitesDb(st.owner);
      siteMaps = new VoiceMapService(db);
      siteMaps.env = env;
      adminMaps = new AdminVoiceMapService(
        db,
        new AdminModeService(db, st.owner, {} as HostAccessService),
        new AdminActionLogService(db),
      );
      adminMaps.env = {};
    });
    afterAll(() => st.close());
    beforeEach(() => {
      modelCalls.length = 0;
      clearVoiceMapCache();
    });

    async function vcSite(): Promise<{ s: ChatSite; m: AccountMembership }> {
      const s = await st.site({ name: `Магазин ${randomUUID().slice(0, 6)}` });
      await setPlan(st.owner, s.accountId, 'pro');
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
      // «Админка» того же сайта: свой verified-хост админки.
      const adminHost = `admin-${randomUUID().slice(0, 6)}.z11a.example`;
      const ah = await st.owner.siteHost.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          host: adminHost,
          status: 'verified',
          method: 'dns',
          verifiedAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await st.owner.assistAdminSettings.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          adminModeEnabled: true,
          adminAccess: 'both',
          adminHostIds: [ah.id],
        },
      });
      const om = await st.owner.siteAccountMember.findFirstOrThrow({
        where: { accountId: s.accountId, role: 'owner' },
      });
      return {
        s,
        m: {
          accountId: s.accountId,
          memberId: om.id,
          telegramId: om.telegramId,
          role: 'owner',
          productRoles: {},
        } as unknown as AccountMembership,
      };
    }

    const cart = {
      tag: 'button',
      role: 'button',
      text: 'Купити',
      assistId: 'add-to-cart',
      unique: true,
    };
    const product = (s: ChatSite) => ({
      url: s.url('/product/1'),
      title: 'Футболка',
      elements: [
        {
          ref: 'e1',
          role: 'button',
          tag: 'button',
          text: 'Купити',
          assistId: 'add-to-cart',
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
    const ctxOf = (s: ChatSite): UiPlanCtx => ({
      site: s.ctx(),
      visitor: st.visitor(),
    });

    it('карта «Админки» с синонимом «в торбу» на той же разметке — план «Сайта» его не знает: модель, mapKey пуст; канарейки нет ни в ответе, ни в таблицах «Сайта»', async () => {
      const { s, m } = await vcSite();
      const d = await adminMaps.draft(m, s.siteId);
      await adminMaps.patch(
        actorOfMember(m),
        s.siteId,
        {
          expectedRevision: d.revision,
          ops: [
            {
              op: 'upsert-target',
              target: {
                key: 'add-to-cart',
                scope: 'site',
                descriptor: cart,
                names: { uk: CANARY },
                synonyms: { uk: [{ text: 'в торбу' }] },
              },
            },
          ],
        },
        'tma',
      );
      const av = await adminMaps.buildVersion(
        actorOfMember(m),
        s.siteId,
        'tma',
      );
      await adminMaps.publish(m, s.siteId, String(av.number));

      // Публикация карты «Админки» не создала ни карты, ни фраз «Сайта».
      expect(
        await st.owner.assistSiteVoiceMap.count({
          where: { siteId: s.siteId },
        }),
      ).toBe(0);
      expect(
        await st.owner.assistSitePhrase.count({ where: { siteId: s.siteId } }),
      ).toBe(0);
      expect(
        await st.owner.assistAdminPhrase.count({
          where: { siteId: s.siteId, norm: 'в торбу' },
        }),
      ).toBe(1);
      // Публичная карта «Сайта» под ролью assist_public — пусто.
      expect(
        await readPublishedVoiceMap(st.publicDb, s.siteId, Date.now()),
      ).toBeNull();
      const r = await plans.create(
        ctxOf(s),
        typed(product(s), 'додай в торбу'),
        async () => true,
      );
      expect(modelCalls).toHaveLength(1);
      expect(modelCalls[0]).not.toContain(CANARY);
      expect(modelCalls[0]).not.toContain('<voice_map');
      expect(JSON.stringify(r)).not.toContain(CANARY);
      // Журнал шагов сайта: ни одной строки с ключом/промахом карты.
      const log = await st.owner.assistSiteUiActionLog.findMany({
        where: { siteId: s.siteId },
      });
      expect(log.length).toBeGreaterThan(0);
      expect(log.every((l) => l.mapKey === null && !l.mapMiss)).toBe(true);
      // Ни одна таблица карты/фраз «Сайта» не содержит канарейку «Админки».
      const siteRows = [
        ...(await st.owner.assistSiteVoiceMap.findMany({
          where: { siteId: s.siteId },
        })),
        ...(await st.owner.assistSiteVoiceMapVersion.findMany({
          where: { siteId: s.siteId },
        })),
        ...(await st.owner.assistSitePhrase.findMany({
          where: { siteId: s.siteId },
        })),
        ...(await st.owner.assistSiteUiActionLog.findMany({
          where: { siteId: s.siteId },
        })),
      ];
      expect(
        JSON.stringify(siteRows, (_k, v) =>
          typeof v === 'bigint' ? String(v) : v,
        ),
      ).not.toContain(CANARY);
      // А в «Админке» — есть (канарейка жива — тест не пустой).
      const adm = await st.owner.assistAdminVoiceMapVersion.findFirstOrThrow({
        where: { siteId: s.siteId, status: 'published' },
      });
      expect(JSON.stringify(adm.content)).toContain(CANARY);
    });

    it('контроль: тот же синоним в карте «Сайта» — прямой путь без модели (механика работает, отличие — только контур)', async () => {
      const { s, m } = await vcSite();
      const d = await siteMaps.draft(m, s.siteId);
      await siteMaps.patch(
        m,
        s.siteId,
        {
          expectedRevision: d.revision,
          ops: [
            {
              op: 'upsert-target',
              target: {
                key: 'add-to-cart',
                scope: 'site',
                descriptor: cart,
                names: { uk: 'Купити' },
                synonyms: { uk: [{ text: 'в торбу' }] },
              },
            },
          ],
        },
        'tma',
      );
      const v = await siteMaps.buildVersion(m, s.siteId, 'tma');
      await siteMaps.publish(m, s.siteId, String(v.number));
      const r = await plans.create(
        ctxOf(s),
        typed(product(s), 'додай в торбу'),
        async () => true,
      );
      expect(modelCalls).toHaveLength(0);
      expect(r.kind).toBe('plan');
      if (r.kind !== 'plan') return;
      expect(r.steps[0].target?.ref).toBe('e1');
      const log = await st.owner.assistSiteUiActionLog.findMany({
        where: { planId: r.planId! },
      });
      expect(log.find((l) => l.action === 'plan')?.mapKey).toBe('add-to-cart');
      // Карта «Админки» этого сайта не появилась.
      expect(
        await st.owner.assistAdminVoiceMap.count({
          where: { siteId: s.siteId },
        }),
      ).toBe(0);
    });
  },
);
