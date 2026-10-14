/**
 * AI Publisher, P-A0: db-тесты миграции `…_publisher_core` — каждый
 * гвард (допустимое проходит, недопустимое → 23514), append-only,
 * неизменяемые колонки, формат актёра, ссылки внутри продукта, частичные
 * уникальные индексы «одна активная», составные FK против чужого кабинета
 * (проектный документ §6.9, §16.1). Под владельцем схемы; каждый тест —
 * своя транзакция с откатом.
 *
 * Файл лежит в src/prisma (зона P-A0), а не в publisher/core (зона P-A1).
 */
import { Client } from 'pg';
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

if (!PUB_RAW_URL) {
  describeWithoutDb('AI Publisher: триггеры pub_* на реальном Postgres');
} else {
  let client: Client;
  let db: PubDb;
  let w: PubWorld;

  beforeAll(async () => {
    client = await connectOwner();
    db = new PubDb(client);
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await db.begin();
    w = await db.world();
  });
  afterEach(async () => {
    await db.rollback();
  });

  describe('каталог: правила схемы', () => {
    it('72 таблицы pub_* (66 P0 + 6 P-R), у каждой — триггеры актёра и неизменяемых колонок (кроме pub_rate_hits)', async () => {
      const tables = await db.q<{ t: string }>(
        `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'sites' AND tablename LIKE 'pub\\_%' ORDER BY 1`,
      );
      expect(tables).toHaveLength(72);
      const trg = await db.q<{ t: string; n: string }>(
        `SELECT c.relname AS t, t.tgname AS n FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace s ON s.oid = c.relnamespace
          WHERE s.nspname = 'sites' AND c.relname LIKE 'pub\\_%' AND NOT t.tgisinternal`,
      );
      const missing: string[] = [];
      for (const { t } of tables) {
        if (t === 'pub_rate_hits') continue;
        for (const suffix of ['_actor', '_identity']) {
          if (!trg.some((r) => r.t === t && r.n === `${t}${suffix}`)) {
            missing.push(`${t}${suffix}`);
          }
        }
      }
      expect(missing).toEqual([]);
    });

    it('в pub_* нет CHECK и constraint-триггеров (wasm migrate diff на них падает)', async () => {
      const r = await db.q(
        `SELECT c.conname FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
          JOIN pg_namespace s ON s.oid = r.relnamespace
          WHERE s.nspname = 'sites' AND r.relname LIKE 'pub\\_%' AND c.contype IN ('c', 't')`,
      );
      expect(r).toEqual([]);
    });

    it('триггерные и читающие таблицы функции — SECURITY DEFINER с search_path; чистые помощники — без DEFINER и без таблиц; EXECUTE у PUBLIC снят у всех', async () => {
      const r = await db.q<{
        f: string;
        d: boolean;
        cfg: string[] | null;
        pub: boolean;
        trg: boolean;
        src: string;
      }>(
        `SELECT p.proname AS f, p.prosecdef AS d, p.proconfig AS cfg,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                p.prorettype = 'trigger'::regtype AS trg, p.prosrc AS src
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'sites' AND p.proname LIKE 'pub\\_%'`,
      );
      expect(r.length).toBeGreaterThanOrEqual(80);
      // Таблица в теле — `"sites"."pub_…"`/`"sites"."site_…"` не как вызов функции.
      const readsTables = (src: string) =>
        /"sites"\."(pub|site)_[a-z_]+"(?!\s*\()/.test(src) ||
        /EXECUTE\s+format/.test(src);
      const bad = r.filter(
        (x) =>
          x.pub ||
          (x.trg || readsTables(x.src)
            ? !x.d || !(x.cfg ?? []).includes('search_path=pg_catalog, pg_temp')
            : x.d || (x.cfg ?? []).length > 0),
      );
      expect(bad.map((x) => x.f)).toEqual([]);
      expect(r.filter((x) => !x.d).length).toBeGreaterThanOrEqual(15);
    });

    it('TRUNCATE журналов, головы параметров и экспериментов — 23514 (аудит P3-4)', async () => {
      for (const t of [
        'pub_audit_events',
        'pub_parameter_decisions',
        'pub_expense_entries',
        'pub_parameters',
        'pub_experiments',
        'pub_approvals',
      ]) {
        await db.rejects(
          async () => db.q(`TRUNCATE "sites"."${t}" CASCADE`),
          /TRUNCATE запрещён/,
        );
      }
      const n = await db.q<{ n: string }>(
        `SELECT count(*) AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relname LIKE 'pub\\_%' AND t.tgname LIKE '%\\_no\\_truncate'`,
      );
      // 20 P0 + снимки правил Reddit (P-R, …_publisher_reddit).
      expect(Number(n[0].n)).toBe(21);
    });
  });

  describe('общие триггеры', () => {
    it('актёр: member:/system:/public/restore: — да; AI и мусор — 23514', async () => {
      for (const a of [
        'member:abc',
        'system:members-reconcile',
        'public',
        'restore:r1',
      ]) {
        await db.child('pub_campaigns', w, {
          code: rid('c').replace(/_/g, '-'),
          name: 'К',
          createdBy: a,
        });
      }
      for (const a of ['ai', 'gemini', 'member:', 'system:Job!', 'admin']) {
        await db.rejects(
          () =>
            db.child('pub_campaigns', w, {
              code: rid('c').replace(/_/g, '-'),
              name: 'К',
              createdBy: a,
            }),
          /createdBy: актёр/,
        );
      }
      // Все колонки *By проверяются, не только createdBy.
      const q = await db.question(w);
      await db.rejects(
        () =>
          db.upd('pub_questions', q, { status: 'rejected', createdBy: 'ai' }),
        /актёр/,
      );
      await db.rejects(
        () =>
          db.child('pub_parameter_proposals', w, {
            parameterKey: 'niche',
            value: json('x'),
            proposedBy: 'ai:helper',
          }),
        /proposedBy: актёр/,
      );
    });

    it('продукт не переносится: accountId, siteId, publicKey, kind неизменны; строка — между продуктами', async () => {
      const other = await db.world();
      const site2 = await db.site(w.accountId);
      for (const set of [
        { accountId: other.accountId },
        { siteId: site2 },
        { publicKey: 'pp_' + 'B'.repeat(24) },
        { kind: 'test' },
      ]) {
        await db.fails(
          '23514',
          async () => db.upd('pub_products', w.productId, set),
          /неизменяема/,
        );
      }
      await db.upd('pub_products', w.productId, { name: 'Новое имя' });
      const sib = await db.sibling(w, { kind: 'test' });
      const c = await db.campaign(w);
      await db.rejects(
        async () => db.upd('pub_campaigns', c, { productId: sib.productId }),
        /productId: колонка неизменяема/,
      );
    });

    it('ссылка на строку другого продукта того же кабинета — 23514; чужого кабинета — тоже отказ', async () => {
      const sib = await db.sibling(w, { kind: 'test' });
      const q = await db.question(w);
      const foreignSource = await db.source(sib);
      await db.rejects(
        () =>
          db.child('pub_question_sources', w, {
            questionId: q,
            sourceId: foreignSource,
          }),
        /ссылка на строку другого продукта/,
      );
      const own = await db.source(w);
      await db.child('pub_question_sources', w, {
        questionId: q,
        sourceId: own,
      });
      // Чужой кабинет: продукт другой — тот же отказ триггера (он срабатывает
      // раньше FK); составной FK держит ссылки, которые триггер не проверяет.
      const stranger = await db.world();
      const strangerSource = await db.source(stranger);
      await db.rejects(async () =>
        db.child('pub_question_sources', w, {
          questionId: q,
          sourceId: strangerSource,
        }),
      );
    });

    it('составной FK (xId, accountId): строку чужого кабинета не привязать — 23503', async () => {
      const stranger = await db.world({ kind: 'eval' });
      const cfg = await db.child('pub_ai_configs', stranger, {
        provider: 'GEMINI',
        model: 'm',
        contextRulesVersion: 'ctx@1',
        schemaSetVersion: 's@1',
        instructionVersions: {},
        configHash: hex64(),
        coveredGenerators: [],
      });
      // Привязка AI-конфигурации идёт к ДРУГОМУ продукту (eval) — триггер
      // «один продукт» её не проверяет, держит только FK по кабинету.
      await db.fails('23503', async () =>
        db.child('pub_ai_config_bindings', w, {
          configId: cfg,
          boundBy: M,
          basis: 'Чужая конфигурация',
        }),
      );
      const b = await db.child('pub_backups', stranger, {
        kind: 'manual',
        blobPathEnc: 'v1.a.b.c',
        sha256: hex64(),
        sizeBytes: 1,
        tableCounts: {},
        keyVersion: 'v1',
        rotationUntil: new Date(Date.now() + 86_400_000),
        status: 'ok',
      });
      const site2 = await db.site(w.accountId);
      await db.fails('23503', async () =>
        db.product(w.accountId, site2, {
          kind: 'restored',
          restoredFromBackupId: b,
        }),
      );
    });

    it('сайт с продуктом не удалить (RESTRICT), второй продукт на сайт — 23505', async () => {
      await db.fails('23503', async () => db.del('site_sites', w.siteId));
      await db.fails('23505', async () => db.product(w.accountId, w.siteId));
    });
  });

  describe('ядро (6.2)', () => {
    it('pub_products: списки, формат ключа, live только у working с liveSince, машина режима', async () => {
      await db.rejects(
        async () => db.product(w.accountId, w.siteId, { kind: 'demo' }),
        /kind/,
      );
      const s2 = await db.site(w.accountId);
      await db.rejects(
        async () => db.product(w.accountId, s2, { publicKey: 'pk_x' }),
        /publicKey/,
      );
      await db.rejects(
        async () =>
          db.product(w.accountId, s2, {
            kind: 'test',
            mode: 'live',
            liveSince: new Date(),
          }),
        /live только у kind=working/,
      );
      await db.rejects(
        async () => db.product(w.accountId, s2, { kind: 'restored' }),
        /restoredFromBackupId/,
      );
      await db.rejects(
        async () => db.upd('pub_products', w.productId, { mode: 'live' }),
        /liveSince/,
      );
      await db.upd('pub_products', w.productId, {
        mode: 'live',
        liveSince: new Date(),
      });
      await db.rejects(
        async () => db.upd('pub_products', w.productId, { mode: 'test' }),
        /машины режима/,
      );
      await db.upd('pub_products', w.productId, { mode: 'closed' });
      await db.upd('pub_products', w.productId, { mode: 'test' });
    });

    it('pub_parameters: ключ из списка; approved — с автором; изменение только с решением той же версии', async () => {
      await db.rejects(
        async () =>
          db.child('pub_parameters', w, {
            key: 'favourite_color',
            value: json(1),
          }),
        /PARAMETER_KEYS/,
      );
      const p = await db.child('pub_parameters', w, {
        key: 'niche',
        value: json('B2B'),
        status: 'assumption',
      });
      await db.rejects(
        async () => db.upd('pub_parameters', p, { value: json('B2C') }),
        /без решения|растёт/,
      );
      await db.rejects(
        () => db.upd('pub_parameters', p, { status: 'approved', version: 2 }),
        /approvedAt\/approvedBy/,
      );
      // Решение — первым, потом параметр той же версии, статуса и значения.
      await db.child('pub_parameter_decisions', w, {
        parameterKey: 'niche',
        version: 2,
        fromStatus: 'assumption',
        toStatus: 'approved',
        valueSnapshot: json('B2C'),
        decidedBy: M,
        basis: 'Решение владельца по нише',
        dependentStages: ['public_publish'],
      });
      await db.rejects(
        () =>
          db.upd('pub_parameters', p, {
            status: 'approved',
            version: 2,
            value: json('B2B'),
            approvedBy: M,
            approvedAt: new Date(),
          }),
        /без решения/,
      );
      await db.upd('pub_parameters', p, {
        status: 'approved',
        version: 2,
        value: json('B2C'),
        approvedBy: M,
        approvedAt: new Date(),
      });
      await db.rejects(
        async () => db.upd('pub_parameters', p, { version: 1 }),
        /не уменьшается/,
      );
      // Вставка сразу approved без решений по ключу — только посев.
      await db.rejects(
        () =>
          db.child('pub_parameters', w, {
            key: 'market',
            value: json('UA'),
            status: 'approved',
            approvedBy: M,
            approvedAt: new Date(),
          }),
        /только посев/,
      );
      // Решение с чужим fromStatus — не основание для изменения.
      await db.child('pub_parameter_decisions', w, {
        parameterKey: 'niche',
        version: 3,
        fromStatus: 'assumption',
        toStatus: 'revoked',
        valueSnapshot: json('B2C'),
        decidedBy: M,
        basis: 'Отзыв ниши владельцем',
        dependentStages: [],
      });
      await db.rejects(
        async () =>
          db.upd('pub_parameters', p, {
            status: 'revoked',
            version: 3,
            approvedBy: null,
            approvedAt: null,
          }),
        /без решения/,
      );
    });

    it('pub_parameters (аудит P2-1): голову не удалить; повторная вставка — только по последнему решению; посев — версия 1 без решений', async () => {
      const p = await db.child('pub_parameters', w, {
        key: 'form_limit',
        value: { count: 50, windowSec: 60 },
      });
      await db.rejects(
        async () => db.del('pub_parameters', p),
        /удаление запрещено/,
      );
      // Удаление в обход (без триггера) невозможно: проверяем повторную вставку
      // на соседнем продукте, где решения по ключу уже есть.
      const w2 = await db.sibling(w, { kind: 'test' });
      for (const [v, val] of [
        [2, { count: 50, windowSec: 60 }],
        [3, { count: 5, windowSec: 600 }],
      ] as const) {
        await db.child('pub_parameter_decisions', w2, {
          parameterKey: 'form_limit',
          version: v,
          fromStatus: v === 2 ? 'assumption' : 'approved',
          toStatus: 'approved',
          valueSnapshot: val,
          decidedBy: M,
          basis: 'Решение по лимиту формы',
          dependentStages: ['real_leads'],
        });
      }
      // Старое решение v2 (ослабленный лимит) — не основание: только последнее.
      await db.rejects(
        async () =>
          db.child('pub_parameters', w2, {
            key: 'form_limit',
            value: { count: 50, windowSec: 60 },
            status: 'approved',
            version: 2,
            approvedBy: M,
            approvedAt: new Date(),
          }),
        /последним решением/,
      );
      await db.rejects(
        async () =>
          db.child('pub_parameters', w2, {
            key: 'form_limit',
            value: { count: 50, windowSec: 60 },
            status: 'assumption',
            version: 1,
          }),
        /последним решением/,
      );
      await db.child('pub_parameters', w2, {
        key: 'form_limit',
        value: { count: 5, windowSec: 600 },
        status: 'approved',
        version: 3,
        approvedBy: M,
        approvedAt: new Date(),
      });
      await db.rejects(
        async () =>
          db.child('pub_parameters', w, {
            key: 'niche',
            value: json('x'),
            version: 2,
          }),
        /только посев/,
      );
    });

    it('pub_parameter_decisions: основание ≥ 10, решает человек, этапы из списка; append-only', async () => {
      const base = {
        parameterKey: 'market',
        version: 1,
        fromStatus: 'assumption',
        toStatus: 'approved',
        valueSnapshot: json('UA'),
        decidedBy: M,
        dependentStages: [],
      };
      await db.rejects(
        async () =>
          db.child('pub_parameter_decisions', w, { ...base, basis: 'коротко' }),
        /basis/,
      );
      await db.rejects(
        async () =>
          db.child('pub_parameter_decisions', w, {
            ...base,
            basis: 'Достаточное основание',
            decidedBy: 'system:cron',
          }),
        /человек/,
      );
      await db.rejects(
        async () =>
          db.child('pub_parameter_decisions', w, {
            ...base,
            basis: 'Достаточное основание',
            dependentStages: ['everything'],
          }),
        /dependentStages/,
      );
      const d = await db.child('pub_parameter_decisions', w, {
        ...base,
        basis: 'Достаточное основание',
      });
      await db.rejects(
        async () =>
          db.upd('pub_parameter_decisions', d, {
            basis: 'Переписанное основание',
          }),
        /append-only/,
      );
      await db.rejects(
        async () => db.del('pub_parameter_decisions', d),
        /append-only/,
      );
    });

    it('pub_parameter_proposals: accepted — только с решением; значение предложения неизменно', async () => {
      const pr = await db.child('pub_parameter_proposals', w, {
        parameterKey: 'form_limit',
        value: { count: 3 },
        proposedBy: M,
      });
      await db.rejects(
        async () =>
          db.upd('pub_parameter_proposals', pr, { status: 'accepted' }),
        /decisionId/,
      );
      await db.rejects(
        async () =>
          db.upd('pub_parameter_proposals', pr, { value: { count: 10 } }),
        /неизменны/,
      );
      await db.upd('pub_parameter_proposals', pr, { status: 'withdrawn' });
      await db.rejects(
        async () => db.upd('pub_parameter_proposals', pr, { status: 'open' }),
        /только из open/,
      );
    });

    it('pub_role_grants: одна активная роль участнику (частичный индекс); отзыв однократен; удаление запрещено', async () => {
      const g = {
        memberId: 'm2',
        memberDisplayName: 'Оля',
        role: 'editor',
        grantedBy: M,
      };
      const id = await db.child('pub_role_grants', w, g);
      await db.fails('23505', async () => db.child('pub_role_grants', w, g));
      await db.child('pub_role_grants', w, { ...g, role: 'sales' });
      await db.rejects(
        async () => db.child('pub_role_grants', w, { ...g, role: 'god' }),
        /role/,
      );
      await db.rejects(
        async () => db.upd('pub_role_grants', id, { role: 'viewer' }),
        /append-only/,
      );
      await db.upd('pub_role_grants', id, {
        revokedBy: M,
        revokedAt: new Date(),
        reason: 'смена обязанностей',
      });
      await db.rejects(
        async () =>
          db.upd('pub_role_grants', id, { revokedBy: null, revokedAt: null }),
        /отозванный/,
      );
      await db.child('pub_role_grants', w, g); // после отзыва — снова можно
      await db.rejects(
        async () => db.del('pub_role_grants', id),
        /append-only/,
      );
    });

    it('pub_audit_events: ключи ПД в meta на любом уровне — 23514; append-only', async () => {
      const ev = {
        actor: M,
        objectType: 'lead',
        objectId: 'l1',
        action: 'transition',
      };
      await db.rejects(
        async () =>
          db.child('pub_audit_events', w, {
            ...ev,
            meta: { diff: [{ Email: 'x' }] },
          }),
        /персональных/,
      );
      await db.rejects(
        async () =>
          db.child('pub_audit_events', w, {
            ...ev,
            meta: { nested: { contactEnc: 'v1.a.b.c' } },
          }),
        /персональных/,
      );
      // Аудит P3-11: ключ нормализуется; email в значениях запрещён.
      for (const meta of [
        { 'e-mail': 'x' },
        { phoneNumber: 'x' },
        { contact_enc: 'x' },
        { applicant: { full_name: 'x' } },
        { note: 'пишите на ivan@example.com' },
      ]) {
        await db.rejects(
          async () => db.child('pub_audit_events', w, { ...ev, meta }),
          /персональных|email/,
        );
      }
      await db.child('pub_audit_events', w, {
        ...ev,
        meta: {
          memberDisplayName: 'Оля',
          contactMethod: 'email',
          contactDueAt: '2026-10-21',
        },
      });
      await db.rejects(
        async () =>
          db.child('pub_audit_events', w, {
            ...ev,
            action: 'delete_everything',
          }),
        /action/,
      );
      await db.rejects(
        async () =>
          db.child('pub_audit_events', w, { ...ev, objectType: 'assist_site' }),
        /objectType/,
      );
      const id = await db.child('pub_audit_events', w, {
        ...ev,
        meta: { from: 'new', to: 'contacted' },
      });
      await db.rejects(
        async () => db.upd('pub_audit_events', id, { reason: 'правка' }),
        /append-only/,
      );
      await db.rejects(
        async () => db.del('pub_audit_events', id),
        /append-only/,
      );
    });

    it('pub_idempotency_keys: ключ кабинета без продукта; ПД в ответе — 23514; opKey — UUID v4', async () => {
      const row = {
        accountId: w.accountId,
        opKey: uuid4(),
        scope: 'product.create',
        requestHash: hex64(),
        createdBy: M,
        expiresAt: new Date(Date.now() + 86_400_000),
      };
      const id = await db.ins('pub_idempotency_keys', {
        id: rid('ik'),
        ...row,
      });
      await db.fails('23505', async () =>
        db.ins('pub_idempotency_keys', { id: rid('ik'), ...row }),
      );
      await db.rejects(
        async () =>
          db.upd('pub_idempotency_keys', id, {
            responseStatus: 201,
            responseBody: { lead: { name: 'Іван' } },
          }),
        /персональных/,
      );
      await db.upd('pub_idempotency_keys', id, {
        responseStatus: 201,
        responseBody: { id: 'p1' },
      });
      await db.rejects(
        async () =>
          db.ins('pub_idempotency_keys', {
            id: rid('ik'),
            ...row,
            opKey: 'not-a-uuid',
          }),
        /UUID v4/,
      );
    });

    it('pub_review_tasks: закрытие — с решением и автором; повтор события не плодит задач', async () => {
      const t = {
        objectType: 'content_version',
        objectId: 'v1',
        reason: 'offer_changed',
        triggerRef: 'offer:2',
        severity: 'critical',
      };
      const id = await db.child('pub_review_tasks', w, t);
      await db.fails('23505', async () => db.child('pub_review_tasks', w, t));
      await db.rejects(
        async () => db.upd('pub_review_tasks', id, { status: 'resolved' }),
        /resolution/,
      );
      await db.upd('pub_review_tasks', id, {
        status: 'resolved',
        resolution: 'Текст не затронут',
        resolvedBy: M,
        resolvedAt: new Date(),
      });
      await db.rejects(
        async () =>
          db.upd('pub_review_tasks', id, { status: 'open', resolvedAt: null }),
        /только из open/,
      );
    });

    it('pub_integrations и pub_campaigns: списки и форматы', async () => {
      await db.rejects(
        async () =>
          db.child('pub_integrations', w, {
            kind: 'facebook',
            status: 'connected',
            staleAfterHours: 24,
          }),
        /kind/,
      );
      await db.child('pub_integrations', w, {
        kind: 'web_analytics',
        status: 'connected',
        staleAfterHours: 24,
      });
      await db.rejects(
        async () => db.campaign(w, { code: 'Пілот 2026' }),
        /code/,
      );
    });
  });

  describe('контент (6.3)', () => {
    it('pub_sources: revoked необратим и требует причины; синтетика только в eval', async () => {
      const s = await db.source(w);
      await db.rejects(
        async () => db.upd('pub_sources', s, { usage: 'revoked' }),
        /revoked\*/,
      );
      await db.upd('pub_sources', s, {
        usage: 'revoked',
        revokedAt: new Date(),
        revokedBy: M,
        revokeReason: 'Права отозваны',
      });
      await db.rejects(
        async () =>
          db.upd('pub_sources', s, {
            usage: 'allowed',
            revokedAt: null,
            revokedBy: null,
            revokeReason: null,
          }),
        /необратим/,
      );
      await db.rejects(
        async () => db.source(w, { isSynthetic: true }),
        /kind=eval/,
      );
      const ev = await db.sibling(w, { kind: 'eval' });
      await db.source(ev, { isSynthetic: true });
      await db.rejects(
        async () => db.source(w, { url: 'http://insecure.example' }),
        /url/,
      );
    });

    it('pub_sources: содержимое заморожено после связи с замороженной версией; метаданные — можно', async () => {
      const s = await db.source(w);
      const c = await db.article(w);
      const v = await db.version(w, c);
      await db.child('pub_version_sources', w, { versionId: v, sourceId: s });
      await db.upd('pub_sources', s, { fragment: 'Правка до заморозки' });
      await db.upd('pub_content_versions', v, {
        status: 'submitted',
        hash: hex64(),
        frozenAt: new Date(),
      });
      await db.rejects(
        async () => db.upd('pub_sources', s, { fragment: 'Правка после' }),
        /supersedesId/,
      );
      await db.upd('pub_sources', s, {
        freshness: 'stale',
        checkedAt: new Date(),
      });
    });

    it('pub_questions: selected — ≥ 1 разрешённый источник и пояснения всех четырёх оценок; частотность — с источником', async () => {
      const scores = Object.fromEntries(
        ['offer_fit', 'confirmed_task', 'own_answer', 'cost'].map((k) => [
          k,
          { score: 2, why: 'Есть данные' },
        ]),
      );
      const q = await db.question(w, { scores });
      await db.rejects(
        async () =>
          db.upd('pub_questions', q, { status: 'selected', selectedRank: 1 }),
        /источника/,
      );
      const restricted = await db.source(w, { usage: 'restricted' });
      await db.child('pub_question_sources', w, {
        questionId: q,
        sourceId: restricted,
      });
      await db.rejects(
        async () =>
          db.upd('pub_questions', q, { status: 'selected', selectedRank: 1 }),
        /источника/,
      );
      await db.child('pub_question_sources', w, {
        questionId: q,
        sourceId: await db.source(w),
      });
      await db.upd('pub_questions', q, { status: 'selected', selectedRank: 1 });
      const q2 = await db.question(w, {
        scores: { ...scores, cost: { score: null, why: '' } },
      });
      await db.child('pub_question_sources', w, {
        questionId: q2,
        sourceId: await db.source(w),
      });
      await db.rejects(
        async () =>
          db.upd('pub_questions', q2, { status: 'selected', selectedRank: 2 }),
        /why/,
      );
      await db.rejects(
        async () =>
          db.question(w, { scores: { offer_fit: { score: 3, why: 'x' } } }),
        /scores/,
      );
      await db.rejects(
        async () => db.question(w, { frequency: 100 }),
        /frequencySourceId/,
      );
      await db.rejects(
        async () => db.upd('pub_questions', q, { selectedRank: 7 }),
        /selectedRank/,
      );
    });

    it('pub_brand_facts: одна активная запись ключа; цена и FAQ — по схеме; active — с утверждением', async () => {
      const f = {
        factKey: 'price.service',
        kind: 'price',
        value: { amountMinor: 500000, currency: 'UAH', note: 'від' },
        status: 'active',
        approvedBy: M,
        approvedAt: new Date(),
      };
      await db.child('pub_brand_facts', w, { ...f, version: 1 });
      await db.fails('23505', async () =>
        db.child('pub_brand_facts', w, { ...f, version: 2 }),
      );
      await db.child('pub_brand_facts', w, {
        ...f,
        version: 2,
        status: 'draft',
      });
      await db.rejects(
        async () =>
          db.child('pub_brand_facts', w, {
            ...f,
            factKey: 'price.b',
            version: 1,
            value: { amountMinor: -1, currency: 'UAH' },
          }),
        /цена/,
      );
      await db.rejects(
        async () =>
          db.child('pub_brand_facts', w, {
            factKey: 'faq.1',
            kind: 'faq',
            value: { question: 'Q' },
            version: 1,
          }),
        /faq/,
      );
      await db.rejects(
        async () =>
          db.child('pub_brand_facts', w, {
            ...f,
            factKey: 'scope.x',
            kind: 'fact',
            value: json('x'),
            version: 1,
            approvedBy: null,
          }),
        /approvedBy/,
      );
      await db.rejects(
        async () =>
          db.child('pub_brand_facts', w, {
            factKey: 'scope.y',
            kind: 'fact',
            value: json('x'),
            version: 1,
            status: 'needs_resolution',
          }),
        /conflictWithId/,
      );
    });

    it('pub_offer_versions: одна активная; содержимое неизменно после выхода из draft', async () => {
      const o = await db.offer(w);
      await db.fails('23505', async () => db.offer(w, { version: 2 }));
      await db.rejects(
        async () => db.upd('pub_offer_versions', o, { text: 'Новый текст' }),
        /неизменно/,
      );
      await db.upd('pub_offer_versions', o, { status: 'superseded' });
      await db.offer(w, { version: 2 });
    });

    it('pub_briefs: ready — вклад, CTA, активный оффер, разрешённый источник; последний источник готового брифа не снять', async () => {
      const offer = await db.offer(w);
      const b = await db.brief(w, {
        offerVersionId: offer,
        ownContribution: 'Наш кейс',
        cta: 'Обговорити',
        ctaIntentNote: 'Підходить для B2B',
      });
      await db.rejects(
        async () => db.upd('pub_briefs', b, { status: 'ready' }),
        /источника/,
      );
      const link = await db.child('pub_brief_sources', w, {
        briefId: b,
        sourceId: await db.source(w),
      });
      await db.upd('pub_briefs', b, { status: 'ready' });
      await db.rejects(
        async () => db.del('pub_brief_sources', link),
        /должен остаться/,
      );
      const b2 = await db.brief(w, { cta: 'CTA', ctaIntentNote: 'x' });
      await db.child('pub_brief_sources', w, {
        briefId: b2,
        sourceId: await db.source(w),
      });
      await db.rejects(
        async () => db.upd('pub_briefs', b2, { status: 'ready' }),
        /собственный вклад/,
      );
      await db.upd('pub_briefs', b2, { ownContribution: 'Вклад' });
      await db.rejects(
        async () => db.upd('pub_briefs', b2, { status: 'ready' }),
        /оффера/,
      );
    });

    it('pub_contents: статья — с брифом и slug; адаптация — с родителем; указатели — только на свои версии; firstPublishedAt — один раз', async () => {
      const a = await db.article(w);
      await db.rejects(
        async () =>
          db.child('pub_contents', w, { kind: 'article', slug: 'no-brief' }),
        /briefId/,
      );
      await db.rejects(
        async () => db.child('pub_contents', w, { kind: 'post' }),
        /parentContentId/,
      );
      await db.rejects(async () => db.article(w, { slug: 'Bad Slug' }), /slug/);
      const post = await db.child('pub_contents', w, {
        kind: 'post',
        parentContentId: a,
      });
      const va = await db.frozenVersion(w, a);
      await db.rejects(async () => db.version(w, post), /parentVersionId/);
      const vp = await db.version(w, post, { parentVersionId: va });
      await db.rejects(
        async () => db.upd('pub_contents', a, { currentVersionId: vp }),
        /версии этого материала/,
      );
      await db.upd('pub_contents', a, { currentVersionId: va });
      await db.upd('pub_contents', a, {
        firstPublishedAt: new Date('2026-10-20T07:00:00Z'),
      });
      await db.rejects(
        async () => db.upd('pub_contents', a, { firstPublishedAt: new Date() }),
        /один раз/,
      );
    });

    it('pub_content_versions: формат = вид материала; вне draft — hash и frozenAt; после заморозки содержимое и связи неизменны', async () => {
      const a = await db.article(w);
      await db.rejects(
        async () => db.version(w, a, { format: 'post' }),
        /format/,
      );
      await db.rejects(
        async () => db.version(w, a, { status: 'submitted' }),
        /hash и frozenAt/,
      );
      // Аудит P1-1: hash — только у замороженной версии.
      await db.rejects(
        async () => db.version(w, a, { number: 7, hash: hex64() }),
        /hash есть ⇔/,
      );
      const draft = await db.version(w, a, { number: 8 });
      await db.rejects(
        async () => db.upd('pub_content_versions', draft, { hash: hex64() }),
        /hash есть ⇔/,
      );
      const v = await db.frozenVersion(w, a);
      await db.rejects(
        async () => db.upd('pub_content_versions', v, { body: 'Тихая правка' }),
        /после frozenAt/,
      );
      await db.upd('pub_content_versions', v, { status: 'approved' });
      await db.rejects(
        async () =>
          db.child('pub_version_sources', w, {
            versionId: v,
            sourceId: await db.source(w),
          }),
        /замороженной/,
      );
      const claim = await db.child('pub_claims', w, {
        statement: 'Факт',
        type: 'fact',
        risk: 'normal',
      });
      await db.rejects(
        async () =>
          db.child('pub_version_claims', w, { versionId: v, claimId: claim }),
        /замороженной/,
      );
    });

    it('pub_claims: критический supported — человек и поддерживающий разрешённый источник, проверенный после изменения; доказательство не снять', async () => {
      const cl = await db.child('pub_claims', w, {
        statement: 'Скидка 20 %',
        type: 'fact',
        risk: 'critical',
      });
      await db.rejects(
        async () => db.upd('pub_claims', cl, { status: 'supported' }),
        /verifiedBy/,
      );
      await db.rejects(
        async () =>
          db.upd('pub_claims', cl, {
            status: 'supported',
            verifiedBy: M,
            verifiedAt: new Date(),
          }),
        /supports=yes/,
      );
      const s = await db.source(w);
      const weak = await db.child('pub_claim_sources', w, {
        claimId: cl,
        sourceId: s,
        supports: 'partial',
        checkedBy: M,
        checkedAt: new Date(),
      });
      await db.rejects(
        async () =>
          db.upd('pub_claims', cl, {
            status: 'supported',
            verifiedBy: M,
            verifiedAt: new Date(),
          }),
        /supports=yes/,
      );
      await db.upd('pub_claim_sources', weak, { supports: 'yes' });
      await db.upd('pub_claims', cl, {
        status: 'supported',
        verifiedBy: M,
        verifiedAt: new Date(),
      });
      await db.rejects(
        async () => db.del('pub_claim_sources', weak),
        /должно остаться/,
      );
      await db.rejects(
        async () =>
          db.upd('pub_claims', cl, { verifiedBy: 'system:ai-review' }),
        /человек/,
      );
    });

    it('pub_claims: statement/type/risk неизменны после связи с замороженной версией', async () => {
      const a = await db.article(w);
      const v = await db.version(w, a);
      const cl = await db.child('pub_claims', w, {
        statement: 'Срок 5 дней',
        type: 'fact',
        risk: 'high',
      });
      await db.child('pub_version_claims', w, { versionId: v, claimId: cl });
      await db.upd('pub_claims', cl, { statement: 'Срок 6 дней' });
      await db.upd('pub_content_versions', v, {
        status: 'submitted',
        hash: hex64(),
        frozenAt: new Date(),
      });
      await db.rejects(
        async () => db.upd('pub_claims', cl, { risk: 'normal' }),
        /supersedesId/,
      );
    });

    it('pub_qa_checks: ai_review — system:ai-review с вызовом, прочие — человек; append-only', async () => {
      const a = await db.article(w);
      const v = await db.frozenVersion(w, a);
      await db.rejects(
        async () =>
          db.child('pub_qa_checks', w, {
            versionId: v,
            kind: 'ai_review',
            result: 'pass',
            blockers: [],
            checkedBy: M,
          }),
        /checkedBy/,
      );
      await db.rejects(
        async () =>
          db.child('pub_qa_checks', w, {
            versionId: v,
            kind: 'editorial',
            result: 'pass',
            blockers: [],
            checkedBy: 'system:ai-review',
          }),
        /checkedBy/,
      );
      const call = await db.aiCall(w);
      await db.child('pub_qa_checks', w, {
        versionId: v,
        kind: 'ai_review',
        result: 'unknown',
        blockers: [],
        checkedBy: 'system:ai-review',
        aiCallId: call,
      });
      const qa = await db.child('pub_qa_checks', w, {
        versionId: v,
        kind: 'editorial',
        result: 'pass',
        blockers: [],
        checkedBy: M,
      });
      await db.rejects(
        async () => db.upd('pub_qa_checks', qa, { result: 'fail' }),
        /append-only/,
      );
    });

    it('pub_approvals: закупка — сумма, валюта, срок ≤ 72 ч; публикация — без срока; переходы только из active; суть неизменна', async () => {
      await db.rejects(
        async () => db.purchaseApproval(w, { expiresAt: null }),
        /72/,
      );
      await db.rejects(
        async () =>
          db.purchaseApproval(w, {
            expiresAt: new Date(Date.now() + 73 * 3_600_000),
            decidedAt: new Date(),
          }),
        /72/,
      );
      await db.rejects(
        async () =>
          db.purchaseApproval(w, { maxAmountMinor: null, currency: null }),
        /сумму/,
      );
      // Аудит P2-2: объект закупки — эта закупка продукта, валюта и сумма.
      const pl = await db.placement(w);
      await db.rejects(
        async () =>
          db.purchaseApproval(w, {
            objectId: pl,
            currency: 'USD',
            maxAmountMinor: 100_000,
          }),
        /закупка этого продукта в той же валюте/,
      );
      await db.rejects(
        async () =>
          db.purchaseApproval(w, { objectId: pl, maxAmountMinor: 99_999 }),
        /сумма не меньше/,
      );
      const other = await db.sibling(w);
      const plOther = await db.placement(other);
      await db.rejects(
        async () => db.purchaseApproval(w, { objectId: plOther }),
        /закупка этого продукта/,
      );
      await db.rejects(
        async () =>
          db.purchaseApproval(w, { objectId: pl, objectType: 'ai_task' }),
        /objectType/,
      );
      await db.purchaseApproval(w, { objectId: pl });
      const a = await db.article(w);
      const v = await db.frozenVersion(w, a);
      await db.rejects(
        async () => db.publishApproval(w, v, { expiresAt: new Date() }),
        /NULL/,
      );
      // Аудит P1-1: согласуется только замороженная версия с её hash.
      const draft = await db.version(w, a, { number: 2 });
      await db.rejects(
        async () =>
          db.child('pub_approvals', w, {
            type: 'publish_version',
            objectType: 'content_version',
            objectId: draft,
            versionHash: hex64(),
            approverMemberId: 'm1',
            approverDisplayName: 'Редактор',
          }),
        /замороженная версия/,
      );
      await db.rejects(
        async () => db.publishApproval(w, v, { versionHash: hex64() }),
        /замороженная версия этого продукта с тем же hash/,
      );
      const ap = await db.publishApproval(w, v);
      await db.rejects(
        async () => db.upd('pub_approvals', ap, { status: 'consumed' }),
        /только purchase/,
      );
      await db.rejects(
        async () => db.upd('pub_approvals', ap, { versionHash: hex64() }),
        /append-only/,
      );
      await db.upd('pub_approvals', ap, {
        status: 'revoked',
        reason: 'Снято редактором',
      });
      await db.rejects(
        async () => db.upd('pub_approvals', ap, { status: 'active' }),
        /только из active/,
      );
      await db.rejects(
        async () => db.publishApproval(w, v, { status: 'superseded' }),
        /создаётся active/,
      );
      await db.rejects(async () => db.del('pub_approvals', ap), /append-only/);
    });
  });

  describe('распространение и деньги (6.4)', () => {
    async function liveProduct(): Promise<void> {
      await db.upd('pub_products', w.productId, {
        mode: 'live',
        liveSince: new Date(),
      });
    }

    it('pub_publications: hash согласования = hash версии, согласование активно, live — только в live рабочего продукта', async () => {
      const a = await db.article(w);
      const v = await db.frozenVersion(w, a);
      const ch = await db.channel(w);
      const ap = await db.publishApproval(w, v);
      const base = {
        versionId: v,
        channelId: ch,
        approvalId: ap,
        finalUrl: 'https://ai-publisher.example/a',
        opKey: uuid4(),
      };
      await db.rejects(
        async () => db.child('pub_publications', w, { ...base, stage: 'live' }),
        /live только/,
      );
      await db.child('pub_publications', w, { ...base, stage: 'test' });
      const v2 = await db.frozenVersion(w, a, { number: 2 });
      await db.rejects(
        async () =>
          db.child('pub_publications', w, {
            ...base,
            versionId: v2,
            opKey: uuid4(),
            stage: 'test',
            finalUrl: 'https://ai-publisher.example/b',
          }),
        /hash этой версии/,
      );
      const ap2 = await db.publishApproval(w, v2);
      await db.upd('pub_approvals', ap2, { status: 'revoked' });
      await db.rejects(
        async () =>
          db.child('pub_publications', w, {
            ...base,
            versionId: v2,
            approvalId: ap2,
            opKey: uuid4(),
            stage: 'test',
            finalUrl: 'https://ai-publisher.example/b',
          }),
        /активном согласовании/,
      );
      // Аудит P1-1: согласование другой версии с тем же hash не годится.
      const twin = await db.frozenVersion(w, a, {
        number: 3,
        hash: await db.versionHash(v),
      });
      await db.rejects(
        async () =>
          db.child('pub_publications', w, {
            ...base,
            versionId: twin,
            opKey: uuid4(),
            stage: 'test',
            finalUrl: 'https://ai-publisher.example/twin',
          }),
        /objectId = versionId/,
      );
      // Аудит P3-10: URL — в каноническом виде.
      for (const finalUrl of [
        'https://AI-Publisher.example/c',
        'https://ai-publisher.example/c/',
        'https://ai-publisher.example:443/c',
        'https://ai-publisher.example/c#top',
      ]) {
        await db.rejects(
          async () =>
            db.child('pub_publications', w, {
              ...base,
              opKey: uuid4(),
              stage: 'test',
              finalUrl,
            }),
          /канонический/,
        );
      }
      await liveProduct();
      await db.child('pub_publications', w, {
        ...base,
        opKey: uuid4(),
        stage: 'live',
        finalUrl: 'https://ai-publisher.example/live',
      });
    });

    it('одна активная публикация URL (частичный индекс); v2 по тому же URL — после replaced v1; переходы — по машине', async () => {
      await liveProduct();
      const a = await db.article(w);
      const ch = await db.channel(w);
      const v1 = await db.frozenVersion(w, a);
      const v2 = await db.frozenVersion(w, a, { number: 2 });
      const url = 'https://ai-publisher.example/guide';
      const p1 = await db.child('pub_publications', w, {
        versionId: v1,
        channelId: ch,
        approvalId: await db.publishApproval(w, v1),
        stage: 'live',
        finalUrl: url,
        opKey: uuid4(),
        status: 'published',
        publishedAt: new Date(),
      });
      const ap2 = await db.publishApproval(w, v2);
      await db.fails('23505', async () =>
        db.child('pub_publications', w, {
          versionId: v2,
          channelId: ch,
          approvalId: ap2,
          stage: 'live',
          finalUrl: url,
          opKey: uuid4(),
        }),
      );
      await db.upd('pub_publications', p1, { status: 'replaced' });
      await db.child('pub_publications', w, {
        versionId: v2,
        channelId: ch,
        approvalId: ap2,
        stage: 'live',
        finalUrl: url,
        opKey: uuid4(),
        status: 'published',
        publishedAt: new Date(),
      });
      await db.rejects(
        async () => db.upd('pub_publications', p1, { status: 'published' }),
        /машины 7.5/,
      );
      await db.rejects(
        async () =>
          db.upd('pub_publications', p1, {
            finalUrl: 'https://ai-publisher.example/other',
          }),
        /неизменны/,
      );
      // Тот же (канал, URL, версия) дважды — нельзя и в истории.
      await db.fails('23505', async () =>
        db.child('pub_publications', w, {
          versionId: v1,
          channelId: ch,
          approvalId: await db.publishApproval(w, v1),
          stage: 'test',
          finalUrl: url,
          opKey: uuid4(),
          status: 'failed',
        }),
      );
    });

    it('pub_distribution_actions: UTM у внешних каналов обязателен, у site — запрещён; done — с публикацией', async () => {
      const a = await db.article(w);
      const v = await db.frozenVersion(w, a);
      const ext = await db.channel(w, {
        code: 'tg',
        name: 'Telegram',
        kind: 'own',
        utmSource: 'telegram',
        utmMedium: 'social',
      });
      const site = await db.channel(w);
      const act = {
        versionId: v,
        format: 'post',
        goal: 'Охват',
        plannedAt: new Date(),
        ownerMemberId: 'm1',
        ownerDisplayName: 'Оператор',
      };
      await db.rejects(
        async () =>
          db.child('pub_distribution_actions', w, {
            ...act,
            channelId: ext,
            measurableUrl: 'https://ai-publisher.example/a',
          }),
        /UTM/,
      );
      await db.child('pub_distribution_actions', w, {
        ...act,
        channelId: ext,
        measurableUrl:
          'https://ai-publisher.example/a?utm_source=telegram&utm_medium=social&utm_campaign=pilot',
      });
      await db.rejects(
        async () =>
          db.child('pub_distribution_actions', w, {
            ...act,
            channelId: site,
            measurableUrl: 'https://ai-publisher.example/a?utm_source=x',
          }),
        /UTM/,
      );
      const ok = await db.child('pub_distribution_actions', w, {
        ...act,
        channelId: site,
        measurableUrl: 'https://ai-publisher.example/a',
      });
      await db.rejects(
        async () => db.upd('pub_distribution_actions', ok, { status: 'done' }),
        /publicationId/,
      );
      await db.rejects(
        async () =>
          db.upd('pub_distribution_actions', ok, { status: 'blocked' }),
        /blockReason/,
      );
    });

    it('pub_venues: verified — все пять проверок и маркировка ссылки', async () => {
      const v = await db.venue(w);
      await db.rejects(
        async () => db.upd('pub_venues', v, { status: 'verified' }),
        /пять проверок/,
      );
      await db.upd('pub_venues', v, {
        checkTopicMarket: true,
        checkPriceConfirmed: true,
        checkFormatConfirmed: true,
        checkTermSet: true,
        checkSupplierKnown: true,
      });
      await db.rejects(
        async () => db.upd('pub_venues', v, { status: 'verified' }),
        /маркировку/,
      );
      await db.upd('pub_venues', v, {
        status: 'verified',
        linkMarking: 'sponsored',
      });
      await db.rejects(
        async () =>
          db.venue(w, { criteria: { topic: { score: 5, why: 'x' } } }),
        /criteria/,
      );
    });

    it('pub_placements: total = base + fees; валюта — с курсом; третья закупка — с решением отчёта; претензия — с владельцем и датой', async () => {
      await db.rejects(
        async () => db.placement(w, { totalPriceMinor: 99_999 }),
        /base \+ fees/,
      );
      await db.rejects(
        async () =>
          db.placement(w, { origCurrency: 'USD', origAmountMinor: 2500 }),
        /другой валюте/,
      );
      await db.placement(w, {
        origCurrency: 'USD',
        origAmountMinor: 2500,
        fxRate: '41.25',
        fxSource: 'НБУ',
        fxAt: new Date(),
      });
      const campaignId = await db.campaign(w);
      const p3 = await db.placement(w, {
        campaignId,
        purchaseSeq: 3,
        priceConfirmedAt: new Date(),
        priceSource: 'лист',
      });
      await db.rejects(
        async () => db.upd('pub_placements', p3, { status: 'approved' }),
        /reportDecisionId/,
      );
      await db.fails('23505', async () =>
        db.placement(w, { campaignId, purchaseSeq: 3 }),
      );
      const p = await db.placement(w, {
        priceConfirmedAt: new Date(),
        priceSource: 'лист',
        externalOrderId: 'ORD-1',
        status: 'ordered',
      });
      await db.rejects(
        async () => db.upd('pub_placements', p, { status: 'disputed' }),
        /claimOwnerMemberId/,
      );
      await db.upd('pub_placements', p, {
        status: 'disputed',
        claimOwnerMemberId: 'm1',
        nextActionAt: new Date(),
      });
      await db.rejects(
        async () => db.upd('pub_placements', p, { purchaseSeq: 2 }),
        /неизменны/,
      );
      // Аудит P2-2: при собранном лимите закупка — в его валюте.
      await db.budgetLimit(w);
      await db.rejects(
        async () =>
          db.placement(w, {
            currency: 'USD',
            origCurrency: null,
          }),
        /валюта лимита бюджета/,
      );
    });

    it('pub_expenses: обязательство закупки ≤ суммы согласования; paid + cancelled ≤ total; refunded ≤ paid', async () => {
      const { placementId: pl, approvalId: ap } = await db.approvedPlacement(w);
      const e = {
        category: 'placements',
        description: 'Размещение',
        placementId: pl,
        currency: 'UAH',
      };
      await db.rejects(
        async () =>
          db.child('pub_expenses', w, { ...e, amountTotalMinor: 100_001 }),
        /валюта лимита бюджета/,
      );
      await db.budgetLimit(w);
      await db.rejects(
        async () =>
          db.child('pub_expenses', w, { ...e, amountTotalMinor: 100_001 }),
        /maxAmountMinor/,
      );
      // Аудит P2-2: валюта, статус и объект согласования.
      await db.rejects(
        async () =>
          db.child('pub_expenses', w, {
            ...e,
            currency: 'USD',
            amountTotalMinor: 1,
          }),
        /валюта лимита бюджета/,
      );
      const { placementId: pl2, approvalId: ap2 } =
        await db.approvedPlacement(w);
      await db.upd('pub_approvals', ap2, {
        status: 'revoked',
        reason: 'Снято владельцем',
      });
      await db.rejects(
        async () =>
          db.child('pub_expenses', w, {
            ...e,
            placementId: pl2,
            amountTotalMinor: 1,
          }),
        /действующему согласованию purchase этой закупки/,
      );
      // Закупка, привязанная к согласованию другой закупки, не проходит.
      const foreign = await db.placement(w);
      await db.rejects(
        async () => db.upd('pub_placements', foreign, { approvalId: ap }),
        /согласование purchase этой закупки/,
      );
      const ex = await db.child('pub_expenses', w, {
        ...e,
        amountTotalMinor: 100_000,
      });
      await db.rejects(
        async () =>
          db.upd('pub_expenses', ex, {
            paidMinor: 60_000,
            cancelledMinor: 50_000,
          }),
        /paid \+ cancelled/,
      );
      await db.rejects(
        async () => db.upd('pub_expenses', ex, { refundedMinor: 1 }),
        /refunded/,
      );
      await db.rejects(
        async () =>
          db.upd('pub_expenses', ex, {
            deliveredMinor: 90_000,
            cancelledMinor: 20_000,
          }),
        /delivered/,
      );
      await db.rejects(
        async () => db.upd('pub_expenses', ex, { amountTotalMinor: 150_000 }),
        /maxAmountMinor/,
      );
      await db.rejects(
        async () =>
          db.child('pub_expenses', w, {
            category: 'tools',
            description: 'Хостинг',
            amountTotalMinor: 1,
            currency: 'UAH',
            placementId: pl,
          }),
        /placementId/,
      );
      await db.child('pub_expenses', w, {
        category: 'tools',
        description: 'Хостинг',
        amountTotalMinor: 30_000,
        currency: 'UAH',
      });
    });

    it('pub_expense_entries: сверка только pending|unknown → confirmed|void; подтверждение — с автором; суммы неизменны', async () => {
      await db.budgetLimit(w);
      const ex = await db.child('pub_expenses', w, {
        category: 'tools',
        description: 'Домен',
        amountTotalMinor: 50_000,
        currency: 'UAH',
      });
      const en = {
        expenseId: ex,
        kind: 'pay',
        amountMinor: 50_000,
        occurredAt: new Date(),
        opKey: uuid4(),
      };
      await db.rejects(
        async () =>
          db.child('pub_expense_entries', w, { ...en, status: 'confirmed' }),
        /confirmedAt/,
      );
      const id = await db.child('pub_expense_entries', w, {
        ...en,
        status: 'unknown',
      });
      await db.rejects(
        async () => db.upd('pub_expense_entries', id, { amountMinor: 1 }),
        /append-only/,
      );
      await db.rejects(
        async () => db.upd('pub_expense_entries', id, { status: 'confirmed' }),
        /confirmedAt/,
      );
      await db.upd('pub_expense_entries', id, {
        status: 'confirmed',
        confirmedAt: new Date(),
        confirmedBy: M,
      });
      await db.rejects(
        async () => db.upd('pub_expense_entries', id, { status: 'void' }),
        /pending\|unknown/,
      );
      await db.rejects(
        async () =>
          db.child('pub_expense_entries', w, {
            ...en,
            opKey: uuid4(),
            kind: 'adjust',
            amountMinor: -100,
            status: 'pending',
          }),
        /adjust/,
      );
      await db.child('pub_expense_entries', w, {
        ...en,
        opKey: uuid4(),
        kind: 'adjust',
        amountMinor: -100,
        status: 'pending',
        note: 'Скидка поставщика',
      });
      await db.rejects(
        async () => db.del('pub_expense_entries', id),
        /append-only/,
      );
    });

    it('pub_reserve_moves: только по согласованию reserve_release на сумму не меньше; pub_budget_limits — без отрицательных', async () => {
      const wrong = await db.purchaseApproval(w);
      await db.rejects(
        async () =>
          db.child('pub_reserve_moves', w, {
            toCategory: 'placements',
            amountMinor: 500,
            approvalId: wrong,
          }),
        /reserve_release/,
      );
      const rr = await db.reserveApproval(w, { maxAmountMinor: 800 });
      // Без строки лимита в валюте согласования перевод невозможен.
      await db.rejects(
        async () =>
          db.child('pub_reserve_moves', w, {
            toCategory: 'placements',
            amountMinor: 500,
            approvalId: rr,
          }),
        /в валюте лимита/,
      );
      await db.budgetLimit(w);
      await db.rejects(
        async () =>
          db.child('pub_reserve_moves', w, {
            toCategory: 'placements',
            amountMinor: 801,
            approvalId: rr,
          }),
        /reserve_release/,
      );
      const mv = await db.child('pub_reserve_moves', w, {
        toCategory: 'placements',
        amountMinor: 500,
        approvalId: rr,
      });
      // Аудит P2-2: сумма всех переводов по согласованию ≤ его суммы.
      await db.rejects(
        async () =>
          db.child('pub_reserve_moves', w, {
            toCategory: 'tools',
            amountMinor: 301,
            approvalId: rr,
          }),
        /всех переводов/,
      );
      await db.child('pub_reserve_moves', w, {
        toCategory: 'tools',
        amountMinor: 300,
        approvalId: rr,
      });
      const usd = await db.reserveApproval(w, { currency: 'USD' });
      await db.rejects(
        async () =>
          db.child('pub_reserve_moves', w, {
            toCategory: 'tools',
            amountMinor: 1,
            approvalId: usd,
          }),
        /в валюте лимита/,
      );
      const revoked = await db.reserveApproval(w);
      await db.upd('pub_approvals', revoked, {
        status: 'revoked',
        reason: 'Снято',
      });
      await db.rejects(
        async () =>
          db.child('pub_reserve_moves', w, {
            toCategory: 'tools',
            amountMinor: 1,
            approvalId: revoked,
          }),
        /действующее/,
      );
      await db.rejects(
        async () => db.del('pub_reserve_moves', mv),
        /append-only/,
      );
      await db.rejects(
        async () =>
          db.child('pub_budget_limits', w, {
            currency: 'UAH',
            netPaidMinor: -1,
          }),
        /≥ 0/,
      );
      await db.fails('23505', async () =>
        db.child('pub_budget_limits', w, { currency: 'UAH' }),
      );
    });

    it('pub_time_entries: инвестиция = setup|development; минуты 1..1440', async () => {
      const t = {
        memberId: 'm1',
        memberDisplayName: 'Оля',
        role: 'editor',
        task: 'Статья',
        minutes: 60,
        workDate: '2026-10-20',
        category: 'production',
      };
      await db.rejects(
        async () =>
          db.child('pub_time_entries', w, { ...t, isInvestment: true }),
        /isInvestment/,
      );
      await db.child('pub_time_entries', w, { ...t, isInvestment: false });
      await db.rejects(
        async () =>
          db.child('pub_time_entries', w, {
            ...t,
            isInvestment: false,
            minutes: 0,
          }),
        /minutes/,
      );
      await db.child('pub_time_entries', w, {
        ...t,
        category: 'development',
        isInvestment: true,
      });
    });
  });

  describe('заявки и аналитика (6.5)', () => {
    // Приём — только в продукт, который принимает заявки (аудит P3-2).
    beforeEach(async () => {
      await db.openForIntake(w);
    });

    it('pub_leads: qualified — с проспектом; тест-флаг — с причиной; closedAt — только в закрытых статусах', async () => {
      const l = await db.lead(w);
      await db.rejects(
        async () => db.upd('pub_leads', l, { status: 'qualified' }),
        /prospectId/,
      );
      await db.upd('pub_leads', l, {
        status: 'qualified',
        prospectId: await db.prospect(w),
      });
      await db.rejects(
        async () => db.lead(w, { testFlag: true }),
        /testReason/,
      );
      await db.rejects(
        async () => db.lead(w, { testReason: 'manual' }),
        /testReason/,
      );
      await db.rejects(
        async () => db.upd('pub_leads', l, { closedAt: new Date() }),
        /closedAt/,
      );
      await db.upd('pub_leads', l, { status: 'won', closedAt: new Date() });
      await db.rejects(
        async () => db.upd('pub_leads', l, { publicRef: 'L-AAAAAAAAAA' }),
        /неизменны/,
      );
      await db.rejects(
        async () => db.lead(w, { selfReportedChannel: 'Мій друг Петро' }),
        /selfReportedChannel/,
      );
      await db.rejects(
        async () => db.lead(w, { contentSlugRaw: 'ivan@example.com' }),
        /контакт/,
      );
    });

    it('pub_leads: в продукте kind≠working и в режиме test — только тестовые заявки; submissionKey уникален в продукте', async () => {
      const t = await db.sibling(w, { kind: 'test', mode: 'test' });
      await db.rejects(async () => db.lead(t), /kind≠working/);
      await db.lead(t, { testFlag: true, testReason: 'test_product' });
      await db.upd('pub_products', w.productId, { mode: 'closed' });
      await db.upd('pub_products', w.productId, { mode: 'test' });
      await db.rejects(async () => db.lead(w), /режиме test/);
      const key = uuid4();
      await db.lead(w, {
        submissionKey: key,
        testFlag: true,
        testReason: 'test_mode',
      });
      await db.fails('23505', async () =>
        db.lead(w, {
          submissionKey: key,
          testFlag: true,
          testReason: 'test_mode',
        }),
      );
    });

    it('pub_lead_contacts: только шифротекст', async () => {
      const l = await db.lead(w);
      await db.rejects(
        async () =>
          db.child('pub_lead_contacts', w, {
            leadId: l,
            contactEnc: 'Іван, +380501234567',
            keyVersion: 'v1',
          }),
        /шифротекст/,
      );
      await db.rejects(
        async () =>
          db.child('pub_lead_contacts', w, {
            leadId: l,
            contactEnc: 'v2.aGVsbG8.dGFn.Y2lwaGVy',
            keyVersion: 'v1',
          }),
        /keyVersion/,
      );
      await db.child('pub_lead_contacts', w, {
        leadId: l,
        contactEnc: 'v1.aGVsbG8.dGFn.Y2lwaGVy',
        matchHash: hex64(),
        keyVersion: 'v1',
      });
      await db.fails('23505', async () =>
        db.child('pub_lead_contacts', w, {
          leadId: l,
          contactEnc: 'v1.a.b.c',
          keyVersion: 'v1',
        }),
      );
    });

    it('pub_lead_decisions: код причины для отказа и отмены, подтверждённый интерес для qualified; append-only, заметку — только обнулить', async () => {
      const l = await db.lead(w);
      const d = { leadId: l, fromStatus: 'new', decidedBy: M };
      await db.rejects(
        async () =>
          db.child('pub_lead_decisions', w, { ...d, toStatus: 'rejected' }),
        /reasonCode/,
      );
      await db.rejects(
        async () =>
          db.child('pub_lead_decisions', w, { ...d, toStatus: 'qualified' }),
        /confirmedInterestAt/,
      );
      await db.rejects(
        async () =>
          db.child('pub_lead_decisions', w, {
            ...d,
            fromStatus: 'qualified',
            toStatus: 'contacted',
          }),
        /reasonCode/,
      );
      await db.rejects(
        async () =>
          db.child('pub_lead_decisions', w, {
            ...d,
            toStatus: 'contacted',
            decidedBy: 'system:ai',
          }),
        /человек/,
      );
      const id = await db.child('pub_lead_decisions', w, {
        ...d,
        toStatus: 'rejected',
        reasonCode: 'vendor_offer',
        noteEnc: 'v1.a.b.c',
      });
      await db.rejects(
        async () => db.upd('pub_lead_decisions', id, { reasonCode: 'spam' }),
        /append-only/,
      );
      await db.rejects(
        async () => db.upd('pub_lead_decisions', id, { noteEnc: 'v1.x.y.z' }),
        /только обнуление/,
      );
      // Ротация ключа (запрос P-A1): перешифровка другой версией — можно.
      await db.upd('pub_lead_decisions', id, { noteEnc: 'v2.x.y.z' });
      await db.rejects(
        async () => db.upd('pub_lead_decisions', id, { noteEnc: 'v2.p.q.r' }),
        /только обнуление/,
      );
      await db.rejects(
        async () =>
          db.upd('pub_lead_decisions', id, { noteEnc: 'Іван передзвонить' }),
        /шифротекст|только обнуление/,
      );
      await db.upd('pub_lead_decisions', id, { noteEnc: null });
      await db.rejects(
        async () => db.upd('pub_lead_decisions', id, { noteEnc: 'v3.x.y.z' }),
        /только обнуление/,
      );
      await db.rejects(
        async () => db.del('pub_lead_decisions', id),
        /append-only/,
      );
      await db.rejects(
        async () =>
          db.child('pub_lead_decisions', w, {
            ...d,
            toStatus: 'contacted',
            noteEnc: 'Іван передзвонить',
          }),
        /шифротекст/,
      );
    });

    it('UTM (события и сессии): только четыре ключа, без email и телефона; [redacted] — можно', async () => {
      const ev = { name: 'content_view', testFlag: false, createdBy: 'public' };
      await db.child('pub_events', w, {
        ...ev,
        eventId: uuid4(),
        utm: {
          source: 'telegram',
          medium: 'social',
          campaign: 'pilot_2026',
          content: 'pl-1',
        },
      });
      await db.child('pub_events', w, {
        ...ev,
        eventId: uuid4(),
        utm: { source: '[redacted]' },
      });
      for (const utm of [
        { term: 'x' },
        { source: 'ivan@example.com' },
        { campaign: '+38 050 123 45 67' },
        { content: '380 44 123 45 67' },
        { source: 'a'.repeat(101) },
        { source: 1 },
      ]) {
        await db.rejects(
          async () =>
            db.child('pub_events', w, { ...ev, eventId: uuid4(), utm }),
          /utm/,
        );
      }
      await db.rejects(
        async () =>
          db.child('pub_sessions', w, {
            sessionRef: 'sess_12345678',
            landingPath: '/',
            utm: { gclid: 'x' },
            consentState: 'unknown',
            testFlag: false,
            createdBy: 'public',
          }),
        /utm/,
      );
      // Аудит P3-5: в пути входа — без query, фрагмента и «@».
      for (const landingPath of ['/a?email=x', '/a#frag', '/u/ivan@example']) {
        await db.rejects(
          async () =>
            db.child('pub_sessions', w, {
              sessionRef: `sess_${uuid4().slice(0, 12)}`,
              landingPath,
              utm: {},
              consentState: 'unknown',
              testFlag: false,
              createdBy: 'public',
            }),
          /landingPath/,
        );
      }
      await db.child('pub_sessions', w, {
        sessionRef: `sess_${uuid4().slice(0, 12)}`,
        landingPath: '/guides/2026-10-20-vybir',
        utm: {},
        consentState: 'unknown',
        testFlag: false,
        createdBy: 'public',
      });
    });

    it('аудит P3-2: заявки и события — только в продукт, который их принимает', async () => {
      const ev = {
        name: 'content_view',
        testFlag: false,
        createdBy: 'public',
      };
      await db.upd('pub_products', w.productId, { mode: 'closed' });
      await db.rejects(async () => db.lead(w), /не принимает заявки/);
      await db.rejects(
        async () => db.child('pub_events', w, { ...ev, eventId: uuid4() }),
        /не принимает/,
      );
      await db.upd('pub_products', w.productId, { mode: 'live' });
      // live без обоих гейтов параметров: события — да, заявки — нет.
      await db.upd('pub_products', w.productId, {
        paramsRealLeadsOk: false,
      });
      await db.child('pub_events', w, { ...ev, eventId: uuid4() });
      await db.rejects(async () => db.lead(w), /не принимает заявки/);
      await db.upd('pub_products', w.productId, { paramsRealLeadsOk: true });
      await db.lead(w);
      await db.upd('pub_products', w.productId, { status: 'archived' });
      await db.rejects(async () => db.lead(w), /не принимает заявки/);
      await db.rejects(
        async () => db.child('pub_events', w, { ...ev, eventId: uuid4() }),
        /не принимает/,
      );
      const ev2 = await db.sibling(w, { kind: 'eval', mode: 'test' });
      await db.rejects(
        async () =>
          db.lead(ev2, { testFlag: true, testReason: 'test_product' }),
        /не принимает заявки/,
      );
    });

    it('pub_events / pub_sessions: leadId только у lead_submit_success; paid_placement — только с размещением', async () => {
      const l = await db.lead(w);
      await db.rejects(
        async () =>
          db.child('pub_events', w, {
            eventId: uuid4(),
            name: 'content_view',
            leadId: l,
            testFlag: false,
            createdBy: 'public',
          }),
        /leadId/,
      );
      await db.rejects(
        async () =>
          db.child('pub_events', w, {
            eventId: uuid4(),
            name: 'lead_submit_success',
            testFlag: false,
            createdBy: 'public',
          }),
        /leadId/,
      );
      const e = await db.child('pub_events', w, {
        eventId: uuid4(),
        name: 'lead_submit_success',
        leadId: l,
        testFlag: false,
        createdBy: 'public',
      });
      await db.rejects(
        async () => db.upd('pub_events', e, { channelGroup: 'paid_placement' }),
        /paid_placement/,
      );
      await db.upd('pub_events', e, {
        channelGroup: 'organic_search',
        enrichedAt: new Date(),
      });
      await db.rejects(
        async () =>
          db.upd('pub_events', e, { name: 'cta_click', leadId: null }),
        /неизменно/,
      );
      await db.rejects(
        async () =>
          db.child('pub_sessions', w, {
            sessionRef: 'short',
            landingPath: '/',
            utm: {},
            consentState: 'unknown',
            testFlag: false,
            createdBy: 'public',
          }),
        /sessionRef/,
      );
    });

    it('pub_notifications: в продукте kind≠working — только suppressed; pub_queue_checks — append-only, человек', async () => {
      const t = await db.sibling(w, { kind: 'test', mode: 'test' });
      const tl = await db.lead(t, {
        testFlag: true,
        testReason: 'test_product',
      });
      await db.rejects(
        async () =>
          db.child('pub_notifications', t, {
            leadId: tl,
            kind: 'new_lead',
            recipientMemberId: 'm1',
          }),
        /suppressed/,
      );
      await db.child('pub_notifications', t, {
        leadId: tl,
        kind: 'new_lead',
        recipientMemberId: 'm1',
        status: 'suppressed',
      });
      const l = await db.lead(w);
      const n = await db.child('pub_notifications', w, {
        leadId: l,
        kind: 'new_lead',
        recipientMemberId: 'm1',
      });
      await db.rejects(
        async () => db.upd('pub_notifications', n, { status: 'sent' }),
        /sentAt/,
      );
      const qc = await db.child('pub_queue_checks', w, {
        checkedBy: M,
        workDate: '2026-10-20',
        openCount: 2,
        overdueCount: 0,
      });
      await db.rejects(
        async () => db.upd('pub_queue_checks', qc, { openCount: 0 }),
        /append-only/,
      );
      await db.rejects(
        async () =>
          db.child('pub_queue_checks', w, {
            checkedBy: 'system:cron',
            workDate: '2026-10-21',
            openCount: 0,
            overdueCount: 0,
          }),
        /человек/,
      );
    });

    it('pub_payments: подтверждение — с автором; суть неизменна; повтор paymentRef — 23505; pub_erasures — append-only', async () => {
      const pr = await db.prospect(w);
      const p = {
        prospectId: pr,
        recordType: 'payment_received',
        payerKind: 'external',
        amountMinor: 1_000_000,
        currency: 'UAH',
        occurredAt: new Date(),
        paymentRef: 'INV-1',
        opKey: uuid4(),
      };
      await db.rejects(
        async () => db.child('pub_payments', w, { ...p, status: 'confirmed' }),
        /confirmedBy/,
      );
      const id = await db.child('pub_payments', w, p);
      await db.fails('23505', async () =>
        db.child('pub_payments', w, { ...p, opKey: uuid4() }),
      );
      await db.rejects(
        async () => db.upd('pub_payments', id, { amountMinor: 2 }),
        /неизменна/,
      );
      await db.upd('pub_payments', id, {
        status: 'confirmed',
        confirmedBy: M,
        confirmedAt: new Date(),
        isNewCustomer: 'yes',
      });
      const er = await db.child('pub_erasures', w, {
        leadId: await db.lead(w),
        erasedBy: M,
        basis: 'Запрос заявителя',
        scope: { active: true },
      });
      await db.rejects(
        async () => db.upd('pub_erasures', er, { basis: 'другое' }),
        /append-only/,
      );
    });
  });

  describe('отчёты, эксперименты, бэкап (6.6)', () => {
    it('pub_experiments: существенные поля неизменны, t0…t90 — один раз и вместе, удаление запрещено', async () => {
      const e = await db.experiment(w);
      await db.rejects(
        async () =>
          db.upd('pub_experiments', e, {
            hypothesis: 'Подправленная гипотеза',
          }),
        /новая версия/,
      );
      await db.rejects(
        async () =>
          db.upd('pub_experiments', e, {
            t0: new Date('2026-10-20T07:00:00Z'),
          }),
        /вместе/,
      );
      const t = {
        t0: new Date('2026-10-20T07:00:00Z'),
        t42: new Date('2026-12-01T08:00:00Z'),
        t72: new Date('2026-12-31T08:00:00Z'),
        t90: new Date('2027-01-18T08:00:00Z'),
      };
      await db.upd('pub_experiments', e, t);
      await db.rejects(
        async () =>
          db.upd('pub_experiments', e, {
            ...t,
            t0: new Date('2026-10-21T07:00:00Z'),
          }),
        /один раз/,
      );
      await db.upd('pub_experiments', e, { status: 'running' });
      await db.rejects(async () => db.del('pub_experiments', e), /удаление/);
      await db.rejects(
        async () => db.experiment(w, { kind: 'change', t0Planned: new Date() }),
        /только у pilot/,
      );
    });

    it('pub_experiment_contents: материалы — только к registered; связи не удаляются', async () => {
      const e = await db.experiment(w);
      const link = await db.child('pub_experiment_contents', w, {
        experimentId: e,
        contentId: await db.article(w),
      });
      await db.rejects(
        async () => db.del('pub_experiment_contents', link),
        /неизменны/,
      );
      await db.upd('pub_experiments', e, { status: 'running' });
      await db.rejects(
        async () =>
          db.child('pub_experiment_contents', w, {
            experimentId: e,
            contentId: await db.article(w),
          }),
        /registered/,
      );
    });

    it('pub_reports: снимок неизменен целиком; наследник — с причиной', async () => {
      const r = {
        kind: 'weekly',
        periodStart: new Date('2026-10-20'),
        periodEnd: new Date('2026-10-27'),
        snapshotAt: new Date(),
        cohort: {},
        attributionModel: 'last_non_direct_30d',
        sources: {},
        metrics: {},
        costs: {},
        inputsHash: hex64(),
      };
      const id = await db.child('pub_reports', w, r);
      await db.rejects(
        async () => db.upd('pub_reports', id, { decision: 'Масштабировать' }),
        /append-only/,
      );
      await db.rejects(
        async () =>
          db.child('pub_reports', w, { ...r, supersedesReportId: id }),
        /причина/,
      );
      await db.child('pub_reports', w, {
        ...r,
        supersedesReportId: id,
        recomputeReason: 'late_decision',
      });
      // Р-PUB-Z2-4: второй наследник того же снимка — 23505 (частичный
      // уникальный индекс, вторая линия к advisory-lock сервиса).
      await db.fails('23505', async () =>
        db.child('pub_reports', w, {
          ...r,
          supersedesReportId: id,
          recomputeReason: 'decision',
          decision: 'Масштабувати',
        }),
      );
      await db.rejects(
        async () =>
          db.child('pub_reports', w, { ...r, attributionModel: 'first_click' }),
        /attributionModel/,
      );
    });

    it('pub_backups.blobPathEnc: только шифротекст версии keyVersion (аудит P3-8)', async () => {
      const bk = {
        kind: 'manual',
        sha256: hex64(),
        sizeBytes: 10,
        tableCounts: {},
        keyVersion: 'v1',
        rotationUntil: new Date(Date.now() + 90 * 86_400_000),
        status: 'ok',
      };
      for (const blobPathEnc of [
        'backups/acc/2026-10-20.tar.gz',
        'v1.backups/acc.tar',
        'v2.aGVsbG8.dGFn.Y2lwaGVy',
      ]) {
        await db.rejects(
          async () => db.child('pub_backups', w, { ...bk, blobPathEnc }),
          /blobPathEnc/,
        );
      }
      await db.child('pub_backups', w, {
        ...bk,
        blobPathEnc: 'v1.aGVsbG8.dGFn.Y2lwaGVy',
      });
    });

    it('pub_restores: цель — продукт kind=restored; pub_metric_imports — append-only', async () => {
      const b = await db.child('pub_backups', w, {
        kind: 'manual',
        blobPathEnc: 'v1.a.b.c',
        sha256: hex64(),
        sizeBytes: 10,
        tableCounts: {},
        keyVersion: 'v1',
        rotationUntil: new Date(Date.now() + 90 * 86_400_000),
        status: 'ok',
      });
      const sib = await db.sibling(w, { kind: 'test' });
      await db.rejects(
        async () =>
          db.child('pub_restores', w, {
            backupId: b,
            mode: 'apply_new_product',
            targetProductId: sib.productId,
            report: {},
            startedBy: M,
          }),
        /kind=restored/,
      );
      const restoredSite = await db.site(w.accountId);
      const restored = await db.product(w.accountId, restoredSite, {
        kind: 'restored',
        restoredFromBackupId: b,
      });
      await db.child('pub_restores', w, {
        backupId: b,
        mode: 'apply_new_product',
        targetProductId: restored,
        report: {},
        startedBy: M,
      });
      await db.rejects(
        async () => db.upd('pub_products', restored, { mode: 'test' }),
        /всегда closed/,
      );
      const mi = await db.child('pub_metric_imports', w, {
        source: 'manual',
        periodStart: new Date('2026-10-20'),
        periodEnd: new Date('2026-10-21'),
        payload: {},
        importedBy: M,
      });
      await db.rejects(
        async () => db.upd('pub_metric_imports', mi, { note: 'x' }),
        /append-only/,
      );
    });

    it('восстановление переносит историю: вставка restore:<id> минует проверки текущего состояния только при идущем восстановлении (аудит P1-2)', async () => {
      const b = await db.child('pub_backups', w, {
        kind: 'manual',
        blobPathEnc: 'v1.a.b.c',
        sha256: hex64(),
        sizeBytes: 10,
        tableCounts: {},
        keyVersion: 'v1',
        rotationUntil: new Date(Date.now() + 90 * 86_400_000),
        status: 'ok',
      });
      const siteId = await db.site(w.accountId);
      const rw: PubWorld = {
        accountId: w.accountId,
        siteId,
        productId: await db.product(w.accountId, siteId, {
          kind: 'restored',
          restoredFromBackupId: b,
        }),
      };
      const restoreId = await db.child('pub_restores', w, {
        backupId: b,
        mode: 'apply_new_product',
        targetProductId: rw.productId,
        report: {},
        startedBy: M,
      });
      const restored = { createdBy: `restore:${restoreId}` };
      const a = await db.article(rw);
      const v = await db.frozenVersion(rw, a);
      // Согласование в историческом статусе, связь замороженной версии,
      // боевая заявка в закрытый продукт kind=restored.
      await db.publishApproval(rw, v, { status: 'superseded', ...restored });
      await db.child('pub_version_sources', rw, {
        versionId: v,
        sourceId: await db.source(rw),
        ...restored,
      });
      await db.lead(rw, restored);
      // Не restore — тот же INSERT запрещён.
      await db.rejects(
        async () => db.publishApproval(rw, v, { status: 'superseded' }),
        /создаётся active/,
      );
      // Поддельный restore:<id> — нет такого восстановления.
      await db.rejects(
        async () =>
          db.publishApproval(rw, v, {
            status: 'superseded',
            createdBy: 'restore:fake',
          }),
        /создаётся active/,
      );
      await db.rejects(
        async () => db.lead(rw, { createdBy: 'restore:fake' }),
        /только тестовые|не принимает/,
      );
      // Настоящий id, но строка не в целевой продукт восстановления.
      const av = await db.article(w);
      const vw = await db.frozenVersion(w, av);
      await db.rejects(
        async () =>
          db.publishApproval(w, vw, { status: 'superseded', ...restored }),
        /создаётся active/,
      );
      await db.rejects(async () => db.lead(w, restored), /не принимает/);
      // Восстановление завершено — обход закрыт.
      await db.upd('pub_restores', restoreId, { status: 'done' });
      await db.rejects(
        async () =>
          db.publishApproval(rw, v, { status: 'superseded', ...restored }),
        /создаётся active/,
      );
    });
  });

  describe('AI (6.7)', () => {
    async function evalWorld() {
      const ev = await db.sibling(w, { kind: 'eval' });
      const cfg = await db.child('pub_ai_configs', ev, {
        provider: 'GEMINI',
        model: 'gemini-2.5-flash',
        contextRulesVersion: 'ctx@1',
        schemaSetVersion: 's@1',
        instructionVersions: { 'pub.brief.draft': 'pub.brief.draft@1' },
        configHash: hex64(),
        coveredGenerators: [
          'pub.helper.answer',
          'pub.brief.draft',
          'pub.qa.review',
          'pub.adaptation.make',
        ],
      });
      return { ev, cfg };
    }
    async function results(
      ev: PubWorld,
      runId: string,
      critical: number,
      useful: number,
    ) {
      for (let i = 1; i <= 30; i++) {
        await db.child('pub_ai_eval_results', ev, {
          runId,
          taskCode: `AI-${String(i).padStart(2, '0')}`,
          schema: 'answer',
          input: {},
          allowedSourceIds: [],
          // Р-PUB-B2-14: допуск считается по ПЕРВОМУ ответу модели —
          // строка без `firstAnswerRaw` ответом не считается.
          firstAnswerRaw: '{"answer":"x"}',
          autoHardFail: [],
          autoFlags: [],
          flagResolutions: [],
          criticalPass: i <= critical,
          usefulnessPass: i <= useful,
          explanation: 'Оценено',
          reviewerMemberId: 'm1',
        });
      }
    }

    it('pub_ai_configs: только в eval-продукте; passed — только по live-прогону с N оценками набора (2.2: critical 30, useful ≥ 24)', async () => {
      await db.rejects(
        async () =>
          db.child('pub_ai_configs', w, {
            provider: 'GEMINI',
            model: 'm',
            contextRulesVersion: 'ctx@1',
            schemaSetVersion: 's@1',
            instructionVersions: {},
            configHash: hex64(),
            coveredGenerators: [],
          }),
        /kind=eval/,
      );
      const { ev, cfg } = await evalWorld();
      const decided = {
        evalStatus: 'passed',
        decidedBy: M,
        decidedAt: new Date(),
        basis: 'Протокол прогона live принят',
      };
      const fake = await db.child('pub_ai_eval_runs', ev, {
        configId: cfg,
        mode: 'fake',
      });
      await results(ev, fake, 30, 30);
      await db.rejects(
        async () =>
          db.upd('pub_ai_configs', cfg, { ...decided, evalRunId: fake }),
        /mode=live/,
      );
      const live = await db.child('pub_ai_eval_runs', ev, {
        configId: cfg,
        mode: 'live',
      });
      await results(ev, live, 29, 30);
      await db.rejects(
        async () =>
          db.upd('pub_ai_configs', cfg, { ...decided, evalRunId: live }),
        /criticalPass у всех/,
      );
      const live2 = await db.child('pub_ai_eval_runs', ev, {
        configId: cfg,
        mode: 'live',
      });
      await results(ev, live2, 30, 23);
      await db.rejects(
        async () =>
          db.upd('pub_ai_configs', cfg, { ...decided, evalRunId: live2 }),
        /usefulnessPass ≥ ⌈0,8·N⌉/,
      );
      const live3 = await db.child('pub_ai_eval_runs', ev, {
        configId: cfg,
        mode: 'live',
      });
      await results(ev, live3, 30, 24);
      // Р-PUB-Z2-1 (сверка с P-B2 S1-1/S2-3): повтор с жёстким провалом
      // блокирует допуск, даже если первый ответ задачи хороший.
      const [first30] = await db.q<{ id: string }>(
        `SELECT "id" FROM "sites"."pub_ai_eval_results"
          WHERE "runId" = $1 AND "taskCode" = 'AI-30'`,
        [live3],
      );
      const badRetry = await db.child('pub_ai_eval_results', ev, {
        runId: live3,
        taskCode: 'AI-30',
        schema: 'answer',
        input: {},
        allowedSourceIds: [],
        firstAnswerRaw: '{"answer":"y"}',
        autoHardFail: [{ code: 'canary_s7' }],
        autoFlags: [],
        flagResolutions: [],
        retryOfResultId: first30.id,
      });
      await db.rejects(
        async () =>
          db.upd('pub_ai_configs', cfg, { ...decided, evalRunId: live3 }),
        /criticalPass у всех строк/,
      );
      // criticalPass=true при жёстком автопровале невозможен и в обход сервиса.
      await db.rejects(
        async () =>
          db.upd('pub_ai_eval_results', badRetry, {
            criticalPass: true,
            usefulnessPass: true,
            explanation: 'Оценено',
            reviewerMemberId: 'm1',
          }),
        /жёстком автопровале/,
      );
      const live4 = await db.child('pub_ai_eval_runs', ev, {
        configId: cfg,
        mode: 'live',
      });
      await results(ev, live4, 30, 24);
      // P-B2 S2-3: прогон live у fake-конфигурации невозможен в обход сервиса.
      const fakeCfg = await db.child('pub_ai_configs', ev, {
        provider: 'fake',
        model: 'fake',
        contextRulesVersion: 'ctx@1',
        schemaSetVersion: 's@1',
        instructionVersions: {},
        configHash: hex64(),
        coveredGenerators: [],
      });
      await db.rejects(
        async () =>
          db.child('pub_ai_eval_runs', ev, { configId: fakeCfg, mode: 'live' }),
        /не у fake-конфигурации/,
      );
      // Строка без ответа модели (таймаут без расхода, `no_answer:*`) не
      // блокирует и не считается (предаудит D2-01).
      await db.child('pub_ai_eval_results', ev, {
        runId: live4,
        taskCode: 'AI-01',
        schema: 'answer',
        input: {},
        allowedSourceIds: [],
        autoHardFail: [{ code: 'no_answer:timeout' }],
        autoFlags: [],
        flagResolutions: [],
      });
      // …а оплаченный обрезанный ответ без текста — ответ и провал
      // (предаудит D2-01): прогон live5 с такой строкой допуска не даёт.
      const live5 = await db.child('pub_ai_eval_runs', ev, {
        configId: cfg,
        mode: 'live',
      });
      await results(ev, live5, 30, 30);
      await db.child('pub_ai_eval_results', ev, {
        runId: live5,
        taskCode: 'AI-02',
        schema: 'answer',
        input: {},
        allowedSourceIds: [],
        autoHardFail: [{ code: 'answer_truncated' }],
        autoFlags: [],
        flagResolutions: [],
        costStatus: 'priced',
        costMicroUsd: 6300n,
        // позже первого (хорошего) ответа AI-02: блокирует как провал повтора
        createdAt: new Date(Date.now() + 60_000),
        criticalPass: false,
        usefulnessPass: false,
        explanation: 'Обрезан',
        reviewerMemberId: 'm1',
      });
      await db.rejects(
        async () =>
          db.upd('pub_ai_configs', cfg, { ...decided, evalRunId: live5 }),
        /criticalPass у всех строк/,
      );
      // «нет ответа» с расходом — подделка, отказ БД
      await db.rejects(
        async () =>
          db.child('pub_ai_eval_results', ev, {
            runId: live5,
            taskCode: 'AI-03',
            schema: 'answer',
            input: {},
            allowedSourceIds: [],
            autoHardFail: [{ code: 'no_answer:timeout' }],
            autoFlags: [],
            flagResolutions: [],
            costStatus: 'priced',
            costMicroUsd: 6300n,
          }),
        /«нет ответа»/,
      );
      await db.upd('pub_ai_configs', cfg, { ...decided, evalRunId: live4 });
      await db.rejects(
        async () => db.upd('pub_ai_configs', cfg, { model: 'другая' }),
        /новая конфигурация/,
      );
      // Аудит P3-13: оценки принятого прогона неизменны, новых строк нет.
      const [graded] = await db.q<{ id: string }>(
        `SELECT "id" FROM "sites"."pub_ai_eval_results"
          WHERE "runId" = $1 AND "taskCode" = 'AI-30'`,
        [live4],
      );
      await db.rejects(
        async () =>
          db.upd('pub_ai_eval_results', graded.id, { usefulnessPass: true }),
        /passed/,
      );
      await db.rejects(
        async () =>
          db.child('pub_ai_eval_results', ev, {
            runId: live4,
            taskCode: 'AI-30',
            schema: 'answer',
            input: {},
            allowedSourceIds: [],
            autoHardFail: [],
            autoFlags: [],
            flagResolutions: [],
            retryOfResultId: graded.id,
          }),
        /passed/,
      );
      await db.rejects(
        async () => db.del('pub_ai_eval_results', graded.id),
        /append-only/,
      );
    });

    it('pub_ai_eval_results: первый ответ и флаги неизменны; оценка — с проверяющим и объяснением', async () => {
      const { ev, cfg } = await evalWorld();
      const run = await db.child('pub_ai_eval_runs', ev, {
        configId: cfg,
        mode: 'fake',
      });
      const r = await db.child('pub_ai_eval_results', ev, {
        runId: run,
        taskCode: 'AI-01',
        schema: 'answer',
        input: {},
        allowedSourceIds: [],
        firstAnswer: { answer: 'x' },
        autoHardFail: [],
        autoFlags: ['guarantee'],
        flagResolutions: [],
      });
      await db.rejects(
        async () =>
          db.upd('pub_ai_eval_results', r, { firstAnswer: { answer: 'y' } }),
        /append-only/,
      );
      await db.rejects(
        async () => db.upd('pub_ai_eval_results', r, { autoFlags: [] }),
        /append-only/,
      );
      // Аудит P3-13: оценка — только после разбора каждого флага.
      await db.rejects(
        async () =>
          db.upd('pub_ai_eval_results', r, {
            criticalPass: true,
            usefulnessPass: true,
            reviewerMemberId: 'm1',
            explanation: 'Оценено',
          }),
        /flagResolutions ≥ autoFlags/,
      );
      await db.rejects(
        async () =>
          db.upd('pub_ai_eval_results', r, {
            criticalPass: true,
            usefulnessPass: true,
            flagResolutions: [{ flag: 'guarantee', by: 'm1' }],
          }),
        /reviewerMemberId/,
      );
      await db.upd('pub_ai_eval_results', r, {
        criticalPass: true,
        usefulnessPass: true,
        reviewerMemberId: 'm1',
        explanation: 'Флаг снят: ответ «без гарантій»',
        flagResolutions: [{ flag: 'guarantee', by: 'm1' }],
      });
      await db.rejects(
        async () =>
          db.child('pub_ai_eval_results', ev, {
            runId: run,
            taskCode: 'AI-31',
            schema: 'answer',
            input: {},
            allowedSourceIds: [],
            autoHardFail: [],
            autoFlags: [],
            flagResolutions: [],
          }),
        /taskCode/,
      );
    });

    it('pub_ai_config_bindings: только у рабочего продукта, одна действующая', async () => {
      const { ev, cfg } = await evalWorld();
      await db.rejects(
        async () =>
          db.child('pub_ai_config_bindings', ev, {
            configId: cfg,
            boundBy: M,
            basis: 'Проверка',
          }),
        /kind=working/,
      );
      const b = await db.child('pub_ai_config_bindings', w, {
        configId: cfg,
        boundBy: M,
        basis: 'Применение конфигурации',
      });
      await db.fails('23505', async () =>
        db.child('pub_ai_config_bindings', w, {
          configId: cfg,
          boundBy: M,
          basis: 'Ещё раз',
        }),
      );
      await db.rejects(
        async () =>
          db.upd('pub_ai_config_bindings', b, { basis: 'Другое основание' }),
        /append-only/,
      );
      await db.upd('pub_ai_config_bindings', b, {
        unboundAt: new Date(),
        unboundBy: M,
      });
      await db.child('pub_ai_config_bindings', w, {
        configId: cfg,
        boundBy: M,
        basis: 'Новая привязка',
      });
    });

    it('pub_ai_tasks: генераций не больше 2 + разрешённых; сверх — только по согласованию', async () => {
      const t = await db.aiTask(w, { generationsUsed: 2 });
      await db.rejects(
        async () => db.upd('pub_ai_tasks', t, { generationsUsed: 3 }),
        /2 \+ extraAllowance/,
      );
      await db.rejects(
        async () =>
          db.upd('pub_ai_tasks', t, { generationsUsed: 3, extraAllowance: 1 }),
        /ai_extra_generation/,
      );
      const ap = await db.child('pub_approvals', w, {
        type: 'ai_extra_generation',
        objectType: 'ai_task',
        objectId: t,
        approverMemberId: 'm1',
        approverDisplayName: 'Ред',
      });
      await db.upd('pub_ai_tasks', t, {
        generationsUsed: 3,
        extraAllowance: 1,
        extraApprovalId: ap,
      });
      await db.rejects(
        async () => db.aiTask(w, { generator: 'pub.payments.do' }),
        /generator/,
      );
    });

    it('pub_ai_calls: источники — только этого продукта; неизвестная цена — не ноль; завершённый вызов неизменен', async () => {
      const sib = await db.sibling(w, { kind: 'test' });
      await db.rejects(
        async () => db.aiCall(w, { sourceIds: [await db.source(sib)] }),
        /источников этого продукта/,
      );
      await db.rejects(
        async () => db.aiCall(w, { sourceIds: ['nope'] }),
        /источников этого продукта/,
      );
      const c = await db.aiCall(w, { sourceIds: [await db.source(w)] });
      await db.rejects(
        async () => db.upd('pub_ai_calls', c, { status: 'ok' }),
        /finishedAt/,
      );
      await db.rejects(
        async () =>
          db.upd('pub_ai_calls', c, {
            status: 'ok',
            finishedAt: new Date(),
            costStatus: 'priced',
          }),
        /costMicroUsd/,
      );
      await db.upd('pub_ai_calls', c, {
        status: 'ok',
        finishedAt: new Date(),
        costStatus: 'unpriced',
        inputTokens: 100,
        output: { brief: 1 },
      });
      await db.rejects(
        async () => db.upd('pub_ai_calls', c, { status: 'timeout' }),
        /завершённый/,
      );
      await db.rejects(
        async () => db.upd('pub_ai_calls', c, { model: 'другая' }),
        /append-only/,
      );
      await db.rejects(
        async () => db.aiCall(w, { requestedBy: 'system:cron' }),
        /system:eval/,
      );
    });

    it('pub_ai_budget_months: формат месяца, суммы ≥ 0', async () => {
      await db.rejects(
        async () =>
          db.child('pub_ai_budget_months', w, {
            month: '2026-13',
            capMicroUsd: 1,
          }),
        /YYYY-MM/,
      );
      await db.child('pub_ai_budget_months', w, {
        month: '2026-10',
        capMicroUsd: 5_000_000,
      });
      await db.rejects(
        async () =>
          db.child('pub_ai_budget_months', w, {
            month: '2026-11',
            capMicroUsd: -1,
          }),
        /≥ 0/,
      );
    });
  });
}
