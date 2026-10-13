/**
 * AI Publisher, P-B1 — брифы F03 (проектный документ §6.3 `pub_briefs`;
 * AT-F03-01/02). Бриф создаётся по ВЫБРАННОМУ вопросу (одна из шести
 * тем) и версии оффера (по умолчанию — активной). Готов (`ready`) только с
 * собственным вкладом, CTA с пояснением уместности, ≥ 1 разрешённым
 * источником и АКТИВНОЙ версией оффера — иначе 409 `PUB_BRIEF_NOT_READY
 * {missing}` (то же держит триггер). Правка готового брифа возвращает его в
 * черновик. Предложение `pub.brief.draft` принимается только этой мутацией
 * человека (`aiCallId`).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { BriefView } from '../contracts/content-api';
import { BRIEF_FORMATS } from '../contracts/states';
import { PubError, validationError } from '../core/errors';
import { PubPorts, type ProductRef, type PubTx } from '../core/ports';
import type { Actor } from '../core/state-machines';
import { casUpdate, parseExpectedRevision } from '../core/revision';
import { has, Issues, type Body } from './input';
import { acceptAiCall, assertAiCall, assertSourceIds } from './refs';
import type { OpOut } from './sources.service';
import { loadBrief } from './views';

const LIST = { maxItems: 30, maxLen: 2000, pii: true } as const;
const CONTENT_FIELDS = [
  'offerVersionId',
  'goal',
  'format',
  'ownContribution',
  'shortAnswer',
  'cta',
  'ctaIntentNote',
  'structure',
  'channels',
  'readinessCriteria',
  'effortMinutes',
  'unresolved',
  'sourceIds',
] as const;

@Injectable()
export class BriefsService {
  constructor(private readonly ports: PubPorts) {}

  private fields(
    is: Issues,
    b: Body,
    create: boolean,
  ): Record<string, unknown> {
    const d: Record<string, unknown> = {};
    const opt = (k: string) => create || has(b, k);
    if (opt('goal'))
      d.goal = is.str(b, 'goal', { required: true, max: 2000, pii: true });
    if (opt('format')) d.format = is.oneOf(b, 'format', BRIEF_FORMATS, true);
    if (opt('ownContribution')) {
      d.ownContribution =
        is.str(b, 'ownContribution', { max: 4000, pii: true }) ?? null;
    }
    if (opt('shortAnswer'))
      d.shortAnswer =
        is.str(b, 'shortAnswer', { max: 2000, pii: true }) ?? null;
    if (opt('cta')) d.cta = is.str(b, 'cta', { max: 300, pii: true }) ?? null;
    if (opt('ctaIntentNote')) {
      d.ctaIntentNote =
        is.str(b, 'ctaIntentNote', { max: 2000, pii: true }) ?? null;
    }
    for (const k of [
      'structure',
      'channels',
      'readinessCriteria',
      'unresolved',
    ] as const) {
      if (opt(k))
        d[k] = (is.strings(b, k, LIST) ?? []) as Prisma.InputJsonValue;
    }
    if (opt('effortMinutes')) {
      d.effortMinutes =
        is.int(b, 'effortMinutes', { min: 0, max: 100_000 }) ?? null;
    }
    return d;
  }

  private async offerOk(
    tx: PubTx,
    productId: string,
    id: string,
  ): Promise<void> {
    const o = await tx.pubOfferVersion.findFirst({
      where: { id, productId },
      select: { id: true },
    });
    if (!o)
      throw validationError([{ field: 'offerVersionId', code: 'not_found' }]);
  }

  private async replaceSources(
    tx: PubTx,
    product: ProductRef,
    briefId: string,
    ids: string[],
    actor: string,
  ): Promise<void> {
    await assertSourceIds(tx, product.id, ids);
    await tx.pubBriefSource.deleteMany({
      where: { briefId, productId: product.id },
    });
    if (ids.length) {
      await tx.pubBriefSource.createMany({
        data: ids.map((sourceId) => ({
          accountId: product.accountId,
          productId: product.id,
          briefId,
          sourceId,
          createdBy: actor,
        })),
      });
    }
  }

  async create(
    tx: PubTx,
    product: ProductRef,
    b: Body,
    actor: string,
    actors: Actor[],
  ): Promise<OpOut<BriefView>> {
    const is = new Issues();
    const questionId = is.str(b, 'questionId', { required: true, max: 100 });
    const offerRaw = is.str(b, 'offerVersionId', { max: 100 });
    const d = this.fields(is, b, true);
    const sourceIds = is.ids(b, 'sourceIds', 50) ?? [];
    const aiRaw = is.str(b, 'aiCallId', { max: 100 });
    is.throwIfAny();
    const q = await tx.pubQuestion.findFirst({
      where: { id: questionId!, productId: product.id },
      select: { status: true },
    });
    if (!q) throw validationError([{ field: 'questionId', code: 'not_found' }]);
    if (q.status !== 'selected') {
      throw validationError([
        { field: 'questionId', code: 'question_not_selected' },
      ]);
    }
    let offerVersionId = offerRaw ?? null;
    if (offerVersionId) await this.offerOk(tx, product.id, offerVersionId);
    else {
      const active = await tx.pubOfferVersion.findFirst({
        where: { productId: product.id, status: 'active' },
        select: { id: true },
      });
      if (!active)
        throw validationError([{ field: 'offerVersionId', code: 'required' }]);
      offerVersionId = active.id;
    }
    const aiCallId = await assertAiCall(tx, product.id, aiRaw, [
      'pub.brief.draft',
    ]);
    const row = await tx.pubBrief.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        questionId: questionId!,
        offerVersionId,
        goal: d.goal as string,
        format: d.format as string,
        ownContribution: d.ownContribution as string | null,
        shortAnswer: d.shortAnswer as string | null,
        cta: d.cta as string | null,
        ctaIntentNote: d.ctaIntentNote as string | null,
        structure: d.structure as Prisma.InputJsonValue,
        channels: d.channels as Prisma.InputJsonValue,
        readinessCriteria: d.readinessCriteria as Prisma.InputJsonValue,
        effortMinutes: d.effortMinutes as number | null,
        unresolved: d.unresolved as Prisma.InputJsonValue,
        status: 'draft',
        aiCallId,
        createdBy: actor,
      },
    });
    await this.replaceSources(tx, product, row.id, sourceIds, actor);
    const accepted = await acceptAiCall(
      this.ports,
      tx,
      product,
      aiCallId,
      actors,
    );
    return {
      body: await loadBrief(tx, product.id, row.id),
      audit: [
        {
          objectType: 'brief',
          objectId: row.id,
          action: 'create',
          toStatus: 'draft',
          meta: { questionId: questionId!, offerVersionId, aiCallId },
        },
        ...accepted,
      ],
    };
  }

  async patch(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
    actor: string,
  ): Promise<OpOut<BriefView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const cur = await tx.pubBrief.findFirst({
      where: { id, productId: product.id },
    });
    if (!cur) throw new PubError('PUB_NOT_FOUND');
    const is = new Issues();
    const d = this.fields(is, b, false);
    const offer = has(b, 'offerVersionId')
      ? is.str(b, 'offerVersionId', { required: true, max: 100 })
      : undefined;
    const sourceIds = has(b, 'sourceIds')
      ? is.ids(b, 'sourceIds', 50)
      : undefined;
    const status = has(b, 'status')
      ? is.oneOf(b, 'status', ['draft', 'rejected'] as const, true)
      : undefined;
    is.throwIfAny();
    if (cur.status === 'rejected') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'brief',
        from: 'rejected',
        to: status ?? 'draft',
        allowed: [],
      });
    }
    if (offer) {
      await this.offerOk(tx, product.id, offer);
      d.offerVersionId = offer;
    }
    const contentChanged = CONTENT_FIELDS.some((k) => has(b, k));
    // Правка готового брифа — снова черновик (готовность подтверждается заново).
    const next =
      status ??
      (contentChanged && cur.status === 'ready' ? 'draft' : cur.status);
    d.status = next;
    await casUpdate(tx.pubBrief, id, expected, d);
    if (sourceIds) await this.replaceSources(tx, product, id, sourceIds, actor);
    return {
      body: await loadBrief(tx, product.id, id),
      audit: [
        {
          objectType: 'brief',
          objectId: id,
          action: next !== cur.status ? 'transition' : 'update',
          fromStatus: cur.status,
          toStatus: next,
          meta: { fields: Object.keys(d).sort() },
        },
      ],
    };
  }

  async ready(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
  ): Promise<OpOut<BriefView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const view = await loadBrief(tx, product.id, id);
    if (view.revision !== expected) {
      throw new PubError('PUB_CONFLICT', { currentRevision: view.revision });
    }
    if (view.status !== 'draft') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'brief',
        from: view.status,
        to: 'ready',
        allowed: view.status === 'ready' ? [] : ['draft'],
      });
    }
    if (view.missing.length) {
      throw new PubError('PUB_BRIEF_NOT_READY', { missing: view.missing });
    }
    await casUpdate(tx.pubBrief, id, expected, { status: 'ready' });
    return {
      body: await loadBrief(tx, product.id, id),
      audit: [
        {
          objectType: 'brief',
          objectId: id,
          action: 'transition',
          fromStatus: 'draft',
          toStatus: 'ready',
        },
      ],
    };
  }
}
