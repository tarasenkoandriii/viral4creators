/**
 * P-R M1 — раунд исправлений внутреннего аудита (`pub-r-m1-audit.md`):
 *  - S1-1/S1-2: доказательства P-R (первоисточник правил, выдержка треда)
 *    не правятся общим `PATCH /sources/:id` (409 `reddit_evidence_locked`),
 *    выдержка меняется новой редакцией через `PATCH …/opportunities/:id`;
 *  - S2-1: они скрыты из общих `/sources` (список, CSV, карточка → 404);
 *  - S2-2: отзыв первоисточника → гейт `block` (`rules_source_revoked`) и
 *    перепроверка зависимых возможностей;
 *  - S2-3: гейт «сейчас» (`policyNow`) пересчитывается при чтении; значение
 *    `reddit_rules_stale_days` ≠ 30 действительно влияет;
 *  - S3-1: гонка дублей → 409 `{existingId}`; S3-2: ники и `r/u_*`;
 *    S3-3: второй продукт того же кабинета, повторный архив; S3-6:
 *    операции при архивном проекте или сообществе → 409;
 *  - `factors.policy_risk` — машиночитаемые `reasons`, `why: null`.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { SitesDb } from '../../prisma/sites-db.service';
import { listOpportunities } from '../../modules/publisher/reddit/lists';
import {
  seedProduct,
  seedSite,
} from '../../modules/publisher/testing/fixtures.testing';
import {
  api,
  ok,
  redditStack,
  redditWorld,
  rulesBody,
  seedCommunity,
  seedOpportunity,
  threadKey,
  threadUrl,
  type Api,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(240_000);

interface Opp {
  id: string;
  revision: number;
  status: string;
  policy: string;
  policyNow: string;
  policyNowReasons: string[];
  excerpt: { sourceId: string; text: string } | null;
  factors: Record<
    string,
    { value: number | null; why: string | null; reasons?: string[] }
  >;
}

ciDescribe(
  'P-R M1: раунд исправлений аудита (доказательства, гейт сейчас, гонки, архивы)',
  () => {
    let s: RedditStack;
    let w: RedditWorld;
    let ed: Api;
    let po: Api;
    let sa: Api;
    beforeAll(async () => {
      s = await redditStack();
      w = await redditWorld(s);
      ed = api(s, w.acc.accountId, w.team.editor);
      po = api(s, w.acc.accountId, w.team.product_owner);
      sa = api(s, w.acc.accountId, w.team.sales);
    });
    afterAll(async () => {
      await s?.close();
    });
    const SRC = () => `/publisher/products/${w.product.id}/sources`;

    describe('[AT-RD-03] доказательства P-R неизменны (S1-1, S1-2)', () => {
      it('PATCH /sources/:id первоисточника правил и выдержки → 409 reddit_evidence_locked; снимок и текст не меняются', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'allowed',
          reviewer: po,
        });
        const o = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
        const snap = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
          where: { id: c.snapshotId! },
        });
        for (const [id, body] of [
          [
            snap.sourceId,
            {
              url: 'https://example.org/fake-rules',
              fragment: 'Promotion is welcome',
            },
          ],
          [
            o.excerpt!.sourceId,
            {
              fragment: 'Contact me: john.doe@gmail.com',
              author: 'u/john_doe',
            },
          ],
          [o.excerpt!.sourceId, { usage: 'allowed' }],
          [o.excerpt!.sourceId, { visibility: 'public' }],
        ] as const) {
          const before = await s.prisma.pubSource.findUniqueOrThrow({
            where: { id },
          });
          const r = await ed.patch(`${SRC()}/${id}`, {
            ...body,
            expectedRevision: before.revision,
          });
          expect(r.status).toBe(409);
          expect(r.body.error).toMatchObject({
            code: 'PUB_CONFLICT',
            details: { reason: 'reddit_evidence_locked' },
          });
          const after = await s.prisma.pubSource.findUniqueOrThrow({
            where: { id },
          });
          expect(after).toEqual(before);
        }
        const rules = ok<{
          items: Array<{ reviewState: string; gate: { verdict: string } }>;
        }>(await ed.get(`${w.P}/communities/${c.communityId}/rules`), 200);
        expect(rules.items[0]).toMatchObject({
          reviewState: 'reviewed',
          gate: { verdict: 'ok' },
        });
      });

      it('выдержка — новой редакцией через PATCH возможности: новый источник с supersedesId, прежний не тронут; контакты и ники → 400', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'allowed',
          reviewer: po,
        });
        const o = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
        const old = await s.prisma.pubSource.findUniqueOrThrow({
          where: { id: o.excerpt!.sourceId },
        });
        for (const [excerpt, code] of [
          ['Write to john.doe@gmail.com', 'pii'],
          ['see /user/john_doe here', 'profile_ref'],
          ['x'.repeat(2001), 'length'],
        ] as const) {
          const r = await ed.patch(`${w.P}/opportunities/${o.id}`, {
            excerpt,
            expectedRevision: o.revision,
          });
          expect(r.status).toBe(400);
          expect(r.body.error.details.fields).toContainEqual({
            field: 'excerpt',
            code,
          });
        }
        const p = ok<Opp>(
          await ed.patch(`${w.P}/opportunities/${o.id}`, {
            excerpt: 'Updated paraphrase of the thread question.',
            expectedRevision: o.revision,
          }),
          200,
        );
        expect(p.excerpt!.sourceId).not.toBe(old.id);
        expect(p.excerpt!.text).toBe(
          'Updated paraphrase of the thread question.',
        );
        const nw = await s.prisma.pubSource.findUniqueOrThrow({
          where: { id: p.excerpt!.sourceId },
        });
        expect(nw).toMatchObject({
          supersedesId: old.id,
          origin: 'reddit',
          kind: 'discussion',
          usage: 'restricted',
          visibility: 'private',
          author: null,
        });
        expect(
          await s.prisma.pubSource.findUniqueOrThrow({ where: { id: old.id } }),
        ).toEqual(old);
        const audit = await s.prisma.pubAuditEvent.findMany({
          where: { productId: w.product.id, objectId: nw.id, action: 'create' },
        });
        expect(audit).toHaveLength(1);
      });
    });

    describe('[AT-RD-02] доказательства P-R скрыты из общих /sources (S2-1)', () => {
      it('список, фильтры, CSV — без Reddit-источников; карточка → 404; обычный источник виден; SA видит только обычные', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'allowed',
          reviewer: po,
        });
        const o = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
        const snap = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
          where: { id: c.snapshotId! },
        });
        const own = ok<{ id: string }>(
          await ed.post(SRC(), {
            kind: 'manual_text',
            title: 'Власний текст',
            fragment: 'Текст продукту',
            visibility: 'public',
            usage: 'allowed',
          }),
          201,
        );
        const hidden = [snap.sourceId, o.excerpt!.sourceId];
        for (const who of [ed, sa]) {
          for (const q of [
            {},
            { kind: 'discussion' },
            { kind: 'url' },
            { limit: '100' },
          ] as Array<Record<string, string>>) {
            const list = ok<{ items: Array<{ id: string }> }>(
              await who.get(SRC(), q),
              200,
            );
            expect(list.items.filter((x) => hidden.includes(x.id))).toEqual([]);
          }
          const csv = await who.get(SRC(), { format: 'csv' });
          expect(csv.status).toBe(200);
          for (const id of hidden) expect(csv.text).not.toContain(id);
          expect(csv.text).toContain(own.id);
          for (const id of hidden) {
            const r = await who.get(`${SRC()}/${id}`);
            expect(r.status).toBe(404);
            expect(r.body.error).toEqual(
              expect.objectContaining({ code: 'PUB_NOT_FOUND' }),
            );
          }
          expect((await who.get(`${SRC()}/${own.id}`)).status).toBe(200);
        }
        // SA к разделу доступа не имеет.
        expect((await sa.get(`${w.P}/opportunities`)).status).toBe(403);
      });
    });

    describe('[AT-RD-04] отзыв первоисточника и гейт «сейчас» (S2-2, S2-3)', () => {
      it('отзыв первоисточника правил → block rules_source_revoked; new/qualified → recheck_required с аудитом; новая возможность — blocked; qualify → 409', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'allowed',
          reviewer: po,
        });
        const a = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
        const b = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
        ok(
          await ed.post(`${w.P}/opportunities/${b.id}/qualify`, {
            expectedRevision: b.revision,
          }),
          200,
        );
        const snap = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
          where: { id: c.snapshotId! },
        });
        ok(
          await po.post(`${SRC()}/${snap.sourceId}/revoke`, {
            reason: 'Правила зняті модераторами',
          }),
          200,
        );
        const comm = ok<{
          rules: { gate: { verdict: string; reasons: string[] } };
        }>(await ed.get(`${w.P}/communities/${c.communityId}`), 200);
        expect(comm.rules.gate).toMatchObject({
          verdict: 'block',
          reasons: ['rules_source_revoked'],
        });
        for (const id of [a.id, b.id]) {
          const v = ok<Opp>(await ed.get(`${w.P}/opportunities/${id}`), 200);
          expect(v).toMatchObject({
            status: 'recheck_required',
            policy: 'block',
            policyNow: 'block',
            policyNowReasons: ['rules_source_revoked'],
          });
        }
        const audit = await s.prisma.pubAuditEvent.findMany({
          where: {
            productId: w.product.id,
            objectType: 'reddit_opportunity',
            objectId: { in: [a.id, b.id] },
            toStatus: 'recheck_required',
          },
        });
        expect(audit).toHaveLength(2);
        expect(ok<Opp>(await seedOpportunity(ed, w.P, c), 201)).toMatchObject({
          status: 'blocked',
          policy: 'block',
        });
        const cur = ok<Opp>(await ed.get(`${w.P}/opportunities/${a.id}`), 200);
        const q = await ed.post(`${w.P}/opportunities/${cur.id}/qualify`, {
          expectedRevision: cur.revision,
        });
        expect(q.status).toBe(409);
        expect(q.body.error.details).toMatchObject({
          reason: 'policy_block',
          reasons: ['rules_source_revoked'],
        });
      });

      it('reddit_rules_stale_days=2 (решением владельца) делает снимок 3-дневной давности stale: policyNow в карточке, списке и CSV, хранимое policy — «на момент оценки»', async () => {
        // Отдельный продукт — параметр не влияет на остальные тесты.
        const site = await seedSite(s.prisma, w.acc.accountId);
        const p2 = await seedProduct(s.prisma, {
          accountId: w.acc.accountId,
          siteId: site,
          kind: 'test',
        });
        const owner = api(s, w.acc.accountId, w.acc.owner);
        const P2 = `/publisher/products/${p2.id}/reddit`;
        const c = await seedCommunity(owner, P2, {
          rules: 'allowed',
          reviewer: owner,
          checkedAt: new Date(Date.now() - 3 * 86_400_000),
        });
        const o = ok<Opp>(await seedOpportunity(owner, P2, c), 201);
        const q = ok<Opp>(
          await owner.post(`${P2}/opportunities/${o.id}/qualify`, {
            expectedRevision: o.revision,
          }),
          200,
        );
        expect(q).toMatchObject({
          status: 'qualified',
          policy: 'ok',
          policyNow: 'ok',
        });
        const pr = ok<{ proposalId: string; parameter: { revision: number } }>(
          await owner.post(
            `/publisher/products/${p2.id}/parameters/reddit_rules_stale_days/proposals`,
            {
              value: { days: 2 },
            },
          ),
          201,
        );
        ok(
          await owner.post(
            `/publisher/products/${p2.id}/parameters/reddit_rules_stale_days/decision`,
            {
              toStatus: 'approved',
              proposalId: pr.proposalId,
              basis: 'Перевіряти правила кожні два дні',
              expectedRevision: pr.parameter.revision,
            },
          ),
          200,
        );
        const card = ok<Opp>(
          await owner.get(`${P2}/opportunities/${o.id}`),
          200,
        );
        expect(card).toMatchObject({
          status: 'qualified',
          policy: 'ok',
          policyNow: 'recheck_required',
          policyNowReasons: ['rules_stale'],
        });
        const list = ok<{ items: Opp[] }>(
          await owner.get(`${P2}/opportunities`),
          200,
        );
        expect(list.items[0]).toMatchObject({ policyNow: 'recheck_required' });
        const csv = await owner.get(`${P2}/opportunities`, { format: 'csv' });
        expect(csv.text).toContain(
          ',ok,,recheck_required,rules_stale,qualified,',
        );
        const comm = ok<{ staleDays: number; rules: { state: string } }>(
          await owner.get(`${P2}/communities/${c.communityId}`),
          200,
        );
        expect(comm).toMatchObject({ staleDays: 2, rules: { state: 'stale' } });
        const n = ok<Opp>(await seedOpportunity(owner, P2, c), 201);
        expect(n).toMatchObject({
          status: 'recheck_required',
          policy: 'recheck_required',
        });
      });

      it('policy_risk: машиночитаемые reasons, why = null', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'restricted',
          reviewer: po,
        });
        const o = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
        expect(o.factors.policy_risk).toEqual({
          value: 50,
          why: null,
          reasons: ['promotion_allowed_with_conditions', 'links_restricted'],
        });
        const none = await seedCommunity(ed, w.P, { rules: null });
        const x = ok<Opp>(await seedOpportunity(ed, w.P, none), 201);
        expect(x.factors.policy_risk).toEqual({
          value: 100,
          why: null,
          reasons: ['rules_missing'],
        });
      });
    });

    describe('[AT-RD-05] гонка дублей → 409 {existingId} (S3-1)', () => {
      it('3 параллельных создания одного треда, запроса и сообщества: один 201, остальные 409 с existingId созданного', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'allowed',
          reviewer: po,
        });
        const key = threadKey();
        const race = async (
          fire: () => Promise<{
            status: number;
            body: { data?: { id: string }; error?: { details?: unknown } };
          }>,
        ) => {
          const rs = await Promise.all([fire(), fire(), fire()]);
          const created = rs.filter((r) => r.status === 201);
          expect(created).toHaveLength(1);
          const id = created[0].body.data!.id;
          for (const r of rs.filter((x) => x.status !== 201)) {
            expect(r.status).toBe(409);
            expect(r.body.error!.details).toEqual({
              reason: 'duplicate',
              existingId: id,
            });
          }
        };
        await race(() =>
          seedOpportunity(ed, w.P, c, { threadUrl: threadUrl(c.name, key) }),
        );
        await race(() =>
          ed.post(`${w.P}/keywords`, {
            projectId: c.projectId,
            phrase: `race ${key}`,
            intent: 'other',
            priority: 1,
          }),
        );
        await race(() =>
          ed.post(`${w.P}/communities`, {
            projectId: c.projectId,
            community: `r/race_${key}`.slice(0, 23),
          }),
        );
      });
    });

    describe('[AT-RD-15] ники и профили (S3-2)', () => {
      it('r/u_* — не сообщество и не тред (400 profile_ref); /user/, u/, полноширинное u／ — 400 profile_ref в выдержке, заголовке, angle, правилах', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'allowed',
          reviewer: po,
        });
        // UI-аудит S3-2: стабильный код `profile_ref` для `r/u_*`.
        for (const community of [
          'r/u_john_doe',
          'u_john_doe',
          '/R/U_JOHN',
          'https://www.reddit.com/r/u_john/',
        ])
          expect(
            (
              await ed.post(`${w.P}/communities`, {
                projectId: c.projectId,
                community,
              })
            ).body.error.details.fields,
          ).toEqual([{ field: 'community', code: 'profile_ref' }]);
        expect(
          (
            await seedOpportunity(ed, w.P, c, {
              threadUrl: 'https://www.reddit.com/r/u_john/comments/abc123/x',
            })
          ).body.error.details.fields,
        ).toContainEqual({ field: 'threadUrl', code: 'profile_ref' });
        for (const [field, value] of [
          ['excerpt', 'see /user/john_doe here'],
          ['excerpt', 'by u／john_doe'],
          ['excerpt', 'https://reddit.com/u/john_doe'],
          ['excerpt', 'check r/u_john_doe'],
          ['titleManual', 'Question from u/john_doe'],
          ['angle', 'Reply to /u/john_doe'],
        ] as const) {
          const r = await seedOpportunity(ed, w.P, c, { [field]: value });
          expect({
            field,
            value,
            fields: r.body.error?.details?.fields,
          }).toEqual({
            field,
            value,
            fields: expect.arrayContaining([{ field, code: 'profile_ref' }]),
          });
        }
        const none = await seedCommunity(ed, w.P, { rules: null });
        const R = `${w.P}/communities/${none.communityId}/rules`;
        expect(
          (
            await ed.post(R, {
              ...rulesBody(none.name, 'allowed'),
              sourceExcerpt: 'Ask u/AutoModerator',
            })
          ).body.error.details.fields,
        ).toEqual([{ field: 'sourceExcerpt', code: 'profile_ref' }]);
        expect(
          (
            await ed.post(R, {
              ...rulesBody(none.name, 'allowed'),
              conditions: ['ok', 'ping /u/mod_team'],
            })
          ).body.error.details.fields,
        ).toEqual([{ field: 'conditions[1]', code: 'profile_ref' }]);
      });
    });

    describe('[AT-RD-01] второй продукт того же кабинета (S3-3)', () => {
      it('объекты продукта 2 не видны и не доступны из продукта 1 (списки пусты от них, карточки и мутации → 404)', async () => {
        const site = await seedSite(s.prisma, w.acc.accountId);
        const p2 = await seedProduct(s.prisma, {
          accountId: w.acc.accountId,
          siteId: site,
          kind: 'test',
        });
        const owner = api(s, w.acc.accountId, w.acc.owner);
        const P2 = `/publisher/products/${p2.id}/reddit`;
        const c2 = await seedCommunity(owner, P2, {
          rules: 'allowed',
          reviewer: owner,
        });
        const o2 = ok<Opp>(await seedOpportunity(owner, P2, c2), 201);
        const k2 = ok<{ id: string }>(
          await owner.post(`${P2}/keywords`, {
            projectId: c2.projectId,
            phrase: 'p2 phrase',
            intent: 'other',
            priority: 1,
          }),
          201,
        );
        for (const [path, q] of [
          ['opportunities', {}],
          ['opportunities', { projectId: c2.projectId }],
          ['opportunities', { communityId: c2.communityId }],
          ['communities', {}],
          ['communities', { projectId: c2.projectId }],
          ['keywords', { projectId: c2.projectId }],
          ['projects', {}],
        ] as const) {
          const ids = ok<{ items: Array<{ id: string }> }>(
            await owner.get(`${w.P}/${path}`, q),
            200,
          ).items.map((x) => x.id);
          expect(
            ids.filter((x) =>
              [o2.id, c2.communityId, c2.projectId, k2.id].includes(x),
            ),
          ).toEqual([]);
        }
        for (const path of [
          `opportunities/${o2.id}`,
          `communities/${c2.communityId}`,
          `communities/${c2.communityId}/rules`,
          `projects/${c2.projectId}`,
        ])
          expect((await owner.get(`${w.P}/${path}`)).status).toBe(404);
        expect(
          (await owner.post(`${w.P}/rules/${c2.snapshotId}/review`)).status,
        ).toBe(404);
        expect(
          (
            await owner.post(`${w.P}/opportunities/${o2.id}/skip`, {
              expectedRevision: o2.revision,
            })
          ).status,
        ).toBe(404);
        expect(
          (
            await owner.patch(`${w.P}/keywords/${k2.id}`, {
              priority: 2,
              expectedRevision: 1,
            })
          ).status,
        ).toBe(404);
        // Создание в продукте 1 со ссылками на объекты продукта 2 → 404.
        expect(
          (
            await owner.post(`${w.P}/opportunities`, {
              projectId: c2.projectId,
              communityId: c2.communityId,
              threadUrl: threadUrl(c2.name),
              titleManual: 'x',
              intent: 'other',
            })
          ).status,
        ).toBe(404);
      });
    });

    describe('[AT-RD-04] архивы (S3-3, S3-6)', () => {
      it('повторный archive → 409 status; при архивном сообществе qualify/score/PATCH → 409 community_archived (skip/archive можно); при архивном проекте createRules/PATCH сообщества/PATCH запроса → 409 project_archived', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'allowed',
          reviewer: po,
        });
        const a = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
        const b = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
        const arch = ok<Opp>(
          await ed.post(`${w.P}/opportunities/${a.id}/archive`, {
            expectedRevision: a.revision,
          }),
          200,
        );
        const again = await ed.post(`${w.P}/opportunities/${a.id}/archive`, {
          expectedRevision: arch.revision,
        });
        expect(again.status).toBe(409);
        expect(again.body.error.details).toMatchObject({
          reason: 'status',
          from: 'archived',
        });
        const comm = ok<{ revision: number }>(
          await ed.get(`${w.P}/communities/${c.communityId}`),
          200,
        );
        ok(
          await ed.patch(`${w.P}/communities/${c.communityId}`, {
            status: 'archived',
            expectedRevision: comm.revision,
          }),
          200,
        );
        for (const r of [
          await ed.post(`${w.P}/opportunities/${b.id}/qualify`, {
            expectedRevision: b.revision,
          }),
          await ed.post(`${w.P}/opportunities/${b.id}/score`, {
            expectedRevision: b.revision,
          }),
          await ed.patch(`${w.P}/opportunities/${b.id}`, {
            angle: 'x',
            expectedRevision: b.revision,
          }),
        ]) {
          expect(r.status).toBe(409);
          expect(r.body.error.details).toMatchObject({
            reason: 'community_archived',
          });
        }
        ok(
          await ed.post(`${w.P}/opportunities/${b.id}/skip`, {
            expectedRevision: b.revision,
          }),
          200,
        );
        // Архивный проект.
        const c2 = await seedCommunity(ed, w.P, { rules: null });
        const k = ok<{ id: string; revision: number }>(
          await ed.post(`${w.P}/keywords`, {
            projectId: c2.projectId,
            phrase: `arch ${threadKey()}`,
            intent: 'other',
            priority: 1,
          }),
          201,
        );
        const proj = ok<{ revision: number }>(
          await ed.get(`${w.P}/projects/${c2.projectId}`),
          200,
        );
        ok(
          await ed.post(`${w.P}/projects/${c2.projectId}/archive`, {
            expectedRevision: proj.revision,
          }),
          200,
        );
        const comm2 = ok<{ revision: number }>(
          await ed.get(`${w.P}/communities/${c2.communityId}`),
          200,
        );
        for (const r of [
          await ed.post(
            `${w.P}/communities/${c2.communityId}/rules`,
            rulesBody(c2.name, 'allowed'),
          ),
          await ed.patch(`${w.P}/communities/${c2.communityId}`, {
            topics: ['x'],
            expectedRevision: comm2.revision,
          }),
          await ed.patch(`${w.P}/keywords/${k.id}`, {
            priority: 2,
            expectedRevision: k.revision,
          }),
        ]) {
          expect(r.status).toBe(409);
          expect(r.body.error.details).toMatchObject({
            reason: 'project_archived',
          });
        }
      });
    });
    describe('Раунд 2 (реаудит N-1, N-2, N-4, N-6)', () => {
      it('[AT-RD-03] N-1: правка выдержки поверх отозванной — 409 PUB_SOURCE_NOT_ALLOWED {revoked} и на текст, и на null; ответ отзыва без текста и URL (N-6b)', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'allowed',
          reviewer: po,
        });
        const o = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
        const sid = o.excerpt!.sourceId;
        const text = o.excerpt!.text;
        const rv = ok<{
          source: Record<string, unknown>;
          revocationId: string;
        }>(
          await po.post(`${SRC()}/${sid}/revoke`, {
            reason: 'Автор треду попросив прибрати цитату',
          }),
          200,
        );
        expect(rv.source).toMatchObject({
          id: sid,
          usage: 'revoked',
          url: null,
          title: null,
          author: null,
          externalRef: null,
          fragment: '',
        });
        expect(JSON.stringify(rv)).not.toContain(text);
        expect(JSON.stringify(rv)).not.toContain('reddit.com');
        const stored = (
          await s.prisma.pubIdempotencyKey.findMany({
            where: { accountId: w.acc.accountId },
          })
        )
          .map((k) => JSON.stringify(k.responseBody))
          .filter((b) => b.includes(rv.revocationId));
        expect(stored).toHaveLength(1);
        expect(stored[0]).not.toContain(text);
        const before = await s.prisma.pubSource.count({
          where: { productId: w.product.id },
        });
        const cur = ok<Opp>(await ed.get(`${w.P}/opportunities/${o.id}`), 200);
        expect(cur.excerpt).toMatchObject({ sourceId: sid, usage: 'revoked' });
        for (const excerpt of [text, 'Зовсім інший текст виписки', null]) {
          const r = await ed.patch(`${w.P}/opportunities/${o.id}`, {
            excerpt,
            expectedRevision: cur.revision,
          });
          expect(r.status).toBe(409);
          expect(r.body.error).toMatchObject({
            code: 'PUB_SOURCE_NOT_ALLOWED',
            details: { sourceIds: [sid], reason: 'revoked' },
          });
        }
        expect(
          await s.prisma.pubSource.count({
            where: { productId: w.product.id },
          }),
        ).toBe(before);
        expect(
          await s.prisma.pubSource.count({ where: { supersedesId: sid } }),
        ).toBe(0);
        // Остальные поля возможности правятся как обычно.
        expect(
          ok<Opp>(
            await ed.patch(`${w.P}/opportunities/${o.id}`, {
              angle: 'Показати відповіді лише з документації',
              expectedRevision: cur.revision,
            }),
            200,
          ).excerpt,
        ).toMatchObject({ sourceId: sid, usage: 'revoked' });
        // Неотозванную выдержку `null` отвязывает (контракт).
        const o2 = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
        expect(
          ok<Opp>(
            await ed.patch(`${w.P}/opportunities/${o2.id}`, {
              excerpt: null,
              expectedRevision: o2.revision,
            }),
            200,
          ).excerpt,
        ).toBeNull();
      });

      it('[AT-RD-04] N-2/N-6: новый проверенный снимок → policyNow=recheck_required [rules_changed] в карточке, списке, CSV и фильтре ?policyNow; score → ok', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'allowed',
          reviewer: po,
        });
        const o = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
        const q = ok<Opp>(
          await ed.post(`${w.P}/opportunities/${o.id}/qualify`, {
            expectedRevision: o.revision,
          }),
          200,
        );
        expect(q).toMatchObject({ status: 'qualified', policyNow: 'ok' });
        const ok2 = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
        const v2 = ok<{ id: string }>(
          await ed.post(
            `${w.P}/communities/${c.communityId}/rules`,
            rulesBody(c.name, 'allowed'),
          ),
          201,
        );
        ok(await po.post(`${w.P}/rules/${v2.id}/review`), 200);
        const card = ok<Opp>(await ed.get(`${w.P}/opportunities/${o.id}`), 200);
        expect(card).toMatchObject({
          status: 'recheck_required',
          policyNow: 'recheck_required',
          policyNowReasons: ['rules_changed'],
        });
        // Живой гейт, а не хранимая причина каскада: подменим хранимую.
        await s.prisma.pubRedditOpportunity.update({
          where: { id: o.id },
          data: { policyReasons: [] },
        });
        expect(
          ok<Opp>(await ed.get(`${w.P}/opportunities/${o.id}`), 200),
        ).toMatchObject({
          policyNow: 'recheck_required',
          policyNowReasons: ['rules_changed'],
        });
        const filtered = await ed.get(`${w.P}/opportunities`, {
          communityId: c.communityId,
          policyNow: 'recheck_required',
        });
        expect(filtered.status).toBe(200);
        const ids = (filtered.body.data.items as Opp[]).map((x) => x.id).sort();
        expect(ids).toEqual([o.id, ok2.id].sort());
        for (const x of filtered.body.data.items as Opp[])
          expect(x.policyNowReasons).toEqual(['rules_changed']);
        const okList = await ed.get(`${w.P}/opportunities`, {
          communityId: c.communityId,
          policyNow: 'ok',
        });
        expect((okList.body.data.items as Opp[]).map((x) => x.id)).toEqual([]);
        const csv = await ed.get(`${w.P}/opportunities`, {
          communityId: c.communityId,
          policyNow: 'recheck_required',
          format: 'csv',
        });
        expect(csv.status).toBe(200);
        const lines = csv.text.trim().split('\n');
        expect(lines).toHaveLength(3);
        for (const l of lines.slice(1))
          expect(l).toContain(',recheck_required,rules_changed,');
        const bad = await ed.get(`${w.P}/opportunities`, {
          policyNow: 'maybe',
        });
        expect(bad.status).toBe(400);
        expect(bad.body.error.details.fields).toEqual([
          { field: 'policyNow', code: 'enum' },
        ]);
        // Пересчёт по текущему снимку снимает rules_changed.
        const sc = ok<Opp>(
          await ed.post(`${w.P}/opportunities/${o.id}/score`, {
            expectedRevision: card.revision,
          }),
          200,
        );
        expect(sc).toMatchObject({ policy: 'ok', policyNow: 'ok' });
        const okNow = await ed.get(`${w.P}/opportunities`, {
          communityId: c.communityId,
          policyNow: 'ok',
        });
        expect((okNow.body.data.items as Opp[]).map((x) => x.id)).toEqual([
          o.id,
        ]);
      });

      it('N-6: фильтр policyNow листает пачками — курсор nextBefore и limit верны при редких совпадениях', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'allowed',
          reviewer: po,
        });
        const made: string[] = [];
        for (let i = 0; i < 5; i++)
          made.push(ok<Opp>(await seedOpportunity(ed, w.P, c), 201).id);
        // Две «старые» оценки по прежнему снимку: rules_changed.
        const v2 = ok<{ id: string }>(
          await ed.post(
            `${w.P}/communities/${c.communityId}/rules`,
            rulesBody(c.name, 'allowed'),
          ),
          201,
        );
        ok(await po.post(`${w.P}/rules/${v2.id}/review`), 200);
        for (const id of made.slice(1, 4)) {
          const cur = ok<Opp>(await ed.get(`${w.P}/opportunities/${id}`), 200);
          ok(
            await ed.post(`${w.P}/opportunities/${id}/score`, {
              expectedRevision: cur.revision,
            }),
            200,
          );
        }
        const want = [made[0], made[4]].sort().reverse();
        const p1 = await ed.get(`${w.P}/opportunities`, {
          communityId: c.communityId,
          policyNow: 'recheck_required',
          limit: '1',
        });
        expect((p1.body.data.items as Opp[]).map((x) => x.id)).toEqual([
          want[0],
        ]);
        expect(p1.body.data.nextBefore).toBe(want[0]);
        const p2 = await ed.get(`${w.P}/opportunities`, {
          communityId: c.communityId,
          policyNow: 'recheck_required',
          limit: '1',
          before: want[0],
        });
        expect((p2.body.data.items as Opp[]).map((x) => x.id)).toEqual([
          want[1],
        ]);
        expect(p2.body.data.nextBefore).toBeNull();
        // Пачки меньше страницы: просмотр идёт дальше первой пачки.
        for (const batch of [1, 2, 3]) {
          const got = await s.mod
            .get(SitesDb)
            .forAccount(w.acc.accountId)
            .$transaction((tx) =>
              listOpportunities(
                tx,
                w.product.id,
                {
                  take: 10,
                  communityId: c.communityId,
                  policyNow: 'recheck_required',
                },
                new Date(),
                batch,
              ),
            );
          expect({ batch, ids: got.map((x) => x.id) }).toEqual({
            batch,
            ids: want,
          });
        }
      });

      it('[AT-RD-05] N-2: параллельная смена фразы двух запросов на одну — один 200, остальные 409 {duplicate, existingId}', async () => {
        const c = await seedCommunity(ed, w.P, { rules: null });
        const key = threadKey();
        const kws: Array<{ id: string; revision: number }> = [];
        for (let i = 0; i < 4; i++)
          kws.push(
            ok(
              await ed.post(`${w.P}/keywords`, {
                projectId: c.projectId,
                phrase: `rename ${i} ${key}`,
                intent: 'other',
                priority: 1,
              }),
              201,
            ),
          );
        const rs = await Promise.all(
          kws.map((k) =>
            ed.patch(`${w.P}/keywords/${k.id}`, {
              phrase: `same phrase ${key}`,
              expectedRevision: k.revision,
            }),
          ),
        );
        const won = rs.filter((r) => r.status === 200);
        expect(won).toHaveLength(1);
        const id = (won[0].body.data as { id: string }).id;
        for (const r of rs.filter((x) => x.status !== 200)) {
          expect(r.status).toBe(409);
          expect(r.body.error.details).toEqual({
            reason: 'duplicate',
            existingId: id,
          });
        }
      });

      it('[AT-RD-15] N-4: /user/ внутри слова и знаки, похожие на «/», — 400 profile_ref', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'allowed',
          reviewer: po,
        });
        for (const excerpt of [
          'Asked about it, see/user/john_doe for details',
          'Thanks u∕john_doe for the tip',
          'Thanks u⁄john_doe for the tip',
          'Thanks u​/john_doe for the tip',
        ]) {
          const r = await seedOpportunity(ed, w.P, c, { excerpt });
          expect(r.status).toBe(400);
          expect(r.body.error.details.fields).toEqual([
            { field: 'excerpt', code: 'profile_ref' },
          ]);
        }
      });
    });
    describe('Раунд 3 (UI-аудит S2-2): чтение доказательств для отзыва', () => {
      interface Ev {
        sourceId: string;
        revision: number;
        supersedesId: string | null;
        current: boolean;
        fragment: string;
        usage: string;
        revokedAt: string | null;
        revokeReason: string | null;
      }
      it('[AT-RD-03] GET …/opportunities/:id/excerpts: все редакции (цепочка и отвязанные), у архивной тоже; отозванные с пометкой; отзыв по id из списка; SA — 403; чужой продукт — 404', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'allowed',
          reviewer: po,
        });
        const url = threadUrl(c.name);
        const o = ok<Opp>(
          await seedOpportunity(ed, w.P, c, { threadUrl: url }),
          201,
        );
        const v1 = o.excerpt!.sourceId;
        const p1 = ok<Opp>(
          await ed.patch(`${w.P}/opportunities/${o.id}`, {
            excerpt: 'Друга редакція виписки треду',
            expectedRevision: o.revision,
          }),
          200,
        );
        const v2 = p1.excerpt!.sourceId;
        const p2 = ok<Opp>(
          await ed.patch(`${w.P}/opportunities/${o.id}`, {
            excerpt: null,
            expectedRevision: p1.revision,
          }),
          200,
        );
        const p3 = ok<Opp>(
          await ed.patch(`${w.P}/opportunities/${o.id}`, {
            excerpt: 'Третя виписка після відв’язки',
            expectedRevision: p2.revision,
          }),
          200,
        );
        const v3 = p3.excerpt!.sourceId;
        ok(
          await ed.post(`${w.P}/opportunities/${o.id}/archive`, {
            expectedRevision: p3.revision,
          }),
          200,
        );
        // Тот же тред в другом продукте кабинета — его выдержки не видны.
        const site = await seedSite(s.prisma, w.acc.accountId);
        const pB = await seedProduct(s.prisma, {
          accountId: w.acc.accountId,
          siteId: site,
          kind: 'test',
        });
        const owner = api(s, w.acc.accountId, w.acc.owner);
        const PB = `/publisher/products/${pB.id}/reddit`;
        const cB = await seedCommunity(owner, PB, {
          name: c.name,
          rules: 'allowed',
          reviewer: owner,
        });
        const oB = ok<Opp>(
          await seedOpportunity(owner, PB, cB, { threadUrl: url }),
          201,
        );
        const ex = ok<{
          opportunityId: string;
          currentSourceId: string;
          items: Ev[];
        }>(await ed.get(`${w.P}/opportunities/${o.id}/excerpts`), 200);
        expect(ex.opportunityId).toBe(o.id);
        expect(ex.currentSourceId).toBe(v3);
        expect(
          ex.items.map((x) => [
            x.sourceId,
            x.revision,
            x.supersedesId,
            x.current,
            x.usage,
          ]),
        ).toEqual([
          [v1, 1, null, false, 'restricted'],
          [v2, 2, v1, false, 'restricted'],
          [v3, 3, null, true, 'restricted'],
        ]);
        expect(ex.items[1].fragment).toBe('Друга редакція виписки треду');
        expect(JSON.stringify(ex)).not.toContain(oB.excerpt!.sourceId);
        // Отзыв прежней редакции — по id из списка, у архивной возможности.
        ok(
          await po.post(`${SRC()}/${v2}/revoke`, {
            reason: 'Автор попросив прибрати',
          }),
          200,
        );
        const ex2 = ok<{ items: Ev[] }>(
          await owner.get(`${w.P}/opportunities/${o.id}/excerpts`),
          200,
        );
        expect(ex2.items.map((x) => [x.sourceId, x.usage])).toEqual([
          [v1, 'revoked'],
          [v2, 'revoked'],
          [v3, 'restricted'],
        ]);
        for (const x of ex2.items.slice(0, 2)) {
          expect(x.revokedAt).not.toBeNull();
          expect(x.revokeReason).toBe('Автор попросив прибрати');
        }
        ok(
          await po.post(`${SRC()}/${v3}/revoke`, { reason: 'ПД у виписці' }),
          200,
        );
        expect(
          ok<{ items: Ev[] }>(
            await ed.get(`${w.P}/opportunities/${o.id}/excerpts`),
            200,
          ).items.every((x) => x.usage === 'revoked'),
        ).toBe(true);
        // Роли и изоляция.
        expect(
          (await sa.get(`${w.P}/opportunities/${o.id}/excerpts`)).status,
        ).toBe(403);
        const foreign = await owner.get(`${PB}/opportunities/${o.id}/excerpts`);
        expect(foreign.status).toBe(404);
        expect(foreign.body.error.code).toBe('PUB_NOT_FOUND');
        expect(
          ok<{ items: Ev[] }>(
            await owner.get(`${PB}/opportunities/${oB.id}/excerpts`),
            200,
          ).items.map((x) => x.sourceId),
        ).toEqual([oB.excerpt!.sourceId]);
      });

      it('[AT-RD-03] GET …/communities/:id/rules/:sid/source: первоисточник и у superseded снимка, отзыв виден; снимок другого сообщества — 404; SA — 403', async () => {
        const c = await seedCommunity(ed, w.P, {
          rules: 'allowed',
          reviewer: po,
        });
        const v2 = ok<{ id: string }>(
          await ed.post(
            `${w.P}/communities/${c.communityId}/rules`,
            rulesBody(c.name, 'restricted'),
          ),
          201,
        );
        const old = ok<{
          snapshotId: string;
          version: number;
          status: string;
          source: Ev & { url: string };
        }>(
          await ed.get(
            `${w.P}/communities/${c.communityId}/rules/${c.snapshotId}/source`,
          ),
          200,
        );
        expect(old).toMatchObject({
          snapshotId: c.snapshotId,
          version: 1,
          status: 'superseded',
          source: { current: false, usage: 'restricted', revision: 1 },
        });
        expect(old.source.url).toContain(`/r/${c.name}/about/rules`);
        const cur = ok<{ status: string; source: Ev }>(
          await ed.get(
            `${w.P}/communities/${c.communityId}/rules/${v2.id}/source`,
          ),
          200,
        );
        expect(cur).toMatchObject({
          status: 'current',
          source: { current: true },
        });
        ok(
          await po.post(`${SRC()}/${old.source.sourceId}/revoke`, {
            reason: 'Стара сторінка правил',
          }),
          200,
        );
        expect(
          ok<{ source: Ev }>(
            await ed.get(
              `${w.P}/communities/${c.communityId}/rules/${c.snapshotId}/source`,
            ),
            200,
          ).source,
        ).toMatchObject({
          usage: 'revoked',
          revokeReason: 'Стара сторінка правил',
        });
        const other = await seedCommunity(ed, w.P, {
          projectId: c.projectId,
          rules: 'allowed',
        });
        for (const path of [
          `${w.P}/communities/${other.communityId}/rules/${c.snapshotId}/source`,
          `${w.P}/communities/${c.communityId}/rules/${other.snapshotId}/source`,
          `${w.P}/communities/${c.communityId}/rules/cnosuchsnapshotzzzzzzzzz/source`,
        ]) {
          const r = await ed.get(path);
          expect(r.status).toBe(404);
          expect(r.body.error.code).toBe('PUB_NOT_FOUND');
        }
        expect(
          (
            await sa.get(
              `${w.P}/communities/${c.communityId}/rules/${v2.id}/source`,
            )
          ).status,
        ).toBe(403);
      });
    });
  },
);
