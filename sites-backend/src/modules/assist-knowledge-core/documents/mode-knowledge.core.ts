/**
 * Общий код маршрутов знаний режима — K3 (контракт Э1 §«REST», ТЗ §3.4,
 * §4.16, §4-тер.12–.14): источники (url/файл), документы, FAQ, исключения,
 * версии, карантин, сводка, разбор загруженных файлов кроном.
 *
 * Нейтральный: таблиц режимов не называет. Модуль режима передаёт
 * `ModeAdapter` — свои делегаты Prisma (через `SitesDb.forAccount`) и свою
 * реализацию `ModeKnowledgeApi` (K2). Поэтому «Админка» физически не
 * может записать FAQ в таблицу «Сайта» и наоборот: у её адаптера других
 * делегатов нет (слой 2, §4.3-бис), а режим выбирает МАРШРУТ (слой 5).
 *
 * Разделение труда (контракт Э1 §4 «K3 → K2»): строки источников,
 * документов-файлов, FAQ и исключений пишет этот код; фрагменты и версии —
 * только K2 через `ModeKnowledgeApi`.
 */
import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { isIP } from 'net';
import { KNOWLEDGE_DEFAULTS } from '../../../config/assist-defaults';
import type { SitesDb } from '../../../prisma/sites-db.service';
import type { AccountMembership } from '../../site-core/account/roles';
import type { HostAccessService } from '../../site-core/ownership/host-access.service';
import type { HostPurpose } from '../../site-core/ownership/host-access';
import { notFoundSite } from '../../site-core/site-core.constants';
import type { SiteCrawlService } from '../../site-crawl/crawl.service';
import type { PublicPageFetcher } from '../../site-crawl/page-fetcher';
import type { CrawlCacheDb, SkipReason } from '../../site-crawl/types';
import { normalizeCrawlUrl } from '../../site-crawl/url';
import type { LearningBudget } from '../../site-ai/learning-budget';
import type {
  CreateSourceResult,
  DocumentView,
  ExclusionView,
  FaqView,
  KnowledgeSummary,
  Page,
  QuarantineView,
  SourceView,
  VersionView,
} from '../api-types';
import type { KnowledgeMode } from '../tables';
import type {
  DocumentInput,
  KnowledgeCtx,
  ModeKnowledgeApi,
  VersionResult,
} from '../types';
import type { KnowledgeBlobStorage } from './blob-storage';
import { e1CodeOf, e1Error } from './errors';
import type {
  CreateExclusionDto,
  CreateFaqDto,
  CreateSourceDto,
  DocumentsQueryDto,
  PatchFaqDto,
  PatchSourceDto,
} from './knowledge.dto';
import {
  DocumentParseError,
  formatFor,
  parseDocument,
  safeFileName,
} from './parse';
import {
  ModeRows,
  RowDelegate,
  SourceRow,
  VersionRow,
  documentView,
  exclusionView,
  faqView,
  quarantineView,
  sourceView,
  versionView,
} from './rows';

/** Источников одного режима на сайт. */
export const MAX_SOURCES_PER_SITE = KNOWLEDGE_DEFAULTS.maxSourcesPerSite;
/** Документов на страницу списка (контракт: Page<DocumentView> по 50). */
export const DOCUMENTS_PAGE = 50;
/** Lease разбора файла кроном и попыток до failed. */
export const PROCESS_LEASE_MS = KNOWLEDGE_DEFAULTS.processLeaseMs;
export const PROCESS_MAX_ATTEMPTS = KNOWLEDGE_DEFAULTS.processMaxAttempts;

/** Что модуль режима даёт общему коду. */
export interface ModeAdapter {
  readonly mode: KnowledgeMode;
  readonly api: ModeKnowledgeApi;
  /** Делегаты режима на клиенте кабинета (`SitesDb.forAccount`). */
  rows(accountId: string): ModeRows;
  /** Источники режима на системном клиенте — крон разбора идёт по всем кабинетам. */
  systemSources(): RowDelegate<SourceRow>;
  /** Опубликованная версия режима (0 — базы ещё нет). */
  publishedVersion(ctx: KnowledgeCtx): Promise<number>;
  /** Назначение проверки хоста для url-источников (`assist-crawl` | `assist-admin`). */
  readonly urlPurpose: HostPurpose;
  /** «Этот файл увидят все посетители» (§3.4) — только «Сайт». */
  readonly requirePublicConfirm: boolean;
  /** Колонки строки файла, которые есть только у таблицы этого режима. */
  fileCreateExtra(now: Date): Record<string, unknown>;
  /** Строка настроек режима (счётчик версий K2) — до первой записи знаний. */
  ensureSettings(ctx: KnowledgeCtx): Promise<void>;
}

export interface ModeCoreDeps {
  db: SitesDb;
  blob: KnowledgeBlobStorage;
  fetcher: PublicPageFetcher;
  hosts: HostAccessService;
  crawl: SiteCrawlService;
  budget: LearningBudget;
}

/** Нормализованный https-URL (без фрагмента) или null. Порт — только 443. */
export function normalizeHttpsUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.port && u.port !== '443') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/\.$/, '');
  if (!host || host.startsWith('[') || isIP(host) !== 0) return null;
  u.hash = '';
  return u;
}

/** Кто меняет FAQ: участник кабинета или системный код (Э3, telegramId = null). */
type FaqActor = Pick<AccountMembership, 'accountId'> & {
  telegramId: bigint | null;
};

function ctxOf(m: { accountId: string }, siteId: string): KnowledgeCtx {
  return { accountId: m.accountId, siteId };
}

function faqRef(id: string): string {
  return `faq:${id}`;
}

