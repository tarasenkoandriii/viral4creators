/**
 * [AT-RD-07] [AT-RD-08] P-R M2 — детерминированная проверка `reddit_policy`
 * на HTTP (reddit-manual-mvp-adapted.md §M2.4, §9; Р-RD-8, Р-RD-51):
 *  - вымышленный отзыв (личный опыт от первого лица при `affiliation ≠
 *    customer`, цитата «клиента» без источника) → BLOCK
 *    `reddit_fake_testimonial`; согласование → 409 `PUB_BLOCKERS_OPEN`
 *    с `reddit_policy_block`;
 *  - нет раскрытия в первых 300 знаках → BLOCK `reddit_disclosure_missing`;
 *    исправление — новой версией;
 *  - `needs_verification` с числом → BLOCK `reddit_unverified_claim`;
 *  - `POST …/reddit/contents/:cid/check` (`qa.technical`): новая строка
 *    QA от `system:reddit-policy`; провал после согласования — каскад
 *    `stale_check` (согласование `superseded`).
 * Каждая строка таблицы §M2.4 — unit (`reddit-m2-pure.spec.ts`).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  DISCLOSURE,
  api,
  approvedVersion,
  contentPath,
  draftVersion,
  humanQaPass,
  ok,
  redditStack,
  redditWorld,
  seedStudio,
  submitVersion,
  versionBody,
  warningCodes,
  type Api,
  type RedditStack,
  type RedditWorld,
  type StudioIds,
  type VersionRef,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(240_000);

interface Qa {
  id: string;
  kind: string;
  result: string;
  checkedBy: string;
  blockers: Array<{ code: string }>;
  warnings: Array<{ code: string }>;
}

ciDescribe('P-R M2: проверка reddit_policy (BLOCK/WARN)', () => {
  let s: RedditStack;
  let w: RedditWorld;
  let ed: Api;
  let po: Api;
  let vw: Api;
  let C: string;
  beforeAll(async () => {
    s = await redditStack();
    w = await redditWorld(s);
    ed = api(s, w.acc.accountId, w.team.editor);
    po = api(s, w.acc.accountId, w.team.product_owner);
    vw = api(s, w.acc.accountId, w.team.viewer);
    C = contentPath(w);
  });
  afterAll(async () => {
    await s?.close();
  });

  async function policyOf(versionId: string): Promise<Qa> {
    const qa = ok<{ items: Qa[] }>(
      await po.get(`${C}/versions/${versionId}/qa-checks`),
      200,
    );
    const last = qa.items.filter((q) => q.kind === 'reddit_policy').pop();
    if (!last) throw new Error('нет reddit_policy');
    return last;
  }

  async function frozen(
    ids: StudioIds,
    body: Record<string, unknown>,
  ): Promise<VersionRef> {
    const d = await draftVersion(ed, w, ids, body);
    return submitVersion(ed, w, ids.contentId, d);
  }

  async function blockersOnApprove(v: VersionRef): Promise<string[]> {
    await humanQaPass(po, w, v.id);
    const r = await po.post(`${C}/versions/${v.id}/approve`, {
      versionHash: v.hash,
      acknowledgedWarnings: await warningCodes(po, w, v.id),
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PUB_BLOCKERS_OPEN');
    return r.body.error.details.blockers.map((b: { code: string }) => b.code);
  }

  describe('[AT-RD-07] вымышленный отзыв → BLOCK', () => {
    it('личный опыт от первого лица (founder) → reddit_fake_testimonial; согласование — reddit_policy_block', async () => {
      const ids = await seedStudio(s, w, ed, po);
      const v = await frozen(ids, {
        body: versionBody(
          "I've been using Demo for a year and it worked great for me.",
        ),
      });
      const q = await policyOf(v.id);
      expect(q).toMatchObject({
        result: 'fail',
        checkedBy: 'system:reddit-policy',
      });
      expect(q.blockers.map((b) => b.code)).toEqual([
        'reddit_fake_testimonial',
      ]);
      expect(await blockersOnApprove(v)).toEqual(['reddit_policy_block']);
      expect(
        await s.prisma.pubApproval.count({ where: { objectId: v.id } }),
      ).toBe(0);
    });

    it('украинский текст «я купив… мені допомогло» → тот же BLOCK', async () => {
      const ids = await seedStudio(s, w, ed, po);
      const v = await frozen(ids, {
        body: versionBody('Я купив Демо минулого року, і мені допомогло.'),
      });
      expect((await policyOf(v.id)).blockers.map((b) => b.code)).toContain(
        'reddit_fake_testimonial',
      );
    });

    it('цитата «клиента» без источника в claimMap → reddit_fake_testimonial', async () => {
      const ids = await seedStudio(s, w, ed, po);
      const v = await frozen(ids, {
        body: versionBody('A customer told us: "it saved our shop hours".'),
        meta: {
          disclosure: DISCLOSURE,
          claimMap: [
            {
              text: 'Ask which formats you tried',
              sourceIds: 'needs_verification',
            },
          ],
          uncertainties: [],
        },
      });
      expect((await policyOf(v.id)).blockers.map((b) => b.code)).toEqual([
        'reddit_fake_testimonial',
      ]);
    });

    it('affiliation=customer — опыт от первого лица допустим (проверка пройдена)', async () => {
      const ids = await seedStudio(s, w, ed, po, { affiliation: 'customer' });
      const v = await frozen(ids, {
        body: versionBody(
          "I've been using Demo for a year as a paying customer.",
        ),
      });
      const q = await policyOf(v.id);
      expect(q.blockers).toEqual([]);
      expect(q.result).toBe('pass');
    });
  });

  describe('[AT-RD-08] нет раскрытия → BLOCK', () => {
    it('раскрытие не в первых 300 знаках → reddit_disclosure_missing; новая версия с раскрытием в начале — pass и согласование', async () => {
      const ids = await seedStudio(s, w, ed, po);
      const late = `${'Here is a practical plan for reusing one article. '.repeat(8)}\n\n${DISCLOSURE}`;
      const v1 = await frozen(ids, { body: late });
      const q1 = await policyOf(v1.id);
      expect(q1.result).toBe('fail');
      expect(q1.blockers.map((b) => b.code)).toEqual([
        'reddit_disclosure_missing',
      ]);
      expect(await blockersOnApprove(v1)).toEqual(['reddit_policy_block']);
      // Исправление — новая версия (замороженную не правят): материал
      // возвращается на доработку общим переходом P-B1.
      const c = await s.prisma.pubContent.findUniqueOrThrow({
        where: { id: ids.contentId },
      });
      ok(
        await po.post(`${C}/contents/${ids.contentId}/transition`, {
          to: 'changes_requested',
          reason: 'Немає розкриття на початку тексту',
          expectedRevision: c.revision,
        }),
        200,
      );
      const v2 = await frozen(ids, {});
      expect((await policyOf(v2.id)).result).toBe('pass');
      await humanQaPass(po, w, v2.id);
      ok(
        await po.post(`${C}/versions/${v2.id}/approve`, {
          versionHash: v2.hash,
          acknowledgedWarnings: await warningCodes(po, w, v2.id),
        }),
        201,
      );
    });

    it('пустое раскрытие → reddit_disclosure_missing', async () => {
      const ids = await seedStudio(s, w, ed, po);
      const v = await frozen(ids, {
        body: 'Start from one verified article and plan a post from it.',
        meta: {
          disclosure: '',
          claimMap: [],
          uncertainties: [],
        },
      });
      expect((await policyOf(v.id)).blockers.map((b) => b.code)).toEqual([
        'reddit_disclosure_missing',
      ]);
    });
  });

  it('needs_verification с числом → BLOCK reddit_unverified_claim; без числа — WARN reddit_claim_needs_verification', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const v = await frozen(ids, {
      meta: {
        disclosure: DISCLOSURE,
        claimMap: [
          { text: 'Saves 5 hours a week', sourceIds: 'needs_verification' },
        ],
        uncertainties: [],
      },
    });
    expect((await policyOf(v.id)).blockers.map((b) => b.code)).toEqual([
      'reddit_unverified_claim',
    ]);
    const ids2 = await seedStudio(s, w, ed, po);
    const v2 = await frozen(ids2, {
      meta: {
        disclosure: DISCLOSURE,
        claimMap: [
          {
            text: 'Ask which formats were tried',
            sourceIds: 'needs_verification',
          },
        ],
        uncertainties: [],
      },
    });
    const q2 = await policyOf(v2.id);
    expect(q2.blockers).toEqual([]);
    expect(q2.warnings.map((x) => x.code)).toContain(
      'reddit_claim_needs_verification',
    );
  });

  it('POST /contents/:cid/check: до заморозки — 409 submit_first; VW — 403; ED — новая строка system:reddit-policy', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const d = await draftVersion(ed, w, ids);
    const early = await ed.post(`${w.P}/contents/${ids.contentId}/check`);
    expect(early.status).toBe(409);
    expect(early.body.error.details).toMatchObject({ hint: 'submit_first' });
    const v = await submitVersion(ed, w, ids.contentId, d);
    const denied = await vw.post(`${w.P}/contents/${ids.contentId}/check`);
    expect(denied.status).toBe(403);
    const q = ok<Qa>(
      await ed.post(`${w.P}/contents/${ids.contentId}/check`),
      201,
    );
    expect(q).toMatchObject({
      kind: 'reddit_policy',
      result: 'pass',
      checkedBy: 'system:reddit-policy',
    });
    expect(
      await s.prisma.pubQaCheck.count({
        where: { versionId: v.id, kind: 'reddit_policy' },
      }),
    ).toBe(2);
  });

  it('проверка после согласования провалилась (правила устарели) → каскад stale_check: согласование superseded, задача на версию', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const v = await approvedVersion(ed, po, w, ids);
    await s.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL session_replication_role = replica`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "sites"."pub_reddit_rule_snapshots" SET "checkedAt" = now() - interval '400 days' WHERE "id" = $1`,
        ids.snapshotId,
      );
    });
    const q = ok<Qa>(
      await ed.post(`${w.P}/contents/${ids.contentId}/check`),
      201,
    );
    expect(q.result).toBe('fail');
    expect(q.blockers.map((b) => b.code)).toContain('reddit_rules_stale');
    const a = await s.prisma.pubApproval.findFirstOrThrow({
      where: { objectId: v.id },
    });
    expect(a).toMatchObject({ status: 'superseded', reason: 'stale_check' });
    expect(
      await s.prisma.pubReviewTask.count({
        where: {
          objectType: 'content_version',
          objectId: v.id,
          status: 'open',
        },
      }),
    ).toBe(1);
  });

  it('[AT-RD-07] [AT-RD-08] T1 (аудит M2 S1-1): пост основателя в сообщество с links prohibited — «Hi» вместо раскрытия, личный опыт, гарантия, 300%, ссылка demo.fr → BLOCK по всем; согласование 409', async () => {
    const ids = await seedStudio(s, w, ed, po, {
      contentType: 'post',
      rules: 'prohibited_links',
    });
    const d = await draftVersion(ed, w, ids, {
      title: 'Quick tip',
      body: "Hi all! I'm using Demo daily, it gave me a guaranteed 300% ROI in a week. Pricing: demo.fr/pricing",
      meta: {
        disclosure: 'Hi',
        claimMap: [],
        uncertainties: [],
      },
    });
    const v = await submitVersion(ed, w, ids.contentId, d);
    const q = await policyOf(v.id);
    expect(q.result).toBe('fail');
    expect(q.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining([
        'reddit_links_prohibited',
        'reddit_links_not_allowed',
        'reddit_disclosure_missing',
        'reddit_unverified_claim',
        'reddit_fake_testimonial',
      ]),
    );
    expect(await blockersOnApprove(v)).toEqual(['reddit_policy_block']);
  });

  it('[AT-RD-08] Р-RD-65: раскрытие без бренда брифа → BLOCK; раскрытие спрятано в спойлер → BLOCK', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const noBrand =
      "Disclosure: I'm the founder of this service, ask me anything.";
    const v1 = await frozen(ids, {
      body: `${noBrand}\n\nStart from one verified article.`,
      meta: { disclosure: noBrand, claimMap: [], uncertainties: [] },
    });
    const q1 = await policyOf(v1.id);
    expect(q1.blockers.map((b) => b.code)).toEqual([
      'reddit_disclosure_missing',
    ]);
    const ids2 = await seedStudio(s, w, ed, po);
    const v2 = await frozen(ids2, {
      body: `>!${DISCLOSURE}!<\n\nStart from one verified article.`,
    });
    expect((await policyOf(v2.id)).blockers.map((b) => b.code)).toEqual([
      'reddit_disclosure_missing',
    ]);
  });
  it('раунд 2 (Р-RD-74…80): T1b «Not affiliated with Demo» у основателя → BLOCK reddit_disclosure_negated; T1c опыт и ссылка в ^(…) → BLOCK; T1d честный технический ответ (Node 18 → 20, Promise.all) → pass и согласование', async () => {
    const t1b = await seedStudio(s, w, ed, po, {
      contentType: 'post',
      rules: 'prohibited_links',
    });
    const neg =
      'Not affiliated with Demo in any way, just sharing what worked.';
    const vb = await frozen(t1b, {
      title: 'Reuse one article',
      body: `${neg}\n\nStart from one verified article.`,
      meta: { disclosure: neg, claimMap: [], uncertainties: [] },
    });
    expect((await policyOf(vb.id)).blockers.map((b) => b.code)).toEqual([
      'reddit_disclosure_negated',
    ]);
    expect(await blockersOnApprove(vb)).toEqual(['reddit_policy_block']);

    const t1c = await seedStudio(s, w, ed, po, {
      contentType: 'post',
      rules: 'prohibited_links',
    });
    const vc = await frozen(t1c, {
      title: 'Reuse one article',
      body: `${DISCLOSURE}\n\n^(I'm using Demo daily and it saved my team, see demo.fr/pricing)`,
    });
    expect((await policyOf(vc.id)).blockers.map((b) => b.code)).toEqual([
      'reddit_links_prohibited',
      'reddit_links_not_allowed',
      'reddit_fake_testimonial',
    ]);

    const t1d = await seedStudio(s, w, ed, po, {
      contentType: 'post',
      rules: 'prohibited_links',
    });
    const vd = await frozen(t1d, {
      title: 'Node upgrade order',
      body: `${DISCLOSURE}\n\nFor what it's worth, if you're on Node.js 18, move to Node 20 LTS first. Wrap the requests in Promise.all and pin react@18.3.1; Object.keys(cache).length shows the cache size.`,
    });
    const qd = await policyOf(vd.id);
    expect(qd).toMatchObject({ result: 'pass', blockers: [] });
    await humanQaPass(po, w, vd.id);
    ok(
      await po.post(`${C}/versions/${vd.id}/approve`, {
        versionHash: vd.hash,
        acknowledgedWarnings: await warningCodes(po, w, vd.id),
      }),
      201,
    );
  });

  it('аудит m2-6/m2-7 (порт): число тезиса needs_verification — BLOCK, а не WARN «из брифа»; число пункта claimMap, которого нет в тексте источника, — WARN reddit_claim_source_mismatch', async () => {
    const ids = await seedStudio(s, w, ed, po, {
      briefExtra: {
        keyPoints: [
          {
            text: 'Demo boosts sales by 300%',
            sourceIds: 'needs_verification',
          },
          { text: 'Ask which formats', sourceIds: 'needs_verification' },
        ],
      },
    });
    const v1 = await frozen(ids, {
      body: versionBody(
        'Teams using Demo boost sales by 300% in the first month.',
      ),
    });
    const q1 = await policyOf(v1.id);
    expect(q1.blockers.map((b) => b.code)).toEqual(['reddit_unverified_claim']);
    expect(q1.warnings.map((b) => b.code)).not.toContain(
      'reddit_claim_from_brief',
    );
    const ids2 = await seedStudio(s, w, ed, po);
    const v2 = await frozen(ids2, {
      body: versionBody('Demo boosts sales by 300% for most shops.'),
      meta: {
        disclosure: DISCLOSURE,
        claimMap: [
          { text: 'Demo boosts sales by 300%', sourceIds: [ids2.sourceId] },
        ],
        uncertainties: [],
      },
    });
    const q2 = await policyOf(v2.id);
    expect(q2.blockers).toEqual([]);
    expect(q2.warnings.map((x) => x.code)).toContain(
      'reddit_claim_source_mismatch',
    );
  });
});
