/**
 * P-D на базе — механизмы под приёмкой (проектный документ §6.5, §11.4,
 * §15.1, §16.6): права роли `publisher_public` минимальны и достаточны
 * для фактического SQL приёма; обогащение идемпотентно и вызывается вне
 * очереди при открытии карточки; сбой обогащения — `failed` с кодом и
 * повтор; основание хранения менеджера обогащение не перетирает;
 * переназначение при удалении участника; слияние и разделение проспектов
 * с историей.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import { PublisherPublicDb } from '../../../prisma/publisher-public-db.service';
import { pgCodeOf } from '../core/operation';
import { asMember, type CoreStack } from '../core/testing/core-stack.testing';
import { LeadEnrichJob, LeadEnrichService } from './lead-enrich.job';
import { LeadsMemberReassign } from './leads-ports';
import { ProspectsService } from './prospects.service';
import {
  intakeProduct,
  leadBody,
  leadsStack,
  postLead,
  randomIp,
  syntheticPerson,
  trustLocalProxy,
  useTestSecrets,
  type IntakeWorld,
} from './testing/leads-fixtures.testing';
import { seedMembers, type SeededMembers } from '../testing/fixtures.testing';

jest.setTimeout(120_000);

ciDescribe('P-D: приём, обогащение, проспекты на базе', () => {
  let s: CoreStack;
  let w: IntakeWorld;
  let team: SeededMembers;
  let restore: Array<() => void>;
  const srv = () => s.app!.getHttpServer();
  const sa = () => asMember(team.sales.telegramId, w.account.accountId);
  const ctx = (now = new Date()) => ({
    now,
    scope: { siteIds: [w.account.siteId] },
    deadline: new Date(Date.now() + 30_000),
  });
  const submit = async (over: Record<string, unknown> = {}) => {
    const body = leadBody(w.product.publicKey, over);
    expect(
      (await postLead(s, body, { origin: w.origin, ip: randomIp() })).status,
    ).toBe(201);
    return s.prisma.pubLead.findFirstOrThrow({
      where: { submissionKey: body.submissionKey },
    });
  };

  beforeAll(async () => {
    restore = [useTestSecrets(), trustLocalProxy()];
    s = await leadsStack({ http: true });
    w = await intakeProduct(s, { kind: 'working' });
    team = await seedMembers(s.prisma, w.product, w.account.owner);
  });
  afterAll(async () => {
    await s.close();
    restore.forEach((r) => r());
  });
  afterEach(() => jest.restoreAllMocks());

  it('клиент публичного приёма — роль publisher_public: прочие колонки заявки и контакты ему недоступны (42501)', async () => {
    const pub = s.mod.get(PublisherPublicDb);
    const role = await pub.$queryRaw<
      Array<{ ok: boolean }>
    >`SELECT pg_has_role(current_user, 'publisher_public', 'MEMBER') AS "ok"`;
    expect(role[0].ok).toBe(true);
    for (const sql of [
      'SELECT "status" FROM "sites"."pub_leads" LIMIT 1',
      'SELECT "contactEnc" FROM "sites"."pub_lead_contacts" LIMIT 1',
      'SELECT "id" FROM "sites"."pub_events" LIMIT 1',
      'SELECT "id" FROM "sites"."pub_products" LIMIT 1',
      'UPDATE "sites"."pub_leads" SET "status" = \'won\' WHERE false',
      'DELETE FROM "sites"."pub_rate_hits" WHERE false',
    ]) {
      let code: string | undefined;
      try {
        await pub.$executeRawUnsafe(sql);
      } catch (e) {
        code = pgCodeOf(e);
      }
      expect({ sql, code }).toEqual({ sql, code: '42501' });
    }
  });

  it('S3-9: requestHash меняется только вместе с удалением контакта (триггер, миграция publisher_leads_fn)', async () => {
    const lead = await submit();
    let code: string | undefined;
    try {
      await s.prisma.$executeRaw`
        UPDATE "sites"."pub_leads" SET "requestHash" = ${'a'.repeat(64)}
         WHERE "id" = ${lead.id}`;
    } catch (e) {
      code = pgCodeOf(e);
    }
    expect(code).toBe('23514');
    await s.prisma.$executeRaw`
      UPDATE "sites"."pub_leads" SET "requestHash" = ${'b'.repeat(64)}, "erasedAt" = now()
       WHERE "id" = ${lead.id}`;
    code = undefined;
    try {
      await s.prisma.$executeRaw`
        UPDATE "sites"."pub_leads" SET "requestHash" = ${'c'.repeat(64)}
         WHERE "id" = ${lead.id}`;
    } catch (e) {
      code = pgCodeOf(e);
    }
    expect(code).toBe('23514');
  });

  it('обогащение идемпотентно: два прохода и открытие карточки — один проспект, одна связь, уведомления по одному на получателя', async () => {
    const lead = await submit();
    const enrich = s.mod.get(LeadEnrichService);
    await enrich.enrichNow(w.product, lead.id);
    await enrich.enrichNow(w.product, lead.id);
    await s.mod.get(LeadEnrichJob).run(ctx());
    expect(
      await s.prisma.pubLeadProspectLink.count({ where: { leadId: lead.id } }),
    ).toBe(1);
    const n = await s.prisma.pubNotification.count({
      where: { leadId: lead.id, kind: 'new_lead' },
    });
    expect(n).toBe(2); // sales + product_owner (TD-02)
    expect(
      (
        await s.prisma.pubLeadOutbox.findFirstOrThrow({
          where: { leadId: lead.id },
        })
      ).status,
    ).toBe('done');
  });

  it('S1-1: параллельное обогащение двух заявок одного человека — один проспект, вторая связь intake_exact_match', async () => {
    const p = syntheticPerson();
    const a = await submit({ contact: p.email, task: `${p.task} — перша` });
    const b = await submit({ contact: p.email, task: `${p.task} — друга` });
    // Создание проспекта нарочно медленное: без сериализации по matchHash
    // обе транзакции успевают не увидеть проспект друг друга.
    const prospects = s.mod.get(ProspectsService);
    const create = prospects.create.bind(prospects);
    jest
      .spyOn(prospects, 'create')
      .mockImplementation(async (...args: Parameters<typeof create>) => {
        await new Promise((r) => setTimeout(r, 400));
        return create(...args);
      });
    const enrich = s.mod.get(LeadEnrichService);
    await Promise.all([
      enrich.enrichNow(w.product, a.id),
      enrich.enrichNow(w.product, b.id),
    ]);
    const leads = await s.prisma.pubLead.findMany({
      where: { id: { in: [a.id, b.id] } },
      select: { prospectId: true },
    });
    expect(new Set(leads.map((l) => l.prospectId)).size).toBe(1);
    expect(leads[0].prospectId).toBeTruthy();
    const links = await s.prisma.pubLeadProspectLink.findMany({
      where: { leadId: { in: [a.id, b.id] } },
      select: { reason: true },
    });
    expect(links.map((l) => l.reason).sort()).toEqual([
      'intake_exact_match',
      'new',
    ]);
  });

  it('открытие карточки до обогащения обогащает вне очереди (LeadEnrichPort)', async () => {
    const lead = await submit();
    expect(lead.enrichedAt).toBeNull();
    const card = await request(srv())
      .get(`/publisher/products/${w.product.id}/leads/${lead.id}`)
      .set(sa());
    expect(card.status).toBe(200);
    expect(card.body.data).toMatchObject({
      enriched: true,
      prospectCode: expect.stringMatching(/^P-\d{4}$/),
    });
    expect(card.body.data.contactDueAt).toBeTruthy();
  });

  it('сбой обогащения: outbox failed с кодом (без текста), заявка цела; через 5 мин — повтор и done', async () => {
    const lead = await submit();
    const spy = jest
      .spyOn(LeadEnrichService.prototype, 'enrichInTx')
      .mockRejectedValueOnce(
        Object.assign(new Error('секрет +380671234567'), { code: 'E_TEST' }),
      );
    const r = await s.mod.get(LeadEnrichJob).run(ctx());
    expect(r.details?.leadsFailed).toBeGreaterThanOrEqual(1);
    spy.mockRestore();
    const ob = await s.prisma.pubLeadOutbox.findFirstOrThrow({
      where: { leadId: lead.id },
    });
    expect(ob).toMatchObject({
      status: 'failed',
      lastErrorCode: 'E_TEST',
      attempts: 1,
    });
    expect(await s.prisma.pubLead.count({ where: { id: lead.id } })).toBe(1);
    // Раньше 5 минут не повторяется; позже — повтор.
    await s.mod.get(LeadEnrichJob).run(ctx());
    expect(
      (
        await s.prisma.pubLeadOutbox.findFirstOrThrow({
          where: { leadId: lead.id },
        })
      ).status,
    ).toBe('failed');
    await s.mod
      .get(LeadEnrichJob)
      .run(ctx(new Date(Date.now() + 6 * 60 * 1000)));
    expect(
      (
        await s.prisma.pubLeadOutbox.findFirstOrThrow({
          where: { leadId: lead.id },
        })
      ).status,
    ).toBe('done');
  });

  it('основание хранения менеджера обогащение не перетирает', async () => {
    const lead = await submit();
    const next = new Date(Date.now() + 20 * 86_400_000);
    await s.prisma.pubLead.update({
      where: { id: lead.id },
      data: { retentionBasis: 'Ручне рішення', reviewDueAt: next },
    });
    await s.mod.get(LeadEnrichService).enrichNow(w.product, lead.id);
    const after = await s.prisma.pubLead.findFirstOrThrow({
      where: { id: lead.id },
    });
    expect(after.reviewDueAt.toISOString()).toBe(next.toISOString());
  });

  it('удаление участника: его открытые заявки — владельцу кабинета, неотправленные уведомления — dead', async () => {
    const lead = await submit();
    await s.mod.get(LeadEnrichService).enrichNow(w.product, lead.id);
    await s.prisma.pubLead.update({
      where: { id: lead.id },
      data: { responsibleMemberId: team.sales.memberId },
    });
    const n = await s.mod
      .get(LeadsMemberReassign)
      .reassign(
        s.prisma as never,
        w.product,
        team.sales.memberId,
        w.account.owner.memberId,
        'system:member-removed',
      );
    expect(n).toBeGreaterThanOrEqual(1);
    const after = await s.prisma.pubLead.findFirstOrThrow({
      where: { id: lead.id },
    });
    expect(after.responsibleMemberId).toBe(w.account.owner.memberId);
    const dead = await s.prisma.pubNotification.findMany({
      where: { leadId: lead.id, recipientMemberId: team.sales.memberId },
    });
    expect(
      dead.every(
        (d) => d.status === 'dead' && d.lastErrorCode === 'recipient_removed',
      ),
    ).toBe(true);
  });

  it('слияние проспектов и разделение: новые строки истории, прежние остаются; повторное слияние — 400', async () => {
    const a = await submit({ contact: syntheticPerson().email });
    const b = await submit({ contact: syntheticPerson().email });
    const enrich = s.mod.get(LeadEnrichService);
    await enrich.enrichNow(w.product, a.id);
    await enrich.enrichNow(w.product, b.id);
    const pa = (
      await s.prisma.pubLead.findFirstOrThrow({ where: { id: a.id } })
    ).prospectId as string;
    const pb = (
      await s.prisma.pubLead.findFirstOrThrow({ where: { id: b.id } })
    ).prospectId as string;
    expect(pa).not.toBe(pb);
    const m = await request(srv())
      .post(`/publisher/products/${w.product.id}/prospects/merge`)
      .set(sa())
      .send({
        opKey: randomUUID(),
        fromId: pb,
        intoId: pa,
        reason: 'Одна компанія, два менеджери',
      });
    expect(m.status).toBe(200);
    expect(m.body.data.leadIds.sort()).toEqual([a.id, b.id].sort());
    const links = await s.prisma.pubLeadProspectLink.findMany({
      where: { leadId: b.id },
      orderBy: { validFrom: 'asc' },
    });
    expect(links.map((l) => [l.prospectId, l.reason])).toEqual([
      [pb, 'new'],
      [pa, 'manual_merge'],
    ]);
    expect(
      (await s.prisma.pubProspect.findFirstOrThrow({ where: { id: pb } }))
        .mergedIntoId,
    ).toBe(pa);
    const again = await request(srv())
      .post(`/publisher/products/${w.product.id}/prospects/merge`)
      .set(sa())
      .send({
        opKey: randomUUID(),
        fromId: pb,
        intoId: pa,
        reason: 'Повтор злиття',
      });
    expect(again.status).toBe(400);
    // Разделение: заявка b — в новый проспект.
    const card = await request(srv())
      .get(`/publisher/products/${w.product.id}/leads/${b.id}`)
      .set(sa());
    const split = await request(srv())
      .post(`/publisher/products/${w.product.id}/leads/${b.id}/prospect`)
      .set(sa())
      .send({
        opKey: randomUUID(),
        prospectId: 'new',
        reason: 'Помилкове злиття',
        expectedRevision: card.body.data.revision,
      });
    expect(split.status).toBe(200);
    expect(split.body.data.prospectId).not.toBe(pa);
    expect(
      split.body.data.prospectLinks.map((l: { reason: string }) => l.reason),
    ).toEqual(['new', 'manual_merge', 'manual_split']);
  });

  it('назначение ответственного — только участнику с правом вести заявки; аналитик — 400 no_lead_access', async () => {
    const lead = await submit();
    const bad = await request(srv())
      .post(`/publisher/products/${w.product.id}/leads/${lead.id}/assign`)
      .set(sa())
      .send({
        opKey: randomUUID(),
        responsibleMemberId: team.analyst.memberId,
        expectedRevision: lead.revision,
      });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields).toEqual([
      { field: 'responsibleMemberId', code: 'no_lead_access' },
    ]);
    const ok = await request(srv())
      .post(`/publisher/products/${w.product.id}/leads/${lead.id}/assign`)
      .set(sa())
      .send({
        opKey: randomUUID(),
        responsibleMemberId: team.sales.memberId,
        expectedRevision: lead.revision,
      });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      responsibleMemberId: team.sales.memberId,
      responsibleDisplayName: expect.stringMatching(/^Учасник …/),
    });
  });
});
