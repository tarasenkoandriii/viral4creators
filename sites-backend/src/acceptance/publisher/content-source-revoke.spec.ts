/**
 * [AT-CORE-21] Отзыв разрешённого ранее источника (P-B1, проектный
 * документ §6.3, §11.3 `sources/:id/revoke`, §12.3): источник больше не
 * попадает в новый AI-контекст (`context-preview`) и общие выгрузки (CSV);
 * связанные claims, версии, адаптации и публикации получают задачи
 * проверки; существующая публикация не остаётся без рассмотрения
 * (`correction_required`), отзыв необратим и записан в
 * `pub_source_revocations`.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { asMember } from '../../modules/publisher/core/testing/core-stack.testing';
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
  '[AT-CORE-21] отозванный источник вне контекста и выгрузок; связанное — на ручную проверку',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack({ http: true });
    });
    afterAll(async () => {
      await s.close();
    });

    it('отзыв: контекст и CSV без источника, задачи claims/версий/адаптаций/публикаций, материал на проверке', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'working',
        mode: 'live',
      });
      const k = new Kit(s, acc, p);
      const slug = testSlug('rv');
      const a = await approvedArticle(k, { slug });
      await k.transition(a.content, 'scheduled');
      const pubId = await k.publish(a.version.id, 'live', slug);
      const post = await k.content({
        kind: 'post',
        parentContentId: a.content.id,
      });
      let pv = await k.version(post.id, {
        title: 'Пост',
        body: 'Текст поста.',
        meta: { cta: 'Читати' },
        sourceIds: [a.source.id],
        offerVersionId: a.offerId,
        parentVersionId: a.version.id,
      });
      pv = await k.submit(pv);
      const other = await k.source({ title: 'Інше джерело' });

      const srv = s.app!.getHttpServer();
      const h = asMember(acc.owner.telegramId, acc.accountId);
      const before = await request(srv)
        .get(`/publisher/products/${p.id}/context-preview?purpose=helper`)
        .set(h)
        .expect(200);
      expect(
        before.body.data.sources.map((x: { id: string }) => x.id),
      ).toContain(a.source.id);

      const res = await request(srv)
        .post(`/publisher/products/${p.id}/sources/${a.source.id}/revoke`)
        .set(h)
        .send({
          opKey: randomUUID(),
          reason: 'Автор відкликав дозвіл на цитування',
        })
        .expect(200);
      expect(res.body.data.source).toMatchObject({
        usage: 'revoked',
        revokeReason: 'Автор відкликав дозвіл на цитування',
      });
      expect(res.body.data.tasksOpened).toBeGreaterThanOrEqual(4);

      // Новый контекст — без отозванного источника (кэша нет).
      const after = await request(srv)
        .get(`/publisher/products/${p.id}/context-preview?purpose=helper`)
        .set(h)
        .expect(200);
      const ids = after.body.data.sources.map((x: { id: string }) => x.id);
      expect(ids).not.toContain(a.source.id);
      expect(ids).toContain(other.id);
      const explicit = await request(srv)
        .get(
          `/publisher/products/${p.id}/context-preview?purpose=helper&sourceIds=${a.source.id}`,
        )
        .set(h)
        .expect(200);
      expect(explicit.body.data.sources).toEqual([]);
      expect(explicit.body.data.excluded.revoked).toBe(1);

      // Общая выгрузка — без отозванного источника; выгрузка в журнале.
      const csv = await request(srv)
        .get(`/publisher/products/${p.id}/sources?format=csv`)
        .set(h)
        .expect(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text).not.toContain(a.source.id);
      expect(csv.text).toContain(other.id);
      expect(csv.text).not.toContain('Клієнти питають'); // текст фрагмента в выгрузку не идёт
      expect(
        await s.prisma.pubAuditEvent.count({
          where: { productId: p.id, action: 'export', objectType: 'product' },
        }),
      ).toBe(1);

      // Задачи: claim, опубликованный материал, публикация, версия адаптации.
      const tasks = await s.prisma.pubReviewTask.findMany({
        where: { productId: p.id, reason: 'source_revoked' },
        select: { objectType: true, objectId: true, severity: true },
      });
      const keyed = tasks.map((t) => `${t.objectType}:${t.objectId}`);
      expect(keyed).toEqual(
        expect.arrayContaining([
          `claim:${a.claim.id}`,
          `content:${a.content.id}`,
          `publication:${pubId}`,
          `content_version:${pv.id}`,
          `question:${a.question.id}`,
          `brief:${a.brief.id}`,
        ]),
      );
      const art = await k.getContent(a.content.id);
      expect(art).toMatchObject({
        status: 'correction_required',
        criticalStale: true,
      });
      const claim = await s.prisma.pubClaim.findUniqueOrThrow({
        where: { id: a.claim.id },
      });
      expect(claim.status).toBe('needs_review');
      // Страница не исчезла молча: решение — за редактором (снятие или новая версия).
      const shown = await s.prisma.$queryRaw<Array<{ sources: unknown[] }>>`
      SELECT "sources" FROM "sites"."pub_public_contents" WHERE "productId" = ${p.id} AND "slug" = ${slug}`;
      expect(shown).toHaveLength(1);
      expect(shown[0].sources).toEqual([]); // отозванный источник со страницы убран
      // Отзыв записан и необратим.
      expect(
        await s.prisma.pubSourceRevocation.count({
          where: { sourceId: a.source.id },
        }),
      ).toBe(1);
      const cur = await s.prisma.pubSource.findUniqueOrThrow({
        where: { id: a.source.id },
      });
      const back = await errOf(
        k.op('source.manage', (tx, st) =>
          k.sources.patch(
            tx,
            k.p,
            a.source.id,
            { expectedRevision: cur.revision, usage: 'allowed' },
            st.actor,
            st.now,
          ),
        ),
      );
      expect(back.code).not.toBe('OK');
      // Новую версию с отозванным источником не собрать.
      const nv = await errOf(
        k.version(a.content.id, {
          title: 'v2',
          body: 'x',
          sourceIds: [a.source.id],
          offerVersionId: a.offerId,
        }),
      );
      expect(nv).toMatchObject({
        code: 'PUB_SOURCE_NOT_ALLOWED',
        details: { sourceIds: [a.source.id] },
      });
    });
    it('отзыв редакции распространяется на всю цепочку (supersedesId): прежняя строка не остаётся в контексте, CSV и на странице; критический claim → criticalStale (аудит P-B1 S1-1, S2-4)', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'working',
        mode: 'live',
      });
      const k = new Kit(s, acc, p);
      const slug = testSlug('ch');
      const a = await approvedArticle(k, { slug });
      await k.transition(a.content, 'scheduled');
      await k.publish(a.version.id, 'live', slug);
      const patch = async (id: string, body: Record<string, unknown>) => {
        const cur = await s.prisma.pubSource.findUniqueOrThrow({
          where: { id },
        });
        return k.op('source.manage', (tx, st) =>
          k.sources.patch(
            tx,
            k.p,
            id,
            { expectedRevision: cur.revision, ...body },
            st.actor,
            st.now,
          ),
        );
      };
      // Новая редакция связанного источника (restricted) → разрешена.
      const s1 = await patch(a.source.id, {
        fragment: 'Клієнти питають, скільки коштує контент-агенція.',
      });
      expect(s1).toMatchObject({
        supersedesId: a.source.id,
        usage: 'restricted',
      });
      await patch(s1.id, { usage: 'allowed' });

      const srv = s.app!.getHttpServer();
      const h = asMember(acc.owner.telegramId, acc.accountId);
      const ctx = async () =>
        (
          await request(srv)
            .get(`/publisher/products/${p.id}/context-preview?purpose=helper`)
            .set(h)
            .expect(200)
        ).body.data.sources.map((x: { id: string }) => x.id);
      const csv = async () =>
        (
          await request(srv)
            .get(`/publisher/products/${p.id}/sources?format=csv`)
            .set(h)
            .expect(200)
        ).text;
      // S2-4: в контексте и выгрузке — только последняя редакция.
      expect(await ctx()).toEqual([s1.id]);
      const before = await csv();
      expect(before).toContain(s1.id);
      expect(before).not.toContain(a.source.id);
      // Прежнюю редакцию к новым объектам не привязать.
      const old = await errOf(
        k.version(a.content.id, {
          title: 'v2',
          body: 'x',
          sourceIds: [a.source.id],
          offerVersionId: a.offerId,
        }),
      );
      expect(old).toMatchObject({
        code: 'PUB_VALIDATION',
        details: {
          fields: [{ field: 'sourceIds', code: 'source_superseded' }],
        },
      });

      // Отзыв НОВОЙ редакции — отозвана и прежняя (её показывает страница).
      const res = await request(srv)
        .post(`/publisher/products/${p.id}/sources/${s1.id}/revoke`)
        .set(h)
        .send({ opKey: randomUUID(), reason: 'Клієнт відкликав згоду' })
        .expect(200);
      expect(res.body.data.source.usage).toBe('revoked');
      const rows = await s.prisma.pubSource.findMany({
        where: { id: { in: [a.source.id, s1.id] } },
        select: { usage: true },
      });
      expect(rows.map((r) => r.usage)).toEqual(['revoked', 'revoked']);
      expect(
        await s.prisma.pubSourceRevocation.count({
          where: { sourceId: { in: [a.source.id, s1.id] } },
        }),
      ).toBe(2);
      expect(await ctx()).toEqual([]);
      const after = await csv();
      expect(after).not.toContain(a.source.id);
      expect(after).not.toContain(s1.id);
      const shown = await s.prisma.$queryRaw<Array<{ sources: unknown[] }>>`
      SELECT "sources" FROM "sites"."pub_public_contents" WHERE "productId" = ${p.id} AND "slug" = ${slug}`;
      expect(shown).toEqual([{ sources: [] }]);
      // Прежняя строка подтверждала критический claim → criticalStale.
      expect(await k.getContent(a.content.id)).toMatchObject({
        status: 'correction_required',
        criticalStale: true,
      });
      const claim = await s.prisma.pubClaim.findUniqueOrThrow({
        where: { id: a.claim.id },
      });
      expect(claim.status).toBe('needs_review');
    });
  },
);
