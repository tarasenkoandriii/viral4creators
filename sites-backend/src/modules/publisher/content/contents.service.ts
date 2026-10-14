/**
 * AI Publisher, P-B1 — материалы, адаптации и версии (проектный документ
 * §6.3 `pub_contents`, `pub_content_versions`, §7.1; F03, F04, F06;
 * AT-CORE-10, AT-F06-01).
 *
 *  - материал: статья (по брифу, со slug) или адаптация (`post|cards|
 *    checklist|video_script`, у родителя есть согласованная версия);
 *  - версия: черновик правится только с ревизией (CAS, параллельная правка
 *    — 409), `submit` замораживает версию ОДНИМ UPDATE (`hash` +
 *    `frozenAt`, контракт P-A0) — дальше текст и связи неизменны
 *    (триггеры); hash — с содержимым claims, источников, фактов и связями
 *    claim → источник (`version-hash.ts`);
 *  - новая версия после согласования снимает согласование только ЕЩЁ НЕ
 *    опубликованной версии (аудит P1-1): опубликованная продолжает
 *    показываться до публикации новой;
 *  - ручные переходы машины 7.1 (`transition`): `request_changes`,
 *    `schedule`/`unschedule`, `needs_correction`, `confirm_unaffected`,
 *    `withdraw`; остальные — своими действиями (версия, отправка,
 *    согласование, публикация через `ContentPort`).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  ContentView,
  VersionDiff,
  VersionView,
} from '../contracts/content-api';
import {
  CONTENT_BLOCK_REASONS,
  CONTENT_KINDS,
  isRedditContentKind,
  type ContentStatus,
} from '../contracts/states';
import { contentVersionHash } from '../core/content-hash';
import { looksLikeContact } from '../core/pii-guard';
import { PubError, validationError } from '../core/errors';
import {
  PubPorts,
  type AuditInput,
  type ProductRef,
  type PubTx,
} from '../core/ports';
import { casUpdate, parseExpectedRevision } from '../core/revision';
import {
  CONTENT_MACHINE,
  assertTransition,
  type Actor,
} from '../core/state-machines';
import { has, Issues, type Body } from './input';
import {
  acceptAiCall,
  assertActiveFactIds,
  assertAiCall,
  assertClaimIds,
  assertSourceIds,
} from './refs';
import {
  checkRedditVersionMeta,
  checkVersionMeta,
  claimMapSourceIds,
  formatIssues,
  hasRawHtml,
  lineDiff,
  metaChangedKeys,
  setDiff,
  type RedditClientMeta,
} from './rules';
import { writeRedditPolicyCheck } from './reddit-policy-check';
import type { RedditMaterialContext } from '../core/ports';
import type { OpOut } from './sources.service';
import { assertHashCurrent, versionHashInput } from './version-hash';
import { approvalBlockers } from './blockers';
import {
  CHANGE_TASK_REASONS,
  loadBrief,
  loadContent,
  loadVersion,
} from './views';

const SLUG_RE = /^[a-z0-9-]{3,80}$/;

/**
 * Slug, «похожий на контакт» (7+ цифр подряд — правило P-A1 `PII_RULE`),
 * приём событий отбрасывает (`contentSlug` → null, путь → `/`), и
 * атрибуция материала теряется: такой slug запрещён при создании и правке
 * — 400 `slug: contact_like` (Р-PUB-Z2-16).
 */
export function slugLooksLikeContact(slug: string | null | undefined): boolean {
  return !!slug && looksLikeContact(slug);
}
const MEMBER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Статусы, из которых создаётся новая версия (переход → drafting). */
const NEW_VERSION_FROM: ContentStatus[] = [
  'brief',
  'drafting',
  'changes_requested',
  'approved',
  'correction_required',
];

interface Links {
  sourceIds: string[];
  claimIds: string[];
  factIds: string[];
}

@Injectable()
export class ContentsService {
  constructor(private readonly ports: PubPorts) {}

  // ── Материал ───────────────────────────────────────────────────────────

