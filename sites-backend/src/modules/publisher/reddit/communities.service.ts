/**
 * AI Publisher, P-R — сообщества и реестр правил (reddit-manual-mvp-
 * adapted.md §M1.1, §M1.3; Р-RD-2, Р-RD-3; AT-RD-03, AT-RD-04).
 *
 *  - Сообщество создаётся в ОДНОЙ операции с каналом `community`
 *    (`ChannelsService` P-C: код `reddit-<name>`, `utmSource='reddit'`,
 *    `utmMedium='community'`) — публикации, UTM и отчёты работают через
 *    каналы. Имя нормализуется (`normalize.ts`), дубль → 409 `{existingId}`.
 *  - Снимок правил: первоисточник — строка `pub_sources` (kind=url, manual,
 *    private, restricted; `SourcesService` P-B1), сам снимок — append-only
 *    `pub_reddit_rule_snapshots` (version + 1, unreviewed). В той же
 *    транзакции прежний снимок → `superseded`, возможности сообщества в
 *    `new|qualified|in_brief` → `recheck_required` (`rules_changed`), аудит
 *    на каждый объект. Reddit-материалов в M1 нет — каскад контента
 *    (`content/cascades.ts`) подключается в M2.
 *  - Review (`reddit.rules.review`): своего снимка не запрещён, а
 *    помечается `selfReview` (триггер требует `selfReview = (reviewedBy =
 *    createdBy)`); требует первоисточник с URL и `checkedAt`.
 * Сети нет: URL правил хранится, но не загружается (Р-RD-0).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ProductCtx } from '../contracts/common';
import type {
  RedditCommunityView,
  RedditRuleSnapshotView,
} from '../contracts/reddit-api';
import {
  REDDIT_COMMUNITY_STATUSES,
  REDDIT_LINKS_POLICIES,
  REDDIT_PROMOTION_POLICIES,
} from '../contracts/states';
import { RedditMaterialsService } from '../content/reddit-materials.service';
import { SourcesService } from '../content/sources.service';
import { has, httpsUrl, Issues, type Body } from '../content/input';
import { PubError } from '../core/errors';
import { looksLikeContact } from '../core/pii-guard';
import type { AuditInput, PubTx } from '../core/ports';
import { casUpdate, parseExpectedRevision } from '../core/revision';
import { ChannelsService } from '../distribution/channels.service';
import { recheckOpportunities } from './cascade';
import {
  assertParentsActive,
  insertOrDuplicate,
  profileRefIssue,
} from './guards';
import {
  canonicalCommunityUrl,
  normalizeSubreddit,
  subredditIssue,
} from './normalize';
import { isSelfReview, type PubAccess } from '../core/roles';
import { localeField, onlyFields, type OpOut } from './projects.service';
import {
  communityRow,
  currentSnapshot,
  loadCommunityView,
  loadSnapshotView,
  projectRow,
} from './views';

/** Будущее `checkedAt` допускается в пределах сдвига часов. */
const CLOCK_SKEW_MS = 5 * 60_000;

export interface Step {
  actor: string;
  now: Date;
}

@Injectable()
export class RedditCommunitiesService {
  constructor(
    private readonly channels: ChannelsService,
    private readonly sources: SourcesService,
    private readonly materials: RedditMaterialsService,
  ) {}

