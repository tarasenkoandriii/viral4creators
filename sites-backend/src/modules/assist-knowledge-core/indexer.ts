/**
 * Индексация и версии базы знаний режима — K2 (§4.3, §4-тер.2, §4-тер.7,
 * §4-тер.11, §4-тер.12). Нейтральный: таблицы — из KnowledgeTables
 * (передаёт модуль режима), специфика режима — хуками (`ModeHooks`).
 * Реализует всё, что обещает ModeKnowledgeApi; SiteKnowledgeService и
 * AdminKnowledgeService — тонкие обёртки со своими таблицами.
 *
 * Сборка версии B от опубликованной P (`build`):
 *  1. замок сборки и номер — VersionRepo.acquire;
 *  2. документы → резка (chunker) → план по каждому фрагменту:
 *     - тот же документ, тот же текст и метаданные в P → строка ПЕРЕХОДИТ
 *       в B (`array_append(versions, B)`), без копии и без эмбеддинга;
 *     - иначе новая строка; вектор КОПИРУЕТСЯ, если на сайте есть фрагмент
 *       с тем же contentHash, или у этого документа в P — с тем же
 *       digitsMaskedHash («изменились только числа»); иначе — эмбеддинг;
 *     - новый не-UGC фрагмент с признаками инъекции — карантин (без
 *       эмбеддинга: в поиск он не идёт);
 *  3. бюджет обучения: не помещается — обход эмбеддит только «горячие
 *     страницы» (остальные изменения ждут следующего периода), действие
 *     человека получает LEARNING_BUDGET_EXHAUSTED;
 *  4. эмбеддинги — ДО записи строк (сбой провайдера не оставляет
 *     полуготовой версии), учёт в site_ai_usage (`assist-embed`);
 *  5. неизменённые документы P переходят в B одним UPDATE;
 *  6. исключения применяются ещё раз (могли появиться за время сборки);
 *  7. ворота (только версия из переобхода) → published | held.
 */
import { HttpStatus, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { KNOWLEDGE_DEFAULTS } from '../../config/assist-defaults';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SitesDb } from '../../prisma/sites-db.service';
import { estimateCost } from '../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../shared/gemini-model';
import type { GeminiEmbedder } from '../site-ai/embedder';
import { estimateEmbedTokens, toVectorLiteral } from '../site-ai/embedder';
import type { LearningBudget } from '../site-ai/learning-budget';
import type { AiUsageRecorder } from '../site-ai/usage-recorder';
import type { ExtractedBlock } from '../site-crawl/types';
import type { AnswerEngine } from './answer/answer-engine';
import { chunkBlocks, chunkFaq } from './chunker';
import { INVARIANT_CASES } from './eval/invariant-cases';
import { runInvariantEval } from './eval/invariant-eval';
import {
  evaluateGates,
  GONE_OR_ERROR_MIN_PAGES,
  heldReasonText,
  type InvariantEvalGate,
} from './gates';
import { detectInjection } from './injection';
import { KnowledgeStore } from './store';
import { qualified, type KnowledgeTables } from './tables';
import type {
  ChunkDraft,
  DocumentInput,
  ExclusionInput,
  GateReport,
  KnowledgeCtx,
  SearchHit,
  SearchQuery,
  VersionResult,
  VersionTrigger,
} from './types';
import { knowledgeError, newRowId, VersionRepo, type RawDb } from './versions';

/** Специфика режима: строка настроек, уведомления, eval-кейсы сайта. */
export interface ModeHooks {
  /** Создать строку настроек режима, если её нет (своим Prisma-делегатом). */
  ensureSettings(ctx: KnowledgeCtx): Promise<void>;
  onHeld?(
    ctx: KnowledgeCtx,
    p: { number: number; reason: string },
  ): Promise<void>;
  onQuarantine?(
    ctx: KnowledgeCtx,
    p: { count: number; suspectedHack: boolean },
  ): Promise<void>;
  afterPublish?(ctx: KnowledgeCtx, number: number): Promise<void>;
  /** Инвариантный eval в воротах (§4-тер.2) — только «Сайт» (У-6). */
  invariantEval?: boolean;
}

export interface IndexerDeps {
  prisma: PrismaService;
  sitesDb: SitesDb;
  embedder: Pick<GeminiEmbedder, 'embed'>;
  usage: Pick<AiUsageRecorder, 'record'>;
  budget: Pick<LearningBudget, 'reserve' | 'adjust'>;
  answer?: Pick<AnswerEngine, 'answer'> | null;
}

/** Сколько ждём замок сборки на действие человека. */
export const HUMAN_WAIT_MS = 25_000;
/** Оценка одного кейса инвариантного eval (вход ≈ 2k, выход ≈ 300 токенов). */
const EVAL_CASE_TOKENS = { inputTokens: 2_000, outputTokens: 300 };

/** Страница site_pages, как её видит индексация. */
export interface CrawlPageInput {
  id: string;
  url: string;
  finalUrl: string | null;
  status: string;
  skipReason: string | null;
  title: string | null;
  lang: string | null;
  blocks: unknown;
  contentHash: string | null;
}

/** Причины, по которым страница «сломалась» (ворота gone_or_error_share). */
const BROKEN_REASONS = new Set(['http_4xx', 'http_5xx', 'timeout', 'empty']);
/** Временные сбои: старые фрагменты остаются (иначе сбой сайта стёр бы знания). */
const KEEP_ON_FAILURE = new Set(['http_5xx', 'timeout', 'limit']);

interface DocPlan {
  sourceId: string;
  input: DocumentInput;
  docHash: string;
  hot: boolean;
}

interface Removal {
  documentId: string;
  status: 'gone' | 'excluded' | 'skipped' | 'failed';
  skipReason?: string | null;
}

interface BuildPlan {
  trigger: VersionTrigger;
  byTelegramId: bigint | null;
  crawlRunId?: string | null;
  upserts: DocPlan[];
  removals: Removal[];
  gated: boolean;
  budgetPolicy: 'strict' | 'crawl';
  /** Ворота gone_or_error_share — считает вызывающий (он видит статусы). */
  gone?: { previouslyPublishedPages: number; brokenPages: number };
}

export interface BuildOutcome {
  version: VersionResult | null;
  /** Сборку не начали: идёт другая. */
  busy: boolean;
  /** Э2: время тика кончилось — версия `building`, следующий тик продолжит. */
  paused: boolean;
  /** Прогон обхода, от которого собрана (собирается) версия. */
  crawlRunId?: string | null;
  /** Документов плана сборки пройдено / всего (по всем тикам). */
  progress?: { done: number; total: number };
  /** За ЭТОТ вызов (тик), не за всю сборку. */
  embedded: number;
  reused: number;
  /** Отложено бюджетом за всю сборку. */
  deferred: number;
  budgetExhausted: boolean;
}

/**
 * Дедлайн тика для сборки обхода (Э2, ограничение Э1). Время — числом мс
 * (`now` подменяется в тестах).
 */
export interface BuildDeadline {
  deadlineAt?: number;
  now?: () => number;
  /** Документов в пачке (по умолчанию BUILD_BATCH_DOCS). */
  batchDocs?: number;
}

/**
 * Документов в одной пачке сборки обхода: резка → резерв → эмбеддинг
 * (≈ 3 фрагмента на страницу — один-два вызова провайдера по
 * embedBatchSize) → запись одной транзакцией.
 */
export const BUILD_BATCH_DOCS = 25;
/** Запас тика на ворота (с инвариантным eval) и публикацию. */
export const FINISH_RESERVE_MS = 15_000;
/** Транзакция записи пачки (интерактивная; умолчание Prisma 5 с мало). */
const BATCH_TX_TIMEOUT_MS = 60_000;

interface BuildCounts {
  added: number;
  changed: number;
  embedded: number;
  reused: number;
  deferred: number;
  quarantined: number;
  /** Документы плана, не тронутые пачкой (исключены/пропали) — перенос P. */
  skipped: number;
}

/**
 * Прогресс сборки — `stats.build` версии (VersionRepo.saveProgress; там же
 * heartbeatAt). При публикации/удержании stats заменяется итогом.
 */
interface BuildState {
  v: 1;
  /** Сборка обхода: очередь сохранена, продолжает следующий тик. */
  resumable: boolean;
  /** Кто ведёт сейчас (null — приостановлена). */
  claim: string | null;
  phase: 'docs' | 'finish';
  trigger: VersionTrigger;
  crawlRunId: string | null;
  gated: boolean;
  budgetPolicy: 'strict' | 'crawl';
  forceVersion: boolean;
  sourceId: string | null;
  includeUgc: boolean;
  /** ref документов плана (обход: URL страницы) — по порядку пачек. */
  queue: string[];
  /** Индексы очереди — «горячие страницы». */
  hot: number[];
  total: number;
  cursor: number;
  removals: Removal[];
  gone: { previouslyPublishedPages: number; brokenPages: number } | null;
  budgetExhausted: boolean;
  /** Резерв обучения, взятый пачкой и ещё не закрытый записью. */
  outstandingMicroUsd: number;
  counts: BuildCounts;
  /** docHash изменённых документов → сколько (ворота identical_changed). */
  changedHashes: Record<string, number>;
  ticks: number;
}

interface DocWork {
  u: DocPlan;
  key: string;
  docId: string | null;
  keep: string[];
  fresh: NewChunk[];
  needTokens: number;
  changed: boolean;
}

function emptyOutcome(): BuildOutcome {
  return {
    version: null,
    busy: false,
    paused: false,
    embedded: 0,
    reused: 0,
    deferred: 0,
    budgetExhausted: false,
  };
}

function emptyCounts(): BuildCounts {
  return {
    added: 0,
    changed: 0,
    embedded: 0,
    reused: 0,
    deferred: 0,
    quarantined: 0,
    skipped: 0,
  };
}

function docKey(sourceId: string, ref: string): string {
  return `${sourceId}\u001f${ref}`;
}

interface ExclusionRow {
  kind: string;
  value: string;
}

