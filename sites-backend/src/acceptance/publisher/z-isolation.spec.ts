/**
 * [AT-CORE-08] Интеграция Z-2b: систематическая изоляция по ВСЕМ маршрутам
 * Publisher. Список маршрутов — из реестра контрактов (`contracts/*-api.ts`
 * `*_ROUTES`), а не руками; первый тест сверяет реестр с роутером
 * собранного приложения — новый маршрут вне контрактов роняет набор, и
 * каждый маршрут контрактов проходит проверки ниже:
 *
 *  1. чужой продукт / чужой сайт (`:pid`, `:siteId` другого кабинета) —
 *     404 `PUB_NOT_FOUND`, ответ неотличим от несуществующего id (нет утечки
 *     существования);
 *  2. свой продукт, но id объекта ЧУЖОГО кабинета в остальных параметрах
 *     пути — не 2xx и тот же ответ, что для несуществующего id;
 *  3. чужой кабинет в заголовке `X-Site-Account` (участник не состоит) —
 *     отказ, одинаковый для существующего и несуществующего продукта;
 *  4. участник с отозванными ролями — 403 на каждом маршруте; наблюдатель —
 *     403 `PUB_ROLE_REQUIRED` на каждой мутации, которой нет у его роли;
 *  5. публичные маршруты: неизвестный ключ — 404, ключ чужого продукта с
 *     чужим Origin — 403 `PUB_ORIGIN_DENIED`;
 *  6. побочных эффектов нет: число строк всех таблиц `pub_*` обоих
 *     кабинетов до и после проверок одинаково (ни ключей идемпотентности, ни
 *     аудита, ни объектов).
 * Раздел Reddit (пакет P-R, AT-RD-01): `REDDIT_ROUTES` в реестре, флаг
 * `PUBLISHER_REDDIT_ENABLED=true` на время набора, у кабинета B — проект,
 * сообщество, снимок правил, возможность и запрос (их id — в чужих
 * объектах проверки 2).
 */
