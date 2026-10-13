/**
 * AI Publisher — задания кронов P-E (проектный документ §15.1):
 *  - `report-staleness` (daily) — решение по квалификации, оплата или смена
 *    идентификации ПОСЛЕ `snapshotAt` по заявке/проспекту когорты
 *    последнего снимка → снимок-наследник с причиной
 *    (`late_decision|late_payment|identity_change`) и задача аналитику
 *    `report_late_decision` (аудит P2-16, Р-PUB-23: вычисление по
 *    зафиксированному определению — не «решение по данным»);
 *    Тот же проход делает снимки вех пилота D42/D72/D90, которых ещё нет
 *    (`system:report-milestones`, аудит P-E S3-8), с задачей аналитику;
 *  - `placement-diagnostics` (daily) — диагностические снимки размещения
 *    +7 и +14 дней после фактической публикации (окно не закрывают);
 *  - `backup-weekly` (daily, по понедельникам Kyiv), `backup-post-purchase`
 *    (tick: после подтверждённой оплаты закупки), `backup-rotation` (daily:
 *    `rotationUntil < now` → blob удалён, строка `expired_deleted`).
 *
 * Обрабатываются только продукты `kind ∈ working|test`, `status=active`
 * (`restored`/`eval` — никогда). Каждое изменение — своей транзакцией
 * кабинета; бюджет прохода — `deadline`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { PubContribution } from '../core/contributions';
import { PubError } from '../core/errors';
import {
  addKyivCalendarDays,
  kyivDateOf,
  kyivDayStart,
  kyivParts,
} from '../core/kyiv-time';
import {
  PubPorts,
  type CronJob,
  type CronResult,
  type PubCronContext,
  type ProductRef,
} from '../core/ports';
import { BackupService, type BackupKind } from './backup.service';
import { ReportsService } from './reports.service';

const ACTIVE = Prisma.sql`p."kind" IN ('working', 'test') AND p."status" = 'active'`;
const scopeSql = (ctx: PubCronContext) =>
  ctx.scope
    ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
    : Prisma.empty;

@Injectable()
@PubContribution('cron-job')
export class ReportStalenessJob implements CronJob {
  readonly key = 'report-staleness';
  readonly schedule = 'daily' as const;

  constructor(
    private readonly db: SitesDb,
    private readonly reports: ReportsService,
    private readonly ports: PubPorts,
  ) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher report-staleness: последние снимки всех кабинетов',
    );
    const heads = await system.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        productId: string;
        late_decision: boolean;
        late_payment: boolean;
        identity_change: boolean;
      }>
    >`
      WITH h AS (
        SELECT r."id", r."accountId", r."productId", r."snapshotAt",
               ARRAY(SELECT jsonb_array_elements_text(COALESCE(r."metrics"->'membership'->'leadIds', '[]'::jsonb))) AS leads,
               ARRAY(SELECT jsonb_array_elements_text(COALESCE(r."metrics"->'membership'->'prospectIds', '[]'::jsonb))) AS prospects
          FROM "sites"."pub_reports" r
          JOIN "sites"."pub_products" p ON p."id" = r."productId"
         WHERE r."kind" IN ('weekly', 'd42', 'd72', 'd90', 'late_cohort') AND ${ACTIVE} ${scopeSql(ctx)}
           AND NOT EXISTS (SELECT 1 FROM "sites"."pub_reports" c WHERE c."supersedesReportId" = r."id")
      )
      , f AS (
      SELECT h."id", h."accountId", h."productId",
             EXISTS (SELECT 1 FROM "sites"."pub_lead_decisions" d
                      WHERE d."productId" = h."productId" AND d."decidedAt" > h."snapshotAt" AND d."leadId" = ANY(h.leads)) AS late_decision,
             EXISTS (SELECT 1 FROM "sites"."pub_payments" x
                      WHERE x."productId" = h."productId" AND x."status" IN ('confirmed', 'refunded')
                        AND x."confirmedAt" > h."snapshotAt"
                        AND (x."leadId" = ANY(h.leads) OR x."prospectId" = ANY(h.prospects))) AS late_payment,
             EXISTS (SELECT 1 FROM "sites"."pub_lead_prospect_links" l
                      WHERE l."productId" = h."productId" AND l."validFrom" > h."snapshotAt" AND l."leadId" = ANY(h.leads)) AS identity_change
        FROM h
      )
      -- Фильтр «есть поздние изменения» — ДО лимита (аудит P-E S3-2): головы
      -- без изменений не занимают места в проходе.
      SELECT * FROM f
       WHERE f.late_decision OR f.late_payment OR f.identity_change
       ORDER BY f."id"
       LIMIT 200`;
    let processed = 0;
    for (const h of heads) {
      if (!h.late_decision && !h.late_payment && !h.identity_change) continue;
      if (Date.now() > ctx.deadline.getTime()) break;
      const reason = h.late_decision
        ? 'late_decision'
        : h.late_payment
          ? 'late_payment'
          : 'identity_change';
      const product: ProductRef = { id: h.productId, accountId: h.accountId };
      const actor = 'system:report-staleness';
      await this.db
        .forAccount(h.accountId)
        .$transaction(
          async (tx) => {
            const prev = await this.reports.get(tx, product, h.id);
            if (await this.reports.isSuperseded(tx, product, prev.id)) return;
            const r = await this.reports.recompute(
              tx,
              product,
              prev,
              reason,
              actor,
              ctx.now,
            );
            for (const a of r.audit) {
              await this.ports.audit().write(tx, {
                ...a,
                accountId: h.accountId,
                productId: h.productId,
                actor,
                occurredAt: ctx.now,
              });
            }
            await this.ports.review().open(
              tx,
              product,
              [
                {
                  objectType: 'report',
                  objectId: r.row.id,
                  reason: 'report_late_decision',
                  triggerRef: prev.id,
                  severity: 'normal',
                },
              ],
              { actor },
            );
            processed++;
          },
          { maxWait: 5000, timeout: 30_000 },
        )
        .catch((e: unknown) => {
          // Параллельное решение/пересчёт успел раньше (цепочка под замком) —
          // наследник уже есть, проход продолжается.
          if (e instanceof PubError && e.code === 'PUB_CONFLICT') return;
          throw e;
        });
    }
    const milestones = await this.milestones(ctx);
    return {
      processed: processed + milestones,
      details: { successors: processed, heads: heads.length, milestones },
    };
  }

  /**
   * Снимки вех пилота D42/D72/D90 (ТЗ §15 «закрывающий снимок — в t72»,
   * аудит P-E S3-8): наступила веха версии пилота, а снимка этого вида у
   * продукта нет — система делает его сама (`system:report-milestones`,
   * версия пилота на t0) и ставит задачу аналитику (`other`,
   * `triggerRef=milestone:<вид>`) — оценить и записать решение.
   */
  private async milestones(ctx: PubCronContext): Promise<number> {
    const system = this.db.system(
      'крон publisher report-staleness: вехи пилота без снимка',
    );
    const due = await system.$queryRaw<
      Array<{ productId: string; accountId: string; kind: string }>
    >`
      SELECT DISTINCT e."productId", e."accountId", k.kind
        FROM "sites"."pub_experiments" e
        JOIN "sites"."pub_products" p ON p."id" = e."productId"
        CROSS JOIN LATERAL (VALUES ('d42', e."t42"), ('d72', e."t72"), ('d90', e."t90")) AS k(kind, at)
       WHERE e."key" = 'pilot' AND e."t0" IS NOT NULL AND k.at IS NOT NULL AND k.at <= ${ctx.now}
         AND ${ACTIVE} ${scopeSql(ctx)}
         AND NOT EXISTS (SELECT 1 FROM "sites"."pub_reports" r
                          WHERE r."productId" = e."productId" AND r."kind" = k.kind)
       ORDER BY e."productId", k.kind
       LIMIT 100`;
    let made = 0;
    const actor = 'system:report-milestones';
    for (const d of due) {
      if (Date.now() > ctx.deadline.getTime()) break;
      const product: ProductRef = { id: d.productId, accountId: d.accountId };
      await this.db.forAccount(d.accountId).$transaction(
        async (tx) => {
          // Повтор/параллельный проход: снимок уже есть — ничего.
          const exists = await tx.pubReport.findFirst({
            where: { productId: d.productId, kind: d.kind },
            select: { id: true },
          });
          if (exists) return;
          const r = await this.reports.create(
            tx,
            product,
            { kind: d.kind },
            actor,
            ctx.now,
          );
          for (const a of r.audit) {
            await this.ports.audit().write(tx, {
              ...a,
              accountId: d.accountId,
              productId: d.productId,
              actor,
              occurredAt: ctx.now,
            });
          }
          await this.ports.review().open(
            tx,
            product,
            [
              {
                objectType: 'report',
                objectId: r.row.id,
                reason: 'other',
                triggerRef: `milestone:${d.kind}`,
                severity: 'normal',
              },
            ],
            { actor },
          );
          made++;
        },
        { maxWait: 5000, timeout: 30_000 },
      );
    }
    return made;
  }
}

