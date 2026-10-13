/**
 * [AT-F06-02] Изменение ключевого claim (P-B1, проектный документ §6.3
 * `pub_claims` «правка — новая строка», §7.1; F04, F06): новая строка claim
 * с `supersedesId`, задачи `claim_changed`; опубликованные статья и
 * адаптации → `correction_required` с `criticalStale` (старую гарантию не
 * распространяют: `ContentPort` отдаёт P-C `criticalStale`, P-C отвергает
 * `PUB_CONTENT_STALE`); согласование неопубликованной адаптации снято;
 * прежняя строка claim к новой версии не привязывается.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  Kit,
  approvedArticle,
  contentStack,
  errOf,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import {
  seedAccount,
  seedProduct,
} from '../../modules/publisher/testing/fixtures.testing';
import { testSlug } from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(150_000);

ciDescribe(
  '[AT-F06-02] ключевой claim изменён → адаптации в проверку, распространение с criticalStale отвергнуто',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('новая строка claim, задачи, correction_required + criticalStale у статьи и адаптаций', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'working',
        mode: 'live',
      });
      const k = new Kit(s, acc, p);
      const slug = testSlug('ac');
      const a = await approvedArticle(k, { slug });
      await k.transition(a.content, 'scheduled');
      await k.publish(a.version.id, 'live', slug);
      const adapt = async (kind: string, title: string, publish: boolean) => {
        const c = await k.content({ kind, parentContentId: a.content.id });
        let v = await k.version(c.id, {
          title,
          body: 'Гарантуємо результат за ціною 10 000 грн.',
          meta: { cta: 'Читати' },
          claimIds: [a.claim.id],
          offerVersionId: a.offerId,
          parentVersionId: a.version.id,
        });
        v = await k.submit(v);
        for (const q of ['editorial', 'technical', 'adaptation_meaning'])
          await k.qaPass(v.id, q);
        const ap = await k.approve(v);
        if (publish) {
          await k.transition(await k.getContent(c.id), 'scheduled');
          await k.publish(v.id, 'live', `${slug}-${kind}`);
        }
        return { c, v, ap };
      };
      const post = await adapt('post', 'Пост', true);
      const checklist = await adapt('checklist', 'Чекліст', false);

      // Правка ключевого claim, связанного с замороженными версиями → новая строка.
      const cur = await s.prisma.pubClaim.findUniqueOrThrow({
        where: { id: a.claim.id },
      });
      const r = await k.op('version.manage', (tx, st) =>
        k.claims.patch(
          tx,
          k.p,
          a.claim.id,
          {
            expectedRevision: cur.revision,
            statement: 'Вартість від 12 000 грн',
          },
          st.actor,
          st.now,
        ),
      );
      expect(r.supersededId).toBe(a.claim.id);
      expect(r.claim).toMatchObject({
        supersedesId: a.claim.id,
        status: 'unverified',
        sources: [],
      });
      expect(r.cascade?.correctionRequired.sort()).toEqual(
        [a.content.id, post.c.id].sort(),
      );
      expect(r.cascade?.approvalsSuperseded).toEqual([checklist.ap.id]);
      // Прежняя строка неизменна (история).
      expect(
        (
          await s.prisma.pubClaim.findUniqueOrThrow({
            where: { id: a.claim.id },
          })
        ).statement,
      ).toBe(a.claim.statement);

      const art = await k.getContent(a.content.id);
      const postC = await k.getContent(post.c.id);
      expect(art).toMatchObject({
        status: 'correction_required',
        criticalStale: true,
      });
      expect(postC).toMatchObject({
        status: 'correction_required',
        criticalStale: true,
      });
      expect(postC.openTasks.map((t) => t.reason)).toEqual(['claim_changed']);
      const chkTasks = await s.prisma.pubReviewTask.findMany({
        where: {
          productId: p.id,
          objectType: 'content_version',
          objectId: checklist.v.id,
        },
      });
      expect(chkTasks.map((t) => [t.reason, t.severity])).toEqual([
        ['claim_changed', 'critical'],
      ]);

      // P-C получает criticalStale — распространение и закупки по адаптации отвергнет.
      const pv = await k.tx((tx) =>
        k.port.publishableVersion(tx, k.p, post.v.id),
      );
      expect(pv).toMatchObject({ criticalStale: true });
      // Публикация той же адаптации в другом канале — отказ: материал «застоялся».
      expect(
        (
          await errOf(
            k.tx((tx) =>
              k.port.markPublished(tx, k.p, post.v.id, 'x', 'live', new Date()),
            ),
          )
        ).code,
      ).toBe('PUB_CONTENT_STALE');
      // Старый claim к новой версии не привязывается.
      const nv = await errOf(
        k.version(post.c.id, {
          title: 'Пост v2',
          body: 'x',
          meta: { cta: 'Читати' },
          claimIds: [a.claim.id],
          offerVersionId: a.offerId,
          parentVersionId: a.version.id,
        }),
      );
      expect(nv.details.fields).toEqual([
        { field: 'claimIds', code: 'claim_superseded' },
      ]);
    });
  },
);
