/**
 * [AT-F09-01] Календарь распространения по адаптациям (P-C, проектный
 * документ §6.4, §7.5; F09): вручную (AI-план в P0 выключен, ДТ-2); у
 * каждого действия — формат, владелец, версия и измеряемая ссылка: с UTM
 * для внешнего канала, без UTM для собственного сайта; запись задачи не
 * равна факту публикации — `done` только с записью публикации и реальным
 * URL; выгрузка CSV экранирует формулы.
 */
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  apiAs,
  distStack,
  seedAdaptation,
  seedTd08,
  type DistStack,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-F09-01] календарь: формат, владелец, версия, измеряемая ссылка',
  () => {
    let s: DistStack;
    beforeAll(async () => {
      s = await distStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('действия по адаптации и статье; UTM у канала Telegram, без UTM у сайта; done — только с публикацией', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const ad = await seedAdaptation(s.prisma, w.ref, {
        articleId: w.articleId,
        articleVersionId: w.versionId,
      });
      const srv = s.app!.getHttpServer();
      const op = apiAs(srv, w.acc.accountId, w.team.operator);
      const P = `/publisher/products/${w.product.id}`;

      const ai = await op.post(`${P}/distribution/plan`, {
        contentId: w.articleId,
      });
      expect(ai.status).toBe(409);
      expect(ai.body.error).toMatchObject({
        code: 'PUB_AI_DISABLED',
        details: { generator: 'pub.distribution.plan' },
      });

      const tg = await op.post(`${P}/channels`, {
        code: 'tg-own',
        title: 'Telegram-канал',
        kind: 'own',
        utmSource: 'telegram',
        utmMedium: 'social',
        adsAllowed: null,
      });
      expect(tg.status).toBe(201);
      expect(tg.body.data).toMatchObject({
        title: 'Telegram-канал',
        kind: 'own',
      });

      const plannedAt = '2026-10-21T09:00:00.000Z';
      const a1 = await op.post(`${P}/distribution/actions`, {
        versionId: ad.versionId,
        channelId: tg.body.data.id,
        format: 'post',
        goal: 'Привести читачів зі спільноти на статтю',
        plannedAt,
        ownerMemberId: w.team.operator.memberId,
      });
      expect(a1.status).toBe(201);
      expect(a1.body.data).toMatchObject({
        versionId: ad.versionId,
        contentId: ad.contentId,
        format: 'post',
        ownerMemberId: w.team.operator.memberId,
        status: 'planned',
        blockReason: null,
        publicationId: null,
        doneUrl: null,
        plannedAt,
      });
      const url = new URL(a1.body.data.measurableUrl);
      expect(url.origin + url.pathname).toBe(
        `https://ai-publisher.org/materials/${w.slug}`,
      );
      expect(url.searchParams.get('utm_source')).toBe('telegram');
      expect(url.searchParams.get('utm_medium')).toBe('social');
      expect(url.searchParams.get('utm_campaign')).toBe('pilot');
      expect(a1.body.data.ownerDisplayName).toMatch(/Учасник/);

      const a2 = await op.post(`${P}/distribution/actions`, {
        versionId: w.versionId,
        channelId: w.siteChannelId,
        format: 'article',
        goal: 'Публікація статті на сайті',
        plannedAt,
        ownerMemberId: w.team.editor.memberId,
      });
      expect(a2.status).toBe(201);
      expect(a2.body.data.measurableUrl).toBe(
        `https://ai-publisher.org/materials/${w.slug}`,
      );

      const stranger = await op.post(`${P}/distribution/actions`, {
        versionId: w.versionId,
        channelId: w.siteChannelId,
        format: 'article',
        goal: 'Ціль',
        plannedAt,
        ownerMemberId: 'not-a-member',
      });
      expect(stranger.status).toBe(400);

      // done без публикации — нельзя (и с чужой публикацией — тоже).
      const noPub = await op.post(
        `${P}/distribution/actions/${a1.body.data.id}/transition`,
        {
          to: 'done',
          expectedRevision: a1.body.data.revision,
        },
      );
      expect(noPub.status).toBe(400);
      const pub = await op.post(`${P}/publications`, {
        versionId: ad.versionId,
        channelId: tg.body.data.id,
        finalUrl: 'https://t.me/s/ai_publisher_ua/15',
      });
      expect(pub.status).toBe(201);
      expect(pub.body.data).toMatchObject({
        stage: 'test',
        status: 'published',
      });
      const wrong = await op.post(
        `${P}/distribution/actions/${a2.body.data.id}/transition`,
        {
          to: 'done',
          publicationId: pub.body.data.id,
          expectedRevision: a2.body.data.revision,
        },
      );
      expect(wrong.status).toBe(400);
      // Та же версия, но публикация в другом канале — тоже не «выполнено».
      const otherChannel = await op.post(`${P}/publications`, {
        versionId: w.versionId,
        channelId: tg.body.data.id,
        finalUrl: 'https://t.me/s/ai_publisher_ua/16',
      });
      expect(otherChannel.status).toBe(201);
      const wrongChannel = await op.post(
        `${P}/distribution/actions/${a2.body.data.id}/transition`,
        {
          to: 'done',
          publicationId: otherChannel.body.data.id,
          expectedRevision: a2.body.data.revision,
        },
      );
      expect(wrongChannel.status).toBe(400);
      // Тот же канал, но публикация ДРУГОЙ версии (статья вместо поста) —
      // тоже не «выполнено» (§7.5, аудит S3-1).
      const wrongVersion = await op.post(
        `${P}/distribution/actions/${a1.body.data.id}/transition`,
        {
          to: 'done',
          publicationId: otherChannel.body.data.id,
          expectedRevision: a1.body.data.revision,
        },
      );
      expect(wrongVersion.status).toBe(400);
      expect(wrongVersion.body.error.details.fields).toEqual([
        { field: 'publicationId', code: 'publication' },
      ]);
      const done = await op.post(
        `${P}/distribution/actions/${a1.body.data.id}/transition`,
        {
          to: 'done',
          publicationId: pub.body.data.id,
          expectedRevision: a1.body.data.revision,
        },
      );
      expect(done.status).toBe(200);
      expect(done.body.data).toMatchObject({
        status: 'done',
        publicationId: pub.body.data.id,
        doneUrl: 'https://t.me/s/ai_publisher_ua/15',
      });
      expect(s.content.published).toEqual(
        expect.arrayContaining([
          {
            versionId: ad.versionId,
            publicationId: pub.body.data.id,
            stage: 'test',
          },
        ]),
      );

      // Календарь списком и CSV (формулы экранированы, аудит export).
      const list = await op.get(`${P}/distribution/actions?limit=10`);
      expect(list.status).toBe(200);
      expect(list.body.data.items).toHaveLength(2);
      await op.post(`${P}/distribution/actions`, {
        versionId: w.versionId,
        channelId: tg.body.data.id,
        format: 'post',
        goal: '=HYPERLINK("x")',
        plannedAt,
        ownerMemberId: w.team.operator.memberId,
      });
      const csv = await request(srv)
        .get(`${P}/distribution/actions?format=csv`)
        .set(op.headers);
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text).toContain(`"'=HYPERLINK(""x"")"`);
      expect(
        await s.prisma.pubAuditEvent.count({
          where: { productId: w.product.id, action: 'export' },
        }),
      ).toBe(1);
    });

    it('измеряемая ссылка через GET /utm; продажи не планируют распространение (403)', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const srv = s.app!.getHttpServer();
      const op = apiAs(srv, w.acc.accountId, w.team.operator);
      const sa = apiAs(srv, w.acc.accountId, w.team.sales);
      const P = `/publisher/products/${w.product.id}`;
      const ch = await op.post(`${P}/channels`, {
        code: 'fb-group',
        title: 'Група у Facebook',
        kind: 'community',
        utmSource: 'facebook',
        utmMedium: 'community',
        adsAllowed: true,
      });
      const u = await op.get(
        `${P}/utm?channelId=${ch.body.data.id}&versionId=${w.versionId}`,
      );
      expect(u.status).toBe(200);
      expect(u.body.data.utm).toEqual({
        source: 'facebook',
        medium: 'community',
        campaign: 'pilot',
      });
      const bySales = await sa.post(`${P}/distribution/actions`, {
        versionId: w.versionId,
        channelId: ch.body.data.id,
        format: 'post',
        goal: 'Ціль',
        plannedAt: '2026-10-21T09:00:00.000Z',
        ownerMemberId: w.team.sales.memberId,
      });
      expect(bySales.status).toBe(403);
    });
  },
);
