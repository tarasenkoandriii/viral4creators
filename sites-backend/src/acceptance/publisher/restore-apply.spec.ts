/**
 * AI Publisher — приёмка P-E: восстановление экспорта (AT-CORE-20,
 * проектный документ §15.4; часть AT-CORE-09 — удалённый контакт не
 * возвращается). TD-10 (`reports/testing/td10.testing.ts`): копия → после
 * копии удалён контакт заявки и отозван источник → dry-run → apply в новый
 * продукт `restored` на тестовом сайте того же кабинета.
 */
import { ciDescribe, testPrisma } from '../../prisma/ci-describe.testing';
import { PubDb, connectOwner } from '../../prisma/publisher-schema.testing';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  contactMatchHash,
  openContact,
  openNote,
  sealNote,
} from '../../modules/publisher/core/contact-crypto';
import { PubError } from '../../modules/publisher/core/errors';
import type { PubPorts } from '../../modules/publisher/core/ports';
import { BackupService } from '../../modules/publisher/reports/backup.service';
import { IntegrationsStalenessJob } from '../../modules/publisher/reports/integrations.service';
import {
  BackupWeeklyJob,
  ReportStalenessJob,
} from '../../modules/publisher/reports/report-jobs';
import { ReportsService } from '../../modules/publisher/reports/reports.service';
import {
  RESTORE_GRANT_REVOKE_REASON,
  RestoreService,
} from '../../modules/publisher/reports/restore.service';
import {
  erasedRequestHash,
  LeadsService,
} from '../../modules/publisher/leads/leads.service';
import { leadsStack } from '../../modules/publisher/leads/testing/leads-fixtures.testing';
import type { CoreStack } from '../../modules/publisher/core/testing/core-stack.testing';
import { memberAccessIn } from '../../modules/publisher/core/product-access.service';
import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { asMember } from '../../modules/publisher/core/testing/core-stack.testing';
import { MemoryBackupStorage } from '../../modules/publisher/reports/testing/memory-backup-storage.testing';
import {
  TD10_SECRET,
  seedTd10,
  td10Keys,
  type Td10,
} from '../../modules/publisher/reports/testing/td10.testing';

const SAVED = process.env.ASSIST_SECRETS_KEY;

/** Порты, которые не должны вызываться (кроны не обрабатывают restored). */
const noPorts = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error('порт вызван — крон обработал restored-продукт');
    },
  },
) as unknown as PubPorts;

