/**
 * AI Publisher, P-R — возможности (треды для ручного ответа): ввод,
 * score v1 и Policy Gate (reddit-manual-mvp-adapted.md §M1.1, §M1.3, §M1.4;
 * AT-RD-03, AT-RD-05, AT-RD-06, AT-RD-15).
 *
 *  - URL треда приводится к канону (`normalize.ts`); сообщество в URL должно
 *    совпасть с выбранным (A15: 400 `community_mismatch`); тот же `<id36>`
 *    в проекте → 409 `{reason:'duplicate', existingId}` без новых строк (A05).
 *  - Выдержка — строка `pub_sources` (discussion, private, restricted ≤ 2000,
 *    `SourcesService` P-B1, Р-RD-4). Сервис P-R проверяет её на контакты
 *    (`pii`, в отличие от обычных источников — Р-PUB-Z2-18) и на ссылки на
 *    профили/ники (`profile_ref`); автора не хранит.
 *  - Score пересчитывается при правке факторов и явным `POST …/score` по
 *    ТЕКУЩЕМУ снимку; `policy_risk` — из снимка. BLOCK score не снимает:
 *    `qualify` только из `new` и при гейте `ok` по текущему снимку (409
 *    `policy_block`/`policy_recheck`), а триггер держит `qualified|in_brief`
 *    только при `policy=ok`.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { FieldIssue } from '../contracts/errors';
import type {
  RedditFactors,
  RedditFactorsInput,
  RedditGateView,
  RedditOpportunityView,
} from '../contracts/reddit-api';
import {
  REDDIT_INTENTS,
  REDDIT_SCORE_FACTORS,
  type RedditIntent,
  type RedditOpportunityStatus,
  type RedditScoreFactor,
} from '../contracts/states';
import { SourcesService } from '../content/sources.service';
import { has, Issues, type Body } from '../content/input';
import { PubError, validationError } from '../core/errors';
import { looksLikeContact } from '../core/pii-guard';
import type { AuditInput, ProductRef, PubTx } from '../core/ports';
import { casUpdate, parseExpectedRevision } from '../core/revision';
import {
  assertParentsActive,
  insertOrDuplicate,
  profileRefIssue,
} from './guards';
import { normalizeThreadUrl, threadUrlIssue } from './normalize';
import { policyGate, policyRisk, policyRiskReasons } from './policy';
import { onlyFields, type OpOut } from './projects.service';
import {
  computeScore,
  emptyFactors,
  factorsFromJson,
  mergeFactors,
} from './score';
import {
  communityRow,
  currentRules,
  loadOpportunityView,
  opportunityRow,
  policySnapshotOf,
  projectRow,
  staleDaysFor,
  type OpportunityRow,
  type SnapshotRow,
} from './views';

export const EXCERPT_MAX = 2000;

/** Статусы, из которых возможность уходит в `skipped`. */
const SKIPPABLE: readonly RedditOpportunityStatus[] = [
  'new',
  'qualified',
  'recheck_required',
  'blocked',
];

export interface Step {
  actor: string;
  now: Date;
}

/** Ввод факторов оператора: 0..100|null + `why` (обязателен при значении). */
export function parseFactors(
  raw: unknown,
  issues: FieldIssue[],
): RedditFactorsInput | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ field: 'factors', code: 'type' });
    return undefined;
  }
  const out: RedditFactorsInput = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const field = `factors.${k}`;
    if (k === 'policy_risk') {
      issues.push({ field, code: 'derived' });
      continue;
    }
    if (!(REDDIT_SCORE_FACTORS as readonly string[]).includes(k)) {
      issues.push({ field, code: 'unknown_field' });
      continue;
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      issues.push({ field, code: 'type' });
      continue;
    }
    const { value, why, ...rest } = v as Record<string, unknown>;
    if (Object.keys(rest).length) {
      issues.push({ field, code: 'unknown_field' });
      continue;
    }
    if (
      value !== null &&
      (typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 100)
    ) {
      issues.push({ field: `${field}.value`, code: 'range' });
      continue;
    }
    let w: string | null = null;
    if (why !== undefined && why !== null) {
      if (typeof why !== 'string' || [...why.trim()].length > 300) {
        issues.push({ field: `${field}.why`, code: 'length' });
        continue;
      }
      if (looksLikeContact(why)) {
        issues.push({ field: `${field}.why`, code: 'pii' });
        continue;
      }
      w = why.trim() || null;
    }
    if (value !== null && !w) {
      issues.push({ field: `${field}.why`, code: 'required' });
      continue;
    }
    out[k as Exclude<RedditScoreFactor, 'policy_risk'>] = {
      value: value as number | null,
      why: w,
    };
  }
  return out;
}

