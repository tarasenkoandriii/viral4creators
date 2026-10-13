/**
 * [AT-F04-02][AT-F06-02][AT-F02-02][AT-CORE-10] Решения и изменения ПОСЛЕ
 * согласования (P-B1, раунд исправлений по аудиту: S0-1, S0-2, S2-1, S2-2,
 * S2-3, S3-3, S3-4, S3-7 — мутации M1, M2, M6):
 *
 *  - claim признан `unsupported` / QA `fail` после согласования →
 *    каскад (`criticalStale` при критическом claim, задачи изменения),
 *    согласование не действует для выпуска и распространения: `schedule`,
 *    `markPublished` и `publishableVersion` (порт P-C) блокируют;
 *  - факт цены в АКТИВНОМ оффере изменён → материалы с этим оффером
 *    (`offer_version`) → `correction_required` + `criticalStale`;
 *  - после публикации v2 статьи адаптации v1 — на проверку;
 *  - параллельные `approve` → одно активное согласование; гонка
 *    `request_changes`/`approve` → ровно один успех;
 *  - параллельная правка источника → 409, одна новая редакция;
 *  - отзыв согласования показанной версии → материал снят (сайт 410);
 *  - `schedule` проверяет все причины задач изменения;
 *  - устаревший hash (связь claim → источник после согласования) →
 *    `schedule`/`markPublished` 409; родитель адаптации снят между
 *    созданием и согласованием → `parent_not_approved`; `supported` по
 *    связи, проверенной ДО правки источника, — отказ.
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { PubPorts } from '../../modules/publisher/core/ports';
import { loadClaim } from '../../modules/publisher/content/views';
import {
  Kit,
  approvedArticle,
  codeOf,
  contentStack,
  errOf,
  type ApprovedArticle,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import {
  seedAccount,
  seedProduct,
} from '../../modules/publisher/testing/fixtures.testing';
import { testSlug } from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(240_000);

ciDescribe(
  '[AT-F04-02][AT-F02-02][AT-CORE-10] отрицательные решения и изменения входов после согласования доходят до выпуска и распространения',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack();
    });
    afterAll(async () => {
      await s.close();
    });

    const liveKit = async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'working',
        mode: 'live',
      });
      return new Kit(s, acc, p);
    };
    const published = async (k: Kit) => {
      const slug = testSlug('aa');
      const a = await approvedArticle(k, { slug });
      await k.transition(a.content, 'scheduled');
      const pubId = await k.publish(a.version.id, 'live', slug);
      return { a, slug, pubId };
    };
    const pv = (k: Kit, versionId: string) =>
      k.tx((tx) => k.port.publishableVersion(tx, k.p, versionId));
    const recheck = (k: Kit, versionId: string) =>
      errOf(k.tx((tx) => k.contents.recheckPublishable(tx, k.p, versionId)));
    const approvalStatus = async (id: string) =>
      (await s.prisma.pubApproval.findUniqueOrThrow({ where: { id } })).status;
    const claimNow = (k: Kit, a: ApprovedArticle) =>
      k.tx((tx) => loadClaim(tx, k.p.id, a.claim.id));
    const mkAdaptation = async (
      k: Kit,
      a: ApprovedArticle,
      kind: string,
      approve = true,
    ) => {
      const c = await k.content({ kind, parentContentId: a.content.id });
      let v = await k.version(c.id, {
        title: `Адаптація ${kind}`,
        body: 'Текст адаптації.',
        meta: {
          cta: 'Читати статтю',
          ...(kind === 'cards' ? { cards: [{ title: 'К1', text: 'Т1' }] } : {}),
        },
        claimIds: [a.claim.id],
        offerVersionId: a.offerId,
        parentVersionId: a.version.id,
      });
      v = await k.submit(v);
      await k.qaPass(v.id, 'editorial');
      await k.qaPass(v.id, 'technical');
      await k.qaPass(v.id, 'adaptation_meaning');
      const ap = approve ? await k.approve(v) : null;
      return { c: await k.getContent(c.id), v, ap };
    };

    // ── S0-1 ─────────────────────────────────────────────────────────────

    it('claim → unsupported ПОСЛЕ согласования (не опубликован): согласование снято, schedule и порт P-C не пропускают', async () => {
      const k = await liveKit();
      const a = await approvedArticle(k);
      expect((await pv(k, a.version.id)).approvalActive).toBe(true);
      await k.verify(a.claim, 'unsupported');
      expect(await approvalStatus(a.approval.id)).toBe('superseded');
      const p = await pv(k, a.version.id);
      expect(p.approvalActive).toBe(false);
      expect((await recheck(k, a.version.id)).code).toBe(
        'PUB_APPROVAL_REQUIRED',
      );
      const c = await k.getContent(a.content.id);
      expect(await codeOf(k.transition(c, 'scheduled'))).not.toBe('OK');
      // Повторное согласование той же версии с unsupported claim — блокер.
      const v = await k.getVersion(a.version.id);
      const again = await errOf(k.approve(v));
      expect(again.code).not.toBe('OK');
    });

    it('claim → unsupported ПОСЛЕ публикации: correction_required + criticalStale, блокер claim_unsupported, повторная публикация и распространение — отказ', async () => {
      const k = await liveKit();
      const { a, slug } = await published(k);
      await k.verify(await claimNow(k, a), 'unsupported');
      const c = await k.getContent(a.content.id);
      expect(c).toMatchObject({
        status: 'correction_required',
        criticalStale: true,
      });
      expect(c.openTasks.map((t) => t.reason)).toContain('claim_changed');
      const p = await pv(k, a.version.id);
      expect(p).toMatchObject({ approvalActive: false, criticalStale: true });
      const r = await recheck(k, a.version.id);
      expect(r.code).toBe('PUB_BLOCKERS_OPEN');
      expect(r.details.blockers).toEqual(
        expect.arrayContaining([{ code: 'claim_unsupported', id: a.claim.id }]),
      );
      expect(
        await codeOf(k.publish(a.version.id, 'test', `${slug}-again`)),
      ).toBe('PUB_BLOCKERS_OPEN');
    });

    it('QA fail ПОСЛЕ публикации (блокер по критическому claim): correction_required + criticalStale, порт не пропускает; QA fail по согласованной неопубликованной версии — согласование снято', async () => {
      const k = await liveKit();
      const { a } = await published(k);
      await k.qaPass(a.version.id, 'editorial', 'fail', [
        {
          code: 'wrong_price',
          text: 'Ціна в тексті не збігається з офером',
          claimId: a.claim.id,
        },
      ]);
      const c = await k.getContent(a.content.id);
      expect(c).toMatchObject({
        status: 'correction_required',
        criticalStale: true,
      });
      expect(c.openTasks.map((t) => t.reason)).toContain('stale_check');
      expect((await pv(k, a.version.id)).approvalActive).toBe(false);
      const r = await recheck(k, a.version.id);
      expect(r.code).toBe('PUB_BLOCKERS_OPEN');
      expect(
        (r.details.blockers as Array<{ code: string }>).map((b) => b.code),
      ).toContain('qa_editorial_missing');

      const b = await approvedArticle(k, { rank: 2 });
      await k.qaPass(b.version.id, 'technical', 'fail', [
        { code: 'broken_link', text: 'Посилання не відкривається' },
      ]);
      expect(await approvalStatus(b.approval.id)).toBe('superseded');
      expect((await pv(k, b.version.id)).approvalActive).toBe(false);
      expect((await k.getContent(b.content.id)).criticalStale).toBe(false);
    });

    // ── S0-2 ─────────────────────────────────────────────────────────────

    it('[AT-F02-02] цена — факт АКТИВНОГО оффера: новая цена → материал с этим оффером correction_required + criticalStale, задача на оффер', async () => {
      const k = await liveKit();
      const f1 = await k.fact({
        factKey: 'price.pilot',
        kind: 'price',
        value: { amountMinor: 1_000_000, currency: 'UAH', note: 'пілот' },
      });
      await k.activateFact(f1.fact.id);
      const offer = await k.offer({ factIds: [f1.fact.id] });
      const slug = testSlug('op');
      const a = await approvedArticle(k, { slug, offerId: offer.id });
      await k.transition(a.content, 'scheduled');
      await k.publish(a.version.id, 'live', slug);
      // Версия не ссылается на факт напрямую — только через оффер.
      expect(
        await s.prisma.pubVersionFact.count({
          where: { versionId: a.version.id },
        }),
      ).toBe(0);
      const f2 = await k.fact({
        factKey: 'price.pilot',
        kind: 'price',
        value: { amountMinor: 1_500_000, currency: 'UAH', note: 'пілот' },
      });
      const r = await k.activateFact(f2.fact.id);
      expect(r.cascade.correctionRequired).toEqual([a.content.id]);
      expect(await k.getContent(a.content.id)).toMatchObject({
        status: 'correction_required',
        criticalStale: true,
      });
      expect((await pv(k, a.version.id)).criticalStale).toBe(true);
      expect(
        await s.prisma.pubReviewTask.count({
          where: {
            productId: k.p.id,
            objectType: 'offer_version',
            objectId: offer.id,
            reason: 'fact_changed',
            severity: 'critical',
            status: 'open',
          },
        }),
      ).toBe(1);
    });

    // ── S2-1 ─────────────────────────────────────────────────────────────

    it('после публикации v2 статьи адаптации v1 — на проверку: показанная → correction_required, согласованная → superseded', async () => {
      const k = await liveKit();
      const { a, slug } = await published(k);
      const post = await mkAdaptation(k, a, 'post');
      await k.transition(post.c, 'scheduled');
      await k.publish(post.v.id, 'live', `${slug}-post`);
      const cards = await mkAdaptation(k, a, 'cards');
      expect((await pv(k, cards.v.id)).approvalActive).toBe(true);

      let c = await k.getContent(a.content.id);
      c = await k.transition(c, 'correction_required', {
        reason: 'Оновлюємо приклади',
      });
      let v2 = await k.version(c.id, {
        title: a.version.title,
        body: 'Оновлений текст.\n\nДругий абзац.',
        meta: {
          description: 'Опис',
          shortAnswer: 'Коротко',
          cta: 'Обговорити задачу',
          editor: 'Редакторка',
        },
        sourceIds: [a.source.id],
        claimIds: [a.claim.id],
        offerVersionId: a.offerId,
      });
      v2 = await k.submit(v2);
      await k.qaPass(v2.id, 'editorial');
      await k.qaPass(v2.id, 'technical');
      await k.approve(v2);
      await k.transition(await k.getContent(c.id), 'scheduled');
      await k.publish(v2.id, 'live', slug);

      expect(await k.getContent(post.c.id)).toMatchObject({
        status: 'correction_required',
      });
      expect(await approvalStatus(cards.ap!.id)).toBe('superseded');
      expect((await pv(k, cards.v.id)).approvalActive).toBe(false);
      const pp = await pv(k, post.v.id);
      expect(pp.approvalActive).toBe(false); // родитель v1 больше не согласован
      expect(pp.openChangeTasks).toBeGreaterThan(0);
    });

    // ── S2-2 ─────────────────────────────────────────────────────────────

    it('параллельные approve одной версии → ровно одно активное согласование; гонка request_changes/approve → ровно один успех', async () => {
      const k = await liveKit();
      const a = await approvedArticle(k);
      // Новая статья до согласования: разберём approve вручную.
      const c = await k.content({
        kind: 'article',
        briefId: a.brief.id,
        slug: testSlug('pa'),
      });
      const prep = async (contentId: string) => {
        let v = await k.version(contentId, {
          title: 'Паралельне рішення',
          body: 'Текст.',
          meta: {
            description: 'Опис',
            shortAnswer: 'Коротко',
            cta: 'Обговорити',
            editor: 'Редакторка',
          },
          sourceIds: [a.source.id],
          claimIds: [a.claim.id],
          offerVersionId: a.offerId,
        });
        v = await k.submit(v);
        await k.qaPass(v.id, 'editorial');
        await k.qaPass(v.id, 'technical');
        return k.getVersion(v.id);
      };
      const v = await prep(c.id);
      const codes = await Promise.all([
        codeOf(k.approve(v)),
        codeOf(k.approve(v)),
      ]);
      expect(codes.filter((x) => x === 'OK')).toHaveLength(1);
      // Второй ждал блокировку материала и увидел уже согласованную версию.
      expect(['PUB_CONFLICT', 'PUB_TRANSITION_INVALID']).toContain(
        codes.find((x) => x !== 'OK'),
      );
      expect(
        await s.prisma.pubApproval.count({
          where: { objectId: v.id, status: 'active' },
        }),
      ).toBe(1);

      const c2 = await k.content({
        kind: 'article',
        briefId: a.brief.id,
        slug: testSlug('rc'),
      });
      const v2 = await prep(c2.id);
      const cur = await k.getContent(c2.id);
      const race = await Promise.all([
        codeOf(k.approve(v2)),
        codeOf(
          k.transition(cur, 'changes_requested', {
            reason: 'Уточнити приклад',
          }),
        ),
      ]);
      expect(race.filter((x) => x === 'OK')).toHaveLength(1);
      const after = await k.getContent(c2.id);
      const active = await s.prisma.pubApproval.count({
        where: { objectId: v2.id, status: 'active' },
      });
      // Согласование есть ⇔ материал согласован (не «changes_requested + активное»).
      expect(active === 1).toBe(after.status === 'approved');
    });

    // ── S2-3 ─────────────────────────────────────────────────────────────

    it('параллельная правка связанного источника с одной ревизией → одна новая редакция, вторая — 409', async () => {
      const k = await liveKit();
      const a = await approvedArticle(k);
      const cur = await s.prisma.pubSource.findUniqueOrThrow({
        where: { id: a.source.id },
      });
      const edit = (fragment: string) =>
        codeOf(
          k.op('source.manage', (tx, st) =>
            k.sources.patch(
              tx,
              k.p,
              a.source.id,
              { expectedRevision: cur.revision, fragment },
              st.actor,
              st.now,
            ),
          ),
        );
      const codes = await Promise.all([
        edit('Редакція А: клієнти питають про ціну.'),
        edit('Редакція Б: клієнти питають про строки.'),
      ]);
      expect(codes.filter((x) => x === 'OK')).toHaveLength(1);
      expect(codes.filter((x) => x !== 'OK')).toEqual(['PUB_CONFLICT']);
      expect(
        await s.prisma.pubSource.count({
          where: { supersedesId: a.source.id },
        }),
      ).toBe(1);
      // Вторая редакция той же прежней строки (свежая ревизия) — тоже 409.
      const now = await s.prisma.pubSource.findUniqueOrThrow({
        where: { id: a.source.id },
      });
      const third = await errOf(
        k.op('source.manage', (tx, st) =>
          k.sources.patch(
            tx,
            k.p,
            a.source.id,
            { expectedRevision: now.revision, fragment: 'Редакція В.' },
            st.actor,
            st.now,
          ),
        ),
      );
      expect(third).toMatchObject({
        code: 'PUB_CONFLICT',
        details: { reason: 'source_superseded' },
      });
    });

    // ── S3-3, S3-4 ───────────────────────────────────────────────────────

    it('отзыв согласования показанной версии → материал снят (сайт 410), публикации сняты', async () => {
      const k = await liveKit();
      const { a, slug } = await published(k);
      await k.op('version.approve', (tx, st) =>
        k.approvals.revoke(
          tx,
          k.p,
          a.approval.id,
          { reason: 'Погодження помилкове' },
          k.who.actors,
          st.now,
        ),
      );
      expect((await k.getContent(a.content.id)).status).toBe('withdrawn');
      const rows = await s.prisma.$queryRaw<Array<{ withdrawn: boolean }>>`
        SELECT "withdrawn" FROM "sites"."pub_public_contents"
         WHERE "productId" = ${k.p.id} AND "slug" = ${slug}`;
      expect(rows).toEqual([{ withdrawn: true }]);
    });

    it('schedule проверяет все причины задач изменения (claim_changed по версии) и устаревший hash (M1)', async () => {
      const k = await liveKit();
      const a = await approvedArticle(k);
      const ports = s.mod.get(PubPorts, { strict: false });
      await k.tx((tx) =>
        ports.review().open(
          tx,
          k.p,
          [
            {
              objectType: 'content_version',
              objectId: a.version.id,
              reason: 'claim_changed',
              triggerRef: `test:${randomUUID()}`,
              severity: 'normal',
            },
          ],
          { actor: 'system:test' },
        ),
      );
      const r = await errOf(k.transition(a.content, 'scheduled'));
      expect(r.code).toBe('PUB_BLOCKERS_OPEN');
      expect(
        (r.details.blockers as Array<{ code: string }>).map((b) => b.code),
      ).toEqual(['change_task_open']);

      // M1: hash версии устарел (новая связь claim → источник) — 409.
      const b = await approvedArticle(k, { rank: 2 });
      const scheduled = await k.transition(b.content, 'scheduled');
      const extra = await k.source({ title: 'Додаткове джерело' });
      await k.claimSource(b.claim.id, extra.id, 'yes');
      expect(await approvalStatus(b.approval.id)).toBe('active');
      expect((await recheck(k, b.version.id)).code).toBe('PUB_APPROVAL_STALE');
      expect(
        await codeOf(k.publish(b.version.id, 'live', `m1-${randomUUID()}`)),
      ).toBe('PUB_APPROVAL_STALE');
      const back = await k.transition(scheduled, 'approved', {
        reason: 'Перевірити hash',
      });
      expect(await codeOf(k.transition(back, 'scheduled'))).toBe(
        'PUB_APPROVAL_STALE',
      );
      expect((await pv(k, b.version.id)).approvalActive).toBe(false);
    });

    // ── S3-7: M2, M6 ─────────────────────────────────────────────────────

    it('M2: родитель адаптации снят между созданием и согласованием → parent_not_approved; снят после — выпуск адаптации блокирован', async () => {
      const k = await liveKit();
      const a = await approvedArticle(k);
      const ready = await mkAdaptation(k, a, 'post');
      const pending = await mkAdaptation(k, a, 'cards', false);
      await k.op('version.approve', (tx, st) =>
        k.approvals.revoke(
          tx,
          k.p,
          a.approval.id,
          { reason: 'Статтю треба переписати' },
          k.who.actors,
          st.now,
        ),
      );
      const r = await errOf(k.approve(await k.getVersion(pending.v.id)));
      expect(r.code).toBe('PUB_BLOCKERS_OPEN');
      expect(r.details.blockers).toEqual([
        { code: 'parent_not_approved', id: a.version.id },
      ]);
      const rr = await recheck(k, ready.v.id);
      expect(rr.code).toBe('PUB_BLOCKERS_OPEN');
      expect(rr.details.blockers).toEqual([
        { code: 'parent_not_approved', id: a.version.id },
      ]);
      expect((await pv(k, ready.v.id)).approvalActive).toBe(false);
    });

    it('M6: supported по связи, проверенной ДО правки источника (некритический claim), — отказ; после повторной проверки — можно', async () => {
      const k = await liveKit();
      const src = await k.source();
      let claim = await k.claim({
        statement: 'Агенція працює з 2019 року',
        type: 'fact',
        risk: 'normal',
      });
      claim = await k.claimSource(claim.id, src.id, 'yes');
      const cur = await s.prisma.pubSource.findUniqueOrThrow({
        where: { id: src.id },
      });
      await k.op('source.manage', (tx, st) =>
        k.sources.patch(
          tx,
          k.p,
          src.id,
          {
            expectedRevision: cur.revision,
            fragment: 'Агенція працює з 2021 року.',
          },
          st.actor,
          st.now,
        ),
      );
      const r = await errOf(k.verify(claim, 'supported'));
      expect(r).toEqual({
        code: 'PUB_VALIDATION',
        details: {
          fields: [{ field: 'status', code: 'no_supporting_source' }],
        },
      });
      claim = await k.claimSource(claim.id, src.id, 'yes');
      expect((await k.verify(claim, 'supported')).status).toBe('supported');
    });
  },
);
