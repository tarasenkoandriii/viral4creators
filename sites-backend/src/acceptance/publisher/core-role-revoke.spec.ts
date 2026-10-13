/**
 * [AT-CORE-11] Роли продукта: отзыв действует на СЛЕДУЮЩЕМ запросе (кэша
 * нет), удалённый участник теряет доступ сразу, а гранты закрывает задание
 * `members-reconcile` (P-A1, проектный документ §4.1; часть AI-28 — P-B2).
 * Маршруты ядра: аналитик предлагает параметр, владелец продукта решает;
 * маршруты денег и заявок (P-C, P-D) проверят тем же гвардом на этапе Z.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { MembersReconcileJob } from '../../modules/publisher/core/members-reconcile.job';
import {
  asMember,
  coreStack,
  type CoreStack,
} from '../../modules/publisher/core/testing/core-stack.testing';
import {
  seedAccount,
  seedMembers,
  seedProduct,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(90_000);

ciDescribe('[AT-CORE-11] отзыв роли продукта — на следующем запросе', () => {
  let s: CoreStack;
  beforeAll(async () => {
    s = await coreStack({ http: true });
  });
  afterAll(async () => {
    await s.close();
  });

  it('аналитик: предложение — 201; после отзыва гранта — 403 PUB_ROLE_REQUIRED; владелец продукта после отзыва — 403 на решение', async () => {
    const acc = await seedAccount(s.prisma);
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      siteId: acc.siteId,
      kind: 'test',
    });
    const team = await seedMembers(s.prisma, p, acc.owner);
    const srv = s.app!.getHttpServer();
    const admin = asMember(acc.owner.telegramId, acc.accountId);
    const analyst = asMember(team.analyst.telegramId, acc.accountId);
    const propose = () =>
      request(srv)
        .post(`/publisher/products/${p.id}/parameters/form_limit/proposals`)
        .set(analyst)
        .send({ opKey: randomUUID(), value: { count: 4, windowSec: 600 } });
    expect((await propose()).status).toBe(201);
    const grants = await request(srv)
      .get(`/publisher/products/${p.id}/roles`)
      .set(admin);
    const g = grants.body.data.items.find(
      (x: { memberId: string; active: boolean }) =>
        x.memberId === team.analyst.memberId && x.active,
    );
    const rv = await request(srv)
      .post(`/publisher/products/${p.id}/roles/${g.id}/revoke`)
      .set(admin)
      .send({ opKey: randomUUID(), reason: 'Аналітик завершив роботу' });
    expect(rv.status).toBe(200);
    const after = await propose();
    expect(after.status).toBe(403);
    expect(after.body.error).toMatchObject({
      code: 'PUB_ROLE_REQUIRED',
      details: { action: 'parameter.propose' },
    });
    // и чтение тоже: других ролей у него нет
    expect(
      (await request(srv).get(`/publisher/products/${p.id}`).set(analyst))
        .status,
    ).toBe(403);

    const po = asMember(team.product_owner.telegramId, acc.accountId);
    const decide = () =>
      request(srv)
        .post(`/publisher/products/${p.id}/parameters/niche/decision`)
        .set(po)
        .send({
          opKey: randomUUID(),
          toStatus: 'rejected',
          basis: 'Ніша ще не обрана',
          expectedRevision: 1,
        });
    const gpo = grants.body.data.items.find(
      (x: { memberId: string }) => x.memberId === team.product_owner.memberId,
    );
    await request(srv)
      .post(`/publisher/products/${p.id}/roles/${gpo.id}/revoke`)
      .set(admin)
      .send({ opKey: randomUUID(), reason: 'Передача ролі' });
    expect((await decide()).status).toBe(403);
  });

  it('удалённый из кабинета участник — 403 сразу; задание закрывает его гранты (revokedBy system:member-removed)', async () => {
    const acc = await seedAccount(s.prisma);
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      siteId: acc.siteId,
      kind: 'test',
    });
    const team = await seedMembers(s.prisma, p, acc.owner);
    const srv = s.app!.getHttpServer();
    const sales = asMember(team.sales.telegramId, acc.accountId);
    expect(
      (await request(srv).get(`/publisher/products/${p.id}`).set(sales)).status,
    ).toBe(200);
    expect(
      (
        await request(srv)
          .delete(`/sites/account/members/${team.sales.memberId}`)
          .set(asMember(acc.owner.telegramId, acc.accountId))
      ).status,
    ).toBe(200);
    expect(
      (await request(srv).get(`/publisher/products/${p.id}`).set(sales)).status,
    ).toBe(403);
    await s.mod.get(MembersReconcileJob).run({
      now: new Date(),
      deadline: new Date(Date.now() + 30_000),
      scope: { siteIds: [p.siteId] },
    });
    const g = await s.prisma.pubRoleGrant.findMany({
      where: { productId: p.id, memberId: team.sales.memberId },
    });
    expect(g.map((x) => x.revokedBy)).toEqual(['system:member-removed']);
  });
});
