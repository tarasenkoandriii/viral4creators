/**
 * Обучение на диалогах «Сайта» (Э3, агент L; ТЗ §4-тер.3–4, §4-тер.8,
 * §4-тер.11–15, §2.8 №4, №31) — формы REST кабинета. TMA (T) повторяет их
 * в `assist/src/lib/learning-types.ts` и разбирает строго. Менять — через
 * координатора; необязательные поля — можно (с записью в отчёте).
 * Тексты вопросов — МАСКИРОВАННЫЕ (§4-тер.3 п.1).
 */
import type { SiteAnswerSource } from '../assist-site-chat/chat-types';

export const LEARNING_KINDS = [
  'unknown',
  'wrong',
  'unhappy',
  'operator_fix',
  'voice_miss',
] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

/** Откуда сигнал (assist_site_learning_items.signal). */
export type LearningSignalSource =
  | 'no_answer'
  | 'empty_search'
  | 'thumbs_down'
  | `flag:${string}`
  | 'repeat'
  | 'handoff_after_answer'
  | 'operator'
  // Э3-бис: ИИ-разметка — answerQuality ≤ 2 или ungrounded_suspect (§5-тер.3
  // «Связь с обучением»; ниже по приоритету, чем 👎 и флаги пост-фильтра).
  | 'label';

/** Элемент очереди глазами экрана: кластер или кандидат оператора. */
export type QueueEntryView =
  | {
      entry: 'cluster';
      id: string;
      label: string;
      kind: LearningKind;
      size: number;
      distinctVisitors: number;
      /** До 5 примеров (маскированные вопросы), без посетителей. */
      examples: string[];
      /** Страницы, где спрашивали (без query), ≤ 3. */
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

export interface QueueView {
  entries: QueueEntryView[];
  /** Счётчики для вкладки (открытые кластеры по типам, кандидаты). */
  counts: Record<LearningKind, number> & { candidates: number };
}

/**
 * POST …/learning/site/queue/:itemId/resolve (itemId — id кластера или
 * кандидата). Опубликовать проверенный ответ может только manager/owner
 * (§4-тер.13; оператор — 403, §4-тер.15 п.14).
 */
export type ResolveRequest =
  | {
      action: 'golden';
      question: string;
      answer: string;
      lang?: string | null;
      /** Варианты — из примеров кластера (дословный вопрос посетителя → variantRefs). */
      variants?: string[];
      /** Обновить существующий проверенный ответ вместо нового. */
      faqId?: string | null;
      /**
       * Э3 (L, необязательное): источники черновика (№4) — страница/файл
       * этого сайта, не UGC; без них ответ — слово владельца.
       */
      sourceRefs?: GoldenView['sourceRefs'];
    }
  | { action: 'source'; note?: string | null }
  | { action: 'out_of_scope' }
  | { action: 'ignore' }
  /** Кандидат оператора: принять (→ golden origin=operator_candidate) или отклонить. */
  | { action: 'accept'; answer?: string | null; question?: string | null }
  | { action: 'reject' };

export interface ResolveResult {
  status: 'resolved' | 'ignored';
  /** Создан/обновлён проверенный ответ. */
  faqId: string | null;
  /** Создан кейс eval (golden или «вне знаний»). */
  evalCaseId: string | null;
}

/** POST …/queue/:itemId/draft — черновик по знаниям (№4); без источников — пусто. */
export interface QueueDraftView {
  text: string;
  lang: string | null;
  sources: SiteAnswerSource[];
  /** budget — бюджет обучения исчерпан (§4-тер.11): черновик отложен. */
  status: 'ok' | 'no_sources' | 'budget';
}

/** POST …/learning/site/queue — кандидат оператора из TMA (из бота — кнопкой, H → L). */
export interface CandidateRequest {
  /** Сообщение оператора в диалоге (role=operator). */
  messageId: string;
  /** Ответ, который оператор предлагает всем (по умолчанию — текст его сообщения). */
  answer?: string | null;
}

export interface GoldenView {
  id: string;
  question: string;
  answer: string;
  variants: string[];
  lang: string | null;
  origin: 'owner' | 'wizard' | 'gap' | 'operator_candidate' | 'copied';
  sourceRefs: Array<{
    documentId: string | null;
    url: string | null;
    chunkHash: string | null;
  }>;
  status: 'active' | 'needs_review' | 'archived';
  /** «На сайте теперь: …» (§4-тер.4 «Конфликт с сайтом»). */
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
  /** «Проверено, верно» — снимает needs_review, переносит reviewAt. */
  reviewed?: boolean;
}

/** POST …/golden/copy-to/:targetSiteId — только сайты одного кабинета и одного endClient (§4-тер.10). */
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
  /** Полнота знаний (CompletenessView мастера Э2 — тот же расчёт). */
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
  /** По неделям (§9.1 «метрики обучаемости»): доля unknown, 👍, передач. */
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
  /** Следующий плановый прогон по расписанию тарифа (Р-36; до Э4 — Start: раз в месяц). */
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

/** №31 «симуляция тестовых диалогов перед публикацией» (MVP-лайт: 10 персонажей). */
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
    /** Что насторожило код: ответ без источника, стоп-фраза, флаг чисел … */
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
