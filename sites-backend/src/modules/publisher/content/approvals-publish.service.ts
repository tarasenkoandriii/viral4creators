/**
 * AI Publisher, P-B1 — согласование версии к публикации (проектный
 * документ §6.3 `pub_approvals` type `publish_version`, §7.1
 * `editorial_review → approved`; AT-CORE-10, AT-F04-02).
 *
 * Согласуется HASH замороженной версии: тело запроса несёт `versionHash`,
 * он обязан совпасть с hash версии и с hash, пересчитанным по текущему
 * состоянию источников и связей claim → источник (контракт P-A1 P2-5);
 * иначе `PUB_APPROVAL_STALE` — прежний hash не разрешает новый текст.
 *
 * Условия (иначе `PUB_BLOCKERS_OPEN {blockers}`): последние редакционная и
 * техническая проверки ЧЕЛОВЕКА — `pass` без блокеров (`unknown` не
 * проходит, `ai_review` не учитывается); все критические claims версии
 * `supported`, ни одного `unsupported`; источники `allowed`; оффер
 * активен; нет открытых задач изменения по версии; у адаптации —
 * `adaptation_meaning = pass` и родительская версия всё ещё согласована.
 * Согласующий — PO; совпадение с автором версии — `selfReview` (ТЗ §5).
 *
 * Правило аудита P1-1: согласование опубликованной версии остаётся
 * `active`, пока новая версия не опубликована (снимает его
 * `ContentPort.markPublished`), явный отзыв (`revoke`) — отдельное
 * действие ED/PO; запись публикации берёт `FOR SHARE` строки согласования
 * (триггер P-A0), поэтому отзыв и публикация сериализуются.
 */
import { Injectable } from '@nestjs/common';
import type { ApprovalView } from '../contracts/content-api';
import { memberActor } from '../contracts/common';
import { PubError, validationError } from '../core/errors';
import { PubContribution } from '../core/contributions';
import type {
  CronJob,
  CronResult,
  ProductRef,
  PubCronContext,
  PubTx,
} from '../core/ports';
import { PubPorts } from '../core/ports';
import { SitesDb } from '../../../prisma/sites-db.service';
import { isSelfReview, type PubAccess } from '../core/roles';
import {
  APPROVAL_MACHINE,
  CONTENT_MACHINE,
  assertTransition,
  type Actor,
} from '../core/state-machines';
import { Issues, type Body } from './input';
import type { OpOut } from './sources.service';
import { ContentsService } from './contents.service';
import { assertHashCurrent } from './version-hash';
import { approvalView } from './views';

const HEX64 = /^[0-9a-f]{64}$/;

import { approvalBlockers } from './blockers';
export { approvalBlockers };

@Injectable()
export class ApprovalsPublishService {
  constructor(private readonly contents: ContentsService) {}

