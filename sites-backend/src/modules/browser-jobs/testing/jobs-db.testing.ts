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
