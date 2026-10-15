/**
 * AI Publisher, P-B1 — `ContentPort` (проектный документ §16.0; §7.1
 * `scheduled → published`, `correction_required → revised`; ДТ-1; аудит
 * P1-1, P2-12, P2-15). Его вызывают публикации P-C в транзакции своей
 * операции: P-C пишет `pub_publications`, а статус материала, указатель
 * опубликованной версии и `firstPublishedAt` меняет ТОЛЬКО этот порт.
 *
 *  - `publishableVersion` — что нужно P-C для решения: hash, активное
 *    согласование (активно И hash версии = пересчитанному по текущему
 *    состоянию — контракт P-A1 P2-5; несогласованная версия —
 *    `approvalActive:false, approvalId:''` без исключения, Р-PUB-Z1-2), `criticalStale` (распространение и
 *    закупки по такому материалу P-C отвергает `PUB_CONTENT_STALE`), первая
 *    live-публикация, активность оффера, открытые задачи изменения;
 *  - `markPublished(stage='test')` — ничего не меняет в материале (ДТ-1:
 *    тестовая публикация не переводит в `published`, не ставит
 *    `firstPublishedAt`), но проверяет, что версия выпускаема;
 *  - `markPublished(stage='live')` — повторные проверки (§7.1), `scheduled
 *    → published` (или `correction_required → revised`), прежнее
 *    согласование опубликованной версии → `superseded` (аудит P1-1),
 *    `publishedVersionId`, `firstPublishedAt` один раз, `criticalStale`
 *    снят новой версией;
 *  - `markWithdrawn` — публикация версии снята (P-C): если это
 *    опубликованная версия и активных live-публикаций материала не осталось
 *    — материал `withdrawn` (сайт отдаёт 410).
 */
import { Injectable } from '@nestjs/common';
import type { ContentStatus } from '../contracts/states';
import { PubError } from '../core/errors';
import { looksLikeContact } from '../core/pii-guard';
import {
  PubPorts,
  type ContentPort,
  type ProductRef,
  type PubTx,
} from '../core/ports';
import { CONTENT_MACHINE, assertTransition } from '../core/state-machines';
import { approvalBlockers } from './blockers';
import { ContentCascades } from './cascades';
import { ContentsService } from './contents.service';
import { currentVersionHash } from './version-hash';
import { CHANGE_TASK_REASONS } from './views';

const SYSTEM_ACTOR = 'system:content-port';

@Injectable()
export class ContentPortImpl implements ContentPort {
  constructor(
    private readonly contents: ContentsService,
    private readonly ports: PubPorts,
    private readonly cascades: ContentCascades,
  ) {}

  async publishableVersion(tx: PubTx, product: ProductRef, versionId: string) {
    const v = await tx.pubContentVersion.findFirst({
      where: { id: versionId, productId: product.id },
      include: {
        content: {
          select: { id: true, criticalStale: true, firstPublishedAt: true },
        },
        offerVersion: { select: { status: true } },
      },
    });
    if (!v) throw new PubError('PUB_NOT_FOUND');
    // Несогласованная (в т. ч. не замороженная) версия — не исключение, а
    // `approvalActive:false, approvalId:''` (интеграция Z-1, Р-PUB-Z1-2):
    // решение об отказе (`PUB_APPROVAL_REQUIRED`, `blocked`) — за P-C.
    const where = {
      productId: product.id,
      type: 'publish_version',
      objectType: 'content_version',
      objectId: versionId,
      versionHash: v.hash ?? '',
    };
    // Действующее согласование — в приоритете; иначе последнее (для id).
    const approval = v.hash
      ? ((await tx.pubApproval.findFirst({
          where: { ...where, status: 'active' },
          orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
          select: { id: true, status: true },
        })) ??
        (await tx.pubApproval.findFirst({
          where,
          orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
          select: { id: true, status: true },
        })))
      : null;
    const hashNow =
      approval?.status === 'active'
        ? await currentVersionHash(tx, product.id, versionId)
        : null;
    // Аудит P-B1 S0-1: те же блокеры, что при согласовании (claim
    // `unsupported`, QA `fail` после согласования, родитель адаптации снят…).
    // Неактивный оффер и задачи изменения у P-C — свои поля (`offerActive`,
    // `openChangeTasks`: тестовая публикация с ними допустима, live — нет).
    const blockers =
      approval?.status === 'active'
        ? (await approvalBlockers(tx, product.id, versionId)).filter(
            (b) => b.code !== 'offer_inactive' && b.code !== 'change_task_open',
          )
        : [];
    const openChangeTasks = await tx.pubReviewTask.count({
      where: {
        productId: product.id,
        status: 'open',
        reason: { in: CHANGE_TASK_REASONS },
        OR: [
          { objectType: 'content_version', objectId: versionId },
          { objectType: 'content', objectId: v.contentId },
        ],
      },
    });
    return {
      contentId: v.contentId,
      hash: v.hash ?? '',
      approvalId: approval?.id ?? '',
      approvalActive:
        approval?.status === 'active' &&
        v.hash !== null &&
        hashNow === v.hash &&
        blockers.length === 0,
      criticalStale: v.content.criticalStale,
      firstLivePublishedAt: v.content.firstPublishedAt,
      offerActive: v.offerVersion.status === 'active',
      openChangeTasks,
    };
  }

