/**
 * Клиент «Обучения» (Э3, REST агента L, контракт §6): очередь (кластеры и
 * кандидаты операторов), решение, черновик №4, проверенные ответы,
 * качество, eval, симуляция №31. Разбор строгий (см. `handoff-api.ts`):
 * неизвестный элемент очереди не рисуется, статус «решён» — только явный.
 */

import type { ApiClient } from '../kit';
import { iso, num, parseSources, requestVoid, seg } from './handoff-api';
import {
  GOLDEN_ORIGINS,
  GOLDEN_STATUSES,
  LEARNING_KINDS,
  type CandidateRequest,
  type EvalRunResult,
  type GoldenCopyResult,
  type GoldenCreateRequest,
  type GoldenPatchRequest,
  type GoldenView,
  type LearningKind,
  type QualityView,
  type QueueDraftView,
  type QueueEntryView,
  type QueueView,
  type ResolveRequest,
  type ResolveResult,
  type SimulationView,
} from './learning-types';
import {
  ID,
  arr,
  count,
  obj,
  oneOf,
  safeHttpsUrl,
  str,
  strs,
  text,
} from './widget-api';

/** Доля 0…1 (иное — 0). */
const share = (v: unknown): number => {
  const n = num(v);
  return n !== null && n >= 0 && n <= 1 ? n : 0;
};

export function parseQueueEntry(v: unknown): QueueEntryView | null {
  const o = obj(v);
  if (typeof o.id !== 'string' || !ID.test(o.id)) return null;
  if (o.entry === 'cluster') {
    return {
      entry: 'cluster',
      id: o.id,
      label: text(o.label),
      kind: oneOf(LEARNING_KINDS, o.kind, 'unknown'),
      size: count(o.size),
      distinctVisitors: count(o.distinctVisitors),
      examples: strs(o.examples).slice(0, 5),
      // Страницы — только https и без query (их показываем ссылкой).
      pages: strs(o.pages)
        .map((p) => safeHttpsUrl(p))
        .filter((p): p is string => !!p)
        .slice(0, 3),
      lang: str(o.lang),
      firstSeenAt: text(o.firstSeenAt),
      lastSeenAt: text(o.lastSeenAt),
      status: oneOf(['open', 'resolved', 'ignored'] as const, o.status, 'open'),
      reopened: o.reopened === true,
    };
  }
  if (o.entry === 'candidate') {
    return {
      entry: 'candidate',
      id: o.id,
      kind: 'operator_fix',
      questionMasked: text(o.questionMasked),
      proposedAnswer: text(o.proposedAnswer),
      proposedByMe: o.proposedByMe === true,
      proposedAt: text(o.proposedAt),
      conversationId:
        typeof o.conversationId === 'string' && ID.test(o.conversationId)
          ? o.conversationId
          : null,
      status: oneOf(
        ['proposed', 'resolved', 'ignored'] as const,
        o.status,
        'proposed'
      ),
    };
  }
  return null;
}

export function parseQueue(v: unknown): QueueView {
  const o = obj(v);
  const c = obj(o.counts);
  const counts = Object.fromEntries(
    LEARNING_KINDS.map((k) => [k, count(c[k])])
  ) as Record<LearningKind, number>;
  return {
    entries: arr(o.entries)
      .map(parseQueueEntry)
      .filter((x): x is QueueEntryView => !!x),
    counts: { ...counts, candidates: count(c.candidates) },
  };
}

export function parseResolve(v: unknown): ResolveResult {
  const o = obj(v);
  return {
    status: o.status === 'resolved' ? 'resolved' : 'ignored',
    faqId: str(o.faqId),
    evalCaseId: str(o.evalCaseId),
  };
}

export function parseQueueDraft(v: unknown): QueueDraftView {
  const o = obj(v);
  return {
    text: text(o.text),
    lang: str(o.lang),
    sources: parseSources(o.sources),
    status: oneOf(
      ['ok', 'no_sources', 'budget'] as const,
      o.status,
      'no_sources'
    ),
  };
}

export function parseGolden(v: unknown): GoldenView | null {
  const o = obj(v);
  if (typeof o.id !== 'string' || !ID.test(o.id)) return null;
  return {
    id: o.id,
    question: text(o.question),
    answer: text(o.answer),
    variants: strs(o.variants),
    lang: str(o.lang),
    origin: oneOf(GOLDEN_ORIGINS, o.origin, 'owner'),
    sourceRefs: arr(o.sourceRefs).map((x) => {
      const r = obj(x);
      return {
        documentId: str(r.documentId),
        url: safeHttpsUrl(r.url),
        chunkHash: str(r.chunkHash),
      };
    }),
    // Неизвестный статус — «проверить»: осторожнее, чем «действует».
    status: oneOf(GOLDEN_STATUSES, o.status, 'needs_review'),
    conflictNote: str(o.conflictNote),
    approvedAt: iso(o.approvedAt),
    approvedByMe: o.approvedByMe === true,
    reviewAt: iso(o.reviewAt),
    updatedAt: text(o.updatedAt),
  };
}

export function parseGoldenList(v: unknown): GoldenView[] {
  const list = Array.isArray(v) ? v : arr(obj(v).items);
  return list.map(parseGolden).filter((x): x is GoldenView => !!x);
}

export function parseCopyResult(v: unknown): GoldenCopyResult {
  const o = obj(v);
  return {
    copied: count(o.copied),
    skipped: arr(o.skipped).map((x) => {
      const s = obj(x);
      return {
        id: text(s.id),
        reason: s.reason === 'duplicate' ? 'duplicate' : 'not_found',
      };
    }),
  };
}

