/**
 * [P-R-ADM] [AT-RD-16] Вкладка «Reddit» Админки — «ноль запросов к Reddit»
 * по ВСЕМ маршрутам внутреннего API: 40 `rx/*` (раздел Reddit) + 24 `cx/*` (v1.2)
 * (студия) + status/setup/params/import (Р-RD-0, Р-RD-ADM-3). Сеть подменена
 * (`reddit-egress.testing.ts`): HTTP-клиенты бросают, соединения и DNS
 * записываются. Сценарий проходит каждый маршрут таблиц (покрытие
 * сверяется с `RX_ROUTES`/`CX_ROUTES`); ожидание — ни одного вызова
 * HTTP-клиентов, соединения и DNS — только localhost (supertest).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  CX_ROUTES,
  RX_ROUTES,
} from '../../modules/publisher/reddit/admin/admin-reddit-routes';
import {
  adminApi,
  useAdminEnv,
  type AdminApi,
} from '../../modules/publisher/reddit/testing/admin-kit.testing';
import {
  DISCLOSURE,
  factorsBody,
  ok,
  openRedditPublish,
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
  type RedditAi,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';
import { watchEgress, type EgressWatch } from './reddit-egress.testing';

jest.setTimeout(300_000);

type Res = {
  status: number;
  body: { data?: unknown; error?: unknown };
  text?: string;
};

ciDescribe(
  '[P-R-ADM] [AT-RD-16] Админка: ноль запросов к Reddit по всем маршрутам',
  () => {
    let s: RedditStack;
    let w: RedditWorld;
    let ai: RedditAi;
    let net: EgressWatch;
    let A: AdminApi;
    let restore: () => void;

    beforeAll(async () => {
      s = await redditStack();
      w = await redditWorld(s, 'working');
      restore = useAdminEnv(w.acc.siteId);
      ai = await redditAi(s, w);
      await openRedditPublish(s.prisma, w);
      A = adminApi(s);
      net = watchEgress();
    });
    afterAll(async () => {
      net?.restore();
      ai?.restore();
      restore?.();
      await s?.close();
    });

    it('все 64 маршрута rx/cx и служебные — HTTP-клиенты не вызваны, сеть только localhost', async () => {
      const used = new Set<string>();
      const call = async <T = Record<string, unknown>>(
        name: string,
        status: number,
        p: Promise<Res>,
      ): Promise<T> => {
        used.add(name);
        return ok<T>((await p) as never, status);
      };
      const offerId = await seedOffer(s.prisma, w);
      const src = await seedContentSource(s.prisma, w);
      expect(offerId).toBeTruthy();
      ok(await A.get('status'), 200);
      ok(await A.postRaw('setup', {}), 200);
      ok(await A.get('params'), 200);
      ok(await A.get('params/niche/proposals'), 200);

      // Проекты
      const name = subredditName('aeg');
      const pr = await call<{ id: string; revision: number }>(
        'rx.createProject',
        201,
        A.post('rx/projects', { title: 'Egress', locale: 'en', market: 'US' }),
      );
      await call('rx.listProjects', 200, A.get('rx/projects'));
      await call('rx.getProject', 200, A.get(`rx/projects/${pr.id}`));
      await call(
        'rx.patchProject',
        200,
        A.patch(`rx/projects/${pr.id}`, {
          expectedRevision: pr.revision,
          title: 'Egress 2',
        }),
      );
      // Сообщества и правила
      const c = await call<{ id: string; revision: number }>(
        'rx.createCommunity',
        201,
        A.post('rx/communities', { projectId: pr.id, community: `r/${name}` }),
      );
      await call('rx.listCommunities', 200, A.get('rx/communities'));
      await call('rx.getCommunity', 200, A.get(`rx/communities/${c.id}`));
      await call(
        'rx.patchCommunity',
        200,
        A.patch(`rx/communities/${c.id}`, {
          expectedRevision: c.revision,
          descriptionManual: 'Owners Q&A',
        }),
      );
      const snap = await call<{ id: string }>(
        'rx.createRules',
        201,
        A.post(`rx/communities/${c.id}/rules`, rulesBody(name, 'restricted')),
      );
      await call('rx.listRules', 200, A.get(`rx/communities/${c.id}/rules`));
      await call(
        'rx.getRulesSource',
        200,
        A.get(`rx/communities/${c.id}/rules/${snap.id}/source`),
      );
      await call('rx.reviewRules', 200, A.post(`rx/rules/${snap.id}/review`));
      // Запросы
      const k = await call<{ id: string; revision: number }>(
        'rx.createKeyword',
        201,
        A.post('rx/keywords', {
          projectId: pr.id,
          phrase: 'site chat widget',
          intent: 'recommendation',
          priority: 3,
        }),
      );
      await call('rx.listKeywords', 200, A.get('rx/keywords'));
      await call(
        'rx.patchKeyword',
        200,
        A.patch(`rx/keywords/${k.id}`, {
          expectedRevision: k.revision,
          priority: 4,
        }),
      );
      // Возможности
      const opp = (title: string) =>
        A.post('rx/opportunities', {
          projectId: pr.id,
          communityId: c.id,
          threadUrl: threadUrl(name),
          titleManual: title,
          excerpt: 'Looking for a widget that answers from our docs only.',
          intent: 'recommendation',
          factors: factorsBody(),
        });
      const o = await call<{ id: string; revision: number }>(
        'rx.createOpportunity',
        201,
        opp('Which AI chat widget answers only from site content?'),
      );
      await call('rx.listOpportunities', 200, A.get('rx/opportunities'));
      const csv = await A.get('rx/opportunities', { format: 'csv' });
      expect(csv.status).toBe(200);
      await call('rx.getOpportunity', 200, A.get(`rx/opportunities/${o.id}`));
      await call(
        'rx.listOpportunityExcerpts',
        200,
        A.get(`rx/opportunities/${o.id}/excerpts`),
      );
      const o2 = await call<{ revision: number }>(
        'rx.patchOpportunity',
        200,
        A.patch(`rx/opportunities/${o.id}`, {
          expectedRevision: o.revision,
          angle: 'Show how answers stay on-site',
        }),
      );
      const o3 = await call<{ revision: number }>(
        'rx.scoreOpportunity',
        200,
        A.post(`rx/opportunities/${o.id}/score`, {
          expectedRevision: o2.revision,
        }),
      );
      await call(
        'rx.qualifyOpportunity',
        200,
        A.post(`rx/opportunities/${o.id}/qualify`, {
          expectedRevision: o3.revision,
        }),
      );
      const sk = ok<{ id: string; revision: number }>(
        (await opp('Skip me: what chat do you use?')) as never,
        201,
      );
      await call(
        'rx.skipOpportunity',
        200,
        A.post(`rx/opportunities/${sk.id}/skip`, {
          expectedRevision: sk.revision,
        }),
      );
      const ar = ok<{ id: string; revision: number }>(
        (await opp('Archive me: best chat widget?')) as never,
        201,
      );
      await call(
        'rx.archiveOpportunity',
        200,
        A.post(`rx/opportunities/${ar.id}/archive`, {
          expectedRevision: ar.revision,
        }),
      );
      // Брифы, генерация, материал
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
      const b = await call<{ id: string; revision: number }>(
        'rx.createBrief',
        201,
        A.post('rx/briefs', {
          projectId: pr.id,
          contentType: 'comment',
          opportunityId: o.id,
          objective: 'Help the author reuse one article',
          keyPoints,
          brand: 'Demo',
          language: 'en',
        }),
      );
      await call('rx.listBriefs', 200, A.get('rx/briefs'));
      await call('rx.getBrief', 200, A.get(`rx/briefs/${b.id}`));
      const b2 = await call<{ revision: number }>(
        'rx.patchBrief',
        200,
        A.patch(`rx/briefs/${b.id}`, {
          expectedRevision: b.revision,
          affiliation: 'founder',
        }),
      );
      await call(
        'rx.briefReady',
        200,
        A.post(`rx/briefs/${b.id}/ready`, { expectedRevision: b2.revision }),
      );
      ai.model.reply(redditDraftJson(2, 'comment', src));
      const g = await call<{
        callId: string;
        call: { output: { variants: Array<{ body: string }> } };
      }>(
        'rx.generateDraft',
        200,
        A.post(`rx/briefs/${b.id}/generate`, {
          template: 'helpful_answer',
          variants: 2,
        }),
      );
      const m = await call<{ content: { id: string } }>(
        'rx.createContent',
        201,
        A.post(`rx/briefs/${b.id}/contents`),
      );
      const cid = m.content.id;
      await call(
        'rx.listBriefContents',
        200,
        A.get(`rx/briefs/${b.id}/contents`),
      );
      await call('rx.getContent', 200, A.get(`rx/contents/${cid}`));
      const meta = {
        disclosure: DISCLOSURE,
        claimMap: [
          {
            text: 'One verified article can become a post, cards and a video script',
            sourceIds: [src],
          },
        ],
        uncertainties: [],
      };
      const d = await call<{ id: string; revision: number }>(
        'cx.createVersion',
        201,
        A.post(`cx/contents/${cid}/versions`, {
          body: g.call.output.variants[0].body,
          meta,
          aiCallId: g.callId,
          variantIndex: 0,
        }),
      );
      await call('cx.listVersions', 200, A.get(`cx/contents/${cid}/versions`));
      await call(
        'cx.getVersion',
        200,
        A.get(`cx/contents/${cid}/versions/${d.id}`),
      );
      const d2 = await call<{ id: string; revision: number }>(
        'cx.patchVersion',
        200,
        A.patch(`cx/contents/${cid}/versions/${d.id}`, {
          expectedRevision: d.revision,
          body: g.call.output.variants[1].body,
          aiCallId: g.callId,
          variantIndex: 1,
        }),
      );
      await call(
        'cx.diff',
        200,
        A.get(`cx/contents/${cid}/versions/${d2.id}/diff/${d2.id}`),
      );
      const v = await call<{ id: string; hash: string }>(
        'cx.submitVersion',
        200,
        A.post(`cx/contents/${cid}/versions/${d2.id}/submit`, {
          expectedRevision: d2.revision,
        }),
      );
      await call('rx.checkContent', 201, A.post(`rx/contents/${cid}/check`));
      for (const kind of ['editorial', 'technical'])
        await call(
          'cx.qaCheck',
          201,
          A.post(`cx/versions/${v.id}/qa-checks`, { kind, result: 'pass' }),
        );
      const qa = await call<{
        items: Array<{ kind: string; warnings: Array<{ code: string }> }>;
      }>('cx.listQa', 200, A.get(`cx/versions/${v.id}/qa-checks`));
      await call(
        'cx.approve',
        201,
        A.post(`cx/versions/${v.id}/approve`, {
          versionHash: v.hash,
          acknowledgedWarnings: (
            qa.items.filter((q) => q.kind === 'reddit_policy').pop()
              ?.warnings ?? []
          ).map((x) => x.code),
        }),
      );
      await call('rx.copyContent', 200, A.post(`rx/contents/${cid}/copy`));
      const oRow = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
        where: { id: o.id },
      });
      const pubv = await call<{ id: string }>(
        'rx.reportPublication',
        201,
        A.post(`rx/contents/${cid}/report-publication`, {
          url: `https://www.reddit.com/r/${name}/comments/${oRow.threadKey}/x/k1aeg/`,
          postedAt: new Date().toISOString(),
        }),
      );
      await call('rx.listPublications', 200, A.get('rx/publications'));
      // v1.2: опрос вызова AI, снятие отметки, отзыв согласования.
      await call('cx.getCall', 200, A.get(`cx/ai/calls/${g.callId}`));
      const pubRow = await s.prisma.pubPublication.findUniqueOrThrow({
        where: { id: pubv.id },
      });
      await call(
        'cx.publicationTransition',
        200,
        A.post(`cx/publications/${pubv.id}/transition`, {
          to: 'withdrawn',
          expectedRevision: pubRow.revision,
          reason: 'Пост видалено',
        }),
      );
      const apprRow = await s.prisma.pubApproval.findFirstOrThrow({
        where: { objectId: v.id, status: 'active' },
      });
      await call(
        'cx.revokeApproval',
        200,
        A.post(`cx/approvals/${apprRow.id}/revoke`, {
          reason: 'Правила спільноти змінились',
        }),
      );
      // v1.2: источники, оффер, факты бренда.
      await call('cx.listSources', 200, A.get('cx/sources'));
      await call(
        'cx.createSource',
        201,
        A.post('cx/sources', {
          kind: 'manual_text',
          title: 'Нотатка платформи',
          fragment: 'Факт для тез брифу.',
          visibility: 'private',
          usage: 'allowed',
        }),
      );
      const snapRow = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
        where: { id: snap.id },
      });
      await call(
        'cx.revokeSource',
        200,
        A.post(`cx/sources/${snapRow.sourceId}/revoke`, {
          reason: 'Першоджерело застаріло',
        }),
      );
      await call('cx.listOffers', 200, A.get('cx/offers'));
      const of = await call<{ id: string }>(
        'cx.createOffer',
        201,
        A.post('cx/offers', {
          title: 'Оффер платформи',
          text: 'Ручний режим.',
        }),
      );
      await call(
        'cx.activateOffer',
        200,
        A.post(`cx/offers/${of.id}/activate`, {
          basis: 'Затверджено оператором платформи',
        }),
      );
      await call('cx.listFacts', 200, A.get('cx/brand-facts'));
      const f1 = await call<{ fact: { id: string } }>(
        'cx.createFact',
        201,
        A.post('cx/brand-facts', {
          factKey: 'platform.mode',
          kind: 'fact',
          value: { text: 'Лише ручне копіювання' },
        }),
      );
      await call(
        'cx.activateFact',
        200,
        A.post(`cx/brand-facts/${f1.fact.id}/activate`, {
          basis: 'Підтверджено оператором',
        }),
      );
      const f2 = ok<{ fact: { id: string; conflictWithId: string | null } }>(
        (await A.post('cx/brand-facts', {
          factKey: 'platform.mode',
          kind: 'fact',
          value: { text: 'Ручне копіювання і чернетки' },
        })) as never,
        201,
      );
      await call(
        'cx.resolveFact',
        200,
        A.post(`cx/brand-facts/${f2.fact.id}/resolve`, {
          keepId: f1.fact.id,
          reason: 'Залишаємо чинне формулювання',
        }),
      );
      await call(
        'cx.retireFact',
        200,
        A.post(`cx/brand-facts/${f1.fact.id}/retire`, {
          reason: 'Формулювання застаріло',
        }),
      );
      // Второй материал (post) — «вернуть на доработку»; архив брифа и проекта.
      const pb = ok<{ id: string; revision: number }>(
        (await A.post('rx/briefs', {
          projectId: pr.id,
          contentType: 'post',
          communityId: c.id,
          objective: 'Teach the method',
          keyPoints,
          affiliation: 'founder',
          brand: 'Demo',
          language: 'en',
        })) as never,
        201,
      );
      ok(
        (await A.post(`rx/briefs/${pb.id}/ready`, {
          expectedRevision: pb.revision,
        })) as never,
        200,
      );
      const pm = ok<{ content: { id: string } }>(
        (await A.post(`rx/briefs/${pb.id}/contents`)) as never,
        201,
      );
      const pd = ok<{ id: string; revision: number }>(
        (await A.post(`cx/contents/${pm.content.id}/versions`, {
          title: 'One article, several formats',
          body: versionBody(),
          meta,
        })) as never,
        201,
      );
      ok(
        (await A.post(`cx/contents/${pm.content.id}/versions/${pd.id}/submit`, {
          expectedRevision: pd.revision,
        })) as never,
        200,
      );
      const pc = await s.prisma.pubContent.findUniqueOrThrow({
        where: { id: pm.content.id },
      });
      await call(
        'cx.transition',
        200,
        A.post(`cx/contents/${pm.content.id}/transition`, {
          expectedRevision: pc.revision,
          to: 'changes_requested',
          reason: 'Уточнити приклад',
        }),
      );
      const ab = ok<{ id: string; revision: number }>(
        (await A.post('rx/briefs', {
          projectId: pr.id,
          contentType: 'post',
          communityId: c.id,
          objective: 'Archive this brief',
        })) as never,
        201,
      );
      await call(
        'rx.archiveBrief',
        200,
        A.post(`rx/briefs/${ab.id}/archive`, { expectedRevision: ab.revision }),
      );
      const p2 = ok<{ id: string; revision: number }>(
        (await A.post('rx/projects', {
          title: 'Egress archive',
          locale: 'en',
          market: 'US',
        })) as never,
        201,
      );
      const p3 = await call<{ revision: number }>(
        'rx.archiveProject',
        200,
        A.post(`rx/projects/${p2.id}/archive`, {
          expectedRevision: p2.revision,
        }),
      );
      await call(
        'rx.restoreProject',
        200,
        A.post(`rx/projects/${p2.id}/restore`, {
          expectedRevision: p3.revision,
        }),
      );
      // Импорт (dry-run) — тоже без сети.
      ok(
        (await A.postRaw('import/plan', {
          communitiesCsv: `name,url,topic,size,promotion_policy,links_policy,flair_required,conditions,source_url,checked_at
r/${name},https://www.reddit.com/r/${name}/,Owners,null,unknown,unknown,null,,https://www.reddit.com/r/${name}/about/rules,2026-10-13
`,
          opportunitiesCsv: '',
          keywordsCsv: '',
          projectTitle: 'Egress',
          locale: 'en',
          market: 'US',
        })) as never,
        200,
      );

      expect([...used].sort()).toEqual(
        [
          ...RX_ROUTES.map((r) => `rx.${r.name}`),
          ...CX_ROUTES.map((r) => `cx.${r.name}`),
        ].sort(),
      );
      expect(net.outbound).toEqual([]);
      expect(net.foreign()).toEqual([]);
      expect(
        [...net.sockets, ...net.lookups].some((h) => /redd/i.test(h)),
      ).toBe(false);
    });
  },
);
