/**
 * Аудит пакета Д, P3 (1): байтовый потолок результата рендера — сначала
 * срезаются ссылки, потом HTML самых длинных страниц; пара суррогатов не
 * режется; итог проходит разбор протоколом и укладывается в `resultBytes`.
 */
import {
  RENDER_RESULT_BUDGET,
  fitRenderBudget,
} from '../../src/jobs/knowledge-render';
import {
  WORKER_LIMITS,
  parseJobParams,
  parseJobResult,
  type KnowledgeRenderResult,
} from '../../src/shared/browser-job-protocol';

const params = parseJobParams('knowledge-render', {
  urls: [0, 1, 2, 3].map((i) => `https://shop.test/${i}`),
  allowedHosts: ['shop.test'],
  viewport: 'desktop',
});
const bytes = (r: unknown) => Buffer.byteLength(JSON.stringify(r), 'utf8');

function result(html: string, links: number = WORKER_LIMITS.renderLinks) {
  return {
    pages: [0, 1, 2, 3].map((i) => ({
      i,
      ok: true,
      error: null,
      html,
      links: Array.from(
        { length: links },
        (_, k) => `https://shop.test/catalog/${'x'.repeat(150)}/${k}`,
      ),
    })),
  } as KnowledgeRenderResult;
}

describe('рендер SPA: байтовый потолок результата (воркер)', () => {
  it('худший случай (3 байта на символ + ссылки) — в потолке, разбор принимает', () => {
    const r = result(' '.repeat(WORKER_LIMITS.renderHtmlChars));
    expect(bytes(r)).toBeGreaterThan(WORKER_LIMITS.resultBytes);
    fitRenderBudget(r);
    expect(bytes(r)).toBeLessThanOrEqual(RENDER_RESULT_BUDGET);
    expect(RENDER_RESULT_BUDGET).toBeLessThan(WORKER_LIMITS.resultBytes);
    expect(() => parseJobResult('knowledge-render', params, r)).not.toThrow();
  });

  it('сначала ссылки: только ссылки не влезают — HTML цел', () => {
    const html = 'а'.repeat(25_000);
    const r = result(html);
    const budget = bytes(result(html, 0)) + 4_000;
    fitRenderBudget(r, budget);
    expect(bytes(r)).toBeLessThanOrEqual(budget);
    expect(r.pages.every((p) => p.html === html)).toBe(true);
  });

  it('обрезка не оставляет одиночный суррогат', () => {
    const r = result('😀'.repeat(14_000), 0);
    fitRenderBudget(r, 150_000);
    for (const p of r.pages) expect(p.html).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(bytes(r)).toBeLessThanOrEqual(150_000);
  });

  it('влезает — не трогается', () => {
    const r = result('<h1>Привіт</h1>', 3);
    const before = JSON.stringify(r);
    fitRenderBudget(r);
    expect(JSON.stringify(r)).toBe(before);
  });
});

describe('рендер SPA: стена времени (аудит P3 (3))', () => {
  it('стена близко — частичный результат (готовые страницы), не отказ всего задания', async () => {
    const { runKnowledgeRender } =
      await import('../../src/jobs/knowledge-render');
    const visited: string[] = [];
    const page = {
      waitForFunction: async () => undefined,
      evaluate: async (_fn: unknown, arg?: unknown) =>
        arg === undefined
          ? undefined
          : { html: '<main><h1>Сторінка</h1></main>', links: [] },
    };
    const ctx = {
      job: {
        id: 'j1',
        wallMs: 41_000,
        params: {
          urls: [0, 1, 2].map((i) => `https://shop.test/${i}`),
          allowedHosts: ['shop.test'],
          viewport: 'desktop',
        },
      },
      signal: new AbortController().signal,
      log: { info: () => undefined },
      jb: {
        newPage: async () => page,
        goto: async (_p: unknown, url: string) => {
          visited.push(url);
          await new Promise((r) => setTimeout(r, 1_500));
        },
      },
    };
    const r = await runKnowledgeRender(ctx as never);
    expect(r.pages.map((p) => p.i)).toEqual([0]);
    expect(visited).toHaveLength(1);
  });
});
