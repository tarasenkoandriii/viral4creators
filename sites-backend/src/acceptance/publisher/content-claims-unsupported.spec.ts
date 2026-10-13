/**
 * [AT-F04-02] Источник не подтверждает цифру (P-B1, проектный документ
 * §6.3, §7.1 guard `editorial_review → approved`; F04): `supports=no` —
 * критический claim не `supported`; согласование версии → 409
 * `PUB_BLOCKERS_OPEN` (QA блокирует фразу, а не принимает ссылку как
 * достаточную проверку); блокер QA с привязкой к claim тоже держит выпуск.
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
  '[AT-F04-02] supports=no → claim не supported, согласование → PUB_BLOCKERS_OPEN',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('цифра без подтверждения блокирует согласование; после исправления (claim unsupported → новая версия без него) — проходит', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      const offer = await k.offer();
      const src = await k.source({
        fragment: 'Клієнти отримали в середньому +40% звернень.',
      });
      const q = await k.selectQuestion(await k.question(), 1, src.id);
      const brief = await k.briefReady(
        await k.brief({
          questionId: q.id,
          goal: 'Мета',
          format: 'case_review',
          ownContribution: 'Кейс',
          cta: 'Обговорити',
          ctaIntentNote: 'Доречно',
          sourceIds: [src.id],
        }),
      );
      const content = await k.content({
        kind: 'article',
        briefId: brief.id,
        slug: testSlug('u'),
      });
      let num = await k.claim({
        statement: 'Звернення зростають утричі',
        type: 'estimate',
        risk: 'critical',
      });
      num = await k.claimSource(num.id, src.id, 'no');
      expect((await errOf(k.verify(num, 'supported'))).details.fields).toEqual([
        { field: 'status', code: 'no_supporting_source' },
      ]);
      let v = await k.version(content.id, {
        title: 'Кейс',
        body: 'Текст із цифрою.',
        sourceIds: [src.id],
        claimIds: [num.id],
        offerVersionId: offer.id,
      });
      v = await k.submit(v);
      await k.qaPass(v.id, 'editorial', 'fail', [
        {
          code: 'claim_unsupported',
          claimId: num.id,
          text: 'Джерело не підтверджує «утричі»',
        },
      ]);
      await k.qaPass(v.id, 'technical');
      const r = await errOf(k.approve(v));
      expect(r.code).toBe('PUB_BLOCKERS_OPEN');
      expect(r.details.blockers).toEqual(
        expect.arrayContaining([
          { code: 'qa_editorial_missing', id: expect.any(String) },
          { code: 'claim_not_supported', id: num.id },
        ]),
      );
      // Редактор помечает claim unsupported — фраза блокирует выпуск и с pass QA.
      num = await k.verify(num, 'unsupported');
      await k.qaPass(v.id, 'editorial');
      const r2 = await errOf(k.approve(v));
      expect(r2.details.blockers).toEqual([
        { code: 'claim_unsupported', id: num.id },
      ]);

      // Исправление: новая версия без неподтверждённой цифры и с верным claim.
      let c = await k.getContent(content.id);
      c = await k.transition(c, 'changes_requested', {
        reason: 'Прибрати неперевірену цифру',
      });
      let ok = await k.claim({
        statement: 'Звернень стало на 40% більше',
        type: 'fact',
        risk: 'critical',
      });
      ok = await k.claimSource(ok.id, src.id, 'yes');
      let v2 = await k.version(c.id, {
        title: 'Кейс (виправлено)',
        body: 'Текст із перевіреною цифрою.',
        sourceIds: [src.id],
        claimIds: [ok.id],
        offerVersionId: offer.id,
      });
      v2 = await k.submit(v2);
      ok = await k.verify(ok, 'supported');
      await k.qaPass(v2.id, 'editorial');
      await k.qaPass(v2.id, 'technical');
      expect((await k.approve(v2)).status).toBe('active');
    });
  },
);
