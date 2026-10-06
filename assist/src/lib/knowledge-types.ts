/**
 * Формы ответов REST Э1 «Знания» и «Песочница» — повтор
 * `sites-backend/src/modules/assist-knowledge-core/api-types.ts` (источник
 * истины — он; контракт Э1 §3 K4). Фронт и сервер деплоятся отдельно,
 * поэтому типы не импортируются оттуда, а повторяются, и
 * `scripts/knowledge-api.test.ts` сверяет имена полей с тем файлом.
 *
 * Отличие одно: `skippedByReason` здесь допускает ключ `other` — так
 * разбор сохраняет причину, которой фронт ещё не знает (см. kit/crawl.ts).
 */

import type { CrawlRunView, SkipReasonKey } from '../kit';

export type { CrawlRunView };

export type KnowledgeMode = 'site' | 'admin';

export const SOURCE_KINDS = [
  'crawl',
  'public_copy',
  'url',
  'file',
  'faq',
  'manual',
  // Э-С Ш5: документы по системному API знаний (ключ knsec_, см. «Интеграции»).
  'api',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const VERSION_STATUSES = [
  'building',
  'checking',
  'published',
  'held',
  'discarded',
] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const VERSION_TRIGGERS = [
  'crawl',
  'document',
  'faq',
  'exclusion',
  'quarantine',
  'rollback',
  'manual',
] as const;
export type VersionTrigger = (typeof VERSION_TRIGGERS)[number];

export const GATE_CHECKS = [
  'gone_or_error_share',
  'identical_changed_share',
  'lang_shift',
  'quarantine_share',
  'invariant_eval',
] as const;
export type GateCheckName = (typeof GATE_CHECKS)[number];

export interface GateCheck {
  check: GateCheckName;
  value: number;
  threshold: number;
  held: boolean;
  note?: string;
}

export interface GateReport {
  checks: GateCheck[];
  held: boolean;
  coldStart: boolean;
}

export const RECRAWL_EVERY = ['manual', 'weekly', 'daily'] as const;
export type RecrawlEvery = (typeof RECRAWL_EVERY)[number];

export interface AssistSettingsView {
  siteId: string;
  enabled: boolean;
  knowledgeVersion: number;
  recrawlEvery: RecrawlEvery;
  nextCrawlAt: string | null;
  hotPages: string[];
  lastCrawl: CrawlRunView | null;
  adminAvailable: boolean;
  hasVerifiedHost: boolean;
}

export interface KnowledgeSummary {
  mode: KnowledgeMode;
  publishedVersion: number;
  pages: {
    read: number;
    skipped: number;
    skippedByReason: Partial<Record<SkipReasonKey, number>>;
  };
  documents: number;
  chunks: number;
  langs: Record<string, number>;
  lastCrawl: CrawlRunView | null;
  heldVersion: VersionView | null;
  quarantineCount: number;
  suggestedQuestions: string[];
  learningBudget: {
    period: string;
    capMicroUsd: number;
    spentMicroUsd: number;
  };
  settings?: AdminKnowledgeSettings;
}

export const SOURCE_STATUSES = [
  'pending_upload',
  'processing',
  'active',
  'failed',
  'disabled',
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export interface SourceView {
  id: string;
  kind: SourceKind;
  title: string | null;
  status: SourceStatus;
  error: string | null;
  fileName: string | null;
  bytes: number | null;
  documentsCount: number;
  lastSyncAt: string | null;
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
  upload?: UploadTicketView;
}

export const DOCUMENT_KINDS = ['page', 'file', 'faq', 'manual'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_STATUSES = [
  'active',
  'gone',
  'excluded',
  'failed',
  'skipped',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export interface DocumentView {
  id: string;
  sourceId: string;
  kind: DocumentKind;
  url: string | null;
  title: string | null;
  lang: string | null;
  status: DocumentStatus;
  skipReason: string | null;
  hot: boolean;
  chunks: number;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const FAQ_STATUSES = ['active', 'needs_review', 'archived'] as const;
export type FaqStatus = (typeof FAQ_STATUSES)[number];

export interface FaqView {
  id: string;
  question: string;
  answer: string;
  variants: string[];
  lang: string | null;
  origin: string;
  status: FaqStatus;
  updatedAt: string;
}

export interface VersionView {
  number: number;
  status: VersionStatus;
  trigger: VersionTrigger;
  stats: Record<string, unknown>;
  gateReport: GateReport | null;
  heldReason: string | null;
  createdAt: string;
  publishedAt: string | null;
  isPublished: boolean;
  canRollback: boolean;
}

export const EXCLUSION_KINDS = [
  'url',
  'urlPrefix',
  'chunkHash',
  'document',
] as const;
export type ExclusionKind = (typeof EXCLUSION_KINDS)[number];

export interface ExclusionView {
  id: string;
  kind: ExclusionKind;
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

export const SANDBOX_STATUSES = [
  'queued',
  'crawling',
  'indexing',
  'ready',
  'failed',
  'blocked',
  'expired',
] as const;
export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

export interface SandboxView {
  id: string;
  kind: 'public' | 'cabinet';
  status: SandboxStatus;
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
  answersFrom: 'sandbox' | 'knowledge';
}

export interface SandboxAnswer {
  answer: string;
  sources: SandboxSourceRef[];
  refused: boolean;
  questionsLeft: number;
}

export interface SandboxTransferResult {
  siteId: string;
  hostId: string;
}
