/**
 * AT-CORE-04 (P-D, проектный документ §11.4, §18.1; ТЗ §20): однократное
 * сохранение. Один `submissionKey` ×10 параллельно → одна заявка и тот же
 * `leadRef`; тот же ключ с другим телом → 409; пять РАЗНЫХ отправок
 * параллельно → пять заявок или честная ошибка, ни одного ложного успеха
 * (каждый 201 — строка в базе, каждая строка — свой 201); новая задача того
 * же человека — новая заявка; лимит сброшен и не подменяет проверку.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  asMember,
  type CoreStack,
} from '../../modules/publisher/core/testing/core-stack.testing';
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

jest.setTimeout(120_000);

ciDescribe('[AT-CORE-04] Однократное сохранение заявки', () => {
  let s: CoreStack;
  let w: IntakeWorld;
  let restore: Array<() => void>;

  const resetLimit = async () => {
    // Сброс тестового счётчика — маршрутом ядра (P-A1) через порт P-D.
    const res = await request(s.app!.getHttpServer())
      .post(`/publisher/products/${w.product.id}/test/rate-limit/reset`)
      .set(asMember(w.account.owner.telegramId, w.account.accountId))
      .send({ opKey: randomUUID() });
    expect(res.status).toBe(200);
    return res.body.data.removed as number;
  };

  beforeAll(async () => {
    restore = [useTestSecrets(), trustLocalProxy()];
    s = await leadsStack({ http: true });
    w = await intakeProduct(s, { kind: 'test' });
  });
  afterAll(async () => {
    await s.close();
    restore.forEach((r) => r());
  });

  it('один submissionKey ×10 параллельно → одна заявка, один и тот же leadRef и eventId, один удар лимита', async () => {
    await resetLimit();
    const ip = randomIp();
    const body = leadBody(w.product.publicKey);
    const all = await Promise.all(
      Array.from({ length: 10 }, () =>
        postLead(s, body, { origin: w.origin, ip }),
      ),
    );
    expect(all.map((r) => r.status).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    const refs = new Set(all.map((r) => r.body.data.leadRef));
    const events = new Set(all.map((r) => r.body.data.eventId));
    expect(refs.size).toBe(1);
    expect(events.size).toBe(1);
    expect(
      await s.prisma.pubLead.count({
        where: { productId: w.product.id, submissionKey: body.submissionKey },
      }),
    ).toBe(1);
    const lead = await s.prisma.pubLead.findFirstOrThrow({
      where: { submissionKey: body.submissionKey },
    });
    expect(await s.prisma.pubEvent.count({ where: { leadId: lead.id } })).toBe(
      1,
    );
    const hits = await s.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS "n" FROM "sites"."pub_rate_hits" WHERE "key" LIKE ${`${w.product.id}:form:%`}`;
    expect(hits[0].n).toBe(1);
  });

  it('тот же submissionKey с другим телом → 409 PUB_IDEMPOTENCY_REUSED, вторая заявка не создаётся', async () => {
    const ip = randomIp();
    const body = leadBody(w.product.publicKey);
    expect((await postLead(s, body, { origin: w.origin, ip })).status).toBe(
      201,
    );
    const other = await postLead(
      s,
      { ...body, task: 'Зовсім інша задача' },
      { origin: w.origin, ip },
    );
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('PUB_IDEMPOTENCY_REUSED');
    expect(
      await s.prisma.pubLead.count({
        where: { submissionKey: body.submissionKey },
      }),
    ).toBe(1);
  });

  it('пять разных отправок параллельно (один источник, лимит сброшен) → пять заявок, ни одного ложного успеха; шестая → 429', async () => {
    const removed = await resetLimit();
    expect(removed).toBeGreaterThanOrEqual(0);
    const ip = randomIp();
    const bodies = Array.from({ length: 5 }, () =>
      leadBody(w.product.publicKey),
    );
    const res = await Promise.all(
      bodies.map((b) => postLead(s, b, { origin: w.origin, ip })),
    );
    for (const [i, r] of res.entries()) {
      const saved = await s.prisma.pubLead.findFirst({
        where: {
          productId: w.product.id,
          submissionKey: bodies[i].submissionKey,
        },
        select: { publicRef: true },
      });
      // Успех ⇔ заявка сохранена ровно этим номером; честная ошибка
      // (не 2xx) ⇔ заявки нет. Ложного успеха нет ни в одном исходе.
      const outcome =
        r.status === 201
          ? saved?.publicRef === r.body.data.leadRef
          : r.status >= 400 && saved === null;
      expect({ i, status: r.status, consistent: outcome }).toEqual({
        i,
        status: r.status,
        consistent: true,
      });
    }
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(new Set(res.map((r) => r.body.data.leadRef)).size).toBe(5);
    const sixth = await postLead(s, leadBody(w.product.publicKey), {
      origin: w.origin,
      ip,
    });
    expect(sixth.status).toBe(429);
  });

  it('новая задача того же человека — новая заявка (не дубль), контакт совпадает по matchHash', async () => {
    await resetLimit();
    const ip = randomIp();
    const p = syntheticPerson();
    const a = leadBody(w.product.publicKey, {
      contact: p.email,
      name: p.name,
      task: 'Задача А',
    });
    const b = leadBody(w.product.publicKey, {
      contact: p.email.toUpperCase(),
      name: p.name,
      task: 'Задача Б',
    });
    expect((await postLead(s, a, { origin: w.origin, ip })).status).toBe(201);
    expect((await postLead(s, b, { origin: w.origin, ip })).status).toBe(201);
    const leads = await s.prisma.pubLead.findMany({
      where: { submissionKey: { in: [a.submissionKey, b.submissionKey] } },
      select: { id: true, duplicateOfLeadId: true },
    });
    expect(leads).toHaveLength(2);
    expect(leads.every((l) => l.duplicateOfLeadId === null)).toBe(true);
    const contacts = await s.prisma.pubLeadContact.findMany({
      where: { leadId: { in: leads.map((l) => l.id) } },
      select: { matchHash: true },
    });
    expect(new Set(contacts.map((c) => c.matchHash)).size).toBe(1);
  });

  it('повтор с другим временем заполнения (elapsedMs) — тот же запрос: 200', async () => {
    const ip = randomIp();
    const body = leadBody(w.product.publicKey, { elapsedMs: 5000 });
    const first = await postLead(s, body, { origin: w.origin, ip });
    const again = await postLead(
      s,
      { ...body, elapsedMs: 65_000 },
      { origin: w.origin, ip },
    );
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.data.leadRef).toBe(first.body.data.leadRef);
  });
});
