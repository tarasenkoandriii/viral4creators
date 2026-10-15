/**
 * AI Publisher, P-R M2 — реализация `REDDIT_PORT` (reddit-manual-mvp-
 * adapted.md §M2.1, §M2.4, §M2.6; Р-RD-50): P-B1 узнаёт отсюда, что нужно
 * Reddit-материалу (бриф, сообщество, тред, текущий снимок правил), и
 * получает детерминированную проверку `reddit_policy` (`checks.ts`). Порт
 * только читает; строки пишет P-B1.
 */
import { Injectable } from '@nestjs/common';
import {
  REDDIT_AFFILIATIONS,
  REDDIT_CONTENT_KIND_OF,
  type RedditAffiliation,
  type RedditContentType,
} from '../contracts/states';
import { PubError } from '../core/errors';
import { addKyivCalendarDays } from '../core/kyiv-time';
import type {
  ProductRef,
  PubTx,
  RedditMaterialContext,
  RedditPolicyCheck,
  RedditPort,
  RedditRulesStale,
} from '../core/ports';
import {
  briefMissing,
  commentServiceTitle,
  keyPointSourceIds,
  keyPointsOf,
} from './brief-rules';
import { redditChecks, type RedditClaim } from './checks';
import { DUPLICATE_WINDOW_DAYS } from './markers';

/** Сколько чужих Reddit-версий читается для проверки дублей (m2-15). */
export const DUPLICATE_SCAN_LIMIT = 200;
import { snapshotState } from './policy';
import { currentRules, policySnapshotOf, staleDaysFor } from './views';

/** `meta.affiliation` версии, если это значение списка. */
function versionAffiliation(
  meta: Record<string, unknown>,
): RedditAffiliation | null {
  const a = meta.affiliation;
  return typeof a === 'string' &&
    (REDDIT_AFFILIATIONS as readonly string[]).includes(a)
    ? (a as RedditAffiliation)
    : null;
}

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Разобранный бриф с тем, что о нём известно сейчас. */
export async function briefState(
  tx: PubTx,
  productId: string,
  briefId: string,
) {
  const brief = await tx.pubRedditBrief.findFirst({
    where: { id: briefId, productId },
  });
  if (!brief) throw new PubError('PUB_NOT_FOUND');
  const keyPoints = keyPointsOf(brief.keyPoints);
  const ids = keyPointSourceIds(keyPoints);
  const [community, opportunity, offer, allowed] = await Promise.all([
    tx.pubRedditCommunity.findFirstOrThrow({
      where: { id: brief.communityId, productId },
      select: { id: true, name: true, canonicalUrl: true, channelId: true },
    }),
    brief.opportunityId
      ? tx.pubRedditOpportunity.findFirst({
          where: { id: brief.opportunityId, productId },
          select: {
            id: true,
            threadUrl: true,
            titleManual: true,
            excerptSourceId: true,
            status: true,
          },
        })
      : Promise.resolve(null),
    tx.pubOfferVersion.findFirst({
      where: { id: brief.offerVersionId, productId },
      select: { status: true },
    }),
    ids.length
      ? tx.pubSource.findMany({
          where: {
            productId,
            id: { in: ids },
            usage: 'allowed',
            origin: 'content',
          },
          select: { id: true },
        })
      : Promise.resolve([] as Array<{ id: string }>),
  ]);
  const missing = briefMissing({
    objective: brief.objective,
    affiliation: brief.affiliation,
    brand: brief.brand,
    contentType: brief.contentType as RedditContentType,
    context: brief.context,
    opportunityId: brief.opportunityId,
    keyPoints,
    offerActive: offer?.status === 'active',
    allowedSourceIds: new Set(allowed.map((s) => s.id)),
  });
  return { brief, keyPoints, community, opportunity, missing };
}