  async markPublished(
    tx: PubTx,
    product: ProductRef,
    versionId: string,
    publicationId: string,
    stage: 'test' | 'live',
    at: Date,
    fact?: { approvalId: string },
  ): Promise<void> {
    const v = await tx.pubContentVersion.findFirst({
      where: { id: versionId, productId: product.id },
      include: { content: true },
    });
    if (!v) throw new PubError('PUB_NOT_FOUND');
    // Повторные проверки (§7.1, аудит P2-15): согласование, hash, оффер,
    // источники, задачи изменения по версии. Отчёт о факте ручной публикации
    // Reddit (`fact`, Р-RD-AUD-5) их не проходит: текст уже опубликован.
    const { approvalId } = fact
      ? fact
      : await this.contents.recheckPublishable(tx, product, versionId);
    const c = v.content;
    if (!fact && c.publishedVersionId === versionId) {
      // Повторная публикация показанной версии (другой канал/стадия):
      // материал на проверке после изменения входов не распространяется.
      if (c.criticalStale)
        throw new PubError('PUB_CONTENT_STALE', { contentId: c.id });
      const open = await tx.pubReviewTask.findMany({
        where: {
          productId: product.id,
          status: 'open',
          objectType: 'content',
          objectId: c.id,
          reason: { in: CHANGE_TASK_REASONS },
        },
        select: { id: true },
      });
      if (open.length) {
        throw new PubError('PUB_BLOCKERS_OPEN', {
          blockers: open.map((t) => ({ code: 'change_task_open', id: t.id })),
        });
      }
    }
    if (stage === 'test') return;
    // Ещё одна live-публикация той же версии (другой канал) — статус не меняется.
    if (
      c.publishedVersionId === versionId &&
      ['published', 'revised', 'correction_required'].includes(c.status)
    ) {
      return;
    }
    const from = c.status as ContentStatus;
    const to: ContentStatus =
      from === 'correction_required' ? 'revised' : 'published';
    if (
      c.approvedVersionId !== versionId &&
      c.publishedVersionId !== versionId
    ) {
      throw new PubError('PUB_APPROVAL_REQUIRED', {
        versionId,
        reason: 'not_current_approved_version',
      });
    }
    // Роль проверил маршрут публикации P-C; здесь — только допустимость перехода.
    assertTransition(CONTENT_MACHINE, from, to);
    // Прежнее согласование опубликованной версии — superseded (аудит P1-1).
    const superseded: string[] = [];
    if (c.publishedVersionId && c.publishedVersionId !== versionId) {
      const prev = await tx.pubApproval.findMany({
        where: {
          productId: product.id,
          type: 'publish_version',
          objectType: 'content_version',
          objectId: c.publishedVersionId,
          status: 'active',
        },
        select: { id: true },
      });
      for (const a of prev) {
        const n = await tx.pubApproval.updateMany({
          where: { id: a.id, status: 'active' },
          data: { status: 'superseded', reason: 'newer_version_published' },
        });
        if (n.count === 1) superseded.push(a.id);
      }
      await tx.pubContentVersion.updateMany({
        where: { id: c.publishedVersionId, status: 'approved' },
        data: { status: 'superseded' },
      });
    }
    await tx.pubContent.update({
      where: { id: c.id },
      data: {
        status: to,
        publishedVersionId: versionId,
        approvedVersionId: versionId,
        // Отчёт о факте ручной публикации (`fact`, Р-RD-AUD-5) проверок не
        // проходил — флаг «на проверке после критичного изменения» остаётся
        // (ревью 2, п. 4): снимает его только выпуск через повторные проверки.
        ...(fact ? {} : { criticalStale: false }),
        ...(c.firstPublishedAt ? {} : { firstPublishedAt: at }),
        revision: { increment: 1 },
      },
    });
    // Аудит P-B1 S2-1: адаптации ПРЕЖНЕЙ показанной версии статьи опираются на
    // снятый текст — на проверку (`stale_check`): неопубликованные согласования
    // снимаются, показанные адаптации — `correction_required`.
    const prevShown = c.publishedVersionId;
    if (prevShown && prevShown !== versionId) {
      const derived = await tx.pubContentVersion.findMany({
        where: { productId: product.id, parentVersionId: prevShown },
        select: { id: true },
      });
      if (derived.length) {
        await this.cascades.run(tx, product, {
          reason: 'stale_check',
          triggerRef: `parent-replaced:${versionId}`,
          versionIds: derived.map((d) => d.id),
          critical: false,
          actor: SYSTEM_ACTOR,
          now: at,
        });
      }
    }
    const audit = this.ports.audit();
    for (const id of superseded) {
      await audit.write(tx, {
        accountId: product.accountId,
        productId: product.id,
        actor: SYSTEM_ACTOR,
        objectType: 'approval',
        objectId: id,
        action: 'transition',
        fromStatus: 'active',
        toStatus: 'superseded',
        meta: { cause: 'newer_version_published', versionId },
      });
    }
    await audit.write(tx, {
      accountId: product.accountId,
      productId: product.id,
      actor: SYSTEM_ACTOR,
      objectType: 'content',
      objectId: c.id,
      action: 'transition',
      fromStatus: from,
      toStatus: to,
      meta: {
        versionId,
        publicationId,
        approvalId,
        firstPublication: !c.firstPublishedAt,
      },
      occurredAt: at,
    });
  }

