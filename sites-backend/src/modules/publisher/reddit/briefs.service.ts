/**
 * AI Publisher, P-R M2 — Reddit-брифы (reddit-manual-mvp-adapted.md §M2.1,
 * §M2.2; Р-RD-5, Р-RD-61; AT-RD-13).
 *
 *  - создание: проект и сообщество активны; комментарий — только к треду
 *    возможности (`opportunityId`) и с непустым контекстом (не задан —
 *    копия выдержки возможности; пусто/нет выдержки — 400 `context:
 *    required`, A13); возможность — того же проекта и сообщества, её гейт
 *    СЕЙЧАС `ok` (хвост M2 (4)): `qualified → in_brief` с аудитом;
 *  - тезисы: источники продукта (`origin=content`, не отозванные);
 *    доказательства P-R — 400 `restricted_source` (Р-RD-4);
 *  - `ready` — `missing` пуст (триггер повторяет); правка содержимого
 *    `ready`-брифа возвращает его в `draft`; `archived` неизменен;
 *  - версия оффера — активная на момент создания (у версии материала
 *    `offerVersionId` NOT NULL); правка — только на текущую активную.
 * Пишет только `pub_reddit_briefs` и `pub_reddit_opportunities` (пакет P-R).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { RedditBriefView } from '../contracts/reddit-api';
import {
  REDDIT_AFFILIATIONS,
  REDDIT_CONTENT_TYPES,
  type RedditContentType,
} from '../contracts/states';
import { has, Issues, type Body } from '../content/input';
import { assertSourceIds } from '../content/refs';
import { PubError, validationError } from '../core/errors';
import { looksLikeContact } from '../core/pii-guard';
import { weakBrand } from './markers';
import type { AuditInput, ProductRef, PubTx } from '../core/ports';
import { casUpdate, parseExpectedRevision } from '../core/revision';
import { briefMissing, keyPointSourceIds, parseKeyPoints } from './brief-rules';
import { loadBriefView } from './brief-views';
import { assertParentsActive, profileRefIssue } from './guards';
import { briefState } from './reddit-port';
import { localeField, onlyFields, type OpOut } from './projects.service';
import { currentRules, gateNow, staleDaysFor } from './views';

export interface Step {
  actor: string;
  now: Date;
}

const CREATE_FIELDS = [
  'opKey',
  'projectId',
  'contentType',
  'opportunityId',
  'communityId',
  'objective',
  'audience',
  'context',
  'keyPoints',
  'affiliation',
  'brand',
  'linksAllowed',
  'tone',
  'language',
  'constraints',
  'forbiddenClaims',
  'cta',
] as const;
const PATCH_FIELDS = [
  'opKey',
  'expectedRevision',
  'objective',
  'audience',
  'context',
  'keyPoints',
  'affiliation',
  'brand',
  'linksAllowed',
  'tone',
  'language',
  'constraints',
  'forbiddenClaims',
  'cta',
  'offerVersionId',
] as const;

/** Свободный текст брифа: длина, контакт (`pii`), ник (`profile_ref`). */
function text(
  is: Issues,
  b: Body,
  field: string,
  max: number,
  required = false,
): string | null | undefined {
  const v = is.str(b, field, { max, pii: true, required });
  profileRefIssue(is, field, v);
  return v;
}

function strings(
  is: Issues,
  b: Body,
  field: string,
  maxItems: number,
): string[] | undefined {
  const v = is.strings(b, field, { maxItems, maxLen: 300, pii: true });
  v?.forEach((x, i) => profileRefIssue(is, `${field}[${i}]`, x));
  return v;
}

@Injectable()
export class RedditBriefsService {
  /** Источники тезисов: продукта, `origin=content`, не отозванные. */
  private async checkKeyPointSources(
    tx: PubTx,
    productId: string,
    ids: string[],
  ): Promise<void> {
    if (!ids.length) return;
    await assertSourceIds(tx, productId, ids, 'keyPoints.sourceIds');
    const reddit = await tx.pubSource.count({
      where: { productId, id: { in: ids }, origin: 'reddit' },
    });
    if (reddit)
      throw validationError([
        { field: 'keyPoints.sourceIds', code: 'restricted_source' },
      ]);
  }

