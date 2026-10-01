/**
 * Приёмка Э0 на НАСТОЯЩЕМ Postgres: изоляция «Админки» ролью БД и
 * изоляция кабинетов (ТЗ помощника §4.3-бис слой 3 и п.4 теста-инварианта;
 * §4.4; план Э0, «Приёмка»).
 *
 * Где идёт: в CI (джоба sites-backend: Postgres `pgvector/pgvector:pg16`,
 * миграции накатаны `prisma migrate deploy` до jest). Строка — та же
 * `SITES_DIRECT_URL`, что у миграций. В песочнице без базы набор
 * ПРОПУСКАЕТСЯ с причиной в названии; в CI (`CI=true`) отсутствие строки —
 * провал, а не пропуск: иначе приёмка тихо перестала бы выполняться.
 *
 * Подключение — под владельцем схемы (суперпользователь в CI), а
 * `SET LOCAL ROLE assist_public` внутри транзакции переключает проверку
 * прав на публичную роль; ROLLBACK в конце не оставляет следов.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { tenantExtension } from './tenant';
import { SITES_DB_SCHEMA } from './prisma.service';

const RAW_URL = process.env.SITES_DIRECT_URL;
const IN_CI = process.env.CI === 'true';

/** `?schema=sites` нужен CLI Prisma; драйверу pg он ни к чему. */
function pgUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}

/** Таблицы «Админки» — из схемы, а не списком руками (§4.3-бис, п.4). */
function adminTables(): string[] {
  const schema = readFileSync(
    join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
    'utf8',
  );
  return [...schema.matchAll(/@@map\("(assist_admin_[^"]+)"\)/g)].map(
    (m) => m[1],
  );
}

