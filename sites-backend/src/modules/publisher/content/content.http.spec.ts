/**
 * P-B1 http: контракт `contracts/content-api.ts` ↔ контроллеры (метод,
 * путь, действие матрицы), роли по матрице §4.2 на настоящем HTTP
 * (`SiteAccountGuard` + `PubRoleGuard`), чужой кабинет — 404 (AT-CORE-08
 * для маршрутов P-B1), повтор `opKey` группы вопросов (ответ с `task` в
 * ключе не хранится), CSV без формул, diff версий, конверт ошибок.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import { CONTENT_ROUTES } from '../contracts/content-api';
import { enumerateControllers } from '../core/route-enumerator';
import { asMember } from '../core/testing/core-stack.testing';
import { PublisherContentPublicController } from '../public/content-public.controller';
import {
  seedAccount,
  seedMembers,
  seedProduct,
  seedTwoAccounts,
  testSlug,
} from '../testing/fixtures.testing';
import { ContentMaterialsController } from './content-materials.controller';
import { slugLooksLikeContact } from './contents.service';
import { ContentSourcesController } from './content-sources.controller';
import {
  Kit,
  approvedArticle,
  contentStack,
  type ContentStack,
} from './testing/content-kit.testing';

jest.setTimeout(120_000);

describe('contracts/content-api ↔ контроллеры P-B1', () => {
  it('CONTENT_ROUTES = маршруты контроллеров (метод, путь, действие)', () => {
    const fromCtl = enumerateControllers([
      ContentSourcesController as never,
      ContentMaterialsController as never,
      PublisherContentPublicController as never,
    ])
      .map(
        (r) => `${r.method} ${r.path} ${JSON.stringify(r.pubActions ?? null)}`,
      )
      .sort();
    const fromContract = Object.values(CONTENT_ROUTES)
      .map(
        (r) =>
          `${r.method} ${r.path} ${JSON.stringify(r.action === null ? null : Array.isArray(r.action) ? r.action : [r.action])}`,
      )
      .sort();
    expect(fromCtl).toEqual(fromContract);
  });
});

ciDescribe('Publisher P-B1: маршруты кабинета по HTTP', () => {
  let s: ContentStack;
  beforeAll(async () => {
    s = await contentStack({ http: true });
  });
  afterAll(async () => {
    await s.close();
  });

  it('роли: просмотр — читает, не пишет; оператор — техническая QA, не редакционная; редактор — не согласует', async () => {
    const acc = await seedAccount(s.prisma);
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    const m = await seedMembers(s.prisma, p, acc.owner);
    const k = new Kit(s, acc, p);
    const a = await approvedArticle(k);
    const srv = s.app!.getHttpServer();
    const base = `/publisher/products/${p.id}`;
    const as = (key: keyof typeof m) =>
      asMember(m[key].telegramId, acc.accountId);

    await request(srv).get(`${base}/sources`).set(as('viewer')).expect(200);
    const vw = await request(srv)
      .post(`${base}/sources`)
      .set(as('viewer'))
      .send({
        opKey: randomUUID(),
        kind: 'manual_text',
        title: 't',
        fragment: 'f',
        visibility: 'public',
        usage: 'allowed',
      })
      .expect(403);
    expect(vw.body.error).toMatchObject({
      code: 'PUB_ROLE_REQUIRED',
      details: { action: 'source.manage' },
    });
    expect(vw.headers['cache-control']).toBe('private, no-store');
    await request(srv).get(`${base}/sources`).set(as('noAccess')).expect(403);

    // Новая версия, чтобы было что проверять.
    const c = await k.transition(a.content, 'scheduled');
    const back = await k.transition(c, 'approved', { reason: 'Ще правка' });
    const v = await k.submit(
      await k.version(back.id, {
        title: 'V2',
        body: 'Інший текст',
        sourceIds: [a.source.id],
        claimIds: [a.claim.id],
        offerVersionId: a.offerId,
      }),
    );
    const op = await request(srv)
      .post(`${base}/versions/${v.id}/qa-checks`)
      .set(as('operator'))
      .send({ opKey: randomUUID(), kind: 'technical', result: 'pass' })
      .expect(201);
    expect(op.body.data).toMatchObject({
      kind: 'technical',
      result: 'pass',
      selfReview: false,
    });
    const opEd = await request(srv)
      .post(`${base}/versions/${v.id}/qa-checks`)
      .set(as('operator'))
      .send({ opKey: randomUUID(), kind: 'editorial', result: 'pass' })
      .expect(403);
    expect(opEd.body.error.details).toEqual({ action: 'qa.editorial' });
    await request(srv)
      .post(`${base}/versions/${v.id}/qa-checks`)
      .set(as('editor'))
      .send({ opKey: randomUUID(), kind: 'editorial', result: 'pass' })
      .expect(201);
    const edAp = await request(srv)
      .post(`${base}/versions/${v.id}/approve`)
      .set(as('editor'))
      .send({ opKey: randomUUID(), versionHash: v.hash })
      .expect(403);
    expect(edAp.body.error.details).toEqual({ action: 'version.approve' });
    const po = await request(srv)
      .post(`${base}/versions/${v.id}/approve`)
      .set(as('product_owner'))
      .send({
        opKey: randomUUID(),
        versionHash: v.hash,
        approverDisplayName: 'Чуже імʼя',
      })
      .expect(201);
    // PO не автор версии — без самоаудита.
    expect(po.body.data).toMatchObject({
      status: 'active',
      selfReview: false,
      // Имя — снимок гранта с сервера, не из тела (S3-6).
      approverDisplayName: (
        await s.prisma.pubRoleGrant.findFirstOrThrow({
          where: { productId: p.id, memberId: m.product_owner.memberId },
        })
      ).memberDisplayName,
    });
    expect(po.body.data.approverDisplayName).not.toBe('Чуже імʼя');
    // Оператор планирует (OP/PO по машине 7.1), но не снимает материал.
    const cur = (
      await request(srv)
        .get(`${base}/contents/${c.id}`)
        .set(as('operator'))
        .expect(200)
    ).body.data;
    await request(srv)
      .post(`${base}/contents/${c.id}/transition`)
      .set(as('operator'))
      .send({
        opKey: randomUUID(),
        to: 'scheduled',
        expectedRevision: cur.revision,
      })
      .expect(200);
    const cur2 = (
      await request(srv)
        .get(`${base}/contents/${c.id}`)
        .set(as('operator'))
        .expect(200)
    ).body.data;
    const wd = await request(srv)
      .post(`${base}/contents/${c.id}/transition`)
      .set(as('operator'))
      .send({
        opKey: randomUUID(),
        to: 'withdrawn',
        reason: 'x',
        expectedRevision: cur2.revision,
      })
      .expect(403);
    expect(wd.body.error.code).toBe('PUB_ROLE_REQUIRED');
    // diff версий
    const diff = await request(srv)
      .get(`${base}/contents/${c.id}/versions/${a.version.id}/diff/${v.id}`)
      .set(as('viewer'))
      .expect(200);
    expect(diff.body.data).toMatchObject({
      a: a.version.id,
      b: v.id,
      title: { from: a.version.title, to: 'V2' },
    });
  });

  it('Р-PUB-Z2-16: slug «похожий на контакт» (7+ цифр) — 400 slug: contact_like при создании и правке; обычный — проходит', async () => {
    const acc = await seedAccount(s.prisma);
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    const k = new Kit(s, acc, p);
    const a = await approvedArticle(k, { slug: testSlug('ok') });
    const srv = s.app!.getHttpServer();
    const base = `/publisher/products/${p.id}`;
    const owner = asMember(acc.owner.telegramId, acc.accountId);
    for (const slug of ['zvit-0671234567', 'tel-067-123-45-67']) {
      const c = await request(srv).post(`${base}/contents`).set(owner).send({
        opKey: randomUUID(),
        kind: 'article',
        briefId: a.brief.id,
        slug,
      });
      expect(c.status).toBe(400);
      expect(c.body.error.details.fields).toEqual(
        expect.arrayContaining([{ field: 'slug', code: 'contact_like' }]),
      );
    }
    const upd = await request(srv)
      .patch(`${base}/contents/${a.content.id}`)
      .set(owner)
      .send({
        opKey: randomUUID(),
        slug: 'kod-1234567',
        expectedRevision: a.content.revision,
      });
    expect(upd.status).toBe(400);
    expect(upd.body.error.details.fields).toEqual([
      { field: 'slug', code: 'contact_like' },
    ]);
    // Год, версия, короткие числа — не контакт.
    for (const ok of ['zvit-2026-v2', 'top-10-agentsiy', testSlug('z1')])
      expect(slugLooksLikeContact(ok)).toBe(false);
    expect(slugLooksLikeContact('a-12345678')).toBe(true);
  });

  it('чужой кабинет: маршруты P-B1 с :pid → 404 одинаково', async () => {
    const { a, b } = await seedTwoAccounts(s.prisma, {
      withProducts: true,
      kind: 'test',
    });
    const srv = s.app!.getHttpServer();
    const h = asMember(a.owner.telegramId, a.accountId);
    for (const path of [
      'sources',
      'questions',
      'brand-facts',
      'briefs',
      'contents',
      'claims',
      'context-preview',
    ]) {
      await request(srv)
        .get(`/publisher/products/${b.product!.id}/${path}`)
        .set(h)
        .expect(404);
    }
    await request(srv)
      .post(`/publisher/products/${b.product!.id}/sources`)
      .set(h)
      .send({
        opKey: randomUUID(),
        kind: 'manual_text',
        title: 't',
        fragment: 'f',
        visibility: 'public',
        usage: 'allowed',
      })
      .expect(404);
  });

  it('группа вопросов: повтор opKey → тот же ответ, в ключе идемпотентности нет текста задачи', async () => {
    const acc = await seedAccount(s.prisma);
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    const k = new Kit(s, acc, p);
    const q = await k.question();
    const srv = s.app!.getHttpServer();
    const h = asMember(acc.owner.telegramId, acc.accountId);
    const body = {
      opKey: randomUUID(),
      key: `g-${randomUUID().slice(0, 6)}`,
      task: 'Обрати агенцію',
      stage: 'consideration',
      rationale: 'Одна задача',
      questionIds: [q.id],
    };
    const r1 = await request(srv)
      .post(`/publisher/products/${p.id}/question-groups`)
      .set(h)
      .send(body)
      .expect(201);
    const r2 = await request(srv)
      .post(`/publisher/products/${p.id}/question-groups`)
      .set(h)
      .send(body)
      .expect(201);
    expect(r2.body.data).toEqual(r1.body.data);
    const key = await s.prisma.pubIdempotencyKey.findFirstOrThrow({
      where: { opKey: body.opKey },
    });
    expect(JSON.stringify(key.responseBody)).not.toContain('Обрати агенцію');
    const other = await request(srv)
      .post(`/publisher/products/${p.id}/question-groups`)
      .set(h)
      .send({ ...body, task: 'Інша задача' })
      .expect(409);
    expect(other.body.error.code).toBe('PUB_IDEMPOTENCY_REUSED');
  });

  it('CSV вопросов: значения-формулы экранированы, аудит export; неверный format — 400', async () => {
    const acc = await seedAccount(s.prisma);
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    const k = new Kit(s, acc, p);
    await k.question({ text: '=HYPERLINK("http://x")' });
    const srv = s.app!.getHttpServer();
    const h = asMember(acc.owner.telegramId, acc.accountId);
    const csv = await request(srv)
      .get(`/publisher/products/${p.id}/questions?format=csv`)
      .set(h)
      .expect(200);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv.headers['cache-control']).toBe('private, no-store');
    const json = await request(srv)
      .get(`/publisher/products/${p.id}/questions`)
      .set(h)
      .expect(200);
    expect(json.body).toMatchObject({
      success: true,
      data: { items: [expect.any(Object)], nextBefore: null },
    });
    await request(srv)
      .get(`/publisher/products/${p.id}/questions?format=xml`)
      .set(h)
      .expect(400);
    expect(
      await s.prisma.pubAuditEvent.count({
        where: { productId: p.id, action: 'export' },
      }),
    ).toBe(1);
  });
});
