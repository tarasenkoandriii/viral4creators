/**
 * CSV-выгрузки списков частями (замечание backend, раунд 3 P-R-ADM): часть —
 * ≤ 5000 строк, есть ещё — курсор `X-Next-Before` (`?before=`), как у
 * журнала AI. Проверяется на 6000 строк: две части (5000 + 1000) без потерь
 * и дублей, у последней заголовка нет:
 *  - Reddit-список (`…/reddit/keywords`) в кабинете и через внутренний API
 *    Админки (`rx/keywords`);
 *  - источники контента и факты бренда (`…/sources`, `…/brand-facts`) в
 *    кабинете и через Админку (`cx/sources`, `cx/brand-facts`).
 * Кабинет assist склеивает части (`csvAll`, `common-api.ts`) по этому
 * заголовку.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { sourceContentHash } from '../../modules/publisher/core/content-hash';
import {
  adminApi,
  useAdminEnv,
  type AdminApi,
} from '../../modules/publisher/reddit/testing/admin-kit.testing';
import {
  api,
  ok,
  redditStack,
  redditWorld,
  type Api,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(300_000);

const N = 6000;

/** Номер буквами (цифры подряд похожи на телефон — `pii`). */
function word(n: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

/** id из первой колонки CSV (без заголовка). */
function ids(text: string): string[] {
  return text
    .split('\n')
    .slice(1)
    .filter((l) => l.trim() !== '')
    .map((l) => l.split(',')[0].replace(/^"|"$/g, ''));
}

type Get = (
  path: string,
  query: Record<string, string>,
) => Promise<{ status: number; text: string; headers: Record<string, string> }>;

/** Все части выгрузки по курсору; возвращает размеры частей и id. */
async function allParts(get: Get, path: string) {
  const sizes: number[] = [];
  const all: string[] = [];
  let before: string | undefined;
  for (let i = 0; i < 5; i++) {
    const r = await get(path, {
      format: 'csv',
      ...(before ? { before } : {}),
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    const part = ids(r.text);
    sizes.push(part.length);
    all.push(...part);
    before = r.headers['x-next-before'];
    if (!before) break;
    expect(before).toBe(part[part.length - 1]);
  }
  return { sizes, all };
}

ciDescribe(
  'CSV частями: 6000 строк → 5000 + 1000 по X-Next-Before (кабинет и Админка)',
  () => {
    let s: RedditStack;
    let w: RedditWorld;
    let ed: Api;
    let A: AdminApi;
    let restore: () => void;
    const created = {
      keywords: [] as string[],
      sources: [] as string[],
      facts: [] as string[],
    };

    beforeAll(async () => {
      s = await redditStack();
      w = await redditWorld(s, 'working');
      restore = useAdminEnv(w.acc.siteId);
      ed = api(s, w.acc.accountId, w.team.editor);
      A = adminApi(s);
      const project = ok<{ id: string }>(
        await ed.post(`${w.P}/projects`, {
          title: 'CSV частями',
          locale: 'en',
          market: 'US',
        }),
        201,
      );
      const base = {
        accountId: w.acc.accountId,
        productId: w.product.id,
        createdBy: 'system:test-seed',
      };
      await s.prisma.pubRedditKeyword.createMany({
        data: Array.from({ length: N }, (_, i) => ({
          ...base,
          projectId: project.id,
          phrase: `phrase ${word(i)}`,
          phraseNorm: `phrase ${word(i)}`,
          intent: 'other',
          priority: 1,
        })),
      });
      await s.prisma.pubSource.createMany({
        data: Array.from({ length: N }, (_, i) => {
          const fragment = `Фрагмент ${word(i)}`;
          return {
            ...base,
            kind: 'manual_text',
            title: `Джерело ${word(i)}`,
            fragment,
            usage: 'allowed',
            visibility: 'private',
            contentHash: sourceContentHash(null, fragment),
          };
        }),
      });
      await s.prisma.pubBrandFact.createMany({
        data: Array.from({ length: N }, (_, i) => ({
          ...base,
          factKey: `fact.${word(i)}`,
          kind: 'fact',
          value: { text: `Факт ${word(i)}` },
          version: 1,
        })),
      });
      const where = { productId: w.product.id };
      created.keywords = (
        await s.prisma.pubRedditKeyword.findMany({
          where,
          select: { id: true },
        })
      ).map((x) => x.id);
      created.sources = (
        await s.prisma.pubSource.findMany({ where, select: { id: true } })
      ).map((x) => x.id);
      created.facts = (
        await s.prisma.pubBrandFact.findMany({ where, select: { id: true } })
      ).map((x) => x.id);
    });
    afterAll(async () => {
      restore?.();
      await s?.close();
    });

    const cabinet: Get = async (path, query) => {
      const r = await ed.get(path, query);
      return { status: r.status, text: r.text, headers: r.headers };
    };
    const admin: Get = async (path, query) => {
      const r = await A.get(path, query);
      return { status: r.status, text: r.text, headers: r.headers };
    };

    const check = (
      got: { sizes: number[]; all: string[] },
      expected: string[],
    ) => {
      expect(got.sizes).toEqual([5000, expected.length - 5000]);
      expect(new Set(got.all).size).toBe(got.all.length);
      expect([...got.all].sort()).toEqual([...expected].sort());
    };

    it('Reddit-список (keywords): кабинет и Админка — две части без потерь и дублей', async () => {
      expect(created.keywords).toHaveLength(N);
      check(await allParts(cabinet, `${w.P}/keywords`), created.keywords);
      check(await allParts(admin, 'rx/keywords'), created.keywords);
      // JSON-список не изменился: страница ≤ 100 и nextBefore в теле.
      const page = ok<{ items: unknown[]; nextBefore: string | null }>(
        await ed.get(`${w.P}/keywords`, { limit: '100' }),
        200,
      );
      expect(page.items).toHaveLength(100);
      expect(page.nextBefore).not.toBeNull();
    });

    it('источники контента и факты бренда: кабинет и Админка — две части без потерь и дублей', async () => {
      const P = `/publisher/products/${w.product.id}`;
      const ownSources = created.sources.filter(Boolean);
      expect(ownSources).toHaveLength(N);
      check(await allParts(cabinet, `${P}/sources`), ownSources);
      check(await allParts(admin, 'cx/sources'), ownSources);
      check(await allParts(cabinet, `${P}/brand-facts`), created.facts);
      check(await allParts(admin, 'cx/brand-facts'), created.facts);
    });
  },
);