import { randomUUID } from 'crypto';
import { ModulesContainer } from '@nestjs/core';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { PublisherAiModule } from '../../modules/publisher/ai/ai.module';
import { PublisherContentModule } from '../../modules/publisher/content/content.module';
import {
  Kit,
  approvedArticle,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import type { RouteSpec } from '../../modules/publisher/contracts/_template';
import { AI_ROUTES } from '../../modules/publisher/contracts/ai-api';
import { CONTENT_ROUTES } from '../../modules/publisher/contracts/content-api';
import { CORE_ROUTES } from '../../modules/publisher/contracts/core-api';
import { DISTRIBUTION_ROUTES } from '../../modules/publisher/contracts/distribution-api';
import { LEADS_ROUTES } from '../../modules/publisher/contracts/leads-api';
import { PUBLIC_ROUTES } from '../../modules/publisher/contracts/public-api';
import { REDDIT_ROUTES } from '../../modules/publisher/contracts/reddit-api';
import { PUBLISHER_REDDIT_ENABLED_ENV } from '../../config/publisher-env';
import { PublisherRedditModule } from '../../modules/publisher/reddit/reddit.module';
import {
  api as redditApi,
  ok as redditOk,
  seedCommunity,
  seedOpportunity,
  seedStudio,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';
import { REPORTS_ROUTES } from '../../modules/publisher/contracts/reports-api';
import {
  CX_ROUTES,
  RX_ROUTES,
} from '../../modules/publisher/reddit/admin/admin-reddit-routes';
import {
  ADMIN_BASE,
  adminApi,
  useAdminEnv,
} from '../../modules/publisher/reddit/testing/admin-kit.testing';
import {
  enumerateRoutes,
  fillPath,
} from '../../modules/publisher/core/route-enumerator';
import { PUB_ROLES } from '../../modules/publisher/contracts/states';
import {
  accessOf,
  can,
  type PubAction,
} from '../../modules/publisher/core/roles';
import {
  asMember,
  coreStack,
} from '../../modules/publisher/core/testing/core-stack.testing';
import { PublisherDistributionModule } from '../../modules/publisher/distribution/distribution.module';
import { PublisherLeadsModule } from '../../modules/publisher/leads/leads.module';
import { PublisherContentPublicModule } from '../../modules/publisher/public/content-public.module';
import { PublisherIntakePublicModule } from '../../modules/publisher/public/intake-public.module';
import { PublisherReportsModule } from '../../modules/publisher/reports/reports.module';
import {
  seedAccount,
  seedMembers,
  type SeededAccount,
  type SeededMembers,
  type SeededProduct,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(600_000);

const MODULES = [
  PublisherContentModule,
  PublisherAiModule,
  PublisherDistributionModule,
  PublisherLeadsModule,
  PublisherReportsModule,
  PublisherRedditModule,
  PublisherContentPublicModule,
  PublisherIntakePublicModule,
];

type Spec = RouteSpec<unknown, unknown>;
type Named = Spec & { name: string };

/** Реестр контрактов: все маршруты Publisher (кабинет и публичные). */
const REGISTRY: Named[] = Object.entries({
  ...prefixed('core', CORE_ROUTES),
  ...prefixed('content', CONTENT_ROUTES),
  ...prefixed('ai', AI_ROUTES),
  ...prefixed('distribution', DISTRIBUTION_ROUTES),
  ...prefixed('leads', LEADS_ROUTES),
  ...prefixed('reports', REPORTS_ROUTES),
  ...prefixed('public', PUBLIC_ROUTES),
  ...prefixed('reddit', REDDIT_ROUTES),
}).map(([name, r]) => ({ ...(r as Spec), name }));

function prefixed(
  pkg: string,
  routes: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(routes).map(([k, v]) => [`${pkg}.${k}`, v]),
  );
}

const CABINET = REGISTRY.filter((r) => r.path.startsWith('/publisher/'));
const PUBLIC = REGISTRY.filter((r) => r.path.startsWith('/public/publisher/'));
const OBJECT_PARAMS = (path: string) =>
  [...path.matchAll(/:([A-Za-z0-9_]+)/g)]
    .map((m) => m[1])
    .filter((p) => p !== 'pid' && p !== 'siteId');
const actionsOf = (r: Spec): PubAction[] =>
  r.action === null
    ? []
    : ((Array.isArray(r.action) ? r.action : [r.action]) as PubAction[]);

/** Несуществующий id того же вида, что cuid (форму id проверяют до поиска). */
const ghostId = () =>
  `c${randomUUID().replace(/-/g, '').slice(0, 24)}`.replace(/[0-9]/g, 'z');

/** Ответ без меняющихся частей (requestId, время, путь). */
interface Shape {
  status: number;
  code: string | null;
  details: unknown;
}

function shape(res: request.Response): Shape {
  const b = res.body as {
    success?: boolean;
    error?: { code?: string; details?: unknown };
  };
  return {
    status: res.status,
    code: b?.error?.code ?? null,
    details: b?.error?.details ?? null,
  };
}

ciDescribe(
  '[AT-CORE-08] z-isolation: все маршруты Publisher из реестра контрактов — изоляция кабинетов, роли, без побочных эффектов',
  () => {
    let s: ContentStack;
    let a: SeededAccount;
    let b: SeededAccount;
    let pa: SeededProduct;
    let pb: SeededProduct;
    let team: SeededMembers;
    let revoked: { telegramId: bigint; memberId: string };
    /** id объектов чужого кабинета: по одной строке каждой таблицы `pub_*`. */
    let foreignIds: string[] = [];
    const srv = () => s.app!.getHttpServer();
    const op = () => randomUUID();

    async function apiProduct(acc: SeededAccount): Promise<SeededProduct> {
      const created = await request(srv())
        .post(`/publisher/sites/${acc.siteId}/product`)
        .set(asMember(acc.owner.telegramId, acc.accountId))
        .send({ opKey: op(), name: 'Продукт Z-2b', kind: 'working' });
      expect(created.status).toBe(201);
      const row = await s.prisma.pubProduct.findUniqueOrThrow({
        where: { id: created.body.data.id as string },
      });
      return {
        id: row.id,
        accountId: acc.accountId,
        siteId: acc.siteId,
        kind: 'working',
        mode: 'closed',
        status: 'active',
        revision: row.revision,
        publicKey: row.publicKey,
      };
    }

    /** Строки `pub_*` обоих кабинетов по таблицам. */
    async function counts(): Promise<Record<string, number>> {
      const tables = await s.prisma.$queryRaw<Array<{ t: string }>>`
        SELECT c.table_name AS t FROM information_schema.columns c
         WHERE c.table_schema = 'sites' AND c.table_name LIKE 'pub\\_%'
           AND c.column_name = 'accountId'
           AND EXISTS (SELECT 1 FROM information_schema.tables x
                        WHERE x.table_schema = 'sites' AND x.table_name = c.table_name
                          AND x.table_type = 'BASE TABLE')
         ORDER BY 1`;
      const out: Record<string, number> = {};
      for (const { t } of tables) {
        const [r] = await s.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM "sites"."${t}" WHERE "accountId" = ANY($1::text[])`,
          [a.accountId, b.accountId],
        );
        out[t] = Number(r.n);
      }
      return out;
    }

    function call(
      r: Spec,
      path: string,
      headers: Record<string, string>,
    ): request.Test {
      const m = r.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put';
      const req = request(srv())[m](path).set(headers);
      return r.method === 'GET'
        ? req
        : req.send({ opKey: op(), expectedRevision: 1 });
    }

    const savedReddit = process.env[PUBLISHER_REDDIT_ENABLED_ENV];

    beforeAll(async () => {
      process.env[PUBLISHER_REDDIT_ENABLED_ENV] = 'true';
      s = (await coreStack({ http: true, imports: MODULES })) as ContentStack;
      a = await seedAccount(s.prisma);
      b = await seedAccount(s.prisma);
      pa = await apiProduct(a);
      pb = await apiProduct(b);
      // Объекты чужого кабинета: материал целиком (источник, вопрос, бриф,
      // версия, утверждение, согласование) + то, что дал product-init.
      await approvedArticle(new Kit(s, b, pb));
      // Объекты P-R кабинета B (AT-RD-01): проект, сообщество (+ канал),
      // снимок правил (+ первоисточник), возможность (+ выдержка), запрос.
      const rb = redditApi(
        { ...s, srv: () => s.app!.getHttpServer() },
        b.accountId,
        b.owner,
      );
      const RB = `/publisher/products/${pb.id}/reddit`;
      const rc = await seedCommunity(rb, RB, { rules: 'allowed' });
      redditOk(await seedOpportunity(rb, RB, rc), 201);
      redditOk(
        await rb.post(`${RB}/keywords`, {
          projectId: rc.projectId,
          phrase: 'isolation keyword',
          intent: 'other',
          priority: 1,
        }),
        201,
      );
      // P-R M2: бриф и Reddit-материал кабинета B (маршруты :id и :cid).
      await seedStudio(
        { ...s, srv: () => s.app!.getHttpServer() },
        { acc: b, product: pb, team: undefined as never, P: RB },
        rb,
        rb,
      );
      team = await seedMembers(s.prisma, pa, a.owner);
      // Участник, которому выдали и затем отозвали ВСЕ роли продукта.
      const m = await s.prisma.siteAccountMember.create({
        data: {
          accountId: a.accountId,
          telegramId: BigInt(`9${Date.now() % 1e9}`),
          role: 'operator',
          productRoles: { publisher: 'member' },
        },
      });
      revoked = { telegramId: m.telegramId, memberId: m.id };
      const owner = asMember(a.owner.telegramId, a.accountId);
      for (const role of PUB_ROLES) {
        const g = await request(srv())
          .post(`/publisher/products/${pa.id}/roles`)
          .set(owner)
          .send({ opKey: op(), memberId: m.id, role });
        expect(g.status).toBe(201);
        const r = await request(srv())
          .post(`/publisher/products/${pa.id}/roles/${g.body.data.id}/revoke`)
          .set(owner)
          .send({ opKey: op(), reason: 'Відкликано для перевірки Z-2b' });
        expect(r.status).toBe(200);
      }
      const tables = await s.prisma.$queryRaw<Array<{ t: string }>>`
        SELECT c.table_name AS t FROM information_schema.columns c
         WHERE c.table_schema = 'sites' AND c.table_name LIKE 'pub\\_%'
           AND c.column_name = 'productId'
           AND EXISTS (SELECT 1 FROM information_schema.columns i
                        WHERE i.table_schema = 'sites' AND i.table_name = c.table_name
                          AND i.column_name = 'id')
           AND EXISTS (SELECT 1 FROM information_schema.tables x
                        WHERE x.table_schema = 'sites' AND x.table_name = c.table_name
                          AND x.table_type = 'BASE TABLE')
         ORDER BY 1`;
      const ids = new Set<string>();
      for (const { t } of tables) {
        const rows = await s.prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "sites"."${t}" WHERE "productId" = $1 LIMIT 1`,
          pb.id,
        );
        for (const r of rows) ids.add(r.id);
      }
      foreignIds = [...ids];
    }, 300_000);
    afterAll(async () => {
      await s?.close();
      if (savedReddit === undefined)
        delete process.env[PUBLISHER_REDDIT_ENABLED_ENV];
      else process.env[PUBLISHER_REDDIT_ENABLED_ENV] = savedReddit;
    });

    it('реестр контрактов = маршруты приложения /publisher/* и /public/publisher/* (новый маршрут вне контрактов роняет набор)', () => {
      const app = enumerateRoutes(s.mod.get(ModulesContainer))
        .filter(
          (r) =>
            r.path.startsWith('/publisher/') ||
            r.path.startsWith('/public/publisher/'),
        )
        .map((r) => `${r.method} ${r.path}`)
        .sort();
      const reg = REGISTRY.map((r) => `${r.method} ${r.path}`).sort();
      expect(new Set(reg).size).toBe(reg.length);
      expect(app).toEqual(reg);
      expect(CABINET.length).toBeGreaterThan(150);
      // P-R: M1 — 26 маршрутов (с restore, Р-RD-AUD-1), M2 (Studio) — ещё 14.
      expect(CABINET.filter((r) => r.name.startsWith('reddit.'))).toHaveLength(
        40,
      );
      expect(foreignIds.length).toBeGreaterThan(15);
    });

    it('чужой продукт/сайт — 404 PUB_NOT_FOUND, как несуществующий; объект чужого кабинета в своём продукте — как несуществующий; без побочных эффектов', async () => {
      const before = await counts();
      const owner = asMember(a.owner.telegramId, a.accountId);
      const bad: unknown[] = [];
      for (const r of CABINET) {
        // 1. Чужой продукт / сайт (остальные параметры — несуществующие).
        const foreign = await call(
          r,
          fillPath(r.path, { pid: pb.id, siteId: pb.siteId }),
          owner,
        );
        const ghost = await call(
          r,
          fillPath(r.path, { pid: ghostId(), siteId: ghostId() }),
          owner,
        );
        const fs = shape(foreign);
        if (
          fs.status !== 404 ||
          fs.code !== 'PUB_NOT_FOUND' ||
          JSON.stringify(fs) !== JSON.stringify(shape(ghost))
        ) {
          bad.push({ route: r.name, foreign: fs, ghost: shape(ghost) });
        }
        // 2. Свой продукт, объект чужого кабинета.
        const params = OBJECT_PARAMS(r.path);
        if (params.length === 0) continue;
        const ghostVals = Object.fromEntries(params.map((p) => [p, ghostId()]));
        const g = await call(
          r,
          fillPath(r.path, { pid: pa.id, siteId: pa.siteId, ...ghostVals }),
          owner,
        );
        for (const id of foreignIds) {
          const vals = Object.fromEntries(params.map((p) => [p, id]));
          const res = await call(
            r,
            fillPath(r.path, { pid: pa.id, siteId: pa.siteId, ...vals }),
            owner,
          );
          const rs = shape(res);
          const gs = shape(g);
          // Тот же отказ, что у несуществующего id; 2xx — утечка.
          if (
            rs.status < 400 ||
            rs.status !== gs.status ||
            rs.code !== gs.code
          ) {
            bad.push({ route: r.name, id, res: rs, ghost: gs });
          }
        }
      }
      expect(bad).toEqual([]);
      expect(await counts()).toEqual(before);
    });

    it('чужой кабинет в X-Site-Account — отказ, одинаковый для существующего и несуществующего продукта; без побочных эффектов', async () => {
      const before = await counts();
      // Владелец A просит кабинет B, где он не участник.
      const intruder = asMember(a.owner.telegramId, b.accountId);
      const bad: unknown[] = [];
      for (const r of CABINET) {
        const real = shape(
          await call(
            r,
            fillPath(r.path, { pid: pb.id, siteId: pb.siteId }),
            intruder,
          ),
        );
        const ghost = shape(
          await call(
            r,
            fillPath(r.path, { pid: ghostId(), siteId: ghostId() }),
            intruder,
          ),
        );
        if (
          ![401, 403, 404].includes(real.status) ||
          JSON.stringify(real) !== JSON.stringify(ghost)
        ) {
          bad.push({ route: r.name, real, ghost });
        }
      }
      expect(bad).toEqual([]);
      expect(await counts()).toEqual(before);
    });

    it('отозванные роли — 403 на каждом маршруте; наблюдатель — 403 PUB_ROLE_REQUIRED на каждой мутации вне своей роли; без побочных эффектов', async () => {
      const before = await counts();
      const rv = asMember(revoked.telegramId, a.accountId);
      const viewer = asMember(team.viewer.telegramId, a.accountId);
      const viewerAccess = accessOf({
        memberId: team.viewer.memberId,
        grants: ['viewer'],
        admin: false,
        accountOwner: false,
      });
      const bad: unknown[] = [];
      let viewerChecked = 0;
      for (const r of CABINET) {
        const path = fillPath(r.path, { pid: pa.id, siteId: pa.siteId });
        const x = shape(await call(r, path, rv));
        if (x.status !== 403) bad.push({ who: 'revoked', route: r.name, ...x });
        if (!r.mutation) continue;
        if (actionsOf(r).some((act) => can(viewerAccess, act))) continue;
        viewerChecked++;
        const v = shape(await call(r, path, viewer));
        if (v.status !== 403 || v.code !== 'PUB_ROLE_REQUIRED')
          bad.push({ who: 'viewer', route: r.name, ...v });
      }
      expect(bad).toEqual([]);
      expect(viewerChecked).toBeGreaterThan(80);
      expect(await counts()).toEqual(before);
    });

    it('Админка (internal/admin/reddit): платформенный продукт A — объекты кабинета B как несуществующие на всех rx/cx; неверный секрет — 401 одинаково; без побочных эффектов', async () => {
      const restore = useAdminEnv(a.siteId);
      try {
        const app = enumerateRoutes(s.mod.get(ModulesContainer))
          .filter((r) => r.path.startsWith(ADMIN_BASE))
          .map((r) => `${r.method} ${r.path}`);
        expect(app).toHaveLength(14);
        expect(RX_ROUTES).toHaveLength(40);
        expect(CX_ROUTES).toHaveLength(24);
        const before = await counts();
        const A = adminApi({ srv });
        const W = adminApi({ srv }, { secret: 'w'.repeat(40) });
        // Проверка не «слепая»: платформенный продукт найден, раздел отвечает.
        expect((await A.get('status')).body.data.product.id).toBe(pa.id);
        expect((await A.get('rx/projects')).status).toBe(200);
        const routes = [
          ...RX_ROUTES.map((r) => ({ ...r, prefix: 'rx' })),
          ...CX_ROUTES.map((r) => ({ ...r, prefix: 'cx' })),
        ];
        const send = (
          api: typeof A,
          method: string,
          path: string,
        ): Promise<request.Response> =>
          method === 'GET'
            ? api.get(path)
            : method === 'PATCH'
              ? api.patch(path, { expectedRevision: 1 })
              : api.post(path, { expectedRevision: 1 });
        const bad: unknown[] = [];
        let wrong: Shape | null = null;
        for (const r of routes) {
          const params = [...r.pattern.matchAll(/:([A-Za-z0-9_]+)/g)].map(
            (m) => m[1],
          );
          const path = (vals: Record<string, string>) =>
            `${r.prefix}/${fillPath(r.pattern, vals)}`;
          const ghostVals = Object.fromEntries(
            params.map((p) => [p, ghostId()]),
          );
          const w = shape(await send(W, r.method, path(ghostVals)));
          wrong ??= w;
          if (w.status !== 401 || JSON.stringify(w) !== JSON.stringify(wrong))
            bad.push({ route: r.name, wrongSecret: w });
          if (params.length === 0) continue;
          const g = shape(await send(A, r.method, path(ghostVals)));
          for (const id of foreignIds) {
            const vals = Object.fromEntries(params.map((p) => [p, id]));
            const rs = shape(await send(A, r.method, path(vals)));
            if (rs.status < 400 || JSON.stringify(rs) !== JSON.stringify(g))
              bad.push({
                route: `${r.prefix}.${r.name}`,
                id,
                res: rs,
                ghost: g,
              });
          }
        }
        expect(bad).toEqual([]);
        expect(await counts()).toEqual(before);
      } finally {
        restore();
      }
    });

    it('публичные маршруты: неизвестный ключ — 404, ключ чужого продукта с чужим Origin — 403; без побочных эффектов', async () => {
      const before = await counts();
      const bad: unknown[] = [];
      for (const r of PUBLIC) {
        const params = { slug: 'kak-vybraty' };
        const path = fillPath(r.path, params);
        const send = (key: string, origin?: string) => {
          const m = r.method.toLowerCase() as 'get' | 'post';
          let req = request(srv())[m](path);
          if (origin) req = req.set('Origin', origin);
          return r.method === 'GET'
            ? req.query({ key })
            : req
                .set('Content-Type', 'application/json')
                .send(JSON.stringify({ key, submissionKey: randomUUID() }));
        };
        const unknown = shape(await send(`pp_${'Z'.repeat(24)}`));
        // Тело события/заявки неполное — допустимы 400 (валидация до ключа)
        // и 404; главное — не 2xx.
        if (unknown.status < 400 || ![400, 404].includes(unknown.status))
          bad.push({ route: r.name, unknown });
        const foreign = shape(await send(pb.publicKey, 'https://evil.example'));
        if (
          foreign.status < 400 ||
          (foreign.status === 403 && foreign.code !== 'PUB_ORIGIN_DENIED')
        )
          bad.push({ route: r.name, foreign });
      }
      expect(bad).toEqual([]);
      expect(await counts()).toEqual(before);
    });
  },
);
