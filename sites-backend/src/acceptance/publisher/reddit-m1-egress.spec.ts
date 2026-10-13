/**
 * [AT-RD-16] P-R M1 — «ноль запросов к Reddit» (reddit-manual-mvp-
 * adapted.md §M1.0, §8.3, §9; A16). Runtime-инспекция сети: `fetch`,
 * `http.request/get`, `https.request/get` подменены БРОСАЮЩИМИ функциями,
 * а `net.Socket#connect` и `dns.lookup` — записывающими (база тестов ходит
 * через них на localhost). Затем полный сценарий M1 по ВСЕМ 25 маршрутам
 * `REDDIT_ROUTES` (проект → сообщество → снимок → review → возможности →
 * score → переходы → запросы → списки и CSV) и импорт источника по URL
 * Reddit (`reddit_manual_only` до сети). Ожидание: ни одного вызова HTTP-
 * клиентов, ни одного соединения и DNS-запроса не к localhost.
 *
 * Статическая часть — правила графа `publisher-reddit-no-network` и
 * `publisher-reddit-no-network-io` (scripts/check-sites-import-graph.mjs).
 */
import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { REDDIT_ROUTES } from '../../modules/publisher/contracts/reddit-api';
import {
  api,
  ok,
  redditStack,
  redditWorld,
  rulesBody,
  seedOpportunity,
  subredditName,
  threadUrl,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(180_000);

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '', 'undefined']);

