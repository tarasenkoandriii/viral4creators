/**
 * Формы ответов REST Э1 (data внутри конверта `{ success, data, meta }`) —
 * стык K3 (маршруты) ↔ K4 (assist/src/lib/knowledge-api.ts повторяет эти
 * типы и разбирает их строго, как site-tma-kit/sites-api.ts). Даты — ISO
 * строки, деньги — микродоллары (number), BigInt наружу не отдаётся.
 * Менять — только через координатора (контракт Э1, §«REST»).
 */

import type { CrawlRunView, SkipReason } from '../site-crawl/types';
import type {
  GateReport,
  SourceKind,
  VersionStatus,
  VersionTrigger,
} from './types';

export type { CrawlRunView };

export interface AssistSettingsView {
  siteId: string;
  enabled: boolean;
  knowledgeVersion: number;
  recrawlEvery: 'manual' | 'weekly' | 'daily';
  nextCrawlAt: string | null;
  hotPages: string[];
  lastCrawl: CrawlRunView | null;
  /** Есть ли у ЗАПРАШИВАЮЩЕГО право на «Админку» (assistAdmin: owner) — показать вкладку. */
  adminAvailable: boolean;
  /** Хотя бы один хост сайта verified — можно полный обход. */
  hasVerifiedHost: boolean;
}

export interface KnowledgeSummary {
  mode: 'site' | 'admin';
  publishedVersion: number;
  pages: {
    read: number;
    skipped: number;
    skippedByReason: Partial<Record<SkipReason, number>>;
  };
  documents: number;
  chunks: number;
  /** Доли языков по фрагментам опубликованной версии: { uk: 0.92, ru: 0.08 }. */
  langs: Record<string, number>;
  lastCrawl: CrawlRunView | null;
  heldVersion: VersionView | null;
  quarantineCount: number;
  /** «Сайт»: 5 вопросов, на которые помощник теперь отвечает (§3.4), с кнопкой «проверить». */
  suggestedQuestions: string[];
  learningBudget: {
    period: string;
    capMicroUsd: number;
    spentMicroUsd: number;
  };
  /** Только «Админка». */
  settings?: AdminKnowledgeSettings;
}

export interface SourceView {
  id: string;
  kind: SourceKind;
  title: string | null;
  status: 'pending_upload' | 'processing' | 'active' | 'failed' | 'disabled';
  error: string | null;
  fileName: string | null;
  bytes: number | null;
  documentsCount: number;
  lastSyncAt: string | null;
  /** url: { urls: string[] } */
  config: Record<string, unknown>;
  createdAt: string;
}

export interface UploadTicketView {
  pathname: string;
  clientToken: string;
  maxBytes: number;
  contentType: string;
  expiresAt: string;
}

export interface CreateSourceResult {
  source: SourceView;
  /** Только kind = file: загрузить файл напрямую в Blob (put из @vercel/blob/client). */
  upload?: UploadTicketView;
}

export interface DocumentView {
  id: string;
  sourceId: string;
  kind: 'page' | 'file' | 'faq' | 'manual';
  url: string | null;
  title: string | null;
  lang: string | null;
  status: 'active' | 'gone' | 'excluded' | 'failed' | 'skipped';
  skipReason: string | null;
  hot: boolean;
  chunks: number;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface FaqView {
  id: string;
  question: string;
  answer: string;
  variants: string[];
  lang: string | null;
  origin: string;
  status: 'active' | 'needs_review' | 'archived';
  updatedAt: string;
}

export interface VersionView {
  number: number;
  status: VersionStatus;
  trigger: VersionTrigger;
  /** { added, removed, changed, chunks, langs } */
  stats: Record<string, unknown>;
  gateReport: GateReport | null;
  heldReason: string | null;
  createdAt: string;
  publishedAt: string | null;
  isPublished: boolean;
  /** В окне отката (7 дней / 5 публикаций) и не текущая. */
  canRollback: boolean;
}

export interface ExclusionView {
  id: string;
  kind: 'url' | 'urlPrefix' | 'chunkHash' | 'document';
  value: string;
  reason: string | null;
  chunksDeleted: number;
  createdAt: string;
}

export interface QuarantineView {
  chunkId: string;
  documentId: string;
  url: string | null;
  title: string | null;
  /** Отрывок ≤ 500 символов — как ДАННЫЕ (текст, не HTML). */
  excerpt: string;
  reason: string | null;
  createdAt: string;
}

export interface AdminKnowledgeSettings {
  includePublicInAdmin: boolean;
  includeUgcInAdmin: boolean;
}

export interface UrlPreview {
  url: string;
  host: string;
  title: string | null;
  lang: string | null;
  sitemapFound: boolean;
  themeColor: string | null;
}

export interface SandboxSourceRef {
  n: number;
  url: string | null;
  title: string | null;
}

export interface SandboxMessageView {
  role: 'visitor' | 'assistant';
  text: string;
  sources: SandboxSourceRef[];
  createdAt: string;
}

export interface SandboxView {
  id: string;
  kind: 'public' | 'cabinet';
  status:
    | 'queued'
    | 'crawling'
    | 'indexing'
    | 'ready'
    | 'failed'
    | 'blocked'
    | 'expired';
  statusReason: string | null;
  url: string;
  host: string;
  title: string | null;
  lang: string | null;
  themeColor: string | null;
  progress: { sitemap: boolean; found: number; read: number; titles: string[] };
  pagesRead: number;
  pagesLimit: number;
  questions: number;
  questionsLimit: number;
  suggestedQuestions: string[];
  messages: SandboxMessageView[];
  expiresAt: string;
  /**
   * Откуда отвечает чат: `sandbox` — 1–10 страниц песочницы; `knowledge` —
   * опубликованная база «Сайта» (сайт подтверждён и проиндексирован).
   */
  answersFrom: 'sandbox' | 'knowledge';
}

export interface SandboxAnswer {
  answer: string;
  sources: SandboxSourceRef[];
  refused: boolean;
  questionsLeft: number;
}

/** Только POST /public/assist/sandbox: ключ браузера — показывается один раз. */
export interface PublicSandboxCreated {
  id: string;
  sandboxKey: string;
  status: SandboxView['status'];
}

export interface SandboxTransferResult {
  siteId: string;
  hostId: string;
}