if (!RAW_URL) {
  describe('изоляция на реальном Postgres', () => {
    // В CI пропуск недопустим — это и есть приёмка.
    (IN_CI ? it : it.skip)(
      'ПРОПУЩЕНО: нет SITES_DIRECT_URL (песочница без базы) — проверка идёт в CI, джоба sites-backend',
      () => {
        throw new Error(
          'CI=true, но SITES_DIRECT_URL не задана — приёмка изоляции не выполнилась',
        );
      },
    );
  });
} else {
  const url = pgUrl(RAW_URL);
  const S = `"${SITES_DB_SCHEMA}"`;

  describe('роль assist_public (реальный Postgres)', () => {
    let client: Client;

    beforeAll(async () => {
      client = new Client({ connectionString: url });
      await client.connect();
    });

    afterAll(async () => {
      await client.end();
    });

    /** Запрос под ролью assist_public; транзакция всегда откатывается. */
    async function asPublic(sql: string): Promise<void> {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE assist_public');
        await client.query(sql);
      } finally {
        await client.query('ROLLBACK');
      }
    }

    it('таблицы «Админки» в схеме нашлись — иначе проверка ниже пуста', () => {
      expect(adminTables()).toContain('assist_admin_chunks');
    });

    it.each(adminTables())(
      'SELECT из %s под assist_public падает (нет прав)',
      async (table) => {
        await expect(
          asPublic(`SELECT 1 FROM ${S}."${table}" LIMIT 1`),
        ).rejects.toMatchObject({ code: '42501' });
      },
    );

    it('контроль: SELECT из assist_site_chunks под той же ролью работает', async () => {
      // Без этого «падает» выше могло бы значить «таблицы нет» или «роли
      // нет», а не «прав нет».
      await expect(
        asPublic(`SELECT 1 FROM ${S}."assist_site_chunks" LIMIT 1`),
      ).resolves.toBeUndefined();
    });

    it.each([
      'site_accounts',
      'site_account_members',
      'site_ownership_challenges',
      'site_opt_out_domains',
      '_prisma_migrations',
    ])('SELECT из %s под assist_public падает', async (table) => {
      await expect(
        asPublic(`SELECT 1 FROM ${S}."${table}" LIMIT 1`),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('site_hosts: статусные колонки читаются, служебные — нет', async () => {
      await expect(
        asPublic(
          `SELECT "id", "host", "status", "expiresAt", "revokedAt" FROM ${S}."site_hosts" LIMIT 1`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(`SELECT "method" FROM ${S}."site_hosts" LIMIT 1`),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('знания «Сайт» роль только читает: INSERT запрещён', async () => {
      await expect(
        asPublic(
          `INSERT INTO ${S}."assist_site_chunks" ("id", "siteId", "text") VALUES ('x', 'y', 'z')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('учёт расходов виджета: INSERT в site_ai_usage разрешён', async () => {
      await expect(
        asPublic(
          `INSERT INTO ${S}."site_ai_usage" ("id", "product", "provider", "operation", "model", "pricingVersion") VALUES ('u1', 'assist', 'GEMINI', 'assist-chat', 'm', 'v')`,
        ),
      ).resolves.toBeUndefined();
    });

    /**
     * Права роли — БЕЛЫМ списком по ВСЕМ таблицам схемы (аудит Э0): список
     * таблиц берётся из базы, а не руками, поэтому новая таблица следующей
     * миграции (как `site_account_invites`, `site_web_sessions` — с хешами
     * токенов) попадает в проверку сама. Любое право сверх списка — провал.
     */
    it('во всей схеме у assist_public нет прав сверх белого списка', async () => {
      const ALLOWED: Record<string, string[]> = {
        site_sites: ['SELECT'],
        // Только колоночный SELECT статусных полей (миграция _sites_core_init).
        site_hosts: ['column:SELECT'],
        site_ai_usage: ['INSERT'],
        assist_site_chunks: ['SELECT'],
      };
      const TABLE_PRIVS = [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ];
      const COLUMN_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
      const { rows } = await client.query<{ t: string }>(
        `SELECT tablename AS t FROM pg_tables WHERE schemaname = $1 ORDER BY 1`,
        [SITES_DB_SCHEMA],
      );
      const tables = rows.map((r) => r.t);
      // Не пустая проверка: таблицы с токенами сессий/приглашений — в ней.
      expect(tables).toEqual(
        expect.arrayContaining([
          'site_web_sessions',
          'site_account_invites',
          'assist_admin_chunks',
        ]),
      );
      const actual: Record<string, string[]> = {};
      for (const t of tables) {
        const rel = `${S}."${t}"`;
        const got: string[] = [];
        for (const p of TABLE_PRIVS) {
          const r = await client.query<{ ok: boolean }>(
            `SELECT has_table_privilege('assist_public', $1, $2) AS ok`,
            [rel, p],
          );
          if (r.rows[0].ok) got.push(p);
        }
        for (const p of COLUMN_PRIVS) {
          if (got.includes(p)) continue;
          const r = await client.query<{ ok: boolean }>(
            `SELECT has_any_column_privilege('assist_public', $1, $2) AS ok`,
            [rel, p],
          );
          if (r.rows[0].ok) got.push(`column:${p}`);
        }
        if (got.length > 0 || ALLOWED[t]) actual[t] = got;
      }
      expect(actual).toEqual(ALLOWED);
    });

    it('роль не может войти сама (NOLOGIN)', async () => {
      const r = await client.query(
        `SELECT rolcanlogin FROM pg_roles WHERE rolname = 'assist_public'`,
      );
      expect(r.rows).toEqual([{ rolcanlogin: false }]);
    });
  });

  describe('кабинеты на реальной базе: адаптер со схемой sites + тенант', () => {
    const prisma = new PrismaClient({
      adapter: new PrismaPg(url, { schema: SITES_DB_SCHEMA }),
    });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const A = `e0-acc-a-${suffix}`;
    const B = `e0-acc-b-${suffix}`;

    beforeAll(async () => {
      for (const id of [A, B]) {
        await prisma.siteAccount.create({
          data: { id, verifyToken: `tok-${id}` },
        });
        await prisma.site.create({
          data: { id: `site-${id}`, accountId: id, name: `Сайт ${id}` },
        });
      }
    });

    afterAll(async () => {
      await prisma.siteAccount.deleteMany({ where: { id: { in: [A, B] } } });
      await prisma.$disconnect();
    });

    it('forAccount(A) видит только сайты кабинета A', async () => {
      const db = prisma.$extends(tenantExtension(A));
      const sites = await db.site.findMany({
        where: { id: { startsWith: 'site-e0-acc-' } },
      });
      expect(sites.map((s) => s.accountId)).toEqual([A]);
    });

    it('дубль хоста в кабинете отклоняется, в другом кабинете — можно', async () => {
      const host = { scheme: 'https', host: 'example.com', port: 443 };
      await prisma.siteHost.create({
        data: { ...host, accountId: A, siteId: `site-${A}` },
      });
      await expect(
        prisma.siteHost.create({
          data: { ...host, accountId: A, siteId: `site-${A}` },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        prisma.siteHost.create({
          data: { ...host, accountId: B, siteId: `site-${B}` },
        }),
      ).resolves.toMatchObject({ accountId: B });
    });

    it('хост кабинета A нельзя привязать к сайту кабинета B (составной FK)', async () => {
      await expect(
        prisma.siteHost.create({
          data: {
            scheme: 'https',
            host: 'shop.example.com',
            port: 443,
            accountId: A,
            siteId: `site-${B}`,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });
  });
}
