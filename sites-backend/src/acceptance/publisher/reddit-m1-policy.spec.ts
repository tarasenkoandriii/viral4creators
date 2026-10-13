/**
 * [AT-RD-03] [AT-RD-04] P-R M1 — реестр правил и Policy Gate
 * (reddit-manual-mvp-adapted.md §M1.3, §M1.4, §9). Четыре сценария:
 *  - снимок `unknown` → `block`; `prohibited` → `block`; высокий score
 *    (все факторы 100) BLOCK не снимает — `qualify` → 409 `policy_block`,
 *    а база не даёт `qualified` при `policy≠ok` (триггер);
 *  - `stale` (reviewed, `checkedAt + staleDays < now`) → `recheck_required`,
 *    квалифицировать (рекомендовать) нельзя;
 *  - новая версия правил → прежний снимок `superseded`, зависимые
 *    возможности `new|qualified` → `recheck_required` (`rules_changed`) с
 *    аудитом на каждую; новый снимок `unreviewed` → `block` до повторного
 *    review; после review пересчёт возвращает `new`.
 * Плюс: review своего снимка — `selfReview`, чужого — нет; review требует
 * URL и `checkedAt`; после review снимок неизменен (кроме статуса).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  api,
  factorsBody,
  ok,
  redditStack,
  redditWorld,
  rulesBody,
  seedCommunity,
  seedOpportunity,
  type Api,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(180_000);

interface Opp {
  id: string;
  revision: number;
  policy: string;
  policyReasons: string[];
  status: string;
  ruleSnapshotId: string | null;
  factors: Record<string, { value: number | null; why: string | null }>;
  score: {
    relevance: number | null;
    risk: number | null;
    priority: number | null;
    missing: string[];
  };
}

ciDescribe('P-R M1: Policy Gate и снимки правил', () => {
  let s: RedditStack;
  let w: RedditWorld;
  let ed: Api;
  let po: Api;
  beforeAll(async () => {
    s = await redditStack();
    w = await redditWorld(s);
    ed = api(s, w.acc.accountId, w.team.editor);
    po = api(s, w.acc.accountId, w.team.product_owner);
  });
  afterAll(async () => {
    await s?.close();
  });

  const all100 = () => {
    const f = factorsBody(100) as Record<
      string,
      { value: number; why: string }
    >;
    for (const k of Object.keys(f)) f[k] = { value: 100, why: 'максимум' };
    return f;
  };

  describe('[AT-RD-03] unknown или prohibited → block; score 100 не снимает', () => {
    it.each([
      ['unknown', ['promotion_unknown', 'links_unknown']],
      ['promotion_prohibited', ['promotion_prohibited']],
    ] as const)(
      'снимок %s (проверенный) → block %j; все факторы 100 — qualify → 409 policy_block',
      async (scenario, reasons) => {
        const c = await seedCommunity(ed, w.P, {
          rules: scenario,
          reviewer: po,
        });
        const o = ok<Opp>(
          await seedOpportunity(ed, w.P, c, { factors: all100() }),
          201,
        );
        expect(o).toMatchObject({
          policy: 'block',
          policyReasons: [...reasons],
          status: 'blocked',
          ruleSnapshotId: c.snapshotId,
        });
        expect(o.factors.policy_risk.value).toBe(100);
        expect(o.score).toMatchObject({ relevance: 100, risk: 100 });
        const q = await ed.post(`${w.P}/opportunities/${o.id}/qualify`, {
          expectedRevision: o.revision,
        });
        expect(q.status).toBe(409);
        expect(q.body.error).toMatchObject({
          code: 'PUB_TRANSITION_INVALID',
          details: { reason: 'policy_block', from: 'blocked' },
        });
        // Пересчёт не снимает BLOCK.
        const r = ok<Opp>(
          await ed.post(`${w.P}/opportunities/${o.id}/score`, {
            expectedRevision: o.revision,
          }),
          200,
        );
        expect(r).toMatchObject({ policy: 'block', status: 'blocked' });
        // База — вторая линия: qualified при policy≠ok невозможен.
        await expect(
          s.prisma.pubRedditOpportunity.update({
            where: { id: o.id },
            data: { status: 'qualified' },
          }),
        ).rejects.toThrow(/qualified\/in_brief только при policy=ok/);
      },
    );

    it('снимка нет → block rules_missing; не проверен → block rules_unreviewed; links prohibited без ссылок → ok, policy_risk 60', async () => {
      const none = await seedCommunity(ed, w.P, { rules: null });
      expect(ok<Opp>(await seedOpportunity(ed, w.P, none), 201)).toMatchObject({
        policy: 'block',
        policyReasons: ['rules_missing'],
        ruleSnapshotId: null,
        status: 'blocked',
      });
      const unrev = await seedCommunity(ed, w.P, {
        rules: 'allowed',
        reviewer: null,
      });
      expect(ok<Opp>(await seedOpportunity(ed, w.P, unrev), 201)).toMatchObject(
        {
          policy: 'block',
          policyReasons: ['rules_unreviewed'],
        },
      );
      const noLinks = await seedCommunity(ed, w.P, {
        rules: 'prohibited_links',
        reviewer: po,
      });
      const o = ok<Opp>(await seedOpportunity(ed, w.P, noLinks), 201);
      expect(o).toMatchObject({ policy: 'ok', status: 'new' });
      expect(o.factors.policy_risk.value).toBe(60);
      // relevance = 70; risk = round(.4·60 + .25·30 + .2·20 + .15·10) = 37
      expect(o.score).toEqual({
        scoreVersion: 'v1',
        relevance: 70,
        risk: 37,
        priority: 44,
        missing: [],
      });
      ok(
        await ed.post(`${w.P}/opportunities/${o.id}/qualify`, {
          expectedRevision: o.revision,
        }),
        200,
      );
    });

    it('policy_risk вводить нельзя (400 derived); пропущенный фактор — null и missing, не 0', async () => {
      const c = await seedCommunity(ed, w.P, {
        rules: 'restricted',
        reviewer: po,
      });
      const bad = await seedOpportunity(ed, w.P, c, {
        factors: { policy_risk: { value: 0, why: 'хочу нуль' } },
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error.details.fields).toEqual([
        { field: 'factors.policy_risk', code: 'derived' },
      ]);
      const noWhy = await seedOpportunity(ed, w.P, c, {
        factors: { topic_fit: { value: 50 } },
      });
      expect(noWhy.body.error.details.fields).toEqual([
        { field: 'factors.topic_fit.why', code: 'required' },
      ]);
      const f = factorsBody(80) as Record<string, unknown>;
      f.answerability = { value: null, why: null };
      const o = ok<Opp>(await seedOpportunity(ed, w.P, c, { factors: f }), 201);
      expect(o.score).toEqual({
        scoreVersion: 'v1',
        relevance: null,
        // policy_risk (restricted) 50: .4·50 + .25·30 + .2·20 + .15·10 = 33.
        risk: 33,
        priority: null,
        missing: ['answerability'],
      });
    });
  });

  describe('[AT-RD-04] stale и новая версия правил → recheck_required', () => {
    it('stale (checkedAt 40 дней назад, staleDays 30) → recheck_required; qualify → 409 policy_recheck', async () => {
      const c = await seedCommunity(ed, w.P, {
        rules: 'allowed',
        reviewer: po,
        checkedAt: new Date(Date.now() - 40 * 86_400_000),
      });
      const community = ok<{
        staleDays: number;
        rules: { state: string; gate: { verdict: string; reasons: string[] } };
      }>(await ed.get(`${w.P}/communities/${c.communityId}`), 200);
      expect(community.staleDays).toBe(30);
      expect(community.rules).toMatchObject({
        state: 'stale',
        gate: { verdict: 'recheck_required', reasons: ['rules_stale'] },
      });
      const o = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
      expect(o).toMatchObject({
        policy: 'recheck_required',
        policyReasons: ['rules_stale'],
        status: 'recheck_required',
      });
      const q = await ed.post(`${w.P}/opportunities/${o.id}/qualify`, {
        expectedRevision: o.revision,
      });
      expect(q.status).toBe(409);
      expect(q.body.error.details).toMatchObject({
        reason: 'policy_recheck',
        from: 'recheck_required',
      });
    });

    it('новая версия: v1 → superseded, new/qualified → recheck_required (аудит на каждую), skipped не трогается; v2 без review → block; review v2 → пересчёт → new', async () => {
      const c = await seedCommunity(ed, w.P, {
        rules: 'allowed',
        reviewer: po,
      });
      const a = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
      const b = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
      const sk = ok<Opp>(await seedOpportunity(ed, w.P, c), 201);
      const bq = ok<Opp>(
        await ed.post(`${w.P}/opportunities/${b.id}/qualify`, {
          expectedRevision: b.revision,
        }),
        200,
      );
      expect(bq.status).toBe('qualified');
      ok(
        await ed.post(`${w.P}/opportunities/${sk.id}/skip`, {
          expectedRevision: sk.revision,
          reason: 'Тред застарів',
        }),
        200,
      );
      const v2 = ok<{
        id: string;
        version: number;
        reviewState: string;
        gate: { verdict: string };
      }>(
        await ed.post(
          `${w.P}/communities/${c.communityId}/rules`,
          rulesBody(c.name, 'restricted'),
        ),
        201,
      );
      expect(v2).toMatchObject({
        version: 2,
        reviewState: 'unreviewed',
        gate: { verdict: 'block' },
      });
      const v1 = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
        where: { id: c.snapshotId! },
      });
      expect(v1.status).toBe('superseded');
      const rows = await s.prisma.pubRedditOpportunity.findMany({
        where: { id: { in: [a.id, b.id, sk.id] } },
      });
      const by = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(by[a.id]).toMatchObject({
        status: 'recheck_required',
        policy: 'recheck_required',
        policyReasons: ['rules_changed'],
        revision: a.revision + 1,
      });
      expect(by[b.id]).toMatchObject({ status: 'recheck_required' });
      expect(by[sk.id].status).toBe('skipped');
      const audit = await s.prisma.pubAuditEvent.findMany({
        where: {
          productId: w.product.id,
          objectType: 'reddit_opportunity',
          objectId: { in: [a.id, b.id] },
          toStatus: 'recheck_required',
        },
      });
      expect(audit.map((x) => x.objectId).sort()).toEqual([a.id, b.id].sort());
      // Снимок v2 ещё не проверен → пересчёт даёт block.
      const blocked = ok<Opp>(
        await ed.post(`${w.P}/opportunities/${a.id}/score`, {
          expectedRevision: a.revision + 1,
        }),
        200,
      );
      expect(blocked).toMatchObject({
        policy: 'block',
        policyReasons: ['rules_unreviewed'],
        status: 'blocked',
        ruleSnapshotId: v2.id,
      });
      // Повторный review — и пересчёт возвращает возможность в работу.
      const reviewed = ok<{ selfReview: boolean; state: string }>(
        await po.post(`${w.P}/rules/${v2.id}/review`),
        200,
      );
      expect(reviewed).toMatchObject({ selfReview: false, state: 'reviewed' });
      const back = ok<Opp>(
        await ed.post(`${w.P}/opportunities/${a.id}/score`, {
          expectedRevision: blocked.revision,
        }),
        200,
      );
      expect(back).toMatchObject({ policy: 'ok', status: 'new' });
      expect(back.factors.policy_risk.value).toBe(50);
      // Review прежней версии — 409.
      expect(
        (await po.post(`${w.P}/rules/${c.snapshotId}/review`)).status,
      ).toBe(409);
      const hist = ok<{ items: Array<{ version: number; status: string }> }>(
        await ed.get(`${w.P}/communities/${c.communityId}/rules`),
        200,
      );
      expect(hist.items.map((x) => [x.version, x.status])).toEqual([
        [2, 'current'],
        [1, 'superseded'],
      ]);
    });

    it('selfReview: автор снимка проверяет сам → selfReview=true (пометка, не запрет); после review снимок неизменен; удалить нельзя', async () => {
      const c = await seedCommunity(ed, w.P, {
        rules: 'allowed',
        reviewer: ed,
      });
      const snap = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
        where: { id: c.snapshotId! },
      });
      expect(snap).toMatchObject({
        reviewState: 'reviewed',
        selfReview: true,
        reviewedBy: `member:${w.team.editor.memberId}`,
      });
      const audit = await s.prisma.pubAuditEvent.findFirstOrThrow({
        where: { objectId: snap.id, action: 'approve' },
      });
      expect(audit.meta).toMatchObject({ selfReview: true });
      await expect(
        s.prisma.pubRedditRuleSnapshot.update({
          where: { id: snap.id },
          data: { linksPolicy: 'allowed', promotionPolicy: 'prohibited' },
        }),
      ).rejects.toThrow(/append-only/);
      await expect(
        s.prisma.pubRedditRuleSnapshot.update({
          where: { id: snap.id },
          data: { selfReview: false },
        }),
      ).rejects.toThrow(/после review неизменно/);
      await expect(
        s.prisma.pubRedditRuleSnapshot.delete({ where: { id: snap.id } }),
      ).rejects.toThrow(/append-only/);
      // Повторный review — 409.
      expect((await po.post(`${w.P}/rules/${snap.id}/review`)).status).toBe(
        409,
      );
    });

    it('снимок требует URL и checkedAt; будущий checkedAt и контакт в выдержке → 400', async () => {
      const c = await seedCommunity(ed, w.P, { rules: null });
      const P = `${w.P}/communities/${c.communityId}/rules`;
      const base = rulesBody(c.name, 'allowed');
      const noUrl = await ed.post(P, { ...base, sourceUrl: undefined });
      expect(noUrl.body.error.details.fields).toEqual([
        { field: 'sourceUrl', code: 'required' },
      ]);
      const http = await ed.post(P, {
        ...base,
        sourceUrl: 'http://x.example/r',
      });
      expect(http.body.error.details.fields).toEqual([
        { field: 'sourceUrl', code: 'format' },
      ]);
      const noDate = await ed.post(P, { ...base, checkedAt: undefined });
      expect(noDate.body.error.details.fields).toEqual([
        { field: 'checkedAt', code: 'required' },
      ]);
      const future = await ed.post(P, {
        ...base,
        checkedAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(future.body.error.details.fields).toEqual([
        { field: 'checkedAt', code: 'future' },
      ]);
      const pii = await ed.post(P, {
        ...base,
        sourceExcerpt: 'Modmail: mods@example.com',
      });
      expect(pii.body.error.details.fields).toEqual([
        { field: 'sourceExcerpt', code: 'pii' },
      ]);
      const r = ok<{ source: { url: string; usage: string } }>(
        await ed.post(P, base),
        201,
      );
      expect(r.source).toMatchObject({
        url: `https://www.reddit.com/r/${c.name}/about/rules`,
        usage: 'restricted',
      });
    });
  });
});
