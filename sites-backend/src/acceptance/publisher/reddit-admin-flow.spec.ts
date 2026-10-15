/**
 * [P-R-ADM] Вкладка «Reddit» Админки — полный путь через внутренний API
 * (`/internal/admin/reddit/**`, Р-RD-ADM-1…5) на fake-AI стенде: параметры
 * гейта `reddit_publish` (предложить → утвердить, актор admin) → проект,
 * сообщество, правила → проверка правил (selfReview — пометка) →
 * возможность → бриф → генерация вариантов (fake-модель без сети) →
 * материал → черновик из варианта → отправка → проверка `reddit_policy` →
 * QA editorial/technical → согласование (selfReview) → копирование →
 * отметка «опубликовано» → списки и CSV; второй материал — «вернуть на
 * доработку» (единственный переход, доступный Админке).
 *
 * Проверяется: актор `admin:<userId>` во всех журналах и полях «кто»
 * (аудит, ключи идемпотентности, решения параметров, проверка правил, QA,
 * согласование, вызов AI, автор версии); ответы — те же формы, что у
 * кабинета; ноль запросов к Reddit (`watchEgress`).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { GATE_PARAMETER_KEYS } from '../../modules/publisher/contracts/parameters';
import {
  ADMIN_USER,
  adminApi,
  useAdminEnv,
  type AdminApi,
} from '../../modules/publisher/reddit/testing/admin-kit.testing';
import {
  DISCLOSURE,
  ok,
  redditAi,
  redditDraftJson,
  redditStack,
  redditWorld,
  rulesBody,
  seedContentSource,
  seedOffer,
  subredditName,
  threadUrl,
  versionBody,
  factorsBody,
  type RedditAi,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';
import { watchEgress, type EgressWatch } from './reddit-egress.testing';

jest.setTimeout(300_000);

const ACTOR = `admin:${ADMIN_USER}`;

ciDescribe(
  '[P-R-ADM] Админка: полный путь бриф → вариант → черновик → проверка → согласование → копирование → отчёт',
  () => {
    let s: RedditStack;
    let w: RedditWorld;
    let ai: RedditAi;
    let net: EgressWatch;
    let A: AdminApi;
    let restoreEnv: () => void;
    let started: Date;

    beforeAll(async () => {
      s = await redditStack();
      w = await redditWorld(s, 'working');
      restoreEnv = useAdminEnv(w.acc.siteId);
      ai = await redditAi(s, w);
      A = adminApi(s);
      started = new Date();
      net = watchEgress();
    });
    afterAll(async () => {
      net?.restore();
      ai?.restore();
      restoreEnv?.();
      await s?.close();
    });

    it('status и setup: платформенный продукт найден, повторный setup — 200 без создания', async () => {
      const st = ok<{
        enabled: boolean;
        aiEnabled: boolean;
        platformSiteId: string;
        product: { id: string; kind: string; mode: string };
        gate: { open: boolean; missing: Array<{ key: string }> };
      }>(await A.get('status'), 200);
      expect(st.enabled).toBe(true);
      expect(st.aiEnabled).toBe(true);
      expect(st.platformSiteId).toBe(w.acc.siteId);
      expect(st.product).toMatchObject({ id: w.product.id, kind: 'working' });
      expect(st.gate.open).toBe(false);
      expect(st.gate.missing.map((m) => m.key).sort()).toEqual(
        [...GATE_PARAMETER_KEYS.reddit_publish].sort(),
      );
      const again = await A.postRaw('setup', {});
      expect(again.status).toBe(200);
      expect(again.body.data).toMatchObject({
        created: false,
        product: { id: w.product.id },
      });
    });

    it('полный путь Админки: актор admin везде, гейт открыт решениями оператора, текст копируется точно', async () => {
      const offerId = await seedOffer(s.prisma, w);
      const src = await seedContentSource(s.prisma, w);

      // ── Параметры гейта reddit_publish (Р-RD-ADM-5) ──────────────────
      const params = ok<{
        items: Array<{ key: string; value: unknown; status: string }>;
        keys: string[];
        hints: {
          offerActiveVersion: { offerVersionId: string; version: number };
          accountOwnerMemberId: string;
        };
      }>(await A.get('params'), 200);
      expect(params.keys).toHaveLength(13);
      expect(params.items.map((x) => x.key).sort()).toEqual(
        [...params.keys].sort(),
      );
      expect(params.hints.offerActiveVersion.offerVersionId).toBe(offerId);
      expect(params.hints.accountOwnerMemberId).toBe(w.acc.owner.memberId);
      for (const key of GATE_PARAMETER_KEYS.reddit_publish) {
        const cur = params.items.find((x) => x.key === key)!;
        const value =
          key === 'offer_active_version'
            ? params.hints.offerActiveVersion
            : key === 'responsibles'
              ? {
                  formOwnerMemberId: params.hints.accountOwnerMemberId,
                  salesMemberIds: [params.hints.accountOwnerMemberId],
                  afterT72MemberId: null,
                }
              : key === 'niche'
                ? { text: 'Платформа: власники сайтів і малий бізнес' }
                : cur.value;
        const pr = ok<{ proposalId: string; parameter: { revision: number } }>(
          await A.post(`params/${key}/propose`, { value }),
          201,
        );
        const open = ok<{ items: Array<{ id: string }> }>(
          await A.get(`params/${key}/proposals`, { status: 'open' }),
          200,
        );
        expect(open.items.map((x) => x.id)).toContain(pr.proposalId);
        ok(
          await A.post(`params/${key}/decide`, {
            toStatus: 'approved',
            proposalId: pr.proposalId,
            expectedRevision: pr.parameter.revision,
            basis: 'Рішення оператора платформи в Адмінці',
          }),
          200,
        );
      }
      const after = ok<{ gate: { open: boolean } }>(await A.get('params'), 200);
      expect(after.gate.open).toBe(true);
      const decisions = await s.prisma.pubParameterDecision.findMany({
        where: { productId: w.product.id, createdAt: { gte: started } },
      });
      expect(decisions.length).toBe(6);
      expect(new Set(decisions.map((d) => d.decidedBy))).toEqual(
        new Set([ACTOR]),
      );

      // ── M1: проект, сообщество, правила, проверка, возможность ───────
      const name = subredditName('adm');
      const proj = ok<{ id: string }>(
        await A.post('rx/projects', {
          title: 'Платформа: Reddit',
          locale: 'en',
          market: 'US',
        }),
        201,
      );
      const comm = ok<{ id: string }>(
        await A.post('rx/communities', {
          projectId: proj.id,
          community: `r/${name}`,
        }),
        201,
      );
      const snap = ok<{ id: string }>(
        await A.post(
          `rx/communities/${comm.id}/rules`,
          rulesBody(name, 'restricted'),
        ),
        201,
      );
      const rev = ok<{ state: string; selfReview: boolean }>(
        await A.post(`rx/rules/${snap.id}/review`),
        200,
      );
      expect(rev.selfReview).toBe(true);
      const snapRow = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
        where: { id: snap.id },
      });
      expect([snapRow.createdBy, snapRow.reviewedBy]).toEqual([ACTOR, ACTOR]);
      const opp = ok<{ id: string; revision: number }>(
        await A.post('rx/opportunities', {
          projectId: proj.id,
          communityId: comm.id,
          threadUrl: threadUrl(name),
          titleManual: 'Which AI chat widget answers only from site content?',
          excerpt: 'Looking for a widget that answers from our docs only.',
          intent: 'recommendation',
          factors: factorsBody(),
        }),
        201,
      );
      ok(
        await A.post(`rx/opportunities/${opp.id}/qualify`, {
          expectedRevision: opp.revision,
        }),
        200,
      );
      const list = ok<{ items: Array<{ id: string }> }>(
        await A.get('rx/opportunities', { status: 'qualified' }),
        200,
      );
      expect(list.items.map((x) => x.id)).toEqual([opp.id]);
      const csv = await A.get('rx/opportunities', { format: 'csv' });
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text).toContain(opp.id);

      // ── M2: бриф → генерация → материал → версия ────────────────────
      const keyPoints = [
        {
          text: 'One verified article can become a post, cards and a video script',
          sourceIds: [src],
        },
        {
          text: 'Ask which formats the author tried',
          sourceIds: 'needs_verification',
        },
      ];
      const b = ok<{ id: string; revision: number }>(
        await A.post('rx/briefs', {
          projectId: proj.id,
          contentType: 'comment',
          opportunityId: opp.id,
          objective: 'Help the author reuse one article',
          keyPoints,
          affiliation: 'founder',
          brand: 'Demo',
          language: 'en',
        }),
        201,
      );
      ok(
        await A.post(`rx/briefs/${b.id}/ready`, {
          expectedRevision: b.revision,
        }),
        200,
      );
      ai.model.reply(redditDraftJson(3, 'comment', src));
      const g = ok<{
        callId: string;
        call: { output: { variants: Array<{ body: string }> } };
      }>(
        await A.post(`rx/briefs/${b.id}/generate`, {
          template: 'helpful_answer',
        }),
        200,
      );
      expect(g.call.output.variants).toHaveLength(3);
      const call = await s.prisma.pubAiCall.findUniqueOrThrow({
        where: { id: g.callId },
      });
      expect(call.requestedBy).toBe(ACTOR);
      const m = ok<{ content: { id: string } }>(
        await A.post(`rx/briefs/${b.id}/contents`),
        201,
      );
      const cid = m.content.id;
      const d = ok<{ id: string; revision: number }>(
        await A.post(`cx/contents/${cid}/versions`, {
          body: g.call.output.variants[0].body,
          meta: {
            disclosure: DISCLOSURE,
            claimMap: [
              {
                text: 'One verified article can become a post, cards and a video script',
                sourceIds: [src],
              },
            ],
            uncertainties: [],
          },
          aiCallId: g.callId,
          variantIndex: 0,
        }),
        201,
      );
      ok(await A.get(`cx/contents/${cid}/versions`), 200);
      const v = ok<{ id: string; hash: string; revision: number }>(
        await A.post(`cx/contents/${cid}/versions/${d.id}/submit`, {
          expectedRevision: d.revision,
        }),
        200,
      );
      ok(await A.get(`cx/contents/${cid}/versions/${v.id}`), 200);
      ok(await A.post(`rx/contents/${cid}/check`), 201);
      for (const kind of ['editorial', 'technical'])
        ok(
          await A.post(`cx/versions/${v.id}/qa-checks`, {
            kind,
            result: 'pass',
          }),
          201,
        );
      const qa = ok<{
        items: Array<{
          kind: string;
          selfReview: boolean;
          warnings: Array<{ code: string }>;
        }>;
      }>(await A.get(`cx/versions/${v.id}/qa-checks`), 200);
      const human = qa.items.filter((q) =>
        ['editorial', 'technical'].includes(q.kind),
      );
      expect(human.map((q) => q.selfReview)).toEqual([true, true]);
      const warn = (
        qa.items.filter((q) => q.kind === 'reddit_policy').pop()?.warnings ?? []
      ).map((x) => x.code);
      const appr = ok<{ selfReview: boolean; approverDisplayName: string }>(
        await A.post(`cx/versions/${v.id}/approve`, {
          versionHash: v.hash,
          acknowledgedWarnings: warn,
        }),
        201,
      );
      expect(appr.selfReview).toBe(true);
      expect(appr.approverDisplayName).toMatch(/^Адмін платформи …/);

      // ── Копирование и отчёт ──────────────────────────────────────────
      const before = net.outbound.length + net.foreign().length;
      const copy = ok<{ body: string; versionHash: string; openUrl: string }>(
        await A.post(`rx/contents/${cid}/copy`),
        200,
      );
      expect(copy.body).toBe(g.call.output.variants[0].body);
      expect(copy.versionHash).toBe(v.hash);
      expect(net.outbound.length + net.foreign().length).toBe(before);
      const oppRow = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
        where: { id: opp.id },
      });
      ok(
        await A.post(`rx/contents/${cid}/report-publication`, {
          url: `https://www.reddit.com/r/${name}/comments/${oppRow.threadKey}/x/k1adm/`,
          postedAt: new Date().toISOString(),
        }),
        201,
      );
      const pubs = ok<{ items: Array<{ contentId: string }> }>(
        await A.get('rx/publications'),
        200,
      );
      expect(pubs.items.map((x) => x.contentId)).toContain(cid);
      const mat = ok<{
        copies: { count: number };
        publications: unknown[];
      }>(await A.get(`rx/contents/${cid}`), 200);
      expect(mat.copies.count).toBe(1);
      expect(mat.publications).toHaveLength(1);

      // ── Кто действовал: только admin:<userId> ───────────────────────
      const audit = await s.prisma.pubAuditEvent.findMany({
        where: { productId: w.product.id, occurredAt: { gte: started } },
      });
      expect(audit.length).toBeGreaterThan(15);
      expect(
        [...new Set(audit.map((a) => a.actor))].filter(
          (x) => x !== ACTOR && !x.startsWith('system:'),
        ),
      ).toEqual([]);
      expect(audit.some((a) => a.action === 'copy' && a.actor === ACTOR)).toBe(
        true,
      );
      const keys = await s.prisma.pubIdempotencyKey.findMany({
        where: { productId: w.product.id, createdAt: { gte: started } },
        select: { createdBy: true },
      });
      expect(new Set(keys.map((k) => k.createdBy))).toEqual(new Set([ACTOR]));
      const ver = await s.prisma.pubContentVersion.findUniqueOrThrow({
        where: { id: v.id },
      });
      expect([ver.authorMemberId, ver.createdBy]).toEqual([ACTOR, ACTOR]);
      const checks = await s.prisma.pubQaCheck.findMany({
        where: { versionId: v.id, kind: { in: ['editorial', 'technical'] } },
      });
      expect(checks.map((c) => c.checkedBy)).toEqual([ACTOR, ACTOR]);
      const approval = await s.prisma.pubApproval.findFirstOrThrow({
        where: { objectId: v.id },
      });
      expect([approval.approverMemberId, approval.createdBy]).toEqual([
        ACTOR,
        ACTOR,
      ]);

      // ── Ноль запросов к Reddit ───────────────────────────────────────
      expect(net.outbound).toEqual([]);
      expect(net.foreign()).toEqual([]);
      expect(
        [...net.sockets, ...net.lookups].some((h) => /redd/i.test(h)),
      ).toBe(false);
    });

    it('второй материал: «вернуть на доработку» — да; прочие ручные переходы — 409 admin_scope', async () => {
      const src = await seedContentSource(s.prisma, w);
      const name = subredditName('admx');
      const proj = ok<{ id: string }>(
        await A.post('rx/projects', {
          title: 'Платформа: Reddit 2',
          locale: 'en',
          market: 'US',
        }),
        201,
      );
      const comm = ok<{ id: string }>(
        await A.post('rx/communities', {
          projectId: proj.id,
          community: `r/${name}`,
        }),
        201,
      );
      const snap = ok<{ id: string }>(
        await A.post(
          `rx/communities/${comm.id}/rules`,
          rulesBody(name, 'allowed'),
        ),
        201,
      );
      ok(await A.post(`rx/rules/${snap.id}/review`), 200);
      const b = ok<{ id: string; revision: number }>(
        await A.post('rx/briefs', {
          projectId: proj.id,
          contentType: 'post',
          communityId: comm.id,
          objective: 'Teach the method',
          keyPoints: [
            { text: 'One article becomes several formats', sourceIds: [src] },
            { text: 'Ask what readers tried', sourceIds: 'needs_verification' },
          ],
          affiliation: 'founder',
          brand: 'Demo',
          language: 'en',
        }),
        201,
      );
      ok(
        await A.post(`rx/briefs/${b.id}/ready`, {
          expectedRevision: b.revision,
        }),
        200,
      );
      const m = ok<{ content: { id: string } }>(
        await A.post(`rx/briefs/${b.id}/contents`),
        201,
      );
      const cid = m.content.id;
      const d = ok<{ id: string; revision: number }>(
        await A.post(`cx/contents/${cid}/versions`, {
          title: 'One article, several formats',
          body: versionBody(),
          meta: {
            disclosure: DISCLOSURE,
            claimMap: [
              { text: 'One article becomes several formats', sourceIds: [src] },
            ],
            uncertainties: [],
          },
        }),
        201,
      );
      ok(
        await A.post(`cx/contents/${cid}/versions/${d.id}/submit`, {
          expectedRevision: d.revision,
        }),
        200,
      );
      const content = await s.prisma.pubContent.findUniqueOrThrow({
        where: { id: cid },
      });
      const withdraw = await A.post(`cx/contents/${cid}/transition`, {
        expectedRevision: content.revision,
        to: 'withdrawn',
        reason: 'Не потрібно',
      });
      expect(withdraw.status).toBe(409);
      expect(withdraw.body.error).toMatchObject({
        code: 'PUB_TRANSITION_INVALID',
        details: { reason: 'admin_scope' },
      });
      const back = ok<{ status: string }>(
        await A.post(`cx/contents/${cid}/transition`, {
          expectedRevision: content.revision,
          to: 'changes_requested',
          reason: 'Уточнити розкриття і приклад',
        }),
        200,
      );
      expect(back.status).toBe('changes_requested');
      const diff = await A.get(
        `cx/contents/${cid}/versions/${d.id}/diff/${d.id}`,
      );
      expect(diff.status).toBe(200);
    });
  },
);
