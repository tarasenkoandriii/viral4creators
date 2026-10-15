/**
 * [P-R-ADM] Изоляция и закрытый список действий вкладки «Reddit» Админки
 * (Р-RD-ADM-1, Р-RD-ADM-2):
 *  - Админка видит ТОЛЬКО платформенный продукт: объекты чужого кабинета по
 *    id — тот же 404, что несуществующие, без записей; списки — только свои;
 *  - статья P0 платформенного продукта через `cx/*` недоступна (404, как
 *    несуществующая) — студия Админки только для Reddit-материалов;
 *  - запрещённое недоступно при любых ролях синтетического членства:
 *    раскрытие контактов, роли, бэкапы и восстановление, бюджеты, источники,
 *    бренд, продукт — `can()` false, `runOperation`/`recordRead` — 403 без
 *    записей; параметры вне гейта `reddit_publish` и P-R — 404; QA кроме
 *    editorial/technical — 400.
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  Kit,
  approvedArticle,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import {
  ADMIN_REDDIT_ACTIONS,
  adminMembership,
  adminRedditAccess,
} from '../../modules/publisher/core/admin-actor';
import { PubOperations } from '../../modules/publisher/core/operation';
import {
  PUB_ACTIONS,
  allowedActions,
  can,
  type PubAction,
} from '../../modules/publisher/core/roles';
import {
  ADMIN_USER,
  adminApi,
  useAdminEnv,
  type AdminApi,
} from '../../modules/publisher/reddit/testing/admin-kit.testing';
import {
  api,
  draftVersion,
  ok,
  redditStack,
  redditWorld,
  seedStudio,
  type RedditStack,
  type RedditWorld,
  type StudioIds,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(300_000);

const ghost = () =>
  `c${randomUUID().replace(/-/g, '').slice(0, 24)}`.replace(/[0-9]/g, 'z');

const shape = (r: { status: number; body: unknown }) => {
  const b = r.body as { error?: { code?: string; details?: unknown } };
  return {
    status: r.status,
    code: b?.error?.code ?? null,
    details: b?.error?.details ?? null,
  };
};

ciDescribe(
  '[P-R-ADM] Админка: только платформенный продукт, закрытый список действий',
  () => {
    let s: RedditStack;
    let wa: RedditWorld;
    let wb: RedditWorld;
    let A: AdminApi;
    let restore: () => void;
    let foreign: StudioIds & { versionId: string };
    let own: StudioIds & { versionId: string };
    let article: { contentId: string; versionId: string };

    async function studio(w: RedditWorld) {
      const ed = api(s, w.acc.accountId, w.team.editor);
      const po = api(s, w.acc.accountId, w.team.product_owner);
      const ids = await seedStudio(s, w, ed, po);
      const v = await draftVersion(ed, w, ids);
      return { ...ids, versionId: v.id };
    }

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
      wb = await redditWorld(s, 'working');
      restore = useAdminEnv(wa.acc.siteId);
      A = adminApi(s);
      foreign = await studio(wb);
      own = await studio(wa);
      const art = await approvedArticle(
        new Kit(s as unknown as ContentStack, wa.acc, wa.product),
      );
      article = { contentId: art.content.id, versionId: art.version.id };
    });
    afterAll(async () => {
      restore?.();
      await s?.close();
    });

    it('объекты чужого кабинета — как несуществующие (404), списки — только платформенный продукт, без записей', async () => {
      const before = {
        a: await rows(wa.product.id),
        b: await rows(wb.product.id),
      };
      const g = ghost();
      const cases: Array<
        [string, (id: string) => Promise<{ status: number; body: unknown }>]
      > = [
        ['getProject', (id) => A.get(`rx/projects/${id}`)],
        [
          'patchProject',
          (id) =>
            A.patch(`rx/projects/${id}`, { expectedRevision: 1, title: 'x' }),
        ],
        ['getCommunity', (id) => A.get(`rx/communities/${id}`)],
        ['listRules', (id) => A.get(`rx/communities/${id}/rules`)],
        ['reviewRules', (id) => A.post(`rx/rules/${id}/review`)],
        ['getOpportunity', (id) => A.get(`rx/opportunities/${id}`)],
        [
          'qualify',
          (id) =>
            A.post(`rx/opportunities/${id}/qualify`, { expectedRevision: 1 }),
        ],
        ['getBrief', (id) => A.get(`rx/briefs/${id}`)],
        [
          'generate',
          (id) =>
            A.post(`rx/briefs/${id}/generate`, { template: 'helpful_answer' }),
        ],
        ['createContent', (id) => A.post(`rx/briefs/${id}/contents`)],
        ['getContent', (id) => A.get(`rx/contents/${id}`)],
        ['copy', (id) => A.post(`rx/contents/${id}/copy`)],
        ['cx versions', (id) => A.get(`cx/contents/${id}/versions`)],
        [
          'cx createVersion',
          (id) => A.post(`cx/contents/${id}/versions`, { body: 'x' }),
        ],
        ['cx qa list', (id) => A.get(`cx/versions/${id}/qa-checks`)],
        [
          'cx qa',
          (id) =>
            A.post(`cx/versions/${id}/qa-checks`, {
              kind: 'editorial',
              result: 'pass',
            }),
        ],
        [
          'cx approve',
          (id) => A.post(`cx/versions/${id}/approve`, { versionHash: 'x' }),
        ],
      ];
      const ids: Record<string, string> = {
        getProject: foreign.projectId,
        patchProject: foreign.projectId,
        getCommunity: foreign.communityId,
        listRules: foreign.communityId,
        reviewRules: foreign.snapshotId!,
        getOpportunity: foreign.opportunityId!,
        qualify: foreign.opportunityId!,
        getBrief: foreign.briefId,
        generate: foreign.briefId,
        createContent: foreign.briefId,
        getContent: foreign.contentId,
        copy: foreign.contentId,
        'cx versions': foreign.contentId,
        'cx createVersion': foreign.contentId,
        'cx qa list': foreign.versionId,
        'cx qa': foreign.versionId,
        'cx approve': foreign.versionId,
      };
      const bad: unknown[] = [];
      for (const [name, call] of cases) {
        const f = shape(await call(ids[name]));
        const n = shape(await call(g));
        // Тот же отказ, что у несуществующего id (генерация при выключенном
        // AI — 409 до поиска брифа, как в кабинете); 2xx — утечка.
        if (
          f.status < 400 ||
          (name !== 'generate' && f.status !== 404) ||
          JSON.stringify(f) !== JSON.stringify(n)
        )
          bad.push({ name, foreign: f, ghost: n });
      }
      expect(bad).toEqual([]);
      for (const [path, id] of [
        ['rx/projects', own.projectId],
        ['rx/communities', own.communityId],
        ['rx/briefs', own.briefId],
        ['rx/opportunities', own.opportunityId!],
      ] as const) {
        const items = ok<{ items: Array<{ id: string }> }>(
          await A.get(path),
          200,
        ).items.map((x) => x.id);
        expect(items).toContain(id);
        for (const fid of [
          foreign.projectId,
          foreign.communityId,
          foreign.briefId,
          foreign.opportunityId,
        ])
          expect(items).not.toContain(fid);
      }
      expect(await rows(wb.product.id)).toEqual(before.b);
      expect(await rows(wa.product.id)).toEqual(before.a);
    });

    it('статья P0 платформенного продукта через cx — 404 (как несуществующая); Reddit-материал — доступен', async () => {
      const before = await rows(wa.product.id);
      const g = ghost();
      const pairs: Array<[string, string]> = [
        [
          `cx/contents/${article.contentId}/versions`,
          `cx/contents/${g}/versions`,
        ],
        [
          `cx/contents/${article.contentId}/versions/${article.versionId}`,
          `cx/contents/${g}/versions/${article.versionId}`,
        ],
        [
          `cx/versions/${article.versionId}/qa-checks`,
          `cx/versions/${g}/qa-checks`,
        ],
        [`rx/contents/${article.contentId}`, `rx/contents/${g}`],
      ];
      for (const [art, gh] of pairs) {
        const a = shape(await A.get(art));
        expect({ art, ...a }).toEqual({ art, ...shape(await A.get(gh)) });
        expect(a.status).toBe(404);
      }
      for (const [art, gh] of [
        [
          `cx/versions/${article.versionId}/approve`,
          `cx/versions/${g}/approve`,
        ],
        [
          `cx/versions/${article.versionId}/qa-checks`,
          `cx/versions/${g}/qa-checks`,
        ],
        [
          `cx/contents/${article.contentId}/transition`,
          `cx/contents/${g}/transition`,
        ],
        [
          `cx/contents/${article.contentId}/versions`,
          `cx/contents/${g}/versions`,
        ],
      ]) {
        const body = {
          kind: 'editorial',
          result: 'pass',
          to: 'changes_requested',
          reason: 'xxxxxxxxxx',
          expectedRevision: 1,
        };
        const a = shape(await A.post(art, body));
        expect({ art, ...a }).toEqual({
          art,
          ...shape(await A.post(gh, body)),
        });
        expect(a.status).toBe(404);
      }
      expect(await rows(wa.product.id)).toEqual(before);
      // Reddit-материал того же продукта — доступен.
      ok(await A.get(`cx/contents/${own.contentId}/versions`), 200);
      ok(await A.get(`cx/versions/${own.versionId}/qa-checks`), 200);
    });

    it('QA вне editorial/technical — 400; параметры вне гейта reddit_publish и P-R — 404', async () => {
      for (const kind of [
        'adaptation_meaning',
        'ai_review',
        'reddit_policy',
        undefined,
      ]) {
        const r = await A.post(`cx/versions/${own.versionId}/qa-checks`, {
          kind,
          result: 'pass',
        });
        expect({ kind, ...shape(r) }).toEqual({
          kind,
          status: 400,
          code: 'PUB_VALIDATION',
          details: { fields: [{ field: 'kind', code: 'enum' }] },
        });
      }
      // v1.4: ключи ai_use и бюджета месяца AI — Админке доступны; прочие
      // (сайт, лиды, закупки, отчёты) — 404 без подробностей
      for (const key of [
        'retention_policy',
        'domain_host',
        'rates_by_role',
        'allowed_cpl_inputs',
        'nope',
      ]) {
        for (const r of [
          await A.get(`params/${key}/proposals`),
          await A.post(`params/${key}/propose`, { value: {} }),
          await A.post(`params/${key}/decide`, {
            toStatus: 'approved',
            basis: 'xxxxxxxxxxxx',
          }),
        ])
          expect({ key, ...shape(r) }).toEqual({
            key,
            status: 404,
            code: 'PUB_NOT_FOUND',
            details: null,
          });
      }
      const p = ok<{ items: Array<{ key: string }> }>(
        await A.get('params'),
        200,
      );
      expect(p.items.map((x) => x.key).sort()).toEqual([
        'ai_budget_usd_month',
        'ai_fx_rate',
        'ai_unpriced_allowed',
        'budget_split',
        'budget_total',
        'language',
        'market',
        'niche',
        'offer_active_version',
        'per_purchase_max',
        'reddit_excerpt_retention_days',
        'reddit_rules_stale_days',
        'responsibles',
      ]);
    });

    it('закрытый список действий: раскрытие контактов, роли, бэкапы, бюджеты и прочее P0 — запрещены при ролях PO+ED+OP+AN; сервисный уровень — 403 без записей', async () => {
      const access = adminRedditAccess(ADMIN_USER);
      expect([...access.roles].sort()).toEqual([
        'analyst',
        'editor',
        'operator',
        'product_owner',
      ]);
      expect(allowedActions(access).sort()).toEqual(
        [...ADMIN_REDDIT_ACTIONS].sort(),
      );
      const forbidden: PubAction[] = [
        'lead.contact.reveal',
        'lead.read',
        'lead.manage',
        'role.manage',
        'backup.manage',
        'restore.dry_run',
        'restore.apply',
        'budget.operate',
        'budget.reserve_release',
        'placement.approve',
        'product.update',
        'product.mode',
        'product.create',
        'audit.read',
        'ai.helper',
        'ai.bind',
        'claim.verify',
        'question.manage',
        'brief.manage',
        'ai.extra',
        'ai.eval.review',
        'traffic.read',
        'time.others',
      ];
      for (const a of forbidden)
        expect({ a, can: can(access, a) }).toEqual({ a, can: false });
      expect(PUB_ACTIONS.filter((a) => can(access, a)).length).toBe(
        ADMIN_REDDIT_ACTIONS.length,
      );
      const ops = s.mod.get(PubOperations);
      const m = adminMembership(wa.acc.accountId, ADMIN_USER);
      const product = {
        id: wa.product.id,
        accountId: wa.acc.accountId,
        siteId: wa.acc.siteId,
        kind: 'working' as const,
        mode: 'closed' as const,
        status: 'active' as const,
        revision: 1,
      };
      const before = await rows(wa.product.id);
      await expect(
        ops.recordRead(m, access, product, 'lead.contact.reveal', {
          objectType: 'product',
          objectId: product.id,
          action: 'reveal_contact',
        }),
      ).rejects.toMatchObject({ code: 'PUB_ROLE_REQUIRED' });
      for (const action of [
        'role.manage',
        'backup.manage',
        'restore.apply',
        'budget.operate',
        'claim.verify',
        'question.manage',
      ] as PubAction[]) {
        let ran = false;
        await expect(
          ops.run(
            {
              m,
              access,
              product,
              action,
              opKey: randomUUID(),
              scope: `test.${action}`,
              pathParams: {},
              body: {},
            },
            async () => {
              ran = true;
              return { status: 200, body: {}, audit: [] };
            },
          ),
        ).rejects.toMatchObject({ code: 'PUB_ROLE_REQUIRED' });
        expect(ran).toBe(false);
      }
      expect(await rows(wa.product.id)).toEqual(before);
    });
  },
);
