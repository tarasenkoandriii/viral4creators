/**
 * [AT-CORE-10] Механизм (P-A1, проектный документ §1 п.5, §8): параллельная
 * правка «головы» не теряется — из двух запросов с одной
 * `expectedRevision` проходит один, второй — 409 `PUB_CONFLICT
 * {currentRevision}`; повтор того же `opKey` — тот же ответ без второй
 * записи. Содержательная часть (hash версии, v1/v2 на сайте) — P-B1
 * `content-approval-hash.spec`.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  asMember,
  coreStack,
  type CoreStack,
} from '../../modules/publisher/core/testing/core-stack.testing';
import {
  seedAccount,
  seedProduct,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(60_000);

ciDescribe(
  '[AT-CORE-10] параллельная правка → 409 и сообщение (механизм CAS)',
  () => {
    let s: CoreStack;
    beforeAll(async () => {
      s = await coreStack({ http: true });
    });
    afterAll(async () => {
      await s.close();
    });

    it('две правки с одной ревизией: одна 200, вторая 409 с текущей ревизией; имя не перезаписано молча', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        siteId: acc.siteId,
        kind: 'test',
      });
      const srv = s.app!.getHttpServer();
      const h = asMember(acc.owner.telegramId, acc.accountId);
      const [a, b] = await Promise.all(
        ['Перша назва', 'Друга назва'].map((name) =>
          request(srv)
            .patch(`/publisher/products/${p.id}`)
            .set(h)
            .send({ opKey: randomUUID(), name, expectedRevision: 1 }),
        ),
      );
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      const lost = a.status === 409 ? a : b;
      const won = a.status === 200 ? a : b;
      expect(lost.body.error).toMatchObject({
        code: 'PUB_CONFLICT',
        details: { currentRevision: 2 },
      });
      const row = await s.prisma.pubProduct.findFirst({ where: { id: p.id } });
      expect(row).toMatchObject({ revision: 2, name: won.body.data.name });
    });

    it('повтор того же opKey после успеха — тот же ответ, ревизия не растёт; тот же opKey с другим телом — 409', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        siteId: acc.siteId,
        kind: 'test',
      });
      const srv = s.app!.getHttpServer();
      const h = asMember(acc.owner.telegramId, acc.accountId);
      const opKey = randomUUID();
      const first = await request(srv)
        .patch(`/publisher/products/${p.id}`)
        .set(h)
        .send({ opKey, name: 'Назва', expectedRevision: 1 });
      const again = await request(srv)
        .patch(`/publisher/products/${p.id}`)
        .set(h)
        .send({ opKey, name: 'Назва', expectedRevision: 1 });
      expect([first.status, again.status]).toEqual([200, 200]);
      expect(again.body.data.revision).toBe(2);
      expect(
        (await s.prisma.pubProduct.findFirst({ where: { id: p.id } }))!
          .revision,
      ).toBe(2);
      const other = await request(srv)
        .patch(`/publisher/products/${p.id}`)
        .set(h)
        .send({ opKey, name: 'Інша', expectedRevision: 2 });
      expect(other.status).toBe(409);
      expect(other.body.error.code).toBe('PUB_IDEMPOTENCY_REUSED');
    });
  },
);