/** Статус после пересчёта гейта (терминальные — без изменений). */
export function statusAfterGate(
  cur: RedditOpportunityStatus,
  verdict: RedditGateView['verdict'],
): RedditOpportunityStatus {
  if (cur === 'skipped' || cur === 'archived') return cur;
  if (verdict === 'block') return 'blocked';
  if (verdict === 'recheck_required') return 'recheck_required';
  return cur === 'blocked' || cur === 'recheck_required' ? 'new' : cur;
}

interface Evaluation {
  factors: RedditFactors;
  gate: RedditGateView;
  snapshot: SnapshotRow | null;
}

@Injectable()
export class RedditOpportunitiesService {
  constructor(private readonly sources: SourcesService) {}

  /** Факторы + выведенный `policy_risk` + гейт по текущему снимку. */
  private async evaluate(
    tx: PubTx,
    productId: string,
    communityId: string,
    prev: RedditFactors,
    input: RedditFactorsInput | undefined,
    now: Date,
  ): Promise<Evaluation> {
    const rules = (await currentRules(tx, productId, [communityId])).get(
      communityId,
    );
    const snapshot = rules?.snap ?? null;
    const ps = rules ? policySnapshotOf(rules.snap, rules.sourceRevoked) : null;
    const factors = mergeFactors(
      prev,
      input,
      policyRisk(ps),
      policyRiskReasons(ps),
    );
    const gate = policyGate(
      ps,
      now,
      await staleDaysFor(tx, productId),
      'opportunity',
      false,
    );
    return { factors, gate, snapshot };
  }

  private scoreData(e: Evaluation) {
    const score = computeScore(e.factors);
    return {
      factors: e.factors as unknown as Prisma.InputJsonValue,
      relevance: score.relevance,
      risk: score.risk,
      priority: score.priority,
      scoreVersion: score.scoreVersion,
      ruleSnapshotId: e.snapshot?.id ?? null,
      policy: e.gate.verdict,
      policyReasons: e.gate.reasons,
    };
  }

