/**
 * [AT-F02-02] Конфликт фактов (P-B1, проектный документ §6.3
 * `pub_brand_facts`; F02): конфликтующая цена → `needs_resolution` +
 * задача `fact_conflict`; неутверждённый кейс вне контекста; разрешение —
 * только PO (`brand.activate`), «одна активная запись ключа» держит база.
 * Каскад нового оффера и изменённого факта — `content-offer-cascade.spec`.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { selectContext } from '../../modules/publisher/content/context-selection';
import {
  Kit,
  contentStack,
  errOf,
  whoOf,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import { td03Brand } from '../../modules/publisher/content/testing/td.testing';
import {
  seedAccount,
  seedMembers,
  seedProduct,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-F02-02] конфликт → needs_resolution + задача; неутверждённый кейс вне контекста',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('конфликтная цена и черновой кейс не используются как факт; задача открыта; разрешение — PO', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      const td = await td03Brand(k);
      expect(td.priceConflict).toMatchObject({
        status: 'needs_resolution',
        conflictWithId: td.priceV2.id,
      });
      expect(td.caseDraft.status).toBe('draft');
      const task = await s.prisma.pubReviewTask.findFirst({
        where: {
          productId: p.id,
          objectType: 'brand_fact',
          objectId: td.priceConflict.id,
        },
      });
      expect(task).toMatchObject({
        reason: 'fact_conflict',
        status: 'open',
        severity: 'critical',
      });
      const ctx = await k.tx((tx) =>
        selectContext(tx, p.id, { purpose: 'helper', audience: 'internal' }),
      );
      const ids = ctx.facts.map((f) => f.id);
      expect(ids).not.toContain(td.priceConflict.id);
      expect(ids).not.toContain(td.caseDraft.id);
      expect(
        ctx.facts.filter((f) => f.factKey === 'price.service'),
      ).toHaveLength(1);

      // Редактор не активирует и не разрешает конфликт (матрица §4.2).
      const members = await seedMembers(s.prisma, p, acc.owner);
      const editor = k.as(whoOf(members.editor, ['editor']));
      expect(
        (
          await errOf(
            editor.op('brand.activate', (tx, st) =>
              editor.brand.resolveFact(
                tx,
                p,
                td.priceConflict.id,
                { keepId: td.priceConflict.id, reason: 'x' },
                st.actor,
                st.now,
              ),
            ),
          )
        ).code,
      ).toBe('PUB_ROLE_REQUIRED');

      // PO оставляет действующую цену: конфликтная → rejected, активная та же.
      const r = await k.op('brand.activate', (tx, st) =>
        k.brand.resolveFact(
          tx,
          p,
          td.priceConflict.id,
          { keepId: td.priceV2.id, reason: 'Знижка не затверджена' },
          st.actor,
          st.now,
        ),
      );
      expect(r.fact.status).toBe('rejected');
      const active = await s.prisma.pubBrandFact.findMany({
        where: { productId: p.id, factKey: 'price.service', status: 'active' },
      });
      expect(active.map((f) => f.id)).toEqual([td.priceV2.id]);

      // Вторая активная запись ключа — отказ базы (частичный уникальный индекс).
      const dup = await errOf(
        s.prisma.pubBrandFact.update({
          where: { id: td.priceV1.id },
          data: { status: 'active' },
        }),
      );
      expect(dup.code).not.toBe('OK');
    });
  },
);