  async create(
    tx: PubTx,
    product: ProductRef,
    b: Body,
    actor: string,
  ): Promise<OpOut<ContentView>> {
    const is = new Issues();
    const kind = is.oneOf(b, 'kind', CONTENT_KINDS, true);
    const briefId = is.str(b, 'briefId', { max: 100 });
    const parentContentId = is.str(b, 'parentContentId', { max: 100 });
    const slug = is.str(b, 'slug', { max: 80, re: SLUG_RE });
    if (slugLooksLikeContact(slug)) is.add('slug', 'contact_like');
    const ownerMemberId = is.str(b, 'ownerMemberId', {
      max: 64,
      re: MEMBER_ID_RE,
    });
    const ownerDisplayName = is.str(b, 'ownerDisplayName', {
      max: 200,
      pii: true,
    });
    if (kind && isRedditContentKind(kind)) {
      // P-R M2 (Р-RD-49): Reddit-материал создаётся из Reddit-брифа
      // (`POST …/reddit/briefs/:id/contents`), не общим маршрутом.
      is.add('kind', 'reddit_route');
    } else if (kind === 'article') {
      if (!briefId) is.add('briefId', 'required');
      if (parentContentId) is.add('parentContentId', 'not_allowed');
    } else if (kind) {
      if (!parentContentId) is.add('parentContentId', 'required');
      if (slug) is.add('slug', 'not_allowed');
    }
    is.throwIfAny();
    if (kind === 'article') {
      const br = await tx.pubBrief.findFirst({
        where: { id: briefId!, productId: product.id },
        select: { status: true },
      });
      if (!br) throw validationError([{ field: 'briefId', code: 'not_found' }]);
      if (br.status === 'rejected') {
        throw validationError([{ field: 'briefId', code: 'brief_rejected' }]);
      }
    } else {
      await this.parentApprovedVersion(tx, product.id, parentContentId!);
    }
    if (slug) await this.slugFree(tx, product.id, slug, null);
    const row = await tx.pubContent.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        kind: kind!,
        briefId: kind === 'article' ? briefId! : (briefId ?? null),
        parentContentId: kind === 'article' ? null : parentContentId!,
        slug: slug ?? null,
        status: 'brief',
        ownerMemberId: ownerMemberId ?? null,
        ownerDisplayName: ownerDisplayName ?? null,
        createdBy: actor,
      },
    });
    return {
      body: await loadContent(tx, product.id, row.id),
      audit: [
        {
          objectType: 'content',
          objectId: row.id,
          action: 'create',
          toStatus: 'brief',
          meta: {
            kind: row.kind,
            briefId: row.briefId,
            parentContentId: row.parentContentId,
          },
        },
      ],
    };
  }

  /** Согласованная версия родительской статьи (для адаптации, F06). */
  private async parentApprovedVersion(
    tx: PubTx,
    productId: string,
    parentContentId: string,
  ): Promise<string[]> {
    const p = await tx.pubContent.findFirst({
      where: { id: parentContentId, productId },
      select: { kind: true, approvedVersionId: true, publishedVersionId: true },
    });
    if (!p || p.kind !== 'article') {
      throw validationError([{ field: 'parentContentId', code: 'not_found' }]);
    }
    const ids = [p.approvedVersionId, p.publishedVersionId].filter(
      (x): x is string => !!x,
    );
    const approved = ids.length
      ? await tx.pubApproval.findMany({
          where: {
            productId,
            type: 'publish_version',
            objectType: 'content_version',
            objectId: { in: ids },
            status: 'active',
          },
          select: { objectId: true },
        })
      : [];
    if (approved.length === 0) {
      throw validationError([
        { field: 'parentContentId', code: 'parent_not_approved' },
      ]);
    }
    return approved.map((a) => a.objectId);
  }

  private async slugFree(
    tx: PubTx,
    productId: string,
    slug: string,
    selfId: string | null,
  ): Promise<void> {
    const other = await tx.pubContent.findFirst({
      where: { productId, slug, ...(selfId ? { id: { not: selfId } } : {}) },
      select: { id: true },
    });
    if (other) throw new PubError('PUB_CONFLICT', { reason: 'slug_taken' });
  }

  async patch(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
  ): Promise<OpOut<ContentView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const cur = await tx.pubContent.findFirst({
      where: { id, productId: product.id },
    });
    if (!cur) throw new PubError('PUB_NOT_FOUND');
    const is = new Issues();
    const d: Record<string, unknown> = {};
    if (has(b, 'slug')) {
      const slug = is.str(b, 'slug', { max: 80, re: SLUG_RE }) ?? null;
      if (slugLooksLikeContact(slug)) is.add('slug', 'contact_like');
      if (cur.kind !== 'article' && slug) is.add('slug', 'not_allowed');
      // Опубликованный URL не меняется молча (публикация держит finalUrl).
      if (cur.firstPublishedAt && slug !== cur.slug)
        is.add('slug', 'published');
      d.slug = slug;
    }
    if (has(b, 'ownerMemberId')) {
      d.ownerMemberId =
        is.str(b, 'ownerMemberId', { max: 64, re: MEMBER_ID_RE }) ?? null;
    }
    if (has(b, 'ownerDisplayName')) {
      d.ownerDisplayName =
        is.str(b, 'ownerDisplayName', { max: 200, pii: true }) ?? null;
    }
    if (has(b, 'nextDueAt')) d.nextDueAt = is.date(b, 'nextDueAt') ?? null;
    if (has(b, 'blockReason')) {
      d.blockReason =
        b.blockReason === null
          ? null
          : is.oneOf(b, 'blockReason', CONTENT_BLOCK_REASONS, true);
    }
    is.throwIfAny();
    if (typeof d.slug === 'string')
      await this.slugFree(tx, product.id, d.slug, id);
    await casUpdate(tx.pubContent, id, expected, d);
    return {
      body: await loadContent(tx, product.id, id),
      audit: [
        {
          objectType: 'content',
          objectId: id,
          action: 'update',
          meta: { fields: Object.keys(d).sort() },
        },
      ],
    };
  }

  // ── Версии ─────────────────────────────────────────────────────────────

  private readVersionFields(
    is: Issues,
    b: Body,
    create: boolean,
  ): { data: Record<string, unknown>; links: Partial<Links> } {
    const data: Record<string, unknown> = {};
    const opt = (k: string) => create || has(b, k);
    if (opt('title'))
      data.title = is.str(b, 'title', { required: true, max: 300 });
    if (opt('body')) {
      const body = b.body;
      if (typeof body !== 'string' && !(create && body === undefined))
        is.add('body', 'type');
      else {
        const s = typeof body === 'string' ? body : '';
        if (s.length > 200_000) is.add('body', 'length');
        else if (hasRawHtml(s)) is.add('body', 'raw_html');
        else data.body = s;
      }
    }
    if (opt('meta')) {
      const m = checkVersionMeta(b.meta);
      m.issues.forEach((x) => is.add(x.field, x.code));
      data.meta = m.meta;
    }
    if (opt('offerVersionId')) {
      data.offerVersionId = is.str(b, 'offerVersionId', {
        required: true,
        max: 100,
      });
    }
    if (has(b, 'parentVersionId')) {
      data.parentVersionId = is.str(b, 'parentVersionId', { max: 100 }) ?? null;
    }
    const links: Partial<Links> = {};
    for (const k of ['sourceIds', 'claimIds', 'factIds'] as const) {
      if (opt(k)) links[k] = is.ids(b, k, 200) ?? [];
    }
    return { data, links };
  }

  private async checkVersionRefs(
    tx: PubTx,
    productId: string,
    data: Record<string, unknown>,
    links: Partial<Links>,
  ): Promise<void> {
    if (typeof data.offerVersionId === 'string') {
      const o = await tx.pubOfferVersion.findFirst({
        where: { id: data.offerVersionId, productId },
        select: { status: true },
      });
      if (!o)
        throw validationError([{ field: 'offerVersionId', code: 'not_found' }]);
      if (o.status !== 'active') {
        throw validationError([
          { field: 'offerVersionId', code: 'offer_inactive' },
        ]);
      }
    }
    if (links.sourceIds) await assertSourceIds(tx, productId, links.sourceIds);
    if (links.claimIds) await assertClaimIds(tx, productId, links.claimIds);
    if (links.factIds) await assertActiveFactIds(tx, productId, links.factIds);
  }

  private async replaceLinks(
    tx: PubTx,
    product: ProductRef,
    versionId: string,
    links: Partial<Links>,
    actor: string,
  ): Promise<void> {
    const base = {
      accountId: product.accountId,
      productId: product.id,
      versionId,
      createdBy: actor,
    };
    if (links.sourceIds) {
      await tx.pubVersionSource.deleteMany({
        where: { versionId, productId: product.id },
      });
      if (links.sourceIds.length) {
        await tx.pubVersionSource.createMany({
          data: links.sourceIds.map((sourceId) => ({ ...base, sourceId })),
        });
      }
    }
    if (links.claimIds) {
      await tx.pubVersionClaim.deleteMany({
        where: { versionId, productId: product.id },
      });
      if (links.claimIds.length) {
        await tx.pubVersionClaim.createMany({
          data: links.claimIds.map((claimId) => ({ ...base, claimId })),
        });
      }
    }
    if (links.factIds) {
      await tx.pubVersionFact.deleteMany({
        where: { versionId, productId: product.id },
      });
      if (links.factIds.length) {
        await tx.pubVersionFact.createMany({
          data: links.factIds.map((factId) => ({ ...base, factId })),
        });
      }
    }
  }

  /** Снять согласование ещё не опубликованной версии (аудит P1-1). */
  private async supersedeUnpublished(
    tx: PubTx,
    product: ProductRef,
    content: {
      approvedVersionId: string | null;
      publishedVersionId: string | null;
    },
    cause: string,
    audit: AuditInput[],
  ): Promise<void> {
    const vid = content.approvedVersionId;
    if (!vid || vid === content.publishedVersionId) return;
    const rows = await tx.pubApproval.findMany({
      where: {
        productId: product.id,
        type: 'publish_version',
        objectType: 'content_version',
        objectId: vid,
        status: 'active',
      },
      select: { id: true },
    });
    for (const a of rows) {
      await tx.pubApproval.updateMany({
        where: { id: a.id, status: 'active' },
        data: { status: 'superseded', reason: cause },
      });
      audit.push({
        objectType: 'approval',
        objectId: a.id,
        action: 'transition',
        fromStatus: 'active',
        toStatus: 'superseded',
        meta: { cause },
      });
    }
    await tx.pubContentVersion.updateMany({
      where: { id: vid, productId: product.id, status: 'approved' },
      data: { status: 'superseded' },
    });
  }

  async createVersion(
    tx: PubTx,
    product: ProductRef,
    contentId: string,
    b: Body,
    m: { memberId: string; actor: string; actors: Actor[] },
    now: Date,
  ): Promise<OpOut<VersionView>> {
    const c = await tx.pubContent.findFirst({
      where: { id: contentId, productId: product.id },
    });
    if (!c) throw new PubError('PUB_NOT_FOUND');
    if (isRedditContentKind(c.kind)) {
      return this.createRedditVersion(tx, product, c, b, m, now);
    }
    const is = new Issues();
    const { data, links } = this.readVersionFields(is, b, true);
    const aiRaw = is.str(b, 'aiCallId', { max: 100 });
    if (c.kind === 'article' && data.parentVersionId)
      is.add('parentVersionId', 'not_allowed');
    if (c.kind !== 'article' && !data.parentVersionId)
      is.add('parentVersionId', 'required');
    is.throwIfAny();
    const from = c.status as ContentStatus;
    if (!NEW_VERSION_FROM.includes(from)) {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'content',
        from,
        to: 'drafting',
        allowed: [],
        hint: 'new_version_not_allowed_in_status',
      });
    }
    if (c.currentVersionId) {
      const curV = await tx.pubContentVersion.findFirst({
        where: { id: c.currentVersionId },
        select: { status: true },
      });
      if (curV?.status === 'draft') {
        throw new PubError('PUB_CONFLICT', {
          reason: 'draft_exists',
          versionId: c.currentVersionId,
        });
      }
    }
    if (from !== 'drafting') {
      assertTransition(CONTENT_MACHINE, from, 'drafting', { actors: m.actors });
    }
    if (from === 'brief' && c.kind === 'article') {
      // Аудит P-B1 S3-5: не только статус — бриф мог устареть после `ready`
      // (оффер заменён, источник отозван).
      const br = await loadBrief(tx, product.id, c.briefId!);
      if (br.status !== 'ready' || br.missing.length) {
        throw new PubError('PUB_BRIEF_NOT_READY', {
          missing:
            br.status !== 'ready' ? ['brief_ready', ...br.missing] : br.missing,
        });
      }
    }
    if (c.kind !== 'article') {
      const parentOk = await this.parentApprovedVersion(
        tx,
        product.id,
        c.parentContentId!,
      );
      if (!parentOk.includes(data.parentVersionId as string)) {
        throw validationError([
          { field: 'parentVersionId', code: 'parent_not_approved' },
        ]);
      }
    }
    await this.checkVersionRefs(tx, product.id, data, links);
    const generators =
      c.kind === 'article'
        ? (['pub.draft.write'] as const)
        : (['pub.adaptation.make'] as const);
    const aiCallId = await assertAiCall(tx, product.id, aiRaw, generators);
    const last = await tx.pubContentVersion.findFirst({
      where: { contentId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    const audit: AuditInput[] = [];
    if (from === 'approved' || from === 'correction_required') {
      await this.supersedeUnpublished(tx, product, c, 'new_version', audit);
    }
    const v = await tx.pubContentVersion.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        contentId,
        number: (last?.number ?? 0) + 1,
        title: data.title as string,
        body: (data.body as string) ?? '',
        meta: (data.meta ?? {}) as Prisma.InputJsonObject,
        format: c.kind,
        parentVersionId: (data.parentVersionId as string | undefined) ?? null,
        offerVersionId: data.offerVersionId as string,
        authorMemberId: m.memberId,
        aiCallId,
        status: 'draft',
        createdBy: m.actor,
      },
    });
    await this.replaceLinks(tx, product, v.id, links, m.actor);
    await tx.pubContent.update({
      where: { id: contentId },
      data: {
        currentVersionId: v.id,
        status: 'drafting',
        ...(from === 'approved'
          ? { approvedVersionId: c.publishedVersionId }
          : {}),
        revision: { increment: 1 },
      },
    });
    audit.push(
      {
        objectType: 'content_version',
        objectId: v.id,
        action: 'create',
        toStatus: 'draft',
        meta: { number: v.number, aiCallId },
      },
      ...(from !== 'drafting'
        ? [
            {
              objectType: 'content' as const,
              objectId: contentId,
              action: 'transition' as const,
              fromStatus: from,
              toStatus: 'drafting',
              occurredAt: now,
            },
          ]
        : []),
      ...(await acceptAiCall(this.ports, tx, product, aiCallId, m.actors)),
    );
    return { body: await loadVersion(tx, product.id, v.id), audit };
  }

  async patchVersion(
    tx: PubTx,
    product: ProductRef,
    contentId: string,
    versionId: string,
    b: Body,
    actor: string,
  ): Promise<OpOut<VersionView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const v = await tx.pubContentVersion.findFirst({
      where: { id: versionId, contentId, productId: product.id },
      include: {
        content: {
          select: { kind: true, parentContentId: true, redditBriefId: true },
        },
      },
    });
    if (!v) throw new PubError('PUB_NOT_FOUND');
    if (v.status !== 'draft') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'content_version',
        from: v.status,
        to: 'draft',
        allowed: [],
        hint: 'frozen_version_create_new',
      });
    }
    if (isRedditContentKind(v.content.kind)) {
      return this.patchRedditVersion(
        tx,
        product,
        contentId,
        versionId,
        b,
        actor,
      );
    }
    const is = new Issues();
    const { data, links } = this.readVersionFields(is, b, false);
    if (v.content.kind === 'article' && data.parentVersionId)
      is.add('parentVersionId', 'not_allowed');
    if (
      v.content.kind !== 'article' &&
      has(b, 'parentVersionId') &&
      !data.parentVersionId
    ) {
      is.add('parentVersionId', 'required');
    }
    is.throwIfAny();
    if (v.content.kind !== 'article' && data.parentVersionId) {
      const ok = await this.parentApprovedVersion(
        tx,
        product.id,
        v.content.parentContentId!,
      );
      if (!ok.includes(data.parentVersionId as string)) {
        throw validationError([
          { field: 'parentVersionId', code: 'parent_not_approved' },
        ]);
      }
    }
    await this.checkVersionRefs(tx, product.id, data, links);
    await casUpdate(tx.pubContentVersion, versionId, expected, data);
    await this.replaceLinks(tx, product, versionId, links, actor);
    return {
      body: await loadVersion(tx, product.id, versionId),
      audit: [
        {
          objectType: 'content_version',
          objectId: versionId,
          action: 'update',
          meta: {
            fields: [...Object.keys(data), ...Object.keys(links)].sort(),
          },
        },
      ],
    };
  }

  /**
   * Отправка на проверку: проверки формата и связей, заморозка ОДНИМ
   * UPDATE (hash + frozenAt), материал `drafting → editorial_review`.
   */
  async submit(
    tx: PubTx,
    product: ProductRef,
    contentId: string,
    versionId: string,
    b: Body,
    actors: Actor[],
    now: Date,
  ): Promise<OpOut<VersionView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const c = await tx.pubContent.findFirst({
      where: { id: contentId, productId: product.id },
    });
    const v = await tx.pubContentVersion.findFirst({
      where: { id: versionId, contentId, productId: product.id },
      include: {
        versionClaimVersionOf: { select: { claimId: true } },
        versionFactVersionOf: {
          select: { fact: { select: { status: true } } },
        },
        versionSourceVersionOf: {
          select: { source: { select: { id: true, usage: true } } },
        },
        offerVersion: { select: { status: true } },
        parentVersion: { select: { title: true } },
      },
    });
    if (!c || !v) throw new PubError('PUB_NOT_FOUND');
    if (v.revision !== expected)
      throw new PubError('PUB_CONFLICT', { currentRevision: v.revision });
    if (v.status !== 'draft' || c.currentVersionId !== v.id) {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'content_version',
        from: v.status,
        to: 'submitted',
        allowed: [],
      });
    }
    assertTransition(
      CONTENT_MACHINE,
      c.status as ContentStatus,
      'editorial_review',
      { actors },
    );
    const issues = formatIssues(
      v.format,
      { title: v.title, body: v.body, meta: (v.meta ?? {}) as never },
      v.parentVersion?.title ?? null,
    );
    // У статьи — claims извлечены (вручную, ДТ-2); факты версии — активные.
    if (c.kind === 'article' && v.versionClaimVersionOf.length === 0) {
      issues.push({ field: 'claimIds', code: 'claims_required' });
    }
    if (v.versionFactVersionOf.some((f) => f.fact.status !== 'active')) {
      issues.push({ field: 'factIds', code: 'fact_not_active' });
    }
    if (v.offerVersion.status !== 'active') {
      issues.push({ field: 'offerVersionId', code: 'offer_inactive' });
    }
    if (issues.length) throw validationError(issues);
    const revoked = v.versionSourceVersionOf.filter(
      (s) => s.source.usage === 'revoked',
    );
    if (revoked.length) {
      throw new PubError('PUB_SOURCE_NOT_ALLOWED', {
        sourceIds: revoked.map((s) => s.source.id),
        reason: 'revoked',
      });
    }
    const reddit = isRedditContentKind(c.kind);
    if (reddit) {
      // P-R M2 (Р-RD-7): серверная часть meta — по ТЕКУЩЕМУ снимку правил и
      // брифу на момент заморозки; входит в hash ниже.
      const ctx = await this.ports
        .reddit()
        .materialContext(tx, product, c.redditBriefId!);
      // Аудит M2 S3-5 (Р-RD-66): заморозка — только при готовом брифе
      // (иначе была бы сырая ошибка гварда meta.affiliation).
      this.assertRedditBriefReady(ctx);
      const n0 = await tx.pubContentVersion.updateMany({
        where: { id: versionId, revision: expected, status: 'draft' },
        data: {
          meta: redditMeta(v.meta, ctx) as Prisma.InputJsonObject,
          ...(c.kind === 'reddit_comment' && ctx.serviceTitle
            ? { title: ctx.serviceTitle }
            : {}),
        },
      });
      if (n0.count !== 1)
        throw new PubError('PUB_CONFLICT', { currentRevision: expected + 1 });
    }
    const hash = contentVersionHash(
      await versionHashInput(tx, product.id, versionId),
    );
    const audit: AuditInput[] = [];
    await this.supersedeUnpublished(
      tx,
      product,
      c,
      'new_version_submitted',
      audit,
    );
    // Контракт P-A0: hash и frozenAt — одним UPDATE.
    const n = await tx.pubContentVersion.updateMany({
      where: { id: versionId, revision: expected, status: 'draft' },
      data: {
        status: 'submitted',
        hash,
        frozenAt: now,
        revision: { increment: 1 },
      },
    });
    if (n.count !== 1)
      throw new PubError('PUB_CONFLICT', { currentRevision: expected + 1 });
    await tx.pubContent.update({
      where: { id: contentId },
      data: {
        status: 'editorial_review',
        ...(c.approvedVersionId !== c.publishedVersionId
          ? { approvedVersionId: c.publishedVersionId }
          : {}),
        revision: { increment: 1 },
      },
    });
    audit.push(
      {
        objectType: 'content_version',
        objectId: versionId,
        action: 'transition',
        fromStatus: 'draft',
        toStatus: 'submitted',
        meta: { hash },
      },
      {
        objectType: 'content',
        objectId: contentId,
        action: 'transition',
        fromStatus: c.status,
        toStatus: 'editorial_review',
      },
    );
    if (reddit) {
      // §M2.4: проверка `reddit_policy` — сразу при заморозке.
      const w = await writeRedditPolicyCheck(
        this.ports,
        tx,
        product,
        versionId,
        now,
        'submit',
      );
      audit.push(w.audit);
    }
    return { body: await loadVersion(tx, product.id, versionId), audit };
  }

  // ── Reddit-материал (P-R M2, §M2.1, Р-RD-49) ──────────────────────────

  /**
   * Поля версии Reddit-материала: заголовок (у комментария — служебный,
   * клиент не передаёт), тело (post ≤ 40 000, comment ≤ 10 000), клиентская
   * часть `meta`, claims/факты; оффер, родитель и `sourceIds` — от сервера
   * (оффер — из брифа, источники — из `claimMap`). `aiCallId` +
   * `variantIndex` — выбранный вариант `pub.reddit.draft`.
   */
  private readRedditFields(
    is: Issues,
    b: Body,
    kind: 'reddit_post' | 'reddit_comment',
    create: boolean,
  ): {
    data: Record<string, unknown>;
    clientMeta: RedditClientMeta | undefined;
    links: Partial<Links>;
    aiRaw: string | null | undefined;
    variantIndex: number | null | undefined;
  } {
    const data: Record<string, unknown> = {};
    const opt = (k: string) => create || has(b, k);
    if (kind === 'reddit_comment') {
      if (has(b, 'title')) is.add('title', 'derived');
    } else if (opt('title')) {
      data.title = is.str(b, 'title', { required: true, max: 300 });
    }
    if (opt('body')) {
      const body = b.body;
      const max = kind === 'reddit_comment' ? 10_000 : 40_000;
      if (typeof body !== 'string' && !(create && body === undefined))
        is.add('body', 'type');
      else {
        const t = typeof body === 'string' ? body : '';
        if ([...t].length > max) is.add('body', 'length');
        else if (hasRawHtml(t)) is.add('body', 'raw_html');
        else data.body = t;
      }
    }
    for (const k of ['offerVersionId', 'sourceIds'] as const)
      if (has(b, k)) is.add(k, 'derived');
    if (has(b, 'parentVersionId')) is.add('parentVersionId', 'not_allowed');
    let clientMeta: RedditClientMeta | undefined;
    if (opt('meta')) {
      const m = checkRedditVersionMeta(b.meta);
      m.issues.forEach((x) => is.add(x.field, x.code));
      clientMeta = m.meta;
    }
    const links: Partial<Links> = {};
    for (const k of ['claimIds', 'factIds'] as const) {
      if (opt(k)) links[k] = is.ids(b, k, 200) ?? [];
    }
    if (clientMeta) links.sourceIds = claimMapSourceIds(clientMeta.claimMap);
    const aiRaw = is.str(b, 'aiCallId', { max: 100 });
    const variantIndex = is.int(b, 'variantIndex', { min: 0, max: 2 });
    if (aiRaw && (variantIndex === undefined || variantIndex === null))
      is.add('variantIndex', 'required');
    if (!aiRaw && typeof variantIndex === 'number')
      is.add('aiCallId', 'required');
    return { data, clientMeta, links, aiRaw, variantIndex };
  }

  /** Бриф готов (иначе 409 `PUB_BRIEF_NOT_READY {missing}`). */
  private assertRedditBriefReady(ctx: RedditMaterialContext): void {
    if (ctx.briefStatus !== 'ready' || ctx.briefMissing.length) {
      throw new PubError('PUB_BRIEF_NOT_READY', {
        missing:
          ctx.briefStatus !== 'ready'
            ? ['brief_ready', ...ctx.briefMissing]
            : ctx.briefMissing,
      });
    }
  }

  /**
   * Источники `claimMap`: источники продукта (`origin=content`), не
   * отозванные, последние редакции; доказательства P-R (выдержка, правила)
   * — 400 `restricted_source` (Р-RD-4).
   */
  private async checkClaimSources(
    tx: PubTx,
    productId: string,
    ids: readonly string[],
  ): Promise<void> {
    if (!ids.length) return;
    await assertSourceIds(tx, productId, ids, 'meta.claimMap.sourceIds');
    const reddit = await tx.pubSource.count({
      where: { productId, id: { in: [...ids] }, origin: 'reddit' },
    });
    if (reddit)
      throw validationError([
        { field: 'meta.claimMap.sourceIds', code: 'restricted_source' },
      ]);
  }

  /**
   * Вариант вызова `pub.reddit.draft` ЭТОГО брифа (P-R M2): задача брифа
   * (`reddit_brief`) или задача переписывания абзаца черновика материала
   * этого брифа (`content_version`, раунд 2, Р-RD-83).
   */
  private async assertRedditVariant(
    tx: PubTx,
    productId: string,
    briefId: string,
    aiRaw: string | null | undefined,
    variantIndex: number | null | undefined,
  ): Promise<string | null> {
    const aiCallId = await assertAiCall(tx, productId, aiRaw, [
      'pub.reddit.draft',
    ]);
    if (!aiCallId) return null;
    const call = await tx.pubAiCall.findFirst({
      where: { id: aiCallId, productId },
      select: {
        output: true,
        task: { select: { objectType: true, objectId: true } },
      },
    });
    const ofBrief =
      !!call &&
      call.task.objectType === 'reddit_brief' &&
      call.task.objectId === briefId;
    const ofDraft =
      !!call &&
      call.task.objectType === 'content_version' &&
      (await tx.pubContentVersion.count({
        where: {
          id: call.task.objectId,
          productId,
          content: { redditBriefId: briefId },
        },
      })) === 1;
    if (!call || (!ofBrief && !ofDraft))
      throw validationError([{ field: 'aiCallId', code: 'ai_call' }]);
    const variants = (call.output as { variants?: unknown } | null)?.variants;
    if (
      !Array.isArray(variants) ||
      typeof variantIndex !== 'number' ||
      variantIndex >= variants.length
    )
      throw validationError([{ field: 'variantIndex', code: 'range' }]);
    return aiCallId;
  }

  private async createRedditVersion(
    tx: PubTx,
    product: ProductRef,
    c: {
      id: string;
      kind: string;
      status: string;
      currentVersionId: string | null;
      approvedVersionId: string | null;
      publishedVersionId: string | null;
      redditBriefId: string | null;
    },
    b: Body,
    m: { memberId: string; actor: string; actors: Actor[] },
    now: Date,
  ): Promise<OpOut<VersionView>> {
    const kind = c.kind as 'reddit_post' | 'reddit_comment';
    const is = new Issues();
    const f = this.readRedditFields(is, b, kind, true);
    is.throwIfAny();
    const from = c.status as ContentStatus;
    if (!NEW_VERSION_FROM.includes(from)) {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'content',
        from,
        to: 'drafting',
        allowed: [],
        hint: 'new_version_not_allowed_in_status',
      });
    }
    if (c.currentVersionId) {
      const curV = await tx.pubContentVersion.findFirst({
        where: { id: c.currentVersionId },
        select: { status: true },
      });
      if (curV?.status === 'draft') {
        throw new PubError('PUB_CONFLICT', {
          reason: 'draft_exists',
          versionId: c.currentVersionId,
        });
      }
    }
    if (from !== 'drafting') {
      assertTransition(CONTENT_MACHINE, from, 'drafting', { actors: m.actors });
    }
    const ctx = await this.ports
      .reddit()
      .materialContext(tx, product, c.redditBriefId!);
    this.assertRedditBriefReady(ctx);
    await this.checkVersionRefs(
      tx,
      product.id,
      { offerVersionId: ctx.offerVersionId },
      { claimIds: f.links.claimIds, factIds: f.links.factIds },
    );
    await this.checkClaimSources(tx, product.id, f.links.sourceIds ?? []);
    const aiCallId = await this.assertRedditVariant(
      tx,
      product.id,
      ctx.briefId,
      f.aiRaw,
      f.variantIndex,
    );
    const last = await tx.pubContentVersion.findFirst({
      where: { contentId: c.id },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    const audit: AuditInput[] = [];
    if (from === 'approved' || from === 'correction_required') {
      await this.supersedeUnpublished(tx, product, c, 'new_version', audit);
    }
    const v = await tx.pubContentVersion.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        contentId: c.id,
        number: (last?.number ?? 0) + 1,
        title:
          kind === 'reddit_comment'
            ? (ctx.serviceTitle ?? `r/${ctx.subreddit}`)
            : (f.data.title as string),
        body: (f.data.body as string) ?? '',
        meta: redditMeta(f.clientMeta ?? {}, ctx) as Prisma.InputJsonObject,
        format: c.kind,
        parentVersionId: null,
        offerVersionId: ctx.offerVersionId,
        authorMemberId: m.memberId,
        aiCallId,
        status: 'draft',
        createdBy: m.actor,
      },
    });
    await this.replaceLinks(
      tx,
      product,
      v.id,
      { sourceIds: f.links.sourceIds ?? [], ...f.links },
      m.actor,
    );
    await tx.pubContent.update({
      where: { id: c.id },
      data: {
        currentVersionId: v.id,
        status: 'drafting',
        ...(from === 'approved'
          ? { approvedVersionId: c.publishedVersionId }
          : {}),
        revision: { increment: 1 },
      },
    });
    audit.push(
      {
        objectType: 'content_version',
        objectId: v.id,
        action: 'create',
        toStatus: 'draft',
        meta: {
          number: v.number,
          aiCallId,
          variantIndex: aiCallId ? (f.variantIndex ?? null) : null,
          ruleSnapshotId: ctx.currentSnapshotId,
        },
      },
      ...(from !== 'drafting'
        ? [
            {
              objectType: 'content' as const,
              objectId: c.id,
              action: 'transition' as const,
              fromStatus: from,
              toStatus: 'drafting',
              occurredAt: now,
            },
          ]
        : []),
      ...(await acceptAiCall(this.ports, tx, product, aiCallId, m.actors)),
    );
    return { body: await loadVersion(tx, product.id, v.id), audit };
  }

  private async patchRedditVersion(
    tx: PubTx,
    product: ProductRef,
    contentId: string,
    versionId: string,
    b: Body,
    actor: string,
  ): Promise<OpOut<VersionView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const v = await tx.pubContentVersion.findFirst({
      where: { id: versionId, contentId, productId: product.id },
      include: { content: { select: { kind: true, redditBriefId: true } } },
    });
    if (!v) throw new PubError('PUB_NOT_FOUND');
    const kind = v.content.kind as 'reddit_post' | 'reddit_comment';
    const is = new Issues();
    const f = this.readRedditFields(is, b, kind, false);
    is.throwIfAny();
    const ctx = await this.ports
      .reddit()
      .materialContext(tx, product, v.content.redditBriefId!);
    await this.checkVersionRefs(
      tx,
      product.id,
      {},
      {
        claimIds: f.links.claimIds,
        factIds: f.links.factIds,
      },
    );
    if (f.links.sourceIds)
      await this.checkClaimSources(tx, product.id, f.links.sourceIds);
    const data: Record<string, unknown> = { ...f.data };
    // Серверная часть meta пересчитывается при каждой правке (Р-RD-7).
    const client =
      f.clientMeta ?? (v.meta as Record<string, unknown> as RedditClientMeta);
    data.meta = redditMeta(client, ctx);
    if (kind === 'reddit_comment' && ctx.serviceTitle)
      data.title = ctx.serviceTitle;
    let aiCallId: string | null | undefined;
    if (has(b, 'aiCallId') || has(b, 'variantIndex')) {
      aiCallId = await this.assertRedditVariant(
        tx,
        product.id,
        ctx.briefId,
        f.aiRaw,
        f.variantIndex,
      );
      data.aiCallId = aiCallId;
    }
    await casUpdate(tx.pubContentVersion, versionId, expected, data);
    await this.replaceLinks(tx, product, versionId, f.links, actor);
    return {
      body: await loadVersion(tx, product.id, versionId),
      audit: [
        {
          objectType: 'content_version',
          objectId: versionId,
          action: 'update',
          meta: {
            fields: [...Object.keys(f.data), ...Object.keys(f.links)]
              .concat(f.clientMeta ? ['meta'] : [])
              .sort(),
            ...(aiCallId !== undefined
              ? { aiCallId, variantIndex: f.variantIndex ?? null }
              : {}),
            ruleSnapshotId: ctx.currentSnapshotId,
          },
        },
      ],
    };
  }

  // ── Ручные переходы машины 7.1 ─────────────────────────────────────────

  async transition(
    tx: PubTx,
    product: ProductRef,
    contentId: string,
    b: Body,
    actors: Actor[],
    now: Date,
  ): Promise<OpOut<ContentView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const is = new Issues();
    const to = is.oneOf(b, 'to', CONTENT_MACHINE.states, true) as
      ContentStatus | undefined;
    const reason = is.str(b, 'reason', { max: 2000, pii: true });
    const plannedAt = is.date(b, 'plannedAt');
    is.throwIfAny();
    const c = await tx.pubContent.findFirst({
      where: { id: contentId, productId: product.id },
    });
    if (!c) throw new PubError('PUB_NOT_FOUND');
    if (c.revision !== expected)
      throw new PubError('PUB_CONFLICT', { currentRevision: c.revision });
    const from = c.status as ContentStatus;
    const t = assertTransition(CONTENT_MACHINE, from, to!, { actors });
    const manual = [
      'request_changes',
      'schedule',
      'unschedule',
      'needs_correction',
      'confirm_unaffected',
      'withdraw',
    ];
    if (!manual.includes(t.action)) {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'content',
        from,
        to,
        allowed: [],
        hint: `use_dedicated_action:${t.action}`,
      });
    }
    const needReason = [
      'request_changes',
      'unschedule',
      'needs_correction',
      'confirm_unaffected',
      'withdraw',
    ];
    if (needReason.includes(t.action) && !reason) {
      throw validationError([{ field: 'reason', code: 'required' }]);
    }
    const data: Record<string, unknown> = { status: to };
    const audit: AuditInput[] = [];
    if (t.action === 'request_changes') {
      await tx.pubContentVersion.updateMany({
        where: { id: c.currentVersionId ?? '', status: 'submitted' },
        data: { status: 'changes_requested' },
      });
    }
    if (t.action === 'schedule' && isRedditContentKind(c.kind)) {
      // P-R M2: Reddit-материал планируется копированием утверждённого
      // текста (гейт reddit_publish, свежая проверка правил, аудит copy).
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'content',
        from,
        to,
        allowed: [],
        hint: 'use_dedicated_action:copy',
      });
    }
    if (t.action === 'schedule') {
      const vid = c.approvedVersionId;
      if (!vid) throw new PubError('PUB_APPROVAL_REQUIRED');
      await this.recheckPublishable(tx, product, vid);
      if (plannedAt) data.nextDueAt = plannedAt;
    }
    if (t.action === 'confirm_unaffected') {
      // Редактор проверил: изменение текст не затрагивает — задачи по
      // материалу закрыты решением (маршрут задач P-A1).
      const open = await tx.pubReviewTask.count({
        where: {
          productId: product.id,
          status: 'open',
          objectType: 'content',
          objectId: contentId,
          reason: { in: CHANGE_TASK_REASONS },
        },
      });
      if (open > 0)
        throw new PubError('PUB_BLOCKERS_OPEN', {
          blockers: [{ code: 'change_task_open' }],
        });
      if (!c.publishedVersionId) throw new PubError('PUB_APPROVAL_REQUIRED');
      data.criticalStale = false;
    }
    if (t.action === 'needs_correction') data.criticalStale = c.criticalStale;
    if (t.action === 'withdraw') {
      audit.push(
        ...(await this.publicationsOff(
          tx,
          product,
          contentId,
          reason!,
          actors,
          now,
        )),
      );
    }
    await casUpdate(tx.pubContent, contentId, expected, data);
    audit.push({
      objectType: 'content',
      objectId: contentId,
      action: 'transition',
      fromStatus: from,
      toStatus: to!,
      reason: reason ?? null,
      occurredAt: now,
    });
    return { body: await loadContent(tx, product.id, contentId), audit };
  }

  /**
   * §7.1: публикации снятого материала → `withdrawn` (таблица P-C — через её
   * порт, Р-PUB-Z1-1); сайт отдаёт 410 по статусу материала. Возвращает
   * записи аудита (актёр — человек операции).
   */
  private async publicationsOff(
    tx: PubTx,
    product: ProductRef,
    contentId: string,
    reason: string,
    actors: Actor[],
    now: Date,
  ): Promise<AuditInput[]> {
    const off = await this.ports
      .publications()
      .withdrawForContent(tx, product, contentId, { reason, actors });
    return off.map((p) => ({
      objectType: 'publication' as const,
      objectId: p.publicationId,
      action: 'transition' as const,
      fromStatus: p.fromStatus,
      toStatus: 'withdrawn',
      reason,
      meta: { contentId, cause: 'content_withdrawn' },
      occurredAt: now,
    }));
  }

  /**
   * Снятие страницы явным отзывом согласования ПОКАЗАННОЙ версии (аудит
   * P-B1 S3-3): материал → `withdrawn` (сайт — 410, не 404), публикации →
   * `withdrawn`. Строка материала блокируется (`FOR UPDATE`).
   */
  async takeDown(
    tx: PubTx,
    product: ProductRef,
    contentId: string,
    reason: string,
    actors: Actor[],
    now: Date,
  ): Promise<AuditInput[]> {
    await tx.$queryRaw`SELECT "id" FROM "sites"."pub_contents" WHERE "id" = ${contentId} FOR UPDATE`;
    const c = await tx.pubContent.findFirst({
      where: { id: contentId, productId: product.id },
      select: { status: true },
    });
    if (!c || c.status === 'withdrawn') return [];
    const from = c.status as ContentStatus;
    assertTransition(CONTENT_MACHINE, from, 'withdrawn', { actors });
    const audit = await this.publicationsOff(
      tx,
      product,
      contentId,
      reason,
      actors,
      now,
    );
    await tx.pubContent.update({
      where: { id: contentId },
      data: { status: 'withdrawn', revision: { increment: 1 } },
    });
    audit.push({
      objectType: 'content',
      objectId: contentId,
      action: 'transition',
      fromStatus: from,
      toStatus: 'withdrawn',
      reason,
      meta: { cause: 'approval_revoked' },
      occurredAt: now,
    });
    return audit;
  }

  /**
   * Повторные проверки перед планированием и публикацией (§7.1, аудит
   * P2-15): согласование активно, hash версии = текущий, оффер активен,
   * источники разрешены, нет открытых задач изменения по версии.
   */
  async recheckPublishable(
    tx: PubTx,
    product: ProductRef,
    versionId: string,
  ): Promise<{ approvalId: string; hash: string }> {
    const v = await tx.pubContentVersion.findFirst({
      where: { id: versionId, productId: product.id },
      select: { hash: true },
    });
    if (!v || !v.hash) throw new PubError('PUB_NOT_FOUND');
    const approval = await tx.pubApproval.findFirst({
      where: {
        productId: product.id,
        type: 'publish_version',
        objectType: 'content_version',
        objectId: versionId,
        status: 'active',
        versionHash: v.hash,
      },
      orderBy: { decidedAt: 'desc' },
      select: { id: true },
    });
    if (!approval) throw new PubError('PUB_APPROVAL_REQUIRED', { versionId });
    await assertHashCurrent(tx, product.id, versionId, v.hash);
    // Те же блокеры, что при согласовании (аудит P-B1 S0-1, S2-1, S3-4):
    // QA человека, claims, источники, оффер, ВСЕ задачи изменения по версии,
    // у адаптации — родитель всё ещё согласован.
    const blockers = await approvalBlockers(tx, product.id, versionId);
    if (blockers.length) throw new PubError('PUB_BLOCKERS_OPEN', { blockers });
    return { approvalId: approval.id, hash: v.hash };
  }

  // ── Diff ───────────────────────────────────────────────────────────────

  async diff(
    tx: PubTx,
    productId: string,
    contentId: string,
    a: string,
    b: string,
  ): Promise<VersionDiff> {
    const va = await loadVersion(tx, productId, a, contentId);
    const vb = await loadVersion(tx, productId, b, contentId);
    const body = lineDiff(va.body, vb.body);
    return {
      a: va.id,
      b: vb.id,
      title: va.title === vb.title ? null : { from: va.title, to: vb.title },
      body: body.lines,
      bodyCoarse: body.coarse,
      metaChanged: metaChangedKeys(va.meta, vb.meta),
      offerChanged: va.offerVersionId !== vb.offerVersionId,
      sources: setDiff(va.sourceIds, vb.sourceIds),
      claims: setDiff(va.claimIds, vb.claimIds),
      facts: setDiff(va.factIds, vb.factIds),
    };
  }
}

/**
 * `meta` Reddit-версии: клиентская часть + серверная (снимок правил,
 * аффилированность брифа, тред возможности) — входит в hash (Р-RD-7).
 */
export function redditMeta(
  client: unknown,
  ctx: Pick<
    RedditMaterialContext,
    'currentSnapshotId' | 'affiliation' | 'threadUrl'
  >,
): Record<string, unknown> {
  const c = (client ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of [
    'disclosure',
    'flairSuggestion',
    'claimMap',
    'uncertainties',
  ])
    if (c[k] !== undefined) out[k] = c[k];
  out.disclosure = typeof out.disclosure === 'string' ? out.disclosure : '';
  out.ruleSnapshotId = ctx.currentSnapshotId;
  out.affiliation = ctx.affiliation;
  out.threadUrl = ctx.threadUrl;
  return out;
}
