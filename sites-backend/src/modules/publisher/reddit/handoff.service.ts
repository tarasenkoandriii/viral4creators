/**
 * AI Publisher, P-R M2 — «Отметить опубликованным» (reddit-manual-mvp-
 * adapted.md §M2.6; Р-RD-10, Р-RD-58; AT-RD-12, AT-RD-15).
 *
 * Сервер Reddit не открывает и URL не проверяет сетью: ссылка приводится к
 * канону (`normalizeReportedUrl`), сообщество — то же, что у брифа (A15),
 * у комментария — ссылка на комментарий в треде возможности. Запись
 * `pub_publications` — `PublicationsService.reportUserPublication` (P-C):
 * `reportKind='user_reported'`, `verifyStatus='not_checked'` навсегда,
 * стадия по общему правилу; материал отмечает `ContentPort.markPublished`.
 * Аудит — `report_publication`.
 *
 * Аудит 15.10.2026 (зона m2, Р-RD-AUD-5): отчёт — факт о версии, которую
 * КОПИРОВАЛИ (аудит `copy` с `versionId` утверждённой версии; нет — 409
 * `not_copied`); действующее согласование и блокеры не проверяются (каскад
 * правил после копирования не мешает отметить уже опубликованный текст);
 * `postedAt` не раньше первого копирования этой версии (допуск 1 мин) —
 * иначе 400 `postedAt: before_copy` (m2-10). Пост — канон без slug, прежние
 * строки со slug сопоставляются по ключу поста; ссылка «Поделиться» —
 * 400 `url: share_link` (m2-12). Материал блокируется `FOR UPDATE`.
 */
import { Injectable } from '@nestjs/common';
import type { ProductCtx } from '../contracts/common';
import type { RedditPublicationView } from '../contracts/reddit-api';
import { isRedditContentKind } from '../contracts/states';
import { Issues, type Body } from '../content/input';
import { PublicationsService } from '../distribution/publications.service';
import { PubError, validationError } from '../core/errors';
import type { PubTx } from '../core/ports';
import { redditPublicationViews } from './brief-views';
import {
  normalizeReportedUrl,
  normalizeThreadUrl,
  reportedPostUrlForms,
} from './normalize';
import { onlyFields, type OpOut } from './projects.service';
import { briefState } from './reddit-port';

/** Допуск часов клиента для `postedAt` (как у `checkedAt` правил). */
const FUTURE_SLACK_MS = 5 * 60_000;
/** Допуск назад: время в форме — с точностью до минуты. */
const PAST_SLACK_MS = 60_000;

@Injectable()
export class RedditHandoffService {
  constructor(private readonly publications: PublicationsService) {}

  async report(
    tx: PubTx,
    product: ProductCtx,
    contentId: string,
    step: { actor: string; now: Date },
    b: Body,
    opKey: string,
  ): Promise<OpOut<RedditPublicationView>> {
    const is = new Issues();
    onlyFields(is, b, ['opKey', 'url', 'postedAt', 'notes']);
    const urlRaw = is.str(b, 'url', { required: true, max: 2048 });
    const postedAt = is.date(b, 'postedAt');
    if (b.postedAt === undefined || b.postedAt === null)
      is.add('postedAt', 'required');
    const notes = is.str(b, 'notes', { max: 1000, pii: true });
    is.throwIfAny();
    if (postedAt && postedAt.getTime() > step.now.getTime() + FUTURE_SLACK_MS)
      throw validationError([{ field: 'postedAt', code: 'future' }]);
    // Отчёты по материалу сериализуются с копированием и снятием с плана.
    await tx.$queryRaw`SELECT "id" FROM "sites"."pub_contents" WHERE "id" = ${contentId} AND "productId" = ${product.id} FOR UPDATE`;
    const c = await tx.pubContent.findFirst({
      where: { id: contentId, productId: product.id },
      select: {
        id: true,
        kind: true,
        status: true,
        redditBriefId: true,
        approvedVersionId: true,
        createdAt: true,
      },
    });
    if (!c || !isRedditContentKind(c.kind) || !c.redditBriefId)
      throw new PubError('PUB_NOT_FOUND');
    // Раунд 4 (аудит экранов S3-5): дата публикации не раньше создания
    // материала (он создаётся из брифа — значит, и не раньше брифа).
    if (postedAt && postedAt.getTime() < c.createdAt.getTime() - PAST_SLACK_MS)
      throw validationError([{ field: 'postedAt', code: 'before_material' }]);
    if (
      !['scheduled', 'published', 'revised'].includes(c.status) ||
      !c.approvedVersionId
    )
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'not_copied',
        from: c.status,
      });
    // Р-RD-AUD-5: версию копировали; дата — не раньше первого копирования.
    const copies = await tx.pubAuditEvent.findMany({
      where: {
        productId: product.id,
        objectType: 'content',
        objectId: c.id,
        action: 'copy',
        meta: { path: ['versionId'], equals: c.approvedVersionId },
      },
      orderBy: { occurredAt: 'asc' },
      take: 1,
      select: { occurredAt: true },
    });
    if (!copies.length)
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'not_copied',
        from: c.status,
      });
    if (
      postedAt &&
      postedAt.getTime() < copies[0].occurredAt.getTime() - PAST_SLACK_MS
    )
      throw validationError([{ field: 'postedAt', code: 'before_copy' }]);
    const st = await briefState(tx, product.id, c.redditBriefId);
    const n = normalizeReportedUrl(urlRaw);
    if ('issue' in n) throw validationError([{ field: 'url', code: n.issue }]);
    const u = n.ok;
    if (u.subreddit !== st.community.name)
      throw validationError([{ field: 'url', code: 'community_mismatch' }]);
    if (c.kind === 'reddit_comment') {
      if (!u.commentId)
        throw validationError([{ field: 'url', code: 'comment_required' }]);
      const thread = st.opportunity
        ? normalizeThreadUrl(st.opportunity.threadUrl)
        : null;
      if (!thread || thread.threadKey !== u.threadKey)
        throw validationError([{ field: 'url', code: 'thread_mismatch' }]);
    } else if (u.commentId) {
      throw validationError([{ field: 'url', code: 'format' }]);
    }
    const out = await this.publications.reportUserPublication(
      tx,
      product,
      step,
      {
        versionId: c.approvedVersionId,
        channelId: st.community.channelId,
        finalUrl: u.url,
        publishedAt: postedAt!,
        opKey,
        ...(u.commentId ? {} : { postForms: reportedPostUrlForms(u.url) }),
      },
    );
    const row = await tx.pubPublication.findFirstOrThrow({
      where: { id: out.body.id, productId: product.id },
    });
    const [view] = await redditPublicationViews(tx, product.id, [row]);
    return {
      body: view,
      audit: [
        {
          objectType: 'publication',
          objectId: row.id,
          action: 'report_publication',
          toStatus: row.status,
          reason: notes ?? null,
          meta: {
            contentId: c.id,
            versionId: row.versionId,
            stage: row.stage,
            reportKind: row.reportKind,
            comment: !!u.commentId,
          },
        },
        // m2-9: прежняя публикация того же URL — `replaced` (после отчёта).
        ...out.audit,
      ],
    };
  }
}