@Injectable()
@PubContribution('cron-job')
export class PlacementDiagnosticsJob implements CronJob {
  readonly key = 'placement-diagnostics';
  readonly schedule = 'daily' as const;
  static readonly OFFSETS = [7, 14] as const;

  constructor(
    private readonly db: SitesDb,
    private readonly reports: ReportsService,
    private readonly ports: PubPorts,
  ) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher placement-diagnostics: опубликованные размещения всех кабинетов',
    );
    const rows = await system.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        productId: string;
        publishedAt: Date;
      }>
    >`
      SELECT pl."id", pl."accountId", pl."productId", pl."publishedAt"
        FROM "sites"."pub_placements" pl
        JOIN "sites"."pub_products" p ON p."id" = pl."productId"
       WHERE pl."publishedAt" IS NOT NULL
         AND pl."publishedAt" <= ${ctx.now}::timestamptz - interval '6 days'
         AND ${ACTIVE} ${scopeSql(ctx)}
         -- Размещения, у которых все диагностические снимки уже есть, место
         -- в проходе не занимают (аудит P-E S3-2): фильтр — до лимита.
         AND (SELECT count(*) FROM "sites"."pub_reports" r
               WHERE r."productId" = pl."productId" AND r."kind" = 'ad_hoc'
                 AND r."createdBy" = 'system:placement-diagnostics'
                 AND r."cohort"->>'focusPlacementId' = pl."id") < ${PlacementDiagnosticsJob.OFFSETS.length}
       ORDER BY pl."publishedAt", pl."id"
       LIMIT 500`;
    let processed = 0;
    for (const pl of rows) {
      for (const offset of PlacementDiagnosticsJob.OFFSETS) {
        if (Date.now() > ctx.deadline.getTime())
          return { processed, details: { snapshots: processed } };
        const due = addKyivCalendarDays(pl.publishedAt, offset);
        if (due.getTime() > ctx.now.getTime()) continue;
        const product: ProductRef = {
          id: pl.productId,
          accountId: pl.accountId,
        };
        const actor = 'system:placement-diagnostics';
        await this.db.forAccount(pl.accountId).$transaction(
          async (tx) => {
            const exists = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "sites"."pub_reports"
               WHERE "productId" = ${pl.productId} AND "accountId" = ${pl.accountId} AND "kind" = 'ad_hoc'
                 AND "cohort"->>'focusPlacementId' = ${pl.id} AND "periodEnd" = ${due}
               LIMIT 1`;
            if (exists.length) return;
            const r = await this.reports.createFocused(
              tx,
              product,
              pl.id,
              pl.publishedAt,
              due,
              actor,
              ctx.now,
            );
            for (const a of r.audit) {
              await this.ports.audit().write(tx, {
                ...a,
                accountId: pl.accountId,
                productId: pl.productId,
                actor,
                occurredAt: ctx.now,
              });
            }
            processed++;
          },
          { maxWait: 5000, timeout: 30_000 },
        );
      }
    }
    return { processed, details: { snapshots: processed } };
  }
}

/** Общий проход копий: экспорт вне транзакции, строка и аудит — в транзакции. */
async function backupProducts(
  db: SitesDb,
  backup: BackupService,
  ports: PubPorts,
  ctx: PubCronContext,
  products: Array<{ id: string; accountId: string }>,
  kind: BackupKind,
  log: Logger,
): Promise<CronResult> {
  let ok = 0;
  let failed = 0;
  for (const p of products) {
    if (Date.now() > ctx.deadline.getTime()) break;
    const actor = `system:backup-${kind === 'weekly' ? 'weekly' : 'post-purchase'}`;
    const prepared = await backup.prepare(p, ctx.now);
    await db.forAccount(p.accountId).$transaction(async (tx) => {
      const r = await backup.insertRow(tx, p, prepared, kind, actor, ctx.now);
      for (const a of r.audit) {
        await ports.audit().write(tx, {
          ...a,
          accountId: p.accountId,
          productId: p.id,
          actor,
          occurredAt: ctx.now,
        });
      }
    });
    if (prepared.status === 'ok') ok++;
    else failed++;
  }
  if (failed)
    log.warn(`backup ${kind}: ${failed} копий не записаны в хранилище`);
  return { processed: ok, details: { ok, failed } };
}

@Injectable()
@PubContribution('cron-job')
export class BackupWeeklyJob implements CronJob {
  readonly key = 'backup-weekly';
  readonly schedule = 'daily' as const;
  private readonly log = new Logger('PublisherBackupWeekly');

  constructor(
    private readonly db: SitesDb,
    private readonly backup: BackupService,
    private readonly ports: PubPorts,
  ) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    if (this.backup.disabled()) {
      this.log.warn(
        'PUBLISHER_BACKUP_DISABLED=true — еженедельная копия пропущена',
      );
      return { processed: 0, details: { disabled: true } };
    }
    if (kyivParts(ctx.now).weekday !== 1)
      return { processed: 0, details: { notMonday: true } };
    const dayStart = kyivDayStart(kyivDateOf(ctx.now));
    const products = await this.db.system(
      'крон publisher backup-weekly: продукты всех кабинетов',
    ).$queryRaw<Array<{ id: string; accountId: string }>>`
      SELECT p."id", p."accountId" FROM "sites"."pub_products" p
       WHERE ${ACTIVE} ${scopeSql(ctx)}
         AND NOT EXISTS (SELECT 1 FROM "sites"."pub_backups" b
                          WHERE b."productId" = p."id" AND b."kind" = 'weekly' AND b."createdAt" >= ${dayStart})
       ORDER BY p."id" LIMIT 100`;
    return backupProducts(
      this.db,
      this.backup,
      this.ports,
      ctx,
      products,
      'weekly',
      this.log,
    );
  }
}

@Injectable()
@PubContribution('cron-job')
export class BackupPostPurchaseJob implements CronJob {
  readonly key = 'backup-post-purchase';
  readonly schedule = 'tick' as const;
  private readonly log = new Logger('PublisherBackupPostPurchase');

  constructor(
    private readonly db: SitesDb,
    private readonly backup: BackupService,
    private readonly ports: PubPorts,
  ) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    if (this.backup.disabled())
      return { processed: 0, details: { disabled: true } };
    const products = await this.db.system(
      'крон publisher backup-post-purchase: оплаты закупок всех кабинетов',
    ).$queryRaw<Array<{ id: string; accountId: string }>>`
      SELECT p."id", p."accountId" FROM "sites"."pub_products" p
       WHERE ${ACTIVE} ${scopeSql(ctx)}
         AND EXISTS (
           SELECT 1 FROM "sites"."pub_expense_entries" en
             JOIN "sites"."pub_expenses" e ON e."id" = en."expenseId"
            WHERE en."productId" = p."id" AND e."category" = 'placements'
              AND en."kind" = 'pay' AND en."status" = 'confirmed'
              AND en."confirmedAt" > COALESCE((SELECT max(b."createdAt") FROM "sites"."pub_backups" b
                                                WHERE b."productId" = p."id" AND b."status" <> 'failed'),
                                              '-infinity'::timestamptz))
       ORDER BY p."id" LIMIT 50`;
    return backupProducts(
      this.db,
      this.backup,
      this.ports,
      ctx,
      products,
      'post_purchase',
      this.log,
    );
  }
}

@Injectable()
@PubContribution('cron-job')
export class BackupRotationJob implements CronJob {
  readonly key = 'backup-rotation';
  readonly schedule = 'daily' as const;

  constructor(
    private readonly db: SitesDb,
    private readonly backup: BackupService,
  ) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const rows = await this.db
      .system('крон publisher backup-rotation: копии всех кабинетов')
      .pubBackup.findMany({
        where: {
          status: 'ok',
          rotationUntil: { lt: ctx.now },
          ...(ctx.scope
            ? { product: { siteId: { in: ctx.scope.siteIds } } }
            : {}),
        },
        take: 200,
        orderBy: { rotationUntil: 'asc' },
      });
    let expired = 0;
    let kept = 0;
    for (const r of rows) {
      if (Date.now() > ctx.deadline.getTime()) break;
      if (await this.backup.expire(r)) expired++;
      else kept++;
    }
    return { processed: expired, details: { expired, keptNoKey: kept } };
  }
}
