/**
 * AI Publisher — ежедневные задания ретенции и формы (P-D, проектный
 * документ §15.1, §15.3; ТЗ §17, §21; AT-CORE-09).
 *
 *  - `retention-review` (daily): заявки с `reviewDueAt` до конца текущих
 *    суток Kyiv и без удаления → задача проверки `retention_review`
 *    ответственному (повтор того же срока задач не плодит — `triggerRef`
 *    = срок) и уведомление `retention_review` (следующий цикл — снова в
 *    очередь). Решение — человек: «удалить» или «хранить» с основанием.
 *  - `form-after-t72` (daily): за 7 дней до t72 пилота, если не назначен
 *    ответственный за форму после t72 (`responsibles.afterT72MemberId`),
 *    — задача `form_after_t72` владельцу кабинета: назначить или закрыть
 *    форму с честным сообщением и альтернативным контактом (ТЗ §17).
 *
 * Продукты `kind=restored|eval` и архивные не обрабатываются.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { PubContribution } from '../core/contributions';
import {
  addKyivCalendarDays,
  kyivDateOf,
  kyivDayStart,
} from '../core/kyiv-time';
import { OPERATION_TX_OPTIONS } from '../core/operation';
import {
  PubPorts,
  type CronJob,
  type CronResult,
  type PubCronContext,
} from '../core/ports';
import { NotificationsService } from './notifications.service';
import {
  accountOwnerId,
  isLeadRecipient,
  leadRecipientIds,
} from './recipients';

/** Партия `retention-review` (курсор по сроку и id). */
export const RETENTION_BATCH = 500;

/** Окно предупреждения перед t72 (§15.1). */
export const FORM_AFTER_T72_LEAD_DAYS = 7;

@Injectable()
@PubContribution('cron-job')
export class RetentionReviewJob implements CronJob {
  readonly key = 'retention-review';
  readonly schedule = 'daily' as const;
  /** Размер партии (тест курсора уменьшает). */
  batch = RETENTION_BATCH;

  constructor(
    private readonly db: SitesDb,
    private readonly ports: PubPorts,
    private readonly notifications: NotificationsService,
  ) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher retention-review: сроки пересмотра заявок всех кабинетов',
    );
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    const endOfToday = addKyivCalendarDays(
      kyivDayStart(kyivDateOf(ctx.now)),
      1,
    );
    type Due = {
      id: string;
      accountId: string;
      productId: string;
      kind: string;
      reviewDueAt: Date;
      responsibleMemberId: string | null;
    };
    let tasks = 0;
    let notices = 0;
    let due = 0;
    // Партии с курсором (аудит P-D S3-10): заявки, по сроку которых задача
    // уже есть (тот же `triggerRef`), не выбираются — иначе при ≥ партии
    // просроченных те же строки шли бы каждый день, а новые сроки — нет.
    let cursor: { at: Date; id: string } | null = null;
    for (;;) {
      if (Date.now() > ctx.deadline.getTime()) break;
      const after: Prisma.Sql = cursor
        ? Prisma.sql`AND (l."reviewDueAt", l."id") > (${cursor.at}, ${cursor.id})`
        : Prisma.empty;
      const rows: Due[] = await system.$queryRaw<Due[]>`
        SELECT l."id", l."accountId", l."productId", p."kind", l."reviewDueAt",
               l."responsibleMemberId"
          FROM "sites"."pub_leads" l
          JOIN "sites"."pub_products" p ON p."id" = l."productId"
         WHERE p."kind" IN ('working', 'test') AND p."status" = 'active' ${scope}
           AND l."erasedAt" IS NULL AND l."reviewDueAt" < ${endOfToday} ${after}
           AND NOT EXISTS (
             SELECT 1 FROM "sites"."pub_review_tasks" t
              WHERE t."productId" = l."productId" AND t."objectType" = 'lead'
                AND t."objectId" = l."id" AND t."reason" = 'retention_review'
                AND t."triggerRef" = 'retention:' || to_char(l."reviewDueAt" AT TIME ZONE 'UTC',
                                                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
         ORDER BY l."reviewDueAt", l."id"
         LIMIT ${this.batch}`;
      if (!rows.length) break;
      const last = rows[rows.length - 1];
      cursor = { at: last.reviewDueAt, id: last.id };
      for (const r of rows) {
        if (Date.now() > ctx.deadline.getTime()) break;
        due++;
        const res = await this.reviewOne(r, ctx.now);
        tasks += res.opened;
        notices += res.n;
      }
      if (rows.length < this.batch) break;
    }
    return {
      processed: due,
      details: { dueLeads: due, tasks, notifications: notices },
    };
  }

  private reviewOne(
    r: {
      id: string;
      accountId: string;
      productId: string;
      kind: string;
      reviewDueAt: Date;
      responsibleMemberId: string | null;
    },
    now: Date,
  ): Promise<{ opened: number; n: number }> {
    const product = { id: r.productId, accountId: r.accountId, kind: r.kind };
    return this.db.forAccount(r.accountId).$transaction(async (tx) => {
      // Ответственный без действующей роли (отозвана, удалён) задачу и
      // уведомление не получает — их получают текущие получатели (S3-3).
      const responsible =
        r.responsibleMemberId &&
        (await isLeadRecipient(tx, r.productId, r.responsibleMemberId))
          ? r.responsibleMemberId
          : null;
      const opened = await this.ports.review().open(
        tx,
        product,
        [
          {
            objectType: 'lead',
            objectId: r.id,
            reason: 'retention_review',
            triggerRef: `retention:${r.reviewDueAt.toISOString()}`,
            severity: 'normal',
            assigneeMemberId: responsible,
            dueAt: r.reviewDueAt,
          },
        ],
        { actor: 'system:retention-review' },
      );
      const to = responsible
        ? [responsible]
        : await leadRecipientIds(tx, product);
      const n = opened
        ? await this.notifications.enqueue(
            tx,
            product,
            r.id,
            'retention_review',
            to,
            'system:retention-review',
            now,
            { reopen: true },
          )
        : 0;
      return { opened, n };
    }, OPERATION_TX_OPTIONS);
  }
}