export function parseQuality(v: unknown): QualityView {
  const o = obj(v);
  const c = obj(o.completeness);
  const e =
    o.lastEval && typeof o.lastEval === 'object' ? obj(o.lastEval) : null;
  const b = obj(o.learningBudget);
  return {
    completeness: { covered: count(c.covered), total: count(c.total) },
    lastEval: e
      ? {
          id: text(e.id),
          kind: text(e.kind),
          at: text(e.at),
          passed: count(e.passed),
          failed: count(e.failed),
          stale: count(e.stale),
          failures: arr(e.failures).map((x) => {
            const f = obj(x);
            return {
              question: text(f.question),
              expected: str(f.expected),
              got: text(f.got),
              reason: text(f.reason),
            };
          }),
        }
      : null,
    weekly: arr(o.weekly).map((x) => {
      const w = obj(x);
      const up = num(w.thumbsUpShare);
      return {
        weekStart: text(w.weekStart),
        dialogs: count(w.dialogs),
        unknownShare: share(w.unknownShare),
        thumbsUpShare: up !== null && up >= 0 && up <= 1 ? up : null,
        handoffShare: share(w.handoffShare),
      };
    }),
    learningBudget: {
      spentMicroUsd: count(b.spentMicroUsd),
      capMicroUsd: count(b.capMicroUsd),
      period: text(b.period),
    },
    nextScheduledEvalAt: iso(o.nextScheduledEvalAt),
    goldenNeedsReview: count(o.goldenNeedsReview),
  };
}

export function parseEvalRun(v: unknown): EvalRunResult {
  const o = obj(v);
  if (o.status === 'done') {
    return {
      status: 'done',
      runId: text(o.runId),
      passed: count(o.passed),
      failed: count(o.failed),
      stale: count(o.stale),
    };
  }
  return { status: 'deferred', reason: 'budget' };
}

export function parseSimulation(v: unknown): SimulationView {
  const o = obj(v);
  return {
    status: o.status === 'done' ? 'done' : 'deferred',
    reason: o.reason === 'budget' ? 'budget' : null,
    personas: arr(o.personas).map((x) => {
      const p = obj(x);
      return {
        key: text(p.key),
        title: text(p.title),
        turns: arr(p.turns).map((t) => {
          const q = obj(t);
          return {
            question: text(q.question),
            answer: text(q.answer),
            sources: parseSources(q.sources),
            refused: q.refused === true,
          };
        }),
        issues: strs(p.issues),
      };
    }),
  };
}

export interface LearningApi {
  queue(
    siteId: string,
    q?: { kind?: string; status?: string }
  ): Promise<QueueView>;
  propose(
    siteId: string,
    body: CandidateRequest
  ): Promise<QueueEntryView | null>;
  resolve(
    siteId: string,
    itemId: string,
    body: ResolveRequest
  ): Promise<ResolveResult>;
  draft(siteId: string, itemId: string): Promise<QueueDraftView>;
  golden(siteId: string): Promise<GoldenView[]>;
  createGolden(
    siteId: string,
    body: GoldenCreateRequest
  ): Promise<GoldenView | null>;
  patchGolden(
    siteId: string,
    gid: string,
    body: GoldenPatchRequest
  ): Promise<GoldenView | null>;
  deleteGolden(siteId: string, gid: string): Promise<void>;
  copyGolden(
    siteId: string,
    targetSiteId: string,
    ids: string[]
  ): Promise<GoldenCopyResult>;
  quality(siteId: string): Promise<QualityView>;
  evalRun(siteId: string): Promise<EvalRunResult>;
  simulate(siteId: string): Promise<SimulationView>;
}

export function createLearningApi(client: ApiClient): LearningApi {
  const base = (s: string) => `/assist/sites/${seg(s)}/learning/site`;
  return {
    queue: async (s, q = {}) => {
      const p = new URLSearchParams();
      if (q.kind && /^[a-z_]{1,20}$/.test(q.kind)) p.set('kind', q.kind);
      if (q.status && /^[a-z_]{1,20}$/.test(q.status))
        p.set('status', q.status);
      const qs = p.toString();
      return parseQueue(
        await client.request('GET', `${base(s)}/queue${qs ? `?${qs}` : ''}`)
      );
    },
    propose: async (s, body) =>
      parseQueueEntry(await client.request('POST', `${base(s)}/queue`, body)),
    resolve: async (s, id, body) =>
      parseResolve(
        await client.request(
          'POST',
          `${base(s)}/queue/${seg(id)}/resolve`,
          body
        )
      ),
    draft: async (s, id) =>
      parseQueueDraft(
        await client.request('POST', `${base(s)}/queue/${seg(id)}/draft`)
      ),
    golden: async (s) =>
      parseGoldenList(await client.request('GET', `${base(s)}/golden`)),
    createGolden: async (s, body) =>
      parseGolden(await client.request('POST', `${base(s)}/golden`, body)),
    patchGolden: async (s, gid, body) =>
      parseGolden(
        await client.request('PATCH', `${base(s)}/golden/${seg(gid)}`, body)
      ),
    deleteGolden: (s, gid) =>
      requestVoid(client, 'DELETE', `${base(s)}/golden/${seg(gid)}`),
    copyGolden: async (s, target, ids) =>
      parseCopyResult(
        await client.request(
          'POST',
          `${base(s)}/golden/copy-to/${seg(target)}`,
          {
            ids,
          }
        )
      ),
    quality: async (s) =>
      parseQuality(await client.request('GET', `${base(s)}/quality`)),
    evalRun: async (s) =>
      parseEvalRun(await client.request('POST', `${base(s)}/eval-run`)),
    simulate: async (s) =>
      parseSimulation(await client.request('POST', `${base(s)}/simulate`)),
  };
}
