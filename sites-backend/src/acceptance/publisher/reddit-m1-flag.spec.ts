/**
 * [AT-RD-17] P-R M1 — флаг `PUBLISHER_REDDIT_ENABLED` (reddit-manual-mvp-
 * adapted.md §M1.0, §9). Выключен (по умолчанию) — КАЖДЫЙ маршрут
 * `…/reddit/**` отвечает 404 `PUB_NOT_FOUND` БЕЗ `details`, и с входом
 * владельца, и без входа (флаг — первый гвард), ответ неотличим от
 * несуществующего продукта; строк не прибавляется. `GET …/products/:pid`
 * отдаёт `features.reddit=false` (кабинет скрывает раздел — UI-часть у
 * assist). Флаг читается на каждом запросе: включили — маршруты работают и
 * `features.reddit=true`.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { PUBLISHER_REDDIT_ENABLED_ENV } from '../../config/publisher-env';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import type { RouteSpec } from '../../modules/publisher/contracts/_template';
import { REDDIT_ROUTES } from '../../modules/publisher/contracts/reddit-api';
import { fillPath } from '../../modules/publisher/core/route-enumerator';
import { asMember } from '../../modules/publisher/core/testing/core-stack.testing';
import {
  api,
  ok,
  redditStack,
  redditWorld,
  seedCommunity,
  seedOpportunity,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(120_000);

const ROUTES = Object.entries(REDDIT_ROUTES).map(([name, r]) => ({
  ...(r as RouteSpec<unknown, unknown>),
  name,
}));

ciDescribe(
  '[AT-RD-17] флаг выключен → 404 на всех маршрутах …/reddit/**, features.reddit=false',
  () => {
    let s: RedditStack;
    let w: RedditWorld;
    beforeAll(async () => {
      s = await redditStack({ enabled: false });
      w = await redditWorld(s);
    });
    afterAll(async () => {
      await s?.close();
    });

    const count = () =>
      s.prisma.pubAuditEvent.count({ where: { productId: w.product.id } });

    it('все 40 маршрутов (M1 и M2): участник (владелец) — 404 PUB_NOT_FOUND без details, как у несуществующего продукта; аноним — тот же отказ входа, что везде; записей нет', async () => {
      const before = await count();
      const keys = await s.prisma.pubIdempotencyKey.count({
        where: { accountId: w.acc.accountId },
      });
      const owner = asMember(w.acc.owner.telegramId, w.acc.accountId);
      const bad: unknown[] = [];
      for (const r of ROUTES) {
        for (const h of [owner]) {
          for (const pid of [w.product.id, 'cnonexistentproductzzzzzz']) {
            const m = r.method.toLowerCase() as 'get' | 'post' | 'patch';
            const req = request(s.srv())
              [m](fillPath(r.path, { pid, id: 'cxxxxxxxxxxxxxxxxxxxxxxx' }))
              .set(h);
            const res = await (r.method === 'GET'
              ? req
              : req.send({
                  opKey: randomUUID(),
                  expectedRevision: 1,
                  title: 'x',
                  locale: 'en',
                  market: 'US',
                }));
            if (
              res.status !== 404 ||
              res.body?.error?.code !== 'PUB_NOT_FOUND' ||
              'details' in (res.body?.error ?? {})
            )
              bad.push({ route: r.name, status: res.status, body: res.body });
          }
        }
      }
      expect(bad).toEqual([]);
      // Аноним отсекается глобальной проверкой входа (как на любом маршруте
      // кабинета) — 401 одинаково для включённого и выключенного раздела.
      const anon = await request(s.srv()).get(`${w.P}/projects`);
      expect(anon.status).toBe(401);
      expect(await count()).toBe(before);
      expect(
        await s.prisma.pubIdempotencyKey.count({
          where: { accountId: w.acc.accountId },
        }),
      ).toBe(keys);
      expect(
        await s.prisma.pubRedditProject.count({
          where: { productId: w.product.id },
        }),
      ).toBe(0);
    });

    it('GET продукта: features.reddit=false; включили флаг — true и раздел работает (флаг читается на запросе)', async () => {
      const owner = api(s, w.acc.accountId, w.acc.owner);
      const p0 = ok<{ features: { reddit: boolean } }>(
        await owner.get(`/publisher/products/${w.product.id}`),
        200,
      );
      expect(p0.features).toEqual({ reddit: false });
      process.env[PUBLISHER_REDDIT_ENABLED_ENV] = 'true';
      try {
        const p1 = ok<{ features: { reddit: boolean } }>(
          await owner.get(`/publisher/products/${w.product.id}`),
          200,
        );
        expect(p1.features).toEqual({ reddit: true });
        expect((await owner.get(`${w.P}/projects`)).status).toBe(200);
      } finally {
        process.env[PUBLISHER_REDDIT_ENABLED_ENV] = 'false';
      }
      expect((await owner.get(`${w.P}/projects`)).status).toBe(404);
    });
    it('реаудит N-6: флаг выключен — отзыв доказательства P-R через /sources работает (Р-RD-32), ответ без текста, URL и заголовка', async () => {
      const owner = api(s, w.acc.accountId, w.acc.owner);
      process.env[PUBLISHER_REDDIT_ENABLED_ENV] = 'true';
      let c: Awaited<ReturnType<typeof seedCommunity>>;
      let o: { excerpt: { sourceId: string } };
      try {
        c = await seedCommunity(owner, w.P, { rules: 'allowed' });
        o = ok(await seedOpportunity(owner, w.P, c), 201);
      } finally {
        process.env[PUBLISHER_REDDIT_ENABLED_ENV] = 'false';
      }
      const snap = await s.prisma.pubRedditRuleSnapshot.findUniqueOrThrow({
        where: { id: c.snapshotId! },
      });
      const SRC = `/publisher/products/${w.product.id}/sources`;
      for (const sid of [o.excerpt.sourceId, snap.sourceId]) {
        const row = await s.prisma.pubSource.findUniqueOrThrow({
          where: { id: sid },
        });
        expect(row.origin).toBe('reddit');
        const rv = ok<{ source: Record<string, unknown> }>(
          await owner.post(`${SRC}/${sid}/revoke`, {
            reason: 'Прибрати з архіву',
          }),
          200,
        );
        expect(rv.source).toMatchObject({
          id: sid,
          usage: 'revoked',
          url: null,
          title: null,
          fragment: '',
        });
        const json = JSON.stringify(rv);
        expect(json).not.toContain(row.fragment);
        expect(json).not.toContain(row.url!);
        expect(json).not.toContain(`"${row.title ?? 'no-title'}"`);
      }
    });
  },
);
