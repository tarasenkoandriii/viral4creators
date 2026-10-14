/**
 * P-R M2 — ретенция выдержек тредов `reddit-retention` (reddit-manual-mvp-
 * adapted.md §4 `reddit_excerpt_retention_days`, хвост M2 (2); Р-RD-59):
 *  - тред обрабатывается, когда все его возможности `archived|skipped` и у
 *    каждой прошло N дней (параметр продукта, по умолчанию 180), а брифы
 *    архивированы; активный бриф держит выдержку;
 *  - фрагмент → плейсхолдер с новым `contentHash` (через порт P-B1),
 *    `context` архивных брифов — тоже; копии текста в сохранённых ответах
 *    мутаций (`pub_idempotency_keys`) заменены; аудит `erase`;
 *  - повтор — no-op; срок из параметра продукта.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { REDDIT_RETENTION_PLACEHOLDER } from '../../modules/publisher/contracts/reddit-api';
import { sourceContentHash } from '../../modules/publisher/core/content-hash';
import { approveParams } from '../../modules/publisher/ai/testing/ai-kit.testing';
import { RedditRetentionJob } from '../../modules/publisher/reddit/retention.job';
import {
  DISCLOSURE,
  api,
  ok,
  versionBody,
  redditAi,
  redditDraftJson,
  redditStack,
  redditWorld,
  seedStudio,
  type Api,
  type RedditStack,
  type RedditWorld,
  type StudioIds,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(240_000);

const EXCERPT =
  'Our shop writes one long guide a month; how do we reuse it without rewriting everything?';

ciDescribe('P-R M2: ретенция выдержек тредов (reddit-retention)', () => {
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

  const run = (now = new Date()) =>
    s.mod.get(RedditRetentionJob).run({
      now,
      scope: { siteIds: [w.product.siteId!] },
      deadline: new Date(Date.now() + 60_000),
    });

  async function archived(
    briefArchived = true,
  ): Promise<{ ids: StudioIds; sourceId: string; threadUrl: string }> {
    const ids = await seedStudio(s, w, ed, po, {
      opportunity: { excerpt: EXCERPT },
      withContent: false,
    });
    const b = await s.prisma.pubRedditBrief.findUniqueOrThrow({
      where: { id: ids.briefId },
    });
    if (briefArchived)
      ok(
        await ed.post(`${w.P}/briefs/${b.id}/archive`, {
          expectedRevision: b.revision,
        }),
        200,
      );
    const o = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
      where: { id: ids.opportunityId! },
    });
    ok(
      await ed.post(`${w.P}/opportunities/${o.id}/archive`, {
        expectedRevision: o.revision,
      }),
      200,
    );
    return { ids, sourceId: o.excerptSourceId!, threadUrl: o.threadUrl };
  }

  /** Возможности треда «устарели» на `days` дней (в обход триггеров — тест). */
  async function age(threadUrl: string, days: number): Promise<void> {
    await s.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL session_replication_role = replica`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "sites"."pub_reddit_opportunities" SET "updatedAt" = now() - ($2 || ' days')::interval WHERE "productId" = $1 AND "threadUrl" = $3`,
        w.product.id,
        String(days),
        threadUrl,
      );
    });
  }

  it('срок не вышел → ничего; 181 день → выдержка и context архивного брифа — плейсхолдер, новый contentHash, ответы мутаций очищены, аудит erase; повтор — no-op', async () => {
    const { ids, sourceId, threadUrl } = await archived();
    const stored = async () =>
      (
        await s.prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM "sites"."pub_idempotency_keys"
           WHERE "productId" = ${w.product.id}
             AND "responseBody"::text LIKE ${`%${EXCERPT}%`}`
      )[0].n;
    expect(Number(await stored())).toBeGreaterThan(0);
    await run();
    const fresh = await s.prisma.pubSource.findUniqueOrThrow({
      where: { id: sourceId },
    });
    expect(fresh.fragment).toBe(EXCERPT);
    await age(threadUrl, 181);
    const r = await run();
    expect(r.details).toMatchObject({
      threads: 1,
      sourcesRedacted: 1,
      briefsRedacted: 1,
    });
    const src = await s.prisma.pubSource.findUniqueOrThrow({
      where: { id: sourceId },
    });
    expect(src.fragment).toBe(REDDIT_RETENTION_PLACEHOLDER);
    expect(src.contentHash).toBe(
      sourceContentHash(src.url, REDDIT_RETENTION_PLACEHOLDER),
    );
    expect(src.contentHash).not.toBe(fresh.contentHash);
    const brief = await s.prisma.pubRedditBrief.findUniqueOrThrow({
      where: { id: ids.briefId },
    });
    expect(brief.context).toBe(REDDIT_RETENTION_PLACEHOLDER);
    expect(Number(await stored())).toBe(0);
    const erased = await s.prisma.pubAuditEvent.findMany({
      where: {
        productId: w.product.id,
        action: 'erase',
        actor: 'system:reddit-retention',
      },
    });
    expect(erased.map((e) => e.objectType).sort()).toEqual([
      'reddit_brief',
      'source',
    ]);
    expect(JSON.stringify(erased)).not.toContain(EXCERPT);
    // В кабинете — плейсхолдер.
    const view = ok<{ context: string }>(
      await ed.get(`${w.P}/briefs/${ids.briefId}`),
      200,
    );
    expect(view.context).toBe(REDDIT_RETENTION_PLACEHOLDER);
    const again = await run();
    expect(again.details).toMatchObject({ threads: 0, sourcesRedacted: 0 });
  });

  it('активный бриф держит выдержку; срок — из параметра продукта (30 дней)', async () => {
    const { sourceId, threadUrl } = await archived(false);
    await age(threadUrl, 400);
    const r = await run();
    // Р-RD-71: тред с неархивным брифом не отбирается вовсе; и сама
    // обработка треда (второй предохранитель) его не трогает.
    expect(r.details).toMatchObject({ threads: 0, sourcesRedacted: 0 });
    const direct = await s.db
      .forAccount(w.acc.accountId)
      .$transaction((tx) =>
        s.mod
          .get(RedditRetentionJob)
          .redactThread(
            tx as never,
            { id: w.product.id, accountId: w.acc.accountId },
            threadUrl,
            new Date(),
          ),
      );
    expect(direct.status).toBe('active_brief');
    expect(
      (await s.prisma.pubSource.findUniqueOrThrow({ where: { id: sourceId } }))
        .fragment,
    ).toBe(EXCERPT);

    const second = await archived();
    await approveParams(
      s.prisma,
      { accountId: w.acc.accountId, ownerMemberId: w.acc.owner.memberId },
      w.product.id,
      { reddit_excerpt_retention_days: { days: 30 } },
    );
    await age(second.threadUrl, 29);
    await run();
    expect(
      (
        await s.prisma.pubSource.findUniqueOrThrow({
          where: { id: second.sourceId },
        })
      ).fragment,
    ).toBe(EXCERPT);
    await age(second.threadUrl, 31);
    await run();
    expect(
      (
        await s.prisma.pubSource.findUniqueOrThrow({
          where: { id: second.sourceId },
        })
      ).fragment,
    ).toBe(REDDIT_RETENTION_PLACEHOLDER);
  });

  it('R2 (аудит S2-4, Р-RD-71): отбор по сроку в SQL и курсор пачками — истёкшие треды за недавними обрабатываются все, недавние не трогаются', async () => {
    const job = s.mod.get(RedditRetentionJob);
    const saved = job.batchSize;
    job.batchSize = 2;
    try {
      const recent = [await archived(), await archived(), await archived()];
      const expired = [await archived(), await archived(), await archived()];
      for (const e of expired) await age(e.threadUrl, 400);
      const r = await run();
      expect(r.details).toMatchObject({
        threads: 3,
        sourcesRedacted: 3,
        notDue: 0,
      });
      expect((r.details as { batches: number }).batches).toBeGreaterThanOrEqual(
        2,
      );
      for (const e of expired)
        expect(
          (
            await s.prisma.pubSource.findUniqueOrThrow({
              where: { id: e.sourceId },
            })
          ).fragment,
        ).toBe(REDDIT_RETENTION_PLACEHOLDER);
      for (const x of recent)
        expect(
          (
            await s.prisma.pubSource.findUniqueOrThrow({
              where: { id: x.sourceId },
            })
          ).fragment,
        ).toBe(EXCERPT);
    } finally {
      job.batchSize = saved;
    }
  });

  it('S3-9 (Р-RD-70): выход генерации брифа, цитирующий выдержку, — плейсхолдер в журнале AI и в сохранённом ответе /generate', async () => {
    const ai = await redditAi(s, w);
    try {
      const ids = await seedStudio(s, w, ed, po, {
        opportunity: { excerpt: EXCERPT },
      });
      ai.model.reply(
        redditDraftJson(2, 'comment', ids.sourceId, (i) =>
          i === 0
            ? {
                body: `${DISCLOSURE}\n\nYou wrote: "${EXCERPT}" — here is a plan.`,
              }
            : {},
        ),
      );
      const g = ok<{ callId: string }>(
        await ed.post(`${w.P}/briefs/${ids.briefId}/generate`, {
          template: 'helpful_answer',
          variants: 2,
        }),
        200,
      );
      // Раунд 2 (Р-RD-83): «переписать абзац» — задача черновика; её
      // выход с фрагментом выдержки из 6 слов подряд тоже маскируется.
      const d = ok<{ id: string }>(
        await ed.post(
          `/publisher/products/${w.product.id}/contents/${ids.contentId}/versions`,
          {
            body: versionBody('Second paragraph.'),
            meta: { disclosure: DISCLOSURE, claimMap: [], uncertainties: [] },
          },
        ),
        201,
      );
      ai.model.reply(
        redditDraftJson(2, 'comment', ids.sourceId, (i) =>
          i === 1
            ? {
                body: `${DISCLOSURE}\n\nSo: one long guide a month, how do you reuse it?`,
              }
            : {},
        ),
      );
      const rw = ok<{ callId: string }>(
        await ed.post(`${w.P}/briefs/${ids.briefId}/generate`, {
          template: 'helpful_answer',
          variants: 2,
          rewrite: { versionId: d.id, paragraph: 1 },
        }),
        200,
      );
      const b = await s.prisma.pubRedditBrief.findUniqueOrThrow({
        where: { id: ids.briefId },
      });
      const c = await s.prisma.pubContent.findFirstOrThrow({
        where: { redditBriefId: b.id },
      });
      // материал снят, бриф и возможность — в архив
      ok(
        await po.post(
          `/publisher/products/${w.product.id}/contents/${c.id}/transition`,
          {
            to: 'withdrawn',
            reason: 'Тред закрито',
            expectedRevision: c.revision,
          },
        ),
        200,
      );
      ok(
        await ed.post(`${w.P}/briefs/${b.id}/archive`, {
          expectedRevision: b.revision,
        }),
        200,
      );
      const o = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
        where: { id: ids.opportunityId! },
      });
      ok(
        await ed.post(`${w.P}/opportunities/${o.id}/archive`, {
          expectedRevision: o.revision,
        }),
        200,
      );
      await age(o.threadUrl, 400);
      const r = await run();
      expect((r.details as { aiCallsRedacted: number }).aiCallsRedacted).toBe(
        2,
      );
      const rwCall = await s.prisma.pubAiCall.findUniqueOrThrow({
        where: { id: rw.callId },
      });
      expect(JSON.stringify(rwCall.output)).not.toContain('one long guide');
      expect(JSON.stringify(rwCall.output)).toContain(
        REDDIT_RETENTION_PLACEHOLDER,
      );
      const call = await s.prisma.pubAiCall.findUniqueOrThrow({
        where: { id: g.callId },
      });
      expect(JSON.stringify(call.output)).not.toContain(
        'reuse it without rewriting',
      );
      expect(JSON.stringify(call.output)).toContain(
        REDDIT_RETENTION_PLACEHOLDER,
      );
      expect(call.status).toBe('ok');
      const stored = await s.prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM "sites"."pub_idempotency_keys"
         WHERE "productId" = ${w.product.id}
           AND "responseBody"::text LIKE ${'%reuse it without rewriting%'}`;
      expect(Number(stored[0].n)).toBe(0);
    } finally {
      ai.restore();
    }
  });

  it('раунд 2 (S3-6, Р-RD-84): архивный продукт — ретенция тоже работает (приватность важнее «заморозки»)', async () => {
    const w2 = await redditWorld(s);
    const ed2 = api(s, w2.acc.accountId, w2.team.editor);
    const po2 = api(s, w2.acc.accountId, w2.team.product_owner);
    const ids = await seedStudio(s, w2, ed2, po2, {
      opportunity: { excerpt: EXCERPT },
      withContent: false,
    });
    const b = await s.prisma.pubRedditBrief.findUniqueOrThrow({
      where: { id: ids.briefId },
    });
    ok(
      await ed2.post(`${w2.P}/briefs/${b.id}/archive`, {
        expectedRevision: b.revision,
      }),
      200,
    );
    const o = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
      where: { id: ids.opportunityId! },
    });
    ok(
      await ed2.post(`${w2.P}/opportunities/${o.id}/archive`, {
        expectedRevision: o.revision,
      }),
      200,
    );
    await s.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL session_replication_role = replica`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "sites"."pub_reddit_opportunities" SET "updatedAt" = now() - interval '400 days' WHERE "productId" = $1`,
        w2.product.id,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "sites"."pub_products" SET "status" = 'archived' WHERE "id" = $1`,
        w2.product.id,
      );
    });
    const r = await s.mod.get(RedditRetentionJob).run({
      now: new Date(),
      scope: { siteIds: [w2.product.siteId!] },
      deadline: new Date(Date.now() + 60_000),
    });
    expect(r.details).toMatchObject({ threads: 1, sourcesRedacted: 1 });
    const src = await s.prisma.pubSource.findUniqueOrThrow({
      where: { id: o.excerptSourceId! },
    });
    expect(src.fragment).toBe(REDDIT_RETENTION_PLACEHOLDER);
  });

  it('гвард базы: выдержку P-R правят только плейсхолдером (иное — 23514)', async () => {
    const { sourceId } = await archived();
    await expect(
      s.prisma.pubSource.update({
        where: { id: sourceId },
        data: { fragment: 'Other text', contentHash: 'b'.repeat(64) },
      }),
    ).rejects.toThrow();
  });
});
