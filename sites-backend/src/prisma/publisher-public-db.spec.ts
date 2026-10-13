/**
 * PublisherPublicDb — клиент под логин-ролью в `publisher_public` (P-A0,
 * Р-PUB-5). Без базы — проверки конфигурации; на реальном Postgres (CI:
 * логин-роль `publisher_public_ci` создаёт шаг джобы sites-backend после
 * миграций) — этот самый клиент с адаптером схемы `sites` читает
 * публичное представление и получает 42501 на таблицах продукта.
 * В CI отсутствие строки — провал, а не пропуск.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PublisherPublicDb,
  assertDistinctPublisherLogin,
  publisherPublicClientOptions,
  publisherPublicConfigured,
} from './publisher-public-db.service';

const PUBLIC_URL = process.env.PUBLISHER_PUBLIC_DATABASE_URL;
const IN_CI = process.env.CI === 'true';

describe('PublisherPublicDb — конфигурация', () => {
  it('тот же логин, что у основного клиента или у виджета, — отказ без пароля в тексте', () => {
    for (const others of [
      { main: 'postgresql://same.ref:SeCrEt2@h:6543/postgres' },
      { assist: 'postgresql://same.ref:SeCrEt3@h:6543/postgres' },
    ]) {
      let message = '';
      try {
        assertDistinctPublisherLogin(
          'postgresql://same.ref:SeCrEt1@h:6543/postgres',
          others,
        );
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/PUBLISHER_PUBLIC_DATABASE_URL/);
      expect(message).toMatch(/publisher_public/);
      expect(message).not.toMatch(/SeCrEt/);
    }
  });

  it('разные логины или нет строки — можно; без строки маршруты закрыты (configured=false)', () => {
    expect(() =>
      assertDistinctPublisherLogin(
        'postgresql://publisher_site.ref:a@h/postgres',
        {
          main: 'postgresql://postgres.ref:b@h/postgres',
          assist: 'postgresql://assist_widget.ref:c@h/postgres',
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertDistinctPublisherLogin(undefined, {
        main: 'postgresql://u:p@h/db',
      }),
    ).not.toThrow();
    expect(publisherPublicConfigured({})).toBe(false);
    expect(
      publisherPublicConfigured({ PUBLISHER_PUBLIC_DATABASE_URL: '  ' }),
    ).toBe(false);
    expect(
      publisherPublicConfigured({
        PUBLISHER_PUBLIC_DATABASE_URL: 'postgresql://x@h/db',
      }),
    ).toBe(true);
  });

  it('без строки сервис создаётся и не подключается (кабинет не падает)', async () => {
    const saved = process.env.PUBLISHER_PUBLIC_DATABASE_URL;
    delete process.env.PUBLISHER_PUBLIC_DATABASE_URL;
    try {
      const svc = new PublisherPublicDb();
      expect(svc.configured).toBe(false);
      await expect(svc.onModuleInit()).resolves.toBeUndefined();
    } finally {
      if (saved !== undefined)
        process.env.PUBLISHER_PUBLIC_DATABASE_URL = saved;
    }
  });
});

if (!PUBLIC_URL) {
  describe('PublisherPublicDb на реальном Postgres (нет строки)', () => {
    (IN_CI ? it : it.skip)(
      'ПРОПУЩЕНО: нет PUBLISHER_PUBLIC_DATABASE_URL — проверка идёт в CI, джоба sites-backend',
      () => {
        throw new Error(
          'CI=true, но PUBLISHER_PUBLIC_DATABASE_URL не задана — проверка роли Publisher не выполнилась',
        );
      },
    );
  });
} else {
  describe('PublisherPublicDb на реальном Postgres', () => {
    const client = new PrismaClient(publisherPublicClientOptions(PUBLIC_URL));

    afterAll(async () => {
      await client.$disconnect();
    });

    it('сырой SQL к представлению с адаптером схемы sites — работает', async () => {
      const rows = await client.$queryRaw<Array<{ n: bigint }>>(
        Prisma.sql`SELECT count(*) AS n FROM "sites"."pub_public_products"`,
      );
      expect(rows).toHaveLength(1);
    });

    it('таблица продукта и таблица помощника — 42501 от Postgres', async () => {
      for (const t of ['pub_products', 'assist_site_chunks', 'site_accounts']) {
        await expect(
          client.$queryRawUnsafe(`SELECT 1 FROM "sites"."${t}" LIMIT 1`),
        ).rejects.toThrow(/permission denied|42501/i);
      }
    });
  });
}