ciDescribe(
  '[AT-CORE-20] Восстановление экспорта: связи, версии, расходы; удаления и отзывы применены; внешние действия не повторены',
  () => {
    let prisma: PrismaService;
    let db: SitesDb;
    let owner: Awaited<ReturnType<typeof connectOwner>>;
    let raw: PubDb;
    let mem: MemoryBackupStorage;
    let backup: BackupService;
    let restore: RestoreService;
    let td: Td10;
    let backupId: string;
    let restoreId: string;
    let target: string;

    const product = () => ({ id: td.w.productId, accountId: td.w.accountId });
    const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
      raw.q<T>(sql, p);
    const count = async (table: string, productId: string) =>
      Number(
        (
          await q<{ n: string }>(
            `SELECT count(*) AS n FROM "sites"."${table}" WHERE "productId" = $1`,
            [productId],
          )
        )[0].n,
      );

    beforeAll(async () => {
      process.env.ASSIST_SECRETS_KEY = TD10_SECRET;
      prisma = testPrisma();
      db = new SitesDb(prisma);
      owner = await connectOwner();
      raw = new PubDb(owner);
      mem = new MemoryBackupStorage();
      backup = new BackupService(db, mem);
      restore = new RestoreService(db);
      td = await seedTd10(raw);
      // Копия.
      const prepared = await backup.prepare(product(), new Date());
      expect(prepared.status).toBe('ok');
      await db
        .forAccount(td.w.accountId)
        .$transaction((tx) =>
          backup.insertRow(
            tx,
            product(),
            prepared,
            'manual',
            'member:m1',
            new Date(),
          ),
        );
      backupId = prepared.id;
      // ПОСЛЕ копии: удалён контакт заявки 2 (P-D: DELETE + erasedAt + pub_erasures) и отозван источник.
      await q(`DELETE FROM "sites"."pub_lead_contacts" WHERE "leadId" = $1`, [
        td.ids.lead2,
      ]);
      await raw.upd('pub_leads', td.ids.lead2, { erasedAt: new Date() });
      await raw.child('pub_erasures', td.w, {
        leadId: td.ids.lead2,
        erasedBy: 'member:m1',
        basis: 'Запит заявника після копії',
        scope: { active: true, exports: true },
      });
      await raw.upd('pub_sources', td.ids.sourceToRevoke, {
        usage: 'revoked',
        revokedAt: new Date(),
        revokedBy: 'member:m1',
        revokeReason: 'Відкликано після копії',
      });
      await raw.child('pub_source_revocations', td.w, {
        sourceId: td.ids.sourceToRevoke,
        revokedBy: 'member:m1',
        reason: 'Відкликано після копії',
      });
    }, 120_000);

    afterAll(async () => {
      if (SAVED === undefined) delete process.env.ASSIST_SECRETS_KEY;
      else process.env.ASSIST_SECRETS_KEY = SAVED;
      await owner?.end();
      await prisma?.$disconnect();
    });

    it('копия: sha256 и счётчики; blob — только шифротекст, путь в базе — шифротекстом', async () => {
      const row = await prisma.pubBackup.findFirstOrThrow({
        where: { id: backupId },
      });
      expect(row.status).toBe('ok');
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.blobPathEnc).toMatch(/^v1\./);
      const counts = row.tableCounts as Record<string, number>;
      expect(counts.pub_lead_contacts).toBe(2);
      expect(counts.pub_lead_outbox).toBeUndefined(); // очередь не экспортируется
      expect(counts.pub_notifications).toBeUndefined();
      expect(counts.pub_idempotency_keys).toBeUndefined();
      const blob = [...mem.blobs.values()][0];
      expect(blob.includes(Buffer.from(td.contact1.contact))).toBe(false);
      expect(blob.includes(Buffer.from('publisher-backup'))).toBe(false);
      // Срок ротации = параметр retention_policy.backupRotationDays (30) — записан.
      expect(
        Math.round(
          (row.rotationUntil.getTime() - row.createdAt.getTime()) /
            3_600_000 /
            24,
        ),
      ).toBe(30);
    });

    it('dry-run: hash и расшифровка, связи без висячих, что будет подавлено и применено', async () => {
      const row = await prisma.pubBackup.findFirstOrThrow({
        where: { id: backupId },
      });
      const doc = await backup.load(row);
      const out = await db
        .forAccount(td.w.accountId)
        .$transaction(async (tx) => {
          const lists = await restore.currentLists(tx, product());
          const report = await restore.dryRunReport(doc, row, lists);
          return restore.recordDryRun(tx, product(), row, report, 'member:m1');
        });
      const report = out.restore.report as Record<string, unknown>;
      expect(out.restore).toMatchObject({
        mode: 'dry_run',
        status: 'done',
        targetProductId: null,
      });
      expect(report).toMatchObject({
        ok: true,
        countMismatch: [],
        links: { dangling: [] },
        encryptedLeadData: { total: 2, unreadable: 0 },
        wouldApply: { erasures: 2, leadRowsSuppressed: 1, revocations: 2 },
        suppressed: {
          leadOutbox: 'not_exported',
          notifications: 'not_exported',
          publications: 1,
          payments: 1,
        },
      });
      // Dry-run ничего не пишет: продукта на тестовом сайте нет.
      expect(
        await prisma.pubProduct.count({ where: { siteId: td.targetSiteId } }),
      ).toBe(0);
    });

    it('apply: новый продукт restored/closed на тестовом сайте того же кабинета, строка running до переноса, затем done', async () => {
      const row = await prisma.pubBackup.findFirstOrThrow({
        where: { id: backupId },
      });
      const doc = await backup.load(row);
      const started = await db
        .forAccount(td.w.accountId)
        .$transaction((tx) =>
          restore.start(
            tx,
            product(),
            row,
            td.targetSiteId,
            'member:m1',
            new Date(),
          ),
        );
      restoreId = started.restore.id;
      target = started.restore.targetProductId as string;
      expect(started.restore.status).toBe('running');
      const t0 = Date.now();
      const done = await restore.transfer(td.w.accountId, restoreId, doc);
      const ms = Date.now() - t0;
      expect(done.status).toBe('done');
      const p = await prisma.pubProduct.findFirstOrThrow({
        where: { id: target },
      });
      expect(p).toMatchObject({
        kind: 'restored',
        mode: 'closed',
        status: 'active',
        siteId: td.targetSiteId,
        restoredFromBackupId: backupId,
      });
      const report = done.report as {
        rows: number;
        timing: { msPerRow: number };
      };
      // eslint-disable-next-line no-console
      console.log(
        `restore TD-10: ${report.rows} строк за ${ms} мс (${report.timing.msPerRow} мс/строка)`,
      );
    }, 120_000);

    it('связи, версии и суммы сохранены: материал, версия со связями, публикация, закупка, обязательство, лимит', async () => {
      const r = (
        await prisma.pubRestore.findFirstOrThrow({ where: { id: restoreId } })
      ).report as Record<string, unknown>;
      const before = (
        r.counts as {
          before: Record<string, number>;
          after: Record<string, number>;
        }
      ).before;
      const after = (r.counts as { after: Record<string, number> }).after;
      for (const [t, n] of Object.entries(before)) {
        if (['pub_products', 'pub_backups', 'pub_restores'].includes(t))
          continue;
        const delta =
          t === 'pub_lead_contacts'
            ? -1
            : t === 'pub_erasures' || t === 'pub_source_revocations'
              ? 1
              : 0;
        expect([t, after[t]]).toEqual([t, n + delta]);
      }
      // Материал TD-10 находим по slug (в TD-10 есть и материал закупки).
      const srcC = await prisma.pubContent.findFirstOrThrow({
        where: { id: td.ids.content },
      });
      const c = await prisma.pubContent.findFirstOrThrow({
        where: { productId: target, slug: srcC.slug },
      });
      const v = await prisma.pubContentVersion.findFirstOrThrow({
        where: { productId: target, contentId: c.id },
      });
      const srcV = await prisma.pubContentVersion.findFirstOrThrow({
        where: { id: td.ids.version },
      });
      expect(c.currentVersionId).toBe(v.id); // обратная ссылка цикла — вторым проходом
      expect(c.publishedVersionId).toBe(v.id);
      expect(v.contentId).toBe(c.id);
      expect({
        title: v.title,
        body: v.body,
        hash: v.hash,
        frozenAt: v.frozenAt,
      }).toEqual({
        title: srcV.title,
        body: srcV.body,
        hash: srcV.hash,
        frozenAt: srcV.frozenAt,
      });
      expect(
        await prisma.pubVersionSource.count({
          where: { productId: target, versionId: v.id },
        }),
      ).toBe(2);
      const pub = await prisma.pubPublication.findFirstOrThrow({
        where: { productId: target },
      });
      expect(pub).toMatchObject({
        status: 'published',
        stage: 'live',
        versionId: v.id,
        createdBy: `restore:${restoreId}`,
      });
      const ex = await prisma.pubExpense.findFirstOrThrow({
        where: { productId: target },
      });
      expect([ex.amountTotalMinor, ex.paidMinor, ex.deliveredMinor]).toEqual([
        100_000n,
        100_000n,
        100_000n,
      ]);
      const pl = await prisma.pubPlacement.findFirstOrThrow({
        where: { productId: target, expenseId: { not: null } },
      });
      expect(pl.expenseId).toBe(ex.id);
      expect(r.budget).toMatchObject({
        countersEqual: true,
        recomputed: {
          netPaidMinor: '100000',
          openCommitMinor: '0',
          usedPlacementsMinor: '100000',
          usedToolsMinor: '0',
        },
      });
      // Самоссылки и материалы эксперимента.
      const reps = await prisma.pubReport.findMany({
        where: { productId: target },
      });
      const childRep = reps.find((x) => x.supersedesReportId);
      expect(reps.map((x) => x.id)).toContain(childRep?.supersedesReportId);
      expect(await count('pub_experiment_contents', target)).toBe(1);
      // «Сначала решения, потом головы»; предложение получило решение вторым проходом.
      const lang = await prisma.pubParameter.findFirstOrThrow({
        where: { productId: target, key: 'language' },
      });
      expect(lang).toMatchObject({ status: 'approved', version: 1 });
      const prop = await prisma.pubParameterProposal.findFirstOrThrow({
        where: { productId: target },
      });
      const dec = await prisma.pubParameterDecision.findFirstOrThrow({
        where: { productId: target, parameterKey: 'language' },
      });
      expect(prop.decisionId).toBe(dec.id);
      expect(dec.proposalId).toBe(prop.id);
      // Мягкие ссылки (журнал, задача, AI) — на НОВЫЕ id.
      const audit = await prisma.pubAuditEvent.findFirstOrThrow({
        where: { productId: target, objectType: 'content' },
      });
      expect(audit.objectId).toBe(c.id);
      const task = await prisma.pubReviewTask.findFirstOrThrow({
        where: { productId: target },
      });
      expect([task.objectId, task.triggerRef]).toEqual([c.id, `td10:${c.id}`]);
      const call = await prisma.pubAiCall.findFirstOrThrow({
        where: { productId: target },
      });
      const allowed = await prisma.pubSource.findFirstOrThrow({
        where: { productId: target, url: 'https://src.example/a' },
      });
      expect(call.sourceIds).toEqual([allowed.id]);
    });

    it('удалённый после копии контакт не вернулся; живой контакт перешифрован под новый AAD и matchHash нового продукта', async () => {
      const keys = td10Keys();
      const leads = await prisma.pubLead.findMany({
        where: { productId: target },
        orderBy: { createdAt: 'asc' },
      });
      expect(leads).toHaveLength(3);
      const contacts = await prisma.pubLeadContact.findMany({
        where: { productId: target },
      });
      expect(contacts).toHaveLength(1); // lead2 удалён после копии, lead3 — до неё
      const c = contacts[0];
      const opened = openContact(c.contactEnc, c.leadId, keys.contact);
      expect(opened?.value).toEqual(td.contact1);
      expect(c.matchHash).toBe(
        contactMatchHash(target, 'email', td.contact1.contact, keys.match),
      );
      // Старый AAD (id исходной заявки) шифротекст не открывает — подложить нельзя.
      expect(openContact(c.contactEnc, td.ids.lead1, keys.contact)).toBeNull();
      const erased = leads.filter((l) => l.erasedAt);
      expect(erased).toHaveLength(2);
      // requestHash удалённых — обезличенный от НОВОГО id (правило P-D S3-9).
      for (const l of erased)
        expect(l.requestHash).toBe(erasedRequestHash(l.id));
      expect(await count('pub_erasures', target)).toBe(2);
      // Публичные номера заявок — новые (глобально уникальны).
      const srcRefs = (
        await prisma.pubLead.findMany({
          where: { productId: td.w.productId },
          select: { publicRef: true },
        })
      ).map((x) => x.publicRef);
      for (const l of leads) expect(srcRefs).not.toContain(l.publicRef);
      // Заметки — под новый id строки.
      const pros = await prisma.pubProspect.findFirstOrThrow({
        where: { productId: target },
      });
      expect(openNote(pros.noteEnc, pros.id, keys.notes)?.value).toBe(
        'Нотатка про проспект',
      );
      const dec = await prisma.pubLeadDecision.findFirstOrThrow({
        where: { productId: target },
      });
      expect(openNote(dec.noteEnc, dec.id, keys.notes)?.value).toBe(
        'Підтвердив інтерес',
      );
    });

    it('отозванный после копии источник не вернулся в активный контур', async () => {
      const srcs = await prisma.pubSource.findMany({
        where: { productId: target },
        orderBy: { url: 'asc' },
      });
      expect(srcs.map((s) => [s.url, s.usage])).toEqual([
        ['https://src.example/a', 'allowed'],
        ['https://src.example/b', 'revoked'],
        ['https://src.example/c', 'revoked'],
      ]);
      expect(await count('pub_source_revocations', target)).toBe(2);
      const r = (
        await prisma.pubRestore.findFirstOrThrow({ where: { id: restoreId } })
      ).report as Record<string, unknown>;
      expect(r.applied).toEqual({
        erasures: 2,
        leadRowsSuppressed: 1,
        decisionNotesCleared: 0,
        // lead2 без проспекта; у проспекта lead1 заявка жива — заметка остаётся.
        prospectNotesCleared: 0,
        // lead2 (после копии) и lead3 (до копии): обезличенный хеш нового id.
        requestHashesErased: 2,
        roleGrantsRevoked: 0,
        revocations: 2,
        sourcesMarkedRevoked: 1,
        claimsNeedsReview: 1,
        // Каскад P-R (реаудит P-R N-5): в TD-10 нет снимков правил Reddit.
        redditOpportunitiesRecheck: 0,
      });
    });

    it('Р-PUB-Z2-23: источник подтверждал критический claim и отозван после копии — перенос не падает, claim в restored — needs_review (как штатный отзыв)', async () => {
      const src = await prisma.pubClaim.findFirstOrThrow({
        where: { id: td.ids.claimCritical },
      });
      expect(src.status).toBe('supported');
      const claims = await prisma.pubClaim.findMany({
        where: { productId: target, statement: src.statement },
      });
      expect(claims.map((c) => [c.status, c.risk])).toEqual([
        ['needs_review', 'critical'],
      ]);
      expect(claims[0].revision).toBe(src.revision + 1);
      const links = await prisma.pubClaimSource.findMany({
        where: { productId: target, claimId: claims[0].id },
        include: { source: { select: { url: true, usage: true } } },
      });
      expect(
        links.map((l) => [l.source.url, l.source.usage, l.supports]),
      ).toEqual([['https://src.example/b', 'revoked', 'yes']]);
    });

    it('внешние действия не повторены: нет исходящей очереди и уведомлений; история — restore:<id>; кроны не трогают restored', async () => {
      expect(await count('pub_lead_outbox', target)).toBe(0);
      expect(await count('pub_notifications', target)).toBe(0);
      for (const t of [
        'pub_publications',
        'pub_payments',
        'pub_expense_entries',
        'pub_leads',
      ]) {
        const rows = await q<{ createdBy: string }>(
          `SELECT DISTINCT "createdBy" FROM "sites"."${t}" WHERE "productId" = $1`,
          [target],
        );
        expect([t, rows.map((x) => x.createdBy)]).toEqual([
          t,
          [`restore:${restoreId}`],
        ]);
      }
      // Обход проверок закрыт: восстановление `done` — вставка restore:<id> проверяется как обычная.
      await expect(
        raw.lead(
          {
            accountId: td.w.accountId,
            siteId: td.targetSiteId,
            productId: target,
          },
          { createdBy: `restore:${restoreId}` },
        ),
      ).rejects.toMatchObject({ code: '23514' });
      // Кроны: интеграция restored «connected» без свежей синхронизации остаётся как есть; копия restored не делается.
      const scope = { siteIds: [td.targetSiteId] };
      const monday = new Date('2026-10-19T05:00:00Z');
      const deadline = new Date(Date.now() + 30_000);
      const job = new IntegrationsStalenessJob(db, noPorts);
      expect(await job.run({ now: new Date(), scope, deadline })).toMatchObject(
        { processed: 0 },
      );
      const integ = await prisma.pubIntegration.findFirstOrThrow({
        where: { productId: target },
      });
      expect(integ.status).toBe('connected');
      const weekly = new BackupWeeklyJob(db, backup, noPorts);
      expect(await weekly.run({ now: monday, scope, deadline })).toMatchObject({
        processed: 0,
      });
      const stale = new ReportStalenessJob(db, new ReportsService(), noPorts);
      expect(
        await stale.run({ now: new Date(), scope, deadline }),
      ).toMatchObject({ processed: 0 });
      expect(await count('pub_backups', target)).toBe(0);
    });

    it('повторный apply на занятый сайт — PUB_PRODUCT_EXISTS; параллельный running — PUB_RESTORE_CONFLICT; порча копии — PUB_RESTORE_CONFLICT', async () => {
      const row = await prisma.pubBackup.findFirstOrThrow({
        where: { id: backupId },
      });
      await expect(
        db
          .forAccount(td.w.accountId)
          .$transaction((tx) =>
            restore.start(
              tx,
              product(),
              row,
              td.targetSiteId,
              'member:m1',
              new Date(),
            ),
          ),
      ).rejects.toMatchObject({ code: 'PUB_PRODUCT_EXISTS' });
      // Порча blob → sha256 не совпал.
      const [path, bytes] = [...mem.blobs.entries()][0];
      const bad = Buffer.from(bytes);
      bad[bad.length - 1] ^= 0xff;
      mem.blobs.set(path, bad);
      await expect(backup.load(row)).rejects.toMatchObject({
        code: 'PUB_RESTORE_CONFLICT',
        details: { reason: 'sha256_mismatch' },
      });
      mem.blobs.set(path, bytes);
      // Идёт другое восстановление этого источника.
      const site2 = await raw.site(td.w.accountId);
      const s1 = await db
        .forAccount(td.w.accountId)
        .$transaction((tx) =>
          restore.start(tx, product(), row, site2, 'member:m1', new Date()),
        );
      const site3 = await raw.site(td.w.accountId);
      const err = await db
        .forAccount(td.w.accountId)
        .$transaction((tx) =>
          restore.start(tx, product(), row, site3, 'member:m1', new Date()),
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PubError);
      expect(err).toMatchObject({
        code: 'PUB_RESTORE_CONFLICT',
        details: { reason: 'running', restoreId: s1.restore.id },
      });
      // Сбой переноса (порченая копия с висячей ссылкой) — failed, продукт archived, строк нет.
      const doc = await backup.load(row);
      doc.tables.pub_content_versions = doc.tables.pub_content_versions.map(
        (x) => ({ ...x, contentId: 'missing_content_id' }),
      );
      await expect(
        restore.transfer(td.w.accountId, s1.restore.id, doc),
      ).rejects.toMatchObject({ code: 'PUB_RESTORE_CONFLICT' });
      const failed = await prisma.pubRestore.findFirstOrThrow({
        where: { id: s1.restore.id },
      });
      expect(failed.status).toBe('failed');
      const tp = await prisma.pubProduct.findFirstOrThrow({
        where: { id: s1.restore.targetProductId as string },
      });
      expect(tp.status).toBe('archived');
      expect(await count('pub_parameters', tp.id)).toBe(0);
    }, 120_000);
  },
);