  private async keywordIdsOf(
    tx: PubTx,
    productId: string,
    projectId: string,
    is: Issues,
    b: Body,
  ): Promise<string[] | undefined> {
    const ids = is.ids(b, 'keywordIds', 10);
    if (!ids || ids.length === 0) return ids;
    const found = await tx.pubRedditKeyword.findMany({
      where: { productId, projectId, id: { in: ids } },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      is.add('keywordIds', 'unknown');
      return undefined;
    }
    return ids;
  }

  async create(
    tx: PubTx,
    product: ProductRef,
    step: Step,
    b: Body,
  ): Promise<OpOut<RedditOpportunityView>> {
    const is = new Issues();
    onlyFields(is, b, [
      'opKey',
      'projectId',
      'communityId',
      'threadUrl',
      'titleManual',
      'excerpt',
      'intent',
      'angle',
      'keywordIds',
      'factors',
    ]);
    const projectId = is.str(b, 'projectId', { required: true, max: 100 });
    const communityId = is.str(b, 'communityId', { required: true, max: 100 });
    const rawUrl = is.str(b, 'threadUrl', { required: true, max: 2048 });
    const thread = rawUrl ? normalizeThreadUrl(rawUrl) : null;
    if (rawUrl && !thread) is.add('threadUrl', threadUrlIssue(rawUrl)!);
    const titleManual = is.str(b, 'titleManual', {
      required: true,
      max: 300,
      pii: true,
    });
    const excerpt = is.str(b, 'excerpt', {
      max: EXCERPT_MAX,
      pii: true,
      trim: true,
    });
    const intent = is.oneOf(b, 'intent', REDDIT_INTENTS, true);
    const angle = is.str(b, 'angle', { max: 1000, pii: true });
    profileRefIssue(is, 'titleManual', titleManual);
    profileRefIssue(is, 'excerpt', excerpt);
    profileRefIssue(is, 'angle', angle);
    const factorIssues: FieldIssue[] = [];
    const factorsIn = parseFactors(b.factors, factorIssues);
    for (const x of factorIssues) is.add(x.field, x.code);
    is.throwIfAny();
    const project = await projectRow(tx, product.id, projectId!);
    const community = await communityRow(tx, product.id, communityId!);
    if (community.projectId !== project.id)
      throw validationError([
        { field: 'communityId', code: 'project_mismatch' },
      ]);
    if (thread!.subreddit !== community.name)
      throw validationError([
        { field: 'threadUrl', code: 'community_mismatch' },
      ]);
    if (project.status !== 'active' || community.status !== 'active') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason:
          project.status !== 'active'
            ? 'project_archived'
            : 'community_archived',
        from: project.status !== 'active' ? project.status : community.status,
      });
    }
    const keywordIds = await this.keywordIdsOf(
      tx,
      product.id,
      project.id,
      is,
      b,
    );
    is.throwIfAny();
    const dup = await tx.pubRedditOpportunity.findFirst({
      where: {
        productId: product.id,
        projectId: project.id,
        threadKey: thread!.threadKey,
      },
      select: { id: true },
    });
    if (dup) {
      throw new PubError('PUB_CONFLICT', {
        reason: 'duplicate',
        existingId: dup.id,
      });
    }
    const audit: AuditInput[] = [];
    let excerptSourceId: string | null = null;
    if (excerpt) {
      const src = await this.excerptSource(
        tx,
        product,
        thread!.url,
        titleManual!,
        excerpt,
        step.actor,
        null,
      );
      excerptSourceId = src.id;
      audit.push(...src.audit);
    }
    const e = await this.evaluate(
      tx,
      product.id,
      community.id,
      emptyFactors(),
      factorsIn,
      step.now,
    );
    const status = statusAfterGate('new', e.gate.verdict);
    const row = await insertOrDuplicate(
      tx,
      () =>
        tx.pubRedditOpportunity.create({
          data: {
            accountId: product.accountId,
            productId: product.id,
            projectId: project.id,
            communityId: community.id,
            threadUrl: thread!.url,
            threadKey: thread!.threadKey,
            titleManual: titleManual!,
            excerptSourceId,
            intent: intent as RedditIntent,
            angle: angle ?? null,
            keywordIds: keywordIds ?? [],
            ...this.scoreData(e),
            status,
            createdBy: step.actor,
          },
        }),
      async () =>
        (
          await tx.pubRedditOpportunity.findFirst({
            where: {
              productId: product.id,
              projectId: project.id,
              threadKey: thread!.threadKey,
            },
            select: { id: true },
          })
        )?.id ?? null,
    );
    audit.push({
      objectType: 'reddit_opportunity',
      objectId: row.id,
      action: 'create',
      toStatus: row.status,
      meta: {
        communityId: community.id,
        threadKey: row.threadKey,
        policy: row.policy,
        ruleSnapshotId: row.ruleSnapshotId,
        relevance: row.relevance,
        risk: row.risk,
        priority: row.priority,
        excerpt: excerptSourceId !== null,
      },
    });
    return {
      body: await loadOpportunityView(tx, product.id, row.id),
      audit,
    };
  }

  /**
   * Выдержка треда — доказательство P-R (`origin='reddit'`): discussion,
   * private, restricted, без автора; новая редакция — с `supersedesId`
   * прежней (прежняя неизменна, аудит S1-2).
   */
  private async excerptSource(
    tx: PubTx,
    product: ProductRef,
    url: string,
    title: string,
    fragment: string,
    actor: string,
    supersedesId: string | null,
  ): Promise<{ id: string; audit: AuditInput[] }> {
    const src = await this.sources.create(
      tx,
      product,
      {
        kind: 'discussion',
        url,
        title,
        fragment,
        visibility: 'private',
        usage: 'restricted',
      },
      actor,
      { origin: 'reddit', ...(supersedesId ? { supersedesId } : {}) },
    );
    return { id: src.body.id, audit: src.audit };
  }

  /** Запись пересчёта и полей CAS + аудит (update или transition). */
  private async save(
    tx: PubTx,
    product: ProductRef,
    cur: OpportunityRow,
    expected: number,
    data: Prisma.PubRedditOpportunityUncheckedUpdateManyInput,
    meta: Record<string, unknown>,
    reason?: string | null,
  ): Promise<OpOut<RedditOpportunityView>> {
    await casUpdate(
      tx.pubRedditOpportunity,
      cur.id,
      expected,
      data as Record<string, unknown>,
    );
    const after = await opportunityRow(tx, product.id, cur.id);
    const changed = after.status !== cur.status;
    return {
      body: await loadOpportunityView(tx, product.id, cur.id),
      audit: [
        {
          objectType: 'reddit_opportunity',
          objectId: cur.id,
          action: changed ? 'transition' : 'update',
          fromStatus: cur.status,
          toStatus: after.status,
          reason: reason ?? null,
          meta: {
            ...meta,
            policy: after.policy,
            ruleSnapshotId: after.ruleSnapshotId,
            relevance: after.relevance,
            risk: after.risk,
            priority: after.priority,
          },
        },
      ],
    };
  }

  async patch(
    tx: PubTx,
    product: ProductRef,
    id: string,
    step: Step,
    b: Body,
  ): Promise<OpOut<RedditOpportunityView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const cur = await opportunityRow(tx, product.id, id);
    const is = new Issues();
    onlyFields(is, b, [
      'opKey',
      'expectedRevision',
      'excerpt',
      'titleManual',
      'intent',
      'angle',
      'keywordIds',
      'factors',
    ]);
    const data: Prisma.PubRedditOpportunityUncheckedUpdateManyInput = {};
    // `null` — отвязать выдержку (контракт); проверяется раньше `has`,
    // иначе `is.str` отвечал бы `required` (найдено тестом N-1).
    const excerptIn =
      b.excerpt === null
        ? null
        : has(b, 'excerpt')
          ? is.str(b, 'excerpt', {
              required: true,
              max: EXCERPT_MAX,
              pii: true,
            })
          : undefined;
    profileRefIssue(is, 'excerpt', excerptIn);
    if (has(b, 'titleManual'))
      data.titleManual =
        is.str(b, 'titleManual', { required: true, max: 300, pii: true }) ??
        undefined;
    if (has(b, 'intent'))
      data.intent = is.oneOf(b, 'intent', REDDIT_INTENTS, true);
    if (has(b, 'angle') || b.angle === null)
      data.angle = is.str(b, 'angle', { max: 1000, pii: true }) ?? null;
    profileRefIssue(is, 'titleManual', data.titleManual as string | undefined);
    profileRefIssue(is, 'angle', data.angle as string | null | undefined);
    if (has(b, 'keywordIds'))
      data.keywordIds =
        (await this.keywordIdsOf(tx, product.id, cur.projectId, is, b)) ?? [];
    const factorIssues: FieldIssue[] = [];
    const factorsIn = parseFactors(b.factors, factorIssues);
    for (const x of factorIssues) is.add(x.field, x.code);
    is.throwIfAny();
    if (cur.status === 'archived') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'status',
        from: cur.status,
      });
    }
    await assertParentsActive(tx, product.id, cur.projectId, cur.communityId);
    const audit: AuditInput[] = [];
    if (excerptIn !== undefined && cur.excerptSourceId) {
      // Реаудит N-1: отзыв выдержки (ПД, права, жалоба) окончателен, как в
      // P-B1: ни новой редакции поверх, ни отвязки (иначе отвязка + новый
      // текст вернули бы тот же фрагмент). Отзыв идёт на всю цепочку, поэтому
      // достаточно текущей редакции.
      const prev = await tx.pubSource.findFirst({
        where: { id: cur.excerptSourceId, productId: product.id },
        select: { usage: true },
      });
      if (prev?.usage === 'revoked') {
        throw new PubError('PUB_SOURCE_NOT_ALLOWED', {
          sourceIds: [cur.excerptSourceId],
          reason: 'revoked',
        });
      }
    }
    if (excerptIn !== undefined) {
      // Новая редакция выдержки (прежний источник неизменен, S1-2).
      if (excerptIn === null) data.excerptSourceId = null;
      else {
        const src = await this.excerptSource(
          tx,
          product,
          cur.threadUrl,
          (data.titleManual as string | undefined) ?? cur.titleManual,
          excerptIn,
          step.actor,
          cur.excerptSourceId,
        );
        data.excerptSourceId = src.id;
        audit.push(...src.audit);
      }
    }
    if (factorsIn !== undefined) {
      const e = await this.evaluate(
        tx,
        product.id,
        cur.communityId,
        factorsFromJson(cur.factors),
        factorsIn,
        step.now,
      );
      Object.assign(data, this.scoreData(e), {
        status: statusAfterGate(
          cur.status as RedditOpportunityStatus,
          e.gate.verdict,
        ),
      });
    }
    const out = await this.save(tx, product, cur, expected, data, {
      fields: Object.keys(data),
    });
    return { body: out.body, audit: [...audit, ...out.audit] };
  }

  async score(
    tx: PubTx,
    product: ProductRef,
    id: string,
    step: Step,
    b: Body,
  ): Promise<OpOut<RedditOpportunityView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const is = new Issues();
    onlyFields(is, b, ['opKey', 'expectedRevision']);
    is.throwIfAny();
    const cur = await opportunityRow(tx, product.id, id);
    if (cur.status === 'archived') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        reason: 'status',
        from: cur.status,
      });
    }
    await assertParentsActive(tx, product.id, cur.projectId, cur.communityId);
    const e = await this.evaluate(
      tx,
      product.id,
      cur.communityId,
      factorsFromJson(cur.factors),
      undefined,
      step.now,
    );
    return this.save(
      tx,
      product,
      cur,
      expected,
      {
        ...this.scoreData(e),
        status: statusAfterGate(
          cur.status as RedditOpportunityStatus,
          e.gate.verdict,
        ),
      },
      { rescore: true },
    );
  }

  async transition(
    tx: PubTx,
    product: ProductRef,
    id: string,
    to: 'qualified' | 'skipped' | 'archived',
    step: Step,
    b: Body,
  ): Promise<OpOut<RedditOpportunityView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const is = new Issues();
    onlyFields(is, b, ['opKey', 'expectedRevision', 'reason']);
    const reason = is.str(b, 'reason', { max: 2000, pii: true });
    is.throwIfAny();
    const cur = await opportunityRow(tx, product.id, id);
    const from = cur.status as RedditOpportunityStatus;
    const invalid = (r: string, extra: Record<string, unknown> = {}) =>
      new PubError('PUB_TRANSITION_INVALID', { reason: r, from, ...extra });
    if (to === 'qualified') {
      if (!['new', 'blocked', 'recheck_required'].includes(from))
        throw invalid('status');
      await assertParentsActive(tx, product.id, cur.projectId, cur.communityId);
      // Гейт — по ТЕКУЩЕМУ снимку и сейчас: высокий score BLOCK не снимает.
      const e = await this.evaluate(
        tx,
        product.id,
        cur.communityId,
        factorsFromJson(cur.factors),
        undefined,
        step.now,
      );
      if (e.gate.verdict === 'block')
        throw invalid('policy_block', { reasons: e.gate.reasons });
      // Гейт уже ok, но возможность считалась по прежнему состоянию
      // правил — сначала пересчёт (`POST …/score`), потом отбор.
      if (
        e.gate.verdict === 'recheck_required' ||
        from !== 'new' ||
        cur.policy !== 'ok' ||
        cur.ruleSnapshotId !== (e.snapshot?.id ?? null)
      )
        throw invalid('policy_recheck', { reasons: e.gate.reasons });
    } else if (to === 'skipped') {
      if (!SKIPPABLE.includes(from)) throw invalid('status');
    } else if (from === 'archived') {
      throw invalid('status');
    }
    return this.save(
      tx,
      product,
      cur,
      expected,
      { status: to },
      { to },
      reason ?? null,
    );
  }
}
