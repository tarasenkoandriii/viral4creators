/**
 * AI Publisher, P-B1 — карта вопросов аудитории F01 (проектный документ
 * §6.3 `pub_questions`, `pub_question_groups`; AT-F01-01/02).
 *
 *  - вопрос хранит исходные фрагменты источников (`pub_question_sources`),
 *    оценки 0–2 по четырём критериям с пояснением к КАЖДОМУ и редакционную
 *    заметку приоритета; частотность — только вместе с источником
 *    измерения, иначе `NULL` («невідомо», не ноль);
 *  - `selected` (одна из шести тем, ранг 1..6) — только с пояснениями всех
 *    четырёх оценок и ≥ 1 разрешённым источником (то же — триггер);
 *  - группы создаёт и разделяет ЧЕЛОВЕК (AI-кластеризация в P0 выключена,
 *    ДТ-2): система ничего не склеивает сама; перенос вопроса из другой
 *    группы — только явным `moveFromOtherGroups` (AT-F01-02).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { QuestionGroupView, QuestionView } from '../contracts/content-api';
import { QUESTION_STAGES } from '../contracts/states';
import { PubError, validationError } from '../core/errors';
import { PubPorts, type ProductRef, type PubTx } from '../core/ports';
import type { Actor } from '../core/state-machines';
import { casUpdate, parseExpectedRevision } from '../core/revision';
import { has, Issues, type Body } from './input';
import { acceptAiCall, assertAiCall, assertSourceIds } from './refs';
import { checkScores, selectionMissing } from './rules';
import type { OpOut } from './sources.service';
import { loadGroup, loadQuestion } from './views';

const KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,99}$/;

interface SourceLink {
  sourceId: string;
  fragment: string | null;
}

function sourceLinks(is: Issues, b: Body): SourceLink[] | undefined {
  const v = b.sources;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 50) {
    is.add('sources', 'type');
    return undefined;
  }
  const out: SourceLink[] = [];
  const seen = new Set<string>();
  v.forEach((x, i) => {
    const o = x as Record<string, unknown> | null;
    if (!o || typeof o.sourceId !== 'string' || seen.has(o.sourceId)) {
      is.add(`sources[${i}]`, 'type');
      return;
    }
    seen.add(o.sourceId);
    const f = o.fragment;
    if (
      f !== undefined &&
      f !== null &&
      (typeof f !== 'string' || [...f].length > 2000)
    ) {
      is.add(`sources[${i}].fragment`, 'length');
      return;
    }
    out.push({
      sourceId: o.sourceId,
      fragment: typeof f === 'string' && f.trim() ? f : null,
    });
  });
  return out;
}

@Injectable()
export class QuestionsService {
  constructor(private readonly ports: PubPorts) {}

  private async replaceSources(
    tx: PubTx,
    product: ProductRef,
    questionId: string,
    links: SourceLink[],
    actor: string,
  ): Promise<void> {
    await assertSourceIds(
      tx,
      product.id,
      links.map((l) => l.sourceId),
      'sources',
    );
    await tx.pubQuestionSource.deleteMany({
      where: { questionId, productId: product.id },
    });
    if (links.length) {
      await tx.pubQuestionSource.createMany({
        data: links.map((l) => ({
          accountId: product.accountId,
          productId: product.id,
          questionId,
          sourceId: l.sourceId,
          fragment: l.fragment,
          createdBy: actor,
        })),
      });
    }
  }

  private async frequencySourceOk(
    tx: PubTx,
    productId: string,
    id: string | null | undefined,
  ): Promise<void> {
    if (!id) return;
    const s = await tx.pubSource.findFirst({
      where: { id, productId },
      select: { id: true },
    });
    if (!s)
      throw validationError([
        { field: 'frequencySourceId', code: 'not_found' },
      ]);
  }

  async create(
    tx: PubTx,
    product: ProductRef,
    b: Body,
    actor: string,
  ): Promise<OpOut<QuestionView>> {
    const is = new Issues();
    const text = is.str(b, 'text', { required: true, max: 1000 });
    const audience = is.str(b, 'audience', { max: 300 });
    const stage = is.oneOf(b, 'stage', QUESTION_STAGES) ?? 'unknown';
    const observedRepeats = is.int(b, 'observedRepeats', {
      min: 0,
      max: 1_000_000,
    });
    const frequency = is.int(b, 'frequency', { min: 0, max: 1_000_000_000 });
    const frequencySourceId = is.str(b, 'frequencySourceId', { max: 100 });
    if (
      ((frequency ?? null) === null) !==
      ((frequencySourceId ?? null) === null)
    ) {
      is.add('frequency', 'requires_source');
    }
    const priorityNote = is.str(b, 'priorityNote', { max: 2000, pii: true });
    const sc = checkScores(b.scores);
    sc.issues.forEach((x) => is.add(x.field, x.code));
    const links = sourceLinks(is, b) ?? [];
    is.throwIfAny();
    await this.frequencySourceOk(tx, product.id, frequencySourceId);
    const row = await tx.pubQuestion.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        text: text!,
        audience: audience ?? null,
        stage,
        observedRepeats: observedRepeats ?? null,
        frequency: frequency ?? null,
        frequencySourceId: frequencySourceId ?? null,
        scores: sc.scores as Prisma.InputJsonObject,
        priorityNote: priorityNote ?? null,
        status: 'candidate',
        createdBy: actor,
      },
    });
    await this.replaceSources(tx, product, row.id, links, actor);
    return {
      body: await loadQuestion(tx, product.id, row.id),
      audit: [
        {
          objectType: 'question',
          objectId: row.id,
          action: 'create',
          toStatus: 'candidate',
        },
      ],
    };
  }

  async patch(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
    actor: string,
  ): Promise<OpOut<QuestionView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const cur = await tx.pubQuestion.findFirst({
      where: { id, productId: product.id },
    });
    if (!cur) throw new PubError('PUB_NOT_FOUND');
    const is = new Issues();
    const data: Record<string, unknown> = {};
    if (has(b, 'text'))
      data.text = is.str(b, 'text', { required: true, max: 1000 });
    if (has(b, 'audience'))
      data.audience = is.str(b, 'audience', { max: 300 }) ?? null;
    if (has(b, 'stage'))
      data.stage = is.oneOf(b, 'stage', QUESTION_STAGES, true);
    if (has(b, 'observedRepeats')) {
      data.observedRepeats =
        is.int(b, 'observedRepeats', { min: 0, max: 1_000_000 }) ?? null;
    }
    if (has(b, 'frequency') || has(b, 'frequencySourceId')) {
      const f = is.int(b, 'frequency', { min: 0, max: 1_000_000_000 }) ?? null;
      const fs = is.str(b, 'frequencySourceId', { max: 100 }) ?? null;
      if ((f === null) !== (fs === null))
        is.add('frequency', 'requires_source');
      data.frequency = f;
      data.frequencySourceId = fs;
    }
    if (has(b, 'priorityNote')) {
      data.priorityNote =
        is.str(b, 'priorityNote', { max: 2000, pii: true }) ?? null;
    }
    let scores = (cur.scores ?? {}) as ReturnType<typeof checkScores>['scores'];
    if (has(b, 'scores')) {
      const sc = checkScores(b.scores);
      sc.issues.forEach((x) => is.add(x.field, x.code));
      scores = { ...scores, ...sc.scores };
      data.scores = scores as Prisma.InputJsonObject;
    }
    const links = has(b, 'sources') ? sourceLinks(is, b) : undefined;
    let groupId: string | null | undefined;
    if (has(b, 'groupId')) groupId = is.str(b, 'groupId', { max: 100 }) ?? null;
    const status = has(b, 'status')
      ? is.oneOf(
          b,
          'status',
          ['candidate', 'selected', 'rejected'] as const,
          true,
        )
      : undefined;
    const rank = has(b, 'selectedRank')
      ? is.int(b, 'selectedRank', { min: 1, max: 6 })
      : undefined;
    is.throwIfAny();
    if (data.frequencySourceId) {
      await this.frequencySourceOk(
        tx,
        product.id,
        data.frequencySourceId as string,
      );
    }
    if (groupId) {
      const g = await tx.pubQuestionGroup.findFirst({
        where: { id: groupId, productId: product.id },
        select: { status: true },
      });
      if (!g) throw validationError([{ field: 'groupId', code: 'not_found' }]);
      if (g.status === 'split' || g.status === 'rejected') {
        throw validationError([{ field: 'groupId', code: 'group_closed' }]);
      }
    }
    if (groupId !== undefined) data.groupId = groupId;
    if (links) await this.replaceSources(tx, product, id, links, actor);

    const nextStatus = status ?? cur.status;
    const nextRank =
      nextStatus === 'selected'
        ? rank !== undefined
          ? rank
          : cur.selectedRank
        : null;
    if (nextStatus === 'selected') {
      if (!nextRank)
        throw validationError([{ field: 'selectedRank', code: 'required' }]);
      const allowed = await tx.pubQuestionSource.count({
        where: {
          questionId: id,
          productId: product.id,
          source: { usage: 'allowed' },
        },
      });
      const missing = selectionMissing(scores, allowed);
      if (missing.length) {
        throw validationError(
          missing.map((field) => ({ field, code: 'required' })),
        );
      }
      const taken = await tx.pubQuestion.findFirst({
        where: {
          productId: product.id,
          selectedRank: nextRank,
          id: { not: id },
        },
        select: { id: true },
      });
      if (taken)
        throw new PubError('PUB_CONFLICT', {
          reason: 'rank_taken',
          questionId: taken.id,
        });
    }
    data.status = nextStatus;
    data.selectedRank = nextRank;
    await casUpdate(tx.pubQuestion, id, expected, data);
    return {
      body: await loadQuestion(tx, product.id, id),
      audit: [
        {
          objectType: 'question',
          objectId: id,
          action: nextStatus !== cur.status ? 'transition' : 'update',
          fromStatus: cur.status,
          toStatus: nextStatus,
          meta: { fields: Object.keys(data).sort(), selectedRank: nextRank },
        },
      ],
    };
  }

  async createGroup(
    tx: PubTx,
    product: ProductRef,
    b: Body,
    actor: string,
    actors: Actor[],
  ): Promise<OpOut<QuestionGroupView>> {
    const is = new Issues();
    const key = is.str(b, 'key', { required: true, max: 100, re: KEY_RE });
    const task = is.str(b, 'task', { required: true, max: 2000, pii: true });
    const stage = is.oneOf(b, 'stage', QUESTION_STAGES, true);
    const audience = is.str(b, 'audience', { max: 300 });
    const rationale = is.str(b, 'rationale', {
      required: true,
      max: 2000,
      pii: true,
    });
    const mergeRisk = is.str(b, 'mergeRisk', { max: 2000, pii: true });
    const questionIds = is.ids(b, 'questionIds', 100);
    if (!questionIds || questionIds.length === 0)
      is.add('questionIds', 'required');
    const move = is.bool(b, 'moveFromOtherGroups') ?? false;
    const aiRaw = is.str(b, 'aiCallId', { max: 100 });
    is.throwIfAny();
    const aiCallId = await assertAiCall(tx, product.id, aiRaw, [
      'pub.questions.cluster',
    ]);
    const qs = await tx.pubQuestion.findMany({
      where: { productId: product.id, id: { in: questionIds! } },
      select: { id: true, groupId: true },
    });
    if (qs.length !== questionIds!.length) {
      throw validationError([{ field: 'questionIds', code: 'not_found' }]);
    }
    const elsewhere = qs.filter((q) => q.groupId !== null).map((q) => q.id);
    if (elsewhere.length && !move) {
      throw new PubError('PUB_CONFLICT', {
        reason: 'question_in_other_group',
        questionIds: elsewhere.sort(),
      });
    }
    const dup = await tx.pubQuestionGroup.findFirst({
      where: { productId: product.id, key: key! },
      select: { id: true },
    });
    if (dup) throw new PubError('PUB_CONFLICT', { reason: 'key_taken' });
    const g = await tx.pubQuestionGroup.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        key: key!,
        task: task!,
        stage: stage!,
        audience: audience ?? null,
        rationale: rationale!,
        mergeRisk: mergeRisk ?? null,
        // Группу утверждает человек этим действием.
        status: 'confirmed',
        aiCallId,
        createdBy: actor,
      },
    });
    await tx.pubQuestion.updateMany({
      where: { productId: product.id, id: { in: questionIds! } },
      data: { groupId: g.id, revision: { increment: 1 } },
    });
    const accepted = await acceptAiCall(
      this.ports,
      tx,
      product,
      aiCallId,
      actors,
    );
    return {
      body: await loadGroup(tx, product.id, g.id),
      audit: [
        ...accepted,
        {
          objectType: 'question_group',
          objectId: g.id,
          action: 'create',
          toStatus: 'confirmed',
          meta: {
            questionIds: questionIds!,
            movedQuestionIds: elsewhere,
            aiCallId,
          },
        },
      ],
    };
  }

  async patchGroup(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
  ): Promise<OpOut<QuestionGroupView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const cur = await tx.pubQuestionGroup.findFirst({
      where: { id, productId: product.id },
    });
    if (!cur) throw new PubError('PUB_NOT_FOUND');
    const is = new Issues();
    const data: Record<string, unknown> = {};
    if (has(b, 'task'))
      data.task = is.str(b, 'task', { required: true, max: 2000, pii: true });
    if (has(b, 'rationale')) {
      data.rationale = is.str(b, 'rationale', {
        required: true,
        max: 2000,
        pii: true,
      });
    }
    if (has(b, 'mergeRisk'))
      data.mergeRisk = is.str(b, 'mergeRisk', { max: 2000, pii: true }) ?? null;
    if (has(b, 'audience'))
      data.audience = is.str(b, 'audience', { max: 300 }) ?? null;
    if (has(b, 'stage'))
      data.stage = is.oneOf(b, 'stage', QUESTION_STAGES, true);
    const status = has(b, 'status')
      ? is.oneOf(b, 'status', ['confirmed', 'split', 'rejected'] as const, true)
      : undefined;
    is.throwIfAny();
    if (status && status !== cur.status) {
      if (cur.status === 'split' || cur.status === 'rejected') {
        throw new PubError('PUB_TRANSITION_INVALID', {
          machine: 'question_group',
          from: cur.status,
          to: status,
          allowed: [],
        });
      }
      data.status = status;
    }
    await casUpdate(tx.pubQuestionGroup, id, expected, data);
    if (status === 'split' || status === 'rejected') {
      // Разделение: вопросы выходят из группы; новые группы — тоже человек.
      await tx.pubQuestion.updateMany({
        where: { productId: product.id, groupId: id },
        data: { groupId: null, revision: { increment: 1 } },
      });
    }
    return {
      body: await loadGroup(tx, product.id, id),
      audit: [
        {
          objectType: 'question_group',
          objectId: id,
          action:
            status === 'split' ? 'split' : status ? 'transition' : 'update',
          fromStatus: cur.status,
          toStatus: (data.status as string | undefined) ?? cur.status,
        },
      ],
    };
  }
}
