/**
 * [AT-RD-12] [AT-RD-15] P-R M2 — копирование и «Отметить опубликованным»
 * (reddit-manual-mvp-adapted.md §M2.6, §4, §9; Р-RD-9, Р-RD-10):
 *  - копирование: гейт `reddit_publish` (409 PUB_GATE_CLOSED), точный
 *    утверждённый текст (comment — только body), `copyToken`, аудит `copy`,
 *    `approved → scheduled` один раз, повтор — только аудит; OP может, ED —
 *    нет (403); общий переход `schedule` для Reddit — 409;
 *  - отчёт: только скопированный материал, URL → канон, сообщество брифа
 *    (A15: чужое → 400), comment — ссылка на комментарий в треде брифа;
 *    запись `user_reported`, `verifyStatus=not_checked`; `verify` → 409
 *    manual_only (VERIFIED не бывает, A12); стадия по общему правилу:
 *    test-продукт → `test` (материал не меняется), working + live +
 *    `public_publish` → `live` (материал `published`); общий POST
 *    /publications с Reddit-версией → 409 manual_only; повтор URL → 409.
 */
import { randomBytes } from 'crypto';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { approveParams } from '../../modules/publisher/ai/testing/ai-kit.testing';
import {
  DEFAULT_PARAMETER_VALUES,
  GATE_PARAMETER_KEYS,
} from '../../modules/publisher/contracts/parameters';
import {
  approvableValue,
  seedVerifiedHost,
} from '../../modules/publisher/testing/fixtures.testing';
import {
  api,
  approvedVersion,
  contentPath,
  draftVersion,
  ok,
  openRedditPublish,
  redditStack,
  redditWorld,
  seedStudio,
  type Api,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(300_000);

interface Copy {
  contentType: string;
  title: string | null;
  body: string;
  copyToken: string;
  scheduled: boolean;
  openUrl: string;
  versionId: string;
  rules: { snapshotId: string; version: number };
}

ciDescribe('P-R M2: копирование и отчёт о ручной публикации', () => {
  let s: RedditStack;
  let w: RedditWorld;
  let ed: Api;
  let po: Api;
  let op: Api;
  let C: string;
  beforeAll(async () => {
    s = await redditStack();
    w = await redditWorld(s);
    ed = api(s, w.acc.accountId, w.team.editor);
    po = api(s, w.acc.accountId, w.team.product_owner);
    op = api(s, w.acc.accountId, w.team.operator);
    C = contentPath(w);
  });
  afterAll(async () => {
    await s?.close();
  });

  it('копирование: гейт reddit_publish закрыт → 409 с недостающими ключами; ED → 403', async () => {
    const ids = await seedStudio(s, w, ed, po);
    await approvedVersion(ed, po, w, ids);
    const closed = await op.post(`${w.P}/contents/${ids.contentId}/copy`);
    expect(closed.status).toBe(409);
    expect(closed.body.error).toMatchObject({
      code: 'PUB_GATE_CLOSED',
      details: { gate: 'reddit_publish' },
    });
    const keys = closed.body.error.details.missing.map(
      (m: { key: string }) => m.key,
    );
    expect(keys).toEqual(
      expect.arrayContaining(['niche', 'language', 'market', 'responsibles']),
    );
    const denied = await ed.post(`${w.P}/contents/${ids.contentId}/copy`);
    expect(denied.status).toBe(403);
  });

  it('[AT-RD-12] копирование: точный текст comment (только body), copyToken, аудит copy, approved → scheduled один раз; повтор — только аудит', async () => {
    await openRedditPublish(s.prisma, w);
    const ids = await seedStudio(s, w, ed, po);
    const v = await approvedVersion(ed, po, w, ids);
    const version = await s.prisma.pubContentVersion.findFirstOrThrow({
      where: { id: v.id },
    });
    const c1 = ok<Copy>(
      await op.post(`${w.P}/contents/${ids.contentId}/copy`),
      200,
    );
    expect(c1).toMatchObject({
      contentType: 'comment',
      title: null,
      body: version.body,
      scheduled: true,
      versionId: v.id,
      rules: { snapshotId: ids.snapshotId, version: 1 },
    });
    expect(c1.copyToken).toMatch(/^[0-9a-f]{64}$/);
    expect(c1.openUrl).toMatch(
      new RegExp(`^https://www\\.reddit\\.com/r/${ids.name}/comments/`),
    );
    const content = await s.prisma.pubContent.findFirstOrThrow({
      where: { id: ids.contentId },
    });
    expect(content.status).toBe('scheduled');
    const c2 = ok<Copy>(
      await po.post(`${w.P}/contents/${ids.contentId}/copy`),
      200,
    );
    expect(c2.scheduled).toBe(false);
    expect(c2.copyToken).not.toBe(c1.copyToken);
    const copies = await s.prisma.pubAuditEvent.findMany({
      where: { objectType: 'content', objectId: ids.contentId, action: 'copy' },
    });
    expect(copies).toHaveLength(2);
    expect(
      copies.map((a) => (a.meta as { copyHash: string }).copyHash).sort(),
    ).toEqual([c1.copyToken, c2.copyToken].sort());
    const sched = await s.prisma.pubAuditEvent.count({
      where: {
        objectType: 'content',
        objectId: ids.contentId,
        action: 'transition',
        toStatus: 'scheduled',
      },
    });
    expect(sched).toBe(1);
    // Перед копированием — свежая reddit_policy (2 при согласовании/заморозке + 2 копии).
    expect(
      await s.prisma.pubQaCheck.count({
        where: { versionId: v.id, kind: 'reddit_policy' },
      }),
    ).toBe(4);
    // Материал Reddit через общий переход schedule не планируется.
    const m = ok<{ content: { revision: number } }>(
      await po.get(`${w.P}/contents/${ids.contentId}`),
      200,
    );
    const back = await po.post(`${C}/contents/${ids.contentId}/transition`, {
      expectedRevision: m.content.revision,
      to: 'approved',
      reason: 'unschedule для теста',
    });
    expect(back.status).toBe(200);
    const sch = await po.post(`${C}/contents/${ids.contentId}/transition`, {
      expectedRevision: m.content.revision + 1,
      to: 'scheduled',
    });
    expect(sch.status).toBe(409);
    expect(sch.body.error.details.hint).toBe('use_dedicated_action:copy');
  });

  it('[AT-RD-12] [AT-RD-15] отчёт: до копирования 409; URL чужого сообщества → 400; comment без id комментария / другой тред → 400; канон; user_reported, stage test, материал не меняется', async () => {
    await openRedditPublish(s.prisma, w);
    const ids = await seedStudio(s, w, ed, po);
    await approvedVersion(ed, po, w, ids);
    const opp = await s.prisma.pubRedditOpportunity.findFirstOrThrow({
      where: { id: ids.opportunityId! },
    });
    const commentUrl = `https://old.reddit.com/r/${ids.name}/comments/${opp.threadKey}/some_slug/k3x9z/?context=3#c`;
    const early = await op.post(
      `${w.P}/contents/${ids.contentId}/report-publication`,
      { url: commentUrl, postedAt: new Date().toISOString() },
    );
    expect(early.status).toBe(409);
    expect(early.body.error.details.reason).toBe('not_copied');
    ok(await op.post(`${w.P}/contents/${ids.contentId}/copy`), 200);
    const bad = async (url: string, code: string) => {
      const r = await op.post(
        `${w.P}/contents/${ids.contentId}/report-publication`,
        { url, postedAt: new Date().toISOString() },
      );
      expect({
        url,
        status: r.status,
        fields: r.body.error?.details?.fields,
      }).toEqual({
        url,
        status: 400,
        fields: [{ field: 'url', code }],
      });
    };
    await bad(
      `https://www.reddit.com/r/othersub/comments/${opp.threadKey}/x/k3x9z`,
      'community_mismatch',
    );
    await bad(
      `https://www.reddit.com/r/${ids.name}/comments/${opp.threadKey}/x`,
      'comment_required',
    );
    await bad(
      `https://www.reddit.com/r/${ids.name}/comments/zzz999/x/k3x9z`,
      'thread_mismatch',
    );
    await bad(`https://redd.it/${opp.threadKey}`, 'format');
    await bad(
      `http://www.reddit.com/r/${ids.name}/comments/${opp.threadKey}/x/k3x9z`,
      'format',
    );
    await bad(
      `https://www.reddit.com/r/u_someone/comments/${opp.threadKey}/x/k3x9z`,
      'profile_ref',
    );
    const future = await op.post(
      `${w.P}/contents/${ids.contentId}/report-publication`,
      {
        url: commentUrl,
        postedAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    );
    expect(future.body.error.details.fields).toEqual([
      { field: 'postedAt', code: 'future' },
    ]);
    // раунд 4 (аудит экранов S3-5): дата раньше создания материала → 400
    const ancient = await op.post(
      `${w.P}/contents/${ids.contentId}/report-publication`,
      { url: commentUrl, postedAt: '1999-01-01T10:00:00.000Z' },
    );
    expect(ancient.status).toBe(400);
    expect(ancient.body.error.details.fields).toEqual([
      { field: 'postedAt', code: 'before_material' },
    ]);
    const postedAt = new Date(Date.now() - 60_000).toISOString();
    const r = ok<Record<string, unknown>>(
      await op.post(`${w.P}/contents/${ids.contentId}/report-publication`, {
        url: commentUrl,
        postedAt,
        notes: 'Опубліковано вручну',
      }),
      201,
    );
    expect(r).toMatchObject({
      finalUrl: `https://www.reddit.com/r/${ids.name}/comments/${opp.threadKey}/comment/k3x9z`,
      status: 'published',
      reportKind: 'user_reported',
      verifyStatus: 'not_checked',
      stage: 'test',
      contentId: ids.contentId,
      communityId: ids.communityId,
      subreddit: ids.name,
      publishedAt: postedAt,
    });
    const audit = await s.prisma.pubAuditEvent.findFirstOrThrow({
      where: { objectId: r.id as string, action: 'report_publication' },
    });
    expect(audit).toMatchObject({ reason: 'Опубліковано вручну' });
    // ДТ-1: тестовая стадия не переводит материал в published.
    const content = await s.prisma.pubContent.findFirstOrThrow({
      where: { id: ids.contentId },
    });
    expect(content.status).toBe('scheduled');
    // Повтор того же URL — 409; verify — 409 manual_only; VERIFIED не бывает.
    const dup = await op.post(
      `${w.P}/contents/${ids.contentId}/report-publication`,
      { url: commentUrl, postedAt },
    );
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.reason).toBe('already_published');
    const verify = await op.post(`${C}/publications/${r.id}/verify`, {
      expectedRevision: r.revision,
      result: 'ok',
    });
    expect(verify.status).toBe(409);
    expect(verify.body.error).toMatchObject({
      code: 'PUB_TRANSITION_INVALID',
      details: { reason: 'manual_only' },
    });
    await expect(
      s.prisma.pubPublication.update({
        where: { id: r.id as string },
        data: { verifyStatus: 'ok' },
      }),
    ).rejects.toThrow(/user_reported — без проверки/);
    // Общий маршрут публикаций для Reddit-версии закрыт.
    const general = await op.post(`${C}/publications`, {
      versionId: (r as { versionId: string }).versionId,
      channelId: (
        await s.prisma.pubRedditCommunity.findFirstOrThrow({
          where: { id: ids.communityId },
        })
      ).channelId,
      finalUrl: `https://www.reddit.com/r/${ids.name}/comments/${opp.threadKey}/comment/abc12`,
    });
    expect(general.status).toBe(409);
    expect(general.body.error.details.reason).toBe('manual_only');
    // Список публикаций раздела.
    const list = ok<{ items: Array<{ id: string }> }>(
      await po.get(`${w.P}/publications`, { contentId: ids.contentId }),
      200,
    );
    expect(list.items.map((x) => x.id)).toEqual([r.id]);
    const csv = await po.get(`${w.P}/publications`, { format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toBe(
      'id,contentId,versionId,subreddit,finalUrl,stage,status,reportKind,verifyStatus,publishedAt',
    );
  });

  it('post: копия с заголовком; отчёт ссылкой на пост (без id комментария), ссылка на комментарий → 400 format', async () => {
    await openRedditPublish(s.prisma, w);
    const ids = await seedStudio(s, w, ed, po, { contentType: 'post' });
    await approvedVersion(ed, po, w, ids, {
      body: { title: 'One article, several formats: a simple plan' },
    });
    const c = ok<Copy>(
      await op.post(`${w.P}/contents/${ids.contentId}/copy`),
      200,
    );
    expect(c).toMatchObject({
      contentType: 'post',
      title: 'One article, several formats: a simple plan',
      openUrl: `https://www.reddit.com/r/${ids.name}`,
    });
    const asComment = await op.post(
      `${w.P}/contents/${ids.contentId}/report-publication`,
      {
        url: `https://www.reddit.com/r/${ids.name}/comments/p0st1/one_article/k3x9z`,
        postedAt: new Date().toISOString(),
      },
    );
    expect(asComment.body.error.details.fields).toEqual([
      { field: 'url', code: 'format' },
    ]);
    const r = ok<{ finalUrl: string }>(
      await op.post(`${w.P}/contents/${ids.contentId}/report-publication`, {
        url: `https://new.reddit.com/r/${ids.name.toUpperCase()}/comments/P0ST1/One_Article/?utm_source=share`,
        postedAt: new Date().toISOString(),
      }),
      201,
    );
    expect(r.finalUrl).toBe(
      `https://www.reddit.com/r/${ids.name}/comments/p0st1/one_article`,
    );
  });

  it('стадия по общему правилу: working + live + public_publish → live, материал published; working + live без public_publish → test', async () => {
    const ws = await redditWorld(s, 'working');
    const ed2 = api(s, ws.acc.accountId, ws.team.editor);
    const po2 = api(s, ws.acc.accountId, ws.team.product_owner);
    const op2 = api(s, ws.acc.accountId, ws.team.operator);
    await openRedditPublish(s.prisma, ws);
    await s.prisma.$executeRaw`
      UPDATE "sites"."pub_products" SET "mode" = 'live', "liveSince" = now()
       WHERE "id" = ${ws.product.id}`;
    const flow = async () => {
      const ids = await seedStudio(s, ws, ed2, po2);
      await approvedVersion(ed2, po2, ws, ids);
      ok(await op2.post(`${ws.P}/contents/${ids.contentId}/copy`), 200);
      const opp = await s.prisma.pubRedditOpportunity.findFirstOrThrow({
        where: { id: ids.opportunityId! },
      });
      const r = ok<{ stage: string }>(
        await op2.post(`${ws.P}/contents/${ids.contentId}/report-publication`, {
          url: `https://www.reddit.com/r/${ids.name}/comments/${opp.threadKey}/x/c0mm1`,
          postedAt: new Date().toISOString(),
        }),
        201,
      );
      const content = await s.prisma.pubContent.findFirstOrThrow({
        where: { id: ids.contentId },
      });
      return { stage: r.stage, status: content.status };
    };
    expect(await flow()).toEqual({ stage: 'test', status: 'scheduled' });
    // Открыть public_publish: ключи гейта утверждены, verified-хост.
    const host = `pubr-${randomBytes(4).toString('hex')}.example`;
    await seedVerifiedHost(s.prisma, ws.acc.accountId, ws.acc.siteId, host);
    const values: Record<string, unknown> = {};
    for (const k of GATE_PARAMETER_KEYS.public_publish)
      values[k] =
        k === 'domain_host'
          ? { host }
          : approvableValue(k, DEFAULT_PARAMETER_VALUES[k]);
    await approveParams(
      s.prisma,
      { accountId: ws.acc.accountId, ownerMemberId: ws.acc.owner.memberId },
      ws.product.id,
      values,
    );
    expect(await flow()).toEqual({ stage: 'live', status: 'published' });
  });

  describe('раунд исправлений M2 (аудит S3-3, S3-4, S3-6, MD; Р-RD-66, Р-RD-69)', () => {
    it('S3-3: WARN, появившийся после согласования (дубль), при копировании — 409 warnings_not_acknowledged; подтверждение копирующего — 200 и в аудите', async () => {
      const w2 = await redditWorld(s);
      const ed2 = api(s, w2.acc.accountId, w2.team.editor);
      const po2 = api(s, w2.acc.accountId, w2.team.product_owner);
      const op2 = api(s, w2.acc.accountId, w2.team.operator);
      await openRedditPublish(s.prisma, w2);
      const a = await seedStudio(s, w2, ed2, po2);
      const va = await approvedVersion(ed2, po2, w2, a, { ack: [] });
      // Второй материал с тем же текстом — дубль для первого.
      const b = await seedStudio(s, w2, ed2, po2);
      await draftVersion(ed2, w2, b);
      const r = await op2.post(`${w2.P}/contents/${a.contentId}/copy`);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({
        code: 'PUB_CONFLICT',
        details: {
          reason: 'warnings_not_acknowledged',
          codes: ['reddit_duplicate'],
        },
      });
      const copy = ok<Copy>(
        await op2.post(`${w2.P}/contents/${a.contentId}/copy`, {
          acknowledgedWarnings: ['reddit_duplicate'],
        }),
        200,
      );
      expect(copy.versionId).toBe(va.id);
      const audit = await s.prisma.pubAuditEvent.findFirstOrThrow({
        where: { objectType: 'content', objectId: a.contentId, action: 'copy' },
      });
      expect(audit.meta).toMatchObject({
        acknowledgedWarnings: ['reddit_duplicate'],
      });
      const bad = await op2.post(`${w2.P}/contents/${a.contentId}/copy`, {
        foo: 1,
      });
      expect(bad.status).toBe(400);
    });

    it('MD + S3-4: выдержку отозвали после согласования — проверка при копировании пишет BLOCK (reddit_thread_missing), 409 с кодами и без id откатанной строки', async () => {
      await openRedditPublish(s.prisma, w);
      const ids = await seedStudio(s, w, ed, po);
      const v = await approvedVersion(ed, po, w, ids);
      const opp = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
        where: { id: ids.opportunityId! },
      });
      ok(
        await po.post(
          `/publisher/products/${w.product.id}/sources/${opp.excerptSourceId}/revoke`,
          { reason: 'Автор треду попросив прибрати' },
        ),
        200,
      );
      const before = await s.prisma.pubQaCheck.count({
        where: { versionId: v.id, kind: 'reddit_policy' },
      });
      const r = await op.post(`${w.P}/contents/${ids.contentId}/copy`);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('PUB_BLOCKERS_OPEN');
      const blocker = r.body.error.details.blockers.find(
        (x: { code: string }) => x.code === 'reddit_policy_block',
      );
      expect(blocker).toEqual({
        code: 'reddit_policy_block',
        codes: expect.arrayContaining(['reddit_thread_missing']),
      });
      expect(
        await s.prisma.pubQaCheck.count({
          where: { versionId: v.id, kind: 'reddit_policy' },
        }),
      ).toBe(before);
    });

    it('S3-6 (Р-RD-66): бриф в архиве или черновике — копирование 409 PUB_BRIEF_NOT_READY', async () => {
      await openRedditPublish(s.prisma, w);
      const ids = await seedStudio(s, w, ed, po);
      await approvedVersion(ed, po, w, ids);
      const b = await s.prisma.pubRedditBrief.findUniqueOrThrow({
        where: { id: ids.briefId },
      });
      ok(
        await ed.patch(`${w.P}/briefs/${b.id}`, {
          tone: 'plain',
          expectedRevision: b.revision,
        }),
        200,
      );
      const draft = await op.post(`${w.P}/contents/${ids.contentId}/copy`);
      expect(draft.status).toBe(409);
      expect(draft.body.error).toMatchObject({
        code: 'PUB_BRIEF_NOT_READY',
        details: { missing: ['brief_ready'] },
      });
      const b2 = await s.prisma.pubRedditBrief.findUniqueOrThrow({
        where: { id: ids.briefId },
      });
      ok(
        await ed.post(`${w.P}/briefs/${b2.id}/archive`, {
          expectedRevision: b2.revision,
        }),
        200,
      );
      const arch = await op.post(`${w.P}/contents/${ids.contentId}/copy`);
      expect(arch.status).toBe(409);
      expect(arch.body.error.code).toBe('PUB_BRIEF_NOT_READY');
    });
  });
});
