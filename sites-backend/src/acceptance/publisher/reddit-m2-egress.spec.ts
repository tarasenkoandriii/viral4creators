/**
 * [AT-RD-11] [AT-RD-16] P-R M2 — «ноль запросов к Reddit» по всем 14
 * маршрутам Studio (reddit-manual-mvp-adapted.md §M2.6, §8.3, §9; A11,
 * A16). Сеть подменена (`reddit-egress.testing.ts`: HTTP-клиенты бросают,
 * соединения и DNS записываются), затем полный сценарий M2: бриф → ready →
 * генерация (fake-модель без сети) → материал → версия → проверка →
 * согласование → копирование → отчёт о публикации → списки и CSV → архив.
 * Ожидание: ни одного вызова HTTP-клиентов, соединения и DNS — только
 * localhost; копирование пишет аудит `copy`.
 * M1 (25 маршрутов) — `reddit-m1-egress.spec.ts`; статическая часть —
 * правила графа `publisher-reddit-no-network(-io)`.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  REDDIT_M2_ROUTE_NAMES,
  type RedditRouteName,
} from '../../modules/publisher/contracts/reddit-api';
import {
  DISCLOSURE,
  api,
  contentPath,
  humanQaPass,
  ok,
  openRedditPublish,
  redditAi,
  redditDraftJson,
  redditStack,
  redditWorld,
  seedCommunity,
  seedContentSource,
  seedOffer,
  seedOpportunity,
  submitVersion,
  warningCodes,
  type RedditAi,
  type RedditStack,
  type RedditWorld,
  type VersionRef,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';
import { watchEgress, type EgressWatch } from './reddit-egress.testing';

jest.setTimeout(240_000);

ciDescribe(
  '[AT-RD-11] [AT-RD-16] ноль запросов к Reddit по маршрутам M2',
  () => {
    let s: RedditStack;
    let w: RedditWorld;
    let ai: RedditAi;
    let net: EgressWatch;

    beforeAll(async () => {
      s = await redditStack();
      w = await redditWorld(s);
      ai = await redditAi(s, w);
      await openRedditPublish(s.prisma, w);
      net = watchEgress();
    });
    afterAll(async () => {
      net?.restore();
      ai?.restore();
      await s?.close();
    });

    it('полный сценарий M2 по всем 14 маршрутам: HTTP-клиенты не вызваны, соединения и DNS — только localhost; аудит copy', async () => {
      const used = new Set<RedditRouteName>();
      const mark = <T>(name: RedditRouteName, v: T): T => {
        used.add(name);
        return v;
      };
      const ed = api(s, w.acc.accountId, w.team.editor);
      const po = api(s, w.acc.accountId, w.team.product_owner);
      const op = api(s, w.acc.accountId, w.team.operator);
      const P = w.P;
      const C = contentPath(w);
      await seedOffer(s.prisma, w);
      const src = await seedContentSource(s.prisma, w);
      const c = await seedCommunity(ed, P, {
        rules: 'restricted',
        reviewer: po,
      });
      const o = ok<{ id: string; revision: number; threadKey: string }>(
        await seedOpportunity(ed, P, c),
        201,
      );
      ok(
        await ed.post(`${P}/opportunities/${o.id}/qualify`, {
          expectedRevision: o.revision,
        }),
        200,
      );
      const keyPoints = [
        {
          text: 'One verified article can become several formats',
          sourceIds: [src],
        },
        { text: 'Ask what the author tried', sourceIds: 'needs_verification' },
      ];
      const b = mark(
        'createBrief',
        ok<{ id: string; revision: number }>(
          await ed.post(`${P}/briefs`, {
            projectId: c.projectId,
            contentType: 'comment',
            opportunityId: o.id,
            objective: 'Help the author reuse one article',
            keyPoints,
          }),
          201,
        ),
      );
      mark('getBrief', ok(await ed.get(`${P}/briefs/${b.id}`), 200));
      const b2 = mark(
        'patchBrief',
        ok<{ revision: number }>(
          await ed.patch(`${P}/briefs/${b.id}`, {
            affiliation: 'founder',
            brand: 'Demo',
            expectedRevision: b.revision,
          }),
          200,
        ),
      );
      mark(
        'briefReady',
        ok(
          await ed.post(`${P}/briefs/${b.id}/ready`, {
            expectedRevision: b2.revision,
          }),
          200,
        ),
      );
      mark('listBriefs', ok(await ed.get(`${P}/briefs`), 200));
      mark(
        'listBriefs',
        (await ed.get(`${P}/briefs`, { format: 'csv' })).status,
      );
      ai.model.reply(redditDraftJson(3, 'comment', src));
      const g = mark(
        'generateDraft',
        ok<{
          callId: string;
          call: { output: { variants: Array<{ body: string }> } };
        }>(
          await ed.post(`${P}/briefs/${b.id}/generate`, {
            template: 'helpful_answer',
          }),
          200,
        ),
      );
      const m = mark(
        'createContent',
        ok<{ content: { id: string } }>(
          await ed.post(`${P}/briefs/${b.id}/contents`),
          201,
        ),
      );
      const cid = m.content.id;
      mark(
        'listBriefContents',
        ok(await ed.get(`${P}/briefs/${b.id}/contents`), 200),
      );
      const d = ok<VersionRef>(
        await ed.post(`${C}/contents/${cid}/versions`, {
          body: g.call.output.variants[0].body,
          meta: {
            disclosure: DISCLOSURE,
            claimMap: [{ text: 'One verified article', sourceIds: [src] }],
            uncertainties: [],
          },
          aiCallId: g.callId,
          variantIndex: 0,
        }),
        201,
      );
      const v = await submitVersion(ed, w, cid, d);
      mark(
        'checkContent',
        ok(await ed.post(`${P}/contents/${cid}/check`), 201),
      );
      await humanQaPass(po, w, v.id);
      ok(
        await po.post(`${C}/versions/${v.id}/approve`, {
          versionHash: v.hash,
          acknowledgedWarnings: await warningCodes(po, w, v.id),
        }),
        201,
      );
      // [AT-RD-11] копирование: 0 исходящих запросов, аудит copy.
      const before = net.outbound.length + net.foreign().length;
      mark('copyContent', ok(await op.post(`${P}/contents/${cid}/copy`), 200));
      expect(net.outbound.length + net.foreign().length).toBe(before);
      expect(
        await s.prisma.pubAuditEvent.count({
          where: { objectType: 'content', objectId: cid, action: 'copy' },
        }),
      ).toBe(1);
      mark('getContent', ok(await ed.get(`${P}/contents/${cid}`), 200));
      const opp = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
        where: { id: o.id },
      });
      mark(
        'reportPublication',
        ok(
          await op.post(`${P}/contents/${cid}/report-publication`, {
            url: `https://www.reddit.com/r/${c.name}/comments/${opp.threadKey}/x/k1egr/`,
            postedAt: new Date().toISOString(),
          }),
          201,
        ),
      );
      mark('listPublications', ok(await ed.get(`${P}/publications`), 200));
      mark(
        'listPublications',
        (await ed.get(`${P}/publications`, { format: 'csv' })).status,
      );
      // Архив второго брифа (post).
      const pb = ok<{ id: string; revision: number }>(
        await ed.post(`${P}/briefs`, {
          projectId: c.projectId,
          contentType: 'post',
          communityId: c.communityId,
          objective: 'Teach the method',
          keyPoints,
        }),
        201,
      );
      mark(
        'archiveBrief',
        ok(
          await ed.post(`${P}/briefs/${pb.id}/archive`, {
            expectedRevision: pb.revision,
          }),
          200,
        ),
      );

      expect([...used].sort()).toEqual([...REDDIT_M2_ROUTE_NAMES].sort());
      expect(net.outbound).toEqual([]);
      expect(net.foreign()).toEqual([]);
      expect(
        [...net.sockets, ...net.lookups].some((h) => /redd/i.test(h)),
      ).toBe(false);
    });

    it('подмена действует: прямой fetch бросает и записывается (тест не «слепой»)', () => {
      const before = net.outbound.length;
      expect(() =>
        (globalThis as unknown as { fetch: (u: string) => unknown }).fetch(
          'https://www.reddit.com/r/x.json',
        ),
      ).toThrow(/egress/);
      expect(net.outbound.length).toBe(before + 1);
      net.outbound.splice(before);
    });
  },
);
