/**
 * AI Publisher, P-B1 — каскады изменения входов материала (проектный
 * документ §6.3, §7.1; F02, F04, F06; AT-F02-02, AT-F06-02, AT-CORE-21):
 * новый оффер, изменённый/снятый факт бренда (`pub_version_facts`),
 * новая строка claim, отзыв или новая редакция источника.
 *
 * По затронутым версиям (и версиям адаптаций, опирающимся на них):
 *  - опубликованная версия материала (`publishedVersionId`) — задача на
 *    материал, `published|revised → correction_required`, `criticalStale`
 *    при изменении цены, гарантии или критического claim; страница
 *    ОСТАЁТСЯ на сайте (её согласование активно, §7.1), задачи получают и
 *    публикации версии (`objectType=publication`);
 *  - прочие версии — задача на версию (блокирует согласование, §7.1), а
 *    активные согласования НЕопубликованных версий → `superseded`
 *    (аудит P2-15).
 * Повтор того же события задач не плодит (`triggerRef`).
 */
import { Injectable } from '@nestjs/common';
import type { CascadeSummary } from '../contracts/content-api';
import type { ContentStatus, ReviewReason } from '../contracts/states';
import {
  PubPorts,
  type ProductRef,
  type PubTx,
  type ReviewItem,
} from '../core/ports';
import { CONTENT_MACHINE, assertTransition } from '../core/state-machines';

export interface CascadeInput {
  reason: Extract<
    ReviewReason,
    | 'offer_changed'
    | 'fact_changed'
    | 'claim_changed'
    | 'source_revoked'
    | 'stale_check'
  >;
  /** id события-причины (новая версия оффера, факт, claim, отзыв). */
  triggerRef: string;
  /** Версии, которые опираются на изменённый объект. */
  versionIds: readonly string[];
  /** Изменение цены, гарантии или критического claim → `criticalStale`. */
  critical: boolean;
  actor: string;
  now: Date;
  /**
   * Только задачи и снятие согласований неопубликованных версий; материал
   * в `correction_required` не переводится (метаданные источника).
   */
  noCorrection?: boolean;
}

const emptySummary = (): CascadeSummary => ({
  tasksOpened: 0,
  correctionRequired: [],
  approvalsSuperseded: [],
});

/**
 * Версии, решение по которым УЖЕ принято: есть активное согласование
 * `publish_version` или версия показана (`publishedVersionId`). Отрицательное
 * решение человека после согласования (claim `unsupported`, QA `fail`) идёт
 * каскадом только по ним (аудит P-B1 S0-1); до согласования его ловят
 * блокеры согласования.
 */
export async function decidedVersionIds(
  tx: PubTx,
  productId: string,
  versionIds: readonly string[],
): Promise<string[]> {
  if (versionIds.length === 0) return [];
  const [approved, shown] = await Promise.all([
    tx.pubApproval.findMany({
      where: {
        productId,
        type: 'publish_version',
        objectType: 'content_version',
        objectId: { in: [...versionIds] },
        status: 'active',
      },
      select: { objectId: true },
    }),
    tx.pubContent.findMany({
      where: { productId, publishedVersionId: { in: [...versionIds] } },
      select: { publishedVersionId: true },
    }),
  ]);
  return [
    ...new Set([
      ...approved.map((a) => a.objectId),
      ...shown.map((c) => c.publishedVersionId as string),
    ]),
  ];
}

@Injectable()
export class ContentCascades {
  constructor(private readonly ports: PubPorts) {}

