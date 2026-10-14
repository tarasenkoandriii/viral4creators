/**
 * [AT-RD-09] [AT-RD-04] P-R M2 — согласование Reddit-версии и его
 * инвалидирование (reddit-manual-mvp-adapted.md §M2.1, §M2.4, §M2.6, §9;
 * Р-RD-7, Р-RD-8):
 *  - ручной путь до согласования: заморозка пишет `reddit_policy`
 *    (`system:reddit-policy`), версия несёт снимок правил в `meta` (hash);
 *  - правка после согласования — только новая версия; прежнее согласование
 *    неопубликованной версии → `superseded`, его hash новой версии не
 *    подходит (`PUB_APPROVAL_STALE`);
 *  - WARN подтверждаются ровно: иначе 409 `warnings_not_acknowledged`;
 *    подтверждение — в meta аудита согласования;
 *  - новый снимок правил после заморозки → `PUB_APPROVAL_STALE
 *    rules_changed`; устаревшая проверка правил → `rules_stale`;
 *  - новый снимок после согласования (AT-RD-04, часть M2) — каскад:
 *    согласование неопубликованной версии `superseded`.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { approveParams } from '../../modules/publisher/ai/testing/ai-kit.testing';
import {
  Kit,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import { testSlug } from '../../modules/publisher/testing/fixtures.testing';
import {
  DISCLOSURE,
  api,
  approvedVersion,
  contentPath,
  draftVersion,
  humanQaPass,
  ok,
  redditStack,
  redditWorld,
  rulesBody,
  seedStudio,
  submitVersion,
  versionBody,
  warningCodes,
  type Api,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(240_000);

interface Version {
  id: string;
  number: number;
  status: string;
  hash: string | null;
  revision: number;
  title: string;
  meta: Record<string, unknown>;
}

ciDescribe('P-R M2: согласование Reddit-версии', () => {
  let s: RedditStack;
  let w: RedditWorld;
  let ed: Api;
  let po: Api;
  let C: string;
  beforeAll(async () => {
    s = await redditStack();
    w = await redditWorld(s);
    ed = api(s, w.acc.accountId, w.team.editor);
    po = api(s, w.acc.accountId, w.team.product_owner);
    C = contentPath(w);
  });
  afterAll(async () => {
    await s?.close();
  });

  it('ручной путь: версия comment — служебный заголовок, meta со снимком; заморозка → reddit_policy pass от system:reddit-policy; согласование PO', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const d = await draftVersion(ed, w, ids);
    const draft = ok<Version>(
      await ed.get(`${C}/contents/${ids.contentId}/versions/${d.id}`),
      200,
    );
    expect(draft.title).toMatch(new RegExp(`^r/${ids.name} · `));
    expect(draft.meta).toMatchObject({
      disclosure: DISCLOSURE,
      ruleSnapshotId: ids.snapshotId,
      affiliation: 'founder',
    });
    expect(String(draft.meta.threadUrl)).toMatch(
      new RegExp(`^https://www\\.reddit\\.com/r/${ids.name}/comments/`),
    );
    const v = await submitVersion(ed, w, ids.contentId, d);
    expect(v.status).toBe('submitted');
    const qa = ok<{
      items: Array<{
        kind: string;
        result: string;
        checkedBy: string;
        blockers: unknown[];
        warnings: unknown[];
      }>;
    }>(await po.get(`${C}/versions/${v.id}/qa-checks`), 200);
    expect(qa.items).toEqual([
      expect.objectContaining({
        kind: 'reddit_policy',
        result: 'pass',
        checkedBy: 'system:reddit-policy',
        blockers: [],
      }),
    ]);
    // Без QA человека — блокеры как у всех материалов.
    const early = await po.post(`${C}/versions/${v.id}/approve`, {
      versionHash: v.hash,
      acknowledgedWarnings: await warningCodes(po, w, v.id),
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('PUB_BLOCKERS_OPEN');
    expect(
      early.body.error.details.blockers.map((b: { code: string }) => b.code),
    ).toEqual(['qa_editorial_missing', 'qa_technical_missing']);
    await humanQaPass(po, w, v.id);
    const a = await po.post(`${C}/versions/${v.id}/approve`, {
      versionHash: v.hash,
      acknowledgedWarnings: await warningCodes(po, w, v.id),
    });
    expect(a.status).toBe(201);
    const audit = await s.prisma.pubAuditEvent.findFirstOrThrow({
      where: { objectType: 'approval', objectId: a.body.data.id },
    });
    expect(audit.meta).toMatchObject({
      versionId: v.id,
      acknowledgedWarnings: expect.any(Array),
      ruleSnapshotId: ids.snapshotId,
    });
    // Перед согласованием проверка записана заново.
    const n = await s.prisma.pubQaCheck.count({
      where: { versionId: v.id, kind: 'reddit_policy' },
    });
    expect(n).toBe(2);
  });

  it('[AT-RD-09] правка после согласования → новая версия; прежнее согласование superseded, его hash новой версии не подходит', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const v1 = await approvedVersion(ed, po, w, ids);
    // Замороженную версию править нельзя.
    const patch = await ed.patch(
      `${C}/contents/${ids.contentId}/versions/${v1.id}`,
      { expectedRevision: v1.revision + 1, body: versionBody('edited') },
    );
    expect(patch.status).toBe(409);
    const d2 = await draftVersion(ed, w, ids, {
      body: versionBody('A second, edited paragraph.'),
    });
    const approvals = await s.prisma.pubApproval.findMany({
      where: { objectId: v1.id },
    });
    expect(approvals.map((x) => x.status)).toEqual(['superseded']);
    const v2 = await submitVersion(ed, w, ids.contentId, d2);
    expect(v2.hash).not.toBe(v1.hash);
    await humanQaPass(po, w, v2.id);
    const stale = await po.post(`${C}/versions/${v2.id}/approve`, {
      versionHash: v1.hash,
      acknowledgedWarnings: await warningCodes(po, w, v2.id),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'PUB_APPROVAL_STALE',
      details: { reason: 'hash_param' },
    });
  });

  it('WARN подтверждаются ровно: не те коды → 409 warnings_not_acknowledged; подтверждение — в meta аудита', async () => {
    // Ссылки restricted + ссылка в тексте, brief.linksAllowed=true → WARN.
    const ids = await seedStudio(s, w, ed, po, { linksAllowed: true });
    const d = await draftVersion(ed, w, ids, {
      body: versionBody('Details are in the docs at docs.example.com/guide'),
    });
    const v = await submitVersion(ed, w, ids.contentId, d);
    await humanQaPass(po, w, v.id);
    const codes = await warningCodes(po, w, v.id);
    expect(codes).toContain('reddit_links_restricted');
    const bad = await po.post(`${C}/versions/${v.id}/approve`, {
      versionHash: v.hash,
      acknowledgedWarnings: [],
    });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toMatchObject({
      code: 'PUB_CONFLICT',
      details: {
        reason: 'warnings_not_acknowledged',
        codes: [...codes].sort(),
      },
    });
    const good = await po.post(`${C}/versions/${v.id}/approve`, {
      versionHash: v.hash,
      acknowledgedWarnings: [...codes].reverse(),
    });
    expect(good.status).toBe(201);
    const audit = await s.prisma.pubAuditEvent.findFirstOrThrow({
      where: { objectType: 'approval', objectId: good.body.data.id },
    });
    expect(
      (audit.meta as { acknowledgedWarnings: string[] }).acknowledgedWarnings,
    ).toEqual(codes);
  });

  it('новый снимок правил после заморозки → PUB_APPROVAL_STALE rules_changed (нужна новая версия на текущем снимке)', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const d = await draftVersion(ed, w, ids);
    const v = await submitVersion(ed, w, ids.contentId, d);
    await humanQaPass(po, w, v.id);
    const snap = ok<{ id: string }>(
      await ed.post(
        `${w.P}/communities/${ids.communityId}/rules`,
        rulesBody(ids.name, 'restricted'),
      ),
      201,
    );
    ok(await po.post(`${w.P}/rules/${snap.id}/review`), 200);
    const r = await po.post(`${C}/versions/${v.id}/approve`, {
      versionHash: v.hash,
      acknowledgedWarnings: [],
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: 'PUB_APPROVAL_STALE',
      details: {
        reason: 'rules_changed',
        ruleSnapshotId: ids.snapshotId,
        currentSnapshotId: snap.id,
      },
    });
  });

  it('проверка правил устарела (staleDays) → PUB_APPROVAL_STALE rules_stale', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const d = await draftVersion(ed, w, ids);
    const v = await submitVersion(ed, w, ids.contentId, d);
    await humanQaPass(po, w, v.id);
    // Срок свежести 1 день и проверка 3 дня назад (через снимок нельзя —
    // checkedAt неизменен): параметр продукта решением владельца.
    await approveParams(
      s.prisma,
      { accountId: w.acc.accountId, ownerMemberId: w.acc.owner.memberId },
      w.product.id,
      { reddit_rules_stale_days: { days: 1 } },
    );
    // checkedAt снимка неизменен (append-only) — проверку «трёхдневной
    // давности» имитируем в обход триггеров (тест).
    await s.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL session_replication_role = replica`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "sites"."pub_reddit_rule_snapshots" SET "checkedAt" = now() - interval '3 days' WHERE "id" = $1`,
        ids.snapshotId,
      );
    });
    const r = await po.post(`${C}/versions/${v.id}/approve`, {
      versionHash: v.hash,
      acknowledgedWarnings: [],
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: 'PUB_APPROVAL_STALE',
      details: { reason: 'rules_stale' },
    });
    await approveParams(
      s.prisma,
      { accountId: w.acc.accountId, ownerMemberId: w.acc.owner.memberId },
      w.product.id,
      { reddit_rules_stale_days: { days: 30 } },
    );
  });

  it('[AT-RD-04] новый снимок правил после согласования: согласование неопубликованной версии → superseded (каскад stale_check), задача на версию', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const v = await approvedVersion(ed, po, w, ids);
    const before = await s.prisma.pubApproval.findFirstOrThrow({
      where: { objectId: v.id },
    });
    expect(before.status).toBe('active');
    ok(
      await ed.post(
        `${w.P}/communities/${ids.communityId}/rules`,
        rulesBody(ids.name, 'restricted'),
      ),
      201,
    );
    const after = await s.prisma.pubApproval.findFirstOrThrow({
      where: { id: before.id },
    });
    expect(after).toMatchObject({
      status: 'superseded',
      reason: 'stale_check',
    });
    const tasks = await s.prisma.pubReviewTask.count({
      where: { objectType: 'content_version', objectId: v.id, status: 'open' },
    });
    expect(tasks).toBe(1);
  });

  describe('раунд исправлений M2 (аудит S2-1, S3-5, S3-11: MB, MC; Р-RD-66)', () => {
    it('T2 / S2-1: правка брифа после заморозки — согласование 409 PUB_BRIEF_NOT_READY; после ready проверка берёт affiliation ВЕРСИИ (founder) — отзыв остаётся BLOCK', async () => {
      const ids = await seedStudio(s, w, ed, po);
      const d = await draftVersion(ed, w, ids, {
        body: versionBody(
          "I've been using Demo for a year and it worked great for me.",
        ),
      });
      const v = await submitVersion(ed, w, ids.contentId, d);
      await humanQaPass(po, w, v.id);
      const b = await s.prisma.pubRedditBrief.findUniqueOrThrow({
        where: { id: ids.briefId },
      });
      const p1 = ok<{ revision: number; status: string }>(
        await ed.patch(`${w.P}/briefs/${b.id}`, {
          affiliation: 'customer',
          expectedRevision: b.revision,
        }),
        200,
      );
      expect(p1.status).toBe('draft');
      const r1 = await po.post(`${C}/versions/${v.id}/approve`, {
        versionHash: v.hash,
        acknowledgedWarnings: await warningCodes(po, w, v.id),
      });
      expect(r1.status).toBe(409);
      expect(r1.body.error).toMatchObject({
        code: 'PUB_BRIEF_NOT_READY',
        details: { missing: ['brief_ready'] },
      });
      ok(
        await ed.post(`${w.P}/briefs/${b.id}/ready`, {
          expectedRevision: p1.revision,
        }),
        200,
      );
      const r2 = await po.post(`${C}/versions/${v.id}/approve`, {
        versionHash: v.hash,
        acknowledgedWarnings: await warningCodes(po, w, v.id),
      });
      expect(r2.status).toBe(409);
      expect(r2.body.error.details.blockers).toEqual([
        {
          code: 'reddit_policy_block',
          codes: expect.arrayContaining(['reddit_fake_testimonial']),
        },
      ]);
      expect(
        await s.prisma.pubApproval.count({ where: { objectId: v.id } }),
      ).toBe(0);
    });

    it('S3-5: заморозка при брифе без affiliation — 409 PUB_BRIEF_NOT_READY (не ошибка базы)', async () => {
      const ids = await seedStudio(s, w, ed, po);
      const d = await draftVersion(ed, w, ids);
      const b = await s.prisma.pubRedditBrief.findUniqueOrThrow({
        where: { id: ids.briefId },
      });
      ok(
        await ed.patch(`${w.P}/briefs/${b.id}`, {
          affiliation: null,
          expectedRevision: b.revision,
        }),
        200,
      );
      const r = await ed.post(
        `${C}/contents/${ids.contentId}/versions/${d.id}/submit`,
        { expectedRevision: d.revision },
      );
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({
        code: 'PUB_BRIEF_NOT_READY',
        details: { missing: ['brief_ready', 'affiliation'] },
      });
    });

    it('MB: лишний код в acknowledgedWarnings — тоже 409 (подтверждение ровно с обеих сторон)', async () => {
      const ids = await seedStudio(s, w, ed, po, { linksAllowed: true });
      const d = await draftVersion(ed, w, ids, {
        body: versionBody('Details are in the docs at docs.example.com/guide'),
      });
      const v = await submitVersion(ed, w, ids.contentId, d);
      await humanQaPass(po, w, v.id);
      const codes = await warningCodes(po, w, v.id);
      const r = await po.post(`${C}/versions/${v.id}/approve`, {
        versionHash: v.hash,
        acknowledgedWarnings: [...codes, 'reddit_offensive'],
      });
      expect(r.status).toBe(409);
      expect(r.body.error.details).toMatchObject({
        reason: 'warnings_not_acknowledged',
      });
    });

    it('MC: acknowledgedWarnings у не-Reddit материала → 400 not_allowed', async () => {
      const w2 = await redditWorld(s, 'working');
      const k = new Kit(s as unknown as ContentStack, w2.acc, w2.product);
      const offerId = (await k.offer()).id;
      const source = await k.source();
      const q = await k.question({ text: 'Питання для статті' });
      const question = await k.selectQuestion(q, 1, source.id);
      const brief = await k.briefReady(
        await k.brief({
          questionId: question.id,
          goal: 'Пояснити вибір',
          format: 'choice_guide',
          ownContribution: 'Власний досвід запусків',
          cta: 'Обговорити задачу',
          ctaIntentNote: 'Читач уже порівнює варіанти — доречна розмова',
          sourceIds: [source.id],
        }),
      );
      const content = await k.content({
        kind: 'article',
        briefId: brief.id,
        slug: testSlug('art'),
      });
      const claim = await k.claimSource(
        (
          await k.claim({
            statement: 'Вартість пілоту 10 000 грн',
            type: 'fact',
            risk: 'normal',
          })
        ).id,
        source.id,
        'yes',
      );
      const v = await k.submit(
        await k.version(content.id, {
          title: 'Як обрати агенцію',
          body: 'Короткий текст.',
          meta: {
            description: 'Опис',
            shortAnswer: 'Коротко',
            cta: 'Обговорити задачу',
            editor: 'Редакторка',
          },
          sourceIds: [source.id],
          claimIds: [claim.id],
          offerVersionId: offerId,
        }),
      );
      const owner = api(s, w2.acc.accountId, w2.acc.owner);
      const r = await owner.post(
        `/publisher/products/${w2.product.id}/versions/${v.id}/approve`,
        { versionHash: v.hash, acknowledgedWarnings: ['reddit_duplicate'] },
      );
      expect(r.status).toBe(400);
      expect(r.body.error.details.fields).toEqual([
        { field: 'acknowledgedWarnings', code: 'not_allowed' },
      ]);
      // раунд 4 (S3-10): у статьи признака студии Reddit нет
      const art = ok<Record<string, unknown>>(
        await owner.get(
          `/publisher/products/${w2.product.id}/contents/${content.id}`,
        ),
        200,
      );
      expect('redditStudio' in art).toBe(false);
    });
  });

  describe('раунд 4 (аудит экранов S2-1, S3-4; Р-RD-86)', () => {
    it('WARN появился между проверкой и «Погодити» (дубль) → 409 с полным составом {code, params} и id СОХРАНЁННОЙ свежей проверки; повтор с её кодами → 201', async () => {
      const w2 = await redditWorld(s);
      const ed2 = api(s, w2.acc.accountId, w2.team.editor);
      const po2 = api(s, w2.acc.accountId, w2.team.product_owner);
      const C2 = contentPath(w2);
      const a = await seedStudio(s, w2, ed2, po2);
      const d = await draftVersion(ed2, w2, a, {
        meta: {
          disclosure: DISCLOSURE,
          claimMap: [
            { text: 'Ask the author', sourceIds: 'needs_verification' },
          ],
          uncertainties: [],
        },
      });
      const v = await submitVersion(ed2, w2, a.contentId, d);
      await humanQaPass(po2, w2, v.id);
      const before = await warningCodes(po2, w2, v.id);
      expect(before).toEqual(['reddit_claim_needs_verification']);
      const policyRows = () =>
        s.prisma.pubQaCheck.count({
          where: { versionId: v.id, kind: 'reddit_policy' },
        });
      const rowsBefore = await policyRows();
      // Второй материал с тем же текстом появился после проверки — дубль.
      const b = await seedStudio(s, w2, ed2, po2);
      await draftVersion(ed2, w2, b);
      const r = await po2.post(`${C2}/versions/${v.id}/approve`, {
        versionHash: v.hash,
        acknowledgedWarnings: before,
      });
      expect(r.status).toBe(409);
      const det = r.body.error.details;
      expect(det).toEqual({
        reason: 'warnings_not_acknowledged',
        codes: ['reddit_claim_needs_verification', 'reddit_duplicate'],
        warnings: [
          { code: 'reddit_claim_needs_verification', params: { claims: [0] } },
          { code: 'reddit_duplicate', params: {} },
        ],
        policyCheckId: expect.any(String),
      });
      // свежая проверка сохранена и стала последней проверкой версии
      expect(await policyRows()).toBe(rowsBefore + 1);
      const kept = await s.prisma.pubQaCheck.findUniqueOrThrow({
        where: { id: det.policyCheckId },
      });
      expect(kept).toMatchObject({
        versionId: v.id,
        kind: 'reddit_policy',
        checkedBy: 'system:reddit-policy',
      });
      expect(await warningCodes(po2, w2, v.id)).toEqual(det.codes);
      expect(
        await s.prisma.pubApproval.count({ where: { objectId: v.id } }),
      ).toBe(0);
      // находки — машиночитаемые: текст = код, без украинского и needs_verification
      const qa = ok<{
        items: Array<{
          id: string;
          warnings: Array<{ code: string; text: string; params: unknown }>;
        }>;
      }>(await po2.get(`${C2}/versions/${v.id}/qa-checks`), 200);
      const last = qa.items.find((q) => q.id === det.policyCheckId)!;
      expect(last.warnings.map((x) => x.text)).toEqual(det.codes);
      const good = await po2.post(`${C2}/versions/${v.id}/approve`, {
        versionHash: v.hash,
        acknowledgedWarnings: det.codes,
      });
      expect(good.status).toBe(201);
    });

    it('S3-10: вид Reddit-материала в общем API — redditStudio: true (общий экран прячет общие действия); у статьи признака нет (тест MC)', async () => {
      const ids = await seedStudio(s, w, ed, po);
      const m = ok<{ kind: string; redditStudio?: true }>(
        await po.get(`${C}/contents/${ids.contentId}`),
        200,
      );
      expect(m).toMatchObject({ kind: 'reddit_comment', redditStudio: true });
    });
  });
});
