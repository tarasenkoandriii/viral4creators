/**
 * AT-CORE-09, сквозной поиск ПД в зоне P-D (проектный документ §1 п.7,
 * §17.1 «первым шагом раскрытие контакта и заметок, затем поиск
 * синтетического контакта во всех колонках всех pub_*, кроме
 * шифротекстов»; ТЗ §14, §21). Полный путь синтетического заявителя: метка
 * с email/телефоном в UTM → события сессии → форма → обогащение →
 * уведомления → переходы с заметкой → заметка проспекта → раскрытие
 * контакта и заметок → выгрузка CSV → оплата → ретенция. Затем:
 *  - сырой поиск имени, email, телефона (и его цифр), текста задачи,
 *    описания бизнеса, заметок и самоотчёта во ВСЕХ строках всех таблиц
 *    `pub_*` (включая `pub_idempotency_keys`, `pub_audit_events`, события,
 *    сессии, уведомления, outbox, окна лимита) — 0 совпадений;
 *  - те же значения в журналах процесса (stdout/stderr, Logger) — 0;
 *  - UTM с контактом → `[redacted]`.
 * Полный межпакетный поиск (все маршруты всех пакетов) — этап Z
 * (`z-pii-scan.spec`).
 */
import { ConsoleLogger, Logger } from '@nestjs/common';
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
  NotificationsDeliverJob,
  type NotifyMessage,
} from '../../modules/publisher/leads/notifications.service';
import {
  intakeProduct,
  leadBody,
  leadsStack,
  postEvent,
  postLead,
  randomIp,
  syntheticPerson,
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
  '[AT-CORE-09] Контакты не попали в аналитику, журналы и ключи: поиск синтетического контакта',
  () => {
    let s: CoreStack;
    let w: IntakeWorld;
    let team: SeededMembers;
    let restore: Array<() => void>;
    const logs: string[] = [];
    const srv = () => s.app!.getHttpServer();

    beforeAll(async () => {
      restore = [useTestSecrets(), trustLocalProxy()];
      s = await leadsStack({ http: true });
      w = await intakeProduct(s, { kind: 'working', analytics: 'session' });
      team = await seedMembers(s.prisma, w.product, w.account.owner);
      // После решений по параметрам — снова live с открытыми флагами.
      await s.prisma.$executeRaw`
      UPDATE "sites"."pub_products" SET "paramsPublicPublishOk" = true, "paramsRealLeadsOk" = true
       WHERE "id" = ${w.product.id}`;
    });
    afterAll(async () => {
      await s.close();
      restore.forEach((r) => r());
    });

    it('полный путь заявителя, затем сырой поиск по всем pub_* и журналам — синтетический контакт только в шифре', async () => {
      const p = syntheticPerson();
      const selfNote = `Самозвіт ${p.email}`;
      const phoneDigits = p.phone.replace(/\D/g, '');
      const needles = [
        p.name,
        p.email,
        p.phone,
        phoneDigits,
        phoneDigits.slice(-9),
        p.task,
        p.business,
        p.note,
        selfNote,
      ];
      const capture = (chunk: unknown) => {
        logs.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.isBuffer(chunk)
              ? chunk.toString('utf8')
              : String(chunk),
        );
      };
      const out = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation((c: unknown) => (capture(c), true));
      const err = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation((c: unknown) => (capture(c), true));
      const cons = (['log', 'warn', 'error', 'info', 'debug'] as const).map(
        (m) =>
          jest
            .spyOn(console, m)
            .mockImplementation((...a: unknown[]) =>
              capture(a.map(String).join(' ')),
            ),
      );
      // Стенд глушит журнал (`coreStack`): для поиска ПД журнал включается.
      Logger.overrideLogger(new ConsoleLogger());
      const sent: NotifyMessage[] = [];
      jest
        .spyOn(BotNotifyTransport.prototype, 'send')
        .mockImplementation(async (m: NotifyMessage) => {
          sent.push(m);
          return 'sent';
        });
      try {
        const sessionRef = testSessionRef();
        const ip = randomIp();
        // Посетитель пришёл по метке, где кто-то вписал контакт.
        const ev = await postEvent(
          s,
          {
            key: w.product.publicKey,
            eventId: randomUUID(),
            name: 'content_view',
            path: `/materials/demo?email=${encodeURIComponent(p.email)}`,
            contentSlug: 'demo-material',
            sessionRef,
            referrerHost: 'facebook.com',
            utm: {
              utm_source: p.email,
              utm_medium: 'social',
              utm_campaign: p.phone,
              utm_content: `t.me/${p.email.split('@')[0].replace(/[^a-z0-9]/g, '')}`,
            },
            consentState: 'not_required',
          },
          { origin: w.origin, ip },
        );
        expect(ev.status).toBe(202);
        expect(
          (
            await postEvent(
              s,
              {
                key: w.product.publicKey,
                eventId: randomUUID(),
                name: 'cta_click',
                sessionRef,
                path: '/contact',
                consentState: 'not_required',
              },
              { origin: w.origin, ip },
            )
          ).status,
        ).toBe(202);
        // Форма: контакт, имя, задача, бизнес, самоотчёт; в UTM формы — тоже контакт.
        const body = leadBody(w.product.publicKey, {
          name: p.name,
          contactMethod: 'email',
          contact: p.email,
          task: p.task,
          business: p.business,
          selfReported: { channel: 'social', note: selfNote },
          sessionRef,
          utm: { utm_source: p.phone },
        });
        const lr = await postLead(s, body, { origin: w.origin, ip });
        expect(lr.status).toBe(201);
        const lead = await s.prisma.pubLead.findFirstOrThrow({
          where: { submissionKey: body.submissionKey },
        });
        const cron = {
          now: new Date(),
          scope: { siteIds: [w.account.siteId] },
          deadline: new Date(Date.now() + 30_000),
        };
        await s.mod.get(LeadEnrichJob).run(cron);
        await s.mod.get(NotificationsDeliverJob).run(cron);
        expect(sent.length).toBeGreaterThan(0);

        const sa = asMember(team.sales.telegramId, w.account.accountId);
        let card = (
          await request(srv())
            .get(`/publisher/products/${w.product.id}/leads/${lead.id}`)
            .set(sa)
        ).body.data;
        // Переход с заметкой (в заметке — контакт: она шифруется).
        let r = await request(srv())
          .post(
            `/publisher/products/${w.product.id}/leads/${lead.id}/transition`,
          )
          .set(sa)
          .send({
            opKey: randomUUID(),
            to: 'contacted',
            note: `${p.note} ${p.phone}`,
            expectedRevision: card.revision,
          });
        expect(r.status).toBe(200);
        card = r.body.data;
        r = await request(srv())
          .post(
            `/publisher/products/${w.product.id}/leads/${lead.id}/transition`,
          )
          .set(sa)
          .send({
            opKey: randomUUID(),
            to: 'qualified',
            confirmedInterestAt: new Date().toISOString(),
            note: p.note,
            expectedRevision: card.revision,
          });
        expect(r.status).toBe(200);
        card = r.body.data;
        const pr = await request(srv())
          .patch(
            `/publisher/products/${w.product.id}/prospects/${card.prospectId}`,
          )
          .set(sa)
          .send({
            opKey: randomUUID(),
            note: `${p.name}: ${p.email}`,
            expectedRevision: 1,
          });
        expect(pr.status).toBe(200);
        // Свободный текст вне шифра с контактом — отказ.
        const bad = await request(srv())
          .post(
            `/publisher/products/${w.product.id}/leads/${lead.id}/test-flag`,
          )
          .set(sa)
          .send({
            opKey: randomUUID(),
            testFlag: true,
            reason: `Перевірка ${p.email}`,
            expectedRevision: card.revision,
          });
        expect(bad.status).toBe(400);
        // Оплата: подтверждение без контакта.
        const pay = await request(srv())
          .post(`/publisher/products/${w.product.id}/payments`)
          .set(sa)
          .send({
            opKey: randomUUID(),
            prospectId: card.prospectId,
            leadId: lead.id,
            recordType: 'payment_received',
            payerKind: 'external',
            amountMinor: '150000',
            currency: 'UAH',
            occurredAt: new Date().toISOString(),
            paymentRef: `INV-${randomUUID().slice(0, 8)}`,
          });
        expect(pay.status).toBe(201);
        // Раскрытие контакта и заметок (первым шагом поиска ПД, §17.1).
        const c = await request(srv())
          .post(`/publisher/products/${w.product.id}/leads/${lead.id}/contact`)
          .send({ purpose: 'first_contact' })
          .set(sa);
        expect(c.status).toBe(200);
        expect(c.body.data.contact).toBe(p.email);
        const n = await request(srv())
          .post(`/publisher/products/${w.product.id}/leads/${lead.id}/notes`)
          .send({})
          .set(sa);
        expect(n.status).toBe(200);
        expect(
          n.body.data.decisions.map((d: { note: string }) => d.note),
        ).toContain(p.note);
        const csv = await request(srv())
          .get(`/publisher/products/${w.product.id}/leads`)
          .query({ format: 'csv' })
          .set(sa);
        expect(csv.status).toBe(200);
        for (const v of needles) expect(csv.text).not.toContain(v);
        const ret = await request(srv())
          .post(
            `/publisher/products/${w.product.id}/leads/${lead.id}/retention`,
          )
          .set(sa)
          .send({
            opKey: randomUUID(),
            basis: 'Триває узгодження договору',
            nextReviewAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            expectedRevision: card.revision,
          });
        expect(ret.status).toBe(200);

        // UTM с контактом — redacted.
        const events = await s.prisma.pubEvent.findMany({
          where: { productId: w.product.id, sessionRef },
        });
        const viewRow = events.find((e) => e.name === 'content_view');
        expect(viewRow?.utm).toEqual({
          source: '[redacted]',
          medium: 'social',
          campaign: '[redacted]',
          content: '[redacted]',
        });
        expect(viewRow?.utmRedacted).toBe(true);
        const session = await s.prisma.pubSession.findFirstOrThrow({
          where: { productId: w.product.id, sessionRef },
        });
        expect(session.landingPath).toBe('/materials/demo');

        // Сырой поиск по всем строкам всех таблиц pub_*.
        const tables = await s.prisma.$queryRaw<Array<{ t: string }>>`
        SELECT tablename AS "t" FROM pg_tables WHERE schemaname = 'sites' AND tablename LIKE 'pub\\_%' ORDER BY 1`;
        expect(tables.length).toBeGreaterThanOrEqual(60);
        const hits: string[] = [];
        for (const { t } of tables) {
          const rows = await s.prisma.$queryRawUnsafe<Array<{ j: string }>>(
            `SELECT row_to_json(x)::text AS j FROM "sites"."${t}" x WHERE row_to_json(x)::text LIKE '%' || $1 || '%' OR row_to_json(x)::text LIKE '%' || $2 || '%'
              OR row_to_json(x)::text LIKE '%' || $3 || '%' OR row_to_json(x)::text LIKE '%' || $4 || '%' OR row_to_json(x)::text LIKE '%' || $5 || '%'
              OR row_to_json(x)::text LIKE '%' || $6 || '%' OR row_to_json(x)::text LIKE '%' || $7 || '%' OR row_to_json(x)::text LIKE '%' || $8 || '%'
              OR row_to_json(x)::text LIKE '%' || $9 || '%'`,
            ...needles.map((v) => JSON.stringify(v).slice(1, -1)),
          );
          for (const r2 of rows) hits.push(`${t}: ${r2.j.slice(0, 200)}`);
        }
        expect(hits).toEqual([]);
        // Шифротекст есть, и он расшифровывается в тот же контакт (см. раскрытие выше).
        const enc = await s.prisma.pubLeadContact.findFirstOrThrow({
          where: { leadId: lead.id },
        });
        expect(enc.contactEnc).toMatch(/^v1\./);
        // Текст уведомлений — без контакта.
        for (const m of sent)
          for (const v of needles) expect(m.text).not.toContain(v);
        // Сбой обогащения и отказ формы тоже пишутся в журнал — без данных.
        await postLead(
          s,
          leadBody(w.product.publicKey, {
            contact: p.email,
            contactMethod: 'phone',
          }),
          { origin: w.origin, ip },
        );
      } finally {
        Logger.overrideLogger(false);
        out.mockRestore();
        err.mockRestore();
        cons.forEach((c) => c.mockRestore());
      }
      const joined = logs.join('\n');
      // Журнал действительно писался (отказ формы — строка фильтра).
      expect(joined).toContain(
        '/public/publisher/v1/leads → 400 PUB_VALIDATION',
      );
      for (const v of needles)
        expect({ v, inLogs: joined.includes(v) }).toEqual({ v, inLogs: false });
    });
  },
);
