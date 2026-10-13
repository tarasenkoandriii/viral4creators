/**
 * [AT-RD-18] P-R M1 — бэкап и восстановление P-E переносят Reddit-сущности
 * (reddit-manual-mvp-adapted.md §6 «Бэкап и восстановление P-E», §9).
 * Экспорт включает пять таблиц `pub_reddit_*` (реестр таблиц, порядок по
 * FK); восстановление в новый продукт `restored`: снимки правил — как были
 * (`reviewed`/`selfReview`/версии/`superseded`), возможности — без
 * изменений (статус, policy, факторы, score, тред), ссылки (`communityId`,
 * `ruleSnapshotId`, `excerptSourceId`, `channelId`, `keywordIds` в jsonb)
 * переназначены на новые строки; гварды P-R пропускают перенос истории
 * (`pub_restoring`), версии не пересчитываются.
 *
 * Реаудит N-5: первоисточник правил, отозванный ПОСЛЕ копии, — при переносе
 * тот же каскад P-R, что у штатного отзыва: возможности сообщества →
 * `recheck_required/block [rules_source_revoked]` с аудитом
 * `restore:<id>`; хранимое состояние = живому гейту (`policyNow`).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { SitesDb } from '../../prisma/sites-db.service';
import { BackupService } from '../../modules/publisher/reports/backup.service';
import { RestoreService } from '../../modules/publisher/reports/restore.service';
import { opportunityViews } from '../../modules/publisher/reddit/views';
import { MemoryBackupStorage } from '../../modules/publisher/reports/testing/memory-backup-storage.testing';
import { TD10_SECRET } from '../../modules/publisher/reports/testing/td10.testing';
import { seedSite } from '../../modules/publisher/testing/fixtures.testing';
import {
  api,
  ok,
  redditStack,
  redditWorld,
  rulesBody,
  seedCommunity,
  seedOpportunity,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(180_000);

const TABLES = [
  'pub_reddit_projects',
  'pub_reddit_communities',
  'pub_reddit_rule_snapshots',
  'pub_reddit_keywords',
  'pub_reddit_opportunities',
] as const;

ciDescribe(
  '[AT-RD-18] бэкап и восстановление переносят Reddit-сущности по правилам P-E',
  () => {
    let s: RedditStack;
    let w: RedditWorld;
    const saved = process.env.ASSIST_SECRETS_KEY;

    beforeAll(async () => {
      process.env.ASSIST_SECRETS_KEY = TD10_SECRET;
      s = await redditStack();
      w = await redditWorld(s);
    });
    afterAll(async () => {
      if (saved === undefined) delete process.env.ASSIST_SECRETS_KEY;
      else process.env.ASSIST_SECRETS_KEY = saved;
      await s?.close();
    });

    it('экспорт → apply в restored: строки, статусы, версии, review и связи сохранены', async () => {
      const ed = api(s, w.acc.accountId, w.team.editor);
      const po = api(s, w.acc.accountId, w.team.product_owner);
      // v1 проверил автор (selfReview), затем v2 — не проверен.
      const c = await seedCommunity(ed, w.P, {
        rules: 'allowed',
        reviewer: ed,
      });
      const kw = ok<{ id: string }>(
        await ed.post(`${w.P}/keywords`, {
          projectId: c.projectId,
          phrase: 'site chatbot',
          intent: 'recommendation',
          priority: 4,
        }),
        201,
      );
      const o1 = ok<{ id: string; revision: number }>(
        await seedOpportunity(ed, w.P, c, { keywordIds: [kw.id] }),
        201,
      );
      ok(
        await ed.post(`${w.P}/opportunities/${o1.id}/qualify`, {
          expectedRevision: o1.revision,
        }),
        200,
      );
      const o2 = ok<{ id: string }>(await seedOpportunity(ed, w.P, c), 201);
      const v2 = ok<{ id: string }>(
        await ed.post(
          `${w.P}/communities/${c.communityId}/rules`,
          rulesBody(c.name, 'restricted'),
        ),
        201,
      );
      // Вторая пара: проверенный чужим (не selfReview) снимок.
      const c2 = await seedCommunity(ed, w.P, {
        projectId: c.projectId,
        rules: 'prohibited_links',
        reviewer: po,
      });
      ok(await seedOpportunity(ed, w.P, c2), 201);

      const db = s.mod.get(SitesDb);
      const mem = new MemoryBackupStorage();
      const backup = new BackupService(db, mem);
      const restore = new RestoreService(db);
      const product = { id: w.product.id, accountId: w.acc.accountId };
      const prepared = await backup.prepare(product, new Date());
      expect(prepared.status).toBe('ok');
      await db
        .forAccount(w.acc.accountId)
        .$transaction((tx) =>
          backup.insertRow(
            tx,
            product,
            prepared,
            'manual',
            'member:m1',
            new Date(),
          ),
        );
      const row = await s.prisma.pubBackup.findFirstOrThrow({
        where: { id: prepared.id },
      });
      const counts = row.tableCounts as Record<string, number>;
      expect(TABLES.map((t) => counts[t])).toEqual([1, 2, 3, 1, 3]);

      const targetSite = await seedSite(s.prisma, w.acc.accountId);
      const doc = await backup.load(row);
      const started = await db
        .forAccount(w.acc.accountId)
        .$transaction((tx) =>
          restore.start(tx, product, row, targetSite, 'member:m1', new Date()),
        );
      const done = await restore.transfer(
        w.acc.accountId,
        started.restore.id,
        doc,
      );
      expect(done.status).toBe('done');
      const target = started.restore.targetProductId as string;

      const src = (t: (typeof TABLES)[number], productId: string) =>
        s.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT * FROM "sites"."${t}" WHERE "productId" = $1 ORDER BY "createdAt", "id"`,
          productId,
        );
      for (const t of TABLES)
        expect({ t, n: (await src(t, target)).length }).toEqual({
          t,
          n: (await src(t, w.product.id)).length,
        });

      const snapView = async (productId: string) =>
        (
          await s.prisma.pubRedditRuleSnapshot.findMany({
            where: { productId },
          })
        )
          .map(
            (x) => `${x.version}|${x.status}|${x.reviewState}|${x.selfReview}`,
          )
          .sort();
      expect(await snapView(target)).toEqual(await snapView(w.product.id));
      expect(await snapView(target)).toEqual([
        '1|current|reviewed|false',
        '1|superseded|reviewed|true',
        '2|current|unreviewed|false',
      ]);
      const snaps = await s.prisma.pubRedditRuleSnapshot.findMany({
        where: { productId: target },
      });
      expect(snaps.every((x) => x.createdBy.startsWith('restore:'))).toBe(true);

      const oppsSrc = await s.prisma.pubRedditOpportunity.findMany({
        where: { productId: w.product.id },
        orderBy: { threadKey: 'asc' },
      });
      const oppsDst = await s.prisma.pubRedditOpportunity.findMany({
        where: { productId: target },
        orderBy: { threadKey: 'asc' },
      });
      const pick = (o: (typeof oppsSrc)[number]) => ({
        threadUrl: o.threadUrl,
        threadKey: o.threadKey,
        status: o.status,
        policy: o.policy,
        policyReasons: o.policyReasons,
        factors: o.factors,
        relevance: o.relevance,
        risk: o.risk,
        priority: o.priority,
        titleManual: o.titleManual,
      });
      expect(oppsDst.map(pick)).toEqual(oppsSrc.map(pick));
      const statuses = Object.fromEntries(oppsSrc.map((o) => [o.id, o.status]));
      expect(statuses[o1.id]).toBe('recheck_required');
      expect(statuses[o2.id]).toBe('recheck_required');

      // Ссылки — на строки НОВОГО продукта.
      const dstKw = await s.prisma.pubRedditKeyword.findFirstOrThrow({
        where: { productId: target },
      });
      const withKw = oppsDst.find(
        (o) => (o.keywordIds as string[]).length > 0,
      )!;
      expect(withKw.keywordIds).toEqual([dstKw.id]);
      for (const o of oppsDst) {
        const comm = await s.prisma.pubRedditCommunity.findFirstOrThrow({
          where: { id: o.communityId },
        });
        expect(comm.productId).toBe(target);
        const ch = await s.prisma.pubChannel.findFirstOrThrow({
          where: { id: comm.channelId },
        });
        expect(ch).toMatchObject({ productId: target, kind: 'community' });
        const sx = o.excerptSourceId
          ? await s.prisma.pubSource.findFirst({
              where: { id: o.excerptSourceId },
            })
          : null;
        expect(
          sx && {
            productId: sx.productId,
            kind: sx.kind,
            usage: sx.usage,
          },
        ).toEqual({
          productId: target,
          kind: 'discussion',
          usage: 'restricted',
        });
        const rs = o.ruleSnapshotId
          ? await s.prisma.pubRedditRuleSnapshot.findFirst({
              where: { id: o.ruleSnapshotId },
            })
          : null;
        expect(rs?.productId).toBe(target);
      }
      expect(v2.id).not.toBe(snaps[0].id);
    });
    it('N-5: первоисточник правил отозван после копии — в restored возможности recheck_required/block [rules_source_revoked], аудит restore:<id>, policyNow = хранимому', async () => {
      const ed = api(s, w.acc.accountId, w.team.editor);
      const po = api(s, w.acc.accountId, w.team.product_owner);
      const c = await seedCommunity(ed, w.P, {
        rules: 'allowed',
        reviewer: po,
      });
      const o = ok<{ id: string; revision: number }>(
        await seedOpportunity(ed, w.P, c),
        201,
      );
      ok(
        await ed.post(`${w.P}/opportunities/${o.id}/qualify`, {
          expectedRevision: o.revision,
        }),
        200,
      );
      const db = s.mod.get(SitesDb);
      const backup = new BackupService(db, new MemoryBackupStorage());
      const restore = new RestoreService(db);
      const product = { id: w.product.id, accountId: w.acc.accountId };
      const prepared = await backup.prepare(product, new Date());
      await db
        .forAccount(w.acc.accountId)
        .$transaction((tx) =>
          backup.insertRow(
            tx,
            product,
            prepared,
            'manual',
            'member:m1',
            new Date(),
          ),
        );
      const row = await s.prisma.pubBackup.findFirstOrThrow({
        where: { id: prepared.id },
      });
      const doc = await backup.load(row);
      // Отзыв ПОСЛЕ копии.
      const snap = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
        where: { id: c.snapshotId! },
      });
      ok(
        await po.post(
          `/publisher/products/${w.product.id}/sources/${snap.sourceId}/revoke`,
          { reason: 'Правила зняті модераторами' },
        ),
        200,
      );
      const targetSite = await seedSite(s.prisma, w.acc.accountId);
      const started = await db
        .forAccount(w.acc.accountId)
        .$transaction((tx) =>
          restore.start(tx, product, row, targetSite, 'member:m1', new Date()),
        );
      const done = await restore.transfer(
        w.acc.accountId,
        started.restore.id,
        doc,
      );
      expect(done.status).toBe('done');
      const target = started.restore.targetProductId as string;
      expect(
        (done.report as { applied: Record<string, number> }).applied,
      ).toMatchObject({ sourcesMarkedRevoked: 1 });

      const dstComm = await s.prisma.pubRedditCommunity.findFirstOrThrow({
        where: { productId: target, name: c.name },
      });
      const dst = await s.prisma.pubRedditOpportunity.findMany({
        where: { productId: target, communityId: dstComm.id },
      });
      expect(dst).toHaveLength(1);
      expect(dst[0]).toMatchObject({
        status: 'recheck_required',
        policy: 'block',
        policyReasons: ['rules_source_revoked'],
      });
      const [view] = await db
        .forAccount(w.acc.accountId)
        .$transaction((tx) => opportunityViews(tx, target, dst));
      expect([view.policyNow, view.policyNowReasons]).toEqual([
        view.policy,
        view.policyReasons,
      ]);
      const audit = await s.prisma.pubAuditEvent.findMany({
        where: {
          productId: target,
          objectType: 'reddit_opportunity',
          objectId: dst[0].id,
          actor: `restore:${started.restore.id}`,
        },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'transition',
        fromStatus: 'qualified',
        toStatus: 'recheck_required',
      });
      expect(
        (done.report as { applied: Record<string, number> }).applied
          .redditOpportunitiesRecheck,
      ).toBe(1);
    });
  },
);
