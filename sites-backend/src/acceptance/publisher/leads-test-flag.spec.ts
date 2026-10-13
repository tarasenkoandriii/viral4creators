/**
 * AT-CORE-06, часть P-D (проектный документ §3.1, §6.5, §11.3; ТЗ §28 «данные
 * команды помечаются test_flag и исключаются из отчётов спроса»): тест-флаг
 * ставится НА ПРИЁМЕ (продукт `kind=test` — `test_product`, режим test
 * рабочего — `test_mode`, live — нетестовые); тестовые переход, событие,
 * заявка и квалификация есть в диагностике и отсутствуют в деловых суммах
 * паспорта; смена флага — с причиной, история в журнале; в тестовом
 * продукте флаг не снимается. Исключение из отчётов P-E — его наборы.
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
  decideParam,
  intakeProduct,
  leadBody,
  leadsStack,
  postEvent,
  postLead,
  randomIp,
  testOrigin,
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
  '[AT-CORE-06] Тесты исключены из спроса: test_flag на приёме и история смены',
  () => {
    let s: CoreStack;
    let live: IntakeWorld;
    let team: SeededMembers;
    let restore: Array<() => void>;
    const srv = () => s.app!.getHttpServer();
    const as = (k: keyof SeededMembers) =>
      asMember(team[k].telegramId, live.account.accountId);
    const enrichAll = (siteId: string) =>
      s.mod.get(LeadEnrichJob).run({
        now: new Date(),
        scope: { siteIds: [siteId] },
        deadline: new Date(Date.now() + 30_000),
      });
    const submit = async (w: IntakeWorld) => {
      const body = leadBody(w.product.publicKey);
      expect(
        (await postLead(s, body, { origin: w.origin, ip: randomIp() })).status,
      ).toBe(201);
      return s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
    };
    const flag = (
      id: string,
      body: Record<string, unknown>,
      who: keyof SeededMembers = 'product_owner',
    ) =>
      request(srv())
        .post(`/publisher/products/${live.product.id}/leads/${id}/test-flag`)
        .set(as(who))
        .send({ opKey: randomUUID(), ...body });

    beforeAll(async () => {
      restore = [useTestSecrets(), trustLocalProxy()];
      s = await leadsStack({ http: true });
      live = await intakeProduct(s, { kind: 'working' });
      team = await seedMembers(s.prisma, live.product, live.account.owner);
    });
    afterAll(async () => {
      await s.close();
      restore.forEach((r) => r());
    });

    it('флаг на приёме: kind=test → test_product; рабочий в режиме test → test_mode; live → нетестовая; событие — с тем же флагом', async () => {
      const t = await intakeProduct(s, { kind: 'test' });
      expect(await submit(t)).toMatchObject({
        testFlag: true,
        testReason: 'test_product',
      });

      const wm = await intakeProduct(s, { kind: 'working' });
      // Машина режима: live → closed → test.
      await s.prisma
        .$executeRaw`UPDATE "sites"."pub_products" SET "mode" = 'closed' WHERE "id" = ${wm.product.id}`;
      await s.prisma
        .$executeRaw`UPDATE "sites"."pub_products" SET "mode" = 'test' WHERE "id" = ${wm.product.id}`;
      const origin = testOrigin();
      await decideParam(
        s,
        wm.product,
        'test_hosts',
        [origin],
        'assumption',
        wm.account.owner.memberId,
      );
      const inTestMode = await submit({ ...wm, origin });
      expect(inTestMode).toMatchObject({
        testFlag: true,
        testReason: 'test_mode',
      });

      const real = await submit(live);
      expect(real).toMatchObject({ testFlag: false, testReason: null });
      const ev = await s.prisma.pubEvent.findFirstOrThrow({
        where: { leadId: real.id },
      });
      expect(ev.testFlag).toBe(false);
    });

    it('смена флага — с причиной (иначе 400; контакт в причине — 400 pii); история в журнале; событие заявки получает тот же флаг', async () => {
      const lead = await submit(live);
      const c = await request(srv())
        .get(`/publisher/products/${live.product.id}/leads/${lead.id}`)
        .set(as('sales'));
      const rev = c.body.data.revision;
      expect(
        (await flag(lead.id, { testFlag: true, expectedRevision: rev })).status,
      ).toBe(400);
      const pii = await flag(lead.id, {
        testFlag: true,
        reason: 'Колега +380 67 123 45 67',
        expectedRevision: rev,
      });
      expect(pii.status).toBe(400);
      expect(pii.body.error.details.fields).toEqual([
        { field: 'reason', code: 'pii' },
      ]);
      const on = await flag(lead.id, {
        testFlag: true,
        testReason: 'team',
        reason: 'Звернення співробітника команди',
        expectedRevision: rev,
      });
      expect(on.status).toBe(200);
      expect(on.body.data).toMatchObject({
        testFlag: true,
        testReason: 'team',
      });
      const ev = await s.prisma.pubEvent.findFirstOrThrow({
        where: { leadId: lead.id },
      });
      expect(ev.testFlag).toBe(true);
      const off = await flag(
        lead.id,
        {
          testFlag: false,
          reason: 'Помилково позначено',
          expectedRevision: on.body.data.revision,
        },
        'analyst',
      );
      expect(off.status).toBe(200);
      expect(off.body.data.testFlag).toBe(false);
      const audit = await request(srv())
        .get(`/publisher/products/${live.product.id}/audit`)
        .query({ objectType: 'lead', objectId: lead.id })
        .set(as('product_owner'));
      expect(audit.status).toBe(200);
      const history = audit.body.data.items
        .filter(
          (a: { meta: { field?: string } | null }) =>
            a.meta?.field === 'testFlag',
        )
        .map(
          (a: {
            fromStatus: string;
            toStatus: string;
            reason: string;
            actor: string;
          }) => [a.fromStatus, a.toStatus, a.reason, a.actor],
        );
      expect(history).toEqual([
        [
          'test',
          'not_test',
          'Помилково позначено',
          `member:${team.analyst.memberId}`,
        ],
        [
          'not_test',
          'test',
          'Звернення співробітника команди',
          `member:${team.product_owner.memberId}`,
        ],
      ]);
      // Наблюдатель флаг не меняет.
      expect(
        (
          await flag(
            lead.id,
            {
              testFlag: true,
              reason: 'Спроба',
              expectedRevision: off.body.data.revision,
            },
            'viewer',
          )
        ).status,
      ).toBe(403);
    });

    it('S2-1: флаг заявки переносится на её сессию и события сессии (пометка и снятие) — и выходит из сессий паспорта', async () => {
      const ws = await intakeProduct(s, {
        kind: 'working',
        analytics: 'session',
      });
      const wsTeam = await seedMembers(s.prisma, ws.product, ws.account.owner);
      const owner = asMember(
        wsTeam.product_owner.telegramId,
        ws.account.accountId,
      );
      const sessionRef = testSessionRef();
      expect(
        (
          await postEvent(
            s,
            {
              key: ws.product.publicKey,
              eventId: randomUUID(),
              name: 'content_view',
              consentState: 'not_required',
              path: '/team-page',
              sessionRef,
            },
            { origin: ws.origin, ip: randomIp() },
          )
        ).status,
      ).toBe(202);
      const body = leadBody(ws.product.publicKey, { sessionRef });
      expect(
        (await postLead(s, body, { origin: ws.origin, ip: randomIp() })).status,
      ).toBe(201);
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      expect(lead.sessionRef).toBe(sessionRef);
      await enrichAll(ws.account.siteId);
      const sessionsOf = async () =>
        (
          await request(srv())
            .get(`/publisher/products/${ws.product.id}/traffic/passport`)
            .set(owner)
        ).body.data.sessions;
      const before = await sessionsOf();
      const state = async () => ({
        session: (
          await s.prisma.pubSession.findFirstOrThrow({
            where: { productId: ws.product.id, sessionRef },
          })
        ).testFlag,
        events: (
          await s.prisma.pubEvent.findMany({
            where: { productId: ws.product.id, sessionRef },
            select: { testFlag: true },
          })
        ).map((e) => e.testFlag),
      });
      expect(await state()).toEqual({ session: false, events: [false, false] });
      const rev = (
        await s.prisma.pubLead.findUniqueOrThrow({
          where: { id: lead.id },
        })
      ).revision;
      const on = await request(srv())
        .post(`/publisher/products/${ws.product.id}/leads/${lead.id}/test-flag`)
        .set(owner)
        .send({
          opKey: randomUUID(),
          testFlag: true,
          testReason: 'team',
          reason: 'Співробітник команди перевіряв форму',
          expectedRevision: rev,
        });
      expect(on.status).toBe(200);
      expect(await state()).toEqual({ session: true, events: [true, true] });
      expect(await sessionsOf()).toBe(before - 1);
      const off = await request(srv())
        .post(`/publisher/products/${ws.product.id}/leads/${lead.id}/test-flag`)
        .set(owner)
        .send({
          opKey: randomUUID(),
          testFlag: false,
          reason: 'Помилково позначено',
          expectedRevision: on.body.data.revision,
        });
      expect(off.status).toBe(200);
      expect(await state()).toEqual({ session: false, events: [false, false] });
    });

    it('S2-1: системную причину приёма (test_mode) снять нельзя — 400 test_mode', async () => {
      const wm = await intakeProduct(s, { kind: 'working' });
      await s.prisma
        .$executeRaw`UPDATE "sites"."pub_products" SET "mode" = 'closed' WHERE "id" = ${wm.product.id}`;
      await s.prisma
        .$executeRaw`UPDATE "sites"."pub_products" SET "mode" = 'test' WHERE "id" = ${wm.product.id}`;
      const origin = testOrigin();
      await decideParam(
        s,
        wm.product,
        'test_hosts',
        [origin],
        'assumption',
        wm.account.owner.memberId,
      );
      const lead = await submit({ ...wm, origin });
      expect(lead.testReason).toBe('test_mode');
      const r = await request(srv())
        .post(`/publisher/products/${wm.product.id}/leads/${lead.id}/test-flag`)
        .set(asMember(wm.account.owner.telegramId, wm.account.accountId))
        .send({
          opKey: randomUUID(),
          testFlag: false,
          reason: 'Спроба зняти',
          expectedRevision: lead.revision,
        });
      expect(r.status).toBe(400);
      expect(r.body.error.details.fields).toEqual([
        { field: 'testFlag', code: 'test_mode' },
      ]);
    });

    it('в тестовом продукте флаг не снимается (все записи тестовые)', async () => {
      const t = await intakeProduct(s, { kind: 'test' });
      const lead = await submit(t);
      const r = await request(srv())
        .post(`/publisher/products/${t.product.id}/leads/${lead.id}/test-flag`)
        .set(asMember(t.account.owner.telegramId, t.account.accountId))
        .send({
          opKey: randomUUID(),
          testFlag: false,
          reason: 'Спроба зняти',
          expectedRevision: lead.revision,
        });
      expect(r.status).toBe(400);
      expect(r.body.error.details.fields).toEqual([
        { field: 'testFlag', code: 'test_product' },
      ]);
    });

    it('тестовые переход, событие, заявка и квалификация видны в диагностике и не входят в деловые суммы паспорта', async () => {
      const realEvent = {
        key: live.product.publicKey,
        eventId: randomUUID(),
        name: 'content_view',
        consentState: 'not_required',
        path: '/',
      };
      expect(
        (await postEvent(s, realEvent, { origin: live.origin, ip: randomIp() }))
          .status,
      ).toBe(202);
      const testLead = await submit(live);
      await flag(testLead.id, {
        testFlag: true,
        reason: 'Тестовий прохід команди',
        expectedRevision: testLead.revision,
      });
      await enrichAll(live.account.siteId);
      // ДТ-3 (интеграция Z-1): тестовая квалификация разрешена и в рабочем
      // продукте — запись остаётся тестовой и в деловые суммы не входит.
      const qualifiedBefore = (
        await request(srv())
          .get(`/publisher/products/${live.product.id}/traffic/passport`)
          .set(as('analyst'))
      ).body.data.qualified;
      const c = await request(srv())
        .get(`/publisher/products/${live.product.id}/leads/${testLead.id}`)
        .set(as('sales'));
      const q = await request(srv())
        .post(
          `/publisher/products/${live.product.id}/leads/${testLead.id}/transition`,
        )
        .set(as('sales'))
        .send({
          opKey: randomUUID(),
          to: 'qualified',
          confirmedInterestAt: new Date().toISOString(),
          expectedRevision: c.body.data.revision,
        });
      expect(q.status).toBe(200);
      expect(q.body.data).toMatchObject({
        status: 'qualified',
        testFlag: true,
      });

      const diag = await request(srv())
        .get(`/publisher/products/${live.product.id}/traffic/events`)
        .query({ test: 'only' })
        .set(as('analyst'));
      expect(diag.status).toBe(200);
      expect(
        diag.body.data.items.map((e: { leadId: string | null }) => e.leadId),
      ).toContain(testLead.id);
      const realOnly = await request(srv())
        .get(`/publisher/products/${live.product.id}/traffic/events`)
        .query({ test: 'exclude' })
        .set(as('analyst'));
      expect(
        realOnly.body.data.items.every(
          (e: { testFlag: boolean }) => !e.testFlag,
        ),
      ).toBe(true);
      const testList = await request(srv())
        .get(`/publisher/products/${live.product.id}/leads`)
        .query({ test: 'only' })
        .set(as('sales'));
      expect(
        testList.body.data.items.map((l: { id: string }) => l.id),
      ).toContain(testLead.id);

      const passport = await request(srv())
        .get(`/publisher/products/${live.product.id}/traffic/passport`)
        .set(as('analyst'));
      expect(passport.status).toBe(200);
      const total = await s.prisma.pubLead.count({
        where: { productId: live.product.id, testFlag: false },
      });
      const tests = await s.prisma.pubLead.count({
        where: { productId: live.product.id, testFlag: true },
      });
      expect(passport.body.data.leads).toMatchObject({ total, test: tests });
      const realSuccess = await s.prisma.pubEvent.count({
        where: {
          productId: live.product.id,
          testFlag: false,
          name: 'lead_submit_success',
        },
      });
      expect(passport.body.data.events.lead_submit_success).toBe(realSuccess);
      // Квалифицированная тестовая заявка — вне деловых сумм (ДТ-3).
      expect(passport.body.data.qualified).toEqual(qualifiedBefore);
      expect(
        await s.prisma.pubLead.count({
          where: { id: testLead.id, status: 'qualified', testFlag: true },
        }),
      ).toBe(1);
    });

    it('квалификация в тестовом продукте разрешена (тестовая квалификация AT-CORE-06) и помечена тестом', async () => {
      const t = await intakeProduct(s, { kind: 'test' });
      const lead = await submit(t);
      await enrichAll(t.account.siteId);
      const owner = asMember(t.account.owner.telegramId, t.account.accountId);
      const c = await request(srv())
        .get(`/publisher/products/${t.product.id}/leads/${lead.id}`)
        .set(owner);
      const q = await request(srv())
        .post(`/publisher/products/${t.product.id}/leads/${lead.id}/transition`)
        .set(owner)
        .send({
          opKey: randomUUID(),
          to: 'qualified',
          confirmedInterestAt: new Date().toISOString(),
          expectedRevision: c.body.data.revision,
        });
      expect(q.status).toBe(200);
      expect(q.body.data).toMatchObject({
        status: 'qualified',
        testFlag: true,
      });
    });
  },
);
