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
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { tenantExtension } from './tenant';
import { SITES_DB_SCHEMA } from './prisma.service';
import { ASSIST_PUBLIC_OMIT } from './assist-public-db.service';

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
      '_prisma_migrations',
      // Э1: обход, источники, версии, исключения, бюджет — не публичное.
      'site_pages',
      'site_crawl_runs',
      'site_crawl_queue',
      'site_cron_locks',
      'assist_site_sources',
      'assist_site_documents',
      'assist_site_knowledge_versions',
      'assist_site_exclusions',
      'assist_site_eval_cases',
      'assist_site_eval_runs',
      'assist_learning_spend',
      // Э2: кабинетное и чужое публичному маршруту.
      'assist_site_wizards',
      'assist_acquisitions',
      'assist_site_leads',
      'assist_widget_drafts',
      'assist_landing_events',
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

    it('site_opt_out_domains (Э1, песочница L0): domain читается, остальное — нет', async () => {
      await expect(
        asPublic(`SELECT "domain" FROM ${S}."site_opt_out_domains" LIMIT 1`),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(`SELECT "source" FROM ${S}."site_opt_out_domains" LIMIT 1`),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('Э1: опубликованная версия и FAQ «Сайта» читаются (поиск виджета/песочницы)', async () => {
      await expect(
        asPublic(`SELECT "knowledgeVersion" FROM ${S}."assist_sites" LIMIT 1`),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(
          `SELECT "question", "answer", "variants", "lang", "status" FROM ${S}."assist_site_faq" LIMIT 1`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(
          `UPDATE ${S}."assist_sites" SET "knowledgeVersion" = 1 WHERE false`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('Э2: черновики и telegramId роли не видны', async () => {
      for (const sql of [
        `SELECT "widgetDraft" FROM ${S}."assist_sites" LIMIT 1`,
        `SELECT "personaDraft" FROM ${S}."assist_sites" LIMIT 1`,
        `SELECT "createdByTelegramId" FROM ${S}."assist_site_faq" LIMIT 1`,
        `SELECT "approvedByTelegramId" FROM ${S}."assist_site_faq" LIMIT 1`,
        `SELECT "createdByTelegramId" FROM ${S}."assist_sandboxes" LIMIT 1`,
        `SELECT "createdByTelegramId" FROM ${S}."assist_site_preview_tokens" LIMIT 1`,
        `SELECT "publishedByTelegramId" FROM ${S}."assist_site_config_versions" LIMIT 1`,
        `UPDATE ${S}."assist_sandboxes" SET "accountId" = 'x' WHERE false`,
        `UPDATE ${S}."assist_sandboxes" SET "transferredAt" = now() WHERE false`,
        `UPDATE ${S}."assist_site_preview_tokens" SET "siteId" = 'x' WHERE false`,
        `UPDATE ${S}."assist_site_leads" SET "deliveryState" = 'x' WHERE false`,
        `DELETE FROM ${S}."assist_site_messages" WHERE false`,
      ]) {
        await expect(asPublic(sql)).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('Э2: виджет читает статус хоста с блокировкой и пишет свои таблицы', async () => {
      await expect(
        asPublic(
          `SELECT "id", "siteId", "status", "expiresAt", "revokedAt", "reverifyBlockedAt" FROM ${S}."site_hosts" LIMIT 1`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(
          `SELECT "publicKey", "widgetVersion", "chatPaused", "operatorBlockedAt", "ipSalt", "allowClientPreview", "leadsConfig", "siteSummary" FROM ${S}."assist_sites" LIMIT 1`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(
          `INSERT INTO ${S}."assist_budget_days" ("scope", "key", "day", "updatedAt") VALUES ('site', 's', '2026-10-01', now()) ON CONFLICT DO NOTHING`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(
          `INSERT INTO ${S}."assist_landing_events" ("id", "name") VALUES ('e1', 'view')`,
        ),
      ).resolves.toBeUndefined();
    });

    it('Э1: публичная песочница пишет только свои таблицы и счётчики', async () => {
      await expect(
        asPublic(
          `INSERT INTO ${S}."assist_sandboxes" ("id", "kind", "url", "host", "registrableDomain", "pagesLimit", "questionsLimit", "expiresAt", "updatedAt") VALUES ('sb1', 'public', 'https://a.example/', 'a.example', 'a.example', 8, 10, now(), now())`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(
          `INSERT INTO ${S}."assist_daily_counters" ("scope", "key", "day", "value", "updatedAt") VALUES ('sandbox-ip', 'k', '2026-10-01', 1, now()) ON CONFLICT ("scope", "key", "day") DO UPDATE SET "value" = ${S}."assist_daily_counters"."value" + 1`,
        ),
      ).resolves.toBeUndefined();
      await expect(
        asPublic(`DELETE FROM ${S}."assist_sandboxes" WHERE false`),
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
        // Только колоночный SELECT статусных полей (миграция _sites_core_init;
        // Э2 добавил reverifyBlockedAt для гварда origin).
        site_hosts: ['column:SELECT'],
        site_ai_usage: ['INSERT'],
        assist_site_chunks: ['SELECT'],
        // Э1 → Э2: поиск виджета/песочницы по опубликованной версии «Сайта».
        // Э2 сузил до колонок: черновики вида/персоны и настройки лидов — кабинету.
        assist_sites: ['column:SELECT'],
        assist_site_faq: ['column:SELECT'],
        // Э1: публичная песочница лендинга под этой ролью; Э2 сузил до
        // колонок (telegramId создателя, перенос, кабинет — не её).
        assist_sandboxes: ['column:SELECT', 'column:INSERT', 'column:UPDATE'],
        assist_sandbox_pages: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        assist_sandbox_chunks: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        assist_sandbox_messages: ['SELECT', 'INSERT'],
        assist_daily_counters: ['SELECT', 'INSERT', 'UPDATE'],
        site_crawl_robots: ['SELECT', 'INSERT', 'UPDATE'],
        // Отказ доменов (L0): только колонка domain.
        site_opt_out_domains: ['column:SELECT'],
        // Э2 (миграция _assist_widget): виджет «Сайта».
        assist_site_config_versions: ['column:SELECT'],
        assist_site_visitor_resumes: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        assist_site_conversations: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        assist_site_messages: ['SELECT', 'INSERT', 'UPDATE'],
        assist_site_leads: ['INSERT'],
        assist_budget_days: ['SELECT', 'INSERT', 'UPDATE'],
        assist_budget_reservations: ['SELECT', 'INSERT', 'DELETE'],
        assist_site_period_usage: ['SELECT', 'INSERT', 'UPDATE'],
        assist_rate_buckets: ['SELECT', 'INSERT', 'UPDATE'],
        assist_site_semantic_cache: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        assist_site_preview_tokens: ['column:SELECT', 'column:UPDATE'],
        assist_site_install_pings: ['SELECT', 'INSERT', 'UPDATE'],
        assist_site_assets: ['column:SELECT'],
        // Лендинг: только запись.
        assist_widget_drafts: ['INSERT'],
        assist_landing_events: ['INSERT'],
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
          'assist_admin_settings',
          'site_pages',
          'assist_sandboxes',
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

    /**
     * Глобальный `omit` публичного клиента (ASSIST_PUBLIC_OMIT) обязан
     * совпадать с колоночными правами: лишняя колонка в omit — тихо пустое
     * поле, недостающая — 42501 на каждом запросе без select.
     */
    it('Э2: ASSIST_PUBLIC_OMIT = колонки без SELECT у роли', async () => {
      const models = Prisma.dmmf.datamodel.models;
      for (const [key, omitted] of Object.entries(ASSIST_PUBLIC_OMIT)) {
        const model = models.find(
          (m) => m.name.charAt(0).toLowerCase() + m.name.slice(1) === key,
        );
        expect(model).toBeDefined();
        const table = model!.dbName ?? model!.name;
        const closed: string[] = [];
        for (const f of model!.fields) {
          if (f.kind === 'object') continue;
          const r = await client.query<{ ok: boolean }>(
            `SELECT has_column_privilege('assist_public', $1, $2, 'SELECT') AS ok`,
            [`${S}."${table}"`, f.dbName ?? f.name],
          );
          if (!r.rows[0].ok) closed.push(f.name);
        }
        expect(closed.sort()).toEqual(Object.keys(omitted).sort());
      }
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
