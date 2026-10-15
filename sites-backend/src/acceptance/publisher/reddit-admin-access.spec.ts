/**
 * [P-R-ADM] Вход внутреннего API вкладки «Reddit» Админки (Р-RD-ADM-2, 3, 6):
 *  - секрет: нет и неверный — 401 ОДИНАКОВО (код и текст), env не задан —
 *    503; секрет проверяется раньше актора;
 *  - `X-Admin-Actor`: нет или не тот формат — 400 `ADMIN_ACTOR_REQUIRED`;
 *  - флаг `PUBLISHER_REDDIT_ENABLED` выключен: `status` — `enabled:false`,
 *    остальные маршруты — 404 `PUB_NOT_FOUND` без `details`, без записей;
 *  - платформенный сайт: не задан — `setup` 409, разделы — 404
 *    `PUB_PRODUCT_NONE`; задан, но сайта нет — 409; `setup` заводит продукт
 *    (`working`, `closed`, параметры-допущения, актор admin) идемпотентно,
 *    гонка двух операторов — один продукт;
 *  - путь вне закрытого списка — 404.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { PARAMETER_KEYS } from '../../modules/publisher/contracts/parameters';
import {
  ADMIN_USER,
  adminApi,
  useAdminEnv,
} from '../../modules/publisher/reddit/testing/admin-kit.testing';
import {
  api,
  ok,
  redditStack,
  redditWorld,
  type RedditStack,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';
import {
  seedAccount,
  seedProduct,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(240_000);

const shape = (r: { status: number; body: unknown }) => {
  const b = r.body as {
    error?: { code?: string; message?: string; details?: unknown };
  };
  return {
    status: r.status,
    code: b?.error?.code ?? null,
    message: b?.error?.message ?? null,
    details: b?.error?.details ?? null,
  };
};

ciDescribe(
  '[P-R-ADM] Админка: секрет, актор, флаг, платформенный продукт',
  () => {
    describe('флаг включён', () => {
      let s: RedditStack;
      let accountId: string;
      let restore: () => void;
      beforeAll(async () => {
        s = await redditStack();
        const w = await redditWorld(s, 'working');
        accountId = w.acc.accountId;
        restore = useAdminEnv(w.acc.siteId);
      });
      afterAll(async () => {
        restore?.();
        await s?.close();
      });

      it('секрет: нет и неверный — 401 одинаково; env не задан — 503; секрет раньше актора', async () => {
        const none = shape(await adminApi(s, { secret: null }).get('status'));
        const wrong = shape(
          await adminApi(s, { secret: 'x'.repeat(40) }).get('status'),
        );
        const short = shape(
          await adminApi(s, { secret: 'abc' }).get('rx/projects'),
        );
        expect(none).toEqual({
          status: 401,
          code: 'UNAUTHORIZED',
          message: expect.any(String),
          details: null,
        });
        expect(wrong).toEqual(none);
        expect(short).toEqual(none);
        // Нет актора и нет секрета — всё равно 401 (секрет первым).
        expect(
          shape(await adminApi(s, { secret: null, actor: null }).get('status')),
        ).toEqual(none);
        const saved = process.env.SITES_INTERNAL_SECRET;
        process.env.SITES_INTERNAL_SECRET = 'short';
        try {
          expect((await adminApi(s).get('status')).status).toBe(503);
        } finally {
          process.env.SITES_INTERNAL_SECRET = saved;
        }
      });

      it('актор: нет или не тот формат — 400 ADMIN_ACTOR_REQUIRED (и на мутации — без записей)', async () => {
        const before = await s.prisma.pubAuditEvent.count({
          where: { accountId },
        });
        for (const actor of [null, '', 'admin:x', 'a b', 'x'.repeat(59), 'ä']) {
          for (const r of [
            await adminApi(s, { actor }).get('status'),
            await adminApi(s, { actor }).post('rx/projects', {
              title: 'x',
              locale: 'en',
              market: 'US',
            }),
          ]) {
            expect({ actor, ...shape(r) }).toEqual({
              actor,
              status: 400,
              code: 'ADMIN_ACTOR_REQUIRED',
              message: expect.any(String),
              details: null,
            });
          }
        }
        expect(
          await s.prisma.pubAuditEvent.count({ where: { accountId } }),
        ).toBe(before);
        expect(
          (await adminApi(s, { actor: 'x'.repeat(58) }).get('status')).status,
        ).toBe(200);
      });

      it('путь вне закрытого списка — 404 PUB_NOT_FOUND (rx, cx, метод, id не того формата)', async () => {
        const A = adminApi(s);
        for (const r of [
          await A.get('rx/nope'),
          await A.get('rx/projects/a.b'),
          await A.get('cx/contents'),
          await A.get('cx/claims'),
          await A.post('cx/sources/import-url', {
            url: 'https://example.com',
          }),
          await A.patch('cx/sources/x1'),
          await A.get('cx/sources/x1'),
          await A.post('cx/claims/x1/verify'),
          await A.get('cx/ai/calls'),
          await A.post('cx/approvals'),
          await A.get('rx/..%2F..%2Fleads'),
          await A.patch('rx/briefs'),
        ]) {
          expect(shape(r)).toEqual({
            status: 404,
            code: 'PUB_NOT_FOUND',
            message: expect.any(String),
            details: null,
          });
        }
        // Метод, которого у контроллера нет, — 404 Nest.
        expect((await A.get('nope')).status).toBe(404);
      });
    });

    describe('платформенный сайт и setup', () => {
      let s: RedditStack;
      let restore: (() => void) | null = null;
      beforeAll(async () => {
        s = await redditStack();
      });
      afterEach(() => {
        restore?.();
        restore = null;
      });
      afterAll(async () => {
        await s?.close();
      });

      it('кабинет с двумя сайтами и продуктами: Админка видит продукт ИМЕННО платформенного сайта', async () => {
        const w = await redditWorld(s, 'working');
        const site2 = await s.prisma.site.create({
          data: { accountId: w.acc.accountId, name: 'Платформа (другой сайт)' },
        });
        const p2 = await seedProduct(s.prisma, {
          accountId: w.acc.accountId,
          siteId: site2.id,
          kind: 'working',
        });
        const own = api(s, w.acc.accountId, w.team.editor);
        ok(
          await own.post(`${w.P}/projects`, {
            title: 'Кабінет: не платформа',
            locale: 'en',
            market: 'US',
          }),
          201,
        );
        restore = useAdminEnv(site2.id);
        const A = adminApi(s);
        expect((await A.get('status')).body.data.product.id).toBe(p2.id);
        expect(
          ok<{ items: unknown[] }>(await A.get('rx/projects'), 200).items,
        ).toEqual([]);
        restore();
        restore = useAdminEnv(w.acc.siteId);
        expect((await A.get('status')).body.data.product.id).toBe(w.product.id);
        expect(
          ok<{ items: unknown[] }>(await A.get('rx/projects'), 200).items,
        ).toHaveLength(1);
      });

      it('ASSIST_INTERNAL_SITE_IDS не задан: status без продукта, setup — 409, разделы — 404 PUB_PRODUCT_NONE', async () => {
        restore = useAdminEnv(null);
        const A = adminApi(s);
        expect((await A.get('status')).body.data).toMatchObject({
          enabled: true,
          platformSiteId: null,
          product: null,
          gate: null,
        });
        expect(shape(await A.postRaw('setup', {}))).toMatchObject({
          status: 409,
          code: 'PUB_CONFLICT',
          details: { reason: 'platform_site_not_configured' },
        });
        for (const r of [
          await A.get('rx/projects'),
          await A.get('params'),
          await A.postRaw('import/plan', {}),
          await A.get('cx/versions/x1/qa-checks'),
        ])
          expect(shape(r)).toMatchObject({
            status: 404,
            code: 'PUB_PRODUCT_NONE',
          });
      });

      it('сайт задан, но его нет в базе — setup 409 platform_site_missing', async () => {
        restore = useAdminEnv('nositezzzzzzzzzzzzzzz, other');
        expect(shape(await adminApi(s).postRaw('setup', {}))).toMatchObject({
          status: 409,
          details: { reason: 'platform_site_missing' },
        });
      });

      it('setup заводит продукт working/closed с параметрами, актор admin; повтор — 200; гонка двух операторов — один продукт', async () => {
        const acc = await seedAccount(s.prisma);
        restore = useAdminEnv(`${acc.siteId} other_site`);
        const A = adminApi(s);
        expect(shape(await A.postRaw('setup', { kind: 'test' }))).toMatchObject(
          {
            status: 400,
            code: 'PUB_VALIDATION',
          },
        );
        const [r1, r2] = await Promise.all([
          A.postRaw('setup', {}),
          adminApi(s, { actor: 'clOtherOperator02' }).postRaw('setup', {}),
        ]);
        expect([r1.status, r2.status].sort()).toEqual([200, 201]);
        const products = await s.prisma.pubProduct.findMany({
          where: { siteId: acc.siteId },
        });
        expect(products).toHaveLength(1);
        const p = products[0];
        expect([p.kind, p.mode, p.status]).toEqual([
          'working',
          'closed',
          'active',
        ]);
        expect(p.createdBy).toMatch(
          /^admin:(clOperatorUser0001|clOtherOperator02)$/,
        );
        expect(
          await s.prisma.pubParameter.count({ where: { productId: p.id } }),
        ).toBe(PARAMETER_KEYS.length);
        const created = (r1.status === 201 ? r1 : r2).body.data;
        expect(created).toMatchObject({
          created: true,
          product: { id: p.id, kind: 'working', mode: 'closed' },
          gate: { open: false },
        });
        const again = await A.postRaw('setup', {});
        expect(again.status).toBe(200);
        expect(again.body.data).toMatchObject({
          created: false,
          product: { id: p.id },
        });
        expect((await A.get('status')).body.data.product.id).toBe(p.id);
        // Существующий продукт сайта (заведён кабинетом) — тот же, любого вида.
        const w = await redditWorld(s, 'test');
        restore();
        restore = useAdminEnv(w.acc.siteId);
        const own = await A.postRaw('setup', {});
        expect(own.status).toBe(200);
        expect(own.body.data.product).toMatchObject({
          id: w.product.id,
          kind: 'test',
        });
        expect(ADMIN_USER).toBe('clOperatorUser0001');
      });
    });

    describe('флаг выключен', () => {
      let s: RedditStack;
      let accountId: string;
      let restore: () => void;
      beforeAll(async () => {
        s = await redditStack({ enabled: false });
        const w = await redditWorld(s, 'working');
        accountId = w.acc.accountId;
        restore = useAdminEnv(w.acc.siteId);
      });
      afterAll(async () => {
        restore?.();
        await s?.close();
      });

      it('status — enabled:false без продукта; остальные маршруты — 404 PUB_NOT_FOUND без details, без записей', async () => {
        const A = adminApi(s);
        expect((await A.get('status')).body.data).toMatchObject({
          enabled: false,
          product: null,
          gate: null,
        });
        const before = await s.prisma.pubAuditEvent.count({
          where: { accountId },
        });
        const keys = await s.prisma.pubIdempotencyKey.count({
          where: { accountId },
        });
        for (const r of [
          await A.postRaw('setup', {}),
          await A.get('rx/projects'),
          await A.post('rx/projects', {
            title: 'x',
            locale: 'en',
            market: 'US',
          }),
          await A.get('cx/versions/x1/qa-checks'),
          await A.get('params'),
          await A.get('params/niche/proposals'),
          await A.post('params/niche/propose', { value: { text: 'x' } }),
          await A.post('params/niche/decide', { toStatus: 'approved' }),
          await A.postRaw('import/plan', {}),
          await A.postRaw('import/apply', {}),
        ]) {
          expect(shape(r)).toEqual({
            status: 404,
            code: 'PUB_NOT_FOUND',
            message: expect.any(String),
            details: null,
          });
        }
        expect(
          await s.prisma.pubAuditEvent.count({ where: { accountId } }),
        ).toBe(before);
        expect(
          await s.prisma.pubIdempotencyKey.count({ where: { accountId } }),
        ).toBe(keys);
      });
    });
  },
);
