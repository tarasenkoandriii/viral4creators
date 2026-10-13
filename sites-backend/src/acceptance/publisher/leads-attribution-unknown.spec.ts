/**
 * AT-F11-02 (P-D, проектный документ §9.3, §13.5; ТЗ §14): без UTM и без
 * хранения истории (`analytics_storage='none'`) неизвестный источник не
 * восстанавливается догадкой: `coverage='unknown'`, последний и первый —
 * пусто, размещение и кампания-размещение не приписываются; первая и
 * последняя модели не удваивают заявку; неизвестные обращения не
 * распределяются по каналам паспорта.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  asMember,
  type CoreStack,
} from '../../modules/publisher/core/testing/core-stack.testing';
import { LeadEnrichJob } from '../../modules/publisher/leads/lead-enrich.job';
import {
  intakeProduct,
  leadBody,
  leadsStack,
  postEvent,
  postLead,
  randomIp,
  trustLocalProxy,
  testSessionRef,
  useTestSecrets,
  type IntakeWorld,
} from '../../modules/publisher/leads/testing/leads-fixtures.testing';
import {
  seedMembers,
  type SeededMembers,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-F11-02] Без UTM и хранения — источник unknown, модели не удваивают заявку',
  () => {
    let s: CoreStack;
    let w: IntakeWorld;
    let team: SeededMembers;
    let restore: Array<() => void>;
    const srv = () => s.app!.getHttpServer();
    const enrich = () =>
      s.mod.get(LeadEnrichJob).run({
        now: new Date(),
        scope: { siteIds: [w.account.siteId] },
        deadline: new Date(Date.now() + 30_000),
      });

    beforeAll(async () => {
      restore = [useTestSecrets(), trustLocalProxy()];
      s = await leadsStack({ http: true });
      w = await intakeProduct(s, { kind: 'working' }); // analytics_storage = none
      team = await seedMembers(s.prisma, w.product, w.account.owner);
    });
    afterAll(async () => {
      await s.close();
      restore.forEach((r) => r());
    });

    it('метка была на материале, но после внутреннего перехода форма без UTM и без sessionRef → coverage unknown, без догадки', async () => {
      const ip = randomIp();
      const sessionRef = testSessionRef();
      expect(
        (
          await postEvent(
            s,
            {
              key: w.product.publicKey,
              eventId: randomUUID(),
              name: 'content_view',
              path: '/materials/x',
              sessionRef,
              utm: { utm_source: 'news', utm_medium: 'social' },
              consentState: 'not_required',
            },
            { origin: w.origin, ip },
          )
        ).status,
      ).toBe(202);
      // Трекер при 'none' sessionRef не шлёт; даже присланный — не хранится.
      const body = leadBody(w.product.publicKey, { sessionRef });
      expect((await postLead(s, body, { origin: w.origin, ip })).status).toBe(
        201,
      );
      await enrich();
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      expect(lead.sessionRef).toBeNull();
      expect(lead).toMatchObject({ placementId: null, contentId: null });
      expect(lead.attribution).toEqual({
        model: 'last_non_direct_30d',
        last: null,
        first: null,
        coverage: 'unknown',
      });
      expect(
        await s.prisma.pubSession.count({ where: { productId: w.product.id } }),
      ).toBe(0);
    });

    it('метка прямо на странице формы: одна заявка, последний и первый — один и тот же источник, не две заявки', async () => {
      const body = leadBody(w.product.publicKey, {
        utm: { utm_source: 'forum', utm_medium: 'community' },
      });
      expect(
        (await postLead(s, body, { origin: w.origin, ip: randomIp() })).status,
      ).toBe(201);
      await enrich();
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      const a = lead.attribution as {
        coverage: string;
        last: { group: string; source: string };
        first: { group: string; source: string };
      };
      expect(a.coverage).toBe('linked');
      expect(a.last).toMatchObject({
        group: 'unpaid_social_community',
        source: 'forum',
      });
      expect(a.first).toEqual(a.last);
      expect(
        await s.prisma.pubLead.count({
          where: { submissionKey: body.submissionKey },
        }),
      ).toBe(1);
    });

    it('паспорт: неизвестные квалифицированные — отдельно, по каналам не распределяются; заявка считается один раз', async () => {
      const sa = asMember(team.sales.telegramId, w.account.accountId);
      const leads = await s.prisma.pubLead.findMany({
        where: { productId: w.product.id },
      });
      for (const l of leads) {
        const r = await request(srv())
          .post(`/publisher/products/${w.product.id}/leads/${l.id}/transition`)
          .set(sa)
          .send({
            opKey: randomUUID(),
            to: 'qualified',
            confirmedInterestAt: new Date().toISOString(),
            expectedRevision: l.revision,
          });
        expect(r.status).toBe(200);
      }
      const p = await request(srv())
        .get(`/publisher/products/${w.product.id}/traffic/passport`)
        .set(asMember(team.analyst.telegramId, w.account.accountId));
      expect(p.status).toBe(200);
      expect(p.body.data).toMatchObject({
        sessionMode: 'none',
        sessions: null, // не измеряется ≠ 0
        leads: { total: 2, test: 0 },
        // S2-2: покрытие и связь — расчёт отчёта P-E (§9.3): техническая
        // связь — сессия заявки в 30-дневном окне; при storage='none'
        // сессий нет, поэтому обе квалифицированные — unknown (метка на
        // странице формы видна в карточке заявки, но в «связанные» CPL не
        // входит — как в отчёте P-E).
        qualified: { allExternal: 2, linked: 0, unknown: 2 },
        coverage: { kind: 'value', value: 0 },
      });
      // Каналы — только по событиям с известной группой; лишней «доли» нет.
      const byChannel = p.body.data.byChannel as Record<string, number>;
      expect(Object.values(byChannel).reduce((x, y) => x + y, 0)).toBe(
        p.body.data.events.content_view +
          p.body.data.events.cta_click +
          p.body.data.events.lead_submit_success,
      );
    });
  },
);
