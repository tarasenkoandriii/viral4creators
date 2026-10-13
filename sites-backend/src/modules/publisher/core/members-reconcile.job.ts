/**
 * AI Publisher — задание `members-reconcile` (tick, P-A1; проектный
 * документ §4.1, §15.1; аудит P2-26; AT-CORE-11).
 *
 * Ссылки на участников в `pub_*` — без FK (удаление участника не падает и
 * не стирает историю), поэтому после `DELETE /sites/account/members/:id`
 * (site-core не импортирует publisher — правило `publisher-leaf`) это
 * задание (аудит P2-4):
 *  1. находит пары «продукт × участник», где участник упомянут в `pub_*`
 *     (гранты ЛЮБОГО статуса — роли могли отозвать до удаления; открытые
 *     задачи проверки, назначенные ему), но его нет в кабинете, и пара ещё
 *     не обработана. Отметка «обработано» — задача проверки
 *     `member_removed` с `triggerRef = 'member-removed:<memberId>'`
 *     (уникальна по событию, открывается последним шагом);
 *  2. если хоть одного ожидаемого вклада `member-reassign` (P-D заявки,
 *     P-C действия, P-B1 материалы) нет — НИЧЕГО не делает и возвращает
 *     `pending` (ответ крона 501): заглушка — не успех, пары остаются
 *     необработанными и пройдут, когда вклады появятся;
 *  3. закрывает активные гранты (`revokedBy = 'system:member-removed'`);
 *  4. переназначает открытые задачи проверки владельцу кабинета, а
 *     заявки, действия и материалы — вкладами пакетов;
 *  5. открывает владельцу задачу `member_removed` (отметку).
 * Доступ уже закрыт и без задания: гвард не находит членства.
 *
 * Продукты `kind=restored|eval` и архивные не обрабатываются (§15.1).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { AuditService } from './audit';
import {
  EXPECTED_MEMBER_REASSIGN,
  PubContribution,
  PubContributions,
  type MemberReassignContributor,
  type MemberReassignKey,
} from './contributions';
import { OPERATION_TX_OPTIONS } from './operation';
import type { CronJob, CronResult, PubCronContext, PubTx } from './ports';
import { ReviewTasksService } from './review-tasks.service';

export const MEMBERS_RECONCILE_ACTOR = 'system:member-removed';
export const MEMBERS_RECONCILE_BATCH = 200;
const REASON = 'Учасника видалено з кабінету — роль закрита автоматично';

interface OrphanRow {
  productId: string;
  accountId: string;
  memberId: string;
}

@Injectable()
@PubContribution('cron-job')
export class MembersReconcileJob implements CronJob {
  readonly key = 'members-reconcile';
  readonly schedule = 'tick' as const;

  constructor(
    private readonly db: SitesDb,
    private readonly audit: AuditService,
    private readonly review: ReviewTasksService,
    private readonly contributions: PubContributions,
  ) {}

  /** Необработанные пары «продукт × удалённый участник» — по всем кабинетам. */
  private async orphans(ctx: PubCronContext): Promise<OrphanRow[]> {
    const system = this.db.system(
      'крон members-reconcile: гранты по всем кабинетам',
    );
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    return system.$queryRaw<OrphanRow[]>`
      WITH refs AS (
        SELECT g."productId", g."accountId", g."memberId"
          FROM "sites"."pub_role_grants" g
        UNION
        SELECT t."productId", t."accountId", t."assigneeMemberId"
          FROM "sites"."pub_review_tasks" t
         WHERE t."status" = 'open' AND t."assigneeMemberId" IS NOT NULL
      )
      SELECT r."productId", r."accountId", r."memberId"
        FROM refs r
        JOIN "sites"."pub_products" p ON p."id" = r."productId" AND p."accountId" = r."accountId"
       WHERE p."kind" IN ('working', 'test') AND p."status" = 'active'
         AND NOT EXISTS (SELECT 1 FROM "sites"."site_account_members" m
                          WHERE m."id" = r."memberId" AND m."accountId" = r."accountId")
         AND NOT EXISTS (SELECT 1 FROM "sites"."pub_review_tasks" d
                          WHERE d."productId" = r."productId" AND d."objectType" = 'member'
                            AND d."objectId" = r."memberId" AND d."reason" = 'member_removed'
                            AND d."triggerRef" = 'member-removed:' || r."memberId")
         ${scope}
       ORDER BY r."productId", r."memberId"
       LIMIT ${MEMBERS_RECONCILE_BATCH}`;
  }

  async run(ctx: PubCronContext): Promise<CronResult> {
    const rows = await this.orphans(ctx);
    const reassigners = this.contributions.list('member-reassign');
    const have = new Set(reassigners.map((r) => r.key));
    const missing = (
      Object.keys(EXPECTED_MEMBER_REASSIGN) as MemberReassignKey[]
    ).filter((k) => !have.has(k));
    if (missing.length > 0) {
      // Аудит P2-4: без вклада переназначения пару не трогаем и не
      // отмечаем — иначе объекты удалённого участника не переназначатся
      // никогда. Есть ли что делать — видно по `waiting`.
      return {
        processed: 0,
        pending: missing.map((k) => `member-reassign:${k}`),
        details: { waiting: rows.length },
      };
    }
    let grantsRevoked = 0;
    let tasksReassigned = 0;
    let objectsReassigned = 0;
    let members = 0;
    for (const row of rows) {
      if (Date.now() > ctx.deadline.getTime()) break;
      const r = await this.db
        .forAccount(row.accountId)
        .$transaction(
          (tx) => this.reconcileOne(tx, row, ctx.now, reassigners),
          OPERATION_TX_OPTIONS,
        );
      grantsRevoked += r.grants;
      tasksReassigned += r.tasks;
      objectsReassigned += r.objects;
      members++;
    }
    return {
      processed: members,
      details: {
        grantsRevoked,
        tasksReassigned,
        objectsReassigned,
      },
    };
  }

  private async reconcileOne(
    tx: PubTx,
    row: OrphanRow,
    now: Date,
    reassigners: MemberReassignContributor[],
  ): Promise<{ grants: number; tasks: number; objects: number }> {
    const product = { id: row.productId, accountId: row.accountId };
    const grants = await tx.pubRoleGrant.findMany({
      where: {
        productId: row.productId,
        memberId: row.memberId,
        revokedAt: null,
      },
    });
    for (const g of grants) {
      const n = await tx.pubRoleGrant.updateMany({
        where: { id: g.id, revokedAt: null },
        data: {
          revokedAt: now,
          revokedBy: MEMBERS_RECONCILE_ACTOR,
          reason: REASON,
        },
      });
      if (n.count !== 1) continue;
      await this.audit.write(tx, {
        accountId: row.accountId,
        productId: row.productId,
        actor: MEMBERS_RECONCILE_ACTOR,
        objectType: 'role_grant',
        objectId: g.id,
        action: 'revoke',
        fromStatus: 'active',
        toStatus: 'revoked',
        reason: REASON,
        meta: { memberId: row.memberId, role: g.role },
      });
    }
    const owner = await tx.siteAccountMember.findFirst({
      where: { role: 'owner' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    let tasks = 0;
    let objects = 0;
    if (owner) {
      const t = await tx.pubReviewTask.updateMany({
        where: {
          productId: row.productId,
          status: 'open',
          assigneeMemberId: row.memberId,
        },
        data: { assigneeMemberId: owner.id, revision: { increment: 1 } },
      });
      tasks = t.count;
      for (const r of reassigners) {
        objects += await r.reassign(
          tx,
          product,
          row.memberId,
          owner.id,
          MEMBERS_RECONCILE_ACTOR,
        );
      }
    }
    await this.review.open(
      tx,
      product,
      [
        {
          objectType: 'member',
          objectId: row.memberId,
          reason: 'member_removed',
          triggerRef: `member-removed:${row.memberId}`,
          severity: 'normal',
          assigneeMemberId: owner?.id ?? null,
        },
      ],
      { actor: MEMBERS_RECONCILE_ACTOR },
    );
    return { grants: grants.length, tasks, objects };
  }
}
