/**
 * AI Publisher, P-A0: роль `publisher_public` и публичные представления на
 * реальном Postgres (проектный документ §6.5, Р-PUB-5, аудит P1-1, P3-3).
 *
 *  - права роли — белым списком по ВСЕМ таблицам и представлениям схемы;
 *  - `assist_public` к `pub_*` не имеет ни одного права (и наоборот —
 *    publisher_public к помощнику и ядру);
 *  - фактический SQL приёма заявки проходит под ролью, лишнее — 42501;
 *  - `pub_public_products`: допуск хостов ≡ `evaluateHostAccess(host,
 *    'publisher-public')` на векторах host-access.spec, независимо от
 *    TimeZone сессии; форма и параметры — по режиму;
 *  - `pub_public_contents`: сайт показывает опубликованную версию, пока
 *    новая не опубликована; снятый материал — строка withdrawn;
 *  - раунд исправлений аудита: атрибуты роли и отсутствие членств,
 *    createdBy и серверное время не вставляются ролью, anon/authenticated
 *    (Supabase) без прав на pub_*, архивные продукты и допущения без
 *    решения не читаются, отозванный источник не раскрывается.
 *
 * Подключение — владельцем схемы; `SET LOCAL ROLE publisher_public` внутри
 * транзакции, которая всегда откатывается.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import {
  HostAccessRow,
  evaluateHostAccess,
} from '../modules/site-core/ownership/host-access';
import {
  M,
  PUB_RAW_URL,
  PubDb,
  PubWorld,
  connectOwner,
  describeWithoutDb,
  hex64,
  json,
  rid,
  uuid4,
} from './publisher-schema.testing';

/** Случайный publicRef формата L- + 10 base32 (запрос P-A1). */
function publicRef(): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  return `L-${Array.from({ length: 10 }, () => A[Math.floor(Math.random() * 32)]).join('')}`;
}

