/**
 * [AT-CORE-10] Версия и согласование (P-B1, проектный документ §6.3, §7.1,
 * §8; аудит P1-1, P2-14, P-A1 P2-5): после согласования изменить ключевой
 * факт — выпуск новой версии требует нового решения; прежний hash не
 * разрешает новый текст (hash включает содержимое claims, источников,
 * фактов и связи claim → источник); опубликованная v1 остаётся на сайте до
 * публикации v2; параллельная правка — 409; `pub_public_contents` отдаёт
 * только согласованный hash; показанные метаданные источника замороженной
 * версии меняются только новой редакцией источника и новой версией
 * (аудит P-B1 S1-2: страница без нового согласования не меняется).
 * Механизм CAS ядра — `core-revision.spec` (P-A1).
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { asMember } from '../../modules/publisher/core/testing/core-stack.testing';
import { assertHashCurrent } from '../../modules/publisher/content/version-hash';
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

jest.setTimeout(180_000);

ciDescribe(
  '[AT-CORE-10] новая версия после правки факта/claim требует нового решения; v1 на сайте до v2',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack({ http: true });
    });
    afterAll(async () => {
      await s.close();
    });

    const shown = (productId: string, slug: string) =>
      s.prisma.$queryRaw<Array<{ versionHash: string; title: string }>>`
      SELECT "versionHash", "title" FROM "sites"."pub_public_contents"
       WHERE "productId" = ${productId} AND "slug" = ${slug} AND NOT "withdrawn"`;

    it('изменение ключевого факта: v1 в проверке, но на сайте; v2 с новым фактом — новое согласование; прежний hash не проходит; после публикации v2 сайт отдаёт v2', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'working',
        mode: 'live',
      });
      const k = new Kit(s, acc, p);
      const f1 = await k.fact({
        factKey: 'term.delivery',
        kind: 'condition',
        value: { text: 'Перший матеріал за 10 днів' },
      });
      await k.activateFact(f1.fact.id);
      const slug = testSlug('h');
      const a = await approvedArticle(k, { slug, factId: f1.fact.id });
      await k.transition(a.content, 'scheduled');
      await k.publish(a.version.id, 'live', slug);
      expect((await shown(p.id, slug))[0].versionHash).toBe(a.version.hash);

      // Ключевой факт изменён (новое значение → решение PO).
      const f2 = await k.fact({
        factKey: 'term.delivery',
        kind: 'condition',
        value: { text: 'Перший матеріал за 14 днів' },
      });
      await k.op('brand.activate', (tx, st) =>
        k.brand.resolveFact(
          tx,
          k.p,
          f2.fact.id,
          { keepId: f2.fact.id, reason: 'Новий термін' },
          st.actor,
          st.now,
        ),
      );
      let c = await k.getContent(a.content.id);
      expect(c.status).toBe('correction_required');
      expect((await shown(p.id, slug))[0].versionHash).toBe(a.version.hash);

      // v2 со старым фактом не отправляется (факт не активен).
      const vOld = await errOf(
        k.version(c.id, {
          title: a.version.title,
          body: 'Перший матеріал за 14 днів.',
          sourceIds: [a.source.id],
          claimIds: [a.claim.id],
          factIds: [f1.fact.id],
          offerVersionId: a.offerId,
        }),
      );
      expect(vOld).toMatchObject({
        code: 'PUB_VALIDATION',
        details: { fields: [{ field: 'factIds', code: 'fact_not_active' }] },
      });
      let v2 = await k.version(c.id, {
        title: a.version.title,
        body: 'Перший матеріал за 14 днів.',
        sourceIds: [a.source.id],
        claimIds: [a.claim.id],
        factIds: [f2.fact.id],
        offerVersionId: a.offerId,
      });
      v2 = await k.submit(v2);
      expect(v2.hash).not.toBe(a.version.hash);
      await k.qaPass(v2.id, 'editorial');
      await k.qaPass(v2.id, 'technical');
      // Прежний hash не разрешает новый текст.
      expect(
        (await errOf(k.approve({ ...v2, hash: a.version.hash }))).code,
      ).toBe('PUB_APPROVAL_STALE');
      // Согласование v1 — только для v1: в базе нельзя опубликовать v2 по нему.
      const ap2 = await k.approve(v2);
      expect(ap2.versionHash).toBe(v2.hash);
      expect((await shown(p.id, slug))[0].versionHash).toBe(a.version.hash);
      c = await k.getContent(c.id);
      await k.transition(c, 'scheduled');
      await k.publish(v2.id, 'live', slug);
      const rows = await shown(p.id, slug);
      expect(rows).toEqual([{ versionHash: v2.hash, title: a.version.title }]);
    });

    it('параллельная правка версии через HTTP: 200 и 409 PUB_CONFLICT с текущей ревизией; повтор opKey — тот же ответ', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      const a = await approvedArticle(k);
      const c = await k.transition(a.content, 'scheduled');
      const back = await k.transition(c, 'approved', {
        reason: 'Правка тексту',
      });
      const v = await k.version(back.id, {
        title: 'T',
        body: 'B',
        offerVersionId: a.offerId,
      });
      const srv = s.app!.getHttpServer();
      const h = asMember(acc.owner.telegramId, acc.accountId);
      const url = `/publisher/products/${p.id}/contents/${c.id}/versions/${v.id}`;
      const keys = [randomUUID(), randomUUID()];
      const [r1, r2] = await Promise.all(
        ['A', 'B'].map((title, i) =>
          request(srv)
            .patch(url)
            .set(h)
            .send({ opKey: keys[i], expectedRevision: v.revision, title }),
        ),
      );
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      const lost = r1.status === 409 ? r1 : r2;
      expect(lost.body.error).toMatchObject({
        code: 'PUB_CONFLICT',
        details: { currentRevision: v.revision + 1 },
      });
      const won = r1.status === 200 ? r1 : r2;
      const wonKey = r1.status === 200 ? keys[0] : keys[1];
      const replay = await request(srv).patch(url).set(h).send({
        opKey: wonKey,
        expectedRevision: v.revision,
        title: won.body.data.title,
      });
      expect(replay.status).toBe(200);
      expect(replay.body.data).toEqual(won.body.data);
    });

    it('метаданные источника замороженной версии (название, видимость) правятся только новой редакцией: опубликованная страница и hash не меняются без новой версии и согласования (аудит P-B1 S1-2)', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'working',
        mode: 'live',
      });
      const k = new Kit(s, acc, p);
      const slug = testSlug('md');
      const a = await approvedArticle(k, { slug });
      await k.transition(a.content, 'scheduled');
      await k.publish(a.version.id, 'live', slug);
      const page = () =>
        s.prisma.$queryRaw<
          Array<{ versionHash: string; sources: unknown[] }>
        >`SELECT "versionHash", "sources" FROM "sites"."pub_public_contents"
           WHERE "productId" = ${p.id} AND "slug" = ${slug} AND NOT "withdrawn"`;
      const before = await page();
      expect(before[0].sources).toEqual([
        { title: a.source.title, url: a.source.url },
      ]);
      const cur = await s.prisma.pubSource.findUniqueOrThrow({
        where: { id: a.source.id },
      });
      const next = await k.op('source.manage', (tx, st) =>
        k.sources.patch(
          tx,
          k.p,
          a.source.id,
          {
            expectedRevision: cur.revision,
            title: 'Нова назва джерела',
            visibility: 'private',
          },
          st.actor,
          st.now,
        ),
      );
      // Новая строка-редакция с тем же правом; прежняя — без изменений.
      expect(next).toMatchObject({
        supersedesId: a.source.id,
        title: 'Нова назва джерела',
        visibility: 'private',
        usage: 'allowed',
      });
      const old = await s.prisma.pubSource.findUniqueOrThrow({
        where: { id: a.source.id },
      });
      expect(old).toMatchObject({
        title: a.source.title,
        visibility: 'public',
        updatedAt: cur.updatedAt,
      });
      // Страница, hash и согласование — прежние; материал не тронут.
      expect(await page()).toEqual(before);
      await k.tx((tx) =>
        assertHashCurrent(tx, p.id, a.version.id, a.version.hash),
      );
      const ap = await s.prisma.pubApproval.findUniqueOrThrow({
        where: { id: a.approval.id },
      });
      expect(ap.status).toBe('active');
      expect((await k.getContent(a.content.id)).status).toBe('published');
      expect(
        (await k.tx((tx) => k.port.publishableVersion(tx, k.p, a.version.id)))
          .approvalActive,
      ).toBe(true);
      // Показать новое название можно только новой версией (новый hash).
      let c = await k.getContent(a.content.id);
      c = await k.transition(c, 'correction_required', {
        reason: 'Оновити назву джерела',
      });
      const v2 = await k.version(c.id, {
        title: a.version.title,
        body: 'Короткий текст.\n\nДругий абзац.',
        meta: {
          description: 'Опис',
          shortAnswer: 'Коротко',
          cta: 'Обговорити задачу',
          editor: 'Редакторка',
        },
        sourceIds: [next.id],
        claimIds: [a.claim.id],
        offerVersionId: a.offerId,
      });
      const v2s = await k.submit(v2);
      expect(v2s.hash).not.toBe(a.version.hash);
      // Несвязанный источник по-прежнему правится на месте.
      const free = await k.source({ title: 'Вільне джерело' });
      const fr = await s.prisma.pubSource.findUniqueOrThrow({
        where: { id: free.id },
      });
      const renamed = await k.op('source.manage', (tx, st) =>
        k.sources.patch(
          tx,
          k.p,
          free.id,
          { expectedRevision: fr.revision, title: 'Перейменоване' },
          st.actor,
          st.now,
        ),
      );
      expect(renamed).toMatchObject({ id: free.id, title: 'Перейменоване' });
      const stale = await errOf(
        k.tx((tx) => assertHashCurrent(tx, p.id, a.version.id, 'f'.repeat(64))),
      );
      expect(stale).toMatchObject({
        code: 'PUB_APPROVAL_STALE',
        details: { reason: 'hash_mismatch' },
      });
    });
  },
);
