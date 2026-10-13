/**
 * [AT-F03-02] Бриф не готов без собственного вклада или при неактивном
 * оффере (P-B1, проектный документ §6.3, §7.1 `brief → drafting`; F03):
 * `PUB_BRIEF_NOT_READY {missing}` до исправления; правка готового брифа
 * возвращает его в черновик; черновик статьи по неготовому брифу не
 * начинается.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  Kit,
  contentStack,
  errOf,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import {
  seedAccount,
  seedProduct,
} from '../../modules/publisher/testing/fixtures.testing';
import { testSlug } from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-F03-02] без вклада или с неактивным оффером → PUB_BRIEF_NOT_READY',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('удалить вклад / подменить оффер — бриф не становится готовым до исправления', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      const offer1 = await k.offer();
      const src = await k.source();
      const q = await k.selectQuestion(await k.question(), 1, src.id);
      const draft = await k.brief({
        questionId: q.id,
        goal: 'Мета',
        format: 'instruction',
        cta: 'Обговорити',
        ctaIntentNote: 'Доречно після відповіді',
        sourceIds: [src.id],
      });
      expect(draft.missing).toEqual(['own_contribution']);
      const r1 = await errOf(k.briefReady(draft));
      expect(r1).toEqual({
        code: 'PUB_BRIEF_NOT_READY',
        details: { missing: ['own_contribution'] },
      });

      // Исправили вклад — готов.
      let b = await k.op('brief.manage', (tx, st) =>
        k.briefs.patch(
          tx,
          k.p,
          draft.id,
          { expectedRevision: draft.revision, ownContribution: 'Власні дані' },
          st.actor,
        ),
      );
      b = await k.briefReady(b);
      expect(b.status).toBe('ready');

      // Правка готового брифа (удалить вклад) — снова черновик и не готов.
      b = await k.op('brief.manage', (tx, st) =>
        k.briefs.patch(
          tx,
          k.p,
          b.id,
          { expectedRevision: b.revision, ownContribution: null },
          st.actor,
        ),
      );
      expect(b).toMatchObject({
        status: 'draft',
        missing: ['own_contribution'],
      });

      // Подменить оффер на неактивный — offer_active в списке недостающего.
      b = await k.op('brief.manage', (tx, st) =>
        k.briefs.patch(
          tx,
          k.p,
          b.id,
          { expectedRevision: b.revision, ownContribution: 'Вклад' },
          st.actor,
        ),
      );
      const inactive = await k.offer({ title: 'Чернетка оферу' }, false);
      b = await k.op('brief.manage', (tx, st) =>
        k.briefs.patch(
          tx,
          k.p,
          b.id,
          { expectedRevision: b.revision, offerVersionId: inactive.id },
          st.actor,
        ),
      );
      expect((await errOf(k.briefReady(b))).details).toEqual({
        missing: ['offer_active'],
      });

      // Черновик статьи по неготовому брифу — PUB_BRIEF_NOT_READY.
      const c = await k.content({
        kind: 'article',
        briefId: b.id,
        slug: testSlug('nr'),
      });
      const v = await errOf(
        k.version(c.id, { title: 'T', body: 'B', offerVersionId: offer1.id }),
      );
      expect(v.code).toBe('PUB_BRIEF_NOT_READY');

      // Без разрешённого источника — тоже не готов (ограниченный не считается).
      const restricted = await k.source({ usage: 'restricted' });
      b = await k.op('brief.manage', (tx, st) =>
        k.briefs.patch(
          tx,
          k.p,
          b.id,
          {
            expectedRevision: b.revision,
            offerVersionId: offer1.id,
            sourceIds: [restricted.id],
          },
          st.actor,
        ),
      );
      expect(b.missing).toEqual(['allowed_source']);
      // База держит то же правило (триггер), даже мимо сервиса.
      const raw = await errOf(
        s.prisma.pubBrief.update({
          where: { id: b.id },
          data: { status: 'ready' },
        }),
      );
      expect(raw.code).not.toBe('OK');
    });
    it('готовый бриф после замены активного оффера: в недостающем offer_active, версию по нему не собрать (аудит P-B1 S3-5, AT-F03-02)', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      const offer1 = await k.offer();
      const src = await k.source();
      const q = await k.selectQuestion(await k.question(), 1, src.id);
      let b = await k.brief({
        questionId: q.id,
        goal: 'Мета',
        format: 'instruction',
        ownContribution: 'Власні дані',
        cta: 'Обговорити',
        ctaIntentNote: 'Доречно після відповіді',
        sourceIds: [src.id],
        offerVersionId: offer1.id,
      });
      b = await k.briefReady(b);
      expect(b).toMatchObject({ status: 'ready', missing: [] });
      const c = await k.content({
        kind: 'article',
        briefId: b.id,
        slug: testSlug('of'),
      });
      // Новый оффер активирован — прежний снят; бриф по-прежнему «ready» в
      // базе, но не готов по сути.
      const offer2 = await k.offer({
        title: 'Новий офер',
        priceNote: '12 000 грн',
      });
      const now = await k.tx((tx) =>
        tx.pubBrief.findUniqueOrThrow({ where: { id: b.id } }),
      );
      expect(now.status).toBe('ready');
      const v = await errOf(
        k.version(c.id, { title: 'T', body: 'B', offerVersionId: offer2.id }),
      );
      expect(v).toEqual({
        code: 'PUB_BRIEF_NOT_READY',
        details: { missing: ['offer_active'] },
      });
    });
  },
);
