/**
 * [AT-RD-13] P-R M2 — Reddit-бриф (reddit-manual-mvp-adapted.md §M2.1,
 * §M2.2, §9; Р-RD-5, Р-RD-14, Р-RD-61):
 *  - comment без возможности или без контекста → 400 `PUB_VALIDATION`
 *    (в ТЗ v1.3 — 422, Р-RD-14), строк не прибавилось;
 *  - контекст comment по умолчанию — выдержка треда; возможность
 *    `qualified → in_brief` по гейту правил СЕЙЧАС (аудит); возможность не
 *    отобрана или сообщество запрещает продвижение → 409;
 *  - тезисы: доказательства P-R (`origin=reddit`) — 400 `restricted_source`;
 *  - `ready` — пустой `missing`; правка `ready` → `draft`; `archived`
 *    неизменен, материал из него не создаётся;
 *  - контакты и ники в тексте брифа — 400 (`pii`/`profile_ref`); список и
 *    CSV.
 */
import { PUBLISHER_REDDIT_AI_ENABLED_ENV } from '../../config/publisher-env';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  api,
  ok,
  redditStack,
  redditWorld,
  seedCommunity,
  seedContentSource,
  seedOffer,
  seedOpportunity,
  type Api,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(240_000);

interface Brief {
  id: string;
  status: string;
  contentType: string;
  context: string | null;
  missing: string[];
  threadUrl: string | null;
  opportunityId: string | null;
  ai: { available: boolean; reason: string | null };
  gate: { verdict: string };
  revision: number;
}

