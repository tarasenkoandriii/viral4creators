/**
 * AT-CORE-09, ретенция (P-D, проектный документ §15.3, §9.1; ТЗ §21):
 * закрытая заявка — пересмотр через 90 дней после `closedAt`; удаление —
 * контакт и шифрованные заметки стёрты из активного реестра и выгрузок,
 * остаётся обезличенная запись `pub_erasures`; открытая — дата пересмотра
 * не позже t72 (если t72 впереди) и затем каждые 90 дней с основанием;
 * задания `retention-review` (задача и уведомление ответственному) и
 * `form-after-t72` (задача владельцу за 7 дней до t72).
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
import {
  addKyivCalendarDays,
  pilotMilestones,
  reviewDueForOpen,
} from '../../modules/publisher/core/kyiv-time';
import { LeadEnrichJob } from '../../modules/publisher/leads/lead-enrich.job';
import { erasedRequestHash } from '../../modules/publisher/leads/leads.service';
import {
  FormAfterT72Job,
  RETENTION_BATCH,
  RetentionReviewJob,
} from '../../modules/publisher/leads/retention.jobs';
import {
  decideParam,
  intakeProduct,
  leadBody,
  leadsStack,
  postLead,
  randomIp,
  syntheticPerson,
  trustLocalProxy,
  useTestSecrets,
  type IntakeWorld,
} from '../../modules/publisher/leads/testing/leads-fixtures.testing';
import {
  seedMembers,
  type SeededMembers,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-CORE-09] Ретенция контакта заявки: пересмотр, удаление, основание хранения',
  () => {
    let s: CoreStack;
    let w: IntakeWorld;
    let team: SeededMembers;
    let owner: Client;
    let t72: Date;
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
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      await s.mod.get(LeadEnrichJob).run(ctx());
      return s.prisma.pubLead.findFirstOrThrow({ where: { id: lead.id } });
    };
    const op = (path: string, body: Record<string, unknown>, as = sa()) =>
      request(srv())
        .post(`/publisher/products/${w.product.id}${path}`)
        .set(as)
        .send({ opKey: randomUUID(), ...body });

    beforeAll(async () => {
      restore = [useTestSecrets(), trustLocalProxy()];
      s = await leadsStack({ http: true });
      w = await intakeProduct(s, { kind: 'working' });
      team = await seedMembers(s.prisma, w.product, w.account.owner);
      owner = await connectOwner();
      // Пилот: t0 — 10 дней назад, t72 — через 62 дня.
      const m = pilotMilestones(addKyivCalendarDays(new Date(), -10));
      t72 = m.t72;
      await new PubDb(owner).experiment(
        {
          accountId: w.account.accountId,
          siteId: w.account.siteId,
          productId: w.product.id,
        },
        { t0: m.t0, t42: m.t42, t72: m.t72, t90: m.t90 },
      );
    });
    afterAll(async () => {
      await owner.end();
      await s.close();
      restore.forEach((r) => r());
    });

    it('открытая заявка: при приёме +90 дней, после обогащения — не позже t72 (t72 впереди)', async () => {
      const lead = await submit();
      expect(lead.reviewDueAt.toISOString()).toBe(
        reviewDueForOpen(lead.receivedAt, t72, null).toISOString(),
      );
      expect(lead.reviewDueAt.getTime()).toBeLessThanOrEqual(t72.getTime());
    });

    it('закрытая (отклонённая) заявка: пересмотр = closedAt + 90 календарных дней Kyiv', async () => {
      const lead = await submit();
      const r = await op(`/leads/${lead.id}/transition`, {
        to: 'rejected',
        reasonCode: 'out_of_scope',
        expectedRevision: lead.revision,
      });
      expect(r.status).toBe(200);
      const closedAt = new Date(r.body.data.closedAt);
      expect(r.body.data.reviewDueAt).toBe(
        addKyivCalendarDays(closedAt, 90).toISOString(),
      );
    });

    it('удаление: контакт и заметки стёрты, раскрытие → 404, обезличенная запись pub_erasures; очередь и CSV без контакта', async () => {
      const p = syntheticPerson();
      const lead = await submit({
        name: p.name,
        contact: p.email,
        task: p.task,
        business: p.business,
      });
      const q = await op(`/leads/${lead.id}/transition`, {
        to: 'rejected',
        reasonCode: 'unreachable',
        note: p.note,
        expectedRevision: lead.revision,
      });
      expect(q.status).toBe(200);
      const prospectId = q.body.data.prospectId as string;
      const upd = await request(srv())
        .patch(`/publisher/products/${w.product.id}/prospects/${prospectId}`)
        .set(sa())
        .send({ opKey: randomUUID(), note: p.note, expectedRevision: 1 });
      expect(upd.status).toBe(200);
      // До удаления контакт раскрывается.
      expect(
        (
          await request(srv())
            .post(
              `/publisher/products/${w.product.id}/leads/${lead.id}/contact`,
            )
            .send({ purpose: 'retention' })
            .set(sa())
        ).status,
      ).toBe(200);
      const erase = await op(`/leads/${lead.id}/erase`, {
        basis: 'Строк зберігання минув, підстав немає',
        expectedRevision: q.body.data.revision,
      });
      expect(erase.status).toBe(200);
      expect(erase.body.data).toMatchObject({ erased: true });
      // S3-9: HMAC тела (имя, контакт, задача) заменён обезличенным.
      const erasedRow = await s.prisma.pubLead.findFirstOrThrow({
        where: { id: lead.id },
      });
      expect(erasedRow.requestHash).not.toBe(lead.requestHash);
      expect(erasedRow.requestHash).toBe(erasedRequestHash(lead.id));
      expect(
        await s.prisma.pubLeadContact.count({ where: { leadId: lead.id } }),
      ).toBe(0);
      const notes = await s.prisma.pubLeadDecision.findMany({
        where: { leadId: lead.id },
        select: { noteEnc: true },
      });
      expect(notes.every((n) => n.noteEnc === null)).toBe(true);
      const pr = await s.prisma.pubProspect.findFirstOrThrow({
        where: { id: prospectId },
      });
      expect(pr.noteEnc).toBeNull();
      const er = await s.prisma.pubErasure.findFirstOrThrow({
        where: { leadId: lead.id },
      });
      expect(er).toMatchObject({
        erasedBy: `member:${team.sales.memberId}`,
        basis: 'Строк зберігання минув, підстав немає',
      });
      expect(er.scope).toMatchObject({
        active: true,
        exports: true,
        protectedRows: 1,
        decisionNotes: 1,
        prospectNote: true,
      });
      const erJson = JSON.stringify(er);
      for (const v of [p.name, p.email, p.task, p.business, p.note])
        expect(erJson).not.toContain(v);
      const reveal = await request(srv())
        .post(`/publisher/products/${w.product.id}/leads/${lead.id}/contact`)
        .send({ purpose: 'retention' })
        .set(sa());
      expect(reveal.status).toBe(404);
      const csv = await request(srv())
        .get(`/publisher/products/${w.product.id}/leads`)
        .query({ format: 'csv' })
        .set(sa());
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text).toContain(lead.publicRef);
      for (const v of [p.name, p.email, p.task, p.business])
        expect(csv.text).not.toContain(v);
      // Повторное удаление — 400 already_erased.
      const again = await op(`/leads/${lead.id}/erase`, {
        basis: 'Повторно',
        expectedRevision: erase.body.data.revision,
      });
      expect(again.status).toBe(400);
    });

    it('хранить дальше — только с основанием и датой не дальше 90 дней; основание с контактом — 400', async () => {
      const lead = await submit();
      const far = addKyivCalendarDays(new Date(), 120).toISOString();
      expect(
        (
          await op(`/leads/${lead.id}/retention`, {
            basis: 'Триває переговори',
            nextReviewAt: far,
            expectedRevision: lead.revision,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await op(`/leads/${lead.id}/retention`, {
            basis: 'Клієнт просив писати на a@b.co',
            nextReviewAt: addKyivCalendarDays(new Date(), 30).toISOString(),
            expectedRevision: lead.revision,
          })
        ).status,
      ).toBe(400);
      const next = addKyivCalendarDays(new Date(), 60).toISOString();
      const ok = await op(`/leads/${lead.id}/retention`, {
        basis: 'Триває узгодження договору',
        nextReviewAt: next,
        expectedRevision: lead.revision,
      });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({
        reviewDueAt: next,
        retentionBasis: 'Триває узгодження договору',
      });
      // Аналитик ретенцией не распоряжается.
      const an = await op(
        `/leads/${lead.id}/retention`,
        {
          basis: 'Спроба',
          nextReviewAt: next,
          expectedRevision: ok.body.data.revision,
        },
        asMember(team.analyst.telegramId, w.account.accountId),
      );
      expect(an.status).toBe(403);
    });

    it('retention-review: наступил срок → задача retention_review ответственному и уведомление; повтор задач не плодит', async () => {
      const lead = await submit();
      const asg = await op(`/leads/${lead.id}/assign`, {
        responsibleMemberId: team.sales.memberId,
        expectedRevision: lead.revision,
      });
      expect(asg.status).toBe(200);
      await s.prisma.pubLead.update({
        where: { id: lead.id },
        data: { reviewDueAt: new Date(Date.now() - 1000) },
      });
      await s.mod.get(RetentionReviewJob).run(ctx());
      await s.mod.get(RetentionReviewJob).run(ctx());
      const tasks = await s.prisma.pubReviewTask.findMany({
        where: {
          productId: w.product.id,
          objectType: 'lead',
          objectId: lead.id,
          reason: 'retention_review',
        },
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].assigneeMemberId).toBe(team.sales.memberId);
      const notes = await s.prisma.pubNotification.findMany({
        where: { leadId: lead.id, kind: 'retention_review' },
      });
      expect(notes.map((n) => n.recipientMemberId)).toEqual([
        team.sales.memberId,
      ]);
      const due = await request(srv())
        .get(`/publisher/products/${w.product.id}/retention/due`)
        .set(sa());
      expect(due.status).toBe(200);
      expect(
        due.body.data.items.find(
          (i: { leadId: string }) => i.leadId === lead.id,
        ),
      ).toMatchObject({ overdue: true });
    });

    it('S3-8: retention-review не трогает удалённые заявки (ни задачи, ни уведомления)', async () => {
      const lead = await submit();
      const erase = await op(`/leads/${lead.id}/erase`, {
        basis: 'Заявник попросив видалити дані',
        expectedRevision: lead.revision,
      });
      expect(erase.status).toBe(200);
      await s.prisma.pubLead.update({
        where: { id: lead.id },
        data: { reviewDueAt: new Date(Date.now() - 1000) },
      });
      await s.mod.get(RetentionReviewJob).run(ctx());
      expect(
        await s.prisma.pubReviewTask.count({
          where: { objectType: 'lead', objectId: lead.id },
        }),
      ).toBe(0);
      expect(
        await s.prisma.pubNotification.count({
          where: { leadId: lead.id, kind: 'retention_review' },
        }),
      ).toBe(0);
    });

    it('S3-10: retention-review идёт партиями с курсором — все просроченные получают задачу за проход; повторный проход их не выбирает', async () => {
      const leads = [await submit(), await submit(), await submit()];
      for (const l of leads) {
        await s.prisma.pubLead.update({
          where: { id: l.id },
          data: { reviewDueAt: new Date(Date.now() - 5000) },
        });
      }
      const job = s.mod.get(RetentionReviewJob);
      job.batch = 1;
      try {
        await job.run(ctx());
        expect(
          await s.prisma.pubReviewTask.count({
            where: {
              objectType: 'lead',
              objectId: { in: leads.map((l) => l.id) },
              reason: 'retention_review',
            },
          }),
        ).toBe(3);
        const again = await job.run(ctx());
        expect(again.details).toMatchObject({ dueLeads: 0, tasks: 0 });
      } finally {
        job.batch = RETENTION_BATCH;
      }
    });

    it('form-after-t72: за 7 дней до t72 без ответственного за форму после t72 — задача владельцу; назначен — задачи нет', async () => {
      const before = new Date(t72.getTime() - 8 * 24 * 3600 * 1000);
      await s.mod.get(FormAfterT72Job).run(ctx(before));
      const none = await s.prisma.pubReviewTask.count({
        where: { productId: w.product.id, reason: 'form_after_t72' },
      });
      expect(none).toBe(0);
      const within = new Date(t72.getTime() - 6 * 24 * 3600 * 1000);
      await s.mod.get(FormAfterT72Job).run(ctx(within));
      await s.mod.get(FormAfterT72Job).run(ctx(within));
      const tasks = await s.prisma.pubReviewTask.findMany({
        where: { productId: w.product.id, reason: 'form_after_t72' },
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        objectType: 'product',
        objectId: w.product.id,
        severity: 'critical',
        assigneeMemberId: w.account.owner.memberId,
      });

      const other = await intakeProduct(s, { kind: 'working' });
      const m = pilotMilestones(addKyivCalendarDays(new Date(), -70));
      await new PubDb(owner).experiment(
        {
          accountId: other.account.accountId,
          siteId: other.account.siteId,
          productId: other.product.id,
        },
        { t0: m.t0, t42: m.t42, t72: m.t72, t90: m.t90 },
      );
      await decideParam(
        s,
        other.product,
        'responsibles',
        {
          formOwnerMemberId: other.account.owner.memberId,
          salesMemberIds: [other.account.owner.memberId],
          afterT72MemberId: other.account.owner.memberId,
        },
        'approved',
        other.account.owner.memberId,
      );
      await s.mod.get(FormAfterT72Job).run({
        now: new Date(),
        scope: { siteIds: [other.account.siteId] },
        deadline: new Date(Date.now() + 30_000),
      });
      expect(
        await s.prisma.pubReviewTask.count({
          where: { productId: other.product.id, reason: 'form_after_t72' },
        }),
      ).toBe(0);
    });
  },
);
