/**
 * AI Publisher, P-C — публикации и наблюдение (проектный документ §7.1,
 * §7.2, §10; ДТ-1; раунд исправлений аудита P-C):
 *  - S3-3: автоперевод `publications-verify` pending → published у
 *    live-публикации — только при открытом гейте `public_publish`;
 *  - S3-5: начало 7 дней наблюдения — одно правило: самая ранняя первая
 *    публикация среди материала и его статьи (рабочий продукт — по live,
 *    тестовый — по публикациям тестовой стадии, без записей размещений);
 *  - S3-6: снятие статьи снимает и публикации её адаптаций.
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import { SitesDb } from '../../../prisma/sites-db.service';
import { addKyivCalendarDays } from '../core/kyiv-time';
import { PubPorts, type PubTx } from '../core/ports';
import { seedVerifiedHost } from '../testing/fixtures.testing';
import { observationPassed, observationStart } from './content-read';
import {
  PublicationsService,
  PublicationsVerifyJob,
} from './publications.service';
import {
  approveParam,
  distStack,
  seedAdaptation,
  seedArticle,
  seedTd08,
  type DistStack,
} from './testing/td08.testing';

jest.setTimeout(120_000);

const PUBLISH_KEYS = [
  'niche',
  'language',
  'market',
  'offer_active_version',
  'domain_host',
  'hosting',
  'data_notice_version',
  'consent_map',
  'analytics_storage',
  'event_map',
  'perf_targets',
  'responsibles',
  'qualification_rules',
  'pilot_calendar',
  'launch_evidence_d0',
];

ciDescribe(
  'P-C: публикации — гейт автоперевода, наблюдение, каскад снятия',
  () => {
    let s: DistStack;
    beforeAll(async () => {
      s = await distStack();
    });
    afterAll(async () => {
      await s.close();
    });

    async function approvalOf(versionId: string): Promise<string> {
      const a = await s.prisma.pubApproval.findFirstOrThrow({
        where: {
          objectId: versionId,
          type: 'publish_version',
          status: 'active',
        },
        select: { id: true },
      });
      return a.id;
    }

    it('S3-3: live pending при закрытом public_publish — проверка пишется, публикация остаётся pending; гейт открыт — published', async () => {
      const w = await seedTd08(s.prisma, s.budget, {
        kind: 'working',
        mode: 'live',
      });
      await seedVerifiedHost(
        s.prisma,
        w.acc.accountId,
        w.product.siteId,
        'ai-publisher.org',
      );
      const art = await seedArticle(s.prisma, w.ref);
      const url = `https://ai-publisher.org/materials/${art.slug}`;
      const pub = await s.prisma.pubPublication.create({
        data: {
          accountId: w.ref.accountId,
          productId: w.ref.id,
          versionId: art.versionId,
          channelId: w.siteChannelId,
          approvalId: await approvalOf(art.versionId),
          stage: 'live',
          finalUrl: url,
          status: 'pending',
          opKey: randomUUID(),
          createdBy: 'member:td08-operator',
        },
      });
      const job = new PublicationsVerifyJob(
        s.mod.get(SitesDb),
        s.mod.get(PubPorts),
        s.mod.get(PublicationsService),
        {
          read: async () => ({
            ok: true,
            status: 200,
            html: `<meta name="pub-version" content="${art.versionHash}">`,
          }),
        },
      );
      const d = { id: pub.id, accountId: w.ref.accountId, productId: w.ref.id };
      await job.checkOne(d, new Date());
      expect(
        await s.prisma.pubPublication.findFirstOrThrow({
          where: { id: pub.id },
        }),
      ).toMatchObject({
        verifyStatus: 'ok',
        status: 'pending',
        publishedAt: null,
      });
      expect(s.content.published.map((x) => x.publicationId)).not.toContain(
        pub.id,
      );
      for (const key of PUBLISH_KEYS) await approveParam(s.prisma, w.ref, key);
      await job.checkOne(d, new Date());
      expect(
        await s.prisma.pubPublication.findFirstOrThrow({
          where: { id: pub.id },
        }),
      ).toMatchObject({ verifyStatus: 'ok', status: 'published' });
      expect(s.content.published.map((x) => x.publicationId)).toContain(pub.id);
    });

    it('S3-5: наблюдение адаптации — с первой публикации статьи (рабочий и тестовый продукт одним правилом)', async () => {
      const now = new Date();
      // Рабочий продукт: статья опубликована live 10 дней назад, пост — сегодня.
      const wk = await seedTd08(s.prisma, s.budget, {
        kind: 'working',
        mode: 'live',
      });
      const post = await seedAdaptation(s.prisma, wk.ref, {
        articleId: wk.articleId,
        articleVersionId: wk.versionId,
      });
      const tenDays = addKyivCalendarDays(now, -10);
      await s.prisma.pubContent.update({
        where: { id: wk.articleId },
        data: { firstPublishedAt: tenDays },
      });
      await s.prisma.pubContent.update({
        where: { id: post.contentId },
        data: { firstPublishedAt: now },
      });
      const startW = await s.prisma.$transaction((tx) =>
        observationStart(
          tx as unknown as PubTx,
          { id: wk.product.id, kind: 'working' },
          [post.contentId, wk.articleId],
          now,
        ),
      );
      expect(startW?.toISOString()).toBe(tenDays.toISOString());
      expect(observationPassed(startW, now)).toBe(true);
      // Только пост (статья не опубликована) — 7 дней не прошли.
      const onlyPost = await s.prisma.$transaction((tx) =>
        observationStart(
          tx as unknown as PubTx,
          { id: wk.product.id, kind: 'working' },
          [post.contentId],
          now,
        ),
      );
      expect(observationPassed(onlyPost, now)).toBe(false);

      // Тестовый продукт: статья — тестовая публикация 10 дней назад (TD-08);
      // запись размещения закупки 20 дней назад началом не считается.
      const wt = await seedTd08(s.prisma, s.budget);
      const paid = await s.prisma.pubChannel.create({
        data: {
          accountId: wt.ref.accountId,
          productId: wt.ref.id,
          code: 'paid-venues',
          name: 'Платні майданчики',
          kind: 'paid_venue',
          utmSource: 'paid-venues',
          utmMedium: 'paid',
          createdBy: 'system:td08',
        },
      });
      await s.prisma.pubPublication.create({
        data: {
          accountId: wt.ref.accountId,
          productId: wt.ref.id,
          versionId: wt.versionId,
          channelId: paid.id,
          approvalId: await approvalOf(wt.versionId),
          stage: 'test',
          finalUrl: 'https://venue.example/old',
          publishedAt: addKyivCalendarDays(now, -20),
          status: 'published',
          opKey: randomUUID(),
          createdBy: 'member:td08-operator',
        },
      });
      const startT = await s.prisma.$transaction((tx) =>
        observationStart(
          tx as unknown as PubTx,
          { id: wt.product.id, kind: 'test' },
          [wt.articleId],
          null,
        ),
      );
      const site = await s.prisma.pubPublication.findFirstOrThrow({
        where: { productId: wt.product.id, channelId: wt.siteChannelId },
        select: { publishedAt: true },
      });
      expect(startT?.toISOString()).toBe(site.publishedAt?.toISOString());
    });

    it('S3-6: снятие статьи снимает и публикации её адаптаций', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const post = await seedAdaptation(s.prisma, w.ref, {
        articleId: w.articleId,
        articleVersionId: w.versionId,
      });
      const tg = await s.prisma.pubChannel.create({
        data: {
          accountId: w.ref.accountId,
          productId: w.ref.id,
          code: 'tg',
          name: 'Telegram',
          kind: 'own',
          utmSource: 'telegram',
          utmMedium: 'social',
          createdBy: 'system:td08',
        },
      });
      const postPub = await s.prisma.pubPublication.create({
        data: {
          accountId: w.ref.accountId,
          productId: w.ref.id,
          versionId: post.versionId,
          channelId: tg.id,
          approvalId: await approvalOf(post.versionId),
          stage: 'test',
          finalUrl: 'https://t.me/s/ai_publisher_ua/7',
          publishedAt: new Date(),
          status: 'published',
          opKey: randomUUID(),
          createdBy: 'member:td08-operator',
        },
      });
      const out = await s.prisma.$transaction((tx) =>
        s.mod
          .get(PublicationsService)
          .withdrawForContent(tx as unknown as PubTx, w.ref, w.articleId, {
            reason: 'Статтю знято редактором',
            actors: ['product_owner'],
          }),
      );
      expect(out.map((x) => x.publicationId)).toContain(postPub.id);
      expect(out).toHaveLength(2);
      expect(
        await s.prisma.pubPublication.count({
          where: { productId: w.product.id, status: 'published' },
        }),
      ).toBe(0);
    });
  },
);
