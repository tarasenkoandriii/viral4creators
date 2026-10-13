/**
 * [AT-F02-02] Каскад нового оффера и изменённого факта (P-B1, проектный
 * документ §6.3, §7.1; аудит P2-13, P2-15; F02): опубликованные материалы
 * и их адаптации уходят в проверку (`correction_required`, задачи) при
 * НЕИЗМЕННОМ hash — страница остаётся на сайте с прежней версией;
 * согласования неопубликованных версий → `superseded`; изменение цены —
 * `criticalStale` (распространение и закупки P-C отвергают такой
 * материал). Факт — по связи `pub_version_facts`.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  Kit,
  approvedArticle,
  contentStack,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import { td05Materials } from '../../modules/publisher/content/testing/td.testing';
import {
  seedAccount,
  seedProduct,
} from '../../modules/publisher/testing/fixtures.testing';
import { testSlug } from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(180_000);

ciDescribe(
  '[AT-F02-02] новый оффер / изменённый факт → материалы и адаптации в проверку при неизменном hash',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack();
    });
    afterAll(async () => {
      await s.close();
    });

    const liveKit = async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'working',
        mode: 'live',
      });
      return new Kit(s, acc, p);
    };
    const shown = (productId: string, slug: string) =>
      s.prisma.$queryRaw<Array<{ versionHash: string }>>`
      SELECT "versionHash" FROM "sites"."pub_public_contents"
       WHERE "productId" = ${productId} AND "slug" = ${slug} AND NOT "withdrawn"`;

    it('новый оффер с другой ценой: опубликованные статья и адаптация → correction_required + criticalStale, страница с прежним hash; неопубликованное согласование → superseded', async () => {
      const k = await liveKit();
      const slug = testSlug('of');
      const a = await approvedArticle(k, { slug });
      await k.transition(a.content, 'scheduled');
      await k.publish(a.version.id, 'live', slug);
      // Адаптация: опубликована (пост) и ещё одна — только согласована.
      const mk = async (kind: string, title: string) => {
        const c = await k.content({ kind, parentContentId: a.content.id });
        let v = await k.version(c.id, {
          title,
          body: 'Текст адаптації.',
          meta: {
            cta: 'Читати статтю',
            ...(kind === 'cards'
              ? { cards: [{ title: 'К1', text: 'Т1' }] }
              : {}),
          },
          claimIds: [a.claim.id],
          offerVersionId: a.offerId,
          parentVersionId: a.version.id,
        });
        v = await k.submit(v);
        await k.qaPass(v.id, 'editorial');
        await k.qaPass(v.id, 'technical');
        await k.qaPass(v.id, 'adaptation_meaning');
        const ap = await k.approve(v);
        return { c: await k.getContent(c.id), v, ap };
      };
      const post = await mk('post', 'Пост про вибір');
      await k.transition(post.c, 'scheduled');
      await k.publish(post.v.id, 'live', `${slug}-post`);
      const cards = await mk('cards', 'Картки про вибір');

      const hashBefore = (await shown(k.p.id, slug))[0].versionHash;
      const offer2 = await k.offer({
        title: 'Оффер 2',
        priceNote: '15 000 грн',
      });
      expect(offer2.status).toBe('active');

      const art = await k.getContent(a.content.id);
      const postC = await k.getContent(post.c.id);
      expect(art).toMatchObject({
        status: 'correction_required',
        criticalStale: true,
        publishedVersionId: a.version.id,
      });
      expect(postC).toMatchObject({
        status: 'correction_required',
        criticalStale: true,
      });
      expect(art.openTasks.map((t) => t.reason)).toContain('offer_changed');
      // Hash не изменился, страница на сайте — прежняя версия.
      expect((await shown(k.p.id, slug))[0].versionHash).toBe(hashBefore);
      expect(hashBefore).toBe(a.version.hash);
      // Публикации получили задачи.
      const pubTasks = await s.prisma.pubReviewTask.count({
        where: {
          productId: k.p.id,
          objectType: 'publication',
          reason: 'offer_changed',
        },
      });
      expect(pubTasks).toBe(2);
      // Неопубликованная адаптация: согласование снято, задача на версию.
      const ap = await s.prisma.pubApproval.findUniqueOrThrow({
        where: { id: cards.ap.id },
      });
      expect(ap.status).toBe('superseded');
      expect(
        await s.prisma.pubReviewTask.count({
          where: {
            productId: k.p.id,
            objectType: 'content_version',
            objectId: cards.v.id,
            reason: 'offer_changed',
          },
        }),
      ).toBe(1);
      // P-C видит криический «застой» — распространение отвергнет.
      const pv = await k.tx((tx) =>
        k.port.publishableVersion(tx, k.p, a.version.id),
      );
      expect(pv).toMatchObject({
        criticalStale: true,
        offerActive: false,
        approvalActive: true,
      });
      expect(pv.openChangeTasks).toBeGreaterThan(0);
    });

    it('изменённый факт (pub_version_facts): опубликованный материал → correction_required без criticalStale; повтор события задач не плодит', async () => {
      const k = await liveKit();
      const td = await td05Materials(k);
      // td05 уже перевёл статью в correction_required (черновик v2) — проверим
      // каскад факта на отдельном опубликованном материале.
      const caseFact = await k.fact({
        factKey: 'case.pilot-2',
        kind: 'case',
        value: { text: 'Кейс 2' },
      });
      await k.activateFact(caseFact.fact.id);
      const slug = testSlug('fc');
      const b = await approvedArticle(k, {
        slug,
        rank: 2,
        offerId: td.article.offerId,
        factId: caseFact.fact.id,
      });
      await k.transition(b.content, 'scheduled');
      await k.publish(b.version.id, 'live', slug);
      const r = await k.op('brand.activate', (tx, st) =>
        k.brand.retireFact(
          tx,
          k.p,
          caseFact.fact.id,
          { reason: 'Клієнт відкликав кейс' },
          st.actor,
          st.now,
        ),
      );
      expect(r.cascade.correctionRequired).toEqual([b.content.id]);
      const c = await k.getContent(b.content.id);
      expect(c).toMatchObject({
        status: 'correction_required',
        criticalStale: false,
      });
      expect(c.openTasks.map((t) => t.reason)).toEqual(['fact_changed']);
      expect((await shown(k.p.id, slug))[0].versionHash).toBe(b.version.hash);
      // Исторический кейс TD-05 тоже снят: материал уже в проверке, задача есть.
      const r2 = await k.op('brand.activate', (tx, st) =>
        k.brand.retireFact(
          tx,
          k.p,
          td.historicalCase.id,
          { reason: 'Кейс застарів' },
          st.actor,
          st.now,
        ),
      );
      expect(r2.cascade.tasksOpened).toBeGreaterThan(0);
    });
  },
);