/** Причина сбоя разбора — фраза для владельца; транзиентное — null. */
function permanentFailure(e: unknown): string | null {
  if (e instanceof DocumentParseError) return e.message;
  const code = e1CodeOf(e);
  if (code && code.startsWith('DOCUMENT_')) return (e as Error).message;
  return null;
}

export class ModeKnowledgeCore {
  private readonly logger: Logger;

  constructor(
    readonly adapter: ModeAdapter,
    private readonly deps: ModeCoreDeps,
  ) {
    this.logger = new Logger(`KnowledgeRoutes:${adapter.mode}`);
  }

  private rows(m: { accountId: string }): ModeRows {
    return this.adapter.rows(m.accountId);
  }

  /** Сайт кабинета или 404 (чужой сайт — «не найден», не 403). */
  async requireSite(m: AccountMembership, siteId: string) {
    const site = await this.deps.db
      .forAccount(m.accountId)
      .site.findFirst({ where: { id: siteId } });
    if (!site) throw notFoundSite();
    return site;
  }

  private async requireSource(
    m: AccountMembership,
    siteId: string,
    sid: string,
  ) {
    const s = await this.rows(m).source.findFirst({
      where: { id: sid, siteId },
    });
    if (!s) throw e1Error(404, 'SOURCE_NOT_FOUND', 'Источник не найден');
    return s;
  }

  /** Клиент кэша robots/opt-out для fetcher'а K1 — таблицы вне тенанта. */
  private crawlDb(): CrawlCacheDb {
    return this.deps.db.system(
      'url-источник знаний: кэш robots и отказ доменов',
    );
  }

  // ── Источники ─────────────────────────────────────────────────────────

