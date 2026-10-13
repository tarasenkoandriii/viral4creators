/**
 * AT-CORE-09, раскрытие контакта (P-D, проектный документ §1 п.7, §4.2,
 * §8.1, §11.3; аудит P1-3; Р-PUB-19): контакт доступен только разрешённым
 * ролям (продажи, владелец продукта, владелец кабинета) — `POST` с целью
 * (Р-PUB-Z2-25, предаудит D1-02: `GET` с записью в журнал пропускали барьеры
 * CSRF веб-кабинета; прежний `GET` — 405 без записи),
 * `Cache-Control: private, no-store`, запись аудита `reveal_contact` БЕЗ
 * содержимого до отдачи данных, без ключа идемпотентности и без хранения
 * ответа. Аналитик, оператор, редактор, наблюдатель и администратор
 * Publisher (без продаж) — 403.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { LEADS_ROUTES } from '../../modules/publisher/contracts/leads-api';
import {
  checkWebRequest,
  isSafeMethod,
} from '../../modules/telegram-auth/web/web-request';
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
  openLive,
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
  '[AT-CORE-09] Раскрытие контакта заявителя: только SA/PO, POST с аудитом, без хранения',
  () => {
    let s: CoreStack;
    let w: IntakeWorld;
    let team: SeededMembers;
    let leadId: string;
    let person: ReturnType<typeof syntheticPerson>;
    let restore: Array<() => void>;
    const srv = () => s.app!.getHttpServer();
    const reveal = (
      who: keyof SeededMembers,
      purpose: string | null = 'first_contact',
    ) => {
      const r = request(srv())
        .post(`/publisher/products/${w.product.id}/leads/${leadId}/contact`)
        .set(asMember(team[who].telegramId, w.account.accountId));
      return r.send(purpose === null ? {} : { purpose });
    };

    beforeAll(async () => {
      restore = [useTestSecrets(), trustLocalProxy()];
      s = await leadsStack({ http: true });
      w = await intakeProduct(s, { kind: 'working' });
      team = await seedMembers(s.prisma, w.product, w.account.owner);
      // Утверждённое уведомление о данных (S3-4); флаги гейтов — после решения.
      await decideParam(
        s,
        w.product,
        'data_notice_version',
        {
          version: 'notice-v2',
          text: 'Ми обробляємо дані заявки для відповіді.',
        },
        'approved',
        w.account.owner.memberId,
      );
      await openLive(s, w.product.id);
      person = syntheticPerson();
      const body = leadBody(w.product.publicKey, {
        dataNoticeVersion: 'notice-v2',
        name: person.name,
        contactMethod: 'phone',
        contact: person.phone,
        task: person.task,
        business: person.business,
        selfReported: { channel: 'social', note: 'Побачив пост у групі' },
      });
      expect(
        (await postLead(s, body, { origin: w.origin, ip: randomIp() })).status,
      ).toBe(201);
      leadId = (
        await s.prisma.pubLead.findFirstOrThrow({
          where: { submissionKey: body.submissionKey },
        })
      ).id;
      await s.mod.get(LeadEnrichJob).run({
        now: new Date(),
        scope: { siteIds: [w.account.siteId] },
        deadline: new Date(Date.now() + 30_000),
      });
    });
    afterAll(async () => {
      await s.close();
      restore.forEach((r) => r());
    });

    it('продажи и владелец продукта (и владелец кабинета) видят контакт: 200, private no-store, ключ идемпотентности не пишется', async () => {
      const keysBefore = await s.prisma.pubIdempotencyKey.count({
        where: { productId: w.product.id },
      });
      for (const who of ['sales', 'product_owner', 'accountOwner'] as const) {
        const r = await reveal(who);
        expect(r.status).toBe(200);
        expect(r.headers['cache-control']).toBe('private, no-store');
        expect(r.body.data).toEqual({
          leadId,
          publicRef: expect.stringMatching(/^L-/),
          name: person.name,
          contactMethod: 'phone',
          contact: person.phone,
          business: person.business,
          task: person.task,
          selfReported: 'Побачив пост у групі',
          dataNotice: {
            version: 'notice-v2',
            expected: 'notice-v2',
            matches: true,
          },
        });
      }
      expect(
        await s.prisma.pubIdempotencyKey.count({
          where: { productId: w.product.id },
        }),
      ).toBe(keysBefore);
    });

    it('S3-4: версия уведомления о данных сверяется с продуктом и сохраняется в шифре; чужая/старая — мягкая пометка (заявка принята)', async () => {
      const body = leadBody(w.product.publicKey, {
        dataNoticeVersion: 'totally-made-up-99',
      });
      expect(
        (await postLead(s, body, { origin: w.origin, ip: randomIp() })).status,
      ).toBe(201);
      const other = (
        await s.prisma.pubLead.findFirstOrThrow({
          where: { submissionKey: body.submissionKey },
        })
      ).id;
      const r = await request(srv())
        .post(`/publisher/products/${w.product.id}/leads/${other}/contact`)
        .send({ purpose: 'first_contact' })
        .set(asMember(team.sales.telegramId, w.account.accountId));
      expect(r.status).toBe(200);
      expect(r.body.data.dataNotice).toEqual({
        version: 'totally-made-up-99',
        expected: 'notice-v2',
        matches: false,
      });
      // Версия не лежит открытым текстом нигде в заявке.
      const row = await s.prisma.pubLead.findFirstOrThrow({
        where: { id: other },
      });
      expect(JSON.stringify(row)).not.toContain('totally-made-up-99');
    });

    it('аналитик, оператор, редактор, наблюдатель, админ Publisher, участник без ролей → 403; без допуска к Publisher → 403', async () => {
      for (const who of [
        'analyst',
        'operator',
        'editor',
        'viewer',
        'admin',
        'memberNoRoles',
        'noAccess',
      ] as const) {
        const r = await reveal(who);
        expect({ who, status: r.status }).toEqual({ who, status: 403 });
        expect(JSON.stringify(r.body)).not.toContain(person.phone);
      }
    });

    it('цель обязательна и из списка; чужой кабинет — 404', async () => {
      expect((await reveal('sales', null)).status).toBe(400);
      expect((await reveal('sales', 'просто цікаво')).status).toBe(400);
      const other = await intakeProduct(s, { kind: 'test' });
      const r = await request(srv())
        .post(`/publisher/products/${w.product.id}/leads/${leadId}/contact`)
        .send({ purpose: 'first_contact' })
        .set(asMember(other.account.owner.telegramId, other.account.accountId));
      expect(r.status).toBe(404);
    });

    it('каждое раскрытие — запись аудита reveal_contact с целью и без содержимого', async () => {
      const before = await s.prisma.pubAuditEvent.count({
        where: {
          productId: w.product.id,
          objectId: leadId,
          action: 'reveal_contact',
        },
      });
      expect((await reveal('sales', 'qualification')).status).toBe(200);
      const rows = await s.prisma.pubAuditEvent.findMany({
        where: {
          productId: w.product.id,
          objectId: leadId,
          action: 'reveal_contact',
        },
        orderBy: { occurredAt: 'desc' },
      });
      expect(rows.length).toBe(before + 1);
      expect(rows[0]).toMatchObject({
        actor: `member:${team.sales.memberId}`,
        objectType: 'lead',
        meta: { what: 'contact', purpose: 'qualification' },
      });
      const dump = JSON.stringify(rows);
      for (const v of [person.name, person.phone, person.task, person.business])
        expect(dump).not.toContain(v);
    });

    it('заметки решений раскрываются тем же правом и тоже журналируются; карточка без контакта и заметок', async () => {
      const c = await request(srv())
        .get(`/publisher/products/${w.product.id}/leads/${leadId}`)
        .set(asMember(team.sales.telegramId, w.account.accountId));
      expect(c.status).toBe(200);
      const cardDump = JSON.stringify(c.body);
      for (const v of [person.name, person.phone, person.task, person.business])
        expect(cardDump).not.toContain(v);
      const t = await request(srv())
        .post(`/publisher/products/${w.product.id}/leads/${leadId}/transition`)
        .set(asMember(team.sales.telegramId, w.account.accountId))
        .send({
          opKey: randomUUID(),
          to: 'contacted',
          note: person.note,
          expectedRevision: c.body.data.revision,
        });
      expect(t.status).toBe(200);
      expect(JSON.stringify(t.body)).not.toContain(person.note);
      const n = await request(srv())
        .post(`/publisher/products/${w.product.id}/leads/${leadId}/notes`)
        .send({})
        .set(asMember(team.product_owner.telegramId, w.account.accountId));
      expect(n.status).toBe(200);
      expect(
        n.body.data.decisions.map((d: { note: string }) => d.note),
      ).toEqual([person.note]);
      const an = await request(srv())
        .post(`/publisher/products/${w.product.id}/leads/${leadId}/notes`)
        .send({})
        .set(asMember(team.analyst.telegramId, w.account.accountId));
      expect(an.status).toBe(403);
      // Ключ идемпотентности перехода не хранит заметку (ответ без неё).
      const key = await s.prisma.pubIdempotencyKey.findFirstOrThrow({
        where: { productId: w.product.id, scope: 'lead.transition' },
        orderBy: { createdAt: 'desc' },
      });
      expect(JSON.stringify(key)).not.toContain(person.note);
    });

    it('Р-PUB-Z2-25 (D1-02): прежний GET раскрытия — 405 Allow: POST, ничего не раскрыто и не записано в журнал', async () => {
      const where = {
        productId: w.product.id,
        objectId: leadId,
        action: 'reveal_contact',
      };
      const before = await s.prisma.pubAuditEvent.count({ where });
      for (const what of ['contact', 'notes'] as const) {
        const r = await request(srv())
          .get(`/publisher/products/${w.product.id}/leads/${leadId}/${what}`)
          .query({ purpose: 'first_contact' })
          .set(asMember(team.sales.telegramId, w.account.accountId));
        expect({ what, status: r.status }).toEqual({ what, status: 405 });
        expect(r.headers.allow).toBe('POST');
        expect(JSON.stringify(r.body)).not.toContain(person.phone);
      }
      expect(await s.prisma.pubAuditEvent.count({ where })).toBe(before);
      // Без роли — по-прежнему 403 (гвард до 405): метод не раскрывает доступ.
      const an = await request(srv())
        .get(`/publisher/products/${w.product.id}/leads/${leadId}/contact`)
        .set(asMember(team.analyst.telegramId, w.account.accountId));
      expect(an.status).toBe(403);
    });

    it('Р-PUB-Z2-25 (D1-02): раскрытие — НЕ безопасный метод, барьеры CSRF веб-кабинета его закрывают', () => {
      for (const r of [LEADS_ROUTES.revealContact, LEADS_ROUTES.revealNotes]) {
        expect(r.method).toBe('POST');
        expect(isSafeMethod(r.method)).toBe(false);
        // Навигация с чужого сайта по cookie: ни X-Telegram-App, ни Origin кабинета.
        const env = {
          WEB_CABINET_ORIGINS: 'https://cabinet.example',
          NODE_ENV: 'production',
        };
        expect(
          checkWebRequest(r.method, { referer: 'https://evil.test/page' }, env)
            ?.code,
        ).toBe('WEB_CSRF_REJECTED');
        expect(
          checkWebRequest(
            r.method,
            { 'x-telegram-app': 'assist', origin: 'https://evil.test' },
            env,
          )?.code,
        ).toBe('WEB_CSRF_REJECTED');
        expect(
          checkWebRequest(
            r.method,
            { 'x-telegram-app': 'assist', origin: 'https://cabinet.example' },
            env,
          ),
        ).toBeNull();
      }
    });
  },
);