  async create(
    tx: PubTx,
    product: ProductCtx,
    step: Step,
    b: Body,
  ): Promise<OpOut<RedditCommunityView>> {
    const is = new Issues();
    onlyFields(is, b, [
      'opKey',
      'projectId',
      'community',
      'descriptionManual',
      'language',
      'topics',
    ]);
    const projectId = is.str(b, 'projectId', { required: true, max: 100 });
    const rawName = is.str(b, 'community', { required: true, max: 300 });
    const name = rawName ? normalizeSubreddit(rawName) : null;
    // UI-аудит S3-2: `r/u_<ник>` — стабильный код `profile_ref`.
    if (rawName && !name) is.add('community', subredditIssue(rawName)!);
    const descriptionManual = is.str(b, 'descriptionManual', {
      max: 2000,
      pii: true,
    });
    const language = localeField(is, b, 'language', false);
    const topics = is.strings(b, 'topics', {
      maxItems: 20,
      maxLen: 64,
      pii: true,
    });
    is.throwIfAny();
    const project = await projectRow(tx, product.id, projectId!);
    if (project.status !== 'active') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'project_archived',
        from: project.status,
      });
    }
    const dup = await tx.pubRedditCommunity.findFirst({
      where: { productId: product.id, name: name! },
      select: { id: true },
    });
    if (dup) {
      throw new PubError('PUB_CONFLICT', {
        reason: 'duplicate',
        existingId: dup.id,
      });
    }
    let channelAudit: AuditInput[] = [];
    const row = await insertOrDuplicate(
      tx,
      async () => {
        const channel = await this.channels.create(tx, product, step, {
          code: `reddit-${name!}`,
          // Имя из 7+ цифр правило «похоже на телефон» отвергло бы (pii-guard
          // канала P-C) — тогда заголовок без имени, имя остаётся в `code`.
          title: looksLikeContact(`r/${name!}`)
            ? 'Reddit · спільнота'
            : `r/${name!}`,
          kind: 'community',
          utmSource: 'reddit',
          utmMedium: 'community',
        });
        channelAudit = channel.audit;
        return tx.pubRedditCommunity.create({
          data: {
            accountId: product.accountId,
            productId: product.id,
            projectId: project.id,
            channelId: channel.body.id,
            name: name!,
            canonicalUrl: canonicalCommunityUrl(name!),
            descriptionManual: descriptionManual ?? null,
            language: language ?? null,
            topics: topics ?? [],
            createdBy: step.actor,
          },
        });
      },
      async () =>
        (
          await tx.pubRedditCommunity.findFirst({
            where: { productId: product.id, name: name! },
            select: { id: true },
          })
        )?.id ?? null,
    );
    return {
      body: await loadCommunityView(tx, product.id, row.id, step.now),
      audit: [
        ...channelAudit,
        {
          objectType: 'reddit_community',
          objectId: row.id,
          action: 'create',
          toStatus: row.status,
          meta: { projectId: project.id, channelId: row.channelId },
        },
      ],
    };
  }

  async patch(
    tx: PubTx,
    product: ProductCtx,
    id: string,
    step: Step,
    b: Body,
  ): Promise<OpOut<RedditCommunityView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const cur = await communityRow(tx, product.id, id);
    const is = new Issues();
    onlyFields(is, b, [
      'opKey',
      'expectedRevision',
      'descriptionManual',
      'language',
      'topics',
      'status',
    ]);
    const data: Prisma.PubRedditCommunityUpdateManyMutationInput = {};
    if (has(b, 'descriptionManual') || b.descriptionManual === null)
      data.descriptionManual =
        is.str(b, 'descriptionManual', { max: 2000, pii: true }) ?? null;
    if (has(b, 'language') || b.language === null)
      data.language = localeField(is, b, 'language', false) ?? null;
    if (has(b, 'topics'))
      data.topics =
        is.strings(b, 'topics', { maxItems: 20, maxLen: 64, pii: true }) ?? [];
    if (has(b, 'status'))
      data.status = is.oneOf(b, 'status', REDDIT_COMMUNITY_STATUSES, true);
    is.throwIfAny();
    // Архивный проект: правка и восстановление его сообществ — 409 (S3-6).
    await assertParentsActive(tx, product.id, cur.projectId);
    await casUpdate(tx.pubRedditCommunity, id, expected, data);
    const view = await loadCommunityView(tx, product.id, id, step.now);
    return {
      body: view,
      audit: [
        {
          objectType: 'reddit_community',
          objectId: id,
          action:
            data.status && data.status !== cur.status ? 'transition' : 'update',
          fromStatus: cur.status,
          toStatus: view.status,
          meta: { fields: Object.keys(data) },
        },
      ],
    };
  }

  // ── Снимки правил ──────────────────────────────────────────────────────

  async createRules(
    tx: PubTx,
    product: ProductCtx,
    communityId: string,
    step: Step,
    b: Body,
  ): Promise<OpOut<RedditRuleSnapshotView>> {
    const is = new Issues();
    onlyFields(is, b, [
      'opKey',
      'sourceUrl',
      'sourceExcerpt',
      'promotionPolicy',
      'linksPolicy',
      'flairRequired',
      'conditions',
      'checkedAt',
    ]);
    const rawUrl = is.str(b, 'sourceUrl', { required: true, max: 2048 });
    const sourceUrl = rawUrl ? httpsUrl(rawUrl) : null;
    if (rawUrl && !sourceUrl) is.add('sourceUrl', 'format');
    const excerpt = is.str(b, 'sourceExcerpt', {
      required: true,
      max: 5000,
      pii: true,
    });
    const promotionPolicy = is.oneOf(
      b,
      'promotionPolicy',
      REDDIT_PROMOTION_POLICIES,
      true,
    );
    const linksPolicy = is.oneOf(b, 'linksPolicy', REDDIT_LINKS_POLICIES, true);
    const flairRequired = is.bool(b, 'flairRequired');
    const conditions = is.strings(b, 'conditions', {
      maxItems: 20,
      maxLen: 300,
      pii: true,
    });
    profileRefIssue(is, 'sourceExcerpt', excerpt);
    (conditions ?? []).forEach((c, i) =>
      profileRefIssue(is, `conditions[${i}]`, c),
    );
    const checkedAt = is.date(b, 'checkedAt');
    if (checkedAt === undefined && !has(b, 'checkedAt'))
      is.add('checkedAt', 'required');
    if (checkedAt === null) is.add('checkedAt', 'required');
    if (checkedAt && checkedAt.getTime() > step.now.getTime() + CLOCK_SKEW_MS)
      is.add('checkedAt', 'future');
    is.throwIfAny();
    // Сериализация версий сообщества: строка сообщества под блокировкой.
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status" FROM "sites"."pub_reddit_communities"
       WHERE "id" = ${communityId} AND "productId" = ${product.id}
       FOR UPDATE`;
    const community = locked[0];
    if (!community) throw new PubError('PUB_NOT_FOUND');
    if (community.status !== 'active') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'community_archived',
        from: community.status,
      });
    }
    await assertParentsActive(
      tx,
      product.id,
      (await communityRow(tx, product.id, communityId)).projectId,
    );
    const prev = await currentSnapshot(tx, product.id, communityId);
    const last = await tx.pubRedditRuleSnapshot.findFirst({
      where: { productId: product.id, communityId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (last?.version ?? 0) + 1;
    const source = await this.sources.create(
      tx,
      product,
      {
        kind: 'url',
        url: sourceUrl,
        title: `Правила спільноти Reddit · v${version}`,
        fragment: excerpt,
        visibility: 'private',
        usage: 'restricted',
      },
      step.actor,
      { origin: 'reddit' },
    );
    const audit: AuditInput[] = [...source.audit];
    if (prev) {
      await tx.pubRedditRuleSnapshot.updateMany({
        where: { id: prev.id, status: 'current' },
        data: { status: 'superseded' },
      });
      audit.push({
        objectType: 'reddit_rule_snapshot',
        objectId: prev.id,
        action: 'transition',
        fromStatus: 'current',
        toStatus: 'superseded',
        meta: { communityId, version: prev.version },
      });
    }
    const snap = await tx.pubRedditRuleSnapshot.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        communityId,
        version,
        sourceId: source.body.id,
        promotionPolicy: promotionPolicy!,
        linksPolicy: linksPolicy!,
        flairRequired: flairRequired ?? null,
        conditions: conditions ?? [],
        checkedAt: checkedAt!,
        createdBy: step.actor,
      },
    });
    audit.push({
      objectType: 'reddit_rule_snapshot',
      objectId: snap.id,
      action: 'create',
      toStatus: 'current',
      meta: {
        communityId,
        version,
        sourceId: source.body.id,
        promotionPolicy: snap.promotionPolicy,
        linksPolicy: snap.linksPolicy,
      },
    });
    audit.push(
      ...(await recheckOpportunities(tx, product, [communityId], {
        policy: 'recheck_required',
        reason: 'rules_changed',
        ruleSnapshotId: snap.id,
      })),
    );
    // M2 (хвост M2 (3), Р-RD-28 → Р-RD-50): Reddit-материалы сообщества с
    // принятым решением — каскад `stale_check` (согласования
    // неопубликованных версий → superseded, опубликованные → на исправление).
    await this.materials.onRulesChanged(
      tx,
      product,
      [communityId],
      `reddit-rules:${snap.id}`,
      step.actor,
      step.now,
    );
    return {
      body: await loadSnapshotView(tx, product.id, snap.id, step.now),
      audit,
    };
  }

  async review(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    snapshotId: string,
    step: Step,
    b: Body,
  ): Promise<OpOut<RedditRuleSnapshotView>> {
    const is = new Issues();
    onlyFields(is, b, ['opKey']);
    is.throwIfAny();
    const s = await tx.pubRedditRuleSnapshot.findFirst({
      where: { id: snapshotId, productId: product.id },
    });
    if (!s) throw new PubError('PUB_NOT_FOUND');
    if (s.reviewState !== 'unreviewed' || s.status !== 'current') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: s.status !== 'current' ? 'superseded' : 'already_reviewed',
        from: s.reviewState,
      });
    }
    const author = /^member:/.test(s.createdBy)
      ? s.createdBy.slice('member:'.length)
      : null;
    const selfReview = isSelfReview(access, 'reddit.rules.review', author);
    const r = await tx.pubRedditRuleSnapshot.updateMany({
      where: { id: s.id, reviewState: 'unreviewed', status: 'current' },
      data: {
        reviewState: 'reviewed',
        reviewedBy: step.actor,
        reviewedAt: step.now,
        selfReview,
      },
    });
    if (r.count !== 1) throw new PubError('PUB_CONFLICT');
    return {
      body: await loadSnapshotView(tx, product.id, s.id, step.now),
      audit: [
        {
          objectType: 'reddit_rule_snapshot',
          objectId: s.id,
          action: 'approve',
          fromStatus: 'unreviewed',
          toStatus: 'reviewed',
          meta: { communityId: s.communityId, version: s.version, selfReview },
        },
      ],
    };
  }
}
