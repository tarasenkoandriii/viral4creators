/**
 * Приёмка Э2 (W5): сборка версии знаний с дедлайном тика — ограничение Э1
 * «сборка не делится на тики» (план, «Э1 — сделано» → «Известные
 * ограничения»; контракт Э2 §1 п.16, §7 «Э1-огр.»). Реальный Postgres +
 * pgvector, ИИ — фейк, время — подменяемые часы (тик «длится» столько,
 * сколько насчитали часы: каждый вызов эмбеддинга — секунда).
 *
 *  1. Сайт на 2 000 страниц собирается за несколько тиков в ОДНУ версию:
 *     между тиками версия `building`, поиск видит прежнюю базу, прогон не
 *     отмечен проиндексированным, резерв бюджета закрыт фактом после
 *     каждой пачки; сборка дольше lease по стенным часам не «протухает».
 *  2. Переобход большого сайта с дедлайном: пока сборка не закончена —
 *     поиск отдаёт ТОЛЬКО прежнюю версию (без смеси), после — только новую.
 *  3. Обрыв функции посреди пачки (резерв взят, пачка не записана):
 *     следующий тик забирает сборку, возвращает резерв и доводит версию;
 *     ни потерянного резерва, ни двойного списания.
 *  4. Обрыв и тики больше не приходят (сайт выключен): уборка снимает
 *     зависшую сборку — версия `discarded`, резерв возвращён, фрагменты
 *     сборки удалены, документы помечены к пересборке, поиск — прежний.
 */
import { contentHash } from '../../modules/assist-knowledge-core/hashing';
import { qualified } from '../../modules/assist-knowledge-core/tables';
import type { EmbedResult, EmbedTask } from '../../modules/site-ai/embedder';
import {
  RAW_URL,
  Harness,
  blocksOf,
  createSite,
  describeWithoutDb,
  filler,
  type PageSpec,
  type SiteFixture,
} from '../e1/k2-fixtures';

