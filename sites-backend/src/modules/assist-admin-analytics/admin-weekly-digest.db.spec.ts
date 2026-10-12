/**
 * Заход 13, пакет Г (Р-З13-Г4): досылка отчёта недели «Админки» ищет ждущие
 * строки по частичному индексу `assist_admin_insights_digest_pending_idx`,
 * а не полным проходом таблицы недель каждый тик крона.
 *
 * Проверяется ровно тот SQL, что исполняет `pendingRows` (`PENDING_ROWS_SQL`):
 * условие WHERE должно выводить условие индекса — иначе планировщик молча
 * вернётся к полному проходу. `enable_seqscan = off` — чтобы на пустой
 * таблице стенда план выбирал индекс, если он вообще применим.
 */
import { PrismaService, SITES_DB_SCHEMA } from '../../prisma/prisma.service';
import { describeDb } from '../site-crawl/testing/crawl-db.testing';
import { PENDING_ROWS_SQL } from './admin-weekly-digest';

jest.setTimeout(60_000);

const INDEX = 'assist_admin_insights_digest_pending_idx';

describeDb(
  'отчёт недели «Админки»: ждущие строки — по частичному индексу',
  () => {
    let prisma: PrismaService;

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma?.$disconnect();
    });

    const plan = async (siteIds: string[] | null): Promise<string> => {
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN ${PENDING_ROWS_SQL}`,
          siteIds,
          50,
        );
      });
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    };

    it('индекс есть и частичный: в нём только строки с непустым ожиданием', async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
        INDEX,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toMatch(/\("digestPendingAt"\)/);
      expect(rows[0].indexdef).toMatch(
        /WHERE \(\(cardinality\("digestPending"\) > 0\) AND \("digestPendingAt" IS NOT NULL\)\)/,
      );
    });

    it('тик крона (все сайты): план — по индексу, без полного прохода', async () => {
      const p = await plan(null);
      expect(p).toContain(INDEX);
      expect(p).not.toMatch(/Seq Scan on assist_admin_insights/);
    });

    it('со списком сайтов условие запроса тоже выводит частичный индекс (индекс по сайту на время проверки снят)', async () => {
      // Аудит з13 P3-7: со списком сайтов планировщик берёт индекс
      // `(siteId, weekStart)` — по нему нельзя понять, применим ли
      // частичный. Снимаем его ВНУТРИ транзакции (откат — исключением).
      let p = '';
      const ROLLBACK = new Error('откат');
      await prisma
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
          await tx.$executeRawUnsafe(
            `DROP INDEX "${SITES_DB_SCHEMA}"."assist_admin_insights_siteId_weekStart_key"`,
          );
          const rows = await tx.$queryRawUnsafe<
            Array<{ 'QUERY PLAN': string }>
          >(`EXPLAIN ${PENDING_ROWS_SQL}`, ['site-a', 'site-b'], 50);
          p = rows.map((r) => r['QUERY PLAN']).join('\n');
          throw ROLLBACK;
        })
        .catch((e: unknown) => {
          if (e !== ROLLBACK) throw e;
        });
      expect(p).toContain(INDEX);
      expect(p).not.toMatch(/Seq Scan on assist_admin_insights/);
      // Индекс по сайту на месте (откат).
      const back = await prisma.$queryRawUnsafe<unknown[]>(
        `SELECT 1 FROM pg_indexes WHERE indexname = 'assist_admin_insights_siteId_weekStart_key'`,
      );
      expect(back).toHaveLength(1);
    });
  },
);
