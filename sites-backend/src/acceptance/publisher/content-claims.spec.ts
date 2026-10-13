/**
 * [AT-F04-01] Паспорт утверждений (P-B1, проектный документ §6.3
 * `pub_claims`, `pub_claim_sources`; F04): claims вводит редактор
 * (извлечение AI в P0 выключено, ДТ-2); критические связаны с источниками и
 * подтверждены человеком; URL сам по себе не даёт `supported`; проверка
 * устаревает, если источник изменился после неё; `pub.qa.review` на фейке
 * даёт предложение — его принимает человек (claim с `aiCallId`), а
 * `ai_review` в согласовании не учитывается.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  Kit,
  contentStack,
  errOf,
  whoOf,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import {
  seedAccount,
  seedMembers,
  seedProduct,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-F04-01] claims введены редактором, критические — с источниками и человеческим подтверждением',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('критический claim: URL без связи — не supported; связь yes с разрешённым источником + человек — supported; источник изменился — снова проверка', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const members = await seedMembers(s.prisma, p, acc.owner);
      const k = new Kit(s, acc, p, whoOf(members.editor, ['editor']));
      const src = await k.source({ url: 'https://example.org/report' });
      let c = await k.claim({
        statement: 'Середня ціна 10 000 грн',
        type: 'fact',
        risk: 'critical',
      });
      expect(c).toMatchObject({ status: 'unverified', sources: [] });
      expect((await errOf(k.verify(c, 'supported'))).details.fields).toEqual([
        { field: 'status', code: 'no_supporting_source' },
      ]);
      // «Частично» тоже не подтверждение.
      c = await k.claimSource(c.id, src.id, 'partial');
      expect((await errOf(k.verify(c, 'supported'))).code).toBe(
        'PUB_VALIDATION',
      );
      c = await k.claimSource(c.id, src.id, 'yes');
      expect(c.sources).toEqual([
        expect.objectContaining({
          sourceId: src.id,
          supports: 'yes',
          checkedBy: `member:${members.editor.memberId}`,
        }),
      ]);
      c = await k.verify(c, 'supported');
      expect(c).toMatchObject({
        status: 'supported',
        verifiedBy: `member:${members.editor.memberId}`,
      });
      // Самоаудит: автор claim подтвердил сам — отметка в журнале.
      const audit = await s.prisma.pubAuditEvent.findFirstOrThrow({
        where: {
          productId: p.id,
          objectType: 'claim',
          objectId: c.id,
          toStatus: 'supported',
        },
      });
      expect(audit.meta).toMatchObject({ selfReview: true, risk: 'critical' });

      // Источник изменился после проверки → новая проверка нужна.
      let c2 = await k.claim({
        statement: 'Термін — 6 тижнів',
        type: 'fact',
        risk: 'critical',
      });
      c2 = await k.claimSource(c2.id, src.id, 'yes');
      const cur = await s.prisma.pubSource.findUniqueOrThrow({
        where: { id: src.id },
      });
      await new Promise((r) => setTimeout(r, 15));
      await k.op('source.manage', (tx, st) =>
        k.sources.patch(
          tx,
          k.p,
          src.id,
          { expectedRevision: cur.revision, freshness: 'current' },
          st.actor,
          st.now,
        ),
      );
      expect((await errOf(k.verify(c2, 'supported'))).code).toBe(
        'PUB_VALIDATION',
      );
      c2 = await k.claimSource(c2.id, src.id, 'yes');
      expect((await k.verify(c2, 'supported')).status).toBe('supported');

      // Продажи/аналитик claims не подтверждают (матрица §4.2).
      const an = k.as(whoOf(members.analyst, ['analyst']));
      expect((await errOf(an.verify(c2, 'unsupported'))).code).toBe(
        'PUB_ROLE_REQUIRED',
      );
    });

    it('pub.qa.review на фейке даёт предложение: человек вводит claim со ссылкой aiCallId; без человека записей нет', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      const src = await k.source();
      const proposal = {
        object_version: 'v1',
        claims: [
          {
            statement: 'Вартість 10 000 грн',
            type: 'fact',
            risk: 'critical',
            source_ids: [src.id],
            supported: 'unknown',
          },
        ],
        blockers: [],
        unresolved_questions: [],
        recommendation: 'Перевірити ціну',
      };
      const call = await k.aiCall('pub.qa.review', proposal);
      expect(
        await s.prisma.pubClaim.count({ where: { productId: p.id } }),
      ).toBe(0);
      const c = await k.claim({
        ...proposal.claims[0],
        source_ids: undefined,
        supported: undefined,
        aiCallId: call,
      });
      expect(c).toMatchObject({ aiCallId: call, status: 'unverified' });
    });
  },
);