  /** `qualified → in_brief` по гейту СЕЙЧАС (хвост M2 (4)). */
  private async takeOpportunity(
    tx: PubTx,
    product: ProductRef,
    opp: {
      id: string;
      status: string;
      communityId: string;
      ruleSnapshotId: string | null;
      revision: number;
    },
    now: Date,
  ): Promise<AuditInput[]> {
    const rules = (await currentRules(tx, product.id, [opp.communityId])).get(
      opp.communityId,
    );
    const g = gateNow(
      opp,
      rules ?? null,
      now,
      await staleDaysFor(tx, product.id),
    );
    const from = opp.status;
    if (g.verdict === 'block')
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'policy_block',
        from,
        reasons: g.reasons,
      });
    if (g.verdict === 'recheck_required')
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'policy_recheck',
        from,
        reasons: g.reasons,
      });
    if (from === 'in_brief') return [];
    if (from !== 'qualified')
      throw new PubError('PUB_TRANSITION_INVALID', { reason: 'status', from });
    const n = await tx.pubRedditOpportunity.updateMany({
      where: {
        id: opp.id,
        productId: product.id,
        status: 'qualified',
        revision: opp.revision,
      },
      data: { status: 'in_brief', revision: { increment: 1 } },
    });
    if (n.count !== 1)
      throw new PubError('PUB_CONFLICT', { currentRevision: opp.revision + 1 });
    return [
      {
        objectType: 'reddit_opportunity',
        objectId: opp.id,
        action: 'transition',
        fromStatus: from,
        toStatus: 'in_brief',
        meta: { cause: 'brief_created' },
      },
    ];
  }

  async create(
    tx: PubTx,
    product: ProductRef,
    step: Step,
    b: Body,
  ): Promise<OpOut<RedditBriefView>> {
    const is = new Issues();
    onlyFields(is, b, CREATE_FIELDS);
    const projectId = is.str(b, 'projectId', { required: true, max: 100 });
    const contentType = is.oneOf(
      b,
      'contentType',
      REDDIT_CONTENT_TYPES,
      true,
    ) as RedditContentType | undefined;
    const opportunityId = is.str(b, 'opportunityId', { max: 100 });
    const communityIn = is.str(b, 'communityId', { max: 100 });
    const objective = text(is, b, 'objective', 500, true);
    const audience = text(is, b, 'audience', 500);
    let context = text(is, b, 'context', 2000);
    const kp = parseKeyPoints(b.keyPoints);
    kp.issues.forEach((x) => is.add(x.field, x.code));
    const affiliation =
      b.affiliation === null || b.affiliation === undefined
        ? null
        : is.oneOf(b, 'affiliation', REDDIT_AFFILIATIONS, true);
    const brandIn = text(is, b, 'brand', 64);
    if (typeof brandIn === 'string' && brandIn.trim().length < 2)
      is.add('brand', 'length');
    const linksAllowed = is.bool(b, 'linksAllowed') ?? false;
    const tone = text(is, b, 'tone', 64);
    const language = localeField(is, b, 'language', false);
    const constraints = strings(is, b, 'constraints', 10) ?? [];
    const forbiddenClaims = strings(is, b, 'forbiddenClaims', 20) ?? [];
    const cta = text(is, b, 'cta', 300);
    if (contentType === 'comment' && !opportunityId)
      is.add('opportunityId', 'required');
    if (contentType === 'post' && !opportunityId && !communityIn)
      is.add('communityId', 'required');
    // A13: явный пустой контекст комментария — сразу 400.
    if (
      contentType === 'comment' &&
      has(b, 'context') &&
      (b.context === null ||
        (typeof b.context === 'string' && !b.context.trim()))
    )
      is.add('context', 'required');
    is.throwIfAny();
    const project = await tx.pubRedditProject.findFirst({
      where: { id: projectId!, productId: product.id },
      select: { id: true, locale: true },
    });
    if (!project)
      throw validationError([{ field: 'projectId', code: 'not_found' }]);
    const audit: AuditInput[] = [];
    let communityId = communityIn ?? null;
    if (opportunityId) {
      const opp = await tx.pubRedditOpportunity.findFirst({
        where: { id: opportunityId, productId: product.id },
      });
      if (!opp)
        throw validationError([{ field: 'opportunityId', code: 'not_found' }]);
      if (opp.projectId !== project.id)
        throw validationError([
          { field: 'opportunityId', code: 'project_mismatch' },
        ]);
      if (communityIn && communityIn !== opp.communityId)
        throw validationError([
          { field: 'communityId', code: 'community_mismatch' },
        ]);
      communityId = opp.communityId;
      await assertParentsActive(tx, product.id, project.id, communityId);
      // Комментарий: контекст по умолчанию — выдержка треда (редактируется).
      if (contentType === 'comment' && context === undefined) {
        const ex = opp.excerptSourceId
          ? await tx.pubSource.findFirst({
              where: { id: opp.excerptSourceId, productId: product.id },
              select: { fragment: true, usage: true },
            })
          : null;
        context = ex && ex.usage !== 'revoked' ? ex.fragment : null;
      }
      audit.push(...(await this.takeOpportunity(tx, product, opp, step.now)));
    } else {
      const c = await tx.pubRedditCommunity.findFirst({
        where: { id: communityId!, productId: product.id },
        select: { id: true, projectId: true },
      });
      if (!c)
        throw validationError([{ field: 'communityId', code: 'not_found' }]);
      if (c.projectId !== project.id)
        throw validationError([
          { field: 'communityId', code: 'project_mismatch' },
        ]);
      await assertParentsActive(tx, product.id, project.id, c.id);
    }
    if (contentType === 'comment' && !context?.trim())
      throw validationError([{ field: 'context', code: 'required' }]);
    await this.checkKeyPointSources(
      tx,
      product.id,
      keyPointSourceIds(kp.points),
    );
    const offer = await tx.pubOfferVersion.findFirst({
      where: { productId: product.id, status: 'active' },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (!offer)
      throw validationError([
        { field: 'offerVersionId', code: 'offer_missing' },
      ]);
    // Р-RD-65: бренд для раскрытия — по умолчанию имя продукта.
    let brand = brandIn ?? null;
    if (brandIn === undefined) {
      const p = await tx.pubProduct.findFirst({
        where: { id: product.id },
        select: { name: true },
      });
      const name = [...(p?.name ?? '').trim()].slice(0, 64).join('');
      brand = !weakBrand(name) && !looksLikeContact(name) ? name : null;
    }
    const row = await tx.pubRedditBrief.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        projectId: project.id,
        communityId: communityId!,
        opportunityId: opportunityId ?? null,
        offerVersionId: offer.id,
        contentType: contentType!,
        objective: objective!,
        audience: audience ?? null,
        context: context ?? null,
        keyPoints: kp.points as unknown as Prisma.InputJsonArray,
        affiliation: affiliation ?? null,
        brand,
        linksAllowed,
        tone: tone ?? null,
        language: language ?? project.locale,
        constraints,
        forbiddenClaims,
        cta: cta ?? null,
        status: 'draft',
        createdBy: step.actor,
      },
    });
    audit.unshift({
      objectType: 'reddit_brief',
      objectId: row.id,
      action: 'create',
      toStatus: 'draft',
      meta: {
        contentType: row.contentType,
        opportunityId: row.opportunityId,
        communityId: row.communityId,
        affiliation: row.affiliation,
      },
    });
    return {
      body: await loadBriefView(tx, product.id, row.id, step.now),
      audit,
    };
  }

  async patch(
    tx: PubTx,
    product: ProductRef,
    id: string,
    step: Step,
    b: Body,
  ): Promise<OpOut<RedditBriefView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const is = new Issues();
    onlyFields(is, b, PATCH_FIELDS);
    const d: Record<string, unknown> = {};
    if (has(b, 'objective')) d.objective = text(is, b, 'objective', 500, true);
    if (has(b, 'audience')) d.audience = text(is, b, 'audience', 500) ?? null;
    if (has(b, 'context')) d.context = text(is, b, 'context', 2000) ?? null;
    let points: ReturnType<typeof parseKeyPoints> | null = null;
    if (has(b, 'keyPoints')) {
      points = parseKeyPoints(b.keyPoints);
      points.issues.forEach((x) => is.add(x.field, x.code));
      d.keyPoints = points.points;
    }
    if (has(b, 'affiliation'))
      d.affiliation =
        b.affiliation === null
          ? null
          : is.oneOf(b, 'affiliation', REDDIT_AFFILIATIONS, true);
    if (has(b, 'brand')) {
      const v = text(is, b, 'brand', 64) ?? null;
      if (typeof v === 'string' && v.trim().length < 2)
        is.add('brand', 'length');
      d.brand = v;
    }
    if (has(b, 'linksAllowed')) d.linksAllowed = is.bool(b, 'linksAllowed');
    if (has(b, 'tone')) d.tone = text(is, b, 'tone', 64) ?? null;
    if (has(b, 'language')) {
      const l = localeField(is, b, 'language', false);
      if (l === null) is.add('language', 'required');
      d.language = l;
    }
    if (has(b, 'constraints'))
      d.constraints = strings(is, b, 'constraints', 10) ?? [];
    if (has(b, 'forbiddenClaims'))
      d.forbiddenClaims = strings(is, b, 'forbiddenClaims', 20) ?? [];
    if (has(b, 'cta')) d.cta = text(is, b, 'cta', 300) ?? null;
    if (has(b, 'offerVersionId'))
      d.offerVersionId = is.str(b, 'offerVersionId', {
        required: true,
        max: 100,
      });
    is.throwIfAny();
    const cur = await tx.pubRedditBrief.findFirst({
      where: { id, productId: product.id },
    });
    if (!cur) throw new PubError('PUB_NOT_FOUND');
    if (cur.status === 'archived')
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'status',
        from: cur.status,
      });
    if (
      cur.contentType === 'comment' &&
      has(b, 'context') &&
      !(d.context as string | null)?.trim()
    )
      throw validationError([{ field: 'context', code: 'required' }]);
    if (points)
      await this.checkKeyPointSources(
        tx,
        product.id,
        keyPointSourceIds(points.points),
      );
    if (typeof d.offerVersionId === 'string') {
      const o = await tx.pubOfferVersion.findFirst({
        where: { id: d.offerVersionId, productId: product.id },
        select: { status: true },
      });
      if (!o)
        throw validationError([{ field: 'offerVersionId', code: 'not_found' }]);
      if (o.status !== 'active')
        throw validationError([
          { field: 'offerVersionId', code: 'offer_inactive' },
        ]);
    }
    const audit: AuditInput[] = [];
    // Правка содержимого готового брифа — снова черновик (ready проверяется заново).
    if (cur.status === 'ready' && Object.keys(d).length) {
      d.status = 'draft';
      audit.push({
        objectType: 'reddit_brief',
        objectId: id,
        action: 'transition',
        fromStatus: 'ready',
        toStatus: 'draft',
        meta: { cause: 'edited' },
      });
    }
    await casUpdate(tx.pubRedditBrief, id, expected, d);
    audit.unshift({
      objectType: 'reddit_brief',
      objectId: id,
      action: 'update',
      meta: {
        fields: Object.keys(d)
          .filter((k) => k !== 'status')
          .sort(),
      },
    });
    return { body: await loadBriefView(tx, product.id, id, step.now), audit };
  }

  async ready(
    tx: PubTx,
    product: ProductRef,
    id: string,
    step: Step,
    b: Body,
  ): Promise<OpOut<RedditBriefView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const is = new Issues();
    onlyFields(is, b, ['opKey', 'expectedRevision']);
    is.throwIfAny();
    const st = await briefState(tx, product.id, id);
    if (st.brief.status !== 'draft')
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'status',
        from: st.brief.status,
      });
    if (st.missing.length)
      throw new PubError('PUB_BRIEF_NOT_READY', { missing: st.missing });
    await casUpdate(tx.pubRedditBrief, id, expected, { status: 'ready' });
    return {
      body: await loadBriefView(tx, product.id, id, step.now),
      audit: [
        {
          objectType: 'reddit_brief',
          objectId: id,
          action: 'transition',
          fromStatus: 'draft',
          toStatus: 'ready',
        },
      ],
    };
  }

  async archive(
    tx: PubTx,
    product: ProductRef,
    id: string,
    step: Step,
    b: Body,
  ): Promise<OpOut<RedditBriefView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const is = new Issues();
    onlyFields(is, b, ['opKey', 'expectedRevision', 'reason']);
    const reason = is.str(b, 'reason', { max: 2000, pii: true });
    is.throwIfAny();
    const cur = await tx.pubRedditBrief.findFirst({
      where: { id, productId: product.id },
      select: { status: true },
    });
    if (!cur) throw new PubError('PUB_NOT_FOUND');
    if (cur.status === 'archived')
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'status',
        from: cur.status,
      });
    await casUpdate(tx.pubRedditBrief, id, expected, { status: 'archived' });
    return {
      body: await loadBriefView(tx, product.id, id, step.now),
      audit: [
        {
          objectType: 'reddit_brief',
          objectId: id,
          action: 'transition',
          fromStatus: cur.status,
          toStatus: 'archived',
          reason: reason ?? null,
        },
      ],
    };
  }
}

export { briefMissing };
