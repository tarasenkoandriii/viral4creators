/**
 * AT-CORE-05 (P-D, проектный документ §6.5, §15.1–15.2; ТЗ §20): заявка
 * сохраняется при сбое уведомления; уведомление `failed` видно в очереди;
 * повтор уведомления не создаёт второй заявки; заявка видна в очереди
 * кабинета независимо от доставки; ежедневная отметка «очередь проверена»
 * (`pub_queue_checks`) — от уведомлений не зависит. Текст уведомления — без
 * контактов (номер и ссылка). Тестовый продукт реальным людям не пишет
 * (`suppressed`).
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
  BotNotifyTransport,
  ContactOverdueJob,
  NOTIFY_MAX_ATTEMPTS,
  NotificationsDeliverJob,
  type NotifyMessage,
} from '../../modules/publisher/leads/notifications.service';
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
} from '../../modules/publisher/leads/testing/leads-fixtures.testing';
import {
  seedMembers,
  type SeededMembers,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-CORE-05] Уведомление менеджеру недоступно — заявка не теряется',
  () => {
    let s: CoreStack;
    let w: IntakeWorld;
    let team: SeededMembers;
    let restore: Array<() => void>;
    const srv = () => s.app!.getHttpServer();
    const ctx = (siteId: string, now = new Date()) => ({
      now,
      scope: { siteIds: [siteId] },
      deadline: new Date(Date.now() + 30_000),
    });

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

    it('бот бросает → заявка, событие успеха и outbox сохранены, уведомления failed; заявка в очереди; повтор → sent без второй заявки', async () => {
      const person = syntheticPerson();
      const body = leadBody(w.product.publicKey, {
        name: person.name,
        contact: person.email,
        task: person.task,
      });
      const sentTexts: NotifyMessage[] = [];
      const send = jest
        .spyOn(BotNotifyTransport.prototype, 'send')
        .mockImplementation(async (m: NotifyMessage) => {
          sentTexts.push(m);
          throw new Error('Telegram недоступен');
        });
      const res = await postLead(s, body, { origin: w.origin, ip: randomIp() });
      expect(res.status).toBe(201);
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });

      const enrich = await s.mod.get(LeadEnrichJob).run(ctx(w.account.siteId));
      expect(enrich.details).toMatchObject({
        leadsEnriched: 1,
        leadsFailed: 0,
      });
      const outbox = await s.prisma.pubLeadOutbox.findFirstOrThrow({
        where: { leadId: lead.id },
      });
      expect(outbox.status).toBe('done');
      const created = await s.prisma.pubNotification.findMany({
        where: { leadId: lead.id },
      });
      // Получатели — активные sales и product_owner (TD-02).
      expect(created.map((n) => n.recipientMemberId).sort()).toEqual(
        [team.sales.memberId, team.product_owner.memberId].sort(),
      );
      expect(
        created.every((n) => n.status === 'pending' && n.kind === 'new_lead'),
      ).toBe(true);

      const deliver = await s.mod
        .get(NotificationsDeliverJob)
        .run(ctx(w.account.siteId));
      expect(deliver.details).toMatchObject({ sent: 0, failed: 2 });
      expect(send).toHaveBeenCalledTimes(2);
      const failed = await s.prisma.pubNotification.findMany({
        where: { leadId: lead.id },
      });
      expect(
        failed.every((n) => n.status === 'failed' && n.attempts === 1),
      ).toBe(true);
      expect(failed[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      // Текст без контактов: номер обращения и ссылка в кабинет.
      for (const m of sentTexts) {
        expect(m.text).toContain(lead.publicRef);
        for (const v of [person.name, person.email, person.task])
          expect(m.text).not.toContain(v);
        expect(m.button.hashPath).toBe(
          `/sites/${w.account.siteId}/publisher/leads/${lead.id}`,
        );
      }
      // Заявка и событие успеха на месте, заявка видна в очереди кабинета.
      expect(
        await s.prisma.pubLead.count({
          where: { submissionKey: body.submissionKey },
        }),
      ).toBe(1);
      expect(
        await s.prisma.pubEvent.count({
          where: { leadId: lead.id, name: 'lead_submit_success' },
        }),
      ).toBe(1);
      const queue = await request(srv())
        .get(`/publisher/products/${w.product.id}/leads`)
        .set(asMember(team.sales.telegramId, w.account.accountId));
      expect(queue.status).toBe(200);
      expect(queue.body.data.items.map((i: { id: string }) => i.id)).toContain(
        lead.id,
      );
      const list = await request(srv())
        .get(`/publisher/products/${w.product.id}/notifications`)
        .query({ status: 'failed' })
        .set(asMember(team.sales.telegramId, w.account.accountId));
      expect(list.status).toBe(200);
      expect(
        list.body.data.items.filter(
          (n: { leadId: string }) => n.leadId === lead.id,
        ),
      ).toHaveLength(2);

      // Повтор: строка → pending; бот снова доступен → sent. Заявка одна.
      send.mockImplementation(async () => 'sent');
      for (const n of failed) {
        const r = await request(srv())
          .post(
            `/publisher/products/${w.product.id}/notifications/${n.id}/retry`,
          )
          .set(asMember(team.sales.telegramId, w.account.accountId))
          .send({ opKey: randomUUID() });
        expect(r.status).toBe(200);
        expect(r.body.data.status).toBe('pending');
      }
      const again = await s.mod
        .get(NotificationsDeliverJob)
        .run(ctx(w.account.siteId));
      expect(again.details).toMatchObject({ sent: 2 });
      const sent = await s.prisma.pubNotification.findMany({
        where: { leadId: lead.id },
      });
      expect(sent.every((n) => n.status === 'sent' && n.sentAt)).toBe(true);
      expect(
        await s.prisma.pubLead.count({
          where: { productId: w.product.id, submissionKey: body.submissionKey },
        }),
      ).toBe(1);
      // Аудит повтора — без контактов.
      const audit = await s.prisma.pubAuditEvent.findMany({
        where: { productId: w.product.id, action: 'retry' },
      });
      expect(audit.length).toBeGreaterThanOrEqual(2);
    });

    it(`после ${NOTIFY_MAX_ATTEMPTS} неудач — dead (видно в очереди), заявка не трогается`, async () => {
      jest
        .spyOn(BotNotifyTransport.prototype, 'send')
        .mockResolvedValue('failed');
      const body = leadBody(w.product.publicKey);
      expect(
        (await postLead(s, body, { origin: w.origin, ip: randomIp() })).status,
      ).toBe(201);
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      await s.mod.get(LeadEnrichJob).run(ctx(w.account.siteId));
      await s.prisma.pubNotification.updateMany({
        where: { leadId: lead.id },
        data: {
          attempts: NOTIFY_MAX_ATTEMPTS - 1,
          status: 'failed',
          nextAttemptAt: new Date(Date.now() - 1000),
        },
      });
      await s.mod.get(NotificationsDeliverJob).run(ctx(w.account.siteId));
      const rows = await s.prisma.pubNotification.findMany({
        where: { leadId: lead.id },
      });
      expect(
        rows.every((n) => n.status === 'dead' && n.lastErrorCode === 'failed'),
      ).toBe(true);
      const fresh = await s.prisma.pubLead.findFirstOrThrow({
        where: { id: lead.id },
      });
      expect(fresh.status).toBe('new');
    });

    it('просрочен первый контакт → уведомление contact_overdue один раз; срок — конец следующего рабочего дня Kyiv', async () => {
      jest
        .spyOn(BotNotifyTransport.prototype, 'send')
        .mockResolvedValue('sent');
      const body = leadBody(w.product.publicKey);
      expect(
        (await postLead(s, body, { origin: w.origin, ip: randomIp() })).status,
      ).toBe(201);
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      await s.mod.get(LeadEnrichJob).run(ctx(w.account.siteId));
      const enriched = await s.prisma.pubLead.findFirstOrThrow({
        where: { id: lead.id },
      });
      expect(enriched.contactDueAt).not.toBeNull();
      expect(enriched.contactDueAt!.getTime()).toBeGreaterThan(
        enriched.receivedAt.getTime(),
      );
      const later = new Date(enriched.contactDueAt!.getTime() + 60_000);
      const overdueOf = () =>
        s.prisma.pubNotification.count({
          where: { leadId: lead.id, kind: 'contact_overdue' },
        });
      // До срока — ничего.
      await s.mod
        .get(ContactOverdueJob)
        .run(
          ctx(
            w.account.siteId,
            new Date(enriched.contactDueAt!.getTime() - 60_000),
          ),
        );
      expect(await overdueOf()).toBe(0);
      await s.mod.get(ContactOverdueJob).run(ctx(w.account.siteId, later));
      expect(await overdueOf()).toBe(2);
      const r2 = await s.mod
        .get(ContactOverdueJob)
        .run(ctx(w.account.siteId, later));
      expect(r2.details).toMatchObject({ overdueLeads: 0 });
      expect(await overdueOf()).toBe(2);
      const card = await request(srv())
        .get(`/publisher/products/${w.product.id}/leads/${lead.id}`)
        .set(asMember(team.sales.telegramId, w.account.accountId));
      expect(card.body.data.overdue).toBe(false); // «сейчас» ещё до срока
    });

    it('отметка «очередь проверена сегодня» — от уведомлений не зависит; повтор в тот же день — та же отметка; пропущенные дни видны', async () => {
      const as = asMember(team.sales.telegramId, w.account.accountId);
      const a = await request(srv())
        .post(`/publisher/products/${w.product.id}/queue-checks`)
        .set(as)
        .send({ opKey: randomUUID() });
      expect(a.status).toBe(201);
      expect(a.body.data.openCount).toBeGreaterThanOrEqual(1);
      const b = await request(srv())
        .post(`/publisher/products/${w.product.id}/queue-checks`)
        .set(as)
        .send({ opKey: randomUUID() });
      expect(b.status).toBe(200);
      expect(b.body.data.id).toBe(a.body.data.id);
      const list = await request(srv())
        .get(`/publisher/products/${w.product.id}/queue-checks`)
        .set(as);
      expect(list.status).toBe(200);
      expect(list.body.data.items.map((i: { id: string }) => i.id)).toContain(
        a.body.data.id,
      );
      expect(list.body.data.missingWorkDates).not.toContain(
        a.body.data.workDate,
      );
      // Аналитик отметку не ставит (матрица: PO, SA).
      const an = await request(srv())
        .post(`/publisher/products/${w.product.id}/queue-checks`)
        .set(asMember(team.analyst.telegramId, w.account.accountId))
        .send({ opKey: randomUUID() });
      expect(an.status).toBe(403);
    });

    it('тестовый продукт: уведомления создаются suppressed и не отправляются', async () => {
      const send = jest
        .spyOn(BotNotifyTransport.prototype, 'send')
        .mockResolvedValue('sent');
      const t = await intakeProduct(s, { kind: 'test' });
      const body = leadBody(t.product.publicKey);
      expect(
        (await postLead(s, body, { origin: t.origin, ip: randomIp() })).status,
      ).toBe(201);
      await s.mod.get(LeadEnrichJob).run(ctx(t.account.siteId));
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      const rows = await s.prisma.pubNotification.findMany({
        where: { leadId: lead.id },
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((n) => n.status === 'suppressed')).toBe(true);
      await s.mod.get(NotificationsDeliverJob).run(ctx(t.account.siteId));
      expect(send).not.toHaveBeenCalled();
    });

    it('S3-3: роль отозвана после постановки в очередь — отозванным не отправляется (dead recipient_revoked), уведомление уходит текущему получателю', async () => {
      const chats: string[] = [];
      jest
        .spyOn(BotNotifyTransport.prototype, 'send')
        .mockImplementation(async (m: NotifyMessage) => {
          chats.push(m.chatId.toString());
          return 'sent';
        });
      const w2 = await intakeProduct(s, { kind: 'working' });
      const team2 = await seedMembers(s.prisma, w2.product, w2.account.owner);
      const body = leadBody(w2.product.publicKey);
      expect(
        (await postLead(s, body, { origin: w2.origin, ip: randomIp() })).status,
      ).toBe(201);
      await s.mod.get(LeadEnrichJob).run(ctx(w2.account.siteId));
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      // Обе роли-получатели отозваны: адресат — владелец кабинета.
      await s.prisma.pubRoleGrant.updateMany({
        where: {
          productId: w2.product.id,
          memberId: {
            in: [team2.sales.memberId, team2.product_owner.memberId],
          },
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          revokedBy: `member:${w2.account.owner.memberId}`,
          reason: 'Доступ відкликано',
        },
      });
      await s.mod.get(NotificationsDeliverJob).run(ctx(w2.account.siteId));
      const rows = await s.prisma.pubNotification.findMany({
        where: { leadId: lead.id },
      });
      const by = new Map(rows.map((n) => [n.recipientMemberId, n]));
      for (const m of [team2.sales.memberId, team2.product_owner.memberId]) {
        expect(by.get(m)).toMatchObject({
          status: 'dead',
          lastErrorCode: 'recipient_revoked',
        });
      }
      expect(by.get(w2.account.owner.memberId)?.status).toBe('pending');
      await s.mod.get(NotificationsDeliverJob).run(ctx(w2.account.siteId));
      expect(chats).toEqual([w2.account.owner.telegramId.toString()]);
      expect(
        (
          await s.prisma.pubNotification.findFirstOrThrow({
            where: {
              leadId: lead.id,
              recipientMemberId: w2.account.owner.memberId,
            },
          })
        ).status,
      ).toBe('sent');
    });
  },
);
