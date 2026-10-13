/**
 * [AT-F02-01] Контекст из утверждённого профиля (P-B1, проектный документ
 * §12.3 `ctx@1`, §11.3 `context-preview`; F02): цена и условия — активной
 * версии, не v1; неутверждённое и конфликтное — вне контекста; запрещённые
 * обещания — отдельным списком ограничений; источники — только `allowed`
 * (для публичного режима — ещё `public`).
 */
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { asMember } from '../../modules/publisher/core/testing/core-stack.testing';
import {
  Kit,
  contentStack,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import { td03Brand } from '../../modules/publisher/content/testing/td.testing';
import {
  seedAccount,
  seedProduct,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-F02-01] контекст содержит активную цену и условия, не v1',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack({ http: true });
    });
    afterAll(async () => {
      await s.close();
    });

    it('context-preview: активные цена v2, условие и оффер v2; черновой кейс, конфликт и v1 — вне', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      const td = await td03Brand(k);
      const res = await request(s.app!.getHttpServer())
        .get(`/publisher/products/${p.id}/context-preview?purpose=helper`)
        .set(asMember(acc.owner.telegramId, acc.accountId))
        .expect(200);
      const ctx = res.body.data;
      const factIds = ctx.facts.map((f: { id: string }) => f.id);
      expect(factIds).toContain(td.priceV2.id);
      expect(factIds).toContain(td.condition.id);
      expect(factIds).not.toContain(td.priceV1.id);
      expect(factIds).not.toContain(td.caseDraft.id);
      expect(factIds).not.toContain(td.priceConflict.id);
      const price = ctx.facts.find(
        (f: { id: string }) => f.id === td.priceV2.id,
      );
      expect(price.value).toEqual({
        amountMinor: 1_200_000,
        currency: 'UAH',
        note: 'пілот',
      });
      expect(ctx.offer).toMatchObject({
        id: td.offerV2.id,
        version: td.offerV2.version,
        priceNote: '12 000 грн',
      });
      expect(ctx.forbiddenPromises.map((f: { id: string }) => f.id)).toEqual([
        td.forbidden.id,
      ]);
      // Источники: только разрешённые; ограниченный и отозванный — вне.
      const srcIds = ctx.sources.map((x: { id: string }) => x.id);
      expect(srcIds).toEqual(
        expect.arrayContaining([td.allowedPublic.id, td.allowedPrivate.id]),
      );
      expect(srcIds).not.toContain(td.restricted.id);
      expect(srcIds).not.toContain(td.revoked.id);
      expect(ctx.excluded).toMatchObject({ restricted: 1, revoked: 1 });

      // Публичный режим — без закрытых источников.
      const pub = await request(s.app!.getHttpServer())
        .get(
          `/publisher/products/${p.id}/context-preview?purpose=helper&audience=public`,
        )
        .set(asMember(acc.owner.telegramId, acc.accountId))
        .expect(200);
      const pubIds = pub.body.data.sources.map((x: { id: string }) => x.id);
      expect(pubIds).toContain(td.allowedPublic.id);
      expect(pubIds).not.toContain(td.allowedPrivate.id);
      expect(pub.body.data.excluded.privateForPublic).toBe(1);

      // Параметр действующего оффера изменён РЕШЕНИЕМ (журнал, версия растёт).
      const param = await s.prisma.pubParameter.findFirstOrThrow({
        where: { productId: p.id, key: 'offer_active_version' },
      });
      expect(param.status).toBe('approved');
      expect(param.value).toEqual({
        offerVersionId: td.offerV2.id,
        version: td.offerV2.version,
      });
      const decisions = await s.prisma.pubParameterDecision.count({
        where: { productId: p.id, parameterKey: 'offer_active_version' },
      });
      expect(decisions).toBe(2);
    });
  },
);