  async approve(
    tx: PubTx,
    product: ProductRef,
    versionId: string,
    b: Body,
    m: { memberId: string; access: PubAccess; actors: Actor[] },
    now: Date,
  ): Promise<OpOut<ApprovalView>> {
    const is = new Issues();
    const versionHash = is.str(b, 'versionHash', {
      required: true,
      max: 64,
      re: HEX64,
    });
    const reason = is.str(b, 'reason', { max: 2000, pii: true });
    is.throwIfAny();
    const head = await tx.pubContentVersion.findFirst({
      where: { id: versionId, productId: product.id },
      select: { contentId: true },
    });
    if (!head) throw new PubError('PUB_NOT_FOUND');
    // Аудит P-B1 S2-2: строка материала под блокировкой до конца операции —
    // параллельный «запрос правок»/второе согласование ждут и видят итог.
    await tx.$queryRaw`SELECT "id" FROM "sites"."pub_contents" WHERE "id" = ${head.contentId} FOR UPDATE`;
    const v = await tx.pubContentVersion.findFirst({
      where: { id: versionId, productId: product.id },
      include: { content: true },
    });
    if (!v) throw new PubError('PUB_NOT_FOUND');
    const c = v.content;
    if (v.status !== 'submitted' || c.currentVersionId !== v.id) {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'content_version',
        from: v.status,
        to: 'approved',
        allowed: [],
      });
    }
    assertTransition(CONTENT_MACHINE, c.status as never, 'approved', {
      actors: m.actors,
    });
    if (versionHash !== v.hash) {
      throw new PubError('PUB_APPROVAL_STALE', {
        reason: 'hash_param',
        versionHash: v.hash,
      });
    }
    await assertHashCurrent(tx, product.id, versionId, v.hash);
    const blockers = await approvalBlockers(tx, product.id, versionId);
    if (blockers.length) throw new PubError('PUB_BLOCKERS_OPEN', { blockers });
    const already = await tx.pubApproval.count({
      where: {
        productId: product.id,
        type: 'publish_version',
        objectType: 'content_version',
        objectId: versionId,
        status: 'active',
      },
    });
    if (already > 0) {
      throw new PubError('PUB_CONFLICT', { reason: 'approval_exists' });
    }
    // Имя согласующего — снимок с сервера (грант роли), не из тела (S3-6).
    const grant = await tx.pubRoleGrant.findFirst({
      where: { productId: product.id, memberId: m.memberId, revokedAt: null },
      orderBy: { grantedAt: 'asc' },
      select: { memberDisplayName: true },
    });
    const selfReview = isSelfReview(
      m.access,
      'version.approve',
      v.authorMemberId,
    );
    const a = await tx.pubApproval.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        type: 'publish_version',
        objectType: 'content_version',
        objectId: versionId,
        versionHash: v.hash!,
        approverMemberId: m.memberId,
        approverDisplayName:
          grant?.memberDisplayName ?? `Учасник …${m.memberId.slice(-6)}`,
        decidedAt: now,
        status: 'active',
        selfReview,
        reason: reason ?? null,
        createdBy: memberActor(m.memberId),
      },
    });
    const nv = await tx.pubContentVersion.updateMany({
      where: { id: versionId, status: 'submitted' },
      data: { status: 'approved' },
    });
    const nc = await tx.pubContent.updateMany({
      where: { id: c.id, revision: c.revision, status: 'editorial_review' },
      data: {
        status: 'approved',
        approvedVersionId: versionId,
        revision: { increment: 1 },
      },
    });
    if (nv.count !== 1 || nc.count !== 1) {
      throw new PubError('PUB_CONFLICT', { currentRevision: c.revision + 1 });
    }
    return {
      body: approvalView(a),
      audit: [
        {
          objectType: 'approval',
          objectId: a.id,
          action: 'approve',
          toStatus: 'active',
          reason: reason ?? null,
          meta: { versionId, versionHash: v.hash!, selfReview },
        },
        {
          objectType: 'content',
          objectId: c.id,
          action: 'transition',
          fromStatus: c.status,
          toStatus: 'approved',
        },
      ],
    };
  }

  async revoke(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
    actors: Actor[],
    now: Date = new Date(),
  ): Promise<OpOut<ApprovalView>> {
    const is = new Issues();
    const reason = is.str(b, 'reason', {
      required: true,
      max: 2000,
      pii: true,
    });
    is.throwIfAny();
    const a = await tx.pubApproval.findFirst({
      where: { id, productId: product.id, type: 'publish_version' },
    });
    if (!a) throw new PubError('PUB_NOT_FOUND');
    assertTransition(APPROVAL_MACHINE, a.status as never, 'revoked', {
      actors,
    });
    // Явный отзыв: условный UPDATE (параллельная публикация держит FOR SHARE).
    const n = await tx.pubApproval.updateMany({
      where: { id, status: 'active' },
      data: { status: 'revoked', reason: reason! },
    });
    if (n.count !== 1)
      throw new PubError('PUB_CONFLICT', { reason: 'approval_changed' });
    // Все прочие активные согласования этой версии — тоже (S2-2).
    await tx.pubApproval.updateMany({
      where: {
        productId: product.id,
        type: 'publish_version',
        objectType: 'content_version',
        objectId: a.objectId,
        status: 'active',
      },
      data: { status: 'revoked', reason: reason! },
    });
    const shown = await tx.pubContent.findFirst({
      where: { productId: product.id, publishedVersionId: a.objectId },
      select: { id: true },
    });
    // Отзыв согласования показанной версии — страница снята: 410 (S3-3).
    const extra = shown
      ? await this.contents.takeDown(
          tx,
          product,
          shown.id,
          reason!,
          actors,
          now,
        )
      : [];
    const c = await tx.pubContent.findFirst({
      where: { productId: product.id, approvedVersionId: a.objectId },
      select: { id: true, publishedVersionId: true },
    });
    if (c && c.publishedVersionId !== a.objectId) {
      await tx.pubContent.update({
        where: { id: c.id },
        data: {
          approvedVersionId: c.publishedVersionId,
          revision: { increment: 1 },
        },
      });
    }
    const row = await tx.pubApproval.findFirstOrThrow({ where: { id } });
    return {
      body: approvalView(row),
      audit: [
        {
          objectType: 'approval',
          objectId: id,
          action: 'revoke',
          fromStatus: 'active',
          toStatus: 'revoked',
          reason: reason!,
          meta: {
            versionId: a.objectId,
            published: !!shown,
          },
        },
        ...extra,
      ],
    };
  }

  async list(
    tx: PubTx,
    productId: string,
    f: { objectId?: string; status?: string },
  ): Promise<{ items: ApprovalView[] }> {
    if (f.status && !APPROVAL_MACHINE.states.includes(f.status as never)) {
      throw validationError([{ field: 'status', code: 'enum' }]);
    }
    const rows = await tx.pubApproval.findMany({
      where: {
        productId,
        type: 'publish_version',
        ...(f.objectId ? { objectId: f.objectId } : {}),
        ...(f.status ? { status: f.status } : {}),
      },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return { items: rows.map(approvalView) };
  }
}

/**
 * Задание `approvals-expire-publish` (tick, §15.1): согласования
 * `publish_version` с `expiresAt ≤ now` → `expired` + аудит. По триггеру
 * P-A0 у `publish_version` срока нет (`expiresAt IS NULL`), поэтому в P0
 * задание обычно ничего не находит — но и не возвращает «успех» вместо
 * работы: обрабатывает всё, что найдёт.
 */
@Injectable()
@PubContribution('cron-job')
export class ApprovalsExpirePublishJob implements CronJob {
  readonly key = 'approvals-expire-publish';
  readonly schedule = 'tick' as const;

  constructor(
    private readonly db: SitesDb,
    private readonly ports: PubPorts,
  ) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const sys = this.db.system(
      'publisher cron: просрочка согласований публикации по всем продуктам',
    );
    const rows = await sys.pubApproval.findMany({
      where: {
        type: 'publish_version',
        status: 'active',
        expiresAt: { lte: ctx.now },
        product: {
          kind: { in: ['working', 'test'] },
          status: 'active',
          ...(ctx.scope ? { siteId: { in: [...ctx.scope.siteIds] } } : {}),
        },
      },
      select: { id: true, accountId: true, productId: true, objectId: true },
      take: 500,
    });
    let processed = 0;
    for (const r of rows) {
      if (Date.now() > ctx.deadline.getTime()) break;
      await this.db.forAccount(r.accountId).$transaction(async (tx) => {
        const n = await tx.pubApproval.updateMany({
          where: { id: r.id, status: 'active' },
          data: { status: 'expired', reason: 'expired' },
        });
        if (n.count !== 1) return;
        processed++;
        await this.ports.audit().write(tx, {
          accountId: r.accountId,
          productId: r.productId,
          actor: 'system:approvals-expire-publish',
          objectType: 'approval',
          objectId: r.id,
          action: 'transition',
          fromStatus: 'active',
          toStatus: 'expired',
          meta: { versionId: r.objectId },
        });
      });
    }
    return { processed, details: { found: rows.length } };
  }
}
