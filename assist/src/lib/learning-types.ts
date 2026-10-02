/**
 * Обучение на диалогах (Э3, сервер — агент L) — повтор
 * `sites-backend/src/modules/assist-site-learning/api-types.ts`
 * (`scripts/e3-api.test.ts` сверяет перечни и поля). Вопросы —
 * маскированные; всё рисуется текстом.
 */
import type { SiteAnswerSource } from './handoff-types';

export const LEARNING_KINDS = [
  'unknown',
  'wrong',
  'unhappy',
  'operator_fix',
  'voice_miss',
] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

export type QueueEntryView =
  | {
      entry: 'cluster';
      id: string;
      label: string;
      kind: LearningKind;
      size: number;
      distinctVisitors: number;
      examples: string[];
      pages: string[];
      lang: string | null;
      firstSeenAt: string;
      lastSeenAt: string;
      status: 'open' | 'resolved' | 'ignored';
      reopened: boolean;
    }
  | {
      entry: 'candidate';
      id: string;
      kind: 'operator_fix';
      questionMasked: string;
      proposedAnswer: string;
      proposedByMe: boolean;
      proposedAt: string;
      conversationId: string | null;
      status: 'proposed' | 'resolved' | 'ignored';
    };

export type ClusterEntry = Extract<QueueEntryView, { entry: 'cluster' }>;
export type CandidateEntry = Extract<QueueEntryView, { entry: 'candidate' }>;

export interface QueueView {
  entries: QueueEntryView[];
  counts: Record<LearningKind, number> & { candidates: number };
}

export type ResolveRequest =
  | {
      action: 'golden';
      question: string;
      answer: string;
      lang?: string | null;
      variants?: string[];
      faqId?: string | null;
    }
  | { action: 'source'; note?: string | null }
  | { action: 'out_of_scope' }
  | { action: 'ignore' }
  | { action: 'accept'; answer?: string | null; question?: string | null }
  | { action: 'reject' };

export interface ResolveResult {
  status: 'resolved' | 'ignored';
  faqId: string | null;
  evalCaseId: string | null;
}

export interface QueueDraftView {
  text: string;
  lang: string | null;
  sources: SiteAnswerSource[];
  status: 'ok' | 'no_sources' | 'budget';
}

export interface CandidateRequest {
  messageId: string;
  answer?: string | null;
}

export const GOLDEN_ORIGINS = [
  'owner',
  'wizard',
  'gap',
  'operator_candidate',
  'copied',
] as const;
export type GoldenOrigin = (typeof GOLDEN_ORIGINS)[number];

export const GOLDEN_STATUSES = ['active', 'needs_review', 'archived'] as const;
export type GoldenStatus = (typeof GOLDEN_STATUSES)[number];

export interface GoldenView {
  id: string;
  question: string;
  answer: string;
  variants: string[];
  lang: string | null;
  origin: GoldenOrigin;
  sourceRefs: Array<{
    documentId: string | null;
    url: string | null;
    chunkHash: string | null;
  }>;
  status: GoldenStatus;
  conflictNote: string | null;
  approvedAt: string | null;
  approvedByMe: boolean;
  reviewAt: string | null;
  updatedAt: string;
}

export interface GoldenCreateRequest {
  question: string;
  answer: string;
  variants?: string[];
  lang?: string | null;
  sourceRefs?: GoldenView['sourceRefs'];
}

export interface GoldenPatchRequest {
  question?: string;
  answer?: string;
  variants?: string[];
  lang?: string | null;
  status?: 'active' | 'archived';
  reviewed?: boolean;
}

export interface GoldenCopyRequest {
  ids: string[];
}
export interface GoldenCopyResult {
  copied: number;
  skipped: Array<{ id: string; reason: 'duplicate' | 'not_found' }>;
}

export interface EvalFailureView {
  question: string;
  expected: string | null;
  got: string;
  reason: string;
}

export interface QualityView {
  completeness: { covered: number; total: number };
  lastEval: {
    id: string;
    kind: string;
    at: string;
    passed: number;
    failed: number;
    stale: number;
    failures: EvalFailureView[];
  } | null;
  weekly: Array<{
    weekStart: string;
    dialogs: number;
    unknownShare: number;
    thumbsUpShare: number | null;
    handoffShare: number;
  }>;
  learningBudget: {
    spentMicroUsd: number;
    capMicroUsd: number;
    period: string;
  };
  nextScheduledEvalAt: string | null;
  goldenNeedsReview: number;
}

export type EvalRunResult =
  | {
      status: 'done';
      runId: string;
      passed: number;
      failed: number;
      stale: number;
    }
  | { status: 'deferred'; reason: 'budget' };

export interface SimulationView {
  status: 'done' | 'deferred';
  reason: 'budget' | null;
  personas: Array<{
    key: string;
    title: string;
    turns: Array<{
      question: string;
      answer: string;
      sources: SiteAnswerSource[];
      refused: boolean;
    }>;
    issues: string[];
  }>;
}

export const LEARNING_ERROR_CODES = [
  'LEARNING_ITEM_NOT_FOUND',
  'LEARNING_RESOLVE_INVALID',
  'GOLDEN_INVALID',
  'GOLDEN_NOT_FOUND',
  'COPY_TARGET_FORBIDDEN',
  'CANDIDATE_INVALID',
  'LEARNING_BUDGET',
] as const;
export type LearningErrorCode = (typeof LEARNING_ERROR_CODES)[number];