if (!RAW_URL) {
  describeWithoutDb('сборка версии с дедлайном тика (Э2, W5)');
} else {
  describe('сборка версии с дедлайном тика (Э2, W5), реальный Postgres', () => {
    let h: Harness;
    /** Часы тика: каждый вызов эмбеддинга «длится» секунду. */
    const clock = { t: 0, now: () => clock.t };
    let realEmbed: Harness['embedder']['embed'];
    /** Обрыв: следующий вызов эмбеддинга «висит» вечно (функцию убили). */
    let hangNext = false;

    beforeAll(() => {
      h = new Harness();
      realEmbed = h.embedder.embed.bind(h.embedder);
      h.embedder.embed = async (
        texts: string[],
        task: EmbedTask,
      ): Promise<EmbedResult> => {
        if (task === 'document') {
          clock.t += 1_000;
          if (hangNext) {
            hangNext = false;
            return new Promise<EmbedResult>(() => undefined);
          }
        }
        return realEmbed(texts, task);
      };
    });

    afterAll(async () => {
      await h.close();
    });

    beforeEach(() => {
      h.embedder.reset();
      h.embedder.fail = false;
      hangNext = false;
    });

    /** site_pages пачкой (crawl() фикстур Э1 — по строке, для 2 000 долго). */
    async function bulkCrawl(s: SiteFixture, pages: PageSpec[]) {
      await h.prisma.sitePage.deleteMany({ where: { siteId: s.siteId } });
      await h.prisma.sitePage.createMany({
        data: pages.map((spec) => {
          const blocks = blocksOf(spec);
          const text = blocks.map((b) => b.text).join('\n');
          return {
            accountId: s.accountId,
            siteId: s.siteId,
            hostId: s.hostId,
            url: `${s.origin}${spec.path}`,
            status: 'ok',
            httpStatus: 200,
            fetchedAt: new Date(),
            changedAt: new Date(),
            text,
            blocks: blocks as unknown as object,
            contentHash: contentHash(text),
            title: spec.title ?? spec.path,
            lang: 'uk',
          };
        }),
      });
      const run = await h.prisma.siteCrawlRun.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          product: 'assist',
          trigger: 'schedule',
          mode: 'full',
          status: 'done',
          maxPages: 5000,
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      return run.id;
    }

    function pagesOf(n: number, seed: string): PageSpec[] {
      return Array.from({ length: n }, (_, i) => ({
        path: `/p${i}`,
        title: `Сторінка ${i}`,
        paragraphs: [filler(`${seed}${i}q`, 12)],
      }));
    }

    /** Один «тик» крона по одному сайту: дедлайн — через `ms` по часам. */
    async function tick(s: SiteFixture, ms: number, batchDocs?: number) {
      const all = await h.siteIndexing.candidates(10_000);
      const c = all.find((x) => x.siteId === s.siteId);
      if (!c) return null;
      return h.siteIndexing.indexSite(c, {
        deadlineAt: clock.t + ms,
        now: clock.now,
        batchDocs,
      });
    }

    async function versions(s: SiteFixture) {
      return h.prisma.assistSiteKnowledgeVersion.findMany({
        where: { siteId: s.siteId },
        orderBy: { number: 'asc' },
      });
    }

    async function assistRow(s: SiteFixture) {
      return h.prisma.assistSite.findUniqueOrThrow({
        where: { siteId: s.siteId },
      });
    }

    /**
     * Списано бюджета обучения = факт в site_ai_usage: эмбеддинги фрагментов
     * и ответы eval (эмбеддинги вопросов eval пишутся той же операцией,
     * но бюджет обучения не списывают — Э1, `queryVector`).
     */
    async function spentVsFact(s: SiteFixture) {
      const st = await h.budget.status(s.accountId, s.siteId);
      const rows = await h.prisma.siteAiUsage.findMany({
        where: {
          siteId: s.siteId,
          OR: [
            { operation: 'assist-embed' },
            {
              operation: 'assist-eval',
              model: { not: 'gemini-embedding-001' },
            },
          ],
        },
        select: { costMicroUsd: true },
      });
      const fact = rows.reduce((x, r) => x + Number(r.costMicroUsd), 0);
      return { spent: st.spentMicroUsd, fact };
    }

    async function outstanding(s: SiteFixture, number: number) {
      const r = await h.prisma.$queryRawUnsafe<{ o: number | null }[]>(
        `SELECT ("stats"->'build'->>'outstandingMicroUsd')::int AS o
           FROM ${qualified('assist_site_knowledge_versions')}
          WHERE "siteId" = $1 AND "number" = $2`,
        s.siteId,
        number,
      );
      return r[0]?.o ?? 0;
    }

    /** Сдвинуть heartbeat сборки в прошлое (стенные часы между тиками). */
    async function ageBuild(s: SiteFixture, number: number, minutes: number) {
      await h.prisma.$executeRawUnsafe(
        `UPDATE ${qualified('assist_site_knowledge_versions')}
            SET "stats" = jsonb_set("stats", '{build,heartbeatAt}',
                  to_jsonb(now() - make_interval(mins => $3))),
                "createdAt" = now() - make_interval(mins => $3)
          WHERE "siteId" = $1 AND "number" = $2`,
        s.siteId,
        number,
        minutes,
      );
    }

    async function chunksIn(s: SiteFixture, number: number) {
      const r = await h.prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${qualified('assist_site_chunks')}
          WHERE "siteId" = $1 AND $2 = ANY("versions")`,
        s.siteId,
        number,
      );
      return r[0].n;
    }

    it('2 000 страниц: несколько тиков, одна версия, без смеси и без потерянного резерва', async () => {
      const s = await createSite(h);
      const runId = await bulkCrawl(s, pagesOf(2_000, 'big'));
      const ticks: Array<{ done: number; total: number }> = [];
      let out = await tick(s, 20_000);
      let guard = 0;
      while (out?.paused) {
        expect(++guard).toBeLessThan(50);
        ticks.push(out.progress!);
        const vs = await versions(s);
        // Одна и та же версия, всё ещё строится; база не опубликована.
        expect(vs).toHaveLength(1);
        expect(vs[0].status).toBe('building');
        expect((await assistRow(s)).knowledgeVersion).toBe(0);
        expect((await assistRow(s)).lastIndexedCrawlRunId).toBeNull();
        expect(
          await h.site.search({ siteId: s.siteId, query: 'big0qтовар0' }),
        ).toEqual([]);
        // Резерв закрыт фактом после каждой пачки — между тиками долга нет.
        expect(await outstanding(s, vs[0].number)).toBe(0);
        const m = await spentVsFact(s);
        expect(m.spent).toBe(m.fact);
        // Между тиками по стенным часам прошло больше lease от СОЗДАНИЯ
        // версии — но heartbeat свежий: сборку не снимают.
        await h.prisma.assistSiteKnowledgeVersion.updateMany({
          where: { siteId: s.siteId, number: vs[0].number },
          data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
        });
        out = await tick(s, 20_000);
      }
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i].done).toBeGreaterThan(ticks[i - 1].done);
      }
      expect(out?.version?.status).toBe('published');
      const vs = await versions(s);
      expect(vs).toHaveLength(1);
      expect(vs[0].stats).toMatchObject({
        added: 2_000,
        ticks: ticks.length + 1,
      });
      expect(vs[0].stats).not.toHaveProperty('build');
      expect(await chunksIn(s, vs[0].number)).toBe(2_000);
      const a = await assistRow(s);
      expect(a.knowledgeVersion).toBe(vs[0].number);
      expect(a.lastIndexedCrawlRunId).toBe(runId);
      // Каждый фрагмент оплачен ровно раз: эмбеддингов = страниц.
      expect(h.embedder.documentTexts).toHaveLength(2_000);
      const hits = await h.site.search({
        siteId: s.siteId,
        query: 'big1999qтовар0',
      });
      expect(hits[0]?.url).toBe(`${s.origin}/p1999`);
      const m = await spentVsFact(s);
      expect(m.spent).toBe(m.fact);
      expect(m.fact).toBeGreaterThan(0);
    }, 300_000);

    it('переобход с дедлайном: пока сборка идёт — только прежняя версия, затем только новая', async () => {
      const s = await createSite(h);
      await bulkCrawl(s, pagesOf(60, 'old'));
      const first = await tick(s, 10_000_000);
      expect(first?.version?.status).toBe('published');
      const v1 = (await assistRow(s)).knowledgeVersion;

      await bulkCrawl(s, pagesOf(60, 'new'));
      let out = await tick(s, 1, 10); // одна пачка за тик
      expect(out?.paused).toBe(true);
      let paused = 0;
      while (out?.paused) {
        paused++;
        expect((await assistRow(s)).knowledgeVersion).toBe(v1);
        const oldHits = await h.site.search({
          siteId: s.siteId,
          query: 'old59qтовар0',
        });
        expect(oldHits[0]?.url).toBe(`${s.origin}/p59`);
        // Новый текст уже записан в строящуюся версию — но поиск его не видит.
        for (const q of ['new0qтовар0', 'new9qтовар0']) {
          const hit = await h.site.search({ siteId: s.siteId, query: q });
          expect(hit.some((x) => x.text.includes('new'))).toBe(false);
        }
        out = await tick(s, 1, 10);
      }
      expect(paused).toBeGreaterThanOrEqual(5);
      expect(out?.version?.status).toBe('published');
      const fresh = await h.site.search({
        siteId: s.siteId,
        query: 'new59qтовар0',
      });
      expect(fresh[0]?.url).toBe(`${s.origin}/p59`);
      const stale = await h.site.search({
        siteId: s.siteId,
        query: 'old59qтовар0',
      });
      expect(stale.some((x) => x.text.includes('old59q'))).toBe(false);
      const m = await spentVsFact(s);
      expect(m.spent).toBe(m.fact);
    }, 120_000);

    it('обрыв посреди пачки: следующий тик возвращает резерв пачки и доводит ту же версию', async () => {
      const s = await createSite(h);
      await bulkCrawl(s, pagesOf(40, 'cut'));
      // Тик 1: одна пачка записана, вторая — резерв взят, эмбеддинг «висит».
      const first = await tick(s, 1, 10);
      expect(first?.paused).toBe(true);
      hangNext = true;
      void tick(s, 1, 10); // функцию «убили»: промис никогда не завершится
      await new Promise((r) => setTimeout(r, 300));
      const [v] = await versions(s);
      expect(v.status).toBe('building');
      const owed = await outstanding(s, v.number);
      expect(owed).toBeGreaterThan(0);
      const mid = await spentVsFact(s);
      expect(mid.spent).toBe(mid.fact + owed);

      // Пока «убитый» тик мог бы жить — сборку не перехватывают.
      const busy = await tick(s, 1, 10);
      expect(busy?.busy).toBe(true);

      // Прошло больше окна перехвата (но меньше lease) — следующий тик.
      await ageBuild(s, v.number, 5);
      let out = await tick(s, 10_000_000, 10);
      expect(out?.paused).toBe(false);
      expect(out?.version?.number).toBe(v.number);
      expect(out?.version?.status).toBe('published');
      expect(await chunksIn(s, v.number)).toBe(40);
      const m = await spentVsFact(s);
      expect(m.spent).toBe(m.fact);
      // Повторный тик ничего не делает и ничего не возвращает второй раз.
      out = await tick(s, 10_000_000, 10);
      expect(out?.version ?? null).toBeNull();
      const again = await spentVsFact(s);
      expect(again.spent).toBe(again.fact);
    }, 120_000);

    it('обрыв, и тики больше не приходят: уборка снимает сборку, резерв возвращён, база прежняя', async () => {
      const s = await createSite(h);
      await bulkCrawl(s, pagesOf(30, 'keep'));
      expect((await tick(s, 10_000_000))?.version?.status).toBe('published');
      const v1 = (await assistRow(s)).knowledgeVersion;
      const base = await spentVsFact(s);

      await bulkCrawl(s, pagesOf(30, 'lost'));
      expect((await tick(s, 1, 10))?.paused).toBe(true);
      hangNext = true;
      void tick(s, 1, 10);
      await new Promise((r) => setTimeout(r, 300));
      const vs = await versions(s);
      const b = vs[vs.length - 1];
      expect(b.status).toBe('building');
      expect(await outstanding(s, b.number)).toBeGreaterThan(0);
      expect(await chunksIn(s, b.number)).toBeGreaterThan(0);

      // Сайт выключили: кандидатом он больше не будет — только уборка.
      await h.prisma.assistSite.update({
        where: { siteId: s.siteId },
        data: { enabled: false },
      });
      // Свежую сборку уборка не трогает.
      expect(
        await h.site.engine.reapStaleBuilds(50, { siteId: s.siteId }),
      ).toBe(0);
      await ageBuild(s, b.number, 11);
      expect(
        await h.site.engine.reapStaleBuilds(50, { siteId: s.siteId }),
      ).toBe(1);
      // Ровно раз.
      expect(
        await h.site.engine.reapStaleBuilds(50, { siteId: s.siteId }),
      ).toBe(0);

      const after = await versions(s);
      expect(after.find((x) => x.number === b.number)?.status).toBe(
        'discarded',
      );
      expect(
        after.some((x) => ['building', 'checking'].includes(x.status)),
      ).toBe(false);
      expect(await chunksIn(s, b.number)).toBe(0);
      expect((await assistRow(s)).knowledgeVersion).toBe(v1);
      const m = await spentVsFact(s);
      expect(m.spent).toBe(m.fact);
      expect(m.fact).toBeGreaterThan(base.fact); // первая пачка уплачена честно
      // Документы, которые сборка успела переписать, — к пересборке: ни
      // один не числится проиндексированным с текстом, которого нет в базе.
      const docs = await h.prisma.assistSiteDocument.findMany({
        where: { siteId: s.siteId },
        select: { ref: true, indexedHash: true },
      });
      const pages = await h.prisma.sitePage.findMany({
        where: { siteId: s.siteId },
        select: { url: true, contentHash: true },
      });
      const fresh = new Map(pages.map((p) => [p.url, p.contentHash]));
      expect(docs).toHaveLength(30);
      expect(docs.filter((d) => d.indexedHash === fresh.get(d.ref))).toEqual(
        [],
      );
      const hit = await h.site.search({
        siteId: s.siteId,
        query: 'keep0qтовар0',
      });
      expect(hit[0]?.url).toBe(`${s.origin}/p0`);
      // Уборка вызывается тиком (по всем сайтам) — проверка подключения.
      // (Настоящая уборка тиком прошла бы по ЧУЖИМ сайтам общей базы.)
      const spy = jest
        .spyOn(h.site.engine, 'reapStaleBuilds')
        .mockResolvedValue(0);
      await h.siteIndexing.tick(1);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    }, 120_000);
  });
}