ciDescribe(
  '[AT-CORE-20] Восстановление после штатного стирания P-D (LeadsService.erase) и отзыва роли: стёртое и отозванное не возвращаются',
  () => {
    let st: CoreStack;
    let owner: Awaited<ReturnType<typeof connectOwner>>;
    let raw: PubDb;
    let backup: BackupService;
    let restore: RestoreService;
    let td: Td10;
    let memberId: string;
    let restoreId: string;
    let target: string;
    let doc: Awaited<ReturnType<BackupService['load']>>;
    let origHash: string;

    beforeAll(async () => {
      process.env.ASSIST_SECRETS_KEY = TD10_SECRET;
      st = await leadsStack({ http: true });
      owner = await connectOwner();
      raw = new PubDb(owner);
      const db = st.db;
      backup = new BackupService(db, new MemoryBackupStorage());
      restore = new RestoreService(db);
      td = await seedTd10(raw);
      const product = { id: td.w.productId, accountId: td.w.accountId };
      // Участник кабинета (не владелец) с ролью sales на продукте.
      const m = await st.prisma.siteAccountMember.create({
        data: {
          accountId: td.w.accountId,
          telegramId: BigInt(`7${randomBytes(4).readUInt32BE(0)}`),
          role: 'operator',
          productRoles: { publisher: 'member' },
        },
      });
      memberId = m.id;
      const grant = await raw.child('pub_role_grants', td.w, {
        memberId,
        memberDisplayName: 'Продавець',
        role: 'sales',
        grantedBy: 'member:m1',
        createdBy: 'member:m1',
      });
      const prepared = await backup.prepare(product, new Date());
      await db
        .forAccount(td.w.accountId)
        .$transaction((tx) =>
          backup.insertRow(
            tx,
            product,
            prepared,
            'manual',
            'member:m1',
            new Date(),
          ),
        );
      origHash = (
        await st.prisma.pubLead.findUniqueOrThrow({
          where: { id: td.ids.lead1 },
        })
      ).requestHash;
      // ПОСЛЕ копии: стирание lead1 НАСТОЯЩИМ путём P-D (контакт, заметка
      // решения, заметка проспекта — у него больше нет живых заявок,
      // обезличенный requestHash, pub_erasures со scope).
      const lead = await st.prisma.pubLead.findUniqueOrThrow({
        where: { id: td.ids.lead1 },
      });
      const pctx = {
        id: td.w.productId,
        accountId: td.w.accountId,
        siteId: td.w.siteId,
        kind: 'working' as const,
        mode: 'closed' as const,
        status: 'active' as const,
        revision: 1,
      };
      await db.forAccount(td.w.accountId).$transaction((tx) =>
        st.mod.get(LeadsService).erase(
          tx,
          pctx,
          td.ids.lead1,
          {
            basis: 'Запит заявника після копії',
            expectedRevision: lead.revision,
          },
          { actor: 'member:m1', now: new Date() },
        ),
      );
      const er = await st.prisma.pubErasure.findFirstOrThrow({
        where: { leadId: td.ids.lead1 },
      });
      expect(er.scope).toMatchObject({ prospectNote: true, decisionNotes: 1 });
      // ПОСЛЕ копии: роль отозвана.
      await raw.upd('pub_role_grants', grant, {
        revokedAt: new Date(),
        revokedBy: 'member:m1',
        reason: 'Звільнено',
      });
      const row = await st.prisma.pubBackup.findFirstOrThrow({
        where: { id: prepared.id },
      });
      doc = await backup.load(row);
      const started = await db
        .forAccount(td.w.accountId)
        .$transaction((tx) =>
          restore.start(
            tx,
            product,
            row,
            td.targetSiteId,
            'member:m1',
            new Date(),
          ),
        );
      restoreId = started.restore.id;
      target = started.restore.targetProductId as string;
      const done = await restore.transfer(td.w.accountId, restoreId, doc);
      expect(done.status).toBe('done');
    }, 180_000);

    afterAll(async () => {
      if (SAVED === undefined) delete process.env.ASSIST_SECRETS_KEY;
      else process.env.ASSIST_SECRETS_KEY = SAVED;
      await owner?.end();
      await st?.close();
    });

    it('заметка проспекта и заметка решения стёртой заявки не вернулись; requestHash — обезличенный нового id, исходного нет', async () => {
      const keys = td10Keys();
      const pros = await st.prisma.pubProspect.findFirstOrThrow({
        where: { productId: target },
      });
      expect(pros.noteEnc).toBeNull();
      expect(openNote(pros.noteEnc, pros.id, keys.notes)).toBeNull();
      const decs = await st.prisma.pubLeadDecision.findMany({
        where: { productId: target },
      });
      expect(decs.map((x) => x.noteEnc)).toEqual(decs.map(() => null));
      const leads = await st.prisma.pubLead.findMany({
        where: { productId: target },
      });
      expect(leads.some((l) => l.requestHash === origHash)).toBe(false);
      const erased = leads.filter((l) => l.erasedAt);
      expect(erased).toHaveLength(2); // lead1 (после копии), lead3 (до)
      for (const l of erased)
        expect(l.requestHash).toBe(erasedRequestHash(l.id));
      // Контакт lead1 не вернулся; жив только контакт lead2.
      const contacts = await st.prisma.pubLeadContact.findMany({
        where: { productId: target },
      });
      expect(contacts).toHaveLength(1);
      expect(
        openContact(contacts[0].contactEnc, contacts[0].leadId, keys.contact)
          ?.value.contact,
      ).toBe('second.td10@example.com');
      const report = (
        await st.prisma.pubRestore.findFirstOrThrow({
          where: { id: restoreId },
        })
      ).report as { applied: Record<string, number> };
      expect(report.applied).toMatchObject({
        erasures: 2,
        leadRowsSuppressed: 1, // контакт lead1 есть в копии — не перенесён
        decisionNotesCleared: 1,
        prospectNotesCleared: 1,
        requestHashesErased: 2,
        roleGrantsRevoked: 1,
      });
    });

    it('отозванная после копии роль не действует в восстановленном продукте: все гранты созданы отозванными (restore:<id>)', async () => {
      const grants = await st.prisma.pubRoleGrant.findMany({
        where: { productId: target },
      });
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        memberId,
        role: 'sales',
        revokedBy: `restore:${restoreId}`,
        reason: RESTORE_GRANT_REVOKE_REASON,
      });
      expect(grants[0].revokedAt).not.toBeNull();
      const access = await st.db
        .forAccount(td.w.accountId)
        .$transaction((tx) => memberAccessIn(tx, target, memberId));
      expect([...(access?.roles ?? [])]).toEqual([]);
    });

    it('Р-PUB-Z2-3: штатное стирание P-D — заметка проспекта стирается только вместе с последней живой заявкой (общее правило leadEraseEffect)', async () => {
      const keys = td10Keys();
      const pid = `pros_z2_${randomBytes(4).toString('hex')}`;
      await raw.prospect(td.w, {
        id: pid,
        noteEnc: sealNote('Нотатка Z2', pid, keys.notes).enc,
      });
      const a = await raw.lead(td.w, { status: 'new', prospectId: pid });
      const b = await raw.lead(td.w, { status: 'new', prospectId: pid });
      const pctx = {
        id: td.w.productId,
        accountId: td.w.accountId,
        siteId: td.w.siteId,
        kind: 'working' as const,
        mode: 'closed' as const,
        status: 'active' as const,
        revision: 1,
      };
      const erase = async (id: string) => {
        const l = await st.prisma.pubLead.findUniqueOrThrow({ where: { id } });
        await st.db
          .forAccount(td.w.accountId)
          .$transaction((tx) =>
            st.mod
              .get(LeadsService)
              .erase(
                tx,
                pctx,
                id,
                { basis: 'Запит заявника Z2', expectedRevision: l.revision },
                { actor: 'member:m1', now: new Date() },
              ),
          );
        return st.prisma.pubErasure.findFirstOrThrow({ where: { leadId: id } });
      };
      const note = async () =>
        (await st.prisma.pubProspect.findUniqueOrThrow({ where: { id: pid } }))
          .noteEnc;
      expect((await erase(a)).scope).toMatchObject({ prospectNote: false });
      expect(await note()).not.toBeNull();
      expect((await erase(b)).scope).toMatchObject({ prospectNote: true });
      expect(await note()).toBeNull();
    });

    it('Р-PUB-Z2-2: в restored раскрытие контакта и заметок закрыто всем, включая владельца кабинета (неявные роли); в исходном — открыто', async () => {
      const ownerM = await st.prisma.siteAccountMember.create({
        data: {
          accountId: td.w.accountId,
          telegramId: BigInt(`8${randomBytes(4).readUInt32BE(0)}`),
          role: 'owner',
          productRoles: { publisher: 'admin' },
        },
      });
      const srv = st.app!.getHttpServer();
      const get = (pid: string, leadId: string, what: 'contact' | 'notes') =>
        request(srv)
          .post(`/publisher/products/${pid}/leads/${leadId}/${what}`)
          .send(what === 'contact' ? { purpose: 'first_contact' } : {})
          .set(asMember(ownerM.telegramId, td.w.accountId));
      const alive = await st.prisma.pubLead.findFirstOrThrow({
        where: { productId: target, erasedAt: null },
      });
      const contactRow = await st.prisma.pubLeadContact.findFirst({
        where: { leadId: alive.id },
      });
      expect(contactRow).not.toBeNull();
      const auditBefore = await st.prisma.pubAuditEvent.count({
        where: { productId: target, action: 'reveal_contact' },
      });
      for (const what of ['contact', 'notes'] as const) {
        const r = await get(target, alive.id, what);
        expect(r.status).toBe(403);
        expect(r.body.error).toMatchObject({
          code: 'PUB_ROLE_REQUIRED',
          details: {
            action: 'lead.contact.reveal',
            reason: 'product_kind',
            kind: 'restored',
          },
        });
        expect(r.body.data).toBeUndefined();
      }
      // Гвард — до поиска заявки: несуществующая заявка тоже 403, а не 404
      // (нет оракула существования; вторая линия — в операции).
      const ghost = await get(target, 'rs_nope', 'contact');
      expect(ghost.status).toBe(403);
      expect(ghost.body.error.details.reason).toBe('product_kind');
      expect(
        await st.prisma.pubAuditEvent.count({
          where: { productId: target, action: 'reveal_contact' },
        }),
      ).toBe(auditBefore);
      // Контроль: тот же владелец в исходном (working) продукте — 200.
      const ok = await get(td.w.productId, td.ids.lead2, 'contact');
      expect(ok.status).toBe(200);
      expect(ok.body.data.leadId).toBe(td.ids.lead2);
    });

    it('повтор и параллельный перенос того же восстановления: успешный продукт не архивируется, ответ — done', async () => {
      const again = await restore.transfer(td.w.accountId, restoreId, doc);
      expect(again.status).toBe('done');
      const both = await Promise.all([
        restore.transfer(td.w.accountId, restoreId, doc),
        restore.transfer(td.w.accountId, restoreId, doc),
      ]);
      expect(both.map((r) => r.status)).toEqual(['done', 'done']);
      const p = await st.prisma.pubProduct.findFirstOrThrow({
        where: { id: target },
      });
      expect(p.status).toBe('active');
    });
  },
);

