/**
 * [AT-RD-01] [AT-RD-02] P-R M1 — изоляция кабинета и роли раздела Reddit
 * (reddit-manual-mvp-adapted.md §M1.0, §5, §9).
 *
 *  - AT-RD-01: КАЖДЫЙ маршрут `REDDIT_ROUTES` с чужим продуктом → 404
 *    `PUB_NOT_FOUND`, неотличимо от несуществующего; объект чужого кабинета
 *    в своём продукте — как несуществующий; побочных эффектов нет (число
 *    строк `pub_*` обоих кабинетов не меняется). Систематически по всем
 *    маршрутам Publisher — ещё и `z-isolation.spec.ts` (реестр включает
 *    `REDDIT_ROUTES`).
 *  - AT-RD-02: наблюдатель (VW) на review правил и на согласование версии →
 *    403 `PUB_ROLE_REQUIRED`; матрица §5 по ролям на всех маршрутах: роль
 *    без действия — 403, с действием — не 403; SA к разделу доступа не имеет.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import type { RouteSpec } from '../../modules/publisher/contracts/_template';
import { REDDIT_ROUTES } from '../../modules/publisher/contracts/reddit-api';
import { fillPath } from '../../modules/publisher/core/route-enumerator';
import {
  accessOf,
  can,
  type PubAction,
} from '../../modules/publisher/core/roles';
import { asMember } from '../../modules/publisher/core/testing/core-stack.testing';
import {
  api,
  ok,
  redditStack,
  redditWorld,
  seedCommunity,
  seedOpportunity,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';
import type { PubRole } from '../../modules/publisher/contracts/states';

jest.setTimeout(300_000);

type Spec = RouteSpec<unknown, unknown> & { name: string };
const ROUTES: Spec[] = Object.entries(REDDIT_ROUTES).map(([name, r]) => ({
  ...(r as RouteSpec<unknown, unknown>),
  name,
}));
const ghost = () =>
  `c${randomUUID().replace(/-/g, '').slice(0, 24)}`.replace(/[0-9]/g, 'z');

ciDescribe('P-R M1: изоляция и роли раздела Reddit', () => {
  let s: RedditStack;
  let a: RedditWorld;
  let b: RedditWorld;
  let foreign: string[] = [];

  beforeAll(async () => {
    s = await redditStack();
    a = await redditWorld(s);
    b = await redditWorld(s);
    // Объекты кабинета B: проект, сообщество, снимок, возможность, запрос.
    const eb = api(s, b.acc.accountId, b.team.editor);
    const c = await seedCommunity(eb, b.P, { rules: 'allowed' });
    const o = ok<{ id: string }>(await seedOpportunity(eb, b.P, c), 201);
    const k = ok<{ id: string }>(
      await eb.post(`${b.P}/keywords`, {
        projectId: c.projectId,
        phrase: 'site assistant',
        intent: 'how_to',
        priority: 3,
      }),
      201,
    );
    foreign = [c.projectId, c.communityId, c.snapshotId!, o.id, k.id];
  });
  afterAll(async () => {
    await s?.close();
  });

  async function counts(): Promise<Record<string, number>> {
    const tables = await s.prisma.$queryRaw<Array<{ t: string }>>`
      SELECT c.table_name AS t FROM information_schema.columns c
       WHERE c.table_schema = 'sites' AND c.table_name LIKE 'pub\\_%'
         AND c.column_name = 'accountId'
         AND EXISTS (SELECT 1 FROM information_schema.tables x
                      WHERE x.table_schema = 'sites' AND x.table_name = c.table_name
                        AND x.table_type = 'BASE TABLE')
       ORDER BY 1`;
    const out: Record<string, number> = {};
    for (const { t } of tables) {
      const [r] = await s.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "sites"."${t}" WHERE "accountId" = ANY($1::text[])`,
        [a.acc.accountId, b.acc.accountId],
      );
      out[t] = Number(r.n);
    }
    return out;
  }

  function call(r: Spec, path: string, h: Record<string, string>) {
    const m = r.method.toLowerCase() as 'get' | 'post' | 'patch';
    const req = request(s.srv())[m](path).set(h);
    return r.method === 'GET'
      ? req
      : req.send({ opKey: randomUUID(), expectedRevision: 1 });
  }
  const shape = (res: request.Response) =>
    JSON.stringify({
      status: res.status,
      code: res.body?.error?.code ?? null,
      details: res.body?.error?.details ?? null,
    });

  describe('[AT-RD-01] чужой кабинет или продукт → 404 на всех маршрутах …/reddit/**', () => {
    it('реестр REDDIT_ROUTES не пуст, все пути под /publisher/products/:pid/reddit/', () => {
      expect(ROUTES.length).toBe(25);
      for (const r of ROUTES)
        expect(r.path.startsWith('/publisher/products/:pid/reddit/')).toBe(
          true,
        );
    });

    it('чужой продукт — 404 как несуществующий; объект кабинета B в продукте A — как несуществующий; без побочных эффектов', async () => {
      const before = await counts();
      const owner = asMember(a.acc.owner.telegramId, a.acc.accountId);
      const bad: unknown[] = [];
      for (const r of ROUTES) {
        const f = await call(r, fillPath(r.path, { pid: b.product.id }), owner);
        const g = await call(r, fillPath(r.path, { pid: ghost() }), owner);
        if (
          f.status !== 404 ||
          f.body.error.code !== 'PUB_NOT_FOUND' ||
          shape(f) !== shape(g)
        )
          bad.push({ route: r.name, foreign: shape(f), ghost: shape(g) });
        if (!r.path.includes(':id')) continue;
        const gid = await call(
          r,
          fillPath(r.path, { pid: a.product.id, id: ghost() }),
          owner,
        );
        for (const id of foreign) {
          const x = await call(
            r,
            fillPath(r.path, { pid: a.product.id, id }),
            owner,
          );
          if (
            x.status < 400 ||
            x.status !== gid.status ||
            x.body.error?.code !== gid.body.error?.code
          )
            bad.push({ route: r.name, id, res: shape(x), ghost: shape(gid) });
        }
      }
      expect(bad).toEqual([]);
      expect(await counts()).toEqual(before);
    });

    it('участник кабинета A с заголовком кабинета B — отказ, одинаковый для существующего и несуществующего продукта', async () => {
      const before = await counts();
      const intruder = asMember(a.acc.owner.telegramId, b.acc.accountId);
      for (const r of ROUTES) {
        const real = await call(
          r,
          fillPath(r.path, { pid: b.product.id, id: foreign[0] }),
          intruder,
        );
        const g = await call(
          r,
          fillPath(r.path, { pid: ghost(), id: ghost() }),
          intruder,
        );
        expect([401, 403, 404]).toContain(real.status);
        expect(shape(real)).toBe(shape(g));
      }
      expect(await counts()).toEqual(before);
    });
  });

  describe('[AT-RD-02] роли: VW — 403 на review правил и согласовании; матрица §5', () => {
    it('VW: POST /rules/:id/review → 403 PUB_ROLE_REQUIRED, снимок не тронут; POST …/versions/:vid/approve → 403', async () => {
      const ea = api(s, a.acc.accountId, a.team.editor);
      const c = await seedCommunity(ea, a.P, {
        rules: 'allowed',
        reviewer: null,
      });
      const vw = api(s, a.acc.accountId, a.team.viewer);
      const r = await vw.post(`${a.P}/rules/${c.snapshotId}/review`);
      expect(r.status).toBe(403);
      expect(r.body.error).toMatchObject({
        code: 'PUB_ROLE_REQUIRED',
        details: { action: 'reddit.rules.review' },
      });
      const snap = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
        where: { id: c.snapshotId! },
      });
      expect(snap.reviewState).toBe('unreviewed');
      const ap = await vw.post(
        `/publisher/products/${a.product.id}/versions/${ghost()}/approve`,
        {},
      );
      expect(ap.status).toBe(403);
      expect(ap.body.error.code).toBe('PUB_ROLE_REQUIRED');
      // Чтение раздела наблюдателю доступно.
      expect((await vw.get(`${a.P}/communities`)).status).toBe(200);
    });

    it('каждая роль × каждый маршрут: нет действия — 403 PUB_ROLE_REQUIRED, есть — не 403; без побочных эффектов', async () => {
      const before = await counts();
      const roles: Array<PubRole | 'admin'> = [
        'product_owner',
        'editor',
        'operator',
        'analyst',
        'sales',
        'viewer',
        'admin',
      ];
      const bad: unknown[] = [];
      let checked = 0;
      for (const role of roles) {
        const m = a.team[role];
        const access = accessOf({
          memberId: m.memberId,
          grants: role === 'admin' ? [] : [role],
          admin: role === 'admin',
          accountOwner: false,
        });
        const h = asMember(m.telegramId, a.acc.accountId);
        for (const r of ROUTES) {
          const allowed = (Array.isArray(r.action) ? r.action : [r.action])
            .filter((x): x is PubAction => !!x)
            .some((x) => can(access, x));
          // Мутации — с несуществующим id/пустым телом: допущенный получит
          // 400/404/409, не 403; запись не происходит.
          const res = await call(
            r,
            fillPath(r.path, { pid: a.product.id, id: ghost() }),
            h,
          );
          checked++;
          if (
            allowed
              ? res.status === 403
              : res.status !== 403 ||
                res.body.error.code !== 'PUB_ROLE_REQUIRED'
          )
            bad.push({
              role,
              route: r.name,
              status: res.status,
              code: res.body?.error?.code,
            });
        }
      }
      expect(bad).toEqual([]);
      expect(checked).toBe(roles.length * ROUTES.length);
      expect(await counts()).toEqual(before);
    });
  });
});
