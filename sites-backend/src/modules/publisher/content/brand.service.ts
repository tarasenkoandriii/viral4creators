/**
 * AI Publisher, P-B1 — факты бренда и versioned offer F02 (проектный
 * документ §6.3 `pub_brand_facts`, `pub_offer_versions`; AT-F02-01/02).
 *
 * Факт:
 *  - запись хранит источник, версию, утвердившего, дату, область;
 *  - второе (иное) значение ключа при активном факте — `needs_resolution`
 *    + задача `fact_conflict`; в контекст не попадает (только `active`);
 *  - активация/разрешение конфликта — PO: прежний активный → `superseded`
 *    (частичный уникальный индекс держит «одна активная»), каскад
 *    `fact_changed` по версиям, которые использовали прежний факт
 *    (`pub_version_facts`): опубликованные → проверка при неизменном hash,
 *    неопубликованные согласования → `superseded`;
 *  - снятие активного факта (`retire`) — тот же каскад.
 * Оффер:
 *  - версия неизменна после выхода из черновика (триггер), hash —
 *    заголовок, текст, цена, связанные факты;
 *  - активация — транзакция: прежняя → `superseded`, параметр
 *    `offer_active_version` — РЕШЕНИЕМ через `ParameterPort` (журнал, гейты),
 *    каскад `offer_changed` (`criticalStale` при изменении цены).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  ActivateOfferResponse,
  CreateBrandFactResponse,
  FactDecisionResponse,
  OfferVersionView,
} from '../contracts/content-api';
import { BRAND_FACT_KINDS } from '../contracts/states';
import { PubError, validationError } from '../core/errors';
import { PubPorts, type ProductRef, type PubTx } from '../core/ports';
import type { Actor } from '../core/state-machines';
import { ContentCascades } from './cascades';
import { Issues, type Body } from './input';
import { assertSourceIds } from './refs';
import {
  checkFactValue,
  isCriticalFact,
  isCriticalOfferChange,
  offerHash,
  sameValue,
} from './rules';
import type { OpOut } from './sources.service';
import { factView, loadFact, loadOffer } from './views';

const KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,99}$/;

@Injectable()
export class BrandService {
  constructor(
    private readonly cascades: ContentCascades,
    private readonly ports: PubPorts,
  ) {}

  // ── Факты ──────────────────────────────────────────────────────────────

  async createFact(
    tx: PubTx,
    product: ProductRef,
    b: Body,
    actor: string,
  ): Promise<OpOut<CreateBrandFactResponse>> {
    const is = new Issues();
    const factKey = is.str(b, 'factKey', {
      required: true,
      max: 100,
      re: KEY_RE,
    });
    const kind = is.oneOf(b, 'kind', BRAND_FACT_KINDS, true);
    const scope = is.str(b, 'scope', { max: 200 });
    const sourceId = is.str(b, 'sourceId', { max: 100 });
    if (kind)
      checkFactValue(kind, b.value).forEach((x) => is.add(x.field, x.code));
    is.throwIfAny();
    if (sourceId) await assertSourceIds(tx, product.id, [sourceId], 'sourceId');
    const prev = await tx.pubBrandFact.findMany({
      where: { productId: product.id, factKey: factKey! },
      orderBy: { version: 'desc' },
    });
    const active = prev.find((p) => p.status === 'active') ?? null;
    if (active && active.kind !== kind) {
      throw validationError([{ field: 'kind', code: 'differs_from_active' }]);
    }
    if (active && sameValue(active.value, b.value)) {
      throw validationError([{ field: 'value', code: 'same_as_active' }]);
    }
    const conflict = active !== null;
    const row = await tx.pubBrandFact.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        factKey: factKey!,
        kind: kind!,
        value: b.value as Prisma.InputJsonValue,
        scope: scope ?? null,
        sourceId: sourceId ?? null,
        version: (prev[0]?.version ?? 0) + 1,
        status: conflict ? 'needs_resolution' : 'draft',
        conflictWithId: active?.id ?? null,
        createdBy: actor,
      },
    });
    let opened = 0;
    if (conflict) {
      opened = await this.ports.review().open(
        tx,
        product,
        [
          {
            objectType: 'brand_fact',
            objectId: row.id,
            reason: 'fact_conflict',
            triggerRef: `fact:${row.id}`,
            severity: isCriticalFact(row) ? 'critical' : 'normal',
          },
        ],
        { actor },
      );
    }
    return {
      body: { fact: factView(row), conflictTaskOpened: opened > 0 },
      audit: [
        {
          objectType: 'brand_fact',
          objectId: row.id,
          action: 'create',
          toStatus: row.status,
          meta: {
            factKey: row.factKey,
            version: row.version,
            conflictWithId: row.conflictWithId,
          },
        },
      ],
    };
  }

  /** Активировать `draft|needs_resolution`; прежний активный — `superseded`. */
  async activateFact(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
    actor: string,
    now: Date,
  ): Promise<OpOut<FactDecisionResponse>> {
    const is = new Issues();
    const basis = is.str(b, 'basis', { max: 2000, pii: true });
    is.throwIfAny();
    return this.activate(tx, product, id, basis ?? null, actor, now);
  }

  private async activate(
    tx: PubTx,
    product: ProductRef,
    id: string,
    reason: string | null,
    actor: string,
    now: Date,
  ): Promise<OpOut<FactDecisionResponse>> {
    const f = await tx.pubBrandFact.findFirst({
      where: { id, productId: product.id },
    });
    if (!f) throw new PubError('PUB_NOT_FOUND');
    if (f.status !== 'draft' && f.status !== 'needs_resolution') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'brand_fact',
        from: f.status,
        to: 'active',
        allowed: [],
      });
    }
    const prev = await tx.pubBrandFact.findFirst({
      where: { productId: product.id, factKey: f.factKey, status: 'active' },
    });
    if (prev) {
      await tx.pubBrandFact.update({
        where: { id: prev.id },
        data: { status: 'superseded', revision: { increment: 1 } },
      });
    }
    await tx.pubBrandFact.update({
      where: { id },
      data: {
        status: 'active',
        approvedBy: actor,
        approvedAt: now,
        revision: { increment: 1 },
      },
    });
    const cascade = prev
      ? await this.factCascade(tx, product, prev, `fact:${id}`, actor, now)
      : { tasksOpened: 0, correctionRequired: [], approvalsSuperseded: [] };
    return {
      body: { fact: await loadFact(tx, product.id, id), cascade },
      audit: [
        {
          objectType: 'brand_fact',
          objectId: id,
          action: 'approve',
          fromStatus: f.status,
          toStatus: 'active',
          reason,
          meta: {
            supersededId: prev?.id ?? null,
            tasksOpened: cascade.tasksOpened,
          },
        },
        ...(prev
          ? [
              {
                objectType: 'brand_fact' as const,
                objectId: prev.id,
                action: 'transition' as const,
                fromStatus: 'active',
                toStatus: 'superseded',
              },
            ]
          : []),
      ],
    };
  }

  private async factCascade(
    tx: PubTx,
    product: ProductRef,
    fact: { id: string; kind: string; factKey: string },
    triggerRef: string,
    actor: string,
    now: Date,
  ) {
    const links = await tx.pubVersionFact.findMany({
      where: { productId: product.id, factId: fact.id },
      select: { versionId: true },
    });
    // Аудит P-B1 S0-2: факт, входящий в оффер, — и через версию оффера
    // (`pub_offer_facts`): материалы с этим оффером несут его цену/условия.
    const offers = await tx.pubOfferFact.findMany({
      where: { productId: product.id, factId: fact.id },
      select: {
        offerVersionId: true,
        offerVersion: { select: { status: true } },
      },
    });
    const viaOffer = offers.length
      ? await tx.pubContentVersion.findMany({
          where: {
            productId: product.id,
            offerVersionId: { in: offers.map((o) => o.offerVersionId) },
          },
          select: { id: true },
        })
      : [];
    // Действующий оффер ссылается на снятый факт — задача владельцу.
    const activeOffers = offers.filter(
      (o) => o.offerVersion.status === 'active',
    );
    if (activeOffers.length) {
      await this.ports.review().open(
        tx,
        product,
        activeOffers.map((o) => ({
          objectType: 'offer_version' as const,
          objectId: o.offerVersionId,
          reason: 'fact_changed' as const,
          triggerRef,
          severity: isCriticalFact(fact)
            ? ('critical' as const)
            : ('normal' as const),
        })),
        { actor },
      );
    }
    return this.cascades.run(tx, product, {
      reason: 'fact_changed',
      triggerRef,
      versionIds: [
        ...new Set([
          ...links.map((l) => l.versionId),
          ...viaOffer.map((v) => v.id),
        ]),
      ],
      critical: isCriticalFact(fact),
      actor,
      now,
    });
  }

  /** Разрешить конфликт: оставить `keepId` (этот факт или активный). */
  async resolveFact(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
    actor: string,
    now: Date,
  ): Promise<OpOut<FactDecisionResponse>> {
    const is = new Issues();
    const keepId = is.str(b, 'keepId', { required: true, max: 100 });
    const reason = is.str(b, 'reason', {
      required: true,
      max: 2000,
      pii: true,
    });
    is.throwIfAny();
    const f = await tx.pubBrandFact.findFirst({
      where: { id, productId: product.id },
    });
    if (!f) throw new PubError('PUB_NOT_FOUND');
    if (f.status !== 'needs_resolution') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'brand_fact',
        from: f.status,
        to: 'resolved',
        allowed: [],
      });
    }
    if (keepId !== f.id && keepId !== f.conflictWithId) {
      throw validationError([{ field: 'keepId', code: 'not_in_conflict' }]);
    }
    if (keepId === f.id) {
      const r = await this.activate(tx, product, f.id, reason!, actor, now);
      r.audit[0].action = 'resolve';
      return r;
    }
    await tx.pubBrandFact.update({
      where: { id: f.id },
      data: { status: 'rejected', revision: { increment: 1 } },
    });
    return {
      body: {
        fact: await loadFact(tx, product.id, f.id),
        cascade: {
          tasksOpened: 0,
          correctionRequired: [],
          approvalsSuperseded: [],
        },
      },
      audit: [
        {
          objectType: 'brand_fact',
          objectId: f.id,
          action: 'resolve',
          fromStatus: 'needs_resolution',
          toStatus: 'rejected',
          reason: reason!,
          meta: { keptId: keepId },
        },
      ],
    };
  }

  /** Снять активный факт (деактивация — тот же каскад, F02). */
  async retireFact(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
    actor: string,
    now: Date,
  ): Promise<OpOut<FactDecisionResponse>> {
    const is = new Issues();
    const reason = is.str(b, 'reason', {
      required: true,
      max: 2000,
      pii: true,
    });
    is.throwIfAny();
    const f = await tx.pubBrandFact.findFirst({
      where: { id, productId: product.id },
    });
    if (!f) throw new PubError('PUB_NOT_FOUND');
    if (f.status !== 'active') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'brand_fact',
        from: f.status,
        to: 'superseded',
        allowed: [],
      });
    }
    await tx.pubBrandFact.update({
      where: { id },
      data: { status: 'superseded', revision: { increment: 1 } },
    });
    const cascade = await this.factCascade(
      tx,
      product,
      f,
      `fact-retire:${id}`,
      actor,
      now,
    );
    return {
      body: { fact: await loadFact(tx, product.id, id), cascade },
      audit: [
        {
          objectType: 'brand_fact',
          objectId: id,
          action: 'transition',
          fromStatus: 'active',
          toStatus: 'superseded',
          reason: reason!,
          meta: { tasksOpened: cascade.tasksOpened },
        },
      ],
    };
  }

  // ── Оффер ──────────────────────────────────────────────────────────────

  async createOffer(
    tx: PubTx,
    product: ProductRef,
    b: Body,
    actor: string,
  ): Promise<OpOut<OfferVersionView>> {
    const is = new Issues();
    const title = is.str(b, 'title', { required: true, max: 300 });
    const text = is.str(b, 'text', { required: true, max: 20_000 });
    const priceNote = is.str(b, 'priceNote', { max: 2000 });
    const factIds = is.ids(b, 'factIds', 100) ?? [];
    is.throwIfAny();
    const facts = await tx.pubBrandFact.findMany({
      where: { productId: product.id, id: { in: factIds } },
      select: { id: true, version: true, value: true, status: true },
    });
    if (facts.length !== factIds.length) {
      throw validationError([{ field: 'factIds', code: 'not_found' }]);
    }
    if (facts.some((f) => f.status !== 'active')) {
      throw validationError([{ field: 'factIds', code: 'fact_not_active' }]);
    }
    const last = await tx.pubOfferVersion.findFirst({
      where: { productId: product.id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const row = await tx.pubOfferVersion.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        version: (last?.version ?? 0) + 1,
        title: title!,
        text: text!,
        priceNote: priceNote ?? null,
        status: 'draft',
        hash: offerHash({
          title: title!,
          text: text!,
          priceNote: priceNote ?? null,
          facts,
        }),
        createdBy: actor,
      },
    });
    if (factIds.length) {
      await tx.pubOfferFact.createMany({
        data: factIds.map((factId) => ({
          accountId: product.accountId,
          productId: product.id,
          offerVersionId: row.id,
          factId,
          createdBy: actor,
        })),
      });
    }
    return {
      body: await loadOffer(tx, product.id, row.id),
      audit: [
        {
          objectType: 'offer_version',
          objectId: row.id,
          action: 'create',
          toStatus: 'draft',
          meta: { version: row.version },
        },
      ],
    };
  }

  async activateOffer(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
    actor: string,
    actors: Actor[],
    now: Date,
  ): Promise<OpOut<ActivateOfferResponse>> {
    const is = new Issues();
    const basis = is.str(b, 'basis', {
      required: true,
      min: 10,
      max: 2000,
      pii: true,
    });
    is.throwIfAny();
    const o = await tx.pubOfferVersion.findFirst({
      where: { id, productId: product.id },
      include: { offerFactOfferVersionOf: { include: { fact: true } } },
    });
    if (!o) throw new PubError('PUB_NOT_FOUND');
    if (o.status !== 'draft') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'offer_version',
        from: o.status,
        to: 'active',
        allowed: [],
      });
    }
    const prev = await tx.pubOfferVersion.findFirst({
      where: { productId: product.id, status: 'active' },
      include: { offerFactOfferVersionOf: { include: { fact: true } } },
    });
    if (prev) {
      await tx.pubOfferVersion.update({
        where: { id: prev.id },
        data: { status: 'superseded', revision: { increment: 1 } },
      });
    }
    await tx.pubOfferVersion.update({
      where: { id },
      data: {
        status: 'active',
        approvedBy: actor,
        approvedAt: now,
        revision: { increment: 1 },
      },
    });
    // Действующий оффер — параметр продукта, меняется РЕШЕНИЕМ (журнал, гейты).
    const decision = await this.ports.parameters().decide(tx, product, {
      key: 'offer_active_version',
      toStatus: 'approved',
      value: { offerVersionId: id, version: o.version },
      basis: basis!,
      decidedBy: actor,
      actors,
    });
    let cascade = {
      tasksOpened: 0,
      correctionRequired: [] as string[],
      approvalsSuperseded: [] as string[],
    };
    if (prev) {
      const shape = (x: typeof prev) => ({
        text: x.text,
        priceNote: x.priceNote,
        facts: x.offerFactOfferVersionOf.map((l) => l.fact),
      });
      const critical = isCriticalOfferChange(shape(prev), shape(o));
      const versions = await tx.pubContentVersion.findMany({
        where: { productId: product.id, offerVersionId: prev.id },
        select: { id: true },
      });
      cascade = await this.cascades.run(tx, product, {
        reason: 'offer_changed',
        triggerRef: `offer:${id}`,
        versionIds: versions.map((v) => v.id),
        critical,
        actor,
        now,
      });
    }
    return {
      body: {
        offer: await loadOffer(tx, product.id, id),
        parameterVersion: decision.version,
        cascade,
      },
      audit: [
        {
          objectType: 'offer_version',
          objectId: id,
          action: 'approve',
          fromStatus: 'draft',
          toStatus: 'active',
          reason: basis!,
          meta: {
            supersededId: prev?.id ?? null,
            decisionId: decision.decisionId,
            tasksOpened: cascade.tasksOpened,
          },
        },
      ],
    };
  }
}