  async listSources(
    m: AccountMembership,
    siteId: string,
  ): Promise<SourceView[]> {
    await this.requireSite(m, siteId);
    const rows = await this.rows(m).source.findMany({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(sourceView);
  }

  /** Адреса url-источника: https, только хосты этого сайта. */
  async validateUrls(
    m: AccountMembership,
    siteId: string,
    raw: string[],
  ): Promise<string[]> {
    const hosts = await this.deps.db
      .forAccount(m.accountId)
      .siteHost.findMany({ where: { siteId }, select: { host: true } });
    const allowed = new Set(hosts.map((h) => h.host));
    const out: string[] = [];
    for (const r of raw) {
      const u = normalizeHttpsUrl(r);
      if (!u) {
        throw e1Error(
          400,
          'URL_INVALID',
          `Не похоже на https-адрес страницы: ${r.slice(0, 200)}`,
        );
      }
      if (!allowed.has(u.hostname)) {
        throw e1Error(
          400,
          'URL_INVALID',
          `Адрес не на хосте этого сайта: ${u.hostname} — добавьте хост в сайт`,
        );
      }
      // Форма обхода (normalizeCrawlUrl): горячие страницы сверяются с
      // site_pages.url и документами по равенству строк — адрес из браузера
      // с utm-метками иначе никогда не стал бы «горячим» (§4-тер.11).
      const key = normalizeCrawlUrl(u.toString()) ?? u.toString();
      if (!out.includes(key)) out.push(key);
    }
    return out;
  }

  async createSource(
    m: AccountMembership,
    siteId: string,
    dto: CreateSourceDto,
    now = new Date(),
  ): Promise<CreateSourceResult> {
    await this.requireSite(m, siteId);
    await this.adapter.ensureSettings(ctxOf(m, siteId));
    const rows = this.rows(m);
    const count = await rows.source.count({ where: { siteId } });
    if (count >= MAX_SOURCES_PER_SITE) {
      throw e1Error(
        409,
        'KNOWLEDGE_SOURCE_LIMIT',
        `У сайта уже ${MAX_SOURCES_PER_SITE} источников — удалите ненужные`,
      );
    }

    if (dto.kind === 'url') {
      const urls = await this.validateUrls(m, siteId, dto.urls ?? []);
      const row = await rows.source.create({
        data: {
          accountId: m.accountId,
          siteId,
          kind: 'url',
          title: dto.title?.trim() || null,
          config: { urls },
          status: 'processing',
          createdByTelegramId: m.telegramId,
        },
      });
      return { source: sourceView(row) };
    }

    const fileName = safeFileName(dto.fileName ?? '');
    const mimeType = (dto.mimeType ?? '').split(';')[0].trim().toLowerCase();
    if (!formatFor(fileName, mimeType)) {
      throw e1Error(
        400,
        'DOCUMENT_TYPE',
        'Поддерживаются PDF, DOCX, TXT, MD и CSV',
      );
    }
    const bytes = dto.bytes ?? 0;
    if (bytes > KNOWLEDGE_DEFAULTS.maxDocumentBytes) {
      throw e1Error(
        400,
        'DOCUMENT_TOO_LARGE',
        'Файл больше 20 МБ — разделите его на части',
      );
    }
    if (this.adapter.requirePublicConfirm && dto.confirmPublic !== true) {
      throw e1Error(
        400,
        'PUBLIC_CONFIRM_REQUIRED',
        'Подтвердите, что этот файл увидят все посетители сайта',
      );
    }
    const row = await rows.source.create({
      data: {
        accountId: m.accountId,
        siteId,
        kind: 'file',
        title: dto.title?.trim() || fileName,
        status: 'pending_upload',
        fileName,
        mimeType,
        bytes,
        createdByTelegramId: m.telegramId,
        ...this.adapter.fileCreateExtra(now),
      },
    });
    try {
      const upload = await this.deps.blob.issueUpload({
        mode: this.adapter.mode,
        accountId: m.accountId,
        siteId,
        sourceId: row.id,
        fileName,
        contentType: mimeType,
        bytes,
      });
      const saved = await rows.source.update({
        where: { id: row.id },
        data: { blobPathname: upload.pathname },
      });
      return { source: sourceView(saved), upload };
    } catch (e) {
      // Источник без токена загрузки — мусор в списке.
      await rows.source
        .deleteMany({ where: { id: row.id } })
        .catch(() => undefined);
      throw e;
    }
  }

  /** TMA: файл загружен в Blob → проверить размер/тип → в очередь разбора. */
  async markUploaded(
    m: AccountMembership,
    siteId: string,
    sid: string,
  ): Promise<SourceView> {
    await this.requireSite(m, siteId);
    const src = await this.requireSource(m, siteId, sid);
    if (src.kind !== 'file' || !src.blobPathname) {
      throw e1Error(409, 'SOURCE_READONLY', 'Это не файловый источник');
    }
    if (src.status === 'processing' || src.status === 'active') {
      return sourceView(src);
    }
    const stat = await this.deps.blob.stat(src.blobPathname);
    if (!stat) {
      throw e1Error(
        409,
        'DOCUMENT_NOT_UPLOADED',
        'Файл ещё не загружен — повторите загрузку',
      );
    }
    const declared = src.bytes ?? KNOWLEDGE_DEFAULTS.maxDocumentBytes;
    if (
      stat.size > declared ||
      stat.size > KNOWLEDGE_DEFAULTS.maxDocumentBytes
    ) {
      await this.deps.blob.remove(src.blobPathname).catch(() => undefined);
      throw e1Error(
        400,
        'DOCUMENT_TOO_LARGE',
        'Файл больше заявленного размера — загрузите заново',
      );
    }
    if (stat.contentType.split(';')[0].trim().toLowerCase() !== src.mimeType) {
      await this.deps.blob.remove(src.blobPathname).catch(() => undefined);
      throw e1Error(
        400,
        'DOCUMENT_TYPE',
        'Тип загруженного файла не совпадает с заявленным',
      );
    }
    const saved = await this.rows(m).source.update({
      where: { id: sid },
      data: {
        status: 'processing',
        error: null,
        lockedUntil: null,
        attempts: 0,
      },
    });
    return sourceView(saved);
  }

  async patchSource(
    m: AccountMembership,
    siteId: string,
    sid: string,
    dto: PatchSourceDto,
  ): Promise<SourceView> {
    await this.requireSite(m, siteId);
    const src = await this.requireSource(m, siteId, sid);
    const managed = src.kind !== 'url' && src.kind !== 'file';
    if (managed && (dto.status !== undefined || dto.urls !== undefined)) {
      throw e1Error(
        409,
        'SOURCE_READONLY',
        'Этот источник управляется автоматически — его можно только переименовать',
      );
    }
    if (dto.urls !== undefined && src.kind !== 'url') {
      throw e1Error(
        409,
        'SOURCE_READONLY',
        'Адреса есть только у источника «страницы»',
      );
    }
    const data: Record<string, unknown> = {};
    if (dto.title !== undefined) data.title = dto.title.trim() || null;
    if (dto.urls !== undefined) {
      data.config = { urls: await this.validateUrls(m, siteId, dto.urls) };
      data.status = 'processing';
      data.lockedUntil = null;
      data.attempts = 0;
    }
    if (dto.status === 'disabled' && src.status !== 'disabled') {
      await this.adapter.api.removeDocuments(
        ctxOf(m, siteId),
        sid,
        'all',
        m.telegramId,
      );
      data.status = 'disabled';
      data.documentsCount = 0;
    } else if (dto.status === 'active' && src.status === 'disabled') {
      if (src.kind === 'file' && !src.blobPathname) {
        throw e1Error(409, 'DOCUMENT_NOT_UPLOADED', 'Файл не загружен');
      }
      // Включили снова — перечитать (страницы могли измениться).
      data.status = 'processing';
      data.lockedUntil = null;
      data.attempts = 0;
      data.error = null;
    }
    const saved = await this.rows(m).source.update({
      where: { id: sid },
      data,
    });
    return sourceView(saved);
  }

  async deleteSource(
    m: AccountMembership,
    siteId: string,
    sid: string,
  ): Promise<{ ok: true }> {
    await this.requireSite(m, siteId);
    const src = await this.requireSource(m, siteId, sid);
    if (src.kind !== 'url' && src.kind !== 'file') {
      throw e1Error(
        409,
        'SOURCE_READONLY',
        'Этот источник управляется автоматически',
      );
    }
    // Сначала — новая версия без документов (сразу, §4-тер.2), потом файл и строка.
    await this.adapter.api.removeDocuments(
      ctxOf(m, siteId),
      sid,
      'all',
      m.telegramId,
    );
    if (src.blobPathname) {
      await this.deps.blob.remove(src.blobPathname).catch((e: unknown) => {
        // Файл без строки никому не виден; хвост уберёт ручная чистка Blob.
        this.logger.warn(
          `Blob не удалён (${src.blobPathname}): ${(e as Error).name}`,
        );
      });
    }
    await this.rows(m).source.deleteMany({ where: { id: sid, siteId } });
    return { ok: true };
  }

  // ── Документы ─────────────────────────────────────────────────────────

  async listDocuments(
    m: AccountMembership,
    siteId: string,
    q: DocumentsQueryDto,
  ): Promise<Page<DocumentView>> {
    await this.requireSite(m, siteId);
    const rows = this.rows(m);
    const where: Record<string, unknown> = { siteId };
    if (q.sourceId) where.sourceId = q.sourceId;
    if (q.status) where.status = q.status;
    const docs = await rows.document.findMany({
      where,
      orderBy: { id: 'asc' },
      take: DOCUMENTS_PAGE + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = docs.slice(0, DOCUMENTS_PAGE);
    const v = await this.adapter.publishedVersion(ctxOf(m, siteId));
    const counts = new Map<string, number>();
    if (page.length > 0 && v > 0) {
      const grouped = await rows.chunk.groupBy({
        by: ['documentId'],
        where: {
          siteId,
          documentId: { in: page.map((d) => d.id) },
          versions: { has: v },
          quarantined: false,
        },
        _count: { _all: true },
      });
      for (const g of grouped) {
        counts.set(g.documentId as string, (g._count as { _all: number })._all);
      }
    }
    return {
      items: page.map((d) => documentView(d, counts.get(d.id) ?? 0)),
      nextCursor:
        docs.length > DOCUMENTS_PAGE ? page[page.length - 1].id : null,
    };
  }

  // ── FAQ ───────────────────────────────────────────────────────────────

  /** Источник `faq` — один на сайт и режим; создаётся при первом FAQ. */
  private async faqSource(m: FaqActor, siteId: string): Promise<SourceRow> {
    const rows = this.rows(m);
    const found = await rows.source.findFirst({
      where: { siteId, kind: 'faq' },
      orderBy: { createdAt: 'asc' },
    });
    if (found) return found;
    return rows.source.create({
      data: {
        accountId: m.accountId,
        siteId,
        kind: 'faq',
        title: 'FAQ',
        status: 'active',
        createdByTelegramId: m.telegramId,
      },
    });
  }

  async listFaq(m: AccountMembership, siteId: string): Promise<FaqView[]> {
    await this.requireSite(m, siteId);
    const rows = await this.rows(m).faq.findMany({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(faqView);
  }

  private async indexFaq(
    m: FaqActor,
    siteId: string,
    faq: {
      id: string;
      question: string;
      answer: string;
      variants: string[];
      lang: string | null;
    },
  ): Promise<void> {
    const src = await this.faqSource(m, siteId);
    const doc: DocumentInput = {
      ref: faqRef(faq.id),
      kind: 'faq',
      title: faq.question,
      lang: faq.lang,
      blocks: [],
      faq: {
        question: faq.question,
        answer: faq.answer,
        variants: faq.variants,
      },
    };
    await this.adapter.api.indexDocuments(ctxOf(m, siteId), src.id, [doc], {
      trigger: 'faq',
      byTelegramId: m.telegramId,
    });
    const rows = this.rows(m);
    const indexed = await rows.document.findFirst({
      where: { sourceId: src.id, ref: faqRef(faq.id) },
    });
    if (indexed) {
      await rows.faq.update({
        where: { id: faq.id },
        data: { documentId: indexed.id },
      });
    }
    await this.syncFaqCount(m, siteId, src.id);
  }

  private async syncFaqCount(m: FaqActor, siteId: string, sourceId: string) {
    const rows = this.rows(m);
    const n = await rows.faq.count({ where: { siteId, status: 'active' } });
    await rows.source.update({
      where: { id: sourceId },
      data: { documentsCount: n, lastSyncAt: new Date() },
    });
  }

  /**
   * Э3 (L, обучение): переиндексировать FAQ как он есть в строке — без
   * участника кабинета (хвост forget посетителя снял дословный вариант;
   * правка проверенного ответа в статусе needs_review — он остаётся в
   * поиске, §4-тер.4 путь (3)). Архивный — ничего (его нет в индексе).
   */
  async reindexFaq(
    ctx: KnowledgeCtx,
    fid: string,
    byTelegramId: bigint | null,
  ): Promise<boolean> {
    const actor: FaqActor = {
      accountId: ctx.accountId,
      telegramId: byTelegramId,
    };
    const row = await this.rows(actor).faq.findFirst({
      where: { id: fid, siteId: ctx.siteId },
    });
    if (!row || row.status === 'archived') return false;
    await this.indexFaq(actor, ctx.siteId, row);
    return true;
  }

  async createFaq(
    m: AccountMembership,
    siteId: string,
    dto: CreateFaqDto,
    now = new Date(),
  ): Promise<FaqView> {
    await this.requireSite(m, siteId);
    await this.adapter.ensureSettings(ctxOf(m, siteId));
    const variants = (dto.variants ?? []).map((v) => v.trim()).filter(Boolean);
    const row = await this.rows(m).faq.create({
      data: {
        accountId: m.accountId,
        siteId,
        question: dto.question.trim(),
        answer: dto.answer.trim(),
        variants,
        lang: dto.lang ?? null,
        origin: 'owner',
        status: 'active',
        // FAQ = проверенный ответ (§4-тер.4): публикует человек с правом.
        approvedByTelegramId: m.telegramId,
        approvedAt: now,
        createdByTelegramId: m.telegramId,
      },
    });
    try {
      await this.indexFaq(m, siteId, row);
    } catch (e) {
      // Без индексации FAQ «висел» бы в списке, но не работал бы — откат строки.
      await this.rows(m)
        .faq.deleteMany({ where: { id: row.id } })
        .catch(() => undefined);
      throw e;
    }
    const fresh = await this.rows(m).faq.findFirst({ where: { id: row.id } });
    return faqView(fresh ?? row);
  }

  private async requireFaq(m: AccountMembership, siteId: string, fid: string) {
    const f = await this.rows(m).faq.findFirst({ where: { id: fid, siteId } });
    if (!f) throw e1Error(404, 'FAQ_NOT_FOUND', 'Вопрос FAQ не найден');
    return f;
  }

  async patchFaq(
    m: AccountMembership,
    siteId: string,
    fid: string,
    dto: PatchFaqDto,
    now = new Date(),
  ): Promise<FaqView> {
    await this.requireSite(m, siteId);
    const before = await this.requireFaq(m, siteId, fid);
    const data: Record<string, unknown> = {};
    if (dto.question !== undefined) data.question = dto.question.trim();
    if (dto.answer !== undefined) data.answer = dto.answer.trim();
    if (dto.variants !== undefined) {
      data.variants = dto.variants.map((v) => v.trim()).filter(Boolean);
    }
    if (dto.lang !== undefined) data.lang = dto.lang;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.question !== undefined || dto.answer !== undefined) {
      data.approvedByTelegramId = m.telegramId;
      data.approvedAt = now;
    }
    const row = await this.rows(m).faq.update({ where: { id: fid }, data });
    const ctx = ctxOf(m, siteId);
    if (row.status === 'active') {
      await this.indexFaq(m, siteId, row);
    } else if (before.status === 'active') {
      const src = await this.faqSource(m, siteId);
      await this.adapter.api.removeDocuments(
        ctx,
        src.id,
        [faqRef(fid)],
        m.telegramId,
      );
      await this.syncFaqCount(m, siteId, src.id);
    }
    const fresh = await this.rows(m).faq.findFirst({ where: { id: fid } });
    return faqView(fresh ?? row);
  }

  async deleteFaq(
    m: AccountMembership,
    siteId: string,
    fid: string,
  ): Promise<{ ok: true }> {
    await this.requireSite(m, siteId);
    const row = await this.requireFaq(m, siteId, fid);
    const src = await this.faqSource(m, siteId);
    if (row.status === 'active' || row.documentId) {
      await this.adapter.api.removeDocuments(
        ctxOf(m, siteId),
        src.id,
        [faqRef(fid)],
        m.telegramId,
      );
    }
    await this.rows(m).faq.deleteMany({ where: { id: fid, siteId } });
    await this.syncFaqCount(m, siteId, src.id);
    return { ok: true };
  }

  // ── Версии ────────────────────────────────────────────────────────────

  /**
   * Номера в окне отката (§4-тер.2): опубликованные за 7 дней, не больше 5
   * последних публикаций, кроме текущей. Окончательное слово — у K2
   * (`rollback` бросит, если окно уже сдвинулось), здесь — для кнопки.
   */
  private rollbackable(
    rows: VersionRow[],
    current: number,
    now: Date,
  ): Set<number> {
    const since =
      now.getTime() - KNOWLEDGE_DEFAULTS.rollbackWindowDays * 86_400_000;
    const published = rows
      .filter((r) => r.publishedAt && r.status !== 'discarded')
      .sort(
        (a, b) =>
          (b.publishedAt as Date).getTime() - (a.publishedAt as Date).getTime(),
      )
      .slice(0, KNOWLEDGE_DEFAULTS.rollbackMaxPublished)
      .filter(
        (r) =>
          (r.publishedAt as Date).getTime() >= since && r.number !== current,
      );
    return new Set(published.map((r) => r.number));
  }

  private async versionRows(
    m: AccountMembership,
    siteId: string,
  ): Promise<VersionRow[]> {
    return this.rows(m).version.findMany({
      where: { siteId },
      orderBy: { number: 'desc' },
      take: 50,
    });
  }

  async listVersions(
    m: AccountMembership,
    siteId: string,
    now = new Date(),
  ): Promise<VersionView[]> {
    await this.requireSite(m, siteId);
    const rows = await this.versionRows(m, siteId);
    const current = await this.adapter.publishedVersion(ctxOf(m, siteId));
    const rb = this.rollbackable(rows, current, now);
    return rows.map((r) => versionView(r, current, rb));
  }

  private async viewOf(
    m: AccountMembership,
    siteId: string,
    number: number,
    now = new Date(),
  ): Promise<VersionView> {
    const rows = await this.versionRows(m, siteId);
    const row = rows.find((r) => r.number === number);
    if (!row) throw e1Error(404, 'VERSION_NOT_FOUND', 'Версия не найдена');
    const current = await this.adapter.publishedVersion(ctxOf(m, siteId));
    return versionView(row, current, this.rollbackable(rows, current, now));
  }

  /** Результат K2 → форма API (строку версии пишет K2). */
  private async resultView(
    m: AccountMembership,
    siteId: string,
    r: VersionResult,
  ): Promise<VersionView> {
    return this.viewOf(m, siteId, r.number);
  }

  private async requireVersion(
    m: AccountMembership,
    siteId: string,
    n: number,
  ) {
    const row = await this.rows(m).version.findFirst({
      where: { siteId, number: n },
    });
    if (!row) throw e1Error(404, 'VERSION_NOT_FOUND', 'Версия не найдена');
    return row;
  }

  async publishVersion(
    m: AccountMembership,
    siteId: string,
    n: number,
  ): Promise<VersionView> {
    await this.requireSite(m, siteId);
    const row = await this.requireVersion(m, siteId, n);
    if (row.status !== 'held') {
      throw e1Error(
        409,
        'VERSION_NOT_HELD',
        'Опубликовать как есть можно только удержанную версию',
      );
    }
    const r = await this.adapter.api.publishHeld(
      ctxOf(m, siteId),
      n,
      m.telegramId,
    );
    return this.resultView(m, siteId, r);
  }

  async discardVersion(
    m: AccountMembership,
    siteId: string,
    n: number,
  ): Promise<VersionView> {
    await this.requireSite(m, siteId);
    const row = await this.requireVersion(m, siteId, n);
    if (row.status !== 'held') {
      throw e1Error(
        409,
        'VERSION_NOT_HELD',
        'Отбросить можно только удержанную версию',
      );
    }
    const r = await this.adapter.api.discard(ctxOf(m, siteId), n, m.telegramId);
    return this.resultView(m, siteId, r);
  }

  async rollbackVersion(
    m: AccountMembership,
    siteId: string,
    n: number,
    now = new Date(),
  ): Promise<VersionView> {
    await this.requireSite(m, siteId);
    await this.requireVersion(m, siteId, n);
    const rows = await this.versionRows(m, siteId);
    const current = await this.adapter.publishedVersion(ctxOf(m, siteId));
    if (!this.rollbackable(rows, current, now).has(n)) {
      throw e1Error(
        409,
        'VERSION_NOT_ROLLBACKABLE',
        'Откат возможен к одной из 5 последних публикаций за 7 дней',
      );
    }
    const r = await this.adapter.api.rollback(
      ctxOf(m, siteId),
      n,
      m.telegramId,
    );
    return this.resultView(m, siteId, r);
  }

  // ── Исключения ────────────────────────────────────────────────────────

  async listExclusions(
    m: AccountMembership,
    siteId: string,
  ): Promise<ExclusionView[]> {
    await this.requireSite(m, siteId);
    const rows = await this.rows(m).exclusion.findMany({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(exclusionView);
  }

  private async normalizeExclusion(
    m: AccountMembership,
    siteId: string,
    dto: CreateExclusionDto,
  ): Promise<string> {
    const value = dto.value.trim();
    switch (dto.kind) {
      case 'url':
      case 'urlPrefix': {
        const u = normalizeHttpsUrl(value);
        // Ключ — как у обхода (normalizeCrawlUrl: без utm-меток, параметры
        // по порядку, без `//`): фрагменты и site_pages хранят URL в этой
        // форме, а владелец вставляет адрес из браузера. Иначе исключение
        // «не находит» страницу и ничего не удаляет (§4-тер.12 «сразу»).
        const n = u ? normalizeCrawlUrl(u.toString()) : null;
        if (!n) {
          throw e1Error(
            400,
            'EXCLUSION_INVALID',
            'Укажите https-адрес страницы или раздела',
          );
        }
        if (dto.kind === 'url') return n;
        // Префикс — с путём, без query: «весь раздел /blog/».
        const p = new URL(n);
        p.search = '';
        return p.toString();
      }
      case 'chunkHash':
        if (!/^[a-f0-9]{64}$/.test(value)) {
          throw e1Error(
            400,
            'EXCLUSION_INVALID',
            'Хеш фрагмента — 64 шестнадцатеричных символа',
          );
        }
        return value;
      case 'document': {
        const d = await this.rows(m).document.findFirst({
          where: { id: value, siteId },
        });
        if (!d) throw e1Error(400, 'EXCLUSION_INVALID', 'Документ не найден');
        return value;
      }
    }
  }

  async createExclusion(
    m: AccountMembership,
    siteId: string,
    dto: CreateExclusionDto,
    now = new Date(),
  ): Promise<ExclusionView> {
    await this.requireSite(m, siteId);
    await this.adapter.ensureSettings(ctxOf(m, siteId));
    const value = await this.normalizeExclusion(m, siteId, dto);
    const rows = this.rows(m);
    const dup = await rows.exclusion.findFirst({
      where: { siteId, kind: dto.kind, value },
    });
    if (dup)
      throw e1Error(409, 'EXCLUSION_DUPLICATE', 'Такое исключение уже есть');
    let row;
    try {
      row = await rows.exclusion.create({
        data: {
          accountId: m.accountId,
          siteId,
          kind: dto.kind,
          value,
          reason: dto.reason?.trim() || null,
          createdByTelegramId: m.telegramId,
        },
      });
    } catch (e) {
      if ((e as { code?: string } | null)?.code === 'P2002') {
        throw e1Error(409, 'EXCLUSION_DUPLICATE', 'Такое исключение уже есть');
      }
      throw e;
    }
    try {
      const r = await this.adapter.api.applyExclusion(
        ctxOf(m, siteId),
        { kind: dto.kind, value, reason: row.reason },
        m.telegramId,
      );
      const saved = await rows.exclusion.update({
        where: { id: row.id },
        data: { chunksDeleted: r.chunksDeleted, appliedAt: now },
      });
      return exclusionView(saved);
    } catch (e) {
      // Не применилось — не оставляем строку «как будто исключено».
      await rows.exclusion
        .deleteMany({ where: { id: row.id } })
        .catch(() => undefined);
      throw e;
    }
  }

  async deleteExclusion(
    m: AccountMembership,
    siteId: string,
    eid: string,
  ): Promise<{ ok: true }> {
    await this.requireSite(m, siteId);
    const rows = this.rows(m);
    const row = await rows.exclusion.findFirst({ where: { id: eid, siteId } });
    if (!row)
      throw e1Error(404, 'EXCLUSION_NOT_FOUND', 'Исключение не найдено');
    await this.adapter.api.liftExclusion(ctxOf(m, siteId), eid);
    // K2 мог уже удалить строку сам — deleteMany не падает на «нет строки».
    await rows.exclusion.deleteMany({ where: { id: eid, siteId } });
    return { ok: true };
  }

  // ── Карантин ──────────────────────────────────────────────────────────

  /**
   * Версии, чей карантин ждёт решения владельца: опубликованная и
   * удержанные. Фрагмент старой версии (окно отката) — не «ждёт»: после
   * «включить» он остаётся там ради отката, но решение уже принято.
   */
  private async pendingVersions(
    m: AccountMembership,
    siteId: string,
  ): Promise<number[]> {
    const [v, held] = await Promise.all([
      this.adapter.publishedVersion(ctxOf(m, siteId)),
      this.rows(m).version.findMany({
        where: { siteId, status: 'held' },
        select: { number: true },
      }),
    ]);
    return [...(v > 0 ? [v] : []), ...held.map((r) => r.number)];
  }

  async listQuarantine(
    m: AccountMembership,
    siteId: string,
  ): Promise<QuarantineView[]> {
    await this.requireSite(m, siteId);
    const rows = await this.rows(m).chunk.findMany({
      where: {
        siteId,
        quarantined: true,
        quarantineAllowedAt: null,
        versions: { hasSome: await this.pendingVersions(m, siteId) },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(quarantineView);
  }

  async allowQuarantined(
    m: AccountMembership,
    siteId: string,
    chunkId: string,
  ): Promise<VersionView> {
    await this.requireSite(m, siteId);
    const c = await this.rows(m).chunk.findFirst({
      where: {
        id: chunkId,
        siteId,
        quarantined: true,
        versions: { hasSome: await this.pendingVersions(m, siteId) },
      },
    });
    if (!c)
      throw e1Error(404, 'CHUNK_NOT_FOUND', 'Фрагмент в карантине не найден');
    const r = await this.adapter.api.allowQuarantined(
      ctxOf(m, siteId),
      chunkId,
      m.telegramId,
    );
    return this.resultView(m, siteId, r);
  }

  // ── Сводка ────────────────────────────────────────────────────────────

  async summary(
    m: AccountMembership,
    siteId: string,
    extra: {
      suggestedQuestions: string[];
      settings?: KnowledgeSummary['settings'];
    },
    now = new Date(),
  ): Promise<KnowledgeSummary> {
    await this.requireSite(m, siteId);
    const ctx = ctxOf(m, siteId);
    const rows = this.rows(m);
    const v = await this.adapter.publishedVersion(ctx);
    const inVersion = { siteId, versions: { has: v }, quarantined: false };

    const pagesByStatus = await this.deps.db
      .forAccount(m.accountId)
      .sitePage.groupBy({
        by: ['status', 'skipReason'],
        where: { siteId },
        _count: { _all: true },
      });
    let read = 0;
    let skipped = 0;
    const skippedByReason: Partial<Record<SkipReason, number>> = {};
    for (const g of pagesByStatus) {
      const n = g._count._all;
      if (g.status === 'ok' || g.status === 'not_modified') read += n;
      else if (g.status === 'skipped' || g.status === 'failed') {
        skipped += n;
        const reason = (g.skipReason ?? 'empty') as SkipReason;
        skippedByReason[reason] = (skippedByReason[reason] ?? 0) + n;
      }
    }

    const [
      documents,
      chunks,
      langGroups,
      held,
      quarantineCount,
      lastCrawl,
      budget,
    ] = await Promise.all([
      rows.document.count({ where: { siteId, status: 'active' } }),
      v > 0 ? rows.chunk.count({ where: inVersion }) : Promise.resolve(0),
      v > 0
        ? rows.chunk.groupBy({
            by: ['lang'],
            where: inVersion,
            _count: { _all: true },
          })
        : Promise.resolve([] as Array<Record<string, unknown>>),
      rows.version.findFirst({
        where: { siteId, status: 'held' },
        orderBy: { number: 'desc' },
      }),
      this.pendingVersions(m, siteId).then((live) =>
        rows.chunk.count({
          where: {
            siteId,
            quarantined: true,
            quarantineAllowedAt: null,
            versions: { hasSome: live },
          },
        }),
      ),
      this.deps.crawl.latestRun(m.accountId, siteId, 'assist'),
      this.deps.budget.status(m.accountId, siteId),
    ]);

    const langs: Record<string, number> = {};
    const total = langGroups.reduce(
      (s, g) => s + (g._count as { _all: number })._all,
      0,
    );
    for (const g of langGroups) {
      const key = (g.lang as string | null) ?? 'unknown';
      langs[key] = total
        ? Math.round(((g._count as { _all: number })._all / total) * 100) / 100
        : 0;
    }

    let heldVersion: VersionView | null = null;
    if (held) {
      const all = await this.versionRows(m, siteId);
      heldVersion = versionView(held, v, this.rollbackable(all, v, now));
    }

    return {
      mode: this.adapter.mode,
      publishedVersion: v,
      pages: { read, skipped, skippedByReason },
      documents,
      chunks,
      langs,
      lastCrawl,
      heldVersion,
      quarantineCount,
      suggestedQuestions: extra.suggestedQuestions,
      learningBudget: {
        period: budget.period,
        capMicroUsd: budget.capMicroUsd,
        spentMicroUsd: budget.spentMicroUsd,
      },
      ...(extra.settings ? { settings: extra.settings } : {}),
    };
  }

  // ── Разбор загруженных файлов и url-источников (крон K2 зовёт первым) ──

  async processPending(
    budgetMs: number,
    now = () => new Date(),
  ): Promise<{ processed: number }> {
    const deadline = now().getTime() + budgetMs;
    const sys = this.adapter.systemSources();
    let processed = 0;
    const tried = new Set<string>();
    while (now().getTime() < deadline) {
      const t = now();
      const due = { OR: [{ lockedUntil: null }, { lockedUntil: { lt: t } }] };
      const batch = await sys.findMany({
        where: { status: 'processing', kind: { in: ['file', 'url'] }, ...due },
        orderBy: { updatedAt: 'asc' },
        take: 5,
      });
      const fresh = batch.filter((r) => !tried.has(r.id));
      if (fresh.length === 0) break;
      for (const row of fresh) {
        if (now().getTime() >= deadline) break;
        tried.add(row.id);
        if (row.attempts >= PROCESS_MAX_ATTEMPTS) {
          // Попытки кончились, а итога нет: прошлые заходы не дожили до
          // catch (функцию убили — память на «zip-бомбе», maxDuration).
          // Без этого такой файл ронял бы крон каждые 5 минут, а разбор
          // файлов идёт ПЕРЕД индексацией всех кабинетов.
          await sys.updateMany({
            where: { id: row.id, status: 'processing', ...due },
            data: {
              status: 'failed',
              error:
                'Не удалось обработать источник — файл слишком сложный или повреждён',
              lockedUntil: null,
            },
          });
          continue;
        }
        const claimed = await sys.updateMany({
          where: { id: row.id, status: 'processing', ...due },
          data: {
            lockedUntil: new Date(t.getTime() + PROCESS_LEASE_MS),
            attempts: { increment: 1 },
          },
        });
        if (claimed.count === 0) continue;
        await this.processOne(row, row.attempts + 1, now());
        processed++;
      }
    }
    return { processed };
  }

  private async processOne(
    row: SourceRow,
    attempt: number,
    now: Date,
  ): Promise<void> {
    const rows = this.adapter.rows(row.accountId);
    const ctx: KnowledgeCtx = { accountId: row.accountId, siteId: row.siteId };
    try {
      const outcome =
        row.kind === 'file'
          ? await this.processFile(ctx, row)
          : await this.processUrls(ctx, row);
      await rows.source.update({
        where: { id: row.id },
        data: {
          status: 'active',
          error: outcome.warning,
          lastSyncAt: now,
          lockedUntil: null,
          attempts: 0,
          documentsCount: outcome.documents,
          ...(outcome.data ?? {}),
        },
      });
    } catch (e) {
      const permanent = permanentFailure(e);
      const giveUp = permanent !== null || attempt >= PROCESS_MAX_ATTEMPTS;
      if (!permanent) {
        this.logger.warn(
          `Источник ${row.id}: сбой обработки (${(e as Error | null)?.name ?? 'Error'})`,
        );
      }
      await rows.source.update({
        where: { id: row.id },
        data: giveUp
          ? {
              status: 'failed',
              error:
                permanent ??
                'Не удалось обработать источник — попробуйте позже',
              lockedUntil: null,
            }
          : // Повтор — следующим тиком после паузы (lease и есть пауза).
            { error: null },
      });
    }
  }

  private async processFile(
    ctx: KnowledgeCtx,
    row: SourceRow,
  ): Promise<{
    documents: number;
    warning: string | null;
    data?: Record<string, unknown>;
  }> {
    if (!row.blobPathname || !row.fileName || !row.mimeType) {
      throw new DocumentParseError('DOCUMENT_TYPE', 'Файл не загружен');
    }
    const format = formatFor(row.fileName, row.mimeType);
    if (!format)
      throw new DocumentParseError(
        'DOCUMENT_TYPE',
        'Поддерживаются PDF, DOCX, TXT, MD и CSV',
      );
    const body = await this.deps.blob.read(
      row.blobPathname,
      KNOWLEDGE_DEFAULTS.maxDocumentBytes,
    );
    const parsed = await parseDocument(body, format, row.fileName);
    const doc: DocumentInput = {
      ref: row.blobPathname,
      kind: 'file',
      url: null,
      title: parsed.title ?? row.fileName,
      lang: parsed.lang,
      blocks: parsed.blocks,
    };
    await this.adapter.api.indexDocuments(ctx, row.id, [doc], {
      trigger: 'document',
      byTelegramId: row.createdByTelegramId,
      replaceAll: true,
    });
    return {
      documents: 1,
      warning: parsed.truncated
        ? 'Файл очень большой — в знания вошла только первая часть текста'
        : null,
      data: { sha256: createHash('sha256').update(body).digest('hex') },
    };
  }

  private async processUrls(
    ctx: KnowledgeCtx,
    row: SourceRow,
  ): Promise<{
    documents: number;
    warning: string | null;
    data?: Record<string, unknown>;
  }> {
    const config =
      row.config && typeof row.config === 'object' && !Array.isArray(row.config)
        ? (row.config as Record<string, unknown>)
        : {};
    const urls = Array.isArray(config.urls)
      ? config.urls.filter((u): u is string => typeof u === 'string')
      : [];
    const hosts = await this.deps.db
      .forAccount(ctx.accountId)
      .siteHost.findMany({ where: { siteId: ctx.siteId } });
    const docs: DocumentInput[] = [];
    const skipped: Array<{ url: string; reason: string }> = [];
    for (const url of urls) {
      const u = normalizeHttpsUrl(url);
      const host = u ? hosts.find((h) => h.host === u.hostname) : undefined;
      if (!u || !host) {
        skipped.push({ url, reason: 'unverified_host' });
        continue;
      }
      try {
        await this.deps.hosts.assertHostVerified(
          host.id,
          this.adapter.urlPurpose,
          {
            accountId: ctx.accountId,
          },
        );
      } catch {
        skipped.push({ url, reason: 'unverified_host' });
        continue;
      }
      const r = await this.deps.fetcher.fetchPage(u.toString(), {
        purpose: this.adapter.urlPurpose,
        db: this.crawlDb(),
      });
      if (!r.ok) {
        skipped.push({ url, reason: r.reason ?? 'http_4xx' });
        continue;
      }
      docs.push({
        ref: r.page.url,
        kind: 'page',
        url: r.page.url,
        title: r.page.title,
        lang: r.page.lang,
        blocks: r.page.blocks,
      });
    }
    if (docs.length === 0) {
      throw e1Error(
        400,
        'DOCUMENT_NO_TEXT',
        'Ни одна страница не прочитана — проверьте, что хост подтверждён и страницы открываются',
      );
    }
    await this.adapter.api.indexDocuments(ctx, row.id, docs, {
      trigger: 'document',
      byTelegramId: row.createdByTelegramId,
      replaceAll: true,
    });
    return {
      documents: docs.length,
      warning:
        skipped.length > 0 ? `Пропущено страниц: ${skipped.length}` : null,
      data: { config: { urls, skipped } },
    };
  }
}