@Injectable()
@PubContribution('cron-job')
export class FormAfterT72Job implements CronJob {
  readonly key = 'form-after-t72';
  readonly schedule = 'daily' as const;

  constructor(
    private readonly db: SitesDb,
    private readonly ports: PubPorts,
  ) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher form-after-t72: t72 пилота и ответственный за форму',
    );
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    const horizon = addKyivCalendarDays(ctx.now, FORM_AFTER_T72_LEAD_DAYS);
    const rows = await system.$queryRaw<
      Array<{
        productId: string;
        accountId: string;
        t72: Date;
        afterT72: string | null;
      }>
    >`
      SELECT p."id" AS "productId", p."accountId", e."t72",
             (pa."value" ->> 'afterT72MemberId') AS "afterT72"
        FROM "sites"."pub_products" p
        JOIN LATERAL (SELECT x."t72" FROM "sites"."pub_experiments" x
                       WHERE x."productId" = p."id" AND x."kind" = 'pilot' AND x."t72" IS NOT NULL
                       ORDER BY x."version" DESC LIMIT 1) e ON true
        LEFT JOIN "sites"."pub_parameters" pa
               ON pa."productId" = p."id" AND pa."key" = 'responsibles'
       WHERE p."kind" IN ('working', 'test') AND p."status" = 'active' ${scope}
         AND p."mode" <> 'closed'
         AND e."t72" <= ${horizon}`;
    let opened = 0;
    for (const r of rows) {
      if (r.afterT72) continue;
      opened += await this.db
        .forAccount(r.accountId)
        .$transaction(async (tx) => {
          const owner = await accountOwnerId(tx);
          return this.ports.review().open(
            tx,
            { id: r.productId, accountId: r.accountId },
            [
              {
                objectType: 'product',
                objectId: r.productId,
                reason: 'form_after_t72',
                triggerRef: `form-after-t72:${r.t72.toISOString()}`,
                severity: 'critical',
                assigneeMemberId: owner,
                dueAt: r.t72,
              },
            ],
            { actor: 'system:form-after-t72' },
          );
        }, OPERATION_TX_OPTIONS);
    }
    return {
      processed: rows.length,
      details: { products: rows.length, tasks: opened },
    };
  }
}
