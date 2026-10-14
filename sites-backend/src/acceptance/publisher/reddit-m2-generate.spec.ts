/**
 * P-R M2 — генерация `pub.reddit.draft` в fake-контуре и E2E-RD-02
 * (reddit-manual-mvp-adapted.md §M2.3, §M2.7, §M2.8; Р-RD-15…17, Р-RD-56).
 * Живая модель — отдельный шлюз после eval 2.3: генератор включается
 * ТОЛЬКО в тесте (`redditAi`), модель — `ScriptedModel` без сети.
 *
 *  - E2E-RD-02 (comment и post): бриф → 3 варианта (fake) → версия из
 *    варианта (`aiCallId` + `variantIndex`) → правка → заморозка → QA →
 *    согласование → копирование → ручной URL (`user_reported`);
 *  - промпт: бриф, тезисы, правила сообщества и тред — в тегах
 *    `trust="untrusted"`; в контексте — только разрешённые источники тезисов;
 *  - отказы до вызова модели: тело (400), бриф не готов (409), гейт правил
 *    (409 policy_block) — строк `pub_ai_calls` не прибавилось;
 *  - «перегенерировать абзац»: `rewrite` — абзац черновика; вне диапазона —
 *    400; идемпотентность по `opKey`;
 *  - ответ против входа (заголовок у комментария) — повтор, затем
 *    `schema_invalid` (422); тайм-аут модели — `reddit-m2-manual.spec.ts`.
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { publisherStandFakeAi } from '../../config/publisher-env';
import {
  AI_PARAMS,
  approveParams,
  openAiMonth,
} from '../../modules/publisher/ai/testing/ai-kit.testing';
import {
  DISCLOSURE,
  api,
  contentPath,
  humanQaPass,
  ok,
  openRedditPublish,
  redditAi,
  redditDraftJson,
  redditStack,
  redditWorld,
  seedStudio,
  submitVersion,
  versionBody,
  warningCodes,
  type Api,
  type RedditAi,
  type RedditStack,
  type RedditWorld,
  type StudioIds,
  type VersionRef,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(240_000);

interface Generated {
  callId: string;
  status: string;
  call: {
    status: string;
    output: {
      variants: Array<{
        title: string | null;
        body: string;
        disclosure: string;
        claim_map: unknown[];
      }>;
    };
    findings: Array<{ code: string; severity: string }>;
    contextSourceIds: string[];
    taskId: string;
  } | null;
}

ciDescribe('P-R M2: генерация pub.reddit.draft (fake) и E2E-RD-02', () => {
  let s: RedditStack;
  let w: RedditWorld;
  let ed: Api;
  let po: Api;
  let op: Api;
  let ai: RedditAi;
  let C: string;
  beforeAll(async () => {
    s = await redditStack();
    w = await redditWorld(s);
    ed = api(s, w.acc.accountId, w.team.editor);
    po = api(s, w.acc.accountId, w.team.product_owner);
    op = api(s, w.acc.accountId, w.team.operator);
    C = contentPath(w);
    ai = await redditAi(s, w);
    await openRedditPublish(s.prisma, w);
  });
  afterAll(async () => {
    ai?.restore();
    await s?.close();
  });
  beforeEach(() => {
    ai.model.queue = [];
    ai.model.fallback = null;
    ai.model.requests = [];
  });

  const calls = () =>
    s.prisma.pubAiCall.count({ where: { productId: w.product.id } });

  async function generate(ids: StudioIds, body: Record<string, unknown> = {}) {
    return ed.post(`${w.P}/briefs/${ids.briefId}/generate`, {
      template: 'helpful_answer',
      ...body,
    });
  }

  /** Версия из варианта ответа (редактор переносит текст и карту). */
  async function versionFrom(
    ids: StudioIds,
    g: Generated,
    variantIndex: number,
  ): Promise<VersionRef> {
    const v = g.call!.output.variants[variantIndex];
    return ok<VersionRef>(
      await ed.post(`${C}/contents/${ids.contentId}/versions`, {
        ...(v.title ? { title: v.title } : {}),
        body: v.body,
        meta: {
          disclosure: v.disclosure,
          claimMap: [
            {
              text: 'One verified article can become a post, cards and a video script',
              sourceIds: [ids.sourceId],
            },
          ],
          uncertainties: [],
        },
        aiCallId: g.callId,
        variantIndex,
      }),
      201,
    );
  }

  for (const type of ['comment', 'post'] as const) {
    it(`E2E-RD-02 (${type}): бриф → 3 варианта (fake) → версия из варианта → правка → QA → согласование → копирование → ручной URL`, async () => {
      const ids = await seedStudio(s, w, ed, po, { contentType: type });
      ai.model.reply(redditDraftJson(3, type, ids.sourceId));
      const g = ok<Generated>(await generate(ids), 200);
      expect(g.status).toBe('ok');
      expect(g.call!.output.variants).toHaveLength(3);
      expect(g.call!.findings).toEqual([]);
      // В контексте — только разрешённый источник тезисов; выдержки треда нет.
      expect(g.call!.contextSourceIds).toEqual([ids.sourceId]);
      const req = ai.model.requests[0];
      expect(req.user).toContain('<community_rules name="r/');
      expect(req.user).toMatch(/trust="untrusted"/);
      // Тред — только у comment.
      expect(req.user.includes('<thread trust="untrusted"')).toBe(
        type === 'comment',
      );
      // Версия из варианта №2: aiCallId сохранён, текст — правка человека.
      const d = await versionFrom(ids, g, 1);
      const row = await s.prisma.pubContentVersion.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(row.aiCallId).toBe(g.callId);
      const edited = ok<VersionRef>(
        await ed.patch(`${C}/contents/${ids.contentId}/versions/${d.id}`, {
          expectedRevision: d.revision,
          body: `${row.body}\n\nEdited by a human editor.`,
        }),
        200,
      );
      const v = await submitVersion(ed, w, ids.contentId, edited);
      await humanQaPass(po, w, v.id);
      ok(
        await po.post(`${C}/versions/${v.id}/approve`, {
          versionHash: v.hash,
          acknowledgedWarnings: await warningCodes(po, w, v.id),
        }),
        201,
      );
      const copy = ok<{
        title: string | null;
        body: string;
        versionId: string;
      }>(await op.post(`${w.P}/contents/${ids.contentId}/copy`), 200);
      expect(copy.versionId).toBe(v.id);
      expect(copy.body).toMatch(/Edited by a human editor\.$/);
      expect(copy.title === null).toBe(type === 'comment');
      const opp = ids.opportunityId
        ? await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
            where: { id: ids.opportunityId },
          })
        : null;
      const url =
        type === 'comment'
          ? `https://www.reddit.com/r/${ids.name}/comments/${opp!.threadKey}/slug/k7e2e/`
          : `https://www.reddit.com/r/${ids.name}/comments/e2e${type.slice(0, 2)}x/one_article/`;
      const pub = ok<{
        reportKind: string;
        stage: string;
        verifyStatus: string;
      }>(
        await op.post(`${w.P}/contents/${ids.contentId}/report-publication`, {
          url,
          postedAt: new Date().toISOString(),
        }),
        201,
      );
      expect(pub).toMatchObject({
        reportKind: 'user_reported',
        stage: 'test',
        verifyStatus: 'not_checked',
      });
    });
  }

  it('отказы до модели: тело → 400; бриф не готов → 409; гейт правил block → 409 policy_block; строк pub_ai_calls не прибавилось', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const before = await calls();
    const bad = await generate(ids, { variants: 4, extra: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields).toEqual(
      expect.arrayContaining([
        { field: 'variants', code: 'range' },
        { field: 'extra', code: 'unknown_field' },
      ]),
    );
    const noTpl = await ed.post(`${w.P}/briefs/${ids.briefId}/generate`, {});
    expect(noTpl.status).toBe(400);
    const draft = await seedStudio(s, w, ed, po, { ready: false });
    const nr = await generate(draft);
    expect(nr.status).toBe(409);
    expect(nr.body.error).toMatchObject({
      code: 'PUB_BRIEF_NOT_READY',
      details: { missing: ['brief_ready'] },
    });
    const blocked = await seedStudio(s, w, ed, po, {
      contentType: 'post',
      rules: 'promotion_prohibited',
    });
    const pb = await generate(blocked);
    expect(pb.status).toBe(409);
    expect(pb.body.error).toMatchObject({
      code: 'PUB_TRANSITION_INVALID',
      details: { reason: 'policy_block' },
    });
    expect(await calls()).toBe(before);
    expect(ai.model.requests).toHaveLength(0);
  });

  it('перегенерировать абзац: rewrite — абзац черновика в промпте; вне диапазона → 400; повтор opKey → тот же вызов', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const d = ok<VersionRef>(
      await ed.post(`${C}/contents/${ids.contentId}/versions`, {
        body: versionBody('Second paragraph to rewrite.'),
        meta: { disclosure: DISCLOSURE, claimMap: [], uncertainties: [] },
      }),
      201,
    );
    const out = await ed.post(`${w.P}/briefs/${ids.briefId}/generate`, {
      template: 'troubleshooting',
      rewrite: { versionId: d.id, paragraph: 9 },
    });
    expect(out.status).toBe(400);
    expect(out.body.error.details.fields).toEqual([
      { field: 'rewrite.paragraph', code: 'range' },
    ]);
    ai.model.reply(redditDraftJson(2, 'comment', ids.sourceId));
    const opKey = randomUUID();
    const g = ok<Generated>(
      await ed.post(`${w.P}/briefs/${ids.briefId}/generate`, {
        opKey,
        template: 'troubleshooting',
        variants: 2,
        rewrite: { versionId: d.id, paragraph: 2 },
      }),
      200,
    );
    expect(g.call!.output.variants).toHaveLength(2);
    expect(ai.model.requests[0].user).toContain('Second paragraph to rewrite.');
    const again = ok<Generated>(
      await ed.post(`${w.P}/briefs/${ids.briefId}/generate`, {
        opKey,
        template: 'troubleshooting',
        variants: 2,
        rewrite: { versionId: d.id, paragraph: 2 },
      }),
      200,
    );
    expect(again.callId).toBe(g.callId);
    expect(ai.model.requests).toHaveLength(1);
    // вариант вне ответа → 400 variantIndex range; вызов чужого брифа → ai_call
    const other = await seedStudio(s, w, ed, po);
    const bad = await ed.post(`${C}/contents/${other.contentId}/versions`, {
      body: versionBody(),
      meta: { disclosure: DISCLOSURE, claimMap: [], uncertainties: [] },
      aiCallId: g.callId,
      variantIndex: 0,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields).toEqual([
      { field: 'aiCallId', code: 'ai_call' },
    ]);
  });

  it('раунд 2 (Р-RD-83): «перегенерировать абзац» после выбора варианта — отдельная задача черновика (лимит по общим правилам); генерация брифа после выбора — 409 ai_task done', async () => {
    const ids = await seedStudio(s, w, ed, po);
    ai.model.reply(redditDraftJson(3, 'comment', ids.sourceId));
    const g = ok<Generated>(await generate(ids), 200);
    // выбор варианта закрывает задачу брифа
    const v1 = await versionFrom(ids, g, 0);
    const briefTask = await s.prisma.pubAiTask.findUniqueOrThrow({
      where: { id: g.call!.taskId },
    });
    expect(briefTask).toMatchObject({
      status: 'done',
      objectType: 'reddit_brief',
      objectId: ids.briefId,
    });
    const again = await generate(ids);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: 'PUB_TRANSITION_INVALID',
      details: { machine: 'ai_task', from: 'done' },
    });
    // переписать абзац выбранного черновика — своя задача, 200
    ai.model.reply(redditDraftJson(2, 'comment', ids.sourceId));
    const r1 = ok<Generated>(
      await generate(ids, {
        variants: 2,
        rewrite: { versionId: v1.id, paragraph: 0 },
      }),
      200,
    );
    const rTask = await s.prisma.pubAiTask.findUniqueOrThrow({
      where: { id: r1.call!.taskId },
    });
    expect(rTask).toMatchObject({
      status: 'open',
      objectType: 'content_version',
      objectId: v1.id,
      generationsUsed: 1,
    });
    // экран восстанавливает последний вызов — это переписывание
    const m = ok<{ lastGeneration: { callId: string } | null }>(
      await ed.get(`${w.P}/contents/${ids.contentId}`),
      200,
    );
    expect(m.lastGeneration?.callId).toBe(r1.callId);
    // вариант переписывания — в черновик этого брифа (PATCH с aiCallId)
    const patched = ok<VersionRef>(
      await ed.patch(`${C}/contents/${ids.contentId}/versions/${v1.id}`, {
        expectedRevision: v1.revision,
        body: r1.call!.output.variants[1].body,
        aiCallId: r1.callId,
        variantIndex: 1,
      }),
      200,
    );
    expect(
      (
        await s.prisma.pubContentVersion.findUniqueOrThrow({
          where: { id: v1.id },
        })
      ).aiCallId,
    ).toBe(r1.callId);
    // повторное переписывание того же черновика — та же задача, лимит общий
    ai.model.reply(redditDraftJson(2, 'comment', ids.sourceId));
    const r2 = ok<Generated>(
      await generate(ids, {
        variants: 2,
        rewrite: { versionId: patched.id, paragraph: 1 },
      }),
      200,
    );
    expect(r2.call!.taskId).toBe(rTask.id);
    expect(
      (await s.prisma.pubAiTask.findUniqueOrThrow({ where: { id: rTask.id } }))
        .generationsUsed,
    ).toBe(2);
    // ни вариант переписывания, ни вариант генерации брифа нельзя
    // принести в материал другого брифа
    const other = await seedStudio(s, w, ed, po);
    for (const callId of [r2.callId, g.callId]) {
      const bad = await ed.post(`${C}/contents/${other.contentId}/versions`, {
        body: versionBody(),
        meta: { disclosure: DISCLOSURE, claimMap: [], uncertainties: [] },
        aiCallId: callId,
        variantIndex: 0,
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error.details.fields).toEqual([
        { field: 'aiCallId', code: 'ai_call' },
      ]);
    }
  });

  it('ответ против входа (заголовок у комментария) → повтор, затем schema_invalid 422; вызов в журнале', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const titled = redditDraftJson(3, 'comment', ids.sourceId, () => ({
      title: 'A title',
    }));
    ai.model.reply(titled, titled);
    const r = await generate(ids);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({
      code: 'PUB_AI_SCHEMA_INVALID',
      details: { status: 'schema_invalid' },
    });
    expect(ai.model.requests).toHaveLength(2);
    const row = await s.prisma.pubAiCall.findUniqueOrThrow({
      where: { id: r.body.error.details.callId },
    });
    expect(row.status).toBe('schema_invalid');
  });

  it('находки шлюза: ссылка при linksAllowed=false и личный опыт → critical link_present / first_person_experience (человек решает, версия не создаётся сама)', async () => {
    const ids = await seedStudio(s, w, ed, po);
    const versions = await s.prisma.pubContentVersion.count({
      where: { contentId: ids.contentId },
    });
    ai.model.reply(
      redditDraftJson(2, 'comment', ids.sourceId, (i) =>
        i === 0
          ? {
              body: `${DISCLOSURE}\n\nI've been using it for months. See demo-tools.com/guide`,
            }
          : {},
      ),
    );
    const g = ok<Generated>(await generate(ids, { variants: 2 }), 200);
    expect(
      g
        .call!.findings.filter((f) => f.severity === 'critical')
        .map((f) => f.code)
        .sort(),
    ).toEqual(['first_person_experience', 'link_present']);
    expect(
      await s.prisma.pubContentVersion.count({
        where: { contentId: ids.contentId },
      }),
    ).toBe(versions);
  });

  it('стенд (Р-RD-73): PUBLISHER_STAND_FAKE_AI — fake-провайдер без сети и стендовое включение pub.reddit.draft; в production флаг игнорируется', async () => {
    expect(
      publisherStandFakeAi({
        PUBLISHER_STAND_FAKE_AI: 'true',
        NODE_ENV: 'test',
      }),
    ).toEqual({ enabled: true, problem: null });
    for (const env of [
      { PUBLISHER_STAND_FAKE_AI: 'true', NODE_ENV: 'production' },
      { PUBLISHER_STAND_FAKE_AI: 'true', NODE_ENV: 'development', VERCEL: '1' },
      { PUBLISHER_STAND_FAKE_AI: 'true' },
    ]) {
      const r = publisherStandFakeAi(env);
      expect(r.enabled).toBe(false);
      expect(r.problem).toMatch(/PUBLISHER_STAND_FAKE_AI проигнорирована/);
    }
    // Без тестовой подмены модели и без включения генератора в коде.
    ai.restore();
    const w2 = await redditWorld(s);
    const ed2 = api(s, w2.acc.accountId, w2.team.editor);
    const po2 = api(s, w2.acc.accountId, w2.team.product_owner);
    await approveParams(
      s.prisma,
      { accountId: w2.acc.accountId, ownerMemberId: w2.acc.owner.memberId },
      w2.product.id,
      AI_PARAMS,
    );
    await openAiMonth(
      s.prisma,
      { id: w2.product.id, accountId: w2.acc.accountId },
      20_000_000n,
    );
    const ids = await seedStudio(s, w2, ed2, po2, { contentType: 'post' });
    const saved = { ...process.env };
    process.env.PUBLISHER_REDDIT_AI_ENABLED = 'true';
    process.env.PUBLISHER_AI_ALLOW_UNEVALUATED = 'true';
    try {
      // флаг стенда выключен — генератор выключен в коде
      const off = await ed2.post(`${w2.P}/briefs/${ids.briefId}/generate`, {
        template: 'comparison',
      });
      expect(off.status).toBe(409);
      expect(off.body.error.code).toBe('PUB_AI_DISABLED');
      // N5 (раунд 2): флаг есть, но окружение не стенд (Vercel; production)
      // → 409 PUB_AI_DISABLED по HTTP и `ai.available=false`.
      process.env.PUBLISHER_STAND_FAKE_AI = 'true';
      process.env.VERCEL = '1';
      for (const nodeEnv of ['test', 'production']) {
        process.env.NODE_ENV = nodeEnv;
        if (nodeEnv === 'production') delete process.env.VERCEL;
        const r = await ed2.post(`${w2.P}/briefs/${ids.briefId}/generate`, {
          template: 'comparison',
        });
        expect({ nodeEnv, status: r.status, code: r.body.error?.code }).toEqual(
          { nodeEnv, status: 409, code: 'PUB_AI_DISABLED' },
        );
        const b = ok<{ ai: { available: boolean } }>(
          await ed2.get(`${w2.P}/briefs/${ids.briefId}`),
          200,
        );
        expect(b.ai.available).toBe(false);
      }
      process.env.NODE_ENV = 'test';
      // Стенд: NODE_ENV=test и НЕ Vercel (jest-окружение задаёт VERCEL=1).
      process.env.PUBLISHER_STAND_FAKE_AI = 'true';
      delete process.env.VERCEL;
      const brief = ok<{ ai: { available: boolean } }>(
        await ed2.get(`${w2.P}/briefs/${ids.briefId}`),
        200,
      );
      expect(brief.ai.available).toBe(true);
      const g = ok<Generated>(
        await ed2.post(`${w2.P}/briefs/${ids.briefId}/generate`, {
          template: 'comparison',
        }),
        200,
      );
      expect(g.call!.output.variants).toHaveLength(3);
      expect(g.call!.findings).toEqual([]);
      expect(g.call!.output.variants[0].title).not.toBeNull();
      const m = ok<{ lastGeneration: { callId: string } | null }>(
        await ed2.get(`${w2.P}/contents/${ids.contentId}`),
        200,
      );
      expect(m.lastGeneration?.callId).toBe(g.callId);
    } finally {
      for (const k of [
        'PUBLISHER_REDDIT_AI_ENABLED',
        'PUBLISHER_AI_ALLOW_UNEVALUATED',
        'PUBLISHER_STAND_FAKE_AI',
        'VERCEL',
        'NODE_ENV',
      ])
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      ai = await redditAi(s, w, { params: false });
    }
  });
});
