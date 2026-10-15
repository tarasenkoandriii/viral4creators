/**
 * [P-R-ADM] Аудит Reddit-подсистемы 15.10.2026, зона «adm»:
 *  - adm-1: строка журнала доступа Админки есть СРАЗУ после ответа (пишется
 *    до его завершения — без ожидания события `finish`);
 *  - adm-2: опрос `cx/ai/calls/:callId` и нераспознанные пути попадают в
 *    журнал (`cx/ai/calls/:callId`, `unknown`); триггер журнала принимает
 *    все шаблоны маршрутов (71 + значения неизвестного пути) и отвергает
 *    мусор;
 *  - adm-7: изоляция внутри ОДНОГО кабинета — второй сайт и второй продукт
 *    того же кабинета, что и платформенный: id его объектов в пути и в теле —
 *    тот же отказ, что у несуществующего id (404 и т.п.), без записей; в
 *    query-фильтре — тот же ответ, что у несуществующего id (пустой список);
 *    курсор `before` — граница сравнения id, в ответе только свои записи.
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { accessRouteTemplates } from '../../modules/publisher/reddit/admin/admin-access-log';
import {
  adminApi,
  useAdminEnv,
  type AdminApi,
} from '../../modules/publisher/reddit/testing/admin-kit.testing';
import {
  api,
  approvedVersion,
  draftVersion,
  ok,
  openRedditPublish,
  redditStack,
  redditWorld,
  seedStudio,
  subredditName,
  type RedditStack,
  type RedditWorld,
  type StudioIds,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';
import {
  seedMembers,
  seedProduct,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(300_000);

const ghost = () =>
  `c${randomUUID().replace(/-/g, '').slice(0, 24)}`.replace(/[0-9]/g, 'z');
const opId = () => `op${randomUUID().replace(/-/g, '').slice(0, 20)}`;

const shape = (r: { status: number; body: unknown }) => {
  const b = r.body as { error?: { code?: string; details?: unknown } };
  return {
    status: r.status,
    code: b?.error?.code ?? null,
    details: b?.error?.details ?? null,
  };
};

ciDescribe(
  '[P-R-ADM] аудит 15.10.2026: журнал доступа и изоляция внутри кабинета',
  () => {
    let s: RedditStack;
    let wa: RedditWorld;
    /** Второй сайт и продукт ТОГО ЖЕ кабинета (не платформенный). */
    let w2: RedditWorld;
    let A: AdminApi;
    let restore: () => void;
    let own: StudioIds & { versionId: string };
    let p2: StudioIds & {
      versionId: string;
      approvalId: string;
      publicationId: string;
      sourceRedditId: string;
      offerId: string;
      factId: string;
    };

    /** Число строк `pub_*` продукта (без побочных эффектов). */
    async function rows(productId: string): Promise<Record<string, number>> {
      const out: Record<string, number> = {};
      const tables = await s.prisma.$queryRaw<Array<{ t: string }>>`
      SELECT c.table_name AS t FROM information_schema.columns c
       WHERE c.table_schema = 'sites' AND c.table_name LIKE 'pub\\_%'
         AND c.column_name = 'productId'
         AND EXISTS (SELECT 1 FROM information_schema.tables x
                      WHERE x.table_schema = 'sites' AND x.table_name = c.table_name
                        AND x.table_type = 'BASE TABLE')
       ORDER BY 1`;
      for (const { t } of tables) {
        const [r] = await s.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM "sites"."${t}" WHERE "productId" = $1`,
          productId,
        );
        out[t] = Number(r.n);
      }
      return out;
    }

    beforeAll(async () => {
      s = await redditStack();
      wa = await redditWorld(s, 'working');
      const site2 = await s.prisma.site.create({
        data: { accountId: wa.acc.accountId, name: 'Другий сайт кабінету' },
      });
      const product2 = await seedProduct(s.prisma, {
        accountId: wa.acc.accountId,
        siteId: site2.id,
        kind: 'working',
      });
      w2 = {
        acc: { ...wa.acc, siteId: site2.id },
        product: product2,
        team: await seedMembers(s.prisma, product2, wa.acc.owner),
        P: `/publisher/products/${product2.id}/reddit`,
      };
      await openRedditPublish(s.prisma, wa);
      await openRedditPublish(s.prisma, w2);

      // Объекты второго продукта — кабинетом (и Админкой, пока платформа — сайт 2).
      const ed2 = api(s, wa.acc.accountId, w2.team.editor);
      const po2 = api(s, wa.acc.accountId, w2.team.product_owner);
      const ids2 = await seedStudio(s, w2, ed2, po2);
      const v2 = await approvedVersion(ed2, po2, w2, ids2);
      const appr = await s.prisma.pubApproval.findFirstOrThrow({
        where: { objectId: v2.id, status: 'active' },
      });
      const op2 = api(s, wa.acc.accountId, w2.team.operator);
      ok(await op2.post(`${w2.P}/contents/${ids2.contentId}/copy`), 200);
      const opp = await s.prisma.pubRedditOpportunity.findUniqueOrThrow({
        where: { id: ids2.opportunityId! },
      });
      const pub = ok<{ id: string }>(
        await op2.post(
          `${w2.P}/contents/${ids2.contentId}/report-publication`,
          {
            url: `https://www.reddit.com/r/${ids2.name}/comments/${opp.threadKey}/x/k2adm/`,
            postedAt: new Date().toISOString(),
          },
        ),
        201,
      );
      const snap = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
        where: { id: ids2.snapshotId! },
      });
      const back = useAdminEnv(site2.id);
      const A2 = adminApi(s);
      const fact = ok<{ fact?: { id: string }; id?: string }>(
        await A2.post('cx/brand-facts', {
          factKey: 'site2.since',
          kind: 'fact',
          value: { text: 'Другий сайт працює з 2025 року' },
        }),
        201,
      );
      const offer = ok<{ id: string }>(
        await A2.post('cx/offers', {
          title: 'Другий сайт: оффер',
          text: 'Чернетка оффера другого сайту.',
        }),
        201,
      );
      back();
      p2 = {
        ...ids2,
        versionId: v2.id,
        approvalId: appr.id,
        publicationId: pub.id,
        sourceRedditId: snap.sourceId!,
        offerId: offer.id,
        factId: fact.fact?.id ?? fact.id!,
      };

      // Платформенный продукт — первый сайт кабинета.
      restore = useAdminEnv(wa.acc.siteId);
      A = adminApi(s);
      const ed = api(s, wa.acc.accountId, wa.team.editor);
      const po = api(s, wa.acc.accountId, wa.team.product_owner);
      const ids = await seedStudio(s, wa, ed, po);
      const v = await draftVersion(ed, wa, ids);
      own = { ...ids, versionId: v.id };
    });
    afterAll(async () => {
      restore?.();
      await s?.close();
    });

    it('adm-7: id объектов второго продукта того же кабинета в пути — как несуществующие, без записей', async () => {
      const before = {
        a: await rows(wa.product.id),
        b: await rows(w2.product.id),
      };
      const g = ghost();
      const cases: Array<
        [
          string,
          string,
          (id: string) => Promise<{ status: number; body: unknown }>,
        ]
      > = [
        ['getProject', p2.projectId, (id) => A.get(`rx/projects/${id}`)],
        [
          'patchProject',
          p2.projectId,
          (id) =>
            A.patch(`rx/projects/${id}`, { expectedRevision: 1, title: 'x' }),
        ],
        [
          'archiveProject',
          p2.projectId,
          (id) => A.post(`rx/projects/${id}/archive`, { expectedRevision: 1 }),
        ],
        ['getCommunity', p2.communityId, (id) => A.get(`rx/communities/${id}`)],
        [
          'listRules',
          p2.communityId,
          (id) => A.get(`rx/communities/${id}/rules`),
        ],
        [
          'getRulesSource',
          p2.communityId,
          (id) => A.get(`rx/communities/${id}/rules/${p2.snapshotId}/source`),
        ],
        [
          'reviewRules',
          p2.snapshotId!,
          (id) => A.post(`rx/rules/${id}/review`),
        ],
        [
          'getOpportunity',
          p2.opportunityId!,
          (id) => A.get(`rx/opportunities/${id}`),
        ],
        [
          'excerpts',
          p2.opportunityId!,
          (id) => A.get(`rx/opportunities/${id}/excerpts`),
        ],
        [
          'skipOpportunity',
          p2.opportunityId!,
          (id) =>
            A.post(`rx/opportunities/${id}/skip`, {
              expectedRevision: 1,
              reason: 'xxxxxxxxxx',
            }),
        ],
        ['getBrief', p2.briefId, (id) => A.get(`rx/briefs/${id}`)],
        [
          'briefContents',
          p2.briefId,
          (id) => A.get(`rx/briefs/${id}/contents`),
        ],
        [
          'createContent',
          p2.briefId,
          (id) => A.post(`rx/briefs/${id}/contents`),
        ],
        ['getContent', p2.contentId, (id) => A.get(`rx/contents/${id}`)],
        [
          'checkContent',
          p2.contentId,
          (id) => A.post(`rx/contents/${id}/check`),
        ],
        ['copy', p2.contentId, (id) => A.post(`rx/contents/${id}/copy`)],
        [
          'cx versions',
          p2.contentId,
          (id) => A.get(`cx/contents/${id}/versions`),
        ],
        [
          'cx getVersion',
          p2.contentId,
          (id) => A.get(`cx/contents/${id}/versions/${p2.versionId}`),
        ],
        [
          'cx createVersion',
          p2.contentId,
          (id) => A.post(`cx/contents/${id}/versions`, { body: 'x' }),
        ],
        [
          'cx transition',
          p2.contentId,
          (id) =>
            A.post(`cx/contents/${id}/transition`, {
              expectedRevision: 1,
              to: 'changes_requested',
              reason: 'xxxxxxxxxx',
            }),
        ],
        [
          'cx qa list',
          p2.versionId,
          (id) => A.get(`cx/versions/${id}/qa-checks`),
        ],
        [
          'cx qa',
          p2.versionId,
          (id) =>
            A.post(`cx/versions/${id}/qa-checks`, {
              kind: 'editorial',
              result: 'pass',
            }),
        ],
        [
          'cx approve',
          p2.versionId,
          (id) => A.post(`cx/versions/${id}/approve`, { versionHash: 'x' }),
        ],
        [
          'cx revokeApproval',
          p2.approvalId,
          (id) => A.post(`cx/approvals/${id}/revoke`, { reason: 'Перевірка' }),
        ],
        [
          'cx revokeSource',
          p2.sourceRedditId,
          (id) => A.post(`cx/sources/${id}/revoke`, { reason: 'Перевірка' }),
        ],
        [
          'cx withdraw',
          p2.publicationId,
          (id) =>
            A.post(`cx/publications/${id}/transition`, {
              to: 'withdrawn',
              expectedRevision: 1,
              reason: 'xxxxxxxxxx',
            }),
        ],
        [
          'cx activateOffer',
          p2.offerId,
          (id) => A.post(`cx/offers/${id}/activate`, { basis: 'xxxxxxxxxxxx' }),
        ],
        [
          'cx activateFact',
          p2.factId,
          (id) =>
            A.post(`cx/brand-facts/${id}/activate`, { basis: 'xxxxxxxxxxxx' }),
        ],
        [
          'cx resolveFact',
          p2.factId,
          (id) =>
            A.post(`cx/brand-facts/${id}/resolve`, {
              keepId: id,
              reason: 'Перевірка ізоляції',
            }),
        ],
        [
          'cx retireFact',
          p2.factId,
          (id) =>
            A.post(`cx/brand-facts/${id}/retire`, {
              reason: 'Перевірка ізоляції',
            }),
        ],
      ];
      const bad: unknown[] = [];
      for (const [name, id, call] of cases) {
        const f = shape(await call(id));
        const n = shape(await call(g));
        if (f.status !== 404 || JSON.stringify(f) !== JSON.stringify(n))
          bad.push({ name, foreign: f, ghost: n });
      }
      expect(bad).toEqual([]);
      expect(await rows(w2.product.id)).toEqual(before.b);
      expect(await rows(wa.product.id)).toEqual(before.a);
    });

    it('adm-7: id второго продукта в теле (проект, сообщество, возможность) — тот же отказ, что у несуществующего, без записей', async () => {
      const before = {
        a: await rows(wa.product.id),
        b: await rows(w2.product.id),
      };
      const brief = (extra: Record<string, unknown>) => ({
        contentType: 'comment',
        objective: 'Help the author reuse one article across formats',
        audience: 'Small business owners',
        keyPoints: [{ text: 'One point', sourceIds: 'needs_verification' }],
        affiliation: 'founder',
        brand: 'Demo',
        linksAllowed: false,
        language: 'en',
        ...extra,
      });
      const cases: Array<
        [string, string, (id: string) => Record<string, unknown>, string]
      > = [
        [
          'createCommunity.projectId',
          'rx/communities',
          (id) => ({ projectId: id, community: `r/${subredditName('iso')}` }),
          p2.projectId,
        ],
        [
          'createKeyword.projectId',
          'rx/keywords',
          (id) => ({
            projectId: id,
            phrase: 'site assistant',
            intent: 'how_to',
            priority: 3,
          }),
          p2.projectId,
        ],
        [
          'createOpportunity.communityId',
          'rx/opportunities',
          (id) => ({
            projectId: own.projectId,
            communityId: id,
            threadUrl: `https://www.reddit.com/r/${own.name}/comments/zz${opId().slice(2, 7)}/x/`,
            titleManual: 'Which AI chat widget answers only from site content?',
            excerpt: 'Looking for a widget that answers from our docs.',
            intent: 'recommendation',
          }),
          p2.communityId,
        ],
        [
          'createBrief.opportunityId',
          'rx/briefs',
          (id) => brief({ projectId: own.projectId, opportunityId: id }),
          p2.opportunityId!,
        ],
        [
          'createBrief.communityId',
          'rx/briefs',
          (id) =>
            brief({
              projectId: own.projectId,
              contentType: 'post',
              communityId: id,
            }),
          p2.communityId,
        ],
        [
          'createBrief.projectId',
          'rx/briefs',
          (id) =>
            brief({
              projectId: id,
              contentType: 'post',
              communityId: own.communityId,
            }),
          p2.projectId,
        ],
      ];
      const bad: unknown[] = [];
      for (const [name, path, body, id] of cases) {
        const f = shape(await A.post(path, body(id)));
        const n = shape(await A.post(path, body(ghost())));
        // «Нет такого»: 404 или 400 `not_found` именно по этому полю.
        const field = name.split('.')[1];
        const notFound =
          f.status === 404 ||
          JSON.stringify(f.details) ===
            JSON.stringify({ fields: [{ field, code: 'not_found' }] });
        if (!notFound || JSON.stringify(f) !== JSON.stringify(n))
          bad.push({ name, foreign: f, ghost: n });
      }
      expect(bad).toEqual([]);
      expect(await rows(w2.product.id)).toEqual(before.b);
      expect(await rows(wa.product.id)).toEqual(before.a);
    });

    it('adm-7: id второго продукта в query — тот же ответ, что у несуществующего (пустой список); списки — только платформенный продукт', async () => {
      const p2ids = [
        p2.projectId,
        p2.communityId,
        p2.opportunityId!,
        p2.briefId,
        p2.contentId,
        p2.publicationId,
        p2.sourceId,
        p2.sourceRedditId,
        p2.offerId,
        p2.factId,
      ];
      const items = (r: { body: unknown }) =>
        JSON.stringify(
          (
            (r.body as { data?: { items?: Array<{ id: string }> } }).data
              ?.items ?? []
          ).map((x) => x.id),
        );
      const g = ghost();
      for (const [path, key, id] of [
        ['rx/communities', 'projectId', p2.projectId],
        ['rx/opportunities', 'communityId', p2.communityId],
        ['rx/opportunities', 'projectId', p2.projectId],
        ['rx/keywords', 'projectId', p2.projectId],
        ['rx/briefs', 'projectId', p2.projectId],
        ['rx/briefs', 'communityId', p2.communityId],
      ] as const) {
        const f = await A.get(path, { [key]: id });
        const n = await A.get(path, { [key]: g });
        expect({ path, key, status: f.status, items: items(f) }).toEqual({
          path,
          key,
          status: n.status,
          items: items(n),
        });
      }
      // `before` — курсор сравнения id (`id < before`), а не ссылка на объект:
      // id второго продукта — просто граница, в ответе только свои записи.
      const page = await A.get('rx/projects', { before: p2.projectId });
      expect(page.status).toBe(200);
      for (const id of p2ids) expect(items(page)).not.toContain(id);
      for (const path of [
        'rx/projects',
        'rx/communities',
        'rx/opportunities',
        'rx/briefs',
        'rx/publications',
        'cx/sources',
        'cx/offers',
        'cx/brand-facts',
      ]) {
        const text = JSON.stringify(ok(await A.get(path), 200));
        for (const id of p2ids)
          expect({ path, leaked: text.includes(id) ? id : null }).toEqual({
            path,
            leaked: null,
          });
      }
    });

    it('adm-1, adm-2: строка журнала — сразу после ответа; опрос AI и нераспознанный путь — в журнале', async () => {
      const actor = opId();
      const B = adminApi(s, { actor });
      const call = ghost();
      expect((await B.get(`cx/ai/calls/${call}`)).status).toBe(404);
      // Без ожидания: строка записана до завершения ответа.
      let got = await s.prisma.pubRedditAdminAccessLog.findMany({
        where: { actor: `admin:${actor}` },
      });
      expect(got.map((r) => `${r.method} ${r.route} ${r.status}`)).toEqual([
        'GET cx/ai/calls/:callId 404',
      ]);
      expect(JSON.stringify(got)).not.toContain(call);
      // Nest сопоставляет без учёта регистра, журнал — «unknown».
      const st = await B.get('STATUS');
      got = await s.prisma.pubRedditAdminAccessLog.findMany({
        where: { actor: `admin:${actor}` },
        orderBy: { at: 'asc' },
      });
      expect(got.map((r) => `${r.method} ${r.route} ${r.status}`)).toEqual([
        'GET cx/ai/calls/:callId 404',
        `GET unknown ${st.status}`,
      ]);
      await B.get(`rx/projects/${own.projectId}`);
      got = await s.prisma.pubRedditAdminAccessLog.findMany({
        where: { actor: `admin:${actor}` },
      });
      expect(got.map((r) => r.route)).toContain('rx/projects/:id');
    });

    it('adm-2: триггер журнала принимает все шаблоны маршрутов и значения неизвестного пути; мусор — 23514', async () => {
      const actor = `admin:${opId()}`;
      const all = accessRouteTemplates();
      expect(all.length).toBeGreaterThanOrEqual(74);
      const failed: string[] = [];
      for (const route of all) {
        try {
          await s.prisma.pubRedditAdminAccessLog.create({
            data: { actor, method: 'GET', route, status: 200 },
          });
        } catch {
          failed.push(route);
        }
      }
      expect(failed).toEqual([]);
      expect(
        await s.prisma.pubRedditAdminAccessLog.count({ where: { actor } }),
      ).toBe(all.length);
      for (const route of ['?', '/status', 'rx/a b', 'x'.repeat(201)])
        await expect(
          s.prisma.pubRedditAdminAccessLog.create({
            data: { actor, method: 'GET', route, status: 200 },
          }),
        ).rejects.toThrow(/23514|pub_/);
      // 499 «клиент ушёл» — допустимый статус.
      await s.prisma.pubRedditAdminAccessLog.create({
        data: { actor, method: 'POST', route: 'import/apply', status: 499 },
      });
    });
  },
);