/** Белый список прав publisher_public (миграция …_publisher_core). */
const ALLOWED: Record<string, string[]> = {
  pub_public_products: ['SELECT'],
  pub_public_contents: ['SELECT'],
  pub_leads: ['column:SELECT', 'column:INSERT'],
  pub_lead_contacts: ['column:INSERT'],
  pub_events: ['column:INSERT'],
  pub_sessions: ['column:INSERT'],
  pub_lead_outbox: ['column:INSERT'],
  pub_rate_hits: ['INSERT', 'column:SELECT'],
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

if (!PUB_RAW_URL) {
  describeWithoutDb('AI Publisher: роль publisher_public на реальном Postgres');
} else {
  let client: Client;
  let db: PubDb;

  beforeAll(async () => {
    client = await connectOwner();
    db = new PubDb(client);
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await db.begin();
  });
  afterEach(async () => {
    await db.rollback();
  });

  async function privileges(role: string): Promise<Record<string, string[]>> {
    const rels = await db.q<{ t: string }>(
      `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'sites' AND c.relkind IN ('r', 'v', 'm') ORDER BY 1`,
    );
    const out: Record<string, string[]> = {};
    for (const { t } of rels) {
      const rel = `"sites"."${t}"`;
      const got: string[] = [];
      for (const p of TABLE_PRIVS) {
        const [r] = await db.q<{ ok: boolean }>(
          `SELECT has_table_privilege($1, $2, $3) AS ok`,
          [role, rel, p],
        );
        if (r.ok) got.push(p);
      }
      for (const p of COLUMN_PRIVS) {
        if (got.includes(p)) continue;
        const [r] = await db.q<{ ok: boolean }>(
          `SELECT has_any_column_privilege($1, $2, $3) AS ok`,
          [role, rel, p],
        );
        if (r.ok) got.push(`column:${p}`);
      }
      if (got.length > 0) out[t] = got;
    }
    return out;
  }

  /** Запрос под ролью внутри текущей транзакции (SAVEPOINT — для отказов). */
  async function asPublisher<T = unknown>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    // При ошибке транзакция прервана: роль вернёт ROLLBACK TO SAVEPOINT
    // (SET LOCAL откатывается вместе с подтранзакцией) в PubDb.fails.
    await db.q('SET LOCAL ROLE publisher_public');
    const rows = (await db.q(sql, params)) as T[];
    await db.q('RESET ROLE');
    return rows;
  }

  describe('роль publisher_public: права', () => {
    it('NOLOGIN; права по всей схеме (таблицы и представления) — ровно белый список', async () => {
      const [r] = await db.q<Record<string, boolean>>(
        `SELECT rolcanlogin, rolsuper, rolbypassrls, rolreplication, rolcreaterole, rolcreatedb, rolinherit
           FROM pg_roles WHERE rolname = 'publisher_public'`,
      );
      // Аудит P3-7: никаких атрибутов, кроме наследования прав по умолчанию.
      expect(r).toEqual({
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: false,
        rolreplication: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolinherit: true,
      });
      // …и роль ни в какую другую не входит (права только свои).
      expect(
        await db.q(
          `SELECT g.rolname FROM pg_auth_members m
             JOIN pg_roles g ON g.oid = m.roleid
             JOIN pg_roles u ON u.oid = m.member
            WHERE u.rolname = 'publisher_public'`,
        ),
      ).toEqual([]);
      expect(await privileges('publisher_public')).toEqual(ALLOWED);
    });

    it('anon и authenticated (Supabase), если есть, к pub_* не имеют ни одного права (аудит P3-14)', async () => {
      const roles = await db.q<{ r: string }>(
        `SELECT rolname AS r FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`,
      );
      for (const { r } of roles) {
        const all = await privileges(r);
        expect(Object.keys(all).filter((t) => t.startsWith('pub_'))).toEqual(
          [],
        );
      }
    });

    it('цикл REVOKE миграции снимает права anon/authenticated, когда роли есть (проверка в откатываемой транзакции)', async () => {
      const sql = readFileSync(
        join(
          __dirname,
          '../../prisma/migrations/20261016090000_publisher_core/migration.sql',
        ),
        'utf8',
      );
      const at = sql.indexOf("'{anon,authenticated}'");
      const start = sql.lastIndexOf('DO $$', at);
      const end = sql.indexOf('\n$$;', at);
      expect(at > 0 && start > 0 && end > at).toBe(true);
      const block = sql.slice(start, end + 4);
      expect(block.match(/DO \$\$/g)).toHaveLength(1);
      const exists = await db.q(
        `SELECT 1 FROM pg_roles WHERE rolname = 'anon'`,
      );
      if (exists.length === 0) await db.q('CREATE ROLE anon NOLOGIN');
      await db.q(
        'GRANT ALL ON "sites"."pub_leads", "sites"."pub_public_products" TO anon',
      );
      expect(Object.keys(await privileges('anon'))).toEqual(
        expect.arrayContaining(['pub_leads', 'pub_public_products']),
      );
      await db.q('SET LOCAL search_path = sites');
      await db.q(block);
      const left = Object.keys(await privileges('anon')).filter((t) =>
        t.startsWith('pub_'),
      );
      expect(left).toEqual([]);
    });

    it('createdBy и серверное время — не колонки роли (аудит P1-2, P3-6)', async () => {
      const cols = await db.q<{ t: string; c: string }>(
        `SELECT c.relname AS t, a.attname AS c
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'sites' AND c.relname LIKE 'pub\\_%' AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname IN ('createdBy', 'receivedAt', 'occurredAt', 'startedAt', 'createdAt')
            AND has_column_privilege('publisher_public', a.attrelid, a.attname, 'INSERT')`,
      );
      expect(cols).toEqual([]);
    });

    it('колонки pub_leads: SELECT — только поиск повтора, INSERT — только минимальная заявка', async () => {
      const cols = await db.q<{
        c: string;
        s: boolean;
        i: boolean;
        u: boolean;
      }>(
        `SELECT a.attname AS c,
                has_column_privilege('publisher_public', a.attrelid, a.attname, 'SELECT') AS s,
                has_column_privilege('publisher_public', a.attrelid, a.attname, 'INSERT') AS i,
                has_column_privilege('publisher_public', a.attrelid, a.attname, 'UPDATE') AS u
           FROM pg_attribute a WHERE a.attrelid = '"sites"."pub_leads"'::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
      );
      expect(
        cols
          .filter((c) => c.s)
          .map((c) => c.c)
          .sort(),
      ).toEqual(
        [
          'id',
          'productId',
          'publicRef',
          'receivedAt',
          'requestHash',
          'submissionKey',
        ].sort(),
      );
      const inserted = cols.filter((c) => c.i).map((c) => c.c);
      for (const forbidden of [
        'prospectId',
        'status',
        'responsibleMemberId',
        'attribution',
        'campaignId',
        'contentId',
        'placementId',
        'enrichedAt',
        'closedAt',
        'erasedAt',
        'duplicateOfLeadId',
        'createdBy',
        'receivedAt',
      ]) {
        expect(inserted).not.toContain(forbidden);
      }
      expect(cols.some((c) => c.u)).toBe(false);
    });

    it('assist_public к pub_* (таблицы и представления) не имеет ни одного права', async () => {
      const all = await privileges('assist_public');
      expect(Object.keys(all).filter((t) => t.startsWith('pub_'))).toEqual([]);
    });

    it('чужое для роли — 42501: ядро, помощник, остальные pub_*', async () => {
      for (const t of [
        'site_accounts',
        'site_hosts',
        'site_sites',
        'assist_site_chunks',
        'assist_site_leads',
        'pub_products',
        'pub_parameters',
        'pub_lead_decisions',
        'pub_audit_events',
        '_prisma_migrations',
      ]) {
        await db.fails('42501', () =>
          asPublisher(`SELECT 1 FROM "sites"."${t}" LIMIT 1`),
        );
      }
      // Контакт и заявка целиком — не читаются.
      await db.fails('42501', () =>
        asPublisher(
          `SELECT "contactEnc" FROM "sites"."pub_lead_contacts" LIMIT 1`,
        ),
      );
      await db.fails('42501', () =>
        asPublisher(`SELECT * FROM "sites"."pub_leads" LIMIT 1`),
      );
      await db.fails('42501', () =>
        asPublisher(`UPDATE "sites"."pub_leads" SET "status" = 'won'`),
      );
      await db.fails('42501', () =>
        asPublisher(`DELETE FROM "sites"."pub_rate_hits"`),
      );
    });

    it('функции миграции роли не вызвать (EXECUTE снят у PUBLIC)', async () => {
      await db.fails('42501', () =>
        asPublisher(`SELECT "sites"."pub_looks_contact"('x')`),
      );
    });
  });

  describe('приём заявки — ровно тот SQL, что пойдёт под ролью (раздел 11.4)', () => {
    it('поиск повтора, окно лимита, заявка, контакт, сессия, событие, очередь — проходят; лишние колонки — 42501', async () => {
      const w = await db.world({ mode: 'test' });
      const [pp] = await db.q<{ publicKey: string }>(
        `SELECT "publicKey" FROM "sites"."pub_products" WHERE "id" = $1`,
        [w.productId],
      );
      const leadId = rid('lead');
      const submissionKey = uuid4();
      const rateKey = `${w.productId}:lead:${hex64()}`;
      await db.q('SET LOCAL ROLE publisher_public');
      // 1. Продукт по ключу — через представление.
      const [prod] = await db.q<{
        id: string;
        accountId: string;
        formOpen: boolean;
        formLimitCount: number;
      }>(
        `SELECT "id", "accountId", "formOpen", "formLimitCount", "formLimitWindowSec", "allowedOrigins", "altContact"
           FROM "sites"."pub_public_products" WHERE "publicKey" = $1`,
        [pp.publicKey],
      );
      expect(prod).toMatchObject({
        id: w.productId,
        accountId: w.accountId,
        formOpen: true,
        formLimitCount: 5,
      });
      // 2. Повтор по submissionKey — колоночный SELECT.
      expect(
        await db.q(
          `SELECT "id", "requestHash", "publicRef", "receivedAt" FROM "sites"."pub_leads" WHERE "productId" = $1 AND "submissionKey" = $2`,
          [w.productId, submissionKey],
        ),
      ).toEqual([]);
      // 3. Лимитер: замок, счёт окна, удар.
      await db.q(`SELECT pg_advisory_xact_lock(hashtext($1))`, [rateKey]);
      const [cnt] = await db.q<{ n: string }>(
        `SELECT count(*) AS n FROM "sites"."pub_rate_hits" WHERE "key" = $1 AND "at" > now() - interval '600 seconds'`,
        [rateKey],
      );
      expect(Number(cnt.n)).toBe(0);
      await db.q(
        `INSERT INTO "sites"."pub_rate_hits" ("id", "key") VALUES ($1, $2)`,
        [rid('rh'), rateKey],
      );
      // 4. Минимальная заявка, шифротекст, сессия, событие, очередь.
      await db.q(
        `INSERT INTO "sites"."pub_leads" ("id", "accountId", "productId", "submissionKey", "requestHash", "publicRef",
            "testFlag", "testReason", "suspectedSpam", "contactMethod", "budgetRange", "selfReportedChannel", "contentSlugRaw",
            "placementCodeRaw", "sessionRef", "consentState", "reviewDueAt")
         VALUES ($1, $2, $3, $4, $5, $6, true, 'test_mode', false, 'email', 'b_10k', 'search', 'guide', NULL,
                 'sess_abcdefgh', 'not_required', now() + interval '90 days')
         ON CONFLICT ("productId", "submissionKey") DO NOTHING
         RETURNING "id", "publicRef", "receivedAt"`,
        [leadId, w.accountId, w.productId, submissionKey, hex64(), publicRef()],
      );
      await db.q(
        `INSERT INTO "sites"."pub_lead_contacts" ("id", "accountId", "productId", "leadId", "contactEnc", "matchHash", "keyVersion")
         VALUES ($1, $2, $3, $4, 'v1.aXY.dGFn.Y3Q', $5, 'v1')`,
        [rid('lc'), w.accountId, w.productId, leadId, hex64()],
      );
      for (let i = 0; i < 2; i++) {
        await db.q(
          `INSERT INTO "sites"."pub_sessions" ("id", "accountId", "productId", "sessionRef", "landingPath", "utm", "consentState", "testFlag")
           VALUES ($1, $2, $3, 'sess_abcdefgh', '/guide', $4, 'not_required', true) ON CONFLICT DO NOTHING`,
          [rid('ss'), w.accountId, w.productId, json({ source: 'telegram' })],
        );
      }
      const eventId = uuid4();
      for (let i = 0; i < 2; i++) {
        await db.q(
          `INSERT INTO "sites"."pub_events" ("id", "accountId", "productId", "eventId", "name", "leadId", "sessionRef", "testFlag", "utm")
           VALUES ($1, $2, $3, $4, 'lead_submit_success', $5, 'sess_abcdefgh', true, NULL) ON CONFLICT DO NOTHING`,
          [rid('ev'), w.accountId, w.productId, eventId, leadId],
        );
      }
      await db.q(
        `INSERT INTO "sites"."pub_lead_outbox" ("id", "accountId", "productId", "leadId", "kind") VALUES ($1, $2, $3, $4, 'lead_received')`,
        [rid('ob'), w.accountId, w.productId, leadId],
      );
      // Повтор той же заявки находится колоночным SELECT.
      expect(
        await db.q(
          `SELECT "id" FROM "sites"."pub_leads" WHERE "productId" = $1 AND "submissionKey" = $2`,
          [w.productId, submissionKey],
        ),
      ).toEqual([{ id: leadId }]);
      await db.q('RESET ROLE');
      const [counts] = await db.q<{ s: string; e: string; o: string }>(
        `SELECT (SELECT count(*) FROM "sites"."pub_sessions" WHERE "productId" = $1) AS s,
                (SELECT count(*) FROM "sites"."pub_events" WHERE "productId" = $1) AS e,
                (SELECT count(*) FROM "sites"."pub_lead_outbox" WHERE "productId" = $1) AS o`,
        [w.productId],
      );
      expect(counts).toEqual({ s: '1', e: '1', o: '1' });
      // createdBy и время — значения сервера, не клиента.
      const [lead] = await db.q<{ createdBy: string; fresh: boolean }>(
        `SELECT "createdBy", "receivedAt" > now() - interval '1 minute' AS fresh FROM "sites"."pub_leads" WHERE "id" = $1`,
        [leadId],
      );
      expect(lead).toEqual({ createdBy: 'public', fresh: true });
      // Аудит P1-2: роль не подставит createdBy (restore:<id>) и время.
      for (const [col, val] of [
        ['createdBy', "'restore:r1'"],
        ['receivedAt', "now() - interval '30 days'"],
      ]) {
        await db.fails('42501', () =>
          asPublisher(
            `INSERT INTO "sites"."pub_leads" ("id", "accountId", "productId", "submissionKey", "requestHash", "publicRef", "testFlag", "testReason", "contactMethod", "consentState", "reviewDueAt", "${col}")
             VALUES ($1, $2, $3, $4, $5, $6, true, 'test_mode', 'email', 'unknown', now(), ${val})`,
            [
              rid('lead'),
              w.accountId,
              w.productId,
              uuid4(),
              hex64(),
              publicRef(),
            ],
          ),
        );
      }
      await db.fails('42501', () =>
        asPublisher(
          `INSERT INTO "sites"."pub_events" ("id", "accountId", "productId", "eventId", "name", "testFlag", "occurredAt")
           VALUES ($1, $2, $3, $4, 'cta_click', true, now() - interval '30 days')`,
          [rid('ev'), w.accountId, w.productId, uuid4()],
        ),
      );
      // Обогащение и статусы — не этой роли.
      await db.fails('42501', () =>
        asPublisher(
          `INSERT INTO "sites"."pub_leads" ("id", "accountId", "productId", "submissionKey", "requestHash", "publicRef", "testFlag", "testReason", "contactMethod", "consentState", "reviewDueAt", "prospectId")
           VALUES ($1, $2, $3, $4, $5, $6, true, 'test_mode', 'email', 'unknown', now(), 'p1')`,
          [
            rid('lead'),
            w.accountId,
            w.productId,
            uuid4(),
            hex64(),
            publicRef(),
          ],
        ),
      );
      await db.fails('42501', () =>
        asPublisher(
          `INSERT INTO "sites"."pub_lead_outbox" ("id", "accountId", "productId", "leadId", "kind", "status") VALUES ($1, $2, $3, $4, 'lead_received', 'done')`,
          [rid('ob'), w.accountId, w.productId, leadId],
        ),
      );
    });

    it('гварды работают и под ролью (SECURITY DEFINER читает продукт): нетестовая заявка в режиме test — 23514', async () => {
      const w = await db.world({ mode: 'test' });
      await db.rejects(
        () =>
          asPublisher(
            `INSERT INTO "sites"."pub_leads" ("id", "accountId", "productId", "submissionKey", "requestHash", "publicRef", "testFlag", "contactMethod", "consentState", "reviewDueAt")
           VALUES ($1, $2, $3, $4, $5, $6, false, 'email', 'unknown', now())`,
            [
              rid('lead'),
              w.accountId,
              w.productId,
              uuid4(),
              hex64(),
              publicRef(),
            ],
          ),
        /режиме test/,
      );
      await db.rejects(
        () =>
          asPublisher(
            `INSERT INTO "sites"."pub_events" ("id", "accountId", "productId", "eventId", "name", "testFlag", "utm") VALUES ($1, $2, $3, $4, 'cta_click', true, $5)`,
            [
              rid('ev'),
              w.accountId,
              w.productId,
              uuid4(),
              json({ source: 'ivan@example.com' }),
            ],
          ),
        /utm/,
      );
      // Аудит P3-2: в закрытый продукт заявка не пишется и под ролью.
      await db.upd('pub_products', w.productId, { mode: 'closed' });
      await db.rejects(
        () =>
          asPublisher(
            `INSERT INTO "sites"."pub_leads" ("id", "accountId", "productId", "submissionKey", "requestHash", "publicRef", "testFlag", "testReason", "contactMethod", "consentState", "reviewDueAt")
           VALUES ($1, $2, $3, $4, $5, $6, true, 'test_mode', 'email', 'unknown', now())`,
            [
              rid('lead'),
              w.accountId,
              w.productId,
              uuid4(),
              hex64(),
              publicRef(),
            ],
          ),
        /не принимает заявки/,
      );
    });
  });

  describe('pub_public_products', () => {
    const DAY = 86_400_000;
    const H = 3_600_000;

    async function liveWorld(
      over: Record<string, unknown> = {},
    ): Promise<PubWorld> {
      return db.world({
        mode: 'live',
        liveSince: new Date(),
        paramsPublicPublishOk: true,
        paramsRealLeadsOk: true,
        ...over,
      });
    }

    async function view(productId: string) {
      const [r] = await db.q<{
        formOpen: boolean;
        allowedOrigins: string[];
        indexableHosts: string[];
        formLimitCount: number;
        formLimitWindowSec: number;
        analyticsStorage: string;
        consentState: string;
        altContact: unknown;
        dataNotice: unknown;
        faq: unknown[];
        offer: unknown;
        contactSla: unknown;
      }>(`SELECT * FROM "sites"."pub_public_products" WHERE "id" = $1`, [
        productId,
      ]);
      return r;
    }

    it('хосты live ≡ evaluateHostAccess(host, "publisher-public") на векторах host-access.spec — при любой TimeZone сессии', async () => {
      const w = await liveWorld();
      const now = Date.now();
      const vectors: Array<Partial<HostAccessRow> & { port?: number }> = [
        { status: 'verified', expiresAt: new Date(now + 30 * DAY) },
        { status: 'verified', expiresAt: new Date(now + 30 * 60_000) },
        { status: 'verified', expiresAt: new Date(now - 1000) },
        { status: 'verified', expiresAt: null },
        {
          status: 'verified',
          expiresAt: new Date(now + DAY),
          reverifyBlockedAt: new Date(now - H),
        },
        {
          status: 'revoked',
          expiresAt: new Date(now + DAY),
          revokedAt: new Date(now - 2 * H),
        },
        { status: 'expired', expiresAt: new Date(now - 10 * H) },
        { status: 'pending', expiresAt: null },
        { status: 'VERIFIED', expiresAt: new Date(now + DAY) },
        { status: 'verified', expiresAt: new Date(now + DAY), port: 8443 },
      ];
      const rows: HostAccessRow[] = [];
      for (const v of vectors) {
        const id = await db.host(w.accountId, w.siteId, {
          status: v.status,
          expiresAt: v.expiresAt,
          revokedAt: v.revokedAt ?? null,
          reverifyBlockedAt: v.reverifyBlockedAt ?? null,
          ...(v.port ? { port: v.port } : {}),
        });
        const [h] = await db.q<HostAccessRow & { port: number }>(
          `SELECT "id", "accountId", "host", "status", "port",
                  "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt", "revokedAt" AT TIME ZONE 'UTC' AS "revokedAt",
                  "reverifyBlockedAt" AT TIME ZONE 'UTC' AS "reverifyBlockedAt"
             FROM "sites"."site_hosts" WHERE "id" = $1`,
          [id],
        );
        rows.push(h);
      }
      const expected = rows
        .filter((h) => evaluateHostAccess(h, 'publisher-public', new Date()).ok)
        .map(
          (h) =>
            `https://${h.host}${(h as unknown as { port: number }).port === 443 ? '' : `:${(h as unknown as { port: number }).port}`}`,
        )
        .sort();
      expect(expected).toHaveLength(3);
      for (const tz of [
        'UTC',
        'Pacific/Kiritimati',
        'Pacific/Pago_Pago',
        'Europe/Kyiv',
      ]) {
        await db.q(`SET LOCAL TimeZone = '${tz}'`);
        const v = await view(w.productId);
        expect([...v.allowedOrigins].sort()).toEqual(expected);
        expect([...v.indexableHosts].sort()).toEqual(
          expected.map((o) => o.replace('https://', '')),
        );
      }
    });

    it('хосты чужого кабинета с тем же именем и чужого сайта не попадают; http-хост — тоже', async () => {
      const w = await liveWorld();
      await db.host(w.accountId, w.siteId, { host: 'shop.example' });
      const other = await db.world();
      await db.host(other.accountId, other.siteId, { host: 'evil.example' });
      const site2 = await db.site(w.accountId);
      await db.host(w.accountId, site2, { host: 'second.example' });
      await db.host(w.accountId, w.siteId, {
        host: 'plain.example',
        scheme: 'http',
        port: 80,
      });
      expect((await view(w.productId)).allowedOrigins).toEqual([
        'https://shop.example',
      ]);
    });

    it('форма: live — только при обоих флагах гейтов; test — открыта на test_hosts; closed — закрыта; eval и restored в представлении нет', async () => {
      const live = await liveWorld();
      expect((await view(live.productId)).formOpen).toBe(true);
      const half = await liveWorld({ paramsRealLeadsOk: false });
      expect((await view(half.productId)).formOpen).toBe(false);
      expect((await view(half.productId)).indexableHosts).toEqual([]);
      const closed = await db.world();
      expect(await view(closed.productId)).toMatchObject({
        formOpen: false,
        allowedOrigins: [],
      });
      const test = await db.world({ mode: 'test' });
      await db.decidedParam(test, 'test_hosts', [
        'https://test.ai-publisher.example',
        'javascript:alert(1)',
      ]);
      expect(await view(test.productId)).toMatchObject({
        formOpen: true,
        allowedOrigins: ['https://test.ai-publisher.example'],
        indexableHosts: [],
      });
      const ev = await db.world({ kind: 'eval' });
      expect(await view(ev.productId)).toBeUndefined();
      // Аудит P3-1: архивного продукта в представлении нет.
      const archived = await liveWorld({ status: 'archived' });
      expect(await view(archived.productId)).toBeUndefined();
    });

    it('закрытый и ни разу не live: строка есть (altContact для 503), оффер, FAQ и уведомление — нет (аудит P3-1)', async () => {
      const closed = await db.world();
      await db.offer(closed);
      await db.decidedParam(
        closed,
        'alt_contact',
        { kind: 'email', value: 'hi@example.com' },
        'approved',
      );
      await db.decidedParam(
        closed,
        'data_notice_version',
        { version: '1', text: 'Повідомлення' },
        'approved',
      );
      await db.child('pub_brand_facts', closed, {
        factKey: 'faq.1',
        kind: 'faq',
        value: { question: 'Q', answer: 'A' },
        version: 1,
        status: 'active',
        approvedBy: M,
        approvedAt: new Date(),
      });
      expect(await view(closed.productId)).toMatchObject({
        formOpen: false,
        altContact: { kind: 'email', value: 'hi@example.com' },
        offer: null,
        faq: [],
        dataNotice: null,
      });
      // Был live и закрыт — публичная часть остаётся.
      const was = await liveWorld();
      await db.offer(was);
      await db.upd('pub_products', was.productId, { mode: 'closed' });
      expect((await view(was.productId)).offer).not.toBeNull();
    });

    it('параметры: утверждённые — всегда, допущения — только в режиме test; без значения — безопасные умолчания', async () => {
      const live = await liveWorld();
      await db.child('pub_parameters', live, {
        key: 'form_limit',
        value: { count: 3, windowSec: 300 },
      });
      await db.child('pub_parameters', live, {
        key: 'alt_contact',
        value: { kind: 'email', value: 'hi@example.com' },
      });
      expect(await view(live.productId)).toMatchObject({
        formLimitCount: 5,
        formLimitWindowSec: 600,
        altContact: null,
        analyticsStorage: 'none',
        consentState: 'unknown',
        contactSla: null,
      });
      // Р-PUB-Z2-9: правило contact_sla — только `{rule}` (календарь сайту
      // не отдаётся), по тем же условиям, что прочие параметры.
      await db.child('pub_parameters', live, {
        key: 'contact_sla',
        value: {
          rule: 'next_business_day_end',
          calendar: {
            workdays: [1, 2, 3, 4, 5],
            holidays: [],
            dayEnd: '18:00',
          },
        },
      });
      expect((await view(live.productId)).contactSla).toBeNull();
      const sla = await liveWorld();
      await db.decidedParam(
        sla,
        'contact_sla',
        {
          rule: 'next_business_day_end',
          calendar: {
            workdays: [1, 2, 3, 4, 5],
            holidays: [],
            dayEnd: '18:00',
          },
        },
        'approved',
      );
      expect((await view(sla.productId)).contactSla).toEqual({
        rule: 'next_business_day_end',
      });
      // Аудит P2-1: посев (допущение без решения) не читается и в test.
      const seeded = await db.world({ mode: 'test' });
      await db.child('pub_parameters', seeded, {
        key: 'form_limit',
        value: { count: 3, windowSec: 300 },
      });
      expect(await view(seeded.productId)).toMatchObject({
        formLimitCount: 5,
        formLimitWindowSec: 600,
      });
      const test = await db.world({ mode: 'test' });
      await db.decidedParam(test, 'form_limit', { count: 3, windowSec: 300 });
      await db.decidedParam(test, 'analytics_storage', json('session'));
      await db.decidedParam(test, 'consent_map', { default: 'not_required' });
      await db.decidedParam(test, 'data_notice_version', {
        version: '1',
        text: 'Повідомлення',
      });
      expect(await view(test.productId)).toMatchObject({
        formLimitCount: 3,
        formLimitWindowSec: 300,
        analyticsStorage: 'session',
        consentState: 'not_required',
        dataNotice: { version: '1', text: 'Повідомлення', approved: false },
      });
    });

    it('FAQ — активные факты faq (≤ 5), оффер — активная версия', async () => {
      const w = await liveWorld();
      for (let i = 1; i <= 6; i++) {
        await db.child('pub_brand_facts', w, {
          factKey: `faq.${i}`,
          kind: 'faq',
          value: { question: `Q${i}`, answer: `A${i}` },
          version: 1,
          status: 'active',
          approvedBy: M,
          approvedAt: new Date(),
        });
      }
      await db.child('pub_brand_facts', w, {
        factKey: 'faq.draft',
        kind: 'faq',
        value: { question: 'Qd', answer: 'Ad' },
        version: 1,
      });
      await db.offer(w, {
        title: 'Пакет',
        text: 'Опис',
        priceNote: 'від 10 000',
      });
      const v = await view(w.productId);
      expect(v.faq).toHaveLength(5);
      expect(v.offer).toEqual({
        title: 'Пакет',
        text: 'Опис',
        priceNote: 'від 10 000',
      });
    });
  });

  describe('pub_public_contents (аудит P1-1)', () => {
    it('v1 опубликована — сайт отдаёт v1; v2 согласована, но не опубликована — всё ещё v1; v2 опубликована — v2; снятый — withdrawn', async () => {
      const w = await db.world({ mode: 'live', liveSince: new Date() });
      const a = await db.article(w, { slug: 'how-to-choose' });
      const ch = await db.channel(w);
      const pubSrc = await db.source(w, {
        title: 'Відкрите джерело',
        url: 'https://open.example/x',
      });
      const privSrc = await db.source(w, {
        visibility: 'private',
        title: 'Інтерв’ю',
        url: 'https://secret.example/y',
      });
      const v1 = await db.version(w, a, {
        title: 'Версія 1',
        meta: { description: 'Опис', internalNote: 'службове' },
      });
      await db.child('pub_version_sources', w, {
        versionId: v1,
        sourceId: pubSrc,
      });
      await db.child('pub_version_sources', w, {
        versionId: v1,
        sourceId: privSrc,
      });
      await db.upd('pub_content_versions', v1, {
        status: 'approved',
        hash: hex64(),
        frozenAt: new Date(),
      });
      const ap1 = await db.publishApproval(w, v1);
      const url = 'https://ai-publisher.example/how-to-choose';
      const p1 = await db.child('pub_publications', w, {
        versionId: v1,
        channelId: ch,
        approvalId: ap1,
        stage: 'live',
        finalUrl: url,
        opKey: uuid4(),
        status: 'published',
        publishedAt: new Date('2026-10-20T07:00:00Z'),
      });
      await db.upd('pub_contents', a, {
        status: 'published',
        firstPublishedAt: new Date('2026-10-20T07:00:00Z'),
      });
      const read = () =>
        db.q<{
          slug: string;
          title: string | null;
          versionHash: string | null;
          withdrawn: boolean;
          sources: unknown;
          meta: Record<string, unknown> | null;
          stage: string;
        }>(
          `SELECT "slug", "title", "versionHash", "withdrawn", "sources", "meta", "stage" FROM "sites"."pub_public_contents" WHERE "productId" = $1`,
          [w.productId],
        );
      let rows = await read();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        slug: 'how-to-choose',
        title: 'Версія 1',
        withdrawn: false,
        stage: 'live',
      });
      // Закрытый источник читателю не раскрывается — только пометка.
      expect(rows[0].sources).toHaveLength(2);
      expect(rows[0].sources).toEqual(
        expect.arrayContaining([
          { title: 'Відкрите джерело', url: 'https://open.example/x' },
          { private: true },
        ]),
      );
      expect(rows[0].meta).toEqual({ description: 'Опис' });
      // v2 согласована (своё согласование), но не опубликована — показ v1.
      const v2 = await db.frozenVersion(w, a, {
        number: 2,
        title: 'Версія 2',
        status: 'approved',
      });
      const ap2 = await db.publishApproval(w, v2);
      rows = await read();
      expect(rows[0].title).toBe('Версія 1');
      // Публикация v2 по тому же URL: v1 → replaced, её согласование → superseded.
      await db.upd('pub_publications', p1, { status: 'replaced' });
      await db.upd('pub_approvals', ap1, { status: 'superseded' });
      await db.child('pub_publications', w, {
        versionId: v2,
        channelId: ch,
        approvalId: ap2,
        stage: 'live',
        finalUrl: url,
        opKey: uuid4(),
        status: 'published',
        publishedAt: new Date('2026-11-01T07:00:00Z'),
      });
      rows = await read();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        title: 'Версія 2',
        versionHash: await db.versionHash(v2),
      });
      // Отзыв согласования снимает страницу (404), снятие материала — 410.
      await db.upd('pub_approvals', ap2, { status: 'revoked' });
      expect(await read()).toEqual([]);
      await db.upd('pub_contents', a, { status: 'withdrawn' });
      rows = await read();
      expect(rows).toEqual([
        expect.objectContaining({
          slug: 'how-to-choose',
          withdrawn: true,
          title: null,
          versionHash: null,
        }),
      ]);
    });

    it('режим test показывает только тестовые публикации; live — только live; restored/eval — ничего', async () => {
      const w = await db.world({ mode: 'test' });
      const a = await db.article(w);
      const ch = await db.channel(w);
      const v = await db.frozenVersion(w, a);
      await db.child('pub_publications', w, {
        versionId: v,
        channelId: ch,
        approvalId: await db.publishApproval(w, v),
        stage: 'test',
        finalUrl: 'https://test.example/a',
        opKey: uuid4(),
      });
      const rows = await db.q<{ stage: string }>(
        `SELECT "stage" FROM "sites"."pub_public_contents" WHERE "productId" = $1`,
        [w.productId],
      );
      expect(rows).toEqual([{ stage: 'test' }]);
      await db.upd('pub_products', w.productId, { mode: 'closed' });
      expect(
        await db.q(
          `SELECT 1 FROM "sites"."pub_public_contents" WHERE "productId" = $1`,
          [w.productId],
        ),
      ).toEqual([]);
    });

    it('аудит P1-1, P3-1, P3-9: отозванный источник не раскрывается; согласование не этой версии и архивный продукт — ничего', async () => {
      const w = await db.world({ mode: 'live', liveSince: new Date() });
      const a = await db.article(w);
      const ch = await db.channel(w);
      const src = await db.source(w, {
        title: 'Джерело',
        url: 'https://src.example/z',
      });
      const v = await db.version(w, a);
      await db.child('pub_version_sources', w, { versionId: v, sourceId: src });
      await db.upd('pub_content_versions', v, {
        status: 'approved',
        hash: hex64(),
        frozenAt: new Date(),
      });
      const ap = await db.publishApproval(w, v);
      const pub = await db.child('pub_publications', w, {
        versionId: v,
        channelId: ch,
        approvalId: ap,
        stage: 'live',
        finalUrl: 'https://ai-publisher.example/p',
        opKey: uuid4(),
        status: 'published',
        publishedAt: new Date(),
      });
      await db.upd('pub_contents', a, {
        status: 'published',
        firstPublishedAt: new Date(),
      });
      const read = () =>
        db.q<{ sources: unknown[] }>(
          `SELECT "sources" FROM "sites"."pub_public_contents" WHERE "productId" = $1`,
          [w.productId],
        );
      expect((await read())[0].sources).toEqual([
        { title: 'Джерело', url: 'https://src.example/z' },
      ]);
      await db.upd('pub_sources', src, {
        usage: 'revoked',
        revokedAt: new Date(),
        revokedBy: M,
        revokeReason: 'Права отозваны',
      });
      expect((await read())[0].sources).toEqual([]);
      // Представление само сверяет objectId согласования с версией
      // (вторая линия после гварда): подменяем согласование в обход гварда
      // (DDL в откатываемой транзакции).
      // Тот же hash, другая версия: отсекает только сверка objectId.
      const v2 = await db.frozenVersion(w, a, {
        number: 2,
        hash: await db.versionHash(v),
      });
      const ap2 = await db.publishApproval(w, v2);
      await db.q(
        `ALTER TABLE "sites"."pub_publications" DISABLE TRIGGER "pub_publication_guard"`,
      );
      await db.q(
        `UPDATE "sites"."pub_publications" SET "approvalId" = $1 WHERE "id" = $2`,
        [ap2, pub],
      );
      await db.q(
        `ALTER TABLE "sites"."pub_publications" ENABLE TRIGGER "pub_publication_guard"`,
      );
      expect(await read()).toEqual([]);
      await db.q(
        `ALTER TABLE "sites"."pub_publications" DISABLE TRIGGER "pub_publication_guard"`,
      );
      await db.q(
        `UPDATE "sites"."pub_publications" SET "approvalId" = $1 WHERE "id" = $2`,
        [ap, pub],
      );
      await db.q(
        `ALTER TABLE "sites"."pub_publications" ENABLE TRIGGER "pub_publication_guard"`,
      );
      expect(await read()).toHaveLength(1);
      await db.upd('pub_products', w.productId, { status: 'archived' });
      expect(await read()).toEqual([]);
    });

    it('роль читает представление контента; таблицы контента — нет', async () => {
      await asPublisher(
        `SELECT "slug" FROM "sites"."pub_public_contents" LIMIT 1`,
      );
      await db.fails('42501', () =>
        asPublisher(`SELECT 1 FROM "sites"."pub_content_versions" LIMIT 1`),
      );
    });
  });
}