@Injectable()
export class RedditPortImpl implements RedditPort {
  async materialContext(
    tx: PubTx,
    product: ProductRef,
    redditBriefId: string,
  ): Promise<RedditMaterialContext> {
    const st = await briefState(tx, product.id, redditBriefId);
    const rules = (await currentRules(tx, product.id, [st.community.id])).get(
      st.community.id,
    );
    const contentType = st.brief.contentType as RedditContentType;
    return {
      briefId: st.brief.id,
      kind: REDDIT_CONTENT_KIND_OF[contentType],
      briefStatus: st.brief.status,
      briefMissing: st.missing,
      offerVersionId: st.brief.offerVersionId,
      affiliation: st.brief.affiliation,
      projectId: st.brief.projectId,
      communityId: st.community.id,
      subreddit: st.community.name,
      canonicalUrl: st.community.canonicalUrl,
      channelId: st.community.channelId,
      opportunityId: st.brief.opportunityId,
      threadUrl: st.opportunity?.threadUrl ?? null,
      serviceTitle:
        contentType === 'comment'
          ? commentServiceTitle(
              st.community.name,
              st.opportunity?.titleManual ?? st.brief.objective,
            )
          : null,
      currentSnapshotId: rules?.snap.id ?? null,
    };
  }

  /** Версия Reddit-материала со всем, что нужно проверке. */
  private async versionOf(tx: PubTx, productId: string, versionId: string) {
    const v = await tx.pubContentVersion.findFirst({
      where: { id: versionId, productId },
      select: {
        id: true,
        contentId: true,
        title: true,
        body: true,
        meta: true,
        content: { select: { kind: true, redditBriefId: true } },
      },
    });
    if (!v || !v.content.redditBriefId) throw new PubError('PUB_NOT_FOUND');
    return v;
  }