  async markWithdrawn(
    tx: PubTx,
    product: ProductRef,
    versionId: string,
    reason: string,
  ): Promise<void> {
    if (looksLikeContact(reason)) {
      throw new PubError('PUB_VALIDATION', {
        fields: [{ field: 'reason', code: 'pii' }],
      });
    }
    const v = await tx.pubContentVersion.findFirst({
      where: { id: versionId, productId: product.id },
      include: {
        content: {
          select: { id: true, status: true, publishedVersionId: true },
        },
      },
    });
    if (!v) throw new PubError('PUB_NOT_FOUND');
    const c = v.content;
    if (c.publishedVersionId !== versionId || c.status === 'withdrawn') return;
    const live = await tx.pubPublication.count({
      where: {
        productId: product.id,
        stage: 'live',
        status: { in: ['pending', 'published'] },
        version: { contentId: c.id },
      },
    });
    if (live > 0) return;
    assertTransition(CONTENT_MACHINE, c.status as ContentStatus, 'withdrawn');
    await tx.pubContent.update({
      where: { id: c.id },
      data: { status: 'withdrawn', revision: { increment: 1 } },
    });
    await this.ports.audit().write(tx, {
      accountId: product.accountId,
      productId: product.id,
      actor: SYSTEM_ACTOR,
      objectType: 'content',
      objectId: c.id,
      action: 'transition',
      fromStatus: c.status,
      toStatus: 'withdrawn',
      reason: reason.slice(0, 2000) || null,
      meta: { versionId },
    });
  }
}
