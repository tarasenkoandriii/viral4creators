/**
 * Строки таблиц режима в том виде, в каком их читает общий код маршрутов
 * знаний (K3), и перевод в формы API (`api-types.ts`, стык с K4).
 *
 * Почему свои интерфейсы, а не типы Prisma: нейтральный модуль не может
 * назвать модели режимов (правило графа neutral-names) — таблицы ему
 * передаёт модуль режима (`ModeAdapter`, mode-knowledge.core.ts). Формы
 * таблиц «Сайта» и «Админки» одинаковы (schema.prisma), поэтому оба набора
 * делегатов подходят под эти интерфейсы.
 */
import type { Prisma } from '@prisma/client';
import type {
  DocumentView,
  ExclusionView,
  FaqView,
  QuarantineView,
  SourceView,
  VersionView,
} from '../api-types';
import type {
  GateReport,
  SourceKind,
  VersionStatus,
  VersionTrigger,
} from '../types';

export interface SourceRow {
  id: string;
  accountId: string;
  siteId: string;
  kind: string;
  title: string | null;
  config: Prisma.JsonValue;
  status: string;
  error: string | null;
  blobPathname: string | null;
  fileName: string | null;
  mimeType: string | null;
  bytes: number | null;
  sha256: string | null;
  documentsCount: number;
  lastSyncAt: Date | null;
  lockedUntil: Date | null;
  attempts: number;
  createdByTelegramId: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentRow {
  id: string;
  sourceId: string;
  ref: string;
  kind: string;
  url: string | null;
  title: string | null;
  lang: string | null;
  status: string;
  skipReason: string | null;
  hot: boolean;
  updatedAt: Date;
}

export interface ChunkRow {
  id: string;
  documentId: string;
  url: string | null;
  title: string | null;
  headingPath: string | null;
  text: string;
  quarantineReason: string | null;
  createdAt: Date;
}

export interface VersionRow {
  number: number;
  status: string;
  trigger: string;
  stats: Prisma.JsonValue;
  gateReport: Prisma.JsonValue | null;
  heldReason: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface FaqRow {
  id: string;
  siteId: string;
  question: string;
  answer: string;
  variants: string[];
  lang: string | null;
  origin: string;
  status: string;
  documentId: string | null;
  updatedAt: Date;
}

export interface ExclusionRow {
  id: string;
  kind: string;
  value: string;
  reason: string | null;
  chunksDeleted: number;
  createdAt: Date;
}

/**
 * Минимум делегата Prisma, нужный общему коду. Аргументы — объектами
 * Prisma как есть (их форма одинакова у обоих режимов); проверку формы
 * держат тесты на настоящей базе (acceptance/e1/knowledge-routes.http.spec.ts).
 */
export interface RowDelegate<R> {
  findMany(args: object): Promise<R[]>;
  findFirst(args: object): Promise<R | null>;
  create(args: object): Promise<R>;
  update(args: object): Promise<R>;
  updateMany(args: object): Promise<{ count: number }>;
  delete(args: object): Promise<R>;
  deleteMany(args: object): Promise<{ count: number }>;
  count(args: object): Promise<number>;
  groupBy(args: object): Promise<Array<Record<string, unknown>>>;
}

export interface ModeRows {
  source: RowDelegate<SourceRow>;
  document: RowDelegate<DocumentRow>;
  chunk: RowDelegate<ChunkRow>;
  version: RowDelegate<VersionRow>;
  faq: RowDelegate<FaqRow>;
  exclusion: RowDelegate<ExclusionRow>;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const SOURCE_STATUSES = [
  'pending_upload',
  'processing',
  'active',
  'failed',
  'disabled',
] as const;

function asRecord(v: Prisma.JsonValue | null): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function sourceView(r: SourceRow): SourceView {
  const status = (SOURCE_STATUSES as readonly string[]).includes(r.status)
    ? (r.status as SourceView['status'])
    : 'failed';
  return {
    id: r.id,
    kind: r.kind as SourceKind,
    title: r.title,
    status,
    error: r.error,
    fileName: r.fileName,
    bytes: r.bytes,
    documentsCount: r.documentsCount,
    lastSyncAt: iso(r.lastSyncAt),
    config: asRecord(r.config),
    createdAt: r.createdAt.toISOString(),
  };
}

export function documentView(r: DocumentRow, chunks: number): DocumentView {
  return {
    id: r.id,
    sourceId: r.sourceId,
    kind: r.kind as DocumentView['kind'],
    url: r.url,
    title: r.title,
    lang: r.lang,
    status: r.status as DocumentView['status'],
    skipReason: r.skipReason,
    hot: r.hot,
    chunks,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function faqView(r: FaqRow): FaqView {
  return {
    id: r.id,
    question: r.question,
    answer: r.answer,
    variants: r.variants,
    lang: r.lang,
    origin: r.origin,
    status: r.status as FaqView['status'],
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function exclusionView(r: ExclusionRow): ExclusionView {
  return {
    id: r.id,
    kind: r.kind as ExclusionView['kind'],
    value: r.value,
    reason: r.reason,
    chunksDeleted: r.chunksDeleted,
    createdAt: r.createdAt.toISOString(),
  };
}

export function quarantineView(r: ChunkRow): QuarantineView {
  return {
    chunkId: r.id,
    documentId: r.documentId,
    url: r.url,
    title: r.title,
    excerpt: r.text.slice(0, 500),
    reason: r.quarantineReason,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * `stats` версии для кабинета. Прогресс сборки `stats.build` (W5) — рабочее
 * состояние индексатора: очередь ref всех документов (до ~150 КБ на 2 000
 * страниц), удаления, хеши, захват. Наружу — только `{ cursor, total }`
 * (сколько из скольких), остальное остаётся в базе.
 */
export function versionStatsView(
  stats: Prisma.JsonValue | null,
): Record<string, unknown> {
  const all = asRecord(stats);
  if (!('build' in all)) return all;
  const { build, ...rest } = all;
  const b = asRecord(build as Prisma.JsonValue);
  const n = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return { ...rest, build: { cursor: n(b.cursor), total: n(b.total) } };
}

export function versionView(
  r: VersionRow,
  published: number,
  rollbackable: Set<number>,
): VersionView {
  return {
    number: r.number,
    status: r.status as VersionStatus,
    trigger: r.trigger as VersionTrigger,
    stats: versionStatsView(r.stats),
    gateReport: (r.gateReport as GateReport | null) ?? null,
    heldReason: r.heldReason,
    createdAt: r.createdAt.toISOString(),
    publishedAt: iso(r.publishedAt),
    isPublished: r.number === published,
    canRollback: rollbackable.has(r.number),
  };
}
