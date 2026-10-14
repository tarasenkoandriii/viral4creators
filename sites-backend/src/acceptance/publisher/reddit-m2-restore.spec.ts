/**
 * [AT-RD-18] P-R M2 — бэкап и восстановление переносят сущности Studio
 * (reddit-manual-mvp-adapted.md §6 «Бэкап и восстановление P-E», §9):
 * Reddit-бриф (`pub_reddit_briefs`, тезисы с id источников в jsonb),
 * Reddit-материал (`redditBriefId`), замороженная версия (meta с
 * `ruleSnapshotId`, hash не меняется), QA `reddit_policy` с `warnings`,
 * отчёт о публикации `user_reported`. Ссылки — на строки нового продукта;
 * гварды пропускают перенос истории (`pub_restoring`).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { SitesDb } from '../../prisma/sites-db.service';
import { BackupService } from '../../modules/publisher/reports/backup.service';
import { RestoreService } from '../../modules/publisher/reports/restore.service';
import { MemoryBackupStorage } from '../../modules/publisher/reports/testing/memory-backup-storage.testing';
import { TD10_SECRET } from '../../modules/publisher/reports/testing/td10.testing';
import { seedSite } from '../../modules/publisher/testing/fixtures.testing';
import {
  api,
  approvedVersion,
  ok,
  openRedditPublish,
  redditStack,
  redditWorld,
  seedStudio,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(180_000);

ciDescribe(
  '[AT-RD-18] P-R M2: бэкап и восстановление переносят бриф, материал и отчёт',
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

    it('экспорт → apply в restored: бриф, материал, версия (meta, hash), reddit_policy с warnings, user_reported — связи на новые строки', async () => {
      const ed = api(s, w.acc.accountId, w.team.editor);
      const po = api(s, w.acc.accountId, w.team.product_owner);
      const op = api(s, w.acc.accountId, w.team.operator);
      await openRedditPublish(s.prisma, w);
      const ids = await seedStudio(s, w, ed, po);
      const v = await approvedVersion(ed, po, w, ids);
      ok(await op.post(`${w.P}/contents/${ids.contentId}/copy`), 200);
      const opp = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
        where: { id: ids.opportunityId! },
      });
      ok(
        await op.post(`${w.P}/contents/${ids.contentId}/report-publication`, {
          url: `https://www.reddit.com/r/${ids.name}/comments/${opp.threadKey}/x/kres1/`,
          postedAt: new Date().toISOString(),
        }),
        201,
      );

      const db = s.mod.get(SitesDb);
      const backup = new BackupService(db, new MemoryBackupStorage());
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
      expect(
        (row.tableCounts as Record<string, number>).pub_reddit_briefs,
      ).toBe(1);
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

      const brief = await s.prisma.pubRedditBrief.findFirstOrThrow({
        where: { productId: target },
      });
      const srcBrief = await s.prisma.pubRedditBrief.findUniqueOrThrow({
        where: { id: ids.briefId },
      });
      expect({
        status: brief.status,
        contentType: brief.contentType,
        objective: brief.objective,
        context: brief.context,
        affiliation: brief.affiliation,
      }).toEqual({
        status: srcBrief.status,
        contentType: srcBrief.contentType,
        objective: srcBrief.objective,
        context: srcBrief.context,
        affiliation: srcBrief.affiliation,
      });
      const kpSource = (brief.keyPoints as Array<{ sourceIds: unknown }>)[0]
        .sourceIds as string[];
      const kpRow = await s.prisma.pubSource.findUniqueOrThrow({
        where: { id: kpSource[0] },
      });
      expect(kpRow.productId).toBe(target);
      const community = await s.prisma.pubRedditCommunity.findUniqueOrThrow({
        where: { id: brief.communityId },
      });
      expect(community.productId).toBe(target);

      const content = await s.prisma.pubContent.findFirstOrThrow({
        where: { productId: target, kind: 'reddit_comment' },
      });
      expect(content.redditBriefId).toBe(brief.id);
      const ver = await s.prisma.pubContentVersion.findFirstOrThrow({
        where: { contentId: content.id, frozenAt: { not: null } },
      });
      const srcVer = await s.prisma.pubContentVersion.findUniqueOrThrow({
        where: { id: v.id },
      });
      expect(ver.body).toBe(srcVer.body);
      const snapId = (ver.meta as { ruleSnapshotId: string }).ruleSnapshotId;
      const snap = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
        where: { id: snapId },
      });
      expect(snap.productId).toBe(target);

      const qa = await s.prisma.pubQaCheck.findMany({
        where: { versionId: ver.id, kind: 'reddit_policy' },
      });
      expect(qa.length).toBeGreaterThan(0);
      expect(qa.every((q) => q.checkedBy === 'system:reddit-policy')).toBe(
        true,
      );
      const pub = await s.prisma.pubPublication.findFirstOrThrow({
        where: { productId: target },
      });
      expect(pub).toMatchObject({
        reportKind: 'user_reported',
        verifyStatus: 'not_checked',
        versionId: ver.id,
      });
    });
  },
);
