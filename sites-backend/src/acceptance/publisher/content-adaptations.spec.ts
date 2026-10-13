/**
 * [AT-F06-01] Пакет адаптаций (P-B1, проектный документ §6.3
 * `pub_contents.kind≠article`, §7.1; F06): из одной согласованной версии —
 * пост, карточки и сценарий, у каждого `parentVersionId`, свой заголовок и
 * CTA; сценарий помечен как сценарий (не готовый ролик); вручную и через
 * `pub.adaptation.make` на фейке (принимает человек, `aiCallId`);
 * согласование адаптации требует проверки сохранения смысла.
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

jest.setTimeout(150_000);

ciDescribe(
  '[AT-F06-01] пост, карточки, сценарий с parentVersionId, своим заголовком и CTA',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('три адаптации одной версии; сценарий — isScript; без смысла-QA согласования нет', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      const a = await approvedArticle(k);

      // Адаптация без согласованного родителя не начинается.
      const plain = await k.content({ kind: 'article', briefId: a.brief.id });
      expect(
        (await errOf(k.content({ kind: 'post', parentContentId: plain.id })))
          .details.fields,
      ).toEqual([{ field: 'parentContentId', code: 'parent_not_approved' }]);

      const scriptProposal = {
        parent_version: a.version.id,
        format: 'video_script',
        title: 'Сценарій: 3 питання до агенції',
        body: null,
        cards: null,
        scenes: [
          { visual: 'Ведучий', voice: 'Три питання', caption: '3 питання' },
        ],
        is_script: true,
        cta: 'Читати статтю',
        used_source_ids: [a.source.id],
        preserved_caveats: [],
        unresolved_questions: [],
      };
      const call = await k.aiCall(
        'pub.adaptation.make',
        scriptProposal,
        'content_version',
        a.version.id,
      );
      const specs = [
        {
          kind: 'post',
          title: 'Пост: як обрати агенцію',
          meta: { cta: 'Читати статтю' },
          body: 'Головна думка поста.',
        },
        {
          kind: 'cards',
          title: 'Картки: 5 кроків вибору',
          meta: {
            cta: 'Обговорити задачу',
            cards: [1, 2, 3, 4, 5].map((n) => ({
              title: `Крок ${n}`,
              text: `Опис ${n}`,
            })),
          },
          body: '',
        },
        {
          kind: 'video_script',
          title: scriptProposal.title,
          meta: { cta: scriptProposal.cta, scenes: scriptProposal.scenes },
          body: '',
          aiCallId: call,
        },
      ];
      for (const sp of specs) {
        const c = await k.content({
          kind: sp.kind,
          parentContentId: a.content.id,
        });
        expect(c).toMatchObject({
          kind: sp.kind,
          parentContentId: a.content.id,
          status: 'brief',
          slug: null,
        });
        // Тот же заголовок, что у статьи, — не самостоятельная адаптация.
        const same = await k.version(c.id, {
          title: a.version.title,
          body: sp.body,
          meta: sp.meta,
          offerVersionId: a.offerId,
          parentVersionId: a.version.id,
        });
        expect((await errOf(k.submit(same))).details.fields).toEqual([
          { field: 'title', code: 'same_as_parent' },
        ]);
        let v = await k.op('version.manage', (tx, st) =>
          k.contents.patchVersion(
            tx,
            k.p,
            c.id,
            same.id,
            { expectedRevision: same.revision, title: sp.title },
            st.actor,
          ),
        );
        expect(v).toMatchObject({
          parentVersionId: a.version.id,
          title: sp.title,
          isScript: sp.kind === 'video_script',
        });
        v = await k.submit(v);
        await k.qaPass(v.id, 'editorial');
        await k.qaPass(v.id, 'technical');
        expect((await errOf(k.approve(v))).details.blockers).toEqual([
          { code: 'qa_adaptation_meaning_missing' },
        ]);
        await k.qaPass(v.id, 'adaptation_meaning');
        expect((await k.approve(v)).status).toBe('active');
      }
      const scripts = await s.prisma.pubContentVersion.findMany({
        where: { productId: p.id, format: 'video_script' },
      });
      expect(scripts).toHaveLength(1);
      expect(scripts[0].aiCallId).toBeNull(); // принят вручную через патч черновика без ссылки
      // Ссылка на предложение AI сохраняется, если человек создаёт версию с ней.
      const c4 = await k.content({
        kind: 'video_script',
        parentContentId: a.content.id,
      });
      const v4 = await k.version(c4.id, {
        title: 'Сценарій 2',
        body: '',
        meta: { cta: 'Читати', scenes: scriptProposal.scenes },
        offerVersionId: a.offerId,
        parentVersionId: a.version.id,
        aiCallId: call,
      });
      expect(v4).toMatchObject({ aiCallId: call, isScript: true });
      // Без CTA адаптация не уходит на проверку.
      const c5 = await k.content({
        kind: 'checklist',
        parentContentId: a.content.id,
      });
      const v5 = await k.version(c5.id, {
        title: 'Чекліст',
        body: '- пункт',
        offerVersionId: a.offerId,
        parentVersionId: a.version.id,
      });
      expect((await errOf(k.submit(v5))).details.fields).toEqual([
        { field: 'meta.cta', code: 'required' },
      ]);
    });
  },
);