  async check(
    tx: PubTx,
    product: ProductRef,
    versionId: string,
    now: Date,
  ): Promise<RedditPolicyCheck> {
    const v = await this.versionOf(tx, product.id, versionId);
    const st = await briefState(tx, product.id, v.content.redditBriefId!);
    const rules = (await currentRules(tx, product.id, [st.community.id])).get(
      st.community.id,
    );
    const staleDays = await staleDaysFor(tx, product.id);
    const meta = (v.meta ?? {}) as Record<string, unknown>;
    const claimMap = (Array.isArray(meta.claimMap) ? meta.claimMap : []).filter(
      (c): c is RedditClaim =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as RedditClaim).text === 'string',
    );
    const ids = [
      ...new Set(
        claimMap.flatMap((c) =>
          Array.isArray(c.sourceIds) ? c.sourceIds : [],
        ),
      ),
    ];
    const sources = ids.length
      ? await tx.pubSource.findMany({
          where: { productId: product.id, id: { in: ids } },
          // Аудит m2-7: текст источника — сверка чисел пункта claimMap.
          select: { id: true, usage: true, origin: true, fragment: true },
        })
      : [];
    const excerpt = st.opportunity?.excerptSourceId
      ? await tx.pubSource.findFirst({
          where: { id: st.opportunity.excerptSourceId, productId: product.id },
          select: { usage: true, fragment: true },
        })
      : null;
    const since = addKyivCalendarDays(now, -DUPLICATE_WINDOW_DAYS);
    // Аудит m2-15: для дублей — версии того же языка (основной подтег
    // брифа), только замороженные или текущие версии других материалов
    // (старые черновики не читаются), не больше DUPLICATE_SCAN_LIMIT.
    const lang = st.brief.language.split('-')[0].toLowerCase();
    const others = await tx.pubContentVersion.findMany({
      where: {
        productId: product.id,
        contentId: { not: v.contentId },
        createdAt: { gte: since },
        content: {
          kind: { in: ['reddit_post', 'reddit_comment'] },
          redditBrief: {
            language: { startsWith: lang, mode: 'insensitive' },
          },
        },
        OR: [
          { frozenAt: { not: null } },
          { contentCurrentVersionOf: { some: {} } },
        ],
      },
      select: { id: true, title: true, body: true, format: true },
      orderBy: { createdAt: 'desc' },
      take: DUPLICATE_SCAN_LIMIT,
    });
    const offer = await tx.pubOfferVersion.findFirst({
      where: { id: st.brief.offerVersionId, productId: product.id },
      select: { text: true },
    });
    const isComment = v.content.kind === 'reddit_comment';
    // Аудит m2-6: «число из брифа» — только из цели, аудитории, тезисов с
    // источником (не `needs_verification`), оффера; контекст комментария —
    // выдержка чужого треда по умолчанию: его числа, которые есть в
    // выдержке, из брифа не засчитываются (`threadTexts`); без выдержки
    // контекст комментария не засчитывается вовсе.
    const excerptText =
      excerpt && excerpt.usage !== 'revoked' ? excerpt.fragment : null;
    const contextUsable = !isComment || excerptText !== null;
    const r = redditChecks({
      contentType: isComment ? 'comment' : 'post',
      title: isComment ? null : v.title,
      body: v.body,
      disclosure: typeof meta.disclosure === 'string' ? meta.disclosure : '',
      flairSuggestion:
        typeof meta.flairSuggestion === 'string' ? meta.flairSuggestion : null,
      claimMap,
      versionSnapshotId:
        typeof meta.ruleSnapshotId === 'string' ? meta.ruleSnapshotId : null,
      brief: {
        // Р-RD-66 (аудит M2 S2-1): аффилированность — ЗАМОРОЖЕННОЙ версии
        // (входит в hash); черновик без неё — текущая брифа.
        affiliation:
          versionAffiliation(meta) ??
          (st.brief.affiliation as RedditAffiliation | null),
        linksAllowed: st.brief.linksAllowed,
        forbiddenClaims: strArray(st.brief.forbiddenClaims),
        brand: st.brief.brand,
      },
      contextTexts: [
        st.brief.objective,
        st.brief.audience ?? '',
        contextUsable ? (st.brief.context ?? '') : '',
        ...st.keyPoints
          .filter((k) => Array.isArray(k.sourceIds))
          .map((k) => k.text),
        offer?.text ?? '',
      ],
      threadTexts: isComment && excerptText ? [excerptText] : [],
      snapshot: rules
        ? {
            ...policySnapshotOf(rules.snap, rules.sourceRevoked),
            id: rules.snap.id,
            flairRequired: rules.snap.flairRequired,
          }
        : null,
      now,
      staleDays,
      thread: isComment
        ? {
            url: st.opportunity?.threadUrl ?? null,
            hasExcerpt: !!excerpt && excerpt.usage !== 'revoked',
          }
        : null,
      sources: new Map(
        sources.map((s) => [
          s.id,
          { usage: s.usage, origin: s.origin, fragment: s.fragment },
        ]),
      ),
      others: others.map((o) => ({
        versionId: o.id,
        text: `${o.format === 'reddit_post' ? o.title : ''}\n${o.body}`,
      })),
    });
    return { ...r, snapshotId: rules?.snap.id ?? null };
  }

  async rulesStale(
    tx: PubTx,
    product: ProductRef,
    versionId: string,
    now: Date,
  ): Promise<RedditRulesStale | null> {
    const v = await this.versionOf(tx, product.id, versionId);
    const brief = await tx.pubRedditBrief.findFirstOrThrow({
      where: { id: v.content.redditBriefId!, productId: product.id },
      select: { communityId: true },
    });
    const rules = (await currentRules(tx, product.id, [brief.communityId])).get(
      brief.communityId,
    );
    const meta = (v.meta ?? {}) as Record<string, unknown>;
    const mine =
      typeof meta.ruleSnapshotId === 'string' ? meta.ruleSnapshotId : null;
    const current = rules?.snap.id ?? null;
    if (mine !== current)
      return {
        reason: 'rules_changed',
        ruleSnapshotId: mine,
        currentSnapshotId: current,
      };
    if (
      rules &&
      snapshotState(
        policySnapshotOf(rules.snap),
        now,
        await staleDaysFor(tx, product.id),
      ) === 'stale'
    )
      return {
        reason: 'rules_stale',
        ruleSnapshotId: mine,
        currentSnapshotId: current,
      };
    return null;
  }
}
