/**
 * Э3 H — участники кабинета (план Э3 «операторы, роли кабинета»; QA-ТЗ
 * §11.3 маршруты «+»): PATCH/DELETE /sites/account/members/:memberId на
 * НАСТОЯЩЕМ Postgres с настоящими гвардами. Роль и права — только
 * владелец; владельца не понизить и не удалить (`MEMBER_LAST_OWNER`);
 * участник может выйти сам; чужой кабинет — 404.
 */
import * as request from 'supertest';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { HANDOFF_ERROR_CODES } from '../../modules/assist-site-handoff/api-types';
import { HandoffStack } from '../../modules/assist-site-handoff/testing/handoff-stack.testing';
import { HandoffHttp } from '../../modules/assist-site-handoff/testing/handoff-http.testing';

jest.setTimeout(60_000);

describeDb('Э3 H — участники кабинета (handoff-members)', () => {
  const st = new HandoffStack();
  const http = new HandoffHttp();
  beforeAll(async () => {
    await st.init();
    await http.init(st);
  });
  afterAll(async () => {
    await http.close();
    await st.close();
  });

  const patch = (memberId: string, tg: bigint, body: object) =>
    request(http.server())
      .patch(`/sites/account/members/${memberId}`)
      .set(http.as(tg))
      .send(body);
  const del = (memberId: string, tg: bigint) =>
    request(http.server())
      .delete(`/sites/account/members/${memberId}`)
      .set(http.as(tg));

  it('владелец меняет роль и права частично; memberId — в кабинете', async () => {
    const s = await st.handoffSite({ operators: 2 });
    const owner = s.members[0];
    const [a] = s.operators;
    const info = await request(http.server())
      .get('/sites/account')
      .set(http.as(owner.telegramId))
      .expect(200);
    expect(info.body.data.me.memberId).toBe(owner.memberId);
    expect(
      info.body.data.members.map((m: { memberId: string }) => m.memberId),
    ).toEqual(s.members.map((m) => m.memberId));
    const res = await patch(a.memberId, owner.telegramId, {
      role: 'manager',
      productRoles: { assist: 'manager', qa: 'viewer' },
    }).expect(200);
    const updated = res.body.data.members.find(
      (m: { memberId: string }) => m.memberId === a.memberId,
    );
    expect(updated).toMatchObject({
      role: 'manager',
      productRoles: { assist: 'manager', qa: 'viewer', assistAdmin: 'none' },
    });
    // Частично: только assistAdmin, остальное — как было.
    await patch(a.memberId, owner.telegramId, {
      productRoles: { assistAdmin: 'employee' },
    }).expect(200);
    const row = await st.owner.siteAccountMember.findUniqueOrThrow({
      where: { id: a.memberId },
    });
    expect(row.productRoles).toEqual({
      qa: 'viewer',
      assist: 'manager',
      assistAdmin: 'employee',
    });
  });

  it('неверные значения — 400; владельца не понизить — 409 MEMBER_LAST_OWNER; не владелец — 403; чужой кабинет — 404', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const other = await st.handoffSite({ operators: 1 });
    const owner = s.members[0];
    const op = s.operators[0];
    const badRole = await patch(op.memberId, owner.telegramId, {
      role: 'owner',
    }).expect(400);
    expect(badRole.body.error.code).toBe('MEMBER_ROLES_INVALID');
    const badRoles = await patch(op.memberId, owner.telegramId, {
      productRoles: { assist: 'god' },
    }).expect(400);
    expect(badRoles.body.error.code).toBe('MEMBER_ROLES_INVALID');
    await patch(op.memberId, owner.telegramId, { extra: 1 }).expect(400);
    const lastOwner = await patch(owner.memberId, owner.telegramId, {
      role: 'manager',
    }).expect(409);
    expect(lastOwner.body.error.code).toBe('MEMBER_LAST_OWNER');
    // Утверждённые коды участников — в списке кода (TMA сверяет свой с ним).
    for (const c of [badRoles, lastOwner])
      expect(HANDOFF_ERROR_CODES).toContain(c.body.error.code);
    const notOwner = await patch(op.memberId, op.telegramId, {
      role: 'manager',
    }).expect(403);
    expect(notOwner.body.error.code).toBe('ACCOUNT_ROLE_REQUIRED');
    const foreign = await patch(other.operators[0].memberId, owner.telegramId, {
      role: 'manager',
    }).expect(404);
    expect(foreign.body.error.code).toBe('MEMBER_NOT_FOUND');
    // Чужой участник не изменился.
    expect(
      (
        await st.owner.siteAccountMember.findUniqueOrThrow({
          where: { id: other.operators[0].memberId },
        })
      ).role,
    ).toBe('operator');
  });

  it('DELETE: владелец удаляет участника; участник выходит сам (попадает в свой кабинет); чужого — 403; себя-владельца — 409', async () => {
    const s = await st.handoffSite({ operators: 3 });
    const owner = s.members[0];
    const [a, b, c] = s.operators;
    const res = await del(a.memberId, owner.telegramId).expect(200);
    expect(
      res.body.data.members.some(
        (m: { memberId: string }) => m.memberId === a.memberId,
      ),
    ).toBe(false);
    const notOwner = await del(c.memberId, b.telegramId).expect(403);
    expect(notOwner.body.error.code).toBe('ACCOUNT_ROLE_REQUIRED');
    const self = await del(b.memberId, b.telegramId).expect(200);
    // Вышел — теперь в своём (новом) кабинете владельцем.
    expect(self.body.data.account.id).not.toBe(s.accountId);
    expect(self.body.data.me.role).toBe('owner');
    const lastOwner = await del(owner.memberId, owner.telegramId).expect(409);
    expect(lastOwner.body.error.code).toBe('MEMBER_LAST_OWNER');
    await del('no-such-member', owner.telegramId).expect(404);
    expect(
      await st.owner.siteAccountMember.count({
        where: { accountId: s.accountId },
      }),
    ).toBe(2);
  });
});
