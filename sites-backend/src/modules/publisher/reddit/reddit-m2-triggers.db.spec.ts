/**
 * P-R M2 — db-проверки миграции `…_publisher_reddit_m2` (reddit-manual-mvp-
 * adapted.md §M2.8 «db»; Р-RD-48): виды материала Reddit и `redditBriefId`,
 * гвард брифа (A13, ready), `reddit_policy` и `warnings` в QA, серверная
 * meta замороженной Reddit-версии, `reportKind` публикаций (VERIFIED у
 * `user_reported` не бывает), путь ретенции выдержки, размер набора eval
 * (N задач) и ключи параметров. Всё — 23514 мимо сервисов.
 */
import { randomUUID } from 'crypto';
import { seedApprovedArticle } from '../ai/testing/ai-kit.testing';
import { sha256Hex } from '../core/content-hash';
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import {
  api,
  approvedVersion,
  draftVersion,
  ok,
  openRedditPublish,
  redditStack,
  redditWorld,
  seedStudio,
  submitVersion,
  type Api,
  type RedditStack,
  type RedditWorld,
  type StudioIds,
} from './testing/reddit-kit.testing';

jest.setTimeout(180_000);

const CHK = /23514|pub_/;

ciDescribe('P-R M2 db: триггеры миграции M2', () => {
  let s: RedditStack;
  let w: RedditWorld;
  let ed: Api;
  let po: Api;
  let ids: StudioIds;
  beforeAll(async () => {
    s = await redditStack();
    w = await redditWorld(s);
    ed = api(s, w.acc.accountId, w.team.editor);
    po = api(s, w.acc.accountId, w.team.product_owner);
    ids = await seedStudio(s, w, ed, po);
  });
  afterAll(async () => {
    await s?.close();
  });

  const base = () => ({ accountId: w.acc.accountId, productId: w.product.id });

  it('pub_contents: Reddit-вид требует redditBriefId (без briefId/родителя/slug), вид = contentType брифа; redditBriefId неизменен и запрещён прочим', async () => {
    const brief = await s.prisma.pubRedditBrief.findUniqueOrThrow({
      where: { id: ids.briefId },
    });
    await expect(
      s.prisma.pubContent.create({
        data: {
          ...base(),
          kind: 'reddit_comment',
          status: 'brief',
          createdBy: 'system:test',
        },
      }),
    ).rejects.toThrow(/redditBriefId: обязателен/);
    await expect(
      s.prisma.pubContent.create({
        data: {
          ...base(),
          kind: 'reddit_post',
          redditBriefId: brief.id,
          status: 'brief',
          createdBy: 'system:test',
        },
      }),
    ).rejects.toThrow(/вид Reddit-материала = contentType брифа/);
    await expect(
      s.prisma.pubContent.create({
        data: {
          ...base(),
          kind: 'reddit_comment',
          redditBriefId: brief.id,
          slug: 'some-slug',
          status: 'brief',
          createdBy: 'system:test',
        },
      }),
    ).rejects.toThrow(/slug: только у article/);
    const other = await seedStudio(s, w, ed, po);
    await expect(
      s.prisma.pubContent.update({
        where: { id: ids.contentId },
        data: { redditBriefId: other.briefId },
      }),
    ).rejects.toThrow(/redditBriefId неизменны/);
  });

  it('pub_reddit_briefs: comment без возможности/контекста, контакт, сообщество другого проекта, ready без affiliation/с одним тезисом/тезисом-доказательством P-R, неизменные поля', async () => {
    const brief = await s.prisma.pubRedditBrief.findUniqueOrThrow({
      where: { id: ids.briefId },
    });
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      revision: _r,
      ...row
    } = brief;
    const create = (over: Record<string, unknown>) =>
      s.prisma.pubRedditBrief.create({
        data: { ...row, status: 'draft', ...over } as never,
      });
    await expect(create({ context: '  ' })).rejects.toThrow(
      /comment требует opportunityId и непустой context/,
    );
    await expect(create({ opportunityId: null })).rejects.toThrow(CHK);
    await expect(
      create({ objective: 'Call +380 67 123 45 67' }),
    ).rejects.toThrow(/похоже на контакт/);
    await expect(
      create({ keyPoints: [{ text: 'x', sourceIds: 'maybe' }] }),
    ).rejects.toThrow(/keyPoints/);
    await expect(
      create({ status: 'ready', affiliation: null }),
    ).rejects.toThrow(/ready требует affiliation/);
    // Р-RD-65: бренд для раскрытия — у аффилированного автора.
    await expect(create({ status: 'ready', brand: null })).rejects.toThrow(
      /ready требует brand/,
    );
    await expect(create({ brand: 'Call +380 67 123 45 67' })).rejects.toThrow(
      /похоже на контакт/,
    );
    await expect(
      create({
        status: 'ready',
        keyPoints: [(brief.keyPoints as unknown[])[0]],
      }),
    ).rejects.toThrow(/ready требует 2..5 тезисов/);
    const opp = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
      where: { id: ids.opportunityId! },
    });
    await expect(
      create({
        status: 'ready',
        keyPoints: [
          { text: 'a', sourceIds: [opp.excerptSourceId] },
          { text: 'b', sourceIds: 'needs_verification' },
        ],
      }),
    ).rejects.toThrow(/разрешённый источник или needs_verification/);
    const other = await seedStudio(s, w, ed, po, { contentType: 'post' });
    await expect(
      create({
        contentType: 'post',
        opportunityId: null,
        communityId: other.communityId,
      }),
    ).rejects.toThrow(/сообщество другого проекта/);
    await expect(
      s.prisma.pubRedditBrief.update({
        where: { id: brief.id },
        data: { contentType: 'post' },
      }),
    ).rejects.toThrow(CHK);
  });

  it('pub_qa_checks: reddit_policy — только system:reddit-policy, fail ⇔ блокеры, только Reddit-версии; warnings — только у reddit_policy', async () => {
    const d = await draftVersion(ed, w, ids);
    const v = await submitVersion(ed, w, ids.contentId, d);
    const qa = (over: Record<string, unknown>) =>
      s.prisma.pubQaCheck.create({
        data: {
          ...base(),
          versionId: v.id,
          kind: 'reddit_policy',
          result: 'pass',
          blockers: [],
          warnings: [],
          checkedBy: 'system:reddit-policy',
          createdBy: 'system:reddit-policy',
          ...over,
        } as never,
      });
    await expect(
      qa({ checkedBy: `member:${w.team.editor.memberId}` }),
    ).rejects.toThrow(/reddit_policy — system:reddit-policy/);
    await expect(qa({ result: 'fail' })).rejects.toThrow(
      /pass без блокеров или fail с блокерами/,
    );
    await expect(
      qa({ result: 'pass', blockers: [{ code: 'reddit_pii', text: 'x' }] }),
    ).rejects.toThrow(/pass без блокеров/);
    await expect(
      qa({
        kind: 'editorial',
        checkedBy: `member:${w.team.editor.memberId}`,
        warnings: [{ code: 'x', text: 'y' }],
      }),
    ).rejects.toThrow(/warnings: массив ≤ 64 КБ, только у reddit_policy/);
    const ok1 = await qa({
      warnings: [{ code: 'reddit_duplicate', text: 't' }],
    });
    expect(ok1.kind).toBe('reddit_policy');
    const src = await s.prisma.pubSource.findFirstOrThrow({
      where: { productId: w.product.id, origin: 'content' },
    });
    const art = await seedApprovedArticle(
      s.prisma,
      { id: w.product.id, accountId: w.acc.accountId },
      [src.id],
      w.team.editor.memberId,
    );
    await expect(qa({ versionId: art.versionId })).rejects.toThrow(
      /только версия Reddit-материала/,
    );
  });

  it('замороженная Reddit-версия несёт affiliation и ruleSnapshotId (снимок этого продукта); после заморозки meta неизменна', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const d = await draftVersion(ed, w, ids);
    const v = await submitVersion(ed, w, ids.contentId, d);
    const row = await s.prisma.pubContentVersion.findUniqueOrThrow({
      where: { id: v.id },
    });
    expect(row.meta).toMatchObject({
      affiliation: 'founder',
      ruleSnapshotId: ids.snapshotId,
    });
    await expect(
      s.prisma.pubContentVersion.update({
        where: { id: v.id },
        data: { meta: { ...(row.meta as object), ruleSnapshotId: null } },
      }),
    ).rejects.toThrow(/после frozenAt содержимое неизменно/);
    // Черновик без серверной meta заморозить в обход сервиса нельзя.
    const d2 = await s.prisma.pubContentVersion.create({
      data: {
        ...base(),
        contentId: ids.contentId,
        number: 99,
        title: row.title,
        body: row.body,
        meta: { disclosure: 'x' },
        format: 'reddit_comment',
        offerVersionId: row.offerVersionId,
        authorMemberId: row.authorMemberId,
        status: 'draft',
        createdBy: 'system:test',
      },
    });
    await expect(
      s.prisma.pubContentVersion.update({
        where: { id: d2.id },
        data: {
          frozenAt: new Date(),
          hash: sha256Hex('x'),
          status: 'submitted',
        },
      }),
    ).rejects.toThrow(
      /замороженная Reddit-версия — affiliation и ruleSnapshotId/,
    );
  });

  it('pub_publications: Reddit — только user_reported; у user_reported нет проверки (VERIFIED не бывает); reportKind неизменен', async () => {
    await openRedditPublish(s.prisma, w);
    const st = await seedStudio(s, w, ed, po);
    await approvedVersion(ed, po, w, st);
    const op = api(s, w.acc.accountId, w.team.operator);
    ok(await op.post(`${w.P}/contents/${st.contentId}/copy`), 200);
    const opp = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
      where: { id: st.opportunityId! },
    });
    const r = ok<{ id: string }>(
      await op.post(`${w.P}/contents/${st.contentId}/report-publication`, {
        url: `https://www.reddit.com/r/${st.name}/comments/${opp.threadKey}/x/kdb01/`,
        postedAt: new Date().toISOString(),
      }),
      201,
    );
    const pub = await s.prisma.pubPublication.findUniqueOrThrow({
      where: { id: r.id },
    });
    expect(pub).toMatchObject({
      reportKind: 'user_reported',
      verifyStatus: 'not_checked',
    });
    await expect(
      s.prisma.pubPublication.update({
        where: { id: pub.id },
        data: {
          verifyStatus: 'ok',
          lastVerifiedAt: new Date(),
          verifiedBy: 'system:x',
        },
      }),
    ).rejects.toThrow(/user_reported — без проверки/);
    await expect(
      s.prisma.pubPublication.update({
        where: { id: pub.id },
        data: { reportKind: 'standard' },
      }),
    ).rejects.toThrow(/reportKind: неизменен/);
    const { id: _i, createdAt: _c, updatedAt: _u, revision: _r, ...copy } = pub;
    await expect(
      s.prisma.pubPublication.create({
        data: {
          ...copy,
          reportKind: 'standard',
          finalUrl: `${pub.finalUrl}/x`,
          opKey: randomUUID(),
        },
      }),
    ).rejects.toThrow(/Reddit-материал — только отчётом user_reported/);
    await expect(
      s.prisma.pubPublication.create({
        data: {
          ...copy,
          status: 'pending',
          finalUrl: `${pub.finalUrl}/y`,
          opKey: randomUUID(),
        },
      }),
    ).rejects.toThrow(/только опубликованная/);
  });

  it('выдержка P-R: только плейсхолдер ретенции и только с новым contentHash; правила (url) — нет', async () => {
    const opp = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
      where: { id: ids.opportunityId! },
    });
    const src = await s.prisma.pubSource.findUniqueOrThrow({
      where: { id: opp.excerptSourceId! },
    });
    await expect(
      s.prisma.pubSource.update({
        where: { id: src.id },
        data: { fragment: '[видалено за терміном зберігання]' },
      }),
    ).rejects.toThrow(/ретенция выдержки P-R — новый contentHash/);
    const snap = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
      where: { id: ids.snapshotId! },
    });
    await expect(
      s.prisma.pubSource.update({
        where: { id: snap.sourceId },
        data: {
          fragment: '[видалено за терміном зберігання]',
          contentHash: sha256Hex('z'),
        },
      }),
    ).rejects.toThrow(/доказательство P-R неизменно/);
  });

  it('eval: размер набора по версии (2.2 → 30, 2.3 → 42); коды задач AI-01…AI-42, схема reddit; ключи параметров и этап reddit_publish', async () => {
    const [r] = await s.prisma.$queryRaw<
      Array<{ a: number; b: number; c: number | null }>
    >`
      SELECT "sites"."pub_eval_set_size"('2.2') AS a, "sites"."pub_eval_set_size"('2.3') AS b,
             "sites"."pub_eval_set_size"('9.9') AS c`;
    expect(r).toEqual({ a: 30, b: 42, c: null });
    const [k] = await s.prisma.$queryRaw<
      Array<{ keys: string[]; gens: string[] }>
    >`
      SELECT "sites"."pub_parameter_keys"() AS keys, "sites"."pub_generators"() AS gens`;
    expect(k.keys).toContain('reddit_excerpt_retention_days');
    expect(k.keys).toHaveLength(40);
    expect(k.gens).toContain('pub.reddit.draft');
    const p = await s.prisma.pubParameter.findFirstOrThrow({
      where: { productId: w.product.id, key: 'reddit_excerpt_retention_days' },
    });
    expect(p).toMatchObject({ value: { days: 180 }, status: 'assumption' });
    await expect(
      s.prisma.pubParameterDecision.create({
        data: {
          ...base(),
          parameterKey: 'reddit_excerpt_retention_days',
          version: p.version + 1,
          fromStatus: p.status,
          toStatus: 'approved',
          valueSnapshot: { days: 90 },
          decidedBy: `member:${w.acc.owner.memberId}`,
          basis: 'Рішення власника щодо строку',
          dependentStages: ['reddit_publish', 'bogus'],
          createdBy: `member:${w.acc.owner.memberId}`,
        },
      }),
    ).rejects.toThrow(/dependentStages/);
  });
});