ciDescribe(
  '[AT-RD-16] ноль запросов к Reddit-хостам по всем маршрутам …/reddit/**',
  () => {
    let s: RedditStack;
    let w: RedditWorld;
    const outbound: string[] = [];
    const sockets: string[] = [];
    const lookups: string[] = [];
    const restore: Array<() => void> = [];

    beforeAll(async () => {
      s = await redditStack();
      w = await redditWorld(s);
      const deny =
        (what: string) =>
        (...args: unknown[]): never => {
          outbound.push(`${what} ${String(args[0])}`);
          throw new Error(`egress запрещён: ${what}`);
        };
      const g = globalThis as { fetch?: unknown };
      const savedFetch = g.fetch;
      g.fetch = deny('fetch');
      restore.push(() => {
        g.fetch = savedFetch;
      });
      // https — запрещён целиком; http — только localhost (supertest ходит
      // в тестовое приложение через http.request на 127.0.0.1).
      for (const fn of ['request', 'get'] as const) {
        const spy = jest
          .spyOn(https, fn)
          .mockImplementation(deny(`https.${fn}`) as never);
        restore.push(() => spy.mockRestore());
        const orig = http[fn];
        const hs = jest.spyOn(http, fn).mockImplementation(((
          ...args: unknown[]
        ) => {
          const a0 = args[0] as
            string | URL | { hostname?: string; host?: string };
          const host =
            typeof a0 === 'string' || a0 instanceof URL
              ? new URL(String(a0)).hostname
              : String(a0?.hostname ?? a0?.host ?? 'localhost');
          if (!LOCAL.has(host.replace(/^\[|\]$/g, '')))
            return deny(`http.${fn}`)(host);
          return (orig as (...x: unknown[]) => unknown)(...args);
        }) as never);
        restore.push(() => hs.mockRestore());
      }
      const origConnect = net.Socket.prototype.connect;
      net.Socket.prototype.connect = function (
        this: net.Socket,
        ...args: unknown[]
      ) {
        const a0 = args[0] as
          { host?: string; path?: string } | number | string;
        const host =
          typeof a0 === 'object' && a0 !== null
            ? (a0.host ?? (a0.path ? '' : 'localhost'))
            : typeof args[1] === 'string'
              ? args[1]
              : 'localhost';
        sockets.push(String(host));
        return (origConnect as (...x: unknown[]) => net.Socket).apply(
          this,
          args,
        );
      } as typeof origConnect;
      restore.push(() => {
        net.Socket.prototype.connect = origConnect;
      });
      const origLookup = dns.lookup;
      (dns as { lookup: unknown }).lookup = (...args: unknown[]) => {
        lookups.push(String(args[0]));
        return (origLookup as (...x: unknown[]) => unknown)(...args);
      };
      restore.push(() => {
        (dns as { lookup: unknown }).lookup = origLookup;
      });
    });
    afterAll(async () => {
      restore.reverse().forEach((r) => r());
      await s?.close();
    });

    it('полный сценарий M1 по всем маршрутам: HTTP-клиенты не вызваны, соединения и DNS — только localhost', async () => {
      const used = new Set<string>();
      const ed = api(s, w.acc.accountId, w.team.editor);
      const po = api(s, w.acc.accountId, w.team.product_owner);
      const P = w.P;
      const mark = <T>(name: keyof typeof REDDIT_ROUTES, v: T) => {
        used.add(name);
        return v;
      };

      const project = mark(
        'createProject',
        ok<{ id: string; revision: number }>(
          await ed.post(`${P}/projects`, {
            title: 'Egress',
            locale: 'en',
            market: 'US',
          }),
          201,
        ),
      );
      mark('listProjects', ok(await ed.get(`${P}/projects`), 200));
      mark(
        'listProjects',
        (await ed.get(`${P}/projects`, { format: 'csv' })).status,
      );
      mark('getProject', ok(await ed.get(`${P}/projects/${project.id}`), 200));
      const p2 = mark(
        'patchProject',
        ok<{ revision: number }>(
          await ed.patch(`${P}/projects/${project.id}`, {
            market: 'US/EU',
            expectedRevision: project.revision,
          }),
          200,
        ),
      );
      const name = subredditName('egress');
      const community = mark(
        'createCommunity',
        ok<{ id: string; revision: number }>(
          await ed.post(`${P}/communities`, {
            projectId: project.id,
            community: `https://old.reddit.com/r/${name}/`,
            topics: ['saas'],
          }),
          201,
        ),
      );
      mark(
        'getCommunity',
        ok(await ed.get(`${P}/communities/${community.id}`), 200),
      );
      mark(
        'patchCommunity',
        ok(
          await ed.patch(`${P}/communities/${community.id}`, {
            descriptionManual: 'Власники малого бізнесу',
            expectedRevision: community.revision,
          }),
          200,
        ),
      );
      mark('listCommunities', ok(await ed.get(`${P}/communities`), 200));
      mark(
        'listCommunities',
        (await ed.get(`${P}/communities`, { format: 'csv' })).status,
      );
      const snap = mark(
        'createRules',
        ok<{ id: string }>(
          await ed.post(
            `${P}/communities/${community.id}/rules`,
            rulesBody(name, 'allowed'),
          ),
          201,
        ),
      );
      mark(
        'reviewRules',
        ok(await po.post(`${P}/rules/${snap.id}/review`), 200),
      );
      mark(
        'listRules',
        ok(await ed.get(`${P}/communities/${community.id}/rules`), 200),
      );
      mark(
        'getRulesSource',
        ok(
          await ed.get(
            `${P}/communities/${community.id}/rules/${snap.id}/source`,
          ),
          200,
        ),
      );
      const kw = mark(
        'createKeyword',
        ok<{ id: string; revision: number }>(
          await ed.post(`${P}/keywords`, {
            projectId: project.id,
            phrase: 'website chatbot',
            intent: 'recommendation',
            priority: 5,
          }),
          201,
        ),
      );
      mark(
        'patchKeyword',
        ok(
          await ed.patch(`${P}/keywords/${kw.id}`, {
            priority: 4,
            expectedRevision: kw.revision,
          }),
          200,
        ),
      );
      mark('listKeywords', ok(await ed.get(`${P}/keywords`), 200));
      mark(
        'listKeywords',
        (await ed.get(`${P}/keywords`, { format: 'csv' })).status,
      );
      const c = { projectId: project.id, communityId: community.id, name };
      const ids: Array<{ id: string; revision: number }> = [];
      for (let i = 0; i < 3; i++)
        ids.push(
          mark(
            'createOpportunity',
            ok<{ id: string; revision: number }>(
              await seedOpportunity(ed, P, c, {
                threadUrl: threadUrl(name),
                keywordIds: [kw.id],
              }),
              201,
            ),
          ),
        );
      mark(
        'getOpportunity',
        ok(await ed.get(`${P}/opportunities/${ids[0].id}`), 200),
      );
      mark(
        'listOpportunityExcerpts',
        ok(await ed.get(`${P}/opportunities/${ids[0].id}/excerpts`), 200),
      );
      const o1 = mark(
        'patchOpportunity',
        ok<{ revision: number }>(
          await ed.patch(`${P}/opportunities/${ids[0].id}`, {
            factors: { topic_fit: { value: 90, why: 'точний збіг' } },
            expectedRevision: ids[0].revision,
          }),
          200,
        ),
      );
      const o2 = mark(
        'scoreOpportunity',
        ok<{ revision: number }>(
          await ed.post(`${P}/opportunities/${ids[0].id}/score`, {
            expectedRevision: o1.revision,
          }),
          200,
        ),
      );
      mark(
        'qualifyOpportunity',
        ok(
          await ed.post(`${P}/opportunities/${ids[0].id}/qualify`, {
            expectedRevision: o2.revision,
          }),
          200,
        ),
      );
      mark(
        'skipOpportunity',
        ok(
          await ed.post(`${P}/opportunities/${ids[1].id}/skip`, {
            expectedRevision: ids[1].revision,
          }),
          200,
        ),
      );
      mark(
        'archiveOpportunity',
        ok(
          await ed.post(`${P}/opportunities/${ids[2].id}/archive`, {
            expectedRevision: ids[2].revision,
          }),
          200,
        ),
      );
      mark('listOpportunities', ok(await ed.get(`${P}/opportunities`), 200));
      mark(
        'listOpportunities',
        (await ed.get(`${P}/opportunities`, { format: 'csv' })).status,
      );
      mark(
        'archiveProject',
        ok(
          await ed.post(`${P}/projects/${project.id}/archive`, {
            expectedRevision: p2.revision,
          }),
          200,
        ),
      );

      // Импорт источника по URL Reddit — отказ ДО сети.
      for (const url of [
        `https://www.reddit.com/r/${name}/comments/abc123/x`,
        'https://redd.it/abc123',
        'https://i.redditmedia.com/x.png',
        'https://www.redditstatic.com/x.js',
        `http://old.reddit.com/r/${name}`,
      ]) {
        const r = await ed.post(
          `/publisher/products/${w.product.id}/sources/import-url`,
          {
            url,
            visibility: 'private',
          },
        );
        expect(r.status).toBe(400);
        expect(r.body.error).toMatchObject({
          code: 'PUB_IMPORT_BLOCKED',
          details: { reason: 'reddit_manual_only' },
        });
      }

      expect([...used].sort()).toEqual(Object.keys(REDDIT_ROUTES).sort());
      expect(outbound).toEqual([]);
      expect(sockets.filter((h) => !LOCAL.has(h))).toEqual([]);
      expect(lookups.filter((h) => !LOCAL.has(h))).toEqual([]);
      expect([...sockets, ...lookups].some((h) => /redd/i.test(h))).toBe(false);
    });

    it('подмена действует: прямой fetch/https.request бросают и записываются (тест не «слепой»)', () => {
      const before = outbound.length;
      expect(() =>
        (globalThis as unknown as { fetch: (u: string) => unknown }).fetch(
          'https://www.reddit.com/r/x.json',
        ),
      ).toThrow(/egress/);
      expect(() => https.request('https://www.reddit.com/')).toThrow(/egress/);
      expect(outbound.length).toBe(before + 2);
      outbound.splice(before);
    });
  },
);
