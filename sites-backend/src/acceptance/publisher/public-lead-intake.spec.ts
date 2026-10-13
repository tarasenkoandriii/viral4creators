/**
 * AT-CORE-03 (P-D, проектный документ §11.4, §18.1): неудачная отправка не
 * показывает успех и не создаёт события успеха; повтор после обрыва с тем
 * же ключом возвращает ту же заявку — даже после исчерпания лимита.
 * Минимальная запись под ролью `publisher_public`: заявка, шифротекст
 * контакта, событие `lead_submit_success`, строка исходящей очереди — в
 * одной транзакции; сбой до COMMIT не оставляет ничего (и удара лимита).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import type { CoreStack } from '../../modules/publisher/core/testing/core-stack.testing';
import { createHash } from 'crypto';
import { validateLeadBody } from '../../modules/publisher/contracts/lead-validation';
import {
  leadRequestHmac,
  publisherKeys,
} from '../../modules/publisher/core/contact-crypto';
import {
  LeadIntakeService,
  canonicalBodyJson,
  requestCanonical,
} from '../../modules/publisher/public/lead-intake';
import { TrafficPassportService } from '../../modules/publisher/leads/traffic-passport.service';
import {
  intakeProduct,
  leadBody,
  leadsStack,
  postLead,
  randomIp,
  trustLocalProxy,
  useTestSecrets,
  type IntakeWorld,
} from '../../modules/publisher/leads/testing/leads-fixtures.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-CORE-03] Неудачная отправка: нет успеха и нет события успеха без COMMIT',
  () => {
    let s: CoreStack;
    let w: IntakeWorld;
    let restoreSecrets: () => void;
    let restoreProxy: () => void;

    const counts = async (productId: string, submissionKey?: string) => {
      const leads = await s.prisma.pubLead.findMany({
        where: { productId, ...(submissionKey ? { submissionKey } : {}) },
        select: { id: true },
      });
      const ids = leads.map((l) => l.id);
      const [events, outbox, contacts, hits] = await Promise.all([
        s.prisma.pubEvent.count({
          where: {
            productId,
            name: 'lead_submit_success',
            ...(submissionKey ? { leadId: { in: ids } } : {}),
          },
        }),
        s.prisma.pubLeadOutbox.count({
          where: {
            productId,
            ...(submissionKey ? { leadId: { in: ids } } : {}),
          },
        }),
        s.prisma.pubLeadContact.count({
          where: {
            productId,
            ...(submissionKey ? { leadId: { in: ids } } : {}),
          },
        }),
        s.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS "n" FROM "sites"."pub_rate_hits" WHERE "key" LIKE ${`${productId}:form:%`}`,
      ]);
      return { leads: ids.length, events, outbox, contacts, hits: hits[0].n };
    };

    beforeAll(async () => {
      restoreSecrets = useTestSecrets();
      restoreProxy = trustLocalProxy();
      s = await leadsStack({ http: true });
      w = await intakeProduct(s, { kind: 'test' });
    });
    afterAll(async () => {
      await s.close();
      restoreProxy();
      restoreSecrets();
    });
    afterEach(() => jest.restoreAllMocks());

    it('успех — только после COMMIT: 201 {leadRef, receivedAt, eventId}; заявка, шифр контакта, событие успеха и outbox — вместе', async () => {
      const body = leadBody(w.product.publicKey);
      const res = await postLead(s, body, { origin: w.origin, ip: randomIp() });
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const data = res.body.data;
      expect(data.leadRef).toMatch(/^L-[A-Z2-7]{10}$/);
      expect(data.eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { productId: w.product.id, submissionKey: body.submissionKey },
      });
      expect(lead).toMatchObject({
        publicRef: data.leadRef,
        status: 'new',
        testFlag: true,
        testReason: 'test_product',
        createdBy: 'public',
        contactMethod: 'email',
      });
      expect(lead.requestHash).toMatch(/^[0-9a-f]{64}$/);
      // Контракт P-A1 (аудит P3-10): ключевой HMAC, не беcключевой sha256
      // тела (по дампу перебор телефонов не восстанавливает контакт).
      const v = validateLeadBody(body);
      if (!v.ok) throw new Error('тело теста невалидно');
      const keys = publisherKeys('contactMatch');
      expect(lead.requestHash).toBe(
        leadRequestHmac(w.product.id, requestCanonical(v.value), keys!),
      );
      expect(lead.requestHash).not.toBe(
        createHash('sha256').update(canonicalBodyJson(v.value)).digest('hex'),
      );
      const ev = await s.prisma.pubEvent.findFirstOrThrow({
        where: { leadId: lead.id },
      });
      expect(ev).toMatchObject({
        name: 'lead_submit_success',
        eventId: data.eventId,
        testFlag: true,
      });
      const contact = await s.prisma.pubLeadContact.findFirstOrThrow({
        where: { leadId: lead.id },
      });
      expect(contact.contactEnc).toMatch(/^v1\./);
      expect(contact.contactEnc).not.toContain(String(body.contact));
      const ob = await s.prisma.pubLeadOutbox.findFirstOrThrow({
        where: { leadId: lead.id },
      });
      expect(ob).toMatchObject({ kind: 'lead_received', status: 'pending' });
    });

    for (const step of ['lead', 'contact', 'event', 'outbox'] as const) {
      it(`сбой на шаге «${step}» до COMMIT → 500, ни заявки, ни события успеха, ни удара лимита; повтор тем же ключом → 201`, async () => {
        const ip = randomIp();
        const body = leadBody(w.product.publicKey);
        const before = await counts(w.product.id);
        const spy = jest
          .spyOn(
            LeadIntakeService.prototype as unknown as {
              afterStep(s: string): Promise<void>;
            },
            'afterStep',
          )
          .mockImplementation(async (st: string) => {
            if (st === step) throw new Error(`имитация сбоя на шаге ${st}`);
          });
        const failed = await postLead(s, body, { origin: w.origin, ip });
        expect(failed.status).toBe(500);
        expect(failed.body.success).toBe(false);
        expect(failed.body.data).toBeUndefined();
        expect(await counts(w.product.id, body.submissionKey)).toEqual({
          leads: 0,
          events: 0,
          outbox: 0,
          contacts: 0,
          hits: before.hits,
        });
        spy.mockRestore();
        const retry = await postLead(s, body, { origin: w.origin, ip });
        expect(retry.status).toBe(201);
        const after = await counts(w.product.id, body.submissionKey);
        expect(after).toMatchObject({
          leads: 1,
          events: 1,
          outbox: 1,
          contacts: 1,
        });
        expect(after.hits).toBe(before.hits + 1);
      });
    }

    it('обрыв после успеха: повтор тем же ключом → 200, тот же leadRef и eventId — даже когда лимит исчерпан; новая 6-я → 429', async () => {
      const ip = randomIp();
      await s.prisma
        .$executeRaw`DELETE FROM "sites"."pub_rate_hits" WHERE "key" LIKE ${`${w.product.id}:%`}`;
      const first = leadBody(w.product.publicKey);
      const ok = await postLead(s, first, { origin: w.origin, ip });
      expect(ok.status).toBe(201);
      for (let i = 0; i < 4; i++) {
        expect(
          (
            await postLead(s, leadBody(w.product.publicKey), {
              origin: w.origin,
              ip,
            })
          ).status,
        ).toBe(201);
      }
      const sixth = await postLead(s, leadBody(w.product.publicKey), {
        origin: w.origin,
        ip,
      });
      expect(sixth.status).toBe(429);
      const again = await postLead(
        s,
        { ...first, elapsedMs: 99_000 },
        { origin: w.origin, ip },
      );
      expect(again.status).toBe(200);
      expect(again.body.data).toEqual(ok.body.data);
      expect(
        await s.prisma.pubLead.count({
          where: { submissionKey: first.submissionKey },
        }),
      ).toBe(1);
    });

    it('форма закрыта (продукт closed) → 503 PUB_FORM_CLOSED, ни одной строки', async () => {
      await s.prisma
        .$executeRaw`UPDATE "sites"."pub_products" SET "mode" = 'closed' WHERE "id" = ${w.product.id}`;
      try {
        const body = leadBody(w.product.publicKey);
        const res = await postLead(s, body, {
          origin: w.origin,
          ip: randomIp(),
        });
        // В режиме closed test_hosts не действуют: Origin не из списка режима.
        expect([403, 503]).toContain(res.status);
        expect(await counts(w.product.id, body.submissionKey)).toMatchObject({
          leads: 0,
          events: 0,
        });
      } finally {
        await s.prisma
          .$executeRaw`UPDATE "sites"."pub_products" SET "mode" = 'test' WHERE "id" = ${w.product.id}`;
      }
    });

    it('нет ключа шифрования → 503 PUB_CONTACT_KEY_MISSING, контакт открытым текстом не пишется', async () => {
      const saved = process.env.ASSIST_SECRETS_KEY;
      delete process.env.ASSIST_SECRETS_KEY;
      try {
        const body = leadBody(w.product.publicKey);
        const res = await postLead(s, body, {
          origin: w.origin,
          ip: randomIp(),
        });
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('PUB_CONTACT_KEY_MISSING');
        expect(await counts(w.product.id, body.submissionKey)).toMatchObject({
          leads: 0,
        });
      } finally {
        process.env.ASSIST_SECRETS_KEY = saved;
      }
    });

    it('ловушка hp: ответ как при успехе (201, leadRef), но заявки и события нет', async () => {
      const body = leadBody(w.product.publicKey, { hp: 'http://spam.example' });
      const res = await postLead(s, body, { origin: w.origin, ip: randomIp() });
      expect(res.status).toBe(201);
      expect(res.body.data.leadRef).toMatch(/^L-[A-Z2-7]{10}$/);
      expect(await counts(w.product.id, body.submissionKey)).toMatchObject({
        leads: 0,
        events: 0,
        outbox: 0,
      });
      expect(
        await s.prisma.pubLead.count({
          where: { publicRef: res.body.data.leadRef },
        }),
      ).toBe(0);
      // S3-5: обезличенный след — строка счётчика без тела и IP; паспорт
      // показывает срабатывания за час.
      const traps = await s.prisma.$queryRaw<Array<{ key: string }>>`
        SELECT "key" FROM "sites"."pub_rate_hits" WHERE "key" LIKE ${`${w.product.id}:trap:%`}`;
      expect(traps).toEqual([{ key: `${w.product.id}:trap:hp` }]);
      const passport = await s.db
        .forAccount(w.account.accountId)
        .$transaction((tx) =>
          s.mod.get(TrafficPassportService).passport(tx, w.product, {}),
        );
      expect(passport.leads.trapHitsLastHour).toBe(1);
    });

    it('S3-7: slug/код размещения формы, похожие на контакт, отбрасываются — заявка принята (201), сырые поля null', async () => {
      const body = leadBody(w.product.publicKey, {
        contentSlug: '0671234567',
        placementCode: 'tg-380671234567',
      });
      const res = await postLead(s, body, { origin: w.origin, ip: randomIp() });
      expect(res.status).toBe(201);
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      expect(lead).toMatchObject({
        contentSlugRaw: null,
        placementCodeRaw: null,
      });
      const ev = await s.prisma.pubEvent.findFirstOrThrow({
        where: { leadId: lead.id },
      });
      expect(ev).toMatchObject({
        contentSlugRaw: null,
        placementCodeRaw: null,
      });
    });

    it('быстрое заполнение (< 800 мс) — мягкая пометка suspectedSpam, не отказ', async () => {
      const body = leadBody(w.product.publicKey, { elapsedMs: 300 });
      const res = await postLead(s, body, { origin: w.origin, ip: randomIp() });
      expect(res.status).toBe(201);
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      expect(lead.suspectedSpam).toBe(true);
    });

    it('невалидное тело → 400 PUB_VALIDATION по полям, удар лимита не тратится', async () => {
      const ip = randomIp();
      const before = await counts(w.product.id);
      const body = leadBody(w.product.publicKey, {
        contactMethod: 'phone',
        contact: 'not-a-phone',
      });
      const res = await postLead(s, body, { origin: w.origin, ip });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PUB_VALIDATION');
      expect(res.body.error.details.fields).toEqual([
        { field: 'contact', code: 'format' },
      ]);
      expect((await counts(w.product.id)).hits).toBe(before.hits);
    });
  },
);