ciDescribe(
  '[AT-CORE-20] Восстановление: скорость массового переноса (замер P-A0 ~0,2 мс/строка на гвардах)',
  () => {
    const N = Number(process.env.PUB_RESTORE_BENCH_ROWS ?? 2000);
    let prisma: PrismaService;
    let owner: Awaited<ReturnType<typeof connectOwner>>;

    beforeAll(async () => {
      process.env.ASSIST_SECRETS_KEY = TD10_SECRET;
      prisma = testPrisma();
      owner = await connectOwner();
    });
    afterAll(async () => {
      if (SAVED === undefined) delete process.env.ASSIST_SECRETS_KEY;
      else process.env.ASSIST_SECRETS_KEY = SAVED;
      await owner?.end();
      await prisma?.$disconnect();
    });

    it(`TD-10 + ${N} сессий и ${N} событий: копия и перенос одной транзакцией, время на строку`, async () => {
      const db = new SitesDb(prisma);
      const raw = new PubDb(owner);
      const mem = new MemoryBackupStorage();
      const backup = new BackupService(db, mem);
      const restore = new RestoreService(db);
      const td = await seedTd10(raw, { extraEvents: N });
      const product = { id: td.w.productId, accountId: td.w.accountId };
      const t0 = Date.now();
      const prepared = await backup.prepare(product, new Date());
      const tExport = Date.now() - t0;
      await db
        .forAccount(product.accountId)
        .$transaction((tx) =>
          backup.insertRow(
            tx,
            product,
            prepared,
            'manual',
            'member:m1',
            new Date(),
          ),
        );
      const row = await prisma.pubBackup.findFirstOrThrow({
        where: { id: prepared.id },
      });
      const t1 = Date.now();
      const doc = await backup.load(row);
      const tLoad = Date.now() - t1;
      const s = await db
        .forAccount(product.accountId)
        .$transaction((tx) =>
          restore.start(
            tx,
            product,
            row,
            td.targetSiteId,
            'member:m1',
            new Date(),
          ),
        );
      const t2 = Date.now();
      const done = await restore.transfer(product.accountId, s.restore.id, doc);
      const tTransfer = Date.now() - t2;
      const r = done.report as {
        rows: number;
        timing: { msPerRow: number; deferredMs: number; slowest: unknown };
      };
      expect(done.status).toBe('done');
      expect(r.rows).toBeGreaterThanOrEqual(2 * N);
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          bench: 'restore',
          rows: r.rows,
          sizeBytes: Number(prepared.sizeBytes),
          exportAndSealMs: tExport,
          loadMs: tLoad,
          transferMs: tTransfer,
          msPerRow: Math.round((tTransfer / r.rows) * 1000) / 1000,
          slowest: r.timing.slowest,
        }),
      );
      // Не порог производительности CI, а защита от деградации на порядок.
      expect(tTransfer / r.rows).toBeLessThan(5);
    }, 600_000);
  },
);