  async run(
    tx: PubTx,
    product: ProductRef,
    input: CascadeInput,
  ): Promise<CascadeSummary> {
    const out = emptySummary();
    if (input.versionIds.length === 0) return out;
    // Версии адаптаций, опирающиеся на затронутые версии статьи (F06).
    const derived = await tx.pubContentVersion.findMany({
      where: {
        productId: product.id,
        parentVersionId: { in: [...input.versionIds] },
      },
      select: { id: true },
    });
    const ids = [
      ...new Set([...input.versionIds, ...derived.map((d) => d.id)]),
    ];
    const versions = await tx.pubContentVersion.findMany({
      where: { productId: product.id, id: { in: ids } },
      select: {
        id: true,
        contentId: true,
        content: {
          select: { id: true, status: true, publishedVersionId: true },
        },
      },
    });
    const severity = input.critical ? 'critical' : 'normal';
    const tasks: ReviewItem[] = [];
    const touchedContents = new Set<string>();
    for (const v of versions) {
      if (v.content.publishedVersionId === v.id) {
        tasks.push({
          objectType: 'content',
          objectId: v.contentId,
          reason: input.reason,
          triggerRef: input.triggerRef,
          severity,
        });
        const pubs = await tx.pubPublication.findMany({
          where: {
            productId: product.id,
            versionId: v.id,
            status: { in: ['pending', 'published'] },
          },
          select: { id: true },
        });
        for (const p of pubs) {
          tasks.push({
            objectType: 'publication',
            objectId: p.id,
            reason: input.reason,
            triggerRef: input.triggerRef,
            severity,
          });
        }
        if (!input.noCorrection && !touchedContents.has(v.contentId)) {
          touchedContents.add(v.contentId);
          if (await this.toCorrection(tx, product, v.contentId, input)) {
            out.correctionRequired.push(v.contentId);
          }
        }
        continue;
      }
      tasks.push({
        objectType: 'content_version',
        objectId: v.id,
        reason: input.reason,
        triggerRef: input.triggerRef,
        severity,
      });
      const approvals = await tx.pubApproval.findMany({
        where: {
          productId: product.id,
          type: 'publish_version',
          objectType: 'content_version',
          objectId: v.id,
          status: 'active',
        },
        select: { id: true },
      });
      for (const a of approvals) {
        const n = await tx.pubApproval.updateMany({
          where: { id: a.id, status: 'active' },
          data: { status: 'superseded', reason: input.reason },
        });
        if (n.count !== 1) continue;
        out.approvalsSuperseded.push(a.id);
        await this.ports.audit().write(tx, {
          accountId: product.accountId,
          productId: product.id,
          actor: input.actor,
          objectType: 'approval',
          objectId: a.id,
          action: 'transition',
          fromStatus: 'active',
          toStatus: 'superseded',
          meta: { cause: input.reason, triggerRef: input.triggerRef },
        });
      }
    }
    out.tasksOpened = await this.ports
      .review()
      .open(tx, product, tasks, { actor: input.actor });
    return out;
  }

  /** `published|revised → correction_required` (+ `criticalStale`). */
  private async toCorrection(
    tx: PubTx,
    product: ProductRef,
    contentId: string,
    input: CascadeInput,
  ): Promise<boolean> {
    const c = await tx.pubContent.findFirst({
      where: { id: contentId, productId: product.id },
      select: { status: true, criticalStale: true },
    });
    if (!c) return false;
    const from = c.status as ContentStatus;
    const canMove = from === 'published' || from === 'revised';
    if (canMove) {
      assertTransition(CONTENT_MACHINE, from, 'correction_required', {
        actors: ['system'],
      });
    }
    if (!canMove && (!input.critical || c.criticalStale)) return false;
    await tx.pubContent.update({
      where: { id: contentId },
      data: {
        ...(canMove ? { status: 'correction_required' } : {}),
        ...(input.critical ? { criticalStale: true } : {}),
        revision: { increment: 1 },
      },
    });
    await this.ports.audit().write(tx, {
      accountId: product.accountId,
      productId: product.id,
      actor: input.actor,
      objectType: 'content',
      objectId: contentId,
      action: 'transition',
      fromStatus: from,
      toStatus: canMove ? 'correction_required' : from,
      meta: {
        cause: input.reason,
        triggerRef: input.triggerRef,
        criticalStale: input.critical || c.criticalStale,
      },
      occurredAt: input.now,
    });
    return canMove;
  }
}
