/**
 * AT-F11-01 (P-D, проектный документ §9.3, §11.4, §13.5; ТЗ §14): путь
 * «внешняя метка → внутренняя страница → форма → заявка» при допустимом
 * хранении `session_ref`: после обогащения в CRM восстанавливаются
 * материал, размещение (по реестру `placementCode`), кампания и источник
 * (`last_non_direct_30d`, первый известный — отдельно); дедупликация
 * `eventId`; `consentState` записан; поля событий ≡ утверждённой карте
 * событий (`event_map`). Паспорт трафика: публикация/размещение → сессии →
 * события → заявки, покрытие и CPL рядом (нулевой знаменатель — не ноль).
 */
import { randomUUID } from 'crypto';
import type { Client } from 'pg';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { PubDb, connectOwner } from '../../prisma/publisher-schema.testing';
import {
  asMember,
  type CoreStack,
} from '../../modules/publisher/core/testing/core-stack.testing';
import { DEFAULT_PARAMETER_VALUES } from '../../modules/publisher/contracts/parameters';
import { eventMapIssues } from '../../modules/publisher/contracts/public-api';
import { LeadEnrichJob } from '../../modules/publisher/leads/lead-enrich.job';
import { computeReport } from '../../modules/publisher/reports/metrics/report-compute';
import { ReportsService } from '../../modules/publisher/reports/reports.service';
import {
  intakeProduct,
  leadBody,
  leadsStack,
  openLive,
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
  '[AT-F11-01] Паспорт трафика: метка → внутренняя страница → форма → заявка восстанавливаются через session_ref',
  () => {
    let s: CoreStack;
    let w: IntakeWorld;
    let team: SeededMembers;
    let owner: Client;
    let db: PubDb;
    let slug: string;
    let contentId: string;
    let placementId: string;
    let placementCode: string;
    let campaignId: string;
    let restore: Array<() => void>;
    const srv = () => s.app!.getHttpServer();
    const ownHost = () => new URL(w.origin).host;
    const entry = (
      expenseId: string,
      kind: 'deliver' | 'adjust',
      amountMinor: number,
      status: 'confirmed' | 'pending',
      note?: string,
    ) =>
      db.child(
        'pub_expense_entries',
        {
          accountId: w.account.accountId,
          siteId: w.account.siteId,
          productId: w.product.id,
        },
        {
          expenseId,
          kind,
          amountMinor,
          status,
          note: note ?? null,
          occurredAt: new Date(),
          confirmedAt: status === 'confirmed' ? new Date() : null,
          opKey: randomUUID(),
        },
      );

    beforeAll(async () => {
      restore = [useTestSecrets(), trustLocalProxy()];
      s = await leadsStack({ http: true });
      w = await intakeProduct(s, { kind: 'working', analytics: 'session' });
      await openLive(s, w.product.id);
      team = await seedMembers(s.prisma, w.product, w.account.owner);
      owner = await connectOwner();
      db = new PubDb(owner);
      const world = {
        accountId: w.account.accountId,
        siteId: w.account.siteId,
        productId: w.product.id,
      };
      contentId = await db.article(world);
      slug = (
        await s.prisma.pubContent.findFirstOrThrow({ where: { id: contentId } })
      ).slug as string;
      await db.budgetLimit(world);
      const ap = await db.approvedPlacement(world);
      placementId = ap.placementId;
      const pl = await s.prisma.pubPlacement.findFirstOrThrow({
        where: { id: placementId },
      });
      placementCode = pl.placementCode;
      campaignId = pl.campaignId;
    });
    afterAll(async () => {
      await owner.end();
      await s.close();
      restore.forEach((r) => r());
    });

    it('путь по метке: материал, размещение, кампания и источник восстановлены; первая/последняя модели — отдельно; consentState записан', async () => {
      const sessionRef = testSessionRef();
      const ip = randomIp();
      const landing = {
        key: w.product.publicKey,
        eventId: randomUUID(),
        name: 'content_view',
        path: `/materials/${slug}`,
        contentSlug: slug,
        sessionRef,
        referrerHost: 'venue.example',
        utm: {
          utm_source: 'venue',
          utm_medium: 'paid',
          utm_campaign: 'pilot',
          utm_content: placementCode,
        },
        consentState: 'not_required',
      };
      expect(
        (await postEvent(s, landing, { origin: w.origin, ip })).status,
      ).toBe(202);
      // Дедупликация eventId: повтор маяка — та же строка.
      expect(
        (await postEvent(s, landing, { origin: w.origin, ip })).status,
      ).toBe(202);
      expect(
        await s.prisma.pubEvent.count({
          where: { productId: w.product.id, eventId: landing.eventId },
        }),
      ).toBe(1);
      // Внутренние переходы — без UTM, переход со своего хоста.
      for (const e of [
        { name: 'cta_click', path: `/materials/${slug}`, contentSlug: slug },
        { name: 'content_view', path: '/contact', referrerHost: ownHost() },
      ]) {
        expect(
          (
            await postEvent(
              s,
              {
                key: w.product.publicKey,
                eventId: randomUUID(),
                sessionRef,
                consentState: 'not_required',
                ...e,
              },
              { origin: w.origin, ip },
            )
          ).status,
        ).toBe(202);
      }
      const body = leadBody(w.product.publicKey, {
        sessionRef,
        consentState: 'not_required',
      });
      expect((await postLead(s, body, { origin: w.origin, ip })).status).toBe(
        201,
      );
      const lead0 = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      expect(lead0).toMatchObject({
        sessionRef,
        consentState: 'not_required',
        contentSlugRaw: null,
        placementCodeRaw: null,
        enrichedAt: null,
      });

      await s.mod.get(LeadEnrichJob).run({
        now: new Date(),
        scope: { siteIds: [w.account.siteId] },
        deadline: new Date(Date.now() + 30_000),
      });
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { id: lead0.id },
      });
      expect(lead).toMatchObject({
        contentId,
        placementId,
        campaignId,
        sessionRef,
      });
      expect(lead.enrichedAt).not.toBeNull();
      const a = lead.attribution as {
        model: string;
        coverage: string;
        last: { group: string; placementId: string; source: string };
        first: { group: string };
      };
      expect(a.model).toBe('last_non_direct_30d');
      expect(a.coverage).toBe('linked');
      expect(a.last).toMatchObject({
        group: 'paid_placement',
        placementId,
        source: 'venue',
      });
      expect(a.first).toMatchObject({ group: 'paid_placement' });
      const session = await s.prisma.pubSession.findFirstOrThrow({
        where: { productId: w.product.id, sessionRef },
      });
      expect(session).toMatchObject({
        landingPath: `/materials/${slug}`,
        landingContentId: contentId,
        placementId,
        channelGroup: 'paid_placement',
        consentState: 'not_required',
      });
      const evs = await s.prisma.pubEvent.findMany({
        where: { productId: w.product.id, sessionRef },
        orderBy: { occurredAt: 'asc' },
      });
      expect(evs.map((e) => e.channelGroup)).toEqual([
        'paid_placement',
        'direct_unknown',
        'direct_unknown',
        'direct_unknown',
      ]);
      expect(evs.every((e) => e.enrichedAt)).toBe(true);

      // Карточка в CRM показывает то же; квалификация → паспорт размещения.
      const sa = asMember(team.sales.telegramId, w.account.accountId);
      const card = await request(srv())
        .get(`/publisher/products/${w.product.id}/leads/${lead.id}`)
        .set(sa);
      expect(card.body.data).toMatchObject({
        contentId,
        placementId,
        campaignId,
        attribution: { coverage: 'linked' },
      });
      const q = await request(srv())
        .post(`/publisher/products/${w.product.id}/leads/${lead.id}/transition`)
        .set(sa)
        .send({
          opKey: randomUUID(),
          to: 'qualified',
          confirmedInterestAt: new Date().toISOString(),
          expectedRevision: card.body.data.revision,
        });
      expect(q.status).toBe(200);

      const pass = await request(srv())
        .get(`/publisher/products/${w.product.id}/traffic/passport`)
        .query({ placementId })
        .set(asMember(team.analyst.telegramId, w.account.accountId));
      expect(pass.status).toBe(200);
      expect(pass.body.data).toMatchObject({
        sessionMode: 'session_ref',
        sessions: 1,
        placement: { id: placementId, placementCode },
        leads: { total: 1, test: 0, pendingEnrichment: 0 },
        qualified: { allExternal: 1, linked: 1, unknown: 0 },
        coverage: { kind: 'value', value: 1 },
        // Расчёт отчёта P-E (S2-2): оказанного по размещению ещё нет —
        // числитель известен и равен 0 (как в отчёте), знаменатель 1.
        directCpl: { kind: 'value', value: '0' },
      });
      expect(pass.body.data.events.content_view).toBe(1);

      // Оказанная часть закупки → прямой CPL = оказано / связанные проспекты.
      const world = {
        accountId: w.account.accountId,
        siteId: w.account.siteId,
        productId: w.product.id,
      };
      const expenseId = await db.child('pub_expenses', world, {
        category: 'placements',
        description: 'Закупка розміщення',
        placementId,
        amountTotalMinor: 100_000,
        deliveredMinor: 60_000,
        currency: 'UAH',
      });
      // §9.4 (аудит P2-4, S2-2): числитель — подтверждённые deliver +
      // adjust; неподтверждённое оказание не входит.
      await entry(expenseId, 'deliver', 60_000, 'confirmed');
      await entry(expenseId, 'adjust', 5_000, 'confirmed', 'Доплата за банер');
      await entry(expenseId, 'deliver', 30_000, 'pending');
      const pass2 = await request(srv())
        .get(`/publisher/products/${w.product.id}/traffic/passport`)
        .query({ placementId })
        .set(asMember(team.product_owner.telegramId, w.account.accountId));
      expect(pass2.body.data.directCpl).toEqual({
        kind: 'value',
        value: '65000',
      });
      expect(pass2.body.data.currency).toBe('UAH');
    });

    it('прямой CPL при нуле связанных проспектов — not_computable с числителем (не ноль)', async () => {
      const world = {
        accountId: w.account.accountId,
        siteId: w.account.siteId,
        productId: w.product.id,
      };
      const other = await db.approvedPlacement(world);
      const otherExpense = await db.child('pub_expenses', world, {
        category: 'placements',
        description: 'Ще одна закупка',
        placementId: other.placementId,
        amountTotalMinor: 50_000,
        deliveredMinor: 50_000,
        currency: 'UAH',
      });
      await entry(otherExpense, 'deliver', 50_000, 'confirmed');
      const r = await request(srv())
        .get(`/publisher/products/${w.product.id}/traffic/passport`)
        .query({ placementId: other.placementId })
        .set(asMember(team.analyst.telegramId, w.account.accountId));
      expect(r.body.data.directCpl).toEqual({
        kind: 'not_computable',
        reason: 'zero_denominator',
        inputs: { numeratorMinor: '50000', technicalQualifiedOfPlacements: 0 },
      });
      // Наблюдатель паспорт не читает (матрица: PO, AN).
      const vw = await request(srv())
        .get(`/publisher/products/${w.product.id}/traffic/passport`)
        .set(asMember(team.viewer.telegramId, w.account.accountId));
      expect(vw.status).toBe(403);
    });

    it('S2-2 сверка с P-E: один проспект с заявками из двух размещений засчитан одному (первая квалифицированная); прямой и продуктовый CPL, покрытие ≡ отчёт P-E', async () => {
      const world = {
        accountId: w.account.accountId,
        siteId: w.account.siteId,
        productId: w.product.id,
      };
      const b = await db.approvedPlacement(world);
      const codeB = (
        await s.prisma.pubPlacement.findFirstOrThrow({
          where: { id: b.placementId },
        })
      ).placementCode;
      const expB = await db.child('pub_expenses', world, {
        category: 'placements',
        description: 'Закупка B',
        placementId: b.placementId,
        amountTotalMinor: 90_000,
        deliveredMinor: 90_000,
        currency: 'UAH',
      });
      await entry(expB, 'deliver', 90_000, 'confirmed');
      const email = `pubd.s22.${randomUUID().slice(0, 8)}@example.com`;
      const sa = asMember(team.sales.telegramId, w.account.accountId);
      const viaPlacement = async (code: string) => {
        const sessionRef = testSessionRef();
        const ip = randomIp();
        expect(
          (
            await postEvent(
              s,
              {
                key: w.product.publicKey,
                eventId: randomUUID(),
                name: 'content_view',
                path: '/',
                sessionRef,
                utm: { utm_source: 'venue', utm_content: code },
                consentState: 'not_required',
              },
              { origin: w.origin, ip },
            )
          ).status,
        ).toBe(202);
        const body = leadBody(w.product.publicKey, {
          sessionRef,
          contact: email,
        });
        expect((await postLead(s, body, { origin: w.origin, ip })).status).toBe(
          201,
        );
        return (
          await s.prisma.pubLead.findFirstOrThrow({
            where: { submissionKey: body.submissionKey },
          })
        ).id;
      };
      const x = await viaPlacement(placementCode);
      const y = await viaPlacement(codeB);
      await s.mod.get(LeadEnrichJob).run({
        now: new Date(),
        scope: { siteIds: [w.account.siteId] },
        deadline: new Date(Date.now() + 30_000),
      });
      for (const id of [x, y]) {
        const card = await request(srv())
          .get(`/publisher/products/${w.product.id}/leads/${id}`)
          .set(sa);
        const q = await request(srv())
          .post(`/publisher/products/${w.product.id}/leads/${id}/transition`)
          .set(sa)
          .send({
            opKey: randomUUID(),
            to: 'qualified',
            confirmedInterestAt: new Date().toISOString(),
            expectedRevision: card.body.data.revision,
          });
        expect(q.status).toBe(200);
      }
      const leads = await s.prisma.pubLead.findMany({
        where: { id: { in: [x, y] } },
        select: { prospectId: true, placementId: true },
      });
      expect(new Set(leads.map((l) => l.prospectId)).size).toBe(1);
      expect(new Set(leads.map((l) => l.placementId))).toEqual(
        new Set([placementId, b.placementId]),
      );

      const from = new Date(Date.now() - 2 * 3_600_000);
      const to = new Date(Date.now() + 3_600_000);
      const an = asMember(team.analyst.telegramId, w.account.accountId);
      const passportOf = async (pl: string) =>
        (
          await request(srv())
            .get(`/publisher/products/${w.product.id}/traffic/passport`)
            .query({
              placementId: pl,
              from: from.toISOString(),
              to: to.toISOString(),
            })
            .set(an)
        ).body.data;
      const pe = await s.db
        .forAccount(w.account.accountId)
        .$transaction(async (tx) =>
          computeReport(
            await new ReportsService().buildInputs(tx, w.product, {
              kind: 'ad_hoc',
              periodStart: from,
              periodEnd: to,
              snapshotAt: new Date(),
              experiment: null,
            }),
          ),
        );
      const m = pe.metrics as {
        leads: {
          qualifiedUnique: number;
          unknownQualified: number;
          coverage: unknown;
        };
        economics: { productCpl: unknown };
        placements: Array<{
          id: string;
          technicalQualified: number;
          directCpl: unknown;
        }>;
      };
      const rowOf = (id: string) => m.placements.find((r) => r.id === id)!;
      expect(rowOf(b.placementId).technicalQualified).toBe(0);
      expect(rowOf(placementId).technicalQualified).toBeGreaterThanOrEqual(1);
      for (const pl of [placementId, b.placementId]) {
        const pass = await passportOf(pl);
        expect({
          pl,
          directCpl: pass.directCpl,
          linked: pass.qualified.linked,
          allExternal: pass.qualified.allExternal,
          unknown: pass.qualified.unknown,
          coverage: pass.coverage,
          productCpl: pass.productCpl,
        }).toEqual({
          pl,
          directCpl: rowOf(pl).directCpl,
          linked: rowOf(pl).technicalQualified,
          allExternal: m.leads.qualifiedUnique,
          unknown: m.leads.unknownQualified,
          coverage: m.leads.coverage,
          productCpl: m.economics.productCpl,
        });
      }
      expect((await passportOf(b.placementId)).directCpl).toEqual({
        kind: 'not_computable',
        reason: 'zero_denominator',
        inputs: { numeratorMinor: '90000', technicalQualifiedOfPlacements: 0 },
      });
    });

    it('S3-11: размещение внесено в реестр ПОСЛЕ событий — события и сессия переклассифицируются в paid_placement, заявка переобогащается', async () => {
      const world = {
        accountId: w.account.accountId,
        siteId: w.account.siteId,
        productId: w.product.id,
      };
      const code = `pl-late${randomUUID().slice(0, 4).replace(/[0-9]/g, 'x')}`;
      const sessionRef = testSessionRef();
      const ip = randomIp();
      const ev = {
        key: w.product.publicKey,
        eventId: randomUUID(),
        name: 'content_view',
        path: '/',
        sessionRef,
        utm: { utm_source: 'venue', utm_medium: 'paid', utm_content: code },
        consentState: 'not_required',
      };
      expect((await postEvent(s, ev, { origin: w.origin, ip })).status).toBe(
        202,
      );
      const body = leadBody(w.product.publicKey, { sessionRef });
      expect((await postLead(s, body, { origin: w.origin, ip })).status).toBe(
        201,
      );
      const run = () =>
        s.mod.get(LeadEnrichJob).run({
          now: new Date(),
          scope: { siteIds: [w.account.siteId] },
          deadline: new Date(Date.now() + 30_000),
        });
      await run();
      const before = await s.prisma.pubEvent.findFirstOrThrow({
        where: { eventId: ev.eventId },
      });
      expect(before.placementId).toBeNull();
      expect(before.channelGroup).not.toBe('paid_placement');
      const lead0 = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      expect(lead0.placementId).toBeNull();

      const late = await db.placement(world, { placementCode: code });
      const r = await run();
      expect(r.details).toMatchObject({ reclassified: 2 });
      const after = await s.prisma.pubEvent.findFirstOrThrow({
        where: { eventId: ev.eventId },
      });
      expect(after).toMatchObject({
        placementId: late,
        channelGroup: 'paid_placement',
      });
      expect(
        await s.prisma.pubSession.findFirstOrThrow({
          where: { productId: w.product.id, sessionRef },
        }),
      ).toMatchObject({ placementId: late, channelGroup: 'paid_placement' });
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { id: lead0.id },
      });
      expect(lead.placementId).toBe(late);
      expect(
        (lead.attribution as { last: { placementId: string } }).last,
      ).toMatchObject({ placementId: late });
      // Повторный проход — переклассифицировать нечего.
      expect((await run()).details).toMatchObject({ reclassified: 0 });
    });

    it('карта событий: поля утверждаемой карты ⊆ полей, которые API принимает и хранит (pub_events)', async () => {
      expect(eventMapIssues(DEFAULT_PARAMETER_VALUES.event_map)).toEqual([]);
      const cols = await s.prisma.$queryRaw<Array<{ c: string }>>`
      SELECT column_name AS "c" FROM information_schema.columns
       WHERE table_schema = 'sites' AND table_name = 'pub_events'`;
      const have = new Set(cols.map((c) => c.c));
      const columnOf: Record<string, string> = {
        contentSlug: 'contentSlugRaw',
        placementCode: 'placementCodeRaw',
        referrerHost: 'referrerHost',
        utm: 'utm',
        sessionRef: 'sessionRef',
        clientAt: 'clientAt',
      };
      for (const e of DEFAULT_PARAMETER_VALUES.event_map.events) {
        for (const f of e.fields)
          expect({ f, column: have.has(columnOf[f]) }).toEqual({
            f,
            column: true,
          });
      }
      for (const c of [
        'eventId',
        'name',
        'occurredAt',
        'testFlag',
        'contentId',
        'placementId',
        'channelGroup',
        'leadId',
      ]) {
        expect(have.has(c)).toBe(true);
      }
    });
  },
);
