/**
 * Типы общего ядра знаний — стык K2 (индексация, поиск, версии) с K3
 * (маршруты, документы, песочница) и K4 (экраны, через api-types.ts).
 * Менять форму — только через координатора (контракт Э1).
 */

import type { ExtractedBlock } from '../site-crawl/types';

export interface KnowledgeCtx {
  accountId: string;
  siteId: string;
}

export type SourceKind =
  | 'crawl' // «Сайт»: публичный обход (один на сайт)
  | 'public_copy' // «Админка»: копия публичного обхода (Р-19)
  | 'url'
  | 'file'
  | 'faq'
  | 'manual'
  // Э-С Ш5: документы владельца через системный API знаний (ключ
  // интеграции сайта) — один на сайт, управляется только этим API.
  | 'api';

export type DocumentKind = 'page' | 'file' | 'faq' | 'manual';

/** Документ на индексацию: текст уже извлечён (страница, файл, FAQ). */
export interface DocumentInput {
  /** Стабильный ключ в источнике: URL | pathname#часть | faq:<id>. */
  ref: string;
  kind: DocumentKind;
  url?: string | null;
  title?: string | null;
  lang?: string | null;
  /** Блоки (страница/файл) — их режет чанкер. */
  blocks: ExtractedBlock[];
  sitePageId?: string | null;
  /** FAQ — пара целиком, без резки (§4.3). */
  faq?: { question: string; answer: string; variants?: string[] };
}

/** Фрагмент после резки, до эмбеддинга. */
export interface ChunkDraft {
  ordinal: number;
  text: string;
  headingPath: string | null;
  tokens: number;
  contentHash: string;
  digitsMaskedHash: string;
  ugc: boolean;
  lang: string | null;
}

export type VersionTrigger =
  | 'crawl'
  | 'document'
  | 'faq'
  | 'exclusion'
  | 'quarantine'
  | 'rollback'
  | 'manual';

export type VersionStatus =
  'building' | 'checking' | 'published' | 'held' | 'discarded';

export interface GateCheck {
  check:
    | 'gone_or_error_share'
    | 'identical_changed_share'
    | 'lang_shift'
    | 'quarantine_share'
    | 'invariant_eval';
  value: number;
  threshold: number;
  held: boolean;
  note?: string;
}

export interface GateReport {
  checks: GateCheck[];
  held: boolean;
  /** Первая версия сайта ворот аномалий не проходит (§4-тер.2). */
  coldStart: boolean;
}

export interface VersionResult {
  number: number;
  status: VersionStatus;
  gateReport: GateReport | null;
}

export interface SearchQuery {
  siteId: string;
  query: string;
  /** По умолчанию — опубликованная версия режима. */
  version?: number;
  /** По умолчанию KNOWLEDGE_DEFAULTS.search.resultTopK. */
  limit?: number;
  /** UGC в выдаче — с пометкой; как подтверждение фактов не используется. */
  includeUgc?: boolean;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  sourceType: DocumentKind;
  url: string | null;
  title: string | null;
  headingPath: string | null;
  text: string;
  lang: string | null;
  ugc: boolean;
  /** Итоговый балл RRF (+ бонус FAQ). */
  score: number;
  vectorRank: number | null;
  textRank: number | null;
}

export interface ExclusionInput {
  kind: 'url' | 'urlPrefix' | 'chunkHash' | 'document';
  value: string;
  reason?: string | null;
}

/**
 * Что режим знаний умеет — реализуют SiteKnowledgeService (assist-site-
 * knowledge) и AdminKnowledgeService (assist-admin-knowledge), оба K2.
 * Вызывают: маршруты и разбор документов (K3), песочница (K3, только
 * search «Сайта»), крон индексации (K2), приёмка (K2).
 *
 * Правило публикации (§4-тер.2, Р-32): действия человека (документ, FAQ,
 * исключение, «включить из карантина», откат) публикуются сразу, без
 * ворот аномалий — проверяется только карантин инъекций; версия из
 * переобхода — через ворота (может стать held).
 */
export interface ModeKnowledgeApi {
  /** Документы источника → новая версия (заменяет документы с теми же ref). */
  indexDocuments(
    ctx: KnowledgeCtx,
    sourceId: string,
    docs: DocumentInput[],
    opts: {
      trigger: VersionTrigger;
      byTelegramId?: bigint | null;
      /** true — документы источника, которых нет в `docs`, становятся gone. */
      replaceAll?: boolean;
    },
  ): Promise<VersionResult>;
  /** Удалить источник/документы из базы (новая версия без них, сразу). */
  removeDocuments(
    ctx: KnowledgeCtx,
    sourceId: string,
    refs: string[] | 'all',
    byTelegramId: bigint | null,
  ): Promise<VersionResult>;
  /** §4-тер.12: фрагменты ВСЕХ версий удаляются сразу; ≤ 5 мин. */
  applyExclusion(
    ctx: KnowledgeCtx,
    exclusion: ExclusionInput,
    byTelegramId: bigint,
  ): Promise<{ chunksDeleted: number; version: VersionResult }>;
  /** Снять исключение: страница вернётся со следующим переобходом. */
  liftExclusion(ctx: KnowledgeCtx, exclusionId: string): Promise<void>;
  allowQuarantined(
    ctx: KnowledgeCtx,
    chunkId: string,
    byTelegramId: bigint,
  ): Promise<VersionResult>;
  publishHeld(
    ctx: KnowledgeCtx,
    number: number,
    byTelegramId: bigint,
  ): Promise<VersionResult>;
  discard(
    ctx: KnowledgeCtx,
    number: number,
    byTelegramId: bigint,
  ): Promise<VersionResult>;
  /** Новая версия с содержимым N (история не переписывается); окно 7 дней / 5 публикаций. */
  rollback(
    ctx: KnowledgeCtx,
    toNumber: number,
    byTelegramId: bigint,
  ): Promise<VersionResult>;
  /** Гибридный поиск (вектор + полнотекст/триграмма → RRF), обязательный siteId. */
  search(q: SearchQuery): Promise<SearchHit[]>;
}
