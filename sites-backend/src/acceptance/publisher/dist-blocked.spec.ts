/**
 * [AT-F09-02] Канал запрещает рекламу либо недоступен (P-C, проектный
 * документ §7.5; F09): действие `blocked` с причиной, публикация не
 * записывается как выполненная (`done` из `blocked` невозможен); снять
 * блокировку можно только устранив причину; материал `criticalStale` не
 * распространяется (`PUB_CONTENT_STALE`).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  apiAs,
  distStack,
  seedTd08,
  type DistStack,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-F09-02] канал без рекламы или недоступен — blocked с причиной',
  () => {
    let s: DistStack;
    beforeAll(async () => {
      s = await distStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('adsAllowed=false → blocked/ads_not_allowed; done невозможен; снятие блокировки — только после разрешения', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const op = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.operator,
      );
      const P = `/publisher/products/${w.product.id}`;
      const ch = (
        await op.post(`${P}/channels`, {
          code: 'forum',
          title: 'Профільний форум',
          kind: 'community',
          utmSource: 'forum',
          utmMedium: 'community',
          adsAllowed: false,
          rulesNote: 'Правила спільноти забороняють рекламу',
        })
      ).body.data;
      const a = await op.post(`${P}/distribution/actions`, {
        versionId: w.versionId,
        channelId: ch.id,
        format: 'post',
        goal: 'Відповідь на питання учасників',
        plannedAt: '2026-10-22T09:00:00.000Z',
        ownerMemberId: w.team.operator.memberId,
      });
      expect(a.status).toBe(201);
      expect(a.body.data).toMatchObject({
        status: 'blocked',
        blockReason: 'ads_not_allowed',
      });

      // Публикация в этом канале ещё не делает действие выполненным.
      const pub = await op.post(`${P}/publications`, {
        versionId: w.versionId,
        channelId: ch.id,
        finalUrl: 'https://forum.example/t/1',
      });
      expect(pub.status).toBe(201);
      const done = await op.post(
        `${P}/distribution/actions/${a.body.data.id}/transition`,
        {
          to: 'done',
          publicationId: pub.body.data.id,
          expectedRevision: a.body.data.revision,
        },
      );
      expect(done.status).toBe(409);
      expect(done.body.error).toMatchObject({
        code: 'PUB_TRANSITION_INVALID',
        details: { from: 'blocked', to: 'done' },
      });
      const unblock = await op.post(
        `${P}/distribution/actions/${a.body.data.id}/transition`,
        {
          to: 'planned',
          expectedRevision: a.body.data.revision,
        },
      );
      expect(unblock.status).toBe(409);
      expect(unblock.body.error.details).toMatchObject({
        reason: 'ads_not_allowed',
      });

      // Модератор разрешил размещение — снимаем блокировку, затем done.
      const okCh = await op.patch(`${P}/channels/${ch.id}`, {
        adsAllowed: true,
        expectedRevision: ch.revision,
      });
      expect(okCh.status).toBe(200);
      const un = await op.post(
        `${P}/distribution/actions/${a.body.data.id}/transition`,
        {
          to: 'planned',
          expectedRevision: a.body.data.revision,
        },
      );
      expect(un.status).toBe(200);
      expect(un.body.data).toMatchObject({
        status: 'planned',
        blockReason: null,
      });
      const ok = await op.post(
        `${P}/distribution/actions/${a.body.data.id}/transition`,
        {
          to: 'done',
          publicationId: pub.body.data.id,
          expectedRevision: un.body.data.revision,
        },
      );
      expect(ok.status).toBe(200);
    });

    it('канал недоступен → channel_unavailable; ручная блокировка требует причины; устаревший материал — PUB_CONTENT_STALE', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const op = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.operator,
      );
      const P = `/publisher/products/${w.product.id}`;
      const ch = (
        await op.post(`${P}/channels`, {
          code: 'tg2',
          title: 'Telegram',
          kind: 'own',
          utmSource: 'telegram',
          utmMedium: 'social',
        })
      ).body.data;
      const off = await op.patch(`${P}/channels/${ch.id}`, {
        status: 'unavailable',
        expectedRevision: ch.revision,
      });
      expect(off.body.data.status).toBe('unavailable');
      const blocked = await op.post(`${P}/distribution/actions`, {
        versionId: w.versionId,
        channelId: ch.id,
        format: 'post',
        goal: 'Анонс',
        plannedAt: '2026-10-22T09:00:00.000Z',
        ownerMemberId: w.team.operator.memberId,
      });
      expect(blocked.body.data).toMatchObject({
        status: 'blocked',
        blockReason: 'channel_unavailable',
      });
      await op.patch(`${P}/channels/${ch.id}`, {
        status: 'available',
        expectedRevision: off.body.data.revision,
      });
      const planned = (
        await op.post(`${P}/distribution/actions`, {
          versionId: w.versionId,
          channelId: ch.id,
          format: 'post',
          goal: 'Анонс',
          plannedAt: '2026-10-23T09:00:00.000Z',
          ownerMemberId: w.team.operator.memberId,
        })
      ).body.data;
      expect(planned.status).toBe('planned');
      const noReason = await op.post(
        `${P}/distribution/actions/${planned.id}/transition`,
        {
          to: 'blocked',
          expectedRevision: planned.revision,
        },
      );
      expect(noReason.status).toBe(400);
      const pub = await op.post(`${P}/publications`, {
        versionId: w.versionId,
        channelId: ch.id,
        finalUrl: 'https://t.me/s/ai_publisher_ua/20',
      });
      s.content.overrides.set(w.versionId, { criticalStale: true });
      await s.prisma.pubContent.update({
        where: { id: w.articleId },
        data: { criticalStale: true },
      });
      const stale = await op.post(
        `${P}/distribution/actions/${planned.id}/transition`,
        {
          to: 'done',
          publicationId: pub.body.data.id,
          expectedRevision: planned.revision,
        },
      );
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('PUB_CONTENT_STALE');
      // Новое действие по устаревшему материалу создаётся сразу blocked.
      const nw = await op.post(`${P}/distribution/actions`, {
        versionId: w.versionId,
        channelId: ch.id,
        format: 'post',
        goal: 'Анонс',
        plannedAt: '2026-10-24T09:00:00.000Z',
        ownerMemberId: w.team.operator.memberId,
      });
      expect(nw.body.data).toMatchObject({
        status: 'blocked',
        blockReason: 'content_stale',
      });
      s.content.overrides.delete(w.versionId);
    });
  },
);
