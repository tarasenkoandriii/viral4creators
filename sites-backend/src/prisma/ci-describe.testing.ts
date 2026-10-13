/**
 * AI Publisher (P-A1, проектный документ §16.0): общий хелпер db-тестов
 * пакетов Publisher — `ciDescribe`.
 *
 *  - база есть (`SITES_DIRECT_URL`) — обычный `describe`;
 *  - базы нет: в CI (`CI=true`) — ПАДЕНИЕ (приёмка не должна тихо
 *    перестать выполняться), локально — пропуск с причиной.
 *
 * Клиент — владелец схемы `sites` через тот же адаптер, что у
 * `PrismaService` (`PrismaPg` со `schema: 'sites'`); `SitesDb` поверх него
 * — как в проде. Тесты на общей базе работают только со своими кабинетами
 * (`seedTwoAccounts`) и не чистят append-only таблицы (их нельзя удалить).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { PrismaService, SITES_DB_SCHEMA } from './prisma.service';
import { SitesDb } from './sites-db.service';

export const CI_DB_URL = process.env.SITES_DIRECT_URL;
export const IN_CI = process.env.CI === 'true';

/** `?schema=sites` нужен CLI Prisma; драйверу pg — нет. */
export function driverUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}

export function hasTestDb(): boolean {
  return !!CI_DB_URL;
}

export function ciDescribe(name: string, body: () => void): void {
  if (!CI_DB_URL) {
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

/** Клиент владельца схемы (как `PrismaService`, но строка — тестовая). */
export function testPrisma(): PrismaService {
  if (!CI_DB_URL) throw new Error('testPrisma: нет SITES_DIRECT_URL');
  return new PrismaClient({
    adapter: new PrismaPg(driverUrl(CI_DB_URL), { schema: SITES_DB_SCHEMA }),
  }) as unknown as PrismaService;
}

export function testSitesDb(prisma: PrismaService): SitesDb {
  return new SitesDb(prisma);
}
