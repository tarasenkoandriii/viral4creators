/**
 * P-R M1 — исправления аудита 15.10.2026 (зона m1; reddit-manual-mvp-
 * adapted.md §13 «Аудит 15.10.2026»):
 *  - m1-1 / Р-RD-AUD-1: архивный проект восстанавливается
 *    (`POST …/projects/:id/restore`, `archived → active`, аудит `transition`)
 *    — его сабреддиты снова доступны продукту; роли; то же из Админки (`rx/*`);
 *  - m1-2: каскад перепроверки и расчёт гейта по «текущему» снимку
 *    сериализованы — параллельный `archive` не воскресает, пересчёт score
 *    под старым снимком не проскакивает мимо каскада (две транзакции);
 *  - m1-3: отозванное значение `reddit_rules_stale_days` не действует;
 *  - m1-4: `profile_ref` на всех свободных полях P-R.
 */
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { SitesDb } from '../../prisma/sites-db.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { RedditOpportunitiesService } from '../../modules/publisher/reddit/opportunities.service';
import {
  ADMIN_USER,
  adminApi,
  useAdminEnv,
} from '../../modules/publisher/reddit/testing/admin-kit.testing';
import {
  api,
  ok,
  redditStack,
  redditWorld,
  rulesBody,
  seedCommunity,
  seedOpportunity,
  subredditName,
  threadUrl,
  type Api,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(180_000);

interface Proj {
  id: string;
  status: string;
  revision: number;
}
interface Opp {
  id: string;
  status: string;
  policy: string;
  revision: number;
  ruleSnapshotId: string | null;
  policyNow: string;
  policyNowReasons: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Есть ли сеанс, ждущий блокировку строки таблицы `table` (до `ms`). */
async function lockWaiter(
  prisma: PrismaService,
  table: string,
  ms = 5000,
): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS "n" FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query ILIKE ${`%${table}%`}`;
    if (Number(r[0].n) > 0) return true;
    await sleep(25);
  }
  return false;
}

/** Транзакция, которую тест держит открытой до `release()`. */
function heldTx(
  db: SitesDb,
  accountId: string,
  body: (tx: Prisma.TransactionClient) => Promise<unknown>,
) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inside = new Promise<void>((r) => (entered = r));
  const done = db.forAccount(accountId).$transaction(
    async (tx) => {
      await body(tx as unknown as Prisma.TransactionClient);
      entered();
      await gate;
    },
    {
      timeout: 60_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
  return { inside, release, done };
}

ciDescribe('[AUD-m1] P-R M1: исправления аудита 15.10.2026', () => {
  let s: RedditStack;
  let w: RedditWorld;
  let po: Api;
  let ed: Api;
  let restoreEnv: () => void;

  beforeAll(async () => {
    s = await redditStack();
    w = await redditWorld(s, 'working');
    restoreEnv = useAdminEnv(w.acc.siteId);
    po = api(s, w.acc.accountId, w.team.product_owner);
    ed = api(s, w.acc.accountId, w.team.editor);
  });
  afterAll(async () => {
    restoreEnv?.();
    await s?.close();
  });

  describe('m1-1 / Р-RD-AUD-1: восстановление архивного проекта', () => {
    it('архив → сабреддиты недоступны; restore (PO) → сообщество, правила и возможности снова работают; дубль по имени — по-прежнему один на продукт; аудит transition', async () => {
      const c = await seedCommunity(po, w.P, { rules: 'allowed' });
      const p0 = ok<Proj>(await po.get(`${w.P}/projects/${c.projectId}`), 200);
      const arch = ok<Proj>(
        await po.post(`${w.P}/projects/${c.projectId}/archive`, {
          expectedRevision: p0.revision,
        }),
        200,
      );
      expect(arch.status).toBe('archived');

      // Второй проект продукта: сабреддит архивного — дубль (один на продукт).
      const v2 = ok<Proj>(
        await po.post(`${w.P}/projects`, {
          title: 'Research v2',
          locale: 'en',
          market: 'US',
        }),
        201,
      );
      const dup = await po.post(`${w.P}/communities`, {
        projectId: v2.id,
        community: `r/${c.name}`,
      });
      expect(dup.status).toBe(409);
      expect(dup.body.error.details).toMatchObject({
        reason: 'duplicate',
        existingId: c.communityId,
      });
      const comm = ok<{ revision: number }>(
        await po.get(`${w.P}/communities/${c.communityId}`),
        200,
      );
      const blocked = await po.patch(`${w.P}/communities/${c.communityId}`, {
        expectedRevision: comm.revision,
        topics: ['saas'],
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.details).toMatchObject({
        reason: 'project_archived',
      });

      // Неверная ревизия — 409 PUB_CONFLICT, без перехода.
      const stale = await po.post(`${w.P}/projects/${c.projectId}/restore`, {
        expectedRevision: p0.revision,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('PUB_CONFLICT');

      const key = randomUUID();
      const send = () =>
        po.post(`${w.P}/projects/${c.projectId}/restore`, {
          opKey: key,
          expectedRevision: arch.revision,
        });
      const back = ok<Proj>(await send(), 200);
      expect(back).toMatchObject({
        id: c.projectId,
        status: 'active',
        revision: arch.revision + 1,
      });
      // Повтор того же opKey — тот же ответ, без второго перехода.
      expect(ok<Proj>(await send(), 200)).toEqual(back);
      const audit = await s.prisma.pubAuditEvent.findMany({
        where: {
          productId: w.product.id,
          objectType: 'reddit_project',
          objectId: c.projectId,
          action: 'transition',
          toStatus: 'active',
        },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        fromStatus: 'archived',
        actor: `member:${w.team.product_owner.memberId}`,
      });

      // Активный проект восстанавливать нечего — 409 status.
      const again = await po.post(`${w.P}/projects/${c.projectId}/restore`, {
        expectedRevision: back.revision,
      });
      expect(again.status).toBe(409);
      expect(again.body.error).toMatchObject({
        code: 'PUB_TRANSITION_INVALID',
        details: { reason: 'status', from: 'active' },
      });

      // Сабреддит снова в работе: правка, новый снимок, возможность.
      ok(
        await po.patch(`${w.P}/communities/${c.communityId}`, {
          expectedRevision: comm.revision,
          topics: ['saas'],
        }),
        200,
      );
      ok(
        await po.post(
          `${w.P}/communities/${c.communityId}/rules`,
          rulesBody(c.name, 'allowed'),
        ),
        201,
      );
      ok(await seedOpportunity(po, w.P, c), 201);
    });

    it('роли: restore — reddit.manage (PO, ED); OP, AN, VW — 403 без перехода; чужой продукт — 404', async () => {
      const mk = async () => {
        const p = ok<Proj>(
          await po.post(`${w.P}/projects`, {
            title: 'Roles',
            locale: 'en',
            market: 'US',
          }),
          201,
        );
        return ok<Proj>(
          await po.post(`${w.P}/projects/${p.id}/archive`, {
            expectedRevision: p.revision,
          }),
          200,
        );
      };
      const p = await mk();
      for (const k of ['operator', 'analyst', 'viewer'] as const) {
        const r = await api(s, w.acc.accountId, w.team[k]).post(
          `${w.P}/projects/${p.id}/restore`,
          { expectedRevision: p.revision },
        );
        expect([k, r.status, r.body.error?.code]).toEqual([
          k,
          403,
          'PUB_ROLE_REQUIRED',
        ]);
      }
      const other = await redditWorld(s);
      const foreign = await api(s, other.acc.accountId, other.acc.owner).post(
        `${other.P}/projects/${p.id}/restore`,
        { expectedRevision: p.revision },
      );
      expect(foreign.status).toBe(404);
      expect(
        ok<Proj>(await po.get(`${w.P}/projects/${p.id}`), 200).status,
      ).toBe('archived');
      expect(
        ok<Proj>(
          await ed.post(`${w.P}/projects/${p.id}/restore`, {
            expectedRevision: p.revision,
          }),
          200,
        ).status,
      ).toBe('active');
    });

    it('Админка: rx/projects/:id/restore — тот же обработчик, актор admin:<userId> в аудите', async () => {
      const A = adminApi(s);
      ok(await A.postRaw('setup', {}), 200);
      const p = ok<Proj>(
        await A.post('rx/projects', {
          title: 'Admin restore',
          locale: 'en',
          market: 'US',
        }),
        201,
      );
      const a = ok<Proj>(
        await A.post(`rx/projects/${p.id}/archive`, {
          expectedRevision: p.revision,
        }),
        200,
      );
      const r = ok<Proj>(
        await A.post(`rx/projects/${p.id}/restore`, {
          expectedRevision: a.revision,
        }),
        200,
      );
      expect(r.status).toBe('active');
      const ev = await s.prisma.pubAuditEvent.findFirst({
        where: {
          objectId: p.id,
          action: 'transition',
          toStatus: 'active',
        },
      });
      expect(ev).toMatchObject({
        fromStatus: 'archived',
        actor: `admin:${ADMIN_USER}`,
      });
    });
  });

  describe('m1-2: каскад перепроверки и гонки (две транзакции)', () => {
    it('сценарий A: archive возможности (незафиксирован) ‖ новый снимок → после обоих коммитов возможность archived, каскад её не тронул', async () => {
      const c = await seedCommunity(po, w.P, { rules: 'allowed' });
      const x = ok<Opp>(await seedOpportunity(po, w.P, c), 201);
      expect(x.status).toBe('new');
      const svc = s.mod.get(RedditOpportunitiesService);
      const t1 = heldTx(s.mod.get(SitesDb), w.acc.accountId, (tx) =>
        svc.transition(
          tx as never,
          w.product,
          x.id,
          'archived',
          { actor: `member:${w.team.editor.memberId}`, now: new Date() },
          { expectedRevision: x.revision },
        ),
      );
      await t1.inside;
      const t2 = (async () =>
        po.post(
          `${w.P}/communities/${c.communityId}/rules`,
          rulesBody(c.name, 'restricted'),
        ))();
      // Новый снимок ждёт блокировку строки возможности (FOR UPDATE).
      expect(await lockWaiter(s.prisma, 'pub_reddit_opportunities')).toBe(true);
      t1.release();
      await t1.done;
      ok(await t2, 201);
      const after = ok<Opp>(await po.get(`${w.P}/opportunities/${x.id}`), 200);
      expect(after.status).toBe('archived');
      const cascade = await s.prisma.pubAuditEvent.count({
        where: {
          objectType: 'reddit_opportunity',
          objectId: x.id,
          toStatus: 'recheck_required',
        },
      });
      expect(cascade).toBe(0);
    });

    it('сценарий B: пересчёт score blocked → new (незафиксирован) ‖ новый снимок → снимок ждёт расчёт и переводит возможность в recheck_required', async () => {
      const c = await seedCommunity(po, w.P, {
        rules: 'allowed',
        reviewer: null,
      });
      const x = ok<Opp>(await seedOpportunity(po, w.P, c), 201);
      expect(x).toMatchObject({ status: 'blocked', policy: 'block' });
      ok(await po.post(`${w.P}/rules/${c.snapshotId}/review`), 200);
      const svc = s.mod.get(RedditOpportunitiesService);
      const t1 = heldTx(s.mod.get(SitesDb), w.acc.accountId, async (tx) => {
        const out = await svc.score(
          tx as never,
          w.product,
          x.id,
          { actor: `member:${w.team.editor.memberId}`, now: new Date() },
          { expectedRevision: x.revision },
        );
        expect(out.body).toMatchObject({
          status: 'new',
          policy: 'ok',
          ruleSnapshotId: c.snapshotId,
        });
      });
      await t1.inside;
      const t2 = (async () =>
        po.post(
          `${w.P}/communities/${c.communityId}/rules`,
          rulesBody(c.name, 'allowed'),
        ))();
      // Новый снимок ждёт блокировку строки сообщества (расчёт держит FOR SHARE).
      expect(await lockWaiter(s.prisma, 'pub_reddit_communities')).toBe(true);
      t1.release();
      await t1.done;
      const s2 = ok<{ id: string }>(await t2, 201);
      const after = ok<Opp>(await po.get(`${w.P}/opportunities/${x.id}`), 200);
      expect(after).toMatchObject({
        status: 'recheck_required',
        policy: 'recheck_required',
      });
      expect(after.ruleSnapshotId).not.toBe(s2.id);
      // Пересчёт по новому (непроверенному) снимку — block.
      const re = ok<Opp>(
        await po.post(`${w.P}/opportunities/${x.id}/score`, {
          expectedRevision: after.revision,
        }),
        200,
      );
      expect(re).toMatchObject({ status: 'blocked', ruleSnapshotId: s2.id });
    });
  });

  describe('m1-3: срок свежести — только действующее значение параметра', () => {
    it('approve 365 → снимок 100-дневной давности ok; revoke → умолчание 30, гейт recheck_required (rules_stale)', async () => {
      const c = await seedCommunity(po, w.P, {
        rules: 'allowed',
        checkedAt: new Date(Date.now() - 100 * 86_400_000),
      });
      const owner = api(s, w.acc.accountId, w.acc.owner);
      const base = `/publisher/products/${w.product.id}/parameters/reddit_rules_stale_days`;
      const pr = ok<{ proposalId: string; parameter: { revision: number } }>(
        await owner.post(`${base}/proposals`, { value: { days: 365 } }),
        201,
      );
      ok(
        await owner.post(`${base}/decision`, {
          toStatus: 'approved',
          proposalId: pr.proposalId,
          basis: 'Правила перевіряємо раз на рік',
          expectedRevision: pr.parameter.revision,
        }),
        200,
      );
      const o = ok<Opp>(await seedOpportunity(po, w.P, c), 201);
      expect(o).toMatchObject({ status: 'new', policy: 'ok', policyNow: 'ok' });
      const param = await s.prisma.pubParameter.findFirstOrThrow({
        where: { productId: w.product.id, key: 'reddit_rules_stale_days' },
      });
      ok(
        await owner.post(`${base}/decision`, {
          toStatus: 'revoked',
          basis: 'Повертаємось до типового терміну',
          expectedRevision: param.revision,
        }),
        200,
      );
      const card = ok<Opp>(await po.get(`${w.P}/opportunities/${o.id}`), 200);
      expect(card).toMatchObject({
        policyNow: 'recheck_required',
        policyNowReasons: ['rules_stale'],
      });
      const comm = ok<{ staleDays: number; rules: { state: string } }>(
        await po.get(`${w.P}/communities/${c.communityId}`),
        200,
      );
      expect(comm).toMatchObject({ staleDays: 30, rules: { state: 'stale' } });
      const q = await po.post(`${w.P}/opportunities/${o.id}/qualify`, {
        expectedRevision: o.revision,
      });
      expect(q.status).toBe(409);
      expect(q.body.error.details).toMatchObject({ reason: 'policy_recheck' });
    });
  });

  describe('m1-4: ники и ссылки на профили — 400 profile_ref во всех свободных полях P-R', () => {
    const PROFILE = 'https://www.reddit.com/user/AutoModerator/comments/x';
    const NICK = 'OP u/some_founder asks exactly this';
    const fieldsOf = (r: {
      status: number;
      body: { error: { details: { fields: unknown } } };
    }) => {
      expect(r.status).toBe(400);
      return (
        r.body.error.details.fields as Array<{ field: string; code: string }>
      ).filter((f) => f.code === 'profile_ref');
    };

    it('проект и запрос: title, market, phrase (создание и правка)', async () => {
      expect(
        fieldsOf(
          await po.post(`${w.P}/projects`, {
            title: `Pilot ${NICK}`,
            locale: 'en',
            market: 'reddit.com/u/someone',
          }),
        ).map((f) => f.field),
      ).toEqual(['title', 'market']);
      const p = ok<Proj>(
        await po.post(`${w.P}/projects`, {
          title: 'Clean',
          locale: 'en',
          market: 'US',
        }),
        201,
      );
      expect(
        fieldsOf(
          await po.patch(`${w.P}/projects/${p.id}`, {
            expectedRevision: p.revision,
            title: NICK,
          }),
        ).map((f) => f.field),
      ).toEqual(['title']);
      expect(
        fieldsOf(
          await po.post(`${w.P}/keywords`, {
            projectId: p.id,
            phrase: 'ask u/helper_bot',
            intent: 'recommendation',
            priority: 1,
          }),
        ).map((f) => f.field),
      ).toEqual(['phrase']);
      const k = ok<{ id: string; revision: number }>(
        await po.post(`${w.P}/keywords`, {
          projectId: p.id,
          phrase: 'site chat widget',
          intent: 'recommendation',
          priority: 1,
        }),
        201,
      );
      expect(
        fieldsOf(
          await po.patch(`${w.P}/keywords/${k.id}`, {
            expectedRevision: k.revision,
            phrase: 'see /user/helper_bot',
          }),
        ).map((f) => f.field),
      ).toEqual(['phrase']);
    });

    it('сообщество и правила: descriptionManual, topics[i], sourceUrl', async () => {
      const p = ok<Proj>(
        await po.post(`${w.P}/projects`, {
          title: 'Communities',
          locale: 'en',
          market: 'US',
        }),
        201,
      );
      const name = subredditName('prf');
      expect(
        fieldsOf(
          await po.post(`${w.P}/communities`, {
            projectId: p.id,
            community: `r/${name}`,
            descriptionManual: `Run by ${NICK}`,
            topics: ['saas', 'u/mod_name'],
          }),
        ).map((f) => f.field),
      ).toEqual(['descriptionManual', 'topics[1]']);
      const c = ok<{ id: string; revision: number }>(
        await po.post(`${w.P}/communities`, {
          projectId: p.id,
          community: `r/${name}`,
        }),
        201,
      );
      expect(
        fieldsOf(
          await po.patch(`${w.P}/communities/${c.id}`, {
            expectedRevision: c.revision,
            descriptionManual: NICK,
            topics: ['user/mod_name'],
          }),
        ).map((f) => f.field),
      ).toEqual(['descriptionManual', 'topics[0]']);
      expect(
        fieldsOf(
          await po.post(`${w.P}/communities/${c.id}/rules`, {
            ...rulesBody(name, 'allowed'),
            sourceUrl: PROFILE,
          }),
        ).map((f) => f.field),
      ).toEqual(['sourceUrl']);
    });

    it('возможность: factors.<k>.why (создание и правка), reason перехода', async () => {
      const c = await seedCommunity(po, w.P, { rules: 'allowed' });
      const bad = {
        topic_fit: { value: 80, why: NICK },
      };
      expect(
        fieldsOf(
          await po.post(`${w.P}/opportunities`, {
            projectId: c.projectId,
            communityId: c.communityId,
            threadUrl: threadUrl(c.name),
            titleManual: 'Which widget?',
            intent: 'recommendation',
            factors: bad,
          }),
        ),
      ).toEqual([{ field: 'factors.topic_fit.why', code: 'profile_ref' }]);
      const o = ok<Opp>(await seedOpportunity(po, w.P, c), 201);
      expect(
        fieldsOf(
          await po.patch(`${w.P}/opportunities/${o.id}`, {
            expectedRevision: o.revision,
            factors: bad,
          }),
        ),
      ).toEqual([{ field: 'factors.topic_fit.why', code: 'profile_ref' }]);
      expect(
        fieldsOf(
          await po.post(`${w.P}/opportunities/${o.id}/skip`, {
            expectedRevision: o.revision,
            reason: `duplicate of ${PROFILE}`,
          }),
        ),
      ).toEqual([{ field: 'reason', code: 'profile_ref' }]);
      // Ничего не записано.
      expect(
        ok<Opp>(await po.get(`${w.P}/opportunities/${o.id}`), 200),
      ).toMatchObject({ status: 'new', revision: o.revision });
    });
  });
});