ciDescribe(
  '[AT-CORE-20] Р-PUB-Z2-3: восстановление применяет правило проспекта стирания P-D и без отметки scope.prospectNote',
  () => {
    let prisma: PrismaService;
    let owner: Awaited<ReturnType<typeof connectOwner>>;

    beforeAll(async () => {
      process.env.ASSIST_SECRETS_KEY = TD10_SECRET;
      prisma = testPrisma();
      owner = await connectOwner();
    });
    afterAll(async () => {
      if (SAVED === undefined) delete process.env.ASSIST_SECRETS_KEY;
      else process.env.ASSIST_SECRETS_KEY = SAVED;
      await owner?.end();
      await prisma?.$disconnect();
    });

    it('после копии стёрта последняя живая заявка проспекта (scope без prospectNote) — заметка проспекта в restored пустая', async () => {
      const db = new SitesDb(prisma);
      const raw = new PubDb(owner);
      const backup = new BackupService(db, new MemoryBackupStorage());
      const restore = new RestoreService(db);
      const td = await seedTd10(raw);
      const product = { id: td.w.productId, accountId: td.w.accountId };
      const prepared = await backup.prepare(product, new Date());
      await db
        .forAccount(product.accountId)
        .$transaction((tx) =>
          backup.insertRow(
            tx,
            product,
            prepared,
            'manual',
            'member:m1',
            new Date(),
          ),
        );
      // ПОСЛЕ копии: lead1 (единственная заявка проспекта) стёрт без отметки
      // о заметке проспекта (запись стирания не знает этого эффекта).
      await raw.q(
        `DELETE FROM "sites"."pub_lead_contacts" WHERE "leadId" = $1`,
        [td.ids.lead1],
      );
      await raw.upd('pub_leads', td.ids.lead1, { erasedAt: new Date() });
      await raw.child('pub_erasures', td.w, {
        leadId: td.ids.lead1,
        erasedBy: 'member:m1',
        basis: 'Запит заявника після копії',
        scope: { active: true, exports: true },
      });
      const row = await prisma.pubBackup.findFirstOrThrow({
        where: { id: prepared.id },
      });
      const doc = await backup.load(row);
      const started = await db
        .forAccount(td.w.accountId)
        .$transaction((tx) =>
          restore.start(
            tx,
            product,
            row,
            td.targetSiteId,
            'member:m1',
            new Date(),
          ),
        );
      const done = await restore.transfer(
        td.w.accountId,
        started.restore.id,
        doc,
      );
      expect(done.status).toBe('done');
      const target = started.restore.targetProductId as string;
      const pros = await prisma.pubProspect.findFirstOrThrow({
        where: { productId: target },
      });
      expect(pros.noteEnc).toBeNull();
      expect(
        (done.report as { applied: { prospectNotesCleared: number } }).applied
          .prospectNotesCleared,
      ).toBe(1);
    }, 120_000);
  },
);