interface OldChunk {
  id: string;
  documentId: string;
  contentHash: string;
  digitsMaskedHash: string;
  headingPath: string | null;
  title: string | null;
  url: string | null;
  ugc: boolean;
  hasEmbedding: boolean;
  embedModel: string | null;
}

/** Новый фрагмент: откуда вектор. */
interface NewChunk {
  documentKey: string;
  draft: ChunkDraft;
  sourceType: string;
  url: string | null;
  title: string | null;
  quarantined: boolean;
  quarantineReason: string | null;
  copyFrom: string | null;
  digitsOnly: boolean;
  vector: number[] | null;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Хеш документа-не-страницы (FAQ, файл): меняется — пересобираем. */
export function documentHash(d: DocumentInput): string {
  return sha256(
    JSON.stringify({
      t: d.title ?? null,
      l: d.lang ?? null,
      u: d.url ?? null,
      b: d.blocks,
      f: d.faq ?? null,
    }),
  );
}

/**
 * Граница префикса — как у обхода (K1, `matchesExcluded`): префикс
 * `…/sale` — это сама `…/sale`, `…/sale/…` и `…/sale?…`, но НЕ `…/sales-terms`;
 * префикс с `/` на конце — всё, что начинается с него. Иначе исключение
 * раздела молча стёрло бы соседние страницы, которые обход продолжает читать.
 */
export function urlUnderPrefix(url: string, prefix: string): boolean {
  if (url === prefix) return true;
  return prefix.endsWith('/')
    ? url.startsWith(prefix)
    : url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`);
}

/** LIKE-шаблоны той же границы ($4, $5 запроса; равенство — $3). */
function prefixPatterns(prefix: string): [string, string] {
  const esc = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  return prefix.endsWith('/')
    ? [`${esc}%`, `${esc}%`]
    : [`${esc}/%`, `${esc}?%`];
}

/** Документ под префиксом ($3 — префикс, $4/$5 — prefixPatterns). */
const PREFIX_SQL = `"url" = $3 OR "url" LIKE $4 OR "url" LIKE $5 OR "ref" = $3 OR "ref" LIKE $4 OR "ref" LIKE $5`;

export function isExcludedUrl(
  url: string | null | undefined,
  exclusions: ExclusionRow[],
): boolean {
  if (!url) return false;
  return exclusions.some(
    (e) =>
      (e.kind === 'url' && e.value === url) ||
      (e.kind === 'urlPrefix' && urlUnderPrefix(url, e.value)),
  );
}

function asBlocks(v: unknown): ExtractedBlock[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (b): b is ExtractedBlock =>
      !!b &&
      typeof b === 'object' &&
      typeof (b as ExtractedBlock).text === 'string' &&
      typeof (b as ExtractedBlock).t === 'string',
  );
}

/** Документ плана из страницы обхода; null — страница не читается. */
function pagePlan(
  page: CrawlPageInput,
  sourceId: string,
  includeUgc: boolean,
  hot: boolean,
): DocPlan | null {
  const blocks = asBlocks(page.blocks).filter((b) => includeUgc || !b.ugc);
  const usable =
    (page.status === 'ok' || page.status === 'not_modified') &&
    !!page.contentHash &&
    blocks.length > 0;
  if (!usable) return null;
  return {
    sourceId,
    docHash: `${page.contentHash}${includeUgc ? '' : ':no-ugc'}`,
    hot,
    input: {
      ref: page.url,
      kind: 'page',
      url: page.finalUrl ?? page.url,
      title: page.title,
      lang: page.lang,
      blocks,
      sitePageId: page.id,
    },
  };
}

function langShares(rows: Array<{ lang: string | null; n: number }>): {
  counts: Record<string, number>;
  shares: Record<string, number>;
  total: number;
} {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const l = r.lang ?? 'unknown';
    counts[l] = (counts[l] ?? 0) + Number(r.n);
    total += Number(r.n);
  }
  const shares: Record<string, number> = {};
  for (const [l, n] of Object.entries(counts)) {
    shares[l] = total ? Math.round((n / total) * 100) / 100 : 0;
  }
  return { counts, shares, total };
}

export class KnowledgeIndexer {
  private readonly logger: Logger;
  readonly versions: VersionRepo;
  readonly store: KnowledgeStore;
  private readonly C: string;
  private readonly D: string;
  private readonly X: string;

  constructor(
    readonly tables: KnowledgeTables,
    private readonly deps: IndexerDeps,
    private readonly hooks: ModeHooks,
  ) {
    this.logger = new Logger(`KnowledgeIndexer:${tables.mode}`);
    this.versions = new VersionRepo(tables, deps.prisma, {
      // Снятая сборка (истёк срок / сбой) — её незакрытый резерв назад.
      onReaped: (ctx, b) =>
        deps.budget.adjust(ctx.accountId, ctx.siteId, -b.outstandingMicroUsd),
    });
    this.store = new KnowledgeStore(tables, deps.prisma);
    this.C = qualified(tables.chunks);
    this.D = qualified(tables.documents);
    this.X = qualified(tables.exclusions);
  }

  private get db(): PrismaService {
    return this.deps.prisma;
  }

  // ── поиск ──────────────────────────────────────────────────────────────

  /** Вектор вопроса; сбой провайдера — пустой (поиск останется текстовым). */
  async queryVector(
    query: string,
    usage?: {
      ctx: KnowledgeCtx;
      operation: 'assist-eval' | 'assist-query-embed';
    },
  ): Promise<number[]> {
    if (!query.trim()) return [];
    try {
      const r = await this.deps.embedder.embed([query], 'query');
      if (usage) {
        await this.deps.usage.record(
          this.deps.sitesDb.forAccount(usage.ctx.accountId),
          {
            accountId: usage.ctx.accountId,
            siteId: usage.ctx.siteId,
            operation: usage.operation,
            model: r.model,
            units: { inputTokens: r.inputTokens },
          },
        );
      }
      return r.vectors[0] ?? [];
    } catch (e) {
      this.logger.warn(
        `Эмбеддинг вопроса не получен — поиск только по тексту: ${(e as Error).name}`,
      );
      return [];
    }
  }

  async search(q: SearchQuery): Promise<SearchHit[]> {
    if (!q.siteId) throw new Error('search: siteId обязателен');
    if (!q.query?.trim()) return [];
    const ctx = await this.searchUsageCtx(q.siteId);
    return this.store.search(
      q,
      await this.queryVector(
        q.query,
        ctx ? { ctx, operation: 'assist-query-embed' } : undefined,
      ),
    );
  }

  /** Кабинет сайта — для строки site_ai_usage эмбеддинга вопроса. */
  private async searchUsageCtx(siteId: string): Promise<KnowledgeCtx | null> {
    const rows = await this.db.$queryRawUnsafe<Array<{ accountId: string }>>(
      `SELECT "accountId" FROM ${qualified('site_sites')} WHERE "id" = $1`,
      siteId,
    );
    return rows[0] ? { accountId: rows[0].accountId, siteId } : null;
  }

  // ── исключения ─────────────────────────────────────────────────────────

  private async exclusions(ctx: KnowledgeCtx): Promise<ExclusionRow[]> {
    return this.db.$queryRawUnsafe<ExclusionRow[]>(
      `SELECT "kind", "value" FROM ${this.X} WHERE "siteId" = $1 AND "accountId" = $2`,
      ctx.siteId,
      ctx.accountId,
    );
  }

  /**
   * Физическое удаление фрагментов ВСЕХ версий под исключение (§4-тер.12):
   * откат их не вернёт. Возвращает число удалённых фрагментов.
   */
  private async deleteExcluded(
    ctx: KnowledgeCtx,
    ex: ExclusionRow,
  ): Promise<number> {
    const base = `"siteId" = $1 AND "accountId" = $2`;
    switch (ex.kind) {
      case 'url':
        return this.db.$executeRawUnsafe(
          `DELETE FROM ${this.C} WHERE ${base} AND ("url" = $3 OR "documentId" IN (
             SELECT "id" FROM ${this.D} WHERE ${base} AND ("url" = $3 OR "ref" = $3)))`,
          ctx.siteId,
          ctx.accountId,
          ex.value,
        );
      case 'urlPrefix': {
        const under = (col: string) =>
          `(${col} = $3 OR ${col} LIKE $4 OR ${col} LIKE $5)`;
        return this.db.$executeRawUnsafe(
          `DELETE FROM ${this.C} WHERE ${base} AND (${under('"url"')} OR "documentId" IN (
             SELECT "id" FROM ${this.D} WHERE ${base} AND (${under('"url"')} OR ${under('"ref"')})))`,
          ctx.siteId,
          ctx.accountId,
          ex.value,
          ...prefixPatterns(ex.value),
        );
      }
      case 'document':
        return this.db.$executeRawUnsafe(
          `DELETE FROM ${this.C} WHERE ${base} AND "documentId" = $3`,
          ctx.siteId,
          ctx.accountId,
          ex.value,
        );
      case 'chunkHash':
        return this.db.$executeRawUnsafe(
          `DELETE FROM ${this.C} WHERE ${base} AND "contentHash" = $3`,
          ctx.siteId,
          ctx.accountId,
          ex.value,
        );
      default:
        return 0;
    }
  }

  private async markDocsExcluded(
    ctx: KnowledgeCtx,
    ex: ExclusionRow,
  ): Promise<void> {
    const set = `"status" = 'excluded', "skipReason" = 'excluded', "updatedAt" = now()`;
    const base = `"siteId" = $1 AND "accountId" = $2`;
    if (ex.kind === 'url') {
      await this.db.$executeRawUnsafe(
        `UPDATE ${this.D} SET ${set} WHERE ${base} AND ("url" = $3 OR "ref" = $3)`,
        ctx.siteId,
        ctx.accountId,
        ex.value,
      );
    } else if (ex.kind === 'urlPrefix') {
      await this.db.$executeRawUnsafe(
        `UPDATE ${this.D} SET ${set} WHERE ${base} AND (${PREFIX_SQL})`,
        ctx.siteId,
        ctx.accountId,
        ex.value,
        ...prefixPatterns(ex.value),
      );
    } else if (ex.kind === 'document') {
      await this.db.$executeRawUnsafe(
        `UPDATE ${this.D} SET ${set} WHERE ${base} AND "id" = $3`,
        ctx.siteId,
        ctx.accountId,
        ex.value,
      );
    }
  }

  async applyExclusion(
    ctx: KnowledgeCtx,
    exclusion: ExclusionInput,
    byTelegramId: bigint,
  ): Promise<{ chunksDeleted: number; version: VersionResult }> {
    if (
      !['url', 'urlPrefix', 'chunkHash', 'document'].includes(exclusion.kind)
    ) {
      throw knowledgeError('BAD_REQUEST', 'Неизвестный вид исключения', 400);
    }
    if (!exclusion.value) {
      throw knowledgeError('BAD_REQUEST', 'Пустое значение исключения', 400);
    }
    await this.hooks.ensureSettings(ctx);
    // Удаление — СРАЗУ и без замка сборки: исключение не ждёт ни ворот,
    // ни бюджета, ни чужой сборки (§4-тер.11, §4-тер.12).
    const chunksDeleted = await this.deleteExcluded(ctx, exclusion);
    await this.markDocsExcluded(ctx, exclusion);
    await this.db.$executeRawUnsafe(
      `UPDATE ${this.X}
          SET "appliedAt" = now(), "chunksDeleted" = "chunksDeleted" + $5
        WHERE "siteId" = $1 AND "accountId" = $2 AND "kind" = $3 AND "value" = $4`,
      ctx.siteId,
      ctx.accountId,
      exclusion.kind,
      exclusion.value,
      chunksDeleted,
    );
    // Новая версия — ради смены knowledgeVersion: ключ семантического
    // кэша (Э2) обязан смениться, иначе кэш вернул бы исключённое.
    const out = await this.build(
      ctx,
      {
        trigger: 'exclusion',
        byTelegramId,
        upserts: [],
        removals: [],
        gated: false,
        budgetPolicy: 'strict',
      },
      { forceVersion: true, waitMs: HUMAN_WAIT_MS },
    );
    const version = out.version ?? (await this.currentAsResult(ctx)); // чужая сборка опубликует свою — фрагментов уже нет
    return { chunksDeleted, version };
  }

  async liftExclusion(ctx: KnowledgeCtx, exclusionId: string): Promise<void> {
    const rows = await this.db.$queryRawUnsafe<ExclusionRow[]>(
      `DELETE FROM ${this.X} WHERE "siteId" = $1 AND "accountId" = $2 AND "id" = $3
        RETURNING "kind", "value"`,
      ctx.siteId,
      ctx.accountId,
      exclusionId,
    );
    const ex = rows[0];
    if (!ex) return;
    // Страница вернётся со следующим переобходом: indexedHash = NULL
    // заставит индексацию взять её как изменённую.
    const base = `"siteId" = $1 AND "accountId" = $2 AND "status" = 'excluded'`;
    const set = `"indexedHash" = NULL, "status" = 'gone', "skipReason" = NULL, "updatedAt" = now()`;
    if (ex.kind === 'url') {
      await this.db.$executeRawUnsafe(
        `UPDATE ${this.D} SET ${set} WHERE ${base} AND ("url" = $3 OR "ref" = $3)`,
        ctx.siteId,
        ctx.accountId,
        ex.value,
      );
    } else if (ex.kind === 'urlPrefix') {
      await this.db.$executeRawUnsafe(
        `UPDATE ${this.D} SET ${set} WHERE ${base} AND (${PREFIX_SQL})`,
        ctx.siteId,
        ctx.accountId,
        ex.value,
        ...prefixPatterns(ex.value),
      );
    } else if (ex.kind === 'document') {
      await this.db.$executeRawUnsafe(
        `UPDATE ${this.D} SET ${set} WHERE ${base} AND "id" = $3`,
        ctx.siteId,
        ctx.accountId,
        ex.value,
      );
    }
  }

  // ── действия человека ──────────────────────────────────────────────────

  async indexDocuments(
    ctx: KnowledgeCtx,
    sourceId: string,
    docs: DocumentInput[],
    opts: {
      trigger: VersionTrigger;
      byTelegramId?: bigint | null;
      replaceAll?: boolean;
    },
  ): Promise<VersionResult> {
    await this.hooks.ensureSettings(ctx);
    const refs = new Set(docs.map((d) => d.ref));
    if (refs.size !== docs.length) {
      throw knowledgeError(
        'BAD_REQUEST',
        'Повторяющиеся ref в документах',
        400,
      );
    }
    const removals: Removal[] = [];
    let previouslyPublishedPages = 0;
    if (opts.replaceAll) {
      const live = await this.liveDocs(ctx, sourceId);
      previouslyPublishedPages = live.length;
      for (const d of live) {
        if (!refs.has(d.ref))
          removals.push({ documentId: d.id, status: 'gone' });
      }
    }
    const gated = opts.trigger === 'crawl';
    const out = await this.build(
      ctx,
      {
        trigger: opts.trigger,
        byTelegramId: opts.byTelegramId ?? null,
        upserts: docs.map((input) => ({
          sourceId,
          input,
          docHash: documentHash(input),
          hot: false,
        })),
        removals,
        gated,
        budgetPolicy: gated ? 'crawl' : 'strict',
        gone: { previouslyPublishedPages, brokenPages: removals.length },
      },
      { forceVersion: true, waitMs: gated ? 0 : HUMAN_WAIT_MS },
    );
    if (!out.version) throw this.busyError();
    return out.version;
  }

  async removeDocuments(
    ctx: KnowledgeCtx,
    sourceId: string,
    refs: string[] | 'all',
    byTelegramId: bigint | null,
  ): Promise<VersionResult> {
    await this.hooks.ensureSettings(ctx);
    const rows = await this.db.$queryRawUnsafe<{ id: string; ref: string }[]>(
      `SELECT "id", "ref" FROM ${this.D}
        WHERE "siteId" = $1 AND "accountId" = $2 AND "sourceId" = $3`,
      ctx.siteId,
      ctx.accountId,
      sourceId,
    );
    const want = refs === 'all' ? null : new Set(refs);
    const removals: Removal[] = rows
      .filter((r) => !want || want.has(r.ref))
      .map((r) => ({ documentId: r.id, status: 'gone' as const }));
    const out = await this.build(
      ctx,
      {
        trigger: 'document',
        byTelegramId,
        upserts: [],
        removals,
        gated: false,
        budgetPolicy: 'strict',
      },
      { forceVersion: true, waitMs: HUMAN_WAIT_MS },
    );
    if (!out.version) throw this.busyError();
    return out.version;
  }

  async allowQuarantined(
    ctx: KnowledgeCtx,
    chunkId: string,
    byTelegramId: bigint,
  ): Promise<VersionResult> {
    await this.hooks.ensureSettings(ctx);
    const rows = await this.db.$queryRawUnsafe<
      Array<{
        id: string;
        documentId: string;
        sourceType: string;
        url: string | null;
        title: string | null;
        headingPath: string | null;
        lang: string | null;
        ordinal: number;
        text: string;
        tokens: number;
        contentHash: string;
        digitsMaskedHash: string;
        ugc: boolean;
      }>
    >(
      `SELECT "id", "documentId", "sourceType", "url", "title", "headingPath", "lang", "ordinal",
              "text", "tokens", "contentHash", "digitsMaskedHash", "ugc"
         FROM ${this.C}
        WHERE "siteId" = $1 AND "accountId" = $2 AND "id" = $3 AND "quarantined"
          AND "versions" && $4::int[]`,
      ctx.siteId,
      ctx.accountId,
      chunkId,
      await this.liveVersionNumbers(ctx),
    );
    // Только фрагмент опубликованной или удержанной версии: уже включённый
    // (его копия без карантина — в текущей версии) повторно не включается —
    // иначе двойное нажатие добавило бы в базу второй такой же фрагмент.
    const c = rows[0];
    if (!c) {
      throw knowledgeError(
        'NOT_FOUND',
        'Фрагмент в карантине не найден',
        HttpStatus.NOT_FOUND,
      );
    }
    // Эмбеддинг — если бюджет позволяет; нет — фрагмент всё равно
    // включается и находится полнотекстом (решение человека не ждёт денег).
    let vector: number[] | null = null;
    const tokens = estimateEmbedTokens(c.text);
    const est = estimateCost(KNOWLEDGE_DEFAULTS.embedModel, {
      inputTokens: tokens,
    }).costMicroUsd;
    if (await this.deps.budget.reserve(ctx.accountId, ctx.siteId, est)) {
      try {
        const r = await this.deps.embedder.embed([c.text], 'document');
        vector = r.vectors[0] ?? null;
        await this.recordEmbed(ctx, r.model, r.inputTokens, est);
      } catch (e) {
        await this.deps.budget.adjust(ctx.accountId, ctx.siteId, -est);
        this.logger.warn(
          `Эмбеддинг включённого фрагмента не получен: ${(e as Error).name}`,
        );
      }
    }
    const got = await this.versions.acquireWaiting(
      ctx,
      { trigger: 'quarantine', byTelegramId },
      HUMAN_WAIT_MS,
    );
    if (!got) throw this.busyError();
    try {
      // Копия фрагмента без карантина — в новую версию; старая строка
      // остаётся в старых версиях (откат вернёт и карантин).
      await this.appendBase(
        this.db,
        ctx,
        got.number,
        got.parent,
        [],
        [chunkId],
      );
      await this.db.$executeRawUnsafe(
        `INSERT INTO ${this.C} ("id", "accountId", "siteId", "documentId", "sourceType", "url", "title",
            "headingPath", "lang", "ordinal", "text", "tokens", "contentHash", "digitsMaskedHash",
            "versions", "ugc", "quarantined", "quarantineAllowedAt", "quarantineAllowedByTelegramId",
            "embedModel", "embedding", "embeddedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
            ARRAY[$15]::int[], $16, false, now(), $17,
            $18, $19::"extensions"."vector", CASE WHEN $19::text IS NULL THEN NULL ELSE now() END, now())`,
        newRowId(),
        ctx.accountId,
        ctx.siteId,
        c.documentId,
        c.sourceType,
        c.url,
        c.title,
        c.headingPath,
        c.lang,
        c.ordinal,
        c.text,
        c.tokens,
        c.contentHash,
        c.digitsMaskedHash,
        got.number,
        c.ugc,
        byTelegramId,
        vector ? KNOWLEDGE_DEFAULTS.embedModel : null,
        vector ? toVectorLiteral(vector) : null,
      );
      return await this.finish(ctx, got, {
        trigger: 'quarantine',
        byTelegramId,
        gated: false,
        stats: { allowedChunkId: chunkId },
      });
    } catch (e) {
      await this.abort(ctx, got.number);
      throw e;
    }
  }

  /** Версии, чей карантин ждёт решения: опубликованная и удержанные. */
  private async liveVersionNumbers(ctx: KnowledgeCtx): Promise<number[]> {
    const rows = await this.db.$queryRawUnsafe<{ number: number }[]>(
      `SELECT "number" FROM ${qualified(this.tables.versions)}
        WHERE "siteId" = $1 AND "accountId" = $2 AND "status" = 'held'
       UNION
       SELECT "knowledgeVersion" FROM ${qualified(this.tables.settings)}
        WHERE "siteId" = $1 AND "accountId" = $2 AND "knowledgeVersion" > 0`,
      ctx.siteId,
      ctx.accountId,
    );
    return rows.map((r) => r.number);
  }

  async publishHeld(
    ctx: KnowledgeCtx,
    number: number,
    byTelegramId: bigint,
  ): Promise<VersionResult> {
    const v = await this.versions.get(ctx, number);
    if (!v) throw this.versionNotFound();
    if (v.status !== 'held') {
      throw knowledgeError('VERSION_NOT_HELD', 'Эта версия не ждёт решения');
    }
    const s = await this.versions.settings(ctx);
    if (!s || v.parentNumber !== s.knowledgeVersion) {
      // После удержания база уже менялась: «как есть» затёрло бы новое.
      await this.discardAndReset(
        ctx,
        number,
        v.parentNumber,
        'устарела: после неё опубликована другая версия',
      );
      throw knowledgeError(
        'VERSION_NOT_HELD',
        'Версия устарела: после неё база уже обновлялась. Следующий переобход соберёт изменения заново',
      );
    }
    const superseded = await this.versions.publish(ctx, number, {
      byTelegramId,
      fromStatuses: ['held'],
    });
    await this.afterPublish(ctx, number, superseded);
    return { number, status: 'published', gateReport: v.gateReport };
  }

  async discard(
    ctx: KnowledgeCtx,
    number: number,
    byTelegramId: bigint,
  ): Promise<VersionResult> {
    void byTelegramId;
    const v = await this.versions.get(ctx, number);
    if (!v) throw this.versionNotFound();
    if (v.status !== 'held') {
      throw knowledgeError(
        'VERSION_NOT_HELD',
        'Отбросить можно только удержанную версию',
      );
    }
    await this.discardAndReset(
      ctx,
      number,
      v.parentNumber,
      'отброшена владельцем',
    );
    return { number, status: 'discarded', gateReport: v.gateReport };
  }

  async rollback(
    ctx: KnowledgeCtx,
    toNumber: number,
    byTelegramId: bigint,
  ): Promise<VersionResult> {
    await this.hooks.ensureSettings(ctx);
    const s = await this.versions.settings(ctx);
    const window = await this.versions.rollbackWindow(ctx);
    if (!s || toNumber === s.knowledgeVersion || !window.includes(toNumber)) {
      throw knowledgeError(
        'VERSION_NOT_ROLLBACKABLE',
        'К этой версии вернуться нельзя: она текущая или вне окна отката (7 дней, 5 публикаций)',
      );
    }
    const got = await this.versions.acquireWaiting(
      ctx,
      { trigger: 'rollback', byTelegramId },
      HUMAN_WAIT_MS,
    );
    if (!got) throw this.busyError();
    try {
      const changed = await this.versions.changedDocs(
        ctx,
        got.parent,
        toNumber,
      );
      await this.db.$executeRawUnsafe(
        `UPDATE ${this.C} SET "versions" = array_append("versions", $3), "updatedAt" = now()
          WHERE "siteId" = $1 AND "accountId" = $2 AND $4 = ANY("versions")`,
        ctx.siteId,
        ctx.accountId,
        got.number,
        toNumber,
      );
      // Страницы, отличающиеся от N, следующий переобход пересоберёт:
      // «свежий факт побеждает» — откат возвращает базу, а не останавливает сайт.
      await this.versions.resetDocs(ctx, changed);
      return await this.finish(ctx, got, {
        trigger: 'rollback',
        byTelegramId,
        gated: false,
        stats: { rollbackOf: toNumber },
      });
    } catch (e) {
      await this.abort(ctx, got.number);
      throw e;
    }
  }

  // ── переобход ──────────────────────────────────────────────────────────

  /**
   * Документы источника, которые есть в опубликованной версии.
   */
  private async liveDocs(
    ctx: KnowledgeCtx,
    sourceId: string,
  ): Promise<Array<{ id: string; ref: string }>> {
    const s = await this.versions.settings(ctx);
    if (!s?.knowledgeVersion) return [];
    return this.db.$queryRawUnsafe(
      `SELECT d."id", d."ref" FROM ${this.D} d
        WHERE d."siteId" = $1 AND d."accountId" = $2 AND d."sourceId" = $3
          AND EXISTS (SELECT 1 FROM ${this.C} c
                       WHERE c."siteId" = $1 AND c."documentId" = d."id"
                         AND $4 = ANY(c."versions"))`,
      ctx.siteId,
      ctx.accountId,
      sourceId,
      s.knowledgeVersion,
    );
  }

  /**
   * Версия из прогона обхода (site_pages сайта → документы источника).
   * Неизменённое (тот же хеш) — без версии и без эмбеддингов.
   * `includeUgc = false` — блоки ugc отбрасываются (копия в «Админку», §3.4).
   */
  async indexCrawl(
    ctx: KnowledgeCtx,
    p: {
      sourceId: string;
      crawlRunId: string;
      pages: CrawlPageInput[];
      hotUrls: string[];
      includeUgc: boolean;
    },
    deadline?: BuildDeadline,
  ): Promise<BuildOutcome> {
    await this.hooks.ensureSettings(ctx);
    // Сборка, которую прошлый тик не успел, — продолжается (та же версия,
    // план не пересчитывается: он сохранён в прогрессе).
    const resumed = await this.resumeCrawl(ctx, p, deadline);
    if (resumed) return resumed;
    // Удержанные версии устаревают: новая соберётся от опубликованной со
    // ВСЕМИ изменениями сайта (их документы получают indexedHash = NULL).
    await this.supersedeHeld(ctx);

    const exclusions = await this.exclusions(ctx);
    const docs = await this.db.$queryRawUnsafe<
      Array<{
        id: string;
        ref: string;
        indexedHash: string | null;
        status: string;
        hot: boolean;
      }>
    >(
      `SELECT "id", "ref", "indexedHash", "status", "hot" FROM ${this.D}
        WHERE "siteId" = $1 AND "accountId" = $2 AND "sourceId" = $3`,
      ctx.siteId,
      ctx.accountId,
      p.sourceId,
    );
    const live = new Set(
      (await this.liveDocs(ctx, p.sourceId)).map((d) => d.id),
    );
    const byRef = new Map(docs.map((d) => [d.ref, d]));
    const hot = new Set(p.hotUrls);
    const seen = new Set<string>();
    const upserts: DocPlan[] = [];
    const removals: Removal[] = [];
    let broken = 0;
    const failing: Array<{ id: string; reason: string }> = [];
    const hotFlags: Array<{ id: string; hot: boolean }> = [];

    for (const page of p.pages) {
      const ref = page.url;
      seen.add(ref);
      const doc = byRef.get(ref);
      const isLive = !!doc && live.has(doc.id);
      const isHot =
        hot.has(page.url) || (!!page.finalUrl && hot.has(page.finalUrl));
      if (doc && doc.hot !== isHot) hotFlags.push({ id: doc.id, hot: isHot });

      if (
        isExcludedUrl(page.url, exclusions) ||
        isExcludedUrl(page.finalUrl, exclusions)
      ) {
        if (doc && doc.status !== 'excluded') {
          removals.push({
            documentId: doc.id,
            status: 'excluded',
            skipReason: 'excluded',
          });
        }
        continue;
      }
      const planned = pagePlan(page, p.sourceId, p.includeUgc, isHot);
      if (planned) {
        if (
          !doc ||
          doc.indexedHash !== planned.docHash ||
          doc.status !== 'active'
        ) {
          upserts.push(planned);
        }
        continue;
      }
      if (page.status === 'new') continue; // ещё не прочитана
      const reason =
        page.status === 'gone' ? 'gone' : (page.skipReason ?? page.status);
      if (isLive && (page.status === 'gone' || BROKEN_REASONS.has(reason))) {
        broken++;
      }
      if (!doc || !isLive) continue;
      if (page.status === 'failed' || KEEP_ON_FAILURE.has(reason)) {
        if (reason !== 'limit') failing.push({ id: doc.id, reason });
        continue;
      }
      removals.push({
        documentId: doc.id,
        status: page.status === 'gone' ? 'gone' : 'skipped',
        skipReason: page.status === 'gone' ? null : reason,
      });
    }
    // Страницы, которых в site_pages больше нет (хост удалён и т.п.).
    for (const d of docs) {
      if (!seen.has(d.ref) && live.has(d.id)) {
        removals.push({ documentId: d.id, status: 'gone' });
        broken++;
      }
    }
    // Временный сбой страницы (5xx/таймаут) фрагменты не стирает. Массовый
    // сбой — другое дело: версия «как есть» (без упавших страниц) идёт в
    // ворота и удерживается, владелец решает сам (§4-тер.15 п.1).
    if (
      live.size > 0 &&
      broken / live.size > KNOWLEDGE_DEFAULTS.gates.goneOrErrorShare &&
      broken >= GONE_OR_ERROR_MIN_PAGES
    ) {
      for (const f of failing) {
        removals.push({
          documentId: f.id,
          status: 'failed',
          skipReason: f.reason,
        });
      }
    }
    for (const f of hotFlags) {
      await this.db.$executeRawUnsafe(
        `UPDATE ${this.D} SET "hot" = $4, "updatedAt" = now()
          WHERE "siteId" = $1 AND "accountId" = $2 AND "id" = $3`,
        ctx.siteId,
        ctx.accountId,
        f.id,
        f.hot,
      );
    }
    if (!upserts.length && !removals.length) {
      return { ...emptyOutcome(), crawlRunId: p.crawlRunId };
    }
    return this.build(
      ctx,
      {
        trigger: 'crawl',
        byTelegramId: null,
        crawlRunId: p.crawlRunId,
        upserts,
        removals,
        gated: true,
        budgetPolicy: 'crawl',
        gone: { previouslyPublishedPages: live.size, brokenPages: broken },
      },
      {
        forceVersion: false,
        waitMs: 0,
        resumable: { sourceId: p.sourceId, includeUgc: p.includeUgc },
        deadline,
      },
    );
  }

  /**
   * Уборка зависших сборок по всем сайтам режима (крон индексации): сборка
   * без heartbeat дольше lease — сайт выключили посреди сборки, тики
   * остановились — иначе осталась бы `building` навсегда (номер в
   * членстве фрагментов, незакрытый резерв). `only` — сузить (тесты на
   * общей базе).
   */
  async reapStaleBuilds(
    limit = 50,
    only?: { siteId: string },
  ): Promise<number> {
    let n = 0;
    for (const ctx of await this.versions.staleSites(limit, only)) {
      try {
        n += (await this.versions.reap(ctx)).length;
      } catch (e) {
        this.logger.error(
          `Уборка зависшей сборки сайта ${ctx.siteId} не удалась: ${(e as Error).message}`,
        );
      }
    }
    return n;
  }

  // ── ядро сборки ────────────────────────────────────────────────────────

  private busyError() {
    return knowledgeError(
      'KNOWLEDGE_BUSY',
      'База знаний сейчас обновляется — повторите через минуту',
    );
  }

  private versionNotFound() {
    return knowledgeError(
      'NOT_FOUND',
      'Версия не найдена',
      HttpStatus.NOT_FOUND,
    );
  }

  private async currentAsResult(ctx: KnowledgeCtx): Promise<VersionResult> {
    const s = await this.versions.settings(ctx);
    const n = s?.knowledgeVersion ?? 0;
    const v = n ? await this.versions.get(ctx, n) : null;
    return {
      number: n,
      status: 'published',
      gateReport: v?.gateReport ?? null,
    };
  }

  /**
   * Сборка не удалась: версия отброшена; что она успела поменять в
   * документах — пересоберёт следующий переобход (indexedHash = NULL:
   * иначе новый хеш документа без его фрагментов «потерял» бы страницу до
   * её следующего изменения); незакрытый резерв обучения — назад.
   */
  private async abort(ctx: KnowledgeCtx, number: number): Promise<void> {
    try {
      const d = await this.versions.discardBuild(
        ctx,
        number,
        'сборка не удалась',
      );
      if (d) await this.versions.cleanupReaped(ctx, [d]);
    } catch (e) {
      this.logger.error(
        `Не удалось отбросить версию ${number}: ${(e as Error).message}`,
      );
    }
  }

  private async discardAndReset(
    ctx: KnowledgeCtx,
    number: number,
    parent: number | null,
    reason: string,
  ): Promise<void> {
    const changed =
      parent !== null
        ? await this.versions.changedDocs(ctx, parent, number)
        : [];
    await this.versions.discard(ctx, number, reason);
    await this.versions.removeNumbers(ctx, [number]);
    await this.versions.resetDocs(ctx, changed);
  }

  private async supersedeHeld(ctx: KnowledgeCtx): Promise<void> {
    const held = await this.db.$queryRawUnsafe<
      Array<{ number: number; parentNumber: number | null }>
    >(
      `SELECT "number", "parentNumber" FROM ${qualified(this.tables.versions)}
        WHERE "siteId" = $1 AND "accountId" = $2 AND "status" = 'held'`,
      ctx.siteId,
      ctx.accountId,
    );
    for (const h of held) {
      await this.discardAndReset(
        ctx,
        h.number,
        h.parentNumber,
        'устарела: новый переобход собрал версию заново',
      );
    }
  }

  /** Неизменённые фрагменты P переходят в B (кроме затронутых документов/строк). */
  private async appendBase(
    db: RawDb,
    ctx: KnowledgeCtx,
    number: number,
    parent: number,
    touchedDocIds: string[],
    skipChunkIds: string[] = [],
  ): Promise<void> {
    if (!parent) return;
    await db.$executeRawUnsafe(
      `UPDATE ${this.C} SET "versions" = array_append("versions", $3), "updatedAt" = now()
        WHERE "siteId" = $1 AND "accountId" = $2 AND $4 = ANY("versions")
          AND NOT ($3 = ANY("versions"))
          AND "documentId" <> ALL($5::text[]) AND "id" <> ALL($6::text[])`,
      ctx.siteId,
      ctx.accountId,
      number,
      parent,
      touchedDocIds,
      skipChunkIds,
    );
  }

  /**
   * Фрагменты P этих документов переходят в B как есть: документ был в
   * плане, но в пачке не изменён (отложен бюджетом, исключён, страница
   * пропала за время сборки) — прежний текст остаётся в базе.
   */
  private async carryDocs(
    db: RawDb,
    ctx: KnowledgeCtx,
    number: number,
    parent: number,
    docIds: string[],
  ): Promise<void> {
    if (!parent || !docIds.length) return;
    await db.$executeRawUnsafe(
      `UPDATE ${this.C} SET "versions" = array_append("versions", $3), "updatedAt" = now()
        WHERE "siteId" = $1 AND "accountId" = $2 AND $4 = ANY("versions")
          AND NOT ($3 = ANY("versions")) AND "documentId" = ANY($5::text[])`,
      ctx.siteId,
      ctx.accountId,
      number,
      parent,
      docIds,
    );
  }

  private async recordEmbed(
    ctx: KnowledgeCtx,
    model: string,
    inputTokens: number,
    reservedMicroUsd: number,
  ): Promise<void> {
    const r = await this.deps.usage.record(
      this.deps.sitesDb.forAccount(ctx.accountId),
      {
        accountId: ctx.accountId,
        siteId: ctx.siteId,
        operation: 'assist-embed',
        model,
        units: { inputTokens, calls: 1 },
      },
    );
    await this.deps.budget.adjust(
      ctx.accountId,
      ctx.siteId,
      r.costMicroUsd - reservedMicroUsd,
    );
  }

  /**
   * Сборка версии по плану (действие человека — без дедлайна, обход — с
   * дедлайном тика). `forceVersion` — создать версию, даже если менять
   * нечего (исключение: нужна смена knowledgeVersion для кэша).
   */
  private async build(
    ctx: KnowledgeCtx,
    plan: BuildPlan,
    o: {
      forceVersion: boolean;
      waitMs: number;
      /** Сборка обхода: очередь сохраняется, следующий тик продолжит. */
      resumable?: { sourceId: string; includeUgc: boolean };
      deadline?: BuildDeadline;
    },
  ): Promise<BuildOutcome> {
    const outcome = emptyOutcome();
    const exclusions = await this.exclusions(ctx);
    // Исключённое не индексируется вовсе (страница, документ, URL).
    const upserts = plan.upserts.filter(
      (u) =>
        !isExcludedUrl(u.input.url ?? null, exclusions) &&
        !isExcludedUrl(u.input.ref, exclusions),
    );
    // Горячие — первыми: при исчерпании бюджета посреди сборки они уже
    // проиндексированы (без них нет свежести цен и доставки, К-1).
    if (plan.budgetPolicy === 'crawl') {
      upserts.sort((a, b) => Number(b.hot) - Number(a.hot));
    }

    const acq = {
      trigger: plan.trigger,
      byTelegramId: plan.byTelegramId,
      crawlRunId: plan.crawlRunId,
    };
    const got =
      o.waitMs > 0
        ? await this.versions.acquireWaiting(ctx, acq, o.waitMs)
        : await this.versions.acquire(ctx, acq);
    if (!got) return { ...outcome, busy: true };
    const B = got.number;
    const P = got.parent;
    const st: BuildState = {
      v: 1,
      resumable: !!o.resumable,
      claim: randomUUID(),
      phase: 'docs',
      trigger: plan.trigger,
      crawlRunId: plan.crawlRunId ?? null,
      gated: plan.gated,
      budgetPolicy: plan.budgetPolicy,
      forceVersion: o.forceVersion,
      sourceId: o.resumable?.sourceId ?? null,
      includeUgc: o.resumable?.includeUgc ?? true,
      queue: o.resumable ? upserts.map((u) => u.input.ref) : [],
      hot: o.resumable ? upserts.flatMap((u, i) => (u.hot ? [i] : [])) : [],
      total: upserts.length,
      cursor: 0,
      removals: plan.removals,
      gone: plan.gone ?? null,
      budgetExhausted: false,
      outstandingMicroUsd: 0,
      counts: emptyCounts(),
      changedHashes: {},
      ticks: 0,
    };
    try {
      // Затронутые документы, которые уже есть, — их фрагменты P решает
      // пачка (перенос/копия/новые); остальное P переходит в B сразу.
      const keys = upserts.map((u) => docKey(u.sourceId, u.input.ref));
      const existing = await this.existingDocs(this.db, ctx, keys);
      await this.appendBase(this.db, ctx, B, P, [
        ...existing.values(),
        ...plan.removals.map((r) => r.documentId),
      ]);
      await this.versions.saveProgress(this.db, ctx, B, st);
    } catch (e) {
      await this.abort(ctx, B);
      throw e;
    }
    return this.runBuild(
      ctx,
      { number: B, parent: P },
      st,
      upserts,
      plan.byTelegramId,
      outcome,
      o.deadline,
    );
  }

  /**
   * Продолжить приостановленную сборку обхода (тик, следующий за тем, где
   * кончилось время, или после падения тика). null — продолжать нечего.
   */
  private async resumeCrawl(
    ctx: KnowledgeCtx,
    p: { sourceId: string; pages: CrawlPageInput[] },
    deadline?: BuildDeadline,
  ): Promise<BuildOutcome | null> {
    const found = await this.versions.findResumable(ctx, p.sourceId);
    if (!found) return null;
    const outcome = emptyOutcome();
    const token = randomUUID();
    const claimed = await this.versions.claim(ctx, found.number, token);
    if (!claimed) return { ...outcome, busy: true }; // ведёт живой тик
    if (claimed.refundMicroUsd > 0) {
      // Тик упал между резервом пачки и её записью: пачки в базе нет —
      // резерв возвращается (тот же UPDATE обнулил его в прогрессе).
      await this.deps.budget.adjust(
        ctx.accountId,
        ctx.siteId,
        -claimed.refundMicroUsd,
      );
    }
    const st = claimed.progress as unknown as BuildState;
    st.claim = token;
    st.outstandingMicroUsd = 0;
    const hot = new Set(st.hot);
    const pageByRef = new Map(p.pages.map((pg) => [pg.url, pg]));
    // Документы плана — из ТЕКУЩИХ страниц (свежий текст побеждает):
    // страница перестала читаться — её прежние фрагменты переходят как есть.
    const plans: Array<DocPlan | null> = st.queue.map((ref, i) => {
      const page = pageByRef.get(ref);
      return page
        ? pagePlan(page, st.sourceId as string, st.includeUgc, hot.has(i))
        : null;
    });
    return this.runBuild(
      ctx,
      { number: found.number, parent: claimed.parent },
      st,
      plans,
      null,
      outcome,
      deadline,
      st.queue,
    );
  }

  /** Пачки от курсора → завершение; дедлайн — приостановка с прогрессом. */
  private async runBuild(
    ctx: KnowledgeCtx,
    got: { number: number; parent: number },
    st: BuildState,
    plans: Array<DocPlan | null>,
    byTelegramId: bigint | null,
    outcome: BuildOutcome,
    deadline?: BuildDeadline,
    refs?: string[],
  ): Promise<BuildOutcome> {
    const B = got.number;
    outcome.crawlRunId = st.crawlRunId;
    const now = deadline?.now ?? Date.now;
    const until = deadline?.deadlineAt;
    const batchDocs = Math.max(1, deadline?.batchDocs ?? BUILD_BATCH_DOCS);
    st.ticks++;
    try {
      const exclusions = await this.exclusions(ctx);
      let lastBatchMs = 0;
      let batches = 0;
      while (st.phase === 'docs' && st.cursor < plans.length) {
        // Не начинать пачку, которая не успеет: оценка — самая долгая
        // пачка этого тика. Первая пачка тика идёт всегда — иначе сборка,
        // начатая без запаса времени, не продвинулась бы никогда.
        if (
          until !== undefined &&
          batches > 0 &&
          now() + lastBatchMs >= until
        ) {
          return await this.pause(ctx, B, st, outcome);
        }
        const t0 = now();
        // Действие человека — одной пачкой: бюджет решается целиком
        // («всё или LEARNING_BUDGET_EXHAUSTED»), сборка — в одном запросе.
        const size = st.budgetPolicy === 'strict' ? plans.length : batchDocs;
        const from = st.cursor;
        const slice = plans.slice(from, from + size).map((plan, i) => ({
          plan,
          key:
            plan !== null
              ? docKey(plan.sourceId, plan.input.ref)
              : docKey(st.sourceId ?? '', refs?.[from + i] ?? ''),
        }));
        await this.runBatch(ctx, got, st, slice, exclusions, outcome);
        batches++;
        lastBatchMs = Math.max(lastBatchMs, now() - t0);
      }
      st.phase = 'finish';
      if (
        until !== undefined &&
        batches > 0 &&
        now() + FINISH_RESERVE_MS >= until
      ) {
        // Ворота (с eval) и публикация — целиком в одном тике: не хватает
        // запаса — завершит следующий (он начнёт прямо с них).
        return await this.pause(ctx, B, st, outcome);
      }
      await this.versions.saveProgress(this.db, ctx, B, st);
      return await this.complete(ctx, got, st, byTelegramId, outcome);
    } catch (e) {
      await this.abort(ctx, B);
      throw e;
    }
  }

  /** Конец тика: прогресс сохранён, claim снят — следующий тик продолжит. */
  private async pause(
    ctx: KnowledgeCtx,
    number: number,
    st: BuildState,
    outcome: BuildOutcome,
  ): Promise<BuildOutcome> {
    if (!st.resumable) {
      // Действие человека не делится на тики (его ждёт запрос) — сюда не
      // попадает: дедлайн передаёт только сборка обхода.
      throw new Error('Сборку без очереди нельзя приостановить');
    }
    st.claim = null;
    await this.versions.saveProgress(this.db, ctx, number, st);
    outcome.paused = true;
    outcome.deferred = st.counts.deferred;
    outcome.budgetExhausted ||= st.budgetExhausted;
    outcome.progress = { done: st.cursor, total: st.total };
    return outcome;
  }

  /**
   * Одна пачка документов: резка → план по фрагментам → резерв бюджета
   * ПАЧКИ (записан в прогресс до эмбеддинга) → эмбеддинг → запись строк,
   * курсора и закрытие резерва ОДНОЙ транзакцией → факт в site_ai_usage.
   * Обрыв до транзакции: резерв пачки виден в прогрессе и возвращается
   * (claim/снятие сборки); после — пачка записана, резерв закрыт.
   */
  private async runBatch(
    ctx: KnowledgeCtx,
    got: { number: number; parent: number },
    st: BuildState,
    slice: Array<{ plan: DocPlan | null; key: string }>,
    exclusions: ExclusionRow[],
    outcome: BuildOutcome,
  ): Promise<void> {
    const B = got.number;
    const P = got.parent;
    const excludedHashes = new Set(
      exclusions.filter((e) => e.kind === 'chunkHash').map((e) => e.value),
    );
    const excludedDocIds = new Set(
      exclusions.filter((e) => e.kind === 'document').map((e) => e.value),
    );
    const docIdByKey = await this.existingDocs(
      this.db,
      ctx,
      slice.map((s) => s.key),
    );
    // Документы плана, которые в этой пачке не меняются, — переносом P.
    const carry: string[] = [];
    const plannable: DocPlan[] = [];
    for (const s of slice) {
      const id = docIdByKey.get(s.key) ?? null;
      const u = s.plan;
      const skip =
        !u ||
        (!!id && excludedDocIds.has(id)) ||
        isExcludedUrl(u.input.url ?? null, exclusions) ||
        isExcludedUrl(u.input.ref, exclusions);
      if (skip) {
        if (id) carry.push(id);
        st.counts.skipped++;
        continue;
      }
      plannable.push(u);
    }

    // Фрагменты затронутых документов в P — кандидаты на перенос/копию вектора.
    const existingIds = plannable
      .map((u) => docIdByKey.get(docKey(u.sourceId, u.input.ref)))
      .filter((x): x is string => !!x);
    const oldChunks: OldChunk[] =
      P && existingIds.length
        ? await this.db.$queryRawUnsafe<OldChunk[]>(
            `SELECT "id", "documentId", "contentHash", "digitsMaskedHash", "headingPath", "title",
                    "url", "ugc", ("embedding" IS NOT NULL) AS "hasEmbedding", "embedModel"
               FROM ${this.C}
              WHERE "siteId" = $1 AND "accountId" = $2 AND "documentId" = ANY($3::text[])
                AND $4 = ANY("versions")
              ORDER BY "ordinal"`,
            ctx.siteId,
            ctx.accountId,
            existingIds,
            P,
          )
        : [];
    const oldByDoc = new Map<string, OldChunk[]>();
    for (const c of oldChunks) {
      const list = oldByDoc.get(c.documentId) ?? [];
      list.push(c);
      oldByDoc.set(c.documentId, list);
    }

    // Резка.
    const drafts = new Map<string, ChunkDraft[]>();
    const allHashes = new Set<string>();
    for (const u of plannable) {
      const key = docKey(u.sourceId, u.input.ref);
      let list: ChunkDraft[];
      if (u.input.kind === 'faq' && u.input.faq) {
        const variants = (u.input.faq.variants ?? []).filter((v) => v.trim());
        const question = variants.length
          ? `${u.input.faq.question} (${variants.join(' / ')})`
          : u.input.faq.question;
        list = [chunkFaq(question, u.input.faq.answer, u.input.lang ?? null)];
      } else {
        list = chunkBlocks(u.input.blocks, {
          minTokens: KNOWLEDGE_DEFAULTS.chunkMinTokens,
          maxTokens: KNOWLEDGE_DEFAULTS.chunkMaxTokens,
          overlapTokens: KNOWLEDGE_DEFAULTS.chunkOverlapTokens,
          lang: u.input.lang ?? null,
        });
      }
      list = list.filter((d) => !excludedHashes.has(d.contentHash));
      drafts.set(key, list);
      for (const d of list) allHashes.add(d.contentHash);
    }

    // Векторы на сайте по contentHash (та же модель) — копия без эмбеддинга.
    // Пачки одной сборки видят векторы предыдущих (они уже в базе).
    const vecByHash = new Map<string, string>();
    if (allHashes.size) {
      const rows = await this.db.$queryRawUnsafe<
        Array<{ id: string; contentHash: string }>
      >(
        `SELECT DISTINCT ON ("contentHash") "id", "contentHash" FROM ${this.C}
          WHERE "siteId" = $1 AND "accountId" = $2 AND "contentHash" = ANY($3::text[])
            AND "embedding" IS NOT NULL AND "embedModel" = $4
          ORDER BY "contentHash", "createdAt" DESC`,
        ctx.siteId,
        ctx.accountId,
        [...allHashes],
        KNOWLEDGE_DEFAULTS.embedModel,
      );
      for (const r of rows) vecByHash.set(r.contentHash, r.id);
    }

    // План по фрагментам.
    const work: DocWork[] = [];
    for (const u of plannable) {
      const key = docKey(u.sourceId, u.input.ref);
      const docId = docIdByKey.get(key) ?? null;
      const old = docId ? [...(oldByDoc.get(docId) ?? [])] : [];
      const claimed = new Set<string>();
      const keep: string[] = [];
      const fresh: NewChunk[] = [];
      let needTokens = 0;
      const url = u.input.url ?? null;
      const title = u.input.title ?? null;
      for (const d of drafts.get(key) ?? []) {
        const same = old.find(
          (c) =>
            !claimed.has(c.id) &&
            c.contentHash === d.contentHash &&
            c.headingPath === d.headingPath &&
            c.title === title &&
            c.url === url &&
            c.ugc === d.ugc,
        );
        if (same) {
          claimed.add(same.id);
          keep.push(same.id);
          continue;
        }
        const verdict = d.ugc
          ? { quarantine: false, reason: null }
          : detectInjection(d.text);
        const byHash = vecByHash.get(d.contentHash) ?? null;
        const byDigits = byHash
          ? null
          : (old.find(
              (c) =>
                c.digitsMaskedHash === d.digitsMaskedHash &&
                c.hasEmbedding &&
                c.embedModel === KNOWLEDGE_DEFAULTS.embedModel,
            )?.id ?? null);
        const nc: NewChunk = {
          documentKey: key,
          draft: d,
          sourceType: u.input.kind,
          url,
          title,
          quarantined: verdict.quarantine,
          quarantineReason: verdict.reason,
          copyFrom: byHash ?? byDigits,
          digitsOnly: !byHash && !!byDigits,
          vector: null,
        };
        if (!nc.quarantined && !nc.copyFrom)
          needTokens += estimateEmbedTokens(d.text);
        fresh.push(nc);
      }
      const changed = fresh.length > 0 || keep.length !== old.length || !docId;
      work.push({ u, key, docId, keep, fresh, needTokens, changed });
    }

    // Бюджет обучения — резерв ПАЧКИ.
    const model = KNOWLEDGE_DEFAULTS.embedModel;
    const tokens = work.reduce((s, w) => s + w.needTokens, 0);
    let est = 0;
    let active = work;
    if (tokens > 0) {
      const want = estimateCost(model, { inputTokens: tokens }).costMicroUsd;
      if (
        !st.budgetExhausted &&
        (await this.deps.budget.reserve(ctx.accountId, ctx.siteId, want))
      ) {
        est = Math.ceil(want);
        // Резерв виден в прогрессе ДО эмбеддинга: обрыв тика дальше — и
        // следующий тик (claim) или уборка (снятие сборки) его вернёт.
        st.outstandingMicroUsd += est;
        await this.versions.saveProgress(this.db, ctx, B, st);
      } else if (st.budgetPolicy === 'strict') {
        throw knowledgeError(
          'LEARNING_BUDGET_EXHAUSTED',
          'Бюджет обучения на этот месяц исчерпан — документ будет добавлен в следующем периоде',
        );
      } else {
        st.budgetExhausted = true;
        // §4-тер.11: при исчерпании — только «горячие страницы» (доставка,
        // оплата, цены — без них нет свежести, К-1). Их копейки
        // списываются по факту, без резерва: это осознанный перерасход.
        active = work.filter((w) => w.needTokens === 0 || w.u.hot);
        st.counts.deferred += work.length - active.length;
      }
    }
    outcome.budgetExhausted ||= st.budgetExhausted;

    // Эмбеддинги — до записи строк (сбой провайдера → сборка отброшена,
    // резерв возвращается из прогресса — abort).
    const toEmbed = active.flatMap((w) =>
      w.fresh.filter((f) => !f.quarantined && !f.copyFrom),
    );
    let embedded: { model: string; inputTokens: number } | null = null;
    if (toEmbed.length) {
      const r = await this.deps.embedder.embed(
        toEmbed.map((f) => f.draft.text),
        'document',
      );
      toEmbed.forEach((f, i) => (f.vector = r.vectors[i]));
      embedded = { model: r.model, inputTokens: r.inputTokens };
    } else if (est) {
      // Нечего эмбеддить (не бывает: резерв — только под эмбеддинг) — вернуть.
      await this.deps.budget.adjust(ctx.accountId, ctx.siteId, -est);
      st.outstandingMicroUsd -= est;
      est = 0;
    }

    // Запись пачки + курсор + закрытие резерва — одной транзакцией.
    const activeKeys = new Set(active.map((w) => w.key));
    for (const w of work) {
      if (!activeKeys.has(w.key) && w.docId) carry.push(w.docId);
    }
    const counts = { ...st.counts };
    const changedHashes = { ...st.changedHashes };
    let reusedHere = 0;
    await this.db.$transaction(
      async (tx) => {
        await this.carryDocs(tx, ctx, B, P, carry);
        for (const w of active) {
          const docId = await this.upsertDoc(tx, ctx, w.u, w.docId);
          if (!w.docId) counts.added++;
          else if (w.changed) {
            counts.changed++;
            changedHashes[w.u.docHash] = (changedHashes[w.u.docHash] ?? 0) + 1;
          }
          if (w.keep.length) {
            await tx.$executeRawUnsafe(
              `UPDATE ${this.C} SET "versions" = array_append("versions", $3), "updatedAt" = now()
                WHERE "siteId" = $1 AND "accountId" = $2 AND "id" = ANY($4::text[])
                  AND NOT ($3 = ANY("versions"))`,
              ctx.siteId,
              ctx.accountId,
              B,
              w.keep,
            );
          }
          for (const f of w.fresh) {
            await this.insertChunk(tx, ctx, docId, B, f);
            if (f.copyFrom) reusedHere++;
            if (f.quarantined) counts.quarantined++;
          }
        }
        counts.embedded += toEmbed.length;
        counts.reused += reusedHere;
        const next: BuildState = {
          ...st,
          cursor: st.cursor + slice.length,
          counts,
          changedHashes,
          outstandingMicroUsd: st.outstandingMicroUsd - est,
        };
        await this.versions.saveProgress(tx, ctx, B, next);
      },
      { maxWait: 10_000, timeout: BATCH_TX_TIMEOUT_MS },
    );
    st.cursor += slice.length;
    st.counts = counts;
    st.changedHashes = changedHashes;
    st.outstandingMicroUsd -= est;
    outcome.embedded += toEmbed.length;
    outcome.reused += reusedHere;
    // Факт — после записи: обрыв здесь оставит списанной оценку пачки
    // (деньги провайдеру уплачены), а не потерянный резерв.
    if (embedded) {
      await this.recordEmbed(ctx, embedded.model, embedded.inputTokens, est);
    }
  }

  /** Конец сборки: удаления, исключения, ворота → published | held. */
  private async complete(
    ctx: KnowledgeCtx,
    got: { number: number; parent: number },
    st: BuildState,
    byTelegramId: bigint | null,
    outcome: BuildOutcome,
  ): Promise<BuildOutcome> {
    const B = got.number;
    const removals = st.removals;
    for (const r of removals) {
      await this.db.$executeRawUnsafe(
        `UPDATE ${this.D}
            SET "status" = $4, "skipReason" = $5,
                "goneAt" = CASE WHEN $4 = 'gone' THEN now() ELSE "goneAt" END,
                "updatedAt" = now()
          WHERE "siteId" = $1 AND "accountId" = $2 AND "id" = $3`,
        ctx.siteId,
        ctx.accountId,
        r.documentId,
        r.status,
        r.skipReason ?? null,
      );
    }
    const c = st.counts;
    outcome.deferred = c.deferred;
    outcome.progress = { done: st.cursor, total: st.total };
    const anyChange =
      c.added + c.changed > 0 || removals.length > 0 || c.quarantined > 0;
    if (!anyChange && !st.forceVersion) {
      // Всё отложено бюджетом или совпало — версия не нужна.
      await this.abort(ctx, B);
      return outcome;
    }

    // Исключения, появившиеся за время сборки, — тоже не попадают.
    for (const ex of await this.exclusions(ctx)) {
      await this.deleteExcluded(ctx, ex);
    }
    const largestIdenticalGroup = Math.max(
      0,
      ...Object.values(st.changedHashes),
    );
    outcome.version = await this.finish(ctx, got, {
      trigger: st.trigger,
      byTelegramId,
      gated: st.gated,
      newQuarantined: c.quarantined,
      gone: st.gone ?? undefined,
      changedPages: c.changed,
      largestIdenticalGroup,
      stats: {
        added: c.added,
        removed: removals.length,
        changed: c.changed,
        embedded: c.embedded,
        reusedVectors: c.reused,
        deferred: c.deferred,
        quarantined: c.quarantined,
        ...(st.ticks > 1 ? { ticks: st.ticks } : {}),
      },
    });
    return outcome;
  }

  /** id существующих документов по ключам «источник␟ref». */
  private async existingDocs(
    db: RawDb,
    ctx: KnowledgeCtx,
    keys: string[],
  ): Promise<Map<string, string>> {
    if (!keys.length) return new Map();
    const rows = await db.$queryRawUnsafe<
      Array<{ id: string; sourceId: string; ref: string }>
    >(
      `SELECT "id", "sourceId", "ref" FROM ${this.D}
        WHERE "siteId" = $1 AND "accountId" = $2
          AND ("sourceId" || chr(31) || "ref") = ANY($3::text[])`,
      ctx.siteId,
      ctx.accountId,
      keys,
    );
    return new Map(rows.map((d) => [docKey(d.sourceId, d.ref), d.id]));
  }

  private async upsertDoc(
    db: RawDb,
    ctx: KnowledgeCtx,
    u: DocPlan,
    docId: string | null,
  ): Promise<string> {
    const i = u.input;
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO ${this.D} ("id", "accountId", "siteId", "sourceId", "ref", "kind", "url",
          "sitePageId", "title", "lang", "contentHash", "indexedHash", "status", "skipReason",
          "hot", "goneAt", "indexedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, 'active', NULL, $12, NULL, now(), now())
       ON CONFLICT ("sourceId", "ref") DO UPDATE SET
          "kind" = EXCLUDED."kind", "url" = EXCLUDED."url", "sitePageId" = EXCLUDED."sitePageId",
          "title" = EXCLUDED."title", "lang" = EXCLUDED."lang",
          "contentHash" = EXCLUDED."contentHash", "indexedHash" = EXCLUDED."indexedHash",
          "status" = 'active', "skipReason" = NULL, "hot" = EXCLUDED."hot", "goneAt" = NULL,
          "indexedAt" = now(), "updatedAt" = now()
       WHERE ${this.D}."siteId" = $3 AND ${this.D}."accountId" = $2
       RETURNING "id"`,
      docId ?? newRowId(),
      ctx.accountId,
      ctx.siteId,
      u.sourceId,
      i.ref,
      i.kind,
      i.url ?? null,
      i.sitePageId ?? null,
      i.title ?? null,
      i.lang ?? null,
      u.docHash,
      u.hot,
    );
    if (!rows[0]) {
      throw new Error(
        'Документ принадлежит другому сайту/кабинету — запись отклонена',
      );
    }
    return rows[0].id;
  }

  private async insertChunk(
    db: RawDb,
    ctx: KnowledgeCtx,
    documentId: string,
    number: number,
    f: NewChunk,
  ): Promise<void> {
    const d = f.draft;
    const common = [
      newRowId(),
      ctx.accountId,
      ctx.siteId,
      documentId,
      f.sourceType,
      f.url,
      f.title,
      d.headingPath,
      d.lang,
      d.ordinal,
      d.text,
      d.tokens,
      d.contentHash,
      d.digitsMaskedHash,
      number,
      d.ugc,
      f.quarantined,
      f.quarantineReason,
    ];
    const cols = `"id", "accountId", "siteId", "documentId", "sourceType", "url", "title",
        "headingPath", "lang", "ordinal", "text", "tokens", "contentHash", "digitsMaskedHash",
        "versions", "ugc", "quarantined", "quarantineReason", "embedModel", "embedding", "embeddedAt", "updatedAt"`;
    const head = `$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ARRAY[$15]::int[], $16, $17, $18`;
    if (f.copyFrom) {
      await db.$executeRawUnsafe(
        `INSERT INTO ${this.C} (${cols})
         SELECT ${head}, s."embedModel", s."embedding", s."embeddedAt", now()
           FROM ${this.C} s WHERE s."id" = $19 AND s."siteId" = $3 AND s."accountId" = $2`,
        ...common,
        f.copyFrom,
      );
      return;
    }
    await db.$executeRawUnsafe(
      `INSERT INTO ${this.C} (${cols})
       VALUES (${head}, $19, $20::"extensions"."vector", CASE WHEN $20::text IS NULL THEN NULL ELSE now() END, now())`,
      ...common,
      f.vector ? KNOWLEDGE_DEFAULTS.embedModel : null,
      f.vector ? toVectorLiteral(f.vector) : null,
    );
  }

  /** Языки фрагментов версии (карантин не считается — его нет в поиске). */
  private async langs(ctx: KnowledgeCtx, number: number) {
    if (!number) return langShares([]);
    const rows = await this.db.$queryRawUnsafe<
      Array<{ lang: string | null; n: number }>
    >(
      `SELECT "lang", count(*)::int AS n FROM ${this.C}
        WHERE "siteId" = $1 AND "accountId" = $2 AND $3 = ANY("versions") AND NOT "quarantined"
        GROUP BY "lang"`,
      ctx.siteId,
      ctx.accountId,
      number,
    );
    return langShares(rows);
  }

  private async invariantGate(
    ctx: KnowledgeCtx,
    number: number,
  ): Promise<InvariantEvalGate> {
    const answer = this.deps.answer;
    if (!this.hooks.invariantEval || !answer) {
      return { ran: false, note: 'отложен: ответчик не подключён' };
    }
    const model = GEMINI_MODEL;
    const est =
      estimateCost(model, EVAL_CASE_TOKENS).costMicroUsd *
      INVARIANT_CASES.length;
    if (!(await this.deps.budget.reserve(ctx.accountId, ctx.siteId, est))) {
      return { ran: false, note: 'отложен: нет бюджета обучения' };
    }
    try {
      const r = await runInvariantEval({
        search: async (question) =>
          this.store.search(
            { siteId: ctx.siteId, query: question, version: number },
            await this.queryVector(question, { ctx, operation: 'assist-eval' }),
          ),
        answer: (req) => answer.answer(req),
      });
      const used = await this.deps.usage.record(
        this.deps.sitesDb.forAccount(ctx.accountId),
        {
          accountId: ctx.accountId,
          siteId: ctx.siteId,
          operation: 'assist-eval',
          model: r.model ?? model,
          units: {
            inputTokens: r.inputTokens,
            cachedInputTokens: r.cachedInputTokens,
            outputTokens: r.outputTokens,
            calls: INVARIANT_CASES.length,
          },
        },
      );
      await this.deps.budget.adjust(
        ctx.accountId,
        ctx.siteId,
        used.costMicroUsd - est,
      );
      return {
        ran: true,
        failed: r.failed,
        total: r.passed + r.failed,
        failures: r.failures.map((f) => `${f.id}: ${f.reason}`),
      };
    } catch (e) {
      await this.deps.budget.adjust(ctx.accountId, ctx.siteId, -est);
      return {
        ran: false,
        note: `отложен: ответчик недоступен (${(e as Error).name})`,
      };
    }
  }

  /** Ворота → публикация или удержание; статистика версии. */
  private async finish(
    ctx: KnowledgeCtx,
    got: { number: number; parent: number },
    p: {
      trigger: VersionTrigger;
      byTelegramId: bigint | null;
      gated: boolean;
      stats: Record<string, unknown>;
      newQuarantined?: number;
      gone?: { previouslyPublishedPages: number; brokenPages: number };
      changedPages?: number;
      largestIdenticalGroup?: number;
    },
  ): Promise<VersionResult> {
    const B = got.number;
    const [newL, parentL] = await Promise.all([
      this.langs(ctx, B),
      this.langs(ctx, got.parent),
    ]);
    const totalRows = await this.db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ${this.C}
        WHERE "siteId" = $1 AND "accountId" = $2 AND $3 = ANY("versions")`,
      ctx.siteId,
      ctx.accountId,
      B,
    );
    const stats = {
      ...p.stats,
      chunks: newL.total,
      langs: newL.shares,
    };
    let report: GateReport | null = null;
    if (p.gated) {
      await this.versions.setStatusChecking(ctx, B);
      const coldStart = got.parent === 0;
      report = evaluateGates({
        coldStart,
        previouslyPublishedPages: p.gone?.previouslyPublishedPages ?? 0,
        brokenPages: p.gone?.brokenPages ?? 0,
        changedPages: p.changedPages ?? 0,
        largestIdenticalGroup: p.largestIdenticalGroup ?? 0,
        parentLangs: parentL.counts,
        newLangs: newL.counts,
        newQuarantined: p.newQuarantined ?? 0,
        totalChunks: totalRows[0]?.n ?? 0,
        invariantEval: coldStart ? null : await this.invariantGate(ctx, B),
      });
    }
    const quarantined = p.newQuarantined ?? 0;
    const suspectedHack = !!report?.checks.find(
      (c) => c.check === 'quarantine_share' && c.held,
    );

    let result: VersionResult;
    if (report?.held) {
      const reason = heldReasonText(report) ?? 'сработали ворота публикации';
      await this.versions.hold(ctx, B, { stats, gateReport: report, reason });
      result = { number: B, status: 'held', gateReport: report };
      if (this.hooks.onHeld) {
        try {
          await this.hooks.onHeld(ctx, { number: B, reason });
          await this.versions.markNotified(ctx, B);
        } catch (e) {
          this.logger.warn(
            `Уведомление об удержании не отправлено: ${(e as Error).message}`,
          );
        }
      }
    } else {
      const superseded = await this.versions.publish(ctx, B, {
        byTelegramId: p.byTelegramId,
        stats,
        gateReport: report,
      });
      await this.afterPublish(ctx, B, superseded);
      result = { number: B, status: 'published', gateReport: report };
    }
    if (quarantined > 0 && this.hooks.onQuarantine) {
      try {
        await this.hooks.onQuarantine(ctx, {
          count: quarantined,
          suspectedHack,
        });
      } catch (e) {
        this.logger.warn(
          `Тревога карантина не отправлена: ${(e as Error).message}`,
        );
      }
    }
    return result;
  }

  private async afterPublish(
    ctx: KnowledgeCtx,
    number: number,
    superseded: number[],
  ): Promise<void> {
    for (const n of superseded) {
      const v = await this.versions.get(ctx, n);
      const changed =
        v?.parentNumber != null
          ? await this.versions.changedDocs(ctx, v.parentNumber, n)
          : [];
      await this.versions.removeNumbers(ctx, [n]);
      await this.versions.resetDocs(ctx, changed);
    }
    await this.versions.prune(ctx);
    if (this.hooks.afterPublish) {
      try {
        await this.hooks.afterPublish(ctx, number);
      } catch (e) {
        this.logger.warn(
          `afterPublish режима не выполнен: ${(e as Error).message}`,
        );
      }
    }
  }
}
