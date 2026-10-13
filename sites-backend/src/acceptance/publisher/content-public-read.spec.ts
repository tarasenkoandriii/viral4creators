/**
 * [AT-CORE-01] Доступность материала — серверная часть P-B1 (проектный
 * документ §11.4 `GET /contents*`, §6.5 `pub_public_contents`; сборка и
 * e2e — P-F): опубликованный по согласованию материал читается публичным
 * API под ролью `publisher_public` (основной текст, краткий ответ,
 * источники — закрытые без ссылки, CTA, hash версии); Origin — только
 * разрешённые хосты режима, без Origin — серверная сборка; снятый — 410,
 * неизвестный и несогласованный — 404; тестовый режим — `noindex`; лимит
 * 120 в минуту на IP — 429 с `Retry-After`.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { PublisherContentPublicController } from '../../modules/publisher/public/content-public.controller';
import {
  Kit,
  approvedArticle,
  contentStack,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import {
  seedAccount,
  seedProduct,
  seedVerifiedHost,
} from '../../modules/publisher/testing/fixtures.testing';
import { testSlug } from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(180_000);

ciDescribe(
  '[AT-CORE-01] публичное чтение опубликованного материала (P-B1)',
  () => {
    let s: ContentStack;
    let ctl: PublisherContentPublicController;
    beforeAll(async () => {
      s = await contentStack({ http: true });
      ctl = s.mod.get(PublisherContentPublicController, { strict: false });
    });
    afterAll(async () => {
      await s.close();
    });
    beforeEach(() => ctl.limiter.reset());

    it('live: список и материал без JS-сценария; Origin; 404/400; снятый — 410', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        siteId: acc.siteId,
        kind: 'working',
        mode: 'live',
      });
      const host = `pub-${randomUUID().slice(0, 8)}.example`;
      await seedVerifiedHost(s.prisma, acc.accountId, acc.siteId, host);
      const k = new Kit(s, acc, p);
      const slug = testSlug('pr');
      const a = await approvedArticle(k, { slug });
      await k.transition(a.content, 'scheduled');
      await k.publish(a.version.id, 'live', slug);
      // Несогласованный черновик — не виден.
      const draft = await k.content({
        kind: 'article',
        briefId: a.brief.id,
        slug: testSlug('dr'),
      });

      const srv = s.app!.getHttpServer();
      const base = '/public/publisher/v1/contents';
      const list = await request(srv)
        .get(`${base}?key=${p.publicKey}`)
        .expect(200);
      expect(list.headers['cache-control']).toMatch(/s-maxage=60/);
      // Аудит P-B1 S3-2: гейт `public_publish` закрыт (indexableHosts пуст)
      // — noindex и в live.
      expect(list.headers['x-robots-tag']).toBe('noindex');
      expect(list.body.data).toEqual([
        {
          slug,
          title: 'Як обрати агенцію',
          description: 'Опис',
          publishedAt: expect.any(String),
          updatedAt: expect.any(String),
          stage: 'live',
          withdrawn: false,
        },
      ]);
      const one = await request(srv)
        .get(`${base}/${slug}?key=${p.publicKey}`)
        .set('Origin', `https://${host}`)
        .expect(200);
      expect(one.body.data).toEqual({
        title: 'Як обрати агенцію',
        shortAnswer: 'Коротко',
        body: 'Короткий текст.\n\nДругий абзац.',
        example: null,
        limitations: [],
        editor: 'Редакторка',
        publishedAt: expect.any(String),
        substantiallyUpdatedAt: null,
        sources: [{ title: a.source.title, url: a.source.url }],
        cta: 'Обговорити задачу',
        versionHash: a.version.hash,
        stage: 'live',
      });
      // Гейт открыт: индексируется только хост сборки из indexableHosts
      // (`?host=` или Origin); чужой хост и запрос без хоста — noindex.
      await s.prisma.$executeRaw`
        UPDATE "sites"."pub_products" SET "paramsPublicPublishOk" = true
         WHERE "id" = ${p.id}`;
      const idx = await request(srv)
        .get(`${base}?key=${p.publicKey}&host=${host}`)
        .expect(200);
      expect(idx.headers['x-robots-tag']).toBeUndefined();
      const idxOrigin = await request(srv)
        .get(`${base}/${slug}?key=${p.publicKey}`)
        .set('Origin', `https://${host}`)
        .expect(200);
      expect(idxOrigin.headers['x-robots-tag']).toBeUndefined();
      const preview = await request(srv)
        .get(`${base}?key=${p.publicKey}&host=preview.vercel.app`)
        .expect(200);
      expect(preview.headers['x-robots-tag']).toBe('noindex');
      const noHost = await request(srv)
        .get(`${base}?key=${p.publicKey}`)
        .expect(200);
      expect(noHost.headers['x-robots-tag']).toBe('noindex');
      // Чужой Origin — 403; несогласованный и неизвестный — 404; плохой ключ — 400.
      const denied = await request(srv)
        .get(`${base}/${slug}?key=${p.publicKey}`)
        .set('Origin', 'https://evil.example')
        .expect(403);
      expect(denied.body.error.code).toBe('PUB_ORIGIN_DENIED');
      expect(denied.headers['cache-control']).toBe('no-store');
      await request(srv)
        .get(`${base}/${draft.slug}?key=${p.publicKey}`)
        .expect(404);
      await request(srv)
        .get(`${base}/nope-${randomUUID().slice(0, 4)}?key=${p.publicKey}`)
        .expect(404);
      await request(srv)
        .get(`${base}?key=pp_${'A'.repeat(24)}`)
        .expect(404);
      const bad = await request(srv).get(`${base}?key=wrong`).expect(400);
      expect(bad.body.error).toMatchObject({
        code: 'PUB_VALIDATION',
        details: { fields: [{ field: 'key', code: 'format' }] },
      });

      // Снятие материала редактором — 410 и признак в списке.
      const c = await k.getContent(a.content.id);
      await k.transition(c, 'withdrawn', { reason: 'Матеріал застарів' });
      const gone = await request(srv)
        .get(`${base}/${slug}?key=${p.publicKey}`)
        .expect(410);
      expect(gone.body.data).toEqual({ withdrawn: true });
      const list2 = await request(srv)
        .get(`${base}?key=${p.publicKey}`)
        .expect(200);
      expect(list2.body.data).toEqual([
        expect.objectContaining({ slug, withdrawn: true, title: null }),
      ]);
    });

    it('test: тестовая публикация видна только в режиме test, ответы noindex; закрытый источник — без ссылки', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
        mode: 'test',
      });
      const k = new Kit(s, acc, p);
      const slug = testSlug('ts');
      const a = await approvedArticle(k, { slug });
      // Версия с закрытым источником.
      const priv = await k.source({
        title: 'Внутрішнє інтерв’ю',
        visibility: 'private',
      });
      let c = await k.transition(a.content, 'scheduled');
      c = await k.transition(c, 'approved', { reason: 'Додати джерело' });
      let v2 = await k.version(c.id, {
        title: 'З інтерв’ю',
        body: 'Текст.',
        meta: { description: 'Опис 2' },
        sourceIds: [a.source.id, priv.id],
        claimIds: [a.claim.id],
        offerVersionId: a.offerId,
      });
      v2 = await k.submit(v2);
      await k.qaPass(v2.id, 'editorial');
      await k.qaPass(v2.id, 'technical');
      await k.approve(v2);
      await k.transition(await k.getContent(c.id), 'scheduled');
      await k.publish(v2.id, 'test', slug);
      const srv = s.app!.getHttpServer();
      const r = await request(srv)
        .get(`/public/publisher/v1/contents/${slug}?key=${p.publicKey}`)
        .expect(200);
      expect(r.headers['x-robots-tag']).toBe('noindex');
      expect(r.body.data.stage).toBe('test');
      expect(r.body.data.sources).toEqual(
        expect.arrayContaining([
          { private: true },
          { title: a.source.title, url: a.source.url },
        ]),
      );
      expect(JSON.stringify(r.body.data)).not.toContain(priv.url ?? '§');
    });

    it('лимит чтения: 120 за минуту с IP, 121-й — 429 с Retry-After', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
        mode: 'test',
      });
      const srv = s.app!.getHttpServer();
      for (let i = 0; i < 120; i++) {
        await request(srv)
          .get(`/public/publisher/v1/contents?key=${p.publicKey}`)
          .expect(200);
      }
      const r = await request(srv)
        .get(`/public/publisher/v1/contents?key=${p.publicKey}`)
        .expect(429);
      expect(r.body.error.code).toBe('PUB_RATE_LIMITED');
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    });
  },
);
