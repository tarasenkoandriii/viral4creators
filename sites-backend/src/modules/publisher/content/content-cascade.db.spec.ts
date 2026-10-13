/**
 * P-B1 на базе: каскады и служебные пути (§6.3, §7.1, §15.1, §16.3):
 * правка содержимого связанного источника — новая строка с `supersedesId`
 * и задачи `claim_changed`; несвязанный источник и claim правятся на месте;
 * отзыв согласования опубликованной версии снимает страницу; `confirm_
 * unaffected` — только после закрытия задач; `markWithdrawn`; вклад
 * `member-reassign:contents`; задание `approvals-expire-publish`.
 */
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import { ReviewTasksService } from '../core/review-tasks.service';
import {
  seedAccount,
  seedProduct,
  type SeededAccount,
} from '../testing/fixtures.testing';
import { ApprovalsExpirePublishJob } from './approvals-publish.service';
import { ContentsMemberReassign } from './member-reassign';
import {
  Kit,
  approvedArticle,
  codeOf,
  contentStack,
  errOf,
  type ContentStack,
} from './testing/content-kit.testing';
import { testSlug } from '../testing/fixtures.testing';

jest.setTimeout(150_000);

ciDescribe('Publisher P-B1: каскады и служебные пути на базе', () => {
  let s: ContentStack;
  let acc: SeededAccount;
  beforeAll(async () => {
    s = await contentStack();
    acc = await seedAccount(s.prisma);
  });
  afterAll(async () => {
    await s.close();
  });
  const kit = async (live = false) =>
    new Kit(
      s,
      acc,
      await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: live ? 'working' : 'test',
        mode: live ? 'live' : 'test',
      }),
    );
  const shown = (productId: string, slug: string) =>
    s.prisma.$queryRaw<Array<{ versionHash: string }>>`
      SELECT "versionHash" FROM "sites"."pub_public_contents"
       WHERE "productId" = ${productId} AND "slug" = ${slug} AND NOT "withdrawn"`;

  it('источник: несвязанный правится на месте (contentHash пересчитан); связанный — новая строка supersedesId, задачи claim_changed', async () => {
    const k = await kit();
    const free = await k.source({ fragment: 'Старий текст' });
    const r = await k.op('source.manage', (tx, st) =>
      k.sources.patch(
        tx,
        k.p,
        free.id,
        { expectedRevision: free.revision, fragment: 'Новий текст' },
        st.actor,
        st.now,
      ),
    );
    expect(r).toMatchObject({
      id: free.id,
      fragment: 'Новий текст',
      supersedesId: null,
    });
    expect(r.contentHash).not.toBe(free.contentHash);

    const a = await approvedArticle(k);
    const cur = await s.prisma.pubSource.findUniqueOrThrow({
      where: { id: a.source.id },
    });
    const n = await k.op('source.manage', (tx, st) =>
      k.sources.patch(
        tx,
        k.p,
        a.source.id,
        { expectedRevision: cur.revision, fragment: 'Виправлений фрагмент' },
        st.actor,
        st.now,
      ),
    );
    expect(n).toMatchObject({
      supersedesId: a.source.id,
      usage: 'restricted',
      fragment: 'Виправлений фрагмент',
    });
    const old = await s.prisma.pubSource.findUniqueOrThrow({
      where: { id: a.source.id },
    });
    expect(old.fragment).toBe(a.source.fragment);
    const tasks = await s.prisma.pubReviewTask.findMany({
      where: {
        productId: k.p.id,
        reason: 'claim_changed',
        triggerRef: `source:${n.id}`,
      },
    });
    expect(tasks.map((t) => `${t.objectType}:${t.objectId}`)).toEqual([
      `content_version:${a.version.id}`,
    ]);
    expect(
      (
        await s.prisma.pubApproval.findUniqueOrThrow({
          where: { id: a.approval.id },
        })
      ).status,
    ).toBe('superseded');
    // Мимо сервиса база не даёт поменять содержимое связанного источника.
    expect(
      await codeOf(
        s.prisma.pubSource.update({
          where: { id: a.source.id },
          data: { fragment: 'хак' },
        }),
      ),
    ).not.toBe('OK');
  });

  it('claim без связи с замороженной версией правится на месте (подтверждение сбрасывается)', async () => {
    const k = await kit();
    const src = await k.source();
    let c = await k.claim({
      statement: 'Термін 2 тижні',
      type: 'fact',
      risk: 'high',
    });
    c = await k.claimSource(c.id, src.id, 'yes');
    c = await k.verify(c, 'supported');
    const r = await k.op('version.manage', (tx, st) =>
      k.claims.patch(
        tx,
        k.p,
        c.id,
        { expectedRevision: c.revision, statement: 'Термін 3 тижні' },
        st.actor,
        st.now,
      ),
    );
    expect(r).toMatchObject({ supersededId: null, cascade: null });
    expect(r.claim).toMatchObject({
      id: c.id,
      statement: 'Термін 3 тижні',
      status: 'needs_review',
    });
  });

  it('отзыв согласования опубликованной версии снимает страницу; confirm_unaffected — только после закрытия задач', async () => {
    const k = await kit(true);
    const slug = testSlug('ra');
    const a = await approvedArticle(k, { slug });
    await k.transition(a.content, 'scheduled');
    await k.publish(a.version.id, 'live', slug);
    expect(await shown(k.p.id, slug)).toHaveLength(1);

    // Факт сменился (через оффер) → материал на проверке.
    await k.offer({ title: 'Оффер 2', priceNote: '10 000 грн' });
    let c = await k.getContent(a.content.id);
    expect(c.status).toBe('correction_required');
    expect(c.criticalStale).toBe(false); // цена та же
    // Редактор: «изменение текст не затрагивает» — пока задача открыта, нельзя.
    expect(
      (
        await errOf(
          k.transition(c, 'published', {
            reason: 'Текст не залежить від оферу',
          }),
        )
      ).details,
    ).toEqual({
      blockers: [{ code: 'change_task_open' }],
    });
    const rt = s.mod.get(ReviewTasksService, { strict: false });
    for (const t of c.openTasks) {
      const row = await s.prisma.pubReviewTask.findUniqueOrThrow({
        where: { id: t.id },
      });
      await k.tx((tx) =>
        rt.resolve(tx, k.p, t.id, {
          status: 'resolved',
          resolution: 'Текст не залежить від оферу',
          expectedRevision: row.revision,
          actor: k.who.actor,
          actors: k.who.actors,
          now: new Date(),
        }),
      );
    }
    c = await k.getContent(c.id);
    c = await k.transition(c, 'published', {
      reason: 'Історичний кейс, текст чинний',
    });
    expect(c.status).toBe('published');

    // Явный отзыв согласования показанной версии — страница снята.
    await k.op('approval.revoke', (tx) =>
      k.approvals.revoke(
        tx,
        k.p,
        a.approval.id,
        { reason: 'Помилка в тексті' },
        k.who.actors,
      ),
    );
    expect(await shown(k.p.id, slug)).toEqual([]);
  });

  it('ContentPort.markWithdrawn: последняя live-публикация снята — материал withdrawn', async () => {
    const k = await kit(true);
    const slug = testSlug('mw');
    const a = await approvedArticle(k, { slug });
    await k.transition(a.content, 'scheduled');
    const pubId = await k.publish(a.version.id, 'live', slug);
    await k.tx(async (tx) => {
      await tx.pubPublication.update({
        where: { id: pubId },
        data: { status: 'withdrawn' },
      });
      await k.port.markWithdrawn(
        tx,
        k.p,
        a.version.id,
        'Площадка зняла публікацію',
      );
    });
    expect((await k.getContent(a.content.id)).status).toBe('withdrawn');
    expect(
      await codeOf(
        k.tx((tx) =>
          k.port.markWithdrawn(tx, k.p, a.version.id, 'тел 067 123 45 67'),
        ),
      ),
    ).toBe('PUB_VALIDATION');
  });

  it('member-reassign: материалы удалённого участника — владельцу кабинета (снимок имени без контактов)', async () => {
    const k = await kit();
    const c = await k
      .op('version.manage', (tx, st) =>
        k.contents.create(
          tx,
          k.p,
          { kind: 'article', briefId: undefined, slug: undefined },
          st.actor,
        ),
      )
      .catch(() => null);
    expect(c).toBeNull(); // статья без брифа не создаётся
    const a = await approvedArticle(k);
    await s.prisma.pubContent.update({
      where: { id: a.content.id },
      data: { ownerMemberId: 'gone-member-1' },
    });
    const contrib = s.mod.get(ContentsMemberReassign, { strict: false });
    const n = await k.tx((tx) =>
      contrib.reassign(
        tx,
        k.p,
        'gone-member-1',
        acc.owner.memberId,
        'system:members-reconcile',
      ),
    );
    expect(n).toBe(1);
    const row = await s.prisma.pubContent.findUniqueOrThrow({
      where: { id: a.content.id },
    });
    expect(row.ownerMemberId).toBe(acc.owner.memberId);
    expect(row.ownerDisplayName).toBe(
      `Учасник …${acc.owner.memberId.slice(-6)}`,
    );
  });

  it('approvals-expire-publish: у publish_version срока нет — задание ничего не трогает и отвечает processed=0', async () => {
    const k = await kit();
    const a = await approvedArticle(k);
    const job = s.mod.get(ApprovalsExpirePublishJob, { strict: false });
    expect(job.key).toBe('approvals-expire-publish');
    const r = await job.run({
      now: new Date(Date.now() + 365 * 86_400_000),
      deadline: new Date(Date.now() + 30_000),
      scope: { siteIds: [k.p.siteId] },
    });
    expect(r.processed).toBe(0);
    expect(
      (
        await s.prisma.pubApproval.findUniqueOrThrow({
          where: { id: a.approval.id },
        })
      ).status,
    ).toBe('active');
  });
});
