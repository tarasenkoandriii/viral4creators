/**
 * P-B1 на базе: сквозной ручной путь F01→F03→F04→согласование→публикация
 * через `ContentPort` и обязательные проверки §16.3 «Тесты»: согласование
 * hash, публикация v2 по тому же URL (`replaced`, сайт отдаёт v1 до
 * публикации v2), параллельная правка черновика (409), `approved` при
 * `unknown` QA запрещён, `scheduled → published` при неактивном оффере
 * запрещён, тестовая публикация не трогает статус и `firstPublishedAt`.
 */
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import {
  seedAccount,
  seedProduct,
  type SeededAccount,
} from '../testing/fixtures.testing';
import {
  Kit,
  approvedArticle,
  codeOf,
  contentStack,
  errOf,
  type ContentStack,
} from './testing/content-kit.testing';
import { versionHashInput } from './version-hash';
import { testSlug } from '../testing/fixtures.testing';

jest.setTimeout(120_000);

ciDescribe('Publisher P-B1: ручной путь контента на базе', () => {
  let s: ContentStack;
  let acc: SeededAccount;

  beforeAll(async () => {
    s = await contentStack();
    acc = await seedAccount(s.prisma);
  });
  afterAll(async () => {
    await s.close();
  });

  const kit = async (mode: 'closed' | 'test' | 'live' = 'live') => {
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: mode === 'live' ? 'working' : 'test',
      mode,
    });
    return new Kit(s, acc, p);
  };

  const viewOf = (productId: string, slug: string) =>
    s.prisma.$queryRaw<Array<{ versionHash: string; title: string }>>`
      SELECT "versionHash", "title" FROM "sites"."pub_public_contents"
       WHERE "productId" = ${productId} AND "slug" = ${slug} AND NOT "withdrawn"`;

  it('согласованная статья: hash замороженной версии, approval active, материал approved', async () => {
    const k = await kit();
    const a = await approvedArticle(k);
    expect(a.version.status).toBe('approved');
    expect(a.version.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.version.frozenAt).not.toBeNull();
    expect(a.approval).toMatchObject({
      status: 'active',
      versionHash: a.version.hash,
      selfReview: true,
    });
    expect(a.content.status).toBe('approved');
    expect(a.content.approvedVersionId).toBe(a.version.id);
  });

  it('v1 опубликована → новая версия v2 отправлена: сайт отдаёт v1; v2 опубликована: v2 на сайте, v1 replaced, её согласование superseded', async () => {
    const k = await kit();
    const slug = testSlug('p');
    const a = await approvedArticle(k, { slug });
    let c = await k.transition(a.content, 'scheduled', {
      plannedAt: new Date().toISOString(),
    });
    const pub1 = await k.publish(a.version.id, 'live', slug);
    c = await k.getContent(c.id);
    expect(c.status).toBe('published');
    expect(c.firstPublishedAt).not.toBeNull();
    expect((await viewOf(k.p.id, slug))[0]?.versionHash).toBe(a.version.hash);

    // Исправление: needs_correction → новая версия → отправка.
    c = await k.transition(c, 'correction_required', {
      reason: 'Уточнити приклад',
    });
    let v2 = await k.version(c.id, {
      title: 'Як обрати агенцію (оновлено)',
      body: 'Новий текст.',
      meta: { description: 'Опис 2', cta: 'Обговорити задачу' },
      sourceIds: [a.source.id],
      claimIds: [a.claim.id],
      offerVersionId: a.offerId,
    });
    v2 = await k.submit(v2);
    // Отправка v2 страницу не снимает: согласование v1 активно.
    expect((await viewOf(k.p.id, slug))[0]?.versionHash).toBe(a.version.hash);
    await k.qaPass(v2.id, 'editorial');
    await k.qaPass(v2.id, 'technical');
    await k.approve(await k.getVersion(v2.id));
    expect((await viewOf(k.p.id, slug))[0]?.versionHash).toBe(a.version.hash);
    c = await k.getContent(c.id);
    c = await k.transition(c, 'scheduled');
    await k.publish(v2.id, 'live', slug);
    const rows = await viewOf(k.p.id, slug);
    expect(rows).toHaveLength(1);
    expect(rows[0].versionHash).toBe(v2.hash);
    const p1 = await s.prisma.pubPublication.findUniqueOrThrow({
      where: { id: pub1 },
    });
    expect(p1.status).toBe('replaced');
    const ap1 = await s.prisma.pubApproval.findUniqueOrThrow({
      where: { id: a.approval.id },
    });
    expect(ap1.status).toBe('superseded');
    c = await k.getContent(c.id);
    expect(c.publishedVersionId).toBe(v2.id);
  });

  it('прежний hash не разрешает новый текст: согласование с hash другой версии → PUB_APPROVAL_STALE', async () => {
    const k = await kit('test');
    const a = await approvedArticle(k);
    const c = await k.transition(a.content, 'scheduled');
    const back = await k.transition(c, 'approved', { reason: 'Перенос дати' });
    let v2 = await k.version(back.id, {
      title: 'Інший текст',
      body: 'Змінено.',
      meta: { cta: 'x' },
      sourceIds: [a.source.id],
      claimIds: [a.claim.id],
      offerVersionId: a.offerId,
    });
    v2 = await k.submit(v2);
    await k.qaPass(v2.id, 'editorial');
    await k.qaPass(v2.id, 'technical');
    const r = await errOf(k.approve({ ...v2, hash: a.version.hash }));
    expect(r.code).toBe('PUB_APPROVAL_STALE');
    // Согласование v1 (не опубликованной) снято новой версией.
    const ap1 = await s.prisma.pubApproval.findUniqueOrThrow({
      where: { id: a.approval.id },
    });
    expect(ap1.status).toBe('superseded');
  });

  it('параллельная правка черновика: вторая запись со старой ревизией → 409 PUB_CONFLICT', async () => {
    const k = await kit('test');
    const offer = await k.offer();
    const src = await k.source();
    const q = await k.selectQuestion(await k.question(), 1, src.id);
    const b = await k.briefReady(
      await k.brief({
        questionId: q.id,
        goal: 'Мета',
        format: 'instruction',
        ownContribution: 'Вклад',
        cta: 'CTA',
        ctaIntentNote: 'Доречно',
        sourceIds: [src.id],
      }),
    );
    const c = await k.content({
      kind: 'article',
      briefId: b.id,
      slug: testSlug('c'),
    });
    const v = await k.version(c.id, {
      title: 'T',
      body: 'B',
      offerVersionId: offer.id,
    });
    const edit = (title: string) =>
      k.op('version.manage', (tx, st) =>
        k.contents.patchVersion(
          tx,
          k.p,
          c.id,
          v.id,
          { expectedRevision: v.revision, title },
          st.actor,
        ),
      );
    const [r1, r2] = await Promise.all([codeOf(edit('A')), codeOf(edit('B'))]);
    expect([r1, r2].sort()).toEqual(['OK', 'PUB_CONFLICT']);
  });

  it('QA unknown не проходит: согласование → PUB_BLOCKERS_OPEN {qa_technical_missing}; ai_review не учитывается', async () => {
    const k = await kit('test');
    const offer = await k.offer();
    const a = await approvedArticle(k, { offerId: offer.id });
    // Новая версия с QA unknown.
    const c = await k.transition(a.content, 'scheduled');
    const back = await k.transition(c, 'approved', { reason: 'Повернути' });
    let v2 = await k.version(back.id, {
      title: 'V2',
      body: 'B2',
      sourceIds: [a.source.id],
      claimIds: [a.claim.id],
      offerVersionId: offer.id,
    });
    v2 = await k.submit(v2);
    await k.qaPass(v2.id, 'editorial');
    await k.qaPass(v2.id, 'technical', 'unknown');
    // Проверка AI «pass» не заменяет техническую проверку человека.
    const call = await k.aiCall('pub.qa.review', { recommendation: 'ok' });
    await s.prisma.pubQaCheck.create({
      data: {
        accountId: acc.accountId,
        productId: k.p.id,
        versionId: v2.id,
        kind: 'ai_review',
        result: 'pass',
        blockers: [],
        checkedBy: 'system:ai-review',
        aiCallId: call,
        createdBy: 'system:ai-review',
      },
    });
    const r = await errOf(k.approve(v2));
    expect(r.code).toBe('PUB_BLOCKERS_OPEN');
    expect(r.details.blockers).toEqual([
      { code: 'qa_technical_missing', id: expect.any(String) },
    ]);
  });

  it('scheduled → published при неактивном оффере запрещён (повторная проверка §7.1)', async () => {
    const k = await kit();
    const slug = testSlug('o');
    const a = await approvedArticle(k, { slug });
    await k.transition(a.content, 'scheduled');
    // Новый оффер активирован после планирования: согласование
    // неопубликованной версии снято (аудит P2-15), оффер версии не активен.
    await k.offer({ title: 'Оффер 2', priceNote: '12 000 грн' });
    const pv = await k.tx((tx) =>
      k.port.publishableVersion(tx, k.p, a.version.id),
    );
    expect(pv).toMatchObject({ offerActive: false, approvalActive: false });
    expect(
      await codeOf(
        k.tx((tx) =>
          k.port.markPublished(
            tx,
            k.p,
            a.version.id,
            'pub-x',
            'live',
            new Date(),
          ),
        ),
      ),
    ).toBe('PUB_APPROVAL_REQUIRED');
    expect(await viewOf(k.p.id, slug)).toEqual([]);
  });

  it('тестовая публикация не переводит материал в published и не ставит firstPublishedAt (ДТ-1)', async () => {
    const k = await kit('test');
    const slug = testSlug('t');
    const a = await approvedArticle(k, { slug });
    const c = await k.transition(a.content, 'scheduled');
    await k.publish(a.version.id, 'test', slug);
    const after = await k.getContent(c.id);
    expect(after.status).toBe('scheduled');
    expect(after.firstPublishedAt).toBeNull();
    expect((await viewOf(k.p.id, slug))[0]?.versionHash).toBe(a.version.hash);
  });

  it('hash версии — с содержимым claims и связями claim → источник: тот же текст с другим claim — другой hash; смена supports после заморозки — PUB_APPROVAL_STALE', async () => {
    const k = await kit('test');
    const a = await approvedArticle(k);
    let c = await k.transition(a.content, 'scheduled');
    c = await k.transition(c, 'approved', { reason: 'Інший claim' });
    let other = await k.claim({
      statement: 'Інше твердження',
      type: 'fact',
      risk: 'normal',
    });
    other = await k.claimSource(other.id, a.source.id, 'yes');
    let v2 = await k.version(c.id, {
      title: a.version.title,
      body: a.version.body,
      meta: a.version.meta,
      sourceIds: a.version.sourceIds,
      claimIds: [other.id],
      offerVersionId: a.offerId,
    });
    v2 = await k.submit(v2);
    expect(v2.hash).not.toBe(a.version.hash);
    const input = await k.tx((tx) => versionHashInput(tx, k.p.id, v2.id));
    expect(input.claims).toEqual([
      {
        id: other.id,
        statement: 'Інше твердження',
        type: 'fact',
        risk: 'normal',
      },
    ]);
    expect(input.claimSources).toEqual([
      { claimId: other.id, sourceId: a.source.id, supports: 'yes' },
    ]);
    expect(input.sources).toEqual([
      expect.objectContaining({
        id: a.source.id,
        title: a.source.title,
        visibility: 'public',
        url: a.source.url,
      }),
    ]);
    await k.qaPass(v2.id, 'editorial');
    await k.qaPass(v2.id, 'technical');
    // Связь claim → источник изменилась после заморозки: hash уже не тот.
    await k.claimSource(other.id, a.source.id, 'partial');
    const r = await errOf(k.approve(v2));
    expect(r).toMatchObject({
      code: 'PUB_APPROVAL_STALE',
      details: { reason: 'hash_mismatch' },
    });
  });

  it('ContentPort.publishableVersion: hash, активность согласования, оффер, задачи', async () => {
    const k = await kit('test');
    const a = await approvedArticle(k);
    const r = await k.tx((tx) =>
      k.port.publishableVersion(tx, k.p, a.version.id),
    );
    expect(r).toMatchObject({
      contentId: a.content.id,
      hash: a.version.hash,
      approvalId: a.approval.id,
      approvalActive: true,
      criticalStale: false,
      firstLivePublishedAt: null,
      offerActive: true,
      openChangeTasks: 0,
    });
  });
});