ciDescribe('P-R M2: Reddit-бриф', () => {
  let s: RedditStack;
  let w: RedditWorld;
  let ed: Api;
  let po: Api;
  let src: string;
  beforeAll(async () => {
    s = await redditStack();
    w = await redditWorld(s);
    ed = api(s, w.acc.accountId, w.team.editor);
    po = api(s, w.acc.accountId, w.team.product_owner);
    await seedOffer(s.prisma, w);
    src = await seedContentSource(s.prisma, w);
  });
  afterAll(async () => {
    await s?.close();
  });

  const points = () => [
    {
      text: 'One verified article can become several formats',
      sourceIds: [src],
    },
    { text: 'Ask what the author tried', sourceIds: 'needs_verification' },
  ];

  async function qualified(
    rules: 'restricted' | 'allowed' = 'restricted',
    extra: Record<string, unknown> = {},
  ) {
    const c = await seedCommunity(ed, w.P, { rules, reviewer: po });
    const o = ok<{ id: string; revision: number }>(
      await seedOpportunity(ed, w.P, c, extra),
      201,
    );
    const q = ok<{ id: string; status: string; revision: number }>(
      await ed.post(`${w.P}/opportunities/${o.id}/qualify`, {
        expectedRevision: o.revision,
      }),
      200,
    );
    return { c, o: q };
  }

  const briefs = () =>
    s.prisma.pubRedditBrief.count({ where: { productId: w.product.id } });

  describe('[AT-RD-13] comment без контекста → 400', () => {
    it('comment без opportunityId → 400 opportunityId required; явный пустой context → 400 context required; строк нет', async () => {
      const { c, o } = await qualified();
      const before = await briefs();
      const r1 = await ed.post(`${w.P}/briefs`, {
        projectId: c.projectId,
        contentType: 'comment',
        communityId: c.communityId,
        objective: 'Help',
        keyPoints: points(),
      });
      expect(r1.status).toBe(400);
      expect(r1.body.error).toMatchObject({
        code: 'PUB_VALIDATION',
        details: { fields: [{ field: 'opportunityId', code: 'required' }] },
      });
      for (const context of ['', '   ', null]) {
        const r = await ed.post(`${w.P}/briefs`, {
          projectId: c.projectId,
          contentType: 'comment',
          opportunityId: o.id,
          objective: 'Help',
          context,
          keyPoints: points(),
        });
        expect(r.status).toBe(400);
        expect(r.body.error.details.fields).toContainEqual({
          field: 'context',
          code: 'required',
        });
      }
      expect(await briefs()).toBe(before);
      // возможность осталась qualified
      const opp = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
        where: { id: o.id },
      });
      expect(opp.status).toBe('qualified');
    });

    it('возможность без выдержки и без context → 400 context required', async () => {
      const { c, o } = await qualified('restricted', { excerpt: null });
      const r = await ed.post(`${w.P}/briefs`, {
        projectId: c.projectId,
        contentType: 'comment',
        opportunityId: o.id,
        objective: 'Help',
        keyPoints: points(),
      });
      expect(r.status).toBe(400);
      expect(r.body.error.details.fields).toEqual([
        { field: 'context', code: 'required' },
      ]);
      expect(r.body.error.code).toBe('PUB_VALIDATION');
    });

    it('правка comment-брифа на пустой context → 400', async () => {
      const { c, o } = await qualified();
      const b = ok<Brief>(
        await ed.post(`${w.P}/briefs`, {
          projectId: c.projectId,
          contentType: 'comment',
          opportunityId: o.id,
          objective: 'Help',
          keyPoints: points(),
        }),
        201,
      );
      const r = await ed.patch(`${w.P}/briefs/${b.id}`, {
        context: ' ',
        expectedRevision: b.revision,
      });
      expect(r.status).toBe(400);
      expect(r.body.error.details.fields).toEqual([
        { field: 'context', code: 'required' },
      ]);
    });
  });

  it('comment: контекст по умолчанию — выдержка; возможность qualified → in_brief с аудитом; вид брифа (тред, гейт, ai)', async () => {
    const { c, o } = await qualified();
    const b = ok<Brief>(
      await ed.post(`${w.P}/briefs`, {
        projectId: c.projectId,
        contentType: 'comment',
        opportunityId: o.id,
        objective: 'Help the author reuse one article',
        keyPoints: points(),
        affiliation: 'founder',
        brand: 'Demo',
      }),
      201,
    );
    expect(b).toMatchObject({
      status: 'draft',
      contentType: 'comment',
      opportunityId: o.id,
      missing: [],
      gate: { verdict: 'ok' },
      ai: { available: false, reason: 'flag_off' },
    });
    expect(b.context).toMatch(/^Looking for a widget/);
    expect(b.threadUrl).toMatch(/^https:\/\/www\.reddit\.com\/r\//);
    const opp = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
      where: { id: o.id },
    });
    expect(opp.status).toBe('in_brief');
    const audit = await s.prisma.pubAuditEvent.findFirst({
      where: {
        objectType: 'reddit_opportunity',
        objectId: o.id,
        toStatus: 'in_brief',
      },
    });
    expect(audit?.meta).toMatchObject({ cause: 'brief_created' });
    // Флаг генерации включён, генератор выключен в коде до eval 2.3.
    const saved = process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV];
    process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV] = 'true';
    try {
      const v = ok<Brief>(await ed.get(`${w.P}/briefs/${b.id}`), 200);
      expect(v.ai).toEqual({ available: false, reason: 'generator_disabled' });
    } finally {
      if (saved === undefined)
        delete process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV];
      else process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV] = saved;
    }
    // Второй бриф на ту же возможность (in_brief) — можно.
    ok(
      await ed.post(`${w.P}/briefs`, {
        projectId: c.projectId,
        contentType: 'comment',
        opportunityId: o.id,
        objective: 'Another angle',
        keyPoints: points(),
      }),
      201,
    );
  });

  it('возможность не отобрана (new) → 409 status; пост в сообщество с запретом продвижения — бриф есть, гейт block (генерация и копирование закрыты)', async () => {
    const c = await seedCommunity(ed, w.P, {
      rules: 'restricted',
      reviewer: po,
    });
    const o = ok<{ id: string }>(await seedOpportunity(ed, w.P, c), 201);
    const r = await ed.post(`${w.P}/briefs`, {
      projectId: c.projectId,
      contentType: 'comment',
      opportunityId: o.id,
      objective: 'Help',
      keyPoints: points(),
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: 'PUB_TRANSITION_INVALID',
      details: { reason: 'status', from: 'new' },
    });
    const p = await seedCommunity(ed, w.P, {
      rules: 'promotion_prohibited',
      reviewer: po,
    });
    const before = await briefs();
    const r2 = await ed.post(`${w.P}/briefs`, {
      projectId: p.projectId,
      contentType: 'post',
      communityId: p.communityId,
      objective: 'Help',
      keyPoints: points(),
      affiliation: 'founder',
    });
    // Пост в запрещённое сообщество: бриф создаётся, но гейт — block.
    const b = ok<Brief>(r2, 201);
    expect(b.gate.verdict).toBe('block');
    expect(await briefs()).toBe(before + 1);
  });

  it('post: без communityId → 400; сообщество другого проекта → 400 project_mismatch; доказательство P-R в тезисах → 400 restricted_source; чужой id → not_found', async () => {
    const c = await seedCommunity(ed, w.P, {
      rules: 'restricted',
      reviewer: po,
    });
    const other = await seedCommunity(ed, w.P, {
      rules: 'restricted',
      reviewer: po,
    });
    const base = {
      projectId: c.projectId,
      contentType: 'post',
      objective: 'Help',
      keyPoints: points(),
    };
    const r1 = await ed.post(`${w.P}/briefs`, base);
    expect(r1.status).toBe(400);
    expect(r1.body.error.details.fields).toEqual([
      { field: 'communityId', code: 'required' },
    ]);
    const r2 = await ed.post(`${w.P}/briefs`, {
      ...base,
      communityId: other.communityId,
    });
    expect(r2.status).toBe(400);
    expect(r2.body.error.details.fields).toEqual([
      { field: 'communityId', code: 'project_mismatch' },
    ]);
    const { o } = await qualified();
    const opp = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
      where: { id: o.id },
    });
    const r3 = await ed.post(`${w.P}/briefs`, {
      ...base,
      communityId: c.communityId,
      keyPoints: [
        { text: 'From the thread', sourceIds: [opp.excerptSourceId] },
      ],
    });
    expect(r3.status).toBe(400);
    expect(r3.body.error.details.fields).toEqual([
      { field: 'keyPoints.sourceIds', code: 'restricted_source' },
    ]);
    const r4 = await ed.post(`${w.P}/briefs`, {
      ...base,
      communityId: c.communityId,
      keyPoints: [{ text: 'Ghost', sourceIds: ['cghostzzzzzzzzzzzzzzzzzz'] }],
    });
    expect(r4.status).toBe(400);
    expect(r4.body.error.details.fields[0]).toMatchObject({
      field: 'keyPoints.sourceIds',
      code: 'not_found',
    });
  });

  it('контакт или ник в тексте брифа → 400 pii / profile_ref', async () => {
    const c = await seedCommunity(ed, w.P, {
      rules: 'restricted',
      reviewer: po,
    });
    const r = await ed.post(`${w.P}/briefs`, {
      projectId: c.projectId,
      contentType: 'post',
      communityId: c.communityId,
      objective: 'Call +380 67 123 45 67',
      audience: 'Ask u/some_user',
      keyPoints: points(),
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details.fields).toEqual(
      expect.arrayContaining([
        { field: 'objective', code: 'pii' },
        { field: 'audience', code: 'profile_ref' },
      ]),
    );
  });

  it('ready: без affiliation → 409 PUB_BRIEF_NOT_READY {missing}; правка ready → draft (аудит); archived неизменен, материал не создаётся', async () => {
    const c = await seedCommunity(ed, w.P, {
      rules: 'restricted',
      reviewer: po,
    });
    const b = ok<Brief>(
      await ed.post(`${w.P}/briefs`, {
        projectId: c.projectId,
        contentType: 'post',
        communityId: c.communityId,
        objective: 'Help',
        keyPoints: points(),
      }),
      201,
    );
    expect(b.missing).toEqual(['affiliation']);
    const nr = await ed.post(`${w.P}/briefs/${b.id}/ready`, {
      expectedRevision: b.revision,
    });
    expect(nr.status).toBe(409);
    expect(nr.body.error).toMatchObject({
      code: 'PUB_BRIEF_NOT_READY',
      details: { missing: ['affiliation'] },
    });
    // Материал из черновика брифа — 409 (бриф не готов).
    const early = await ed.post(`${w.P}/briefs/${b.id}/contents`);
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({
      code: 'PUB_BRIEF_NOT_READY',
      details: { missing: ['brief_ready', 'affiliation'] },
    });
    const p1 = ok<Brief>(
      await ed.patch(`${w.P}/briefs/${b.id}`, {
        affiliation: 'founder',
        brand: 'Demo',
        expectedRevision: b.revision,
      }),
      200,
    );
    expect(p1.missing).toEqual([]);
    const r = ok<Brief>(
      await ed.post(`${w.P}/briefs/${b.id}/ready`, {
        expectedRevision: p1.revision,
      }),
      200,
    );
    expect(r.status).toBe('ready');
    const p2 = ok<Brief>(
      await ed.patch(`${w.P}/briefs/${b.id}`, {
        tone: 'plain',
        expectedRevision: r.revision,
      }),
      200,
    );
    expect(p2.status).toBe('draft');
    expect(
      await s.prisma.pubAuditEvent.count({
        where: {
          objectType: 'reddit_brief',
          objectId: b.id,
          fromStatus: 'ready',
          toStatus: 'draft',
        },
      }),
    ).toBe(1);
    // Устаревшая ревизия → 409 PUB_CONFLICT.
    const stale = await ed.patch(`${w.P}/briefs/${b.id}`, {
      tone: 'x',
      expectedRevision: r.revision,
    });
    expect(stale.status).toBe(409);
    const a = ok<Brief>(
      await ed.post(`${w.P}/briefs/${b.id}/archive`, {
        expectedRevision: p2.revision,
        reason: 'Не актуально',
      }),
      200,
    );
    expect(a.status).toBe('archived');
    const pa = await ed.patch(`${w.P}/briefs/${b.id}`, {
      tone: 'x',
      expectedRevision: a.revision,
    });
    expect(pa.status).toBe(409);
    const ca = await ed.post(`${w.P}/briefs/${b.id}/contents`);
    expect(ca.status).toBe(409);
  });

  it('список и CSV: фильтр по статусу, колонки REDDIT_CSV_COLUMNS.briefs', async () => {
    const list = ok<{ items: Brief[] }>(
      await po.get(`${w.P}/briefs`, { status: 'archived' }),
      200,
    );
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((b) => b.status === 'archived')).toBe(true);
    const csv = await po.get(`${w.P}/briefs`, { format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toBe(
      'id,projectId,subreddit,opportunityId,contentType,objective,affiliation,linksAllowed,language,status,missing,contentIds,createdAt',
    );
  });

  it('Р-RD-65: brand — по умолчанию имя продукта; без него при affiliation≠none — missing brand; контакт — 400', async () => {
    const c = await seedCommunity(ed, w.P, {
      rules: 'restricted',
      reviewer: po,
    });
    await s.prisma.pubProduct.update({
      where: { id: w.product.id },
      data: { name: 'Demo Shop' },
    });
    const b2 = ok<Brief & { brand: string | null }>(
      await ed.post(`${w.P}/briefs`, {
        projectId: c.projectId,
        contentType: 'post',
        communityId: c.communityId,
        objective: 'Help',
        keyPoints: points(),
        affiliation: 'founder',
      }),
      201,
    );
    expect(b2.brand).toBe('Demo Shop');
    expect(b2.missing).toEqual([]);
    const p = ok<Brief>(
      await ed.patch(`${w.P}/briefs/${b2.id}`, {
        brand: null,
        expectedRevision: b2.revision,
      }),
      200,
    );
    expect(p.missing).toEqual(['brand']);
    const nr = await ed.post(`${w.P}/briefs/${b2.id}/ready`, {
      expectedRevision: p.revision,
    });
    expect(nr.body.error).toMatchObject({
      code: 'PUB_BRIEF_NOT_READY',
      details: { missing: ['brand'] },
    });
    const pii = await ed.patch(`${w.P}/briefs/${b2.id}`, {
      brand: 'Call +380 67 123 45 67',
      expectedRevision: p.revision,
    });
    expect(pii.status).toBe(400);
    expect(pii.body.error.details.fields).toEqual([
      { field: 'brand', code: 'pii' },
    ]);
    const n = ok<Brief>(
      await ed.patch(`${w.P}/briefs/${b2.id}`, {
        affiliation: 'none',
        expectedRevision: p.revision,
      }),
      200,
    );
    expect(n.missing).toEqual([]);
  });
});
