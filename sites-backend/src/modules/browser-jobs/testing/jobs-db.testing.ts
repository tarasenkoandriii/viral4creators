/**
 * Тесты очереди браузерного воркера на НАСТОЯЩЕМ Postgres: клиент-владелец
 * и `describeDb` (без `SITES_DIRECT_URL` — пропуск с причиной, при
 * `CI=true` — провал), плюс прямая запись строк очереди для продуктов,
 * которым граф не даёт называть таблицы очереди (`browser-jobs-names`).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { SITES_DB_SCHEMA } from '../../../prisma/prisma.service';
import type { PrismaService } from '../../../prisma/prisma.service';

const RAW = process.env.SITES_DIRECT_URL;
const IN_CI = process.env.CI === 'true';

export function describeDb(name: string, body: () => void): void {
  if (!RAW) {
    describe(name, () => {
      (IN_CI ? it : it.skip)(
        'ПРОПУЩЕНО: нет SITES_DIRECT_URL (песочница без базы) — проверка идёт в CI, джоба sites-backend',
        () => {
          throw new Error(
            `CI=true, но SITES_DIRECT_URL не задана — «${name}» не выполнился`,
          );
        },
      );
    });
    return;
  }
  describe(name, body);
}

export function ownerPrisma(): PrismaService {
  const u = new URL(RAW!);
  u.searchParams.delete('schema');
  return new PrismaClient({
    adapter: new PrismaPg(u.toString(), { schema: SITES_DB_SCHEMA }),
  }) as unknown as PrismaService;
}

/** Строка очереди напрямую (тесты сверки продуктов). */
export async function insertBrowserJob(
  prisma: PrismaService,
  data: Prisma.SiteBrowserJobUncheckedCreateInput,
): Promise<string> {
  return (await prisma.siteBrowserJob.create({ data })).id;
}

export async function browserJobRow(prisma: PrismaService, id: string) {
  return prisma.siteBrowserJob.findUniqueOrThrow({ where: { id } });
}

/**
 * Файлы, которые берут/подметают задания очереди ГЛОБАЛЬНО (`claim` без
 * кабинета, `reap`/`reconcile` без области), не могут идти параллельно
 * друг с другом: в CI jest гоняет файлы в нескольких воркерах на одной
 * базе, и `claim` одного файла забирал задания другого (локально на
 * 2 ядрах jest шёл одним воркером — не видно; CI 229b803). Сессионная
 * advisory-блокировка на своём соединении сериализует ровно эти файлы,
 * остальные идут параллельно как раньше.
 */
export function serializeQueueTests(): void {
  let client: import('pg').Client | null = null;
  beforeAll(async () => {
    const { Client } = await import('pg');
    const u = new URL(RAW!);
    u.searchParams.delete('schema');
    client = new Client({ connectionString: u.toString() });
    await client.connect();
    await client.query(
      "SELECT pg_advisory_lock(hashtext('v4c:test:browser-jobs-queue'))",
    );
  }, 600_000);
  afterAll(async () => {
    if (!client) return;
    try {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext('v4c:test:browser-jobs-queue'))",
      );
    } finally {
      await client.end();
      client = null;
    }
  });
}

/** Ожидающие и идущие задания базы теста — в `cancelled` (чистая очередь). */
export async function cancelActiveJobs(prisma: PrismaService): Promise<void> {
  await prisma.siteBrowserJob.updateMany({
    where: { status: { in: ['queued', 'running'] } },
    data: { status: 'cancelled' },
  });
}

/** Уборка заданий без кабинета (`gen-<subject>`) после спека. */
export async function deleteJobsOf(
  prisma: PrismaService,
  accountIds: string[],
): Promise<void> {
  await prisma.siteBrowserJob.deleteMany({
    where: { accountId: { in: accountIds } },
  });
}
