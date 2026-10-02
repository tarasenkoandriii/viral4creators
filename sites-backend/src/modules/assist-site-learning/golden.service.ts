/**
 * Проверенные ответы — L (§4-тер.4, §4-тер.10, §4-тер.13): поверх FAQ Э1
 * (`ModeKnowledgeCore` — создание/правка/индексация — НЕ дублировать):
 * варианты, язык, источник, reviewAt (180 дней; 30 — если в ответе числа),
 * статусы, конфликт с сайтом, копирование в сайт того же кабинета и
 * endClient (origin=copied, без ссылки на оригинал). Каждый активный
 * проверенный ответ — кейс eval kind=golden (faqId), архив — кейс archived.
 * Права: чтение — assist: manager|operator; запись — manager/owner
 * (оператор — 403, §4-тер.15 п.14).
 *
 * Уточнения реализации (L):
 *  - строку и индекс создаёт/правит `ModeKnowledgeCore` (createFaq/patchFaq,
 *    публикация новой версии сразу — §4-тер.2 «действие человека»); поля Э3
 *    (origin, sourceRefs, reviewAt, variantRefs, fromConversationId)
 *    дописываются той же строке после — в индекс они не входят;
 *  - `needs_review` ставит/снимает этот код ПРЯМО в строке: документ
 *    остаётся в индексе (путь (3) §4-тер.4 — генерация рядом со свежими
 *    фрагментами), прямой путь виджета берёт только `active`;
 *  - варианты от посетителя (`variantRefs`) и вопрос/варианты с контактом
 *    или маской контакта — отказ GOLDEN_INVALID: знания всех посетителей
 *    не хранят ПДн одного (§4-тер.7);
 *  - источник (`sourceRefs`) — документ ЭТОГО сайта (страница/файл), не
 *    UGC; `chunkHash` — фрагмент этого документа без UGC, иначе отказ;
 *  - копирование: только активные/на пересмотре; варианты-цитаты
 *    посетителей и источники (документы другого сайта) не копируются;
 *    дубль — тот же вопрос (без регистра) у неархивного ответа цели.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LEARNING_DEFAULTS } from '../../config/assist-defaults';
import { SitesDb } from '../../prisma/sites-db.service';
import { KnowledgeBlobStorage } from '../assist-knowledge-core/documents/blob-storage';
import { ModeKnowledgeCore } from '../assist-knowledge-core/documents/mode-knowledge.core';
import { siteModeAdapter } from '../assist-site-knowledge/site-mode.adapter';
import { SiteKnowledgeService } from '../assist-site-knowledge/site-knowledge.service';
import { LearningBudget } from '../site-ai/learning-budget';
import type { AccountMembership } from '../site-core/account/roles';
import { HostAccessService } from '../site-core/ownership/host-access.service';
import { notFoundSite } from '../site-core/site-core.constants';
import { SiteCrawlService } from '../site-crawl/crawl.service';
import { PublicPageFetcher } from '../site-crawl/page-fetcher';
import type {
  GoldenCopyRequest,
  GoldenCopyResult,
  GoldenCreateRequest,
  GoldenPatchRequest,
  GoldenView,
} from './api-types';
import {
  GOLDEN_LIMITS,
  cleanText,
  hasContact,
  learningError,
  parseLang,
  parseVariants,
  requireAssistAny,
  requireManager,
} from './learning-common';

export type GoldenOrigin = GoldenView['origin'];
export type SourceRef = GoldenView['sourceRefs'][number];
export interface VariantRef {
  variant: string;
  conversationId: string;
}

/** Строка FAQ глазами L (все колонки Э1 + Э3). */
export interface GoldenRow {
  id: string;
  accountId: string;
  siteId: string;
  question: string;
  answer: string;
  variants: string[];
  lang: string | null;
  origin: string;
  sourceRefs: Prisma.JsonValue | null;
  status: string;
  approvedByTelegramId: bigint | null;
  approvedAt: Date | null;
  reviewAt: Date | null;
  conflictNote: string | null;
  fromConversationId: string | null;
  variantRefs: Prisma.JsonValue | null;
  documentId: string | null;
  updatedAt: Date;
}

/** Вход создания проверенного ответа изнутри L (очередь, кандидат, копия). */
export interface GoldenInput {
  question: string;
  answer: string;
  variants: string[];
  lang: string | null;
  origin: GoldenOrigin;
  sourceRefs: SourceRef[];
  variantRefs: VariantRef[];
  fromConversationId: string | null;
}

const ORIGINS: readonly GoldenOrigin[] = [
  'owner',
  'wizard',
  'gap',
  'operator_candidate',
  'copied',
];

/** Срок пересмотра (§4-тер.4): 30 дней, если в ответе числа, иначе 180. */
export function reviewAtFor(answer: string, now: Date): Date {
  const ms = /\d/.test(answer)
    ? LEARNING_DEFAULTS.reviewAfterWithNumbersMs
    : LEARNING_DEFAULTS.reviewAfterMs;
  return new Date(now.getTime() + ms);
}

/** sourceRefs из базы: и форма Э3, и черновики мастера Э2 (`{ url, title }`). */
export function parseSourceRefs(v: unknown): SourceRef[] {
  if (!Array.isArray(v)) return [];
  const out: SourceRef[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const s = (k: string) =>
      typeof o[k] === 'string' && (o[k] as string) ? (o[k] as string) : null;
    const ref = {
      documentId: s('documentId'),
      url: s('url'),
      chunkHash: s('chunkHash'),
    };
    if (ref.documentId || ref.url || ref.chunkHash) out.push(ref);
  }
  return out;
}

export function parseVariantRefs(v: unknown): VariantRef[] {
  if (!Array.isArray(v)) return [];
  const out: VariantRef[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    if (typeof o.variant === 'string' && typeof o.conversationId === 'string') {
      out.push({ variant: o.variant, conversationId: o.conversationId });
    }
  }
  return out;
}

export function goldenView(
  r: GoldenRow,
  m: { telegramId: bigint },
): GoldenView {
  const status = (['active', 'needs_review', 'archived'] as const).includes(
    r.status as GoldenView['status'],
  )
    ? (r.status as GoldenView['status'])
    : 'active';
  return {
    id: r.id,
    question: r.question,
    answer: r.answer,
    variants: r.variants,
    lang: r.lang,
    origin: ORIGINS.includes(r.origin as GoldenOrigin)
      ? (r.origin as GoldenOrigin)
      : 'owner',
    sourceRefs: parseSourceRefs(r.sourceRefs),
    status,
    conflictNote: r.conflictNote,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    approvedByMe:
      r.approvedByTelegramId !== null &&
      r.approvedByTelegramId === m.telegramId,
    reviewAt: r.reviewAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
  };
}

const json = (v: unknown): Prisma.InputJsonValue =>
  v as unknown as Prisma.InputJsonValue;

@Injectable()
export class GoldenAnswersService {
  now: () => Date = () => new Date();
  private readonly logger = new Logger(GoldenAnswersService.name);
  readonly core: ModeKnowledgeCore;

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly knowledge: SiteKnowledgeService,
    blob: KnowledgeBlobStorage,
    fetcher: PublicPageFetcher,
    hosts: HostAccessService,
    crawl: SiteCrawlService,
    budget: LearningBudget,
  ) {
    // Тот же адаптер «Сайта», что у маршрутов FAQ Э1 (K3): строка FAQ,
    // документ источника `faq`, новая опубликованная версия.
    this.core = new ModeKnowledgeCore(siteModeAdapter(sitesDb, knowledge), {
      db: sitesDb,
      blob,
      fetcher,
      hosts,
      crawl,
      budget,
    });
  }

  private db(accountId: string) {
    return this.sitesDb.forAccount(accountId);
  }

  async requireSite(m: AccountMembership, siteId: string) {
    const site = await this.db(m.accountId).site.findFirst({
      where: { id: siteId },
      select: { id: true, endClientId: true },
    });
    if (!site) throw notFoundSite();
    return site;
  }

  async row(accountId: string, siteId: string, id: string) {
    return (await this.db(accountId).assistSiteFaq.findFirst({
      where: { id, siteId },
    })) as GoldenRow | null;
  }

  private async requireGolden(
    m: AccountMembership,
    siteId: string,
    id: string,
  ): Promise<GoldenRow> {
    const r =
      typeof id === 'string' ? await this.row(m.accountId, siteId, id) : null;
    if (!r) {
      throw learningError(
        404,
        'GOLDEN_NOT_FOUND',
        'Проверенный ответ не найден',
      );
    }
    return r;
  }

  /**
   * Статус ответа сменился БЕЗ новой версии знаний (needs_review ↔ active):
   * ключ семантического кэша — версия, и прежний ответ отдавался бы ещё
   * сутки (§4-тер.7 «кэш сбрасывается»). Кэш — по siteId, вне тенанта.
   */
  async dropAnswerCache(siteId: string): Promise<void> {
    await this.sitesDb
      .system('сброс кэша ответов сайта: сменился статус проверенного ответа')
      .assistSiteSemanticCache.deleteMany({ where: { siteId } });
  }

  // ── проверка входа ───────────────────────────────────────────────────

  invalid(message: string) {
    return learningError(400, 'GOLDEN_INVALID', message);
  }

  /** Вопрос проверенного ответа: 1..500, без контактов/масок посетителя. */
  parseQuestion(v: unknown): string {
    const q = cleanText(v, GOLDEN_LIMITS.question);
    if (!q) throw this.invalid('Вопрос пустой или длиннее 500 символов');
    if (hasContact(q)) {
      throw this.invalid(
        'Уберите из вопроса контактные данные посетителя (телефон, e-mail, карту)',
      );
    }
    return q;
  }

  parseAnswer(v: unknown): string {
    const a = cleanText(v, GOLDEN_LIMITS.answer);
    if (!a) throw this.invalid('Ответ пустой или длиннее 5000 символов');
    return a;
  }

  parseVariantsOrThrow(v: unknown): string[] {
    const out = parseVariants(v);
    if (!out) {
      throw this.invalid(
        'Вариантов не больше 10, каждый до 500 символов и без контактных данных посетителя',
      );
    }
    return out;
  }

  parseLangOrThrow(v: unknown): string | null {
    const l = parseLang(v);
    if (l === undefined) throw this.invalid('Язык: uk, ru или en');
    return l;
  }

  /**
   * Источники: документ ЭТОГО сайта (не FAQ), фрагмент — его и без UGC
   * (§4-тер.7: отзыв посетителя не может подтверждать проверенный ответ).
   */
  async validateSourceRefs(
    accountId: string,
    siteId: string,
    v: unknown,
  ): Promise<SourceRef[]> {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > 5) {
      throw this.invalid('Источников — не больше 5');
    }
    const t = this.db(accountId);
    const out: SourceRef[] = [];
    for (const raw of v) {
      const ref = parseSourceRefs([raw])[0];
      if (!ref) throw this.invalid('Источник: documentId, url или chunkHash');
      const doc = await t.assistSiteDocument.findFirst({
        where: {
          siteId,
          kind: { not: 'faq' },
          ...(ref.documentId ? { id: ref.documentId } : { url: ref.url ?? '' }),
        },
        select: { id: true, url: true },
      });
      if (!doc && !(ref.chunkHash && !ref.documentId && !ref.url)) {
        throw this.invalid('Источник — не страница и не документ этого сайта');
      }
      let documentId = doc?.id ?? null;
      let url = doc?.url ?? null;
      if (ref.chunkHash) {
        const chunk = await t.assistSiteChunk.findFirst({
          where: {
            siteId,
            contentHash: ref.chunkHash,
            sourceType: { not: 'faq' },
            ...(documentId ? { documentId } : {}),
          },
          select: { ugc: true, documentId: true, url: true },
        });
        if (!chunk) throw this.invalid('Фрагмент источника не найден на сайте');
        if (chunk.ugc) {
          throw this.invalid(
            'Отзыв или комментарий посетителя не может быть источником проверенного ответа',
          );
        }
        documentId = chunk.documentId;
        url = url ?? chunk.url;
      }
      out.push({ documentId, url, chunkHash: ref.chunkHash ?? null });
    }
    return out;
  }

  // ── кейс eval проверенного ответа ───────────────────────────────────

  /** Кейс kind=golden: один на ответ (повторный вызов — обновляет). */
  async upsertGoldenCase(row: GoldenRow, status: 'active' | 'archived') {
    const t = this.db(row.accountId);
    const mustCite = [
      ...new Set(
        parseSourceRefs(row.sourceRefs)
          .map((r) => r.url)
          .filter((u): u is string => !!u),
      ),
    ];
    const existing = await t.assistSiteEvalCase.findFirst({
      where: { siteId: row.siteId, kind: 'golden', faqId: row.id },
      select: { id: true },
    });
    const data = {
      question: row.question,
      expected: row.answer,
      mustCite,
      lang: row.lang,
      status,
    };
    if (existing) {
      await t.assistSiteEvalCase.updateMany({
        where: { id: existing.id },
        data,
      });
      return existing.id;
    }
    const created = await t.assistSiteEvalCase.create({
      data: {
        ...data,
        accountId: row.accountId,
        siteId: row.siteId,
        kind: 'golden',
        mustNotSay: [],
        faqId: row.id,
      },
      select: { id: true },
    });
    return created.id;
  }

  // ── создание (кабинет и очередь) ─────────────────────────────────────

  /**
   * Новый проверенный ответ: строка + индекс (ModeKnowledgeCore.createFaq),
   * поля Э3, кейс eval. Права проверяет вызывающий.
   */
  async createGolden(
    m: AccountMembership,
    siteId: string,
    input: GoldenInput,
  ): Promise<{ row: GoldenRow; evalCaseId: string }> {
    const now = this.now();
    const created = await this.core.createFaq(
      m,
      siteId,
      {
        question: input.question,
        answer: input.answer,
        variants: input.variants,
        lang: input.lang ?? undefined,
      },
      now,
    );
    const t = this.db(m.accountId);
    await t.assistSiteFaq.updateMany({
      where: { id: created.id, siteId },
      data: {
        origin: input.origin,
        sourceRefs: input.sourceRefs.length
          ? json(input.sourceRefs)
          : Prisma.DbNull,
        variantRefs: input.variantRefs.length
          ? json(input.variantRefs)
          : Prisma.DbNull,
        fromConversationId: input.fromConversationId,
        reviewAt: reviewAtFor(input.answer, now),
        conflictNote: null,
      },
    });
    const row = (await this.row(m.accountId, siteId, created.id)) as GoldenRow;
    const evalCaseId = await this.upsertGoldenCase(row, 'active');
    return { row, evalCaseId };
  }

  /**
   * Ответ из очереди в СУЩЕСТВУЮЩИЙ проверенный ответ: новые варианты (с
   * цитатами посетителей — variantRefs) и, если дан, новый текст.
   */
  async extendGolden(
    m: AccountMembership,
    siteId: string,
    faqId: string,
    p: {
      answer: string | null;
      lang: string | null;
      variants: string[];
      variantRefs: VariantRef[];
    },
  ): Promise<{ row: GoldenRow; evalCaseId: string }> {
    const before = await this.requireGolden(m, siteId, faqId);
    if (before.status === 'archived') {
      throw this.invalid(
        'Ответ в архиве — восстановите его или создайте новый',
      );
    }
    const variants = [...before.variants];
    for (const v of p.variants) {
      if (!variants.some((x) => x.toLowerCase() === v.toLowerCase())) {
        variants.push(v);
      }
    }
    if (variants.length > GOLDEN_LIMITS.variants) {
      throw this.invalid('У ответа уже 10 вариантов — уберите лишние');
    }
    const refs = [...parseVariantRefs(before.variantRefs)];
    for (const r of p.variantRefs) {
      if (
        !refs.some(
          (x) =>
            x.variant === r.variant && x.conversationId === r.conversationId,
        )
      ) {
        refs.push(r);
      }
    }
    await this.applyPatch(m, siteId, before, {
      answer: p.answer ?? undefined,
      variants,
      variantRefs: refs,
      lang: p.lang ?? undefined,
    });
    const row = (await this.row(m.accountId, siteId, faqId)) as GoldenRow;
    const evalCaseId = await this.upsertGoldenCase(row, 'active');
    return { row, evalCaseId };
  }

  // ── маршруты ─────────────────────────────────────────────────────────

  async list(
    m: AccountMembership,
    siteId: string,
    q: { status: 'active' | 'needs_review' | 'archived' | 'all' },
  ): Promise<GoldenView[]> {
    requireAssistAny(m);
    await this.requireSite(m, siteId);
    const status = q?.status ?? 'all';
    const rows = (await this.db(m.accountId).assistSiteFaq.findMany({
      where: {
        siteId,
        ...(status === 'all' ? {} : { status }),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: 500,
    })) as GoldenRow[];
    return rows.map((r) => goldenView(r, m));
  }

  async create(
    m: AccountMembership,
    siteId: string,
    body: GoldenCreateRequest,
  ): Promise<GoldenView> {
    requireManager(m);
    await this.requireSite(m, siteId);
    const b = (body ?? {}) as unknown as Record<string, unknown>;
    const input: GoldenInput = {
      question: this.parseQuestion(b.question),
      answer: this.parseAnswer(b.answer),
      variants: this.parseVariantsOrThrow(b.variants),
      lang: this.parseLangOrThrow(b.lang),
      origin: 'owner',
      sourceRefs: await this.validateSourceRefs(
        m.accountId,
        siteId,
        b.sourceRefs,
      ),
      variantRefs: [],
      fromConversationId: null,
    };
    const { row } = await this.createGolden(m, siteId, input);
    return goldenView(row, m);
  }

  /**
   * Правка строки: текст и варианты — через ModeKnowledgeCore (одобрение и
   * индекс), поля Э3 — здесь. Правка текста = новое одобрение человеком:
   * needs_review снимается, срок пересмотра — заново.
   */
  private async applyPatch(
    m: AccountMembership,
    siteId: string,
    before: GoldenRow,
    p: {
      question?: string;
      answer?: string;
      variants?: string[];
      variantRefs?: VariantRef[];
      lang?: string | null;
    },
  ): Promise<void> {
    const now = this.now();
    const t = this.db(m.accountId);
    const textChanged =
      (p.question !== undefined && p.question !== before.question) ||
      (p.answer !== undefined && p.answer !== before.answer);
    const indexChanged =
      textChanged ||
      (p.variants !== undefined &&
        p.variants.join('\n') !== before.variants.join('\n')) ||
      (p.lang !== undefined && p.lang !== before.lang);
    if (textChanged && before.status === 'needs_review') {
      // Снять пересмотр ДО правки ядра: ядро переиндексирует только active.
      await t.assistSiteFaq.updateMany({
        where: { id: before.id, siteId },
        data: { status: 'active' },
      });
    }
    if (indexChanged) {
      await this.core.patchFaq(
        m,
        siteId,
        before.id,
        {
          ...(p.question !== undefined ? { question: p.question } : {}),
          ...(p.answer !== undefined ? { answer: p.answer } : {}),
          ...(p.variants !== undefined ? { variants: p.variants } : {}),
          ...(p.lang !== undefined && p.lang !== null ? { lang: p.lang } : {}),
        },
        now,
      );
      if (!textChanged && before.status === 'needs_review') {
        // Варианты у ответа на пересмотре: ядро его не переиндексирует, а
        // он остаётся в поиске (путь (3)) — индекс должен совпасть со строкой.
        await this.core.reindexFaq(
          { accountId: m.accountId, siteId },
          before.id,
          m.telegramId,
        );
      }
    }
    const variants = p.variants ?? before.variants;
    const refs = (p.variantRefs ?? parseVariantRefs(before.variantRefs)).filter(
      (r) => variants.includes(r.variant),
    );
    const answer = p.answer ?? before.answer;
    await t.assistSiteFaq.updateMany({
      where: { id: before.id, siteId },
      data: {
        variantRefs: refs.length ? json(refs) : Prisma.DbNull,
        ...(p.lang === null ? { lang: null } : {}),
        ...(textChanged
          ? {
              status: 'active',
              conflictNote: null,
              reviewAt: reviewAtFor(answer, now),
              approvedByTelegramId: m.telegramId,
              approvedAt: now,
            }
          : {}),
      },
    });
  }

  async patch(
    m: AccountMembership,
    siteId: string,
    goldenId: string,
    body: GoldenPatchRequest,
  ): Promise<GoldenView> {
    requireManager(m);
    await this.requireSite(m, siteId);
    const before = await this.requireGolden(m, siteId, goldenId);
    const b = (body ?? {}) as unknown as Record<string, unknown>;
    const p: Parameters<GoldenAnswersService['applyPatch']>[3] = {};
    if (b.question !== undefined) p.question = this.parseQuestion(b.question);
    if (b.answer !== undefined) p.answer = this.parseAnswer(b.answer);
    if (b.variants !== undefined) {
      // Варианты-цитаты посетителей, которые уже есть, — не «новый контакт»:
      // их форма прошла проверку при принятии из очереди.
      p.variants = this.parseVariantsOrThrow(b.variants);
    }
    if (b.lang !== undefined) p.lang = this.parseLangOrThrow(b.lang);
    const status = b.status;
    if (status !== undefined && status !== 'active' && status !== 'archived') {
      throw this.invalid('Статус: active или archived');
    }
    if (b.reviewed !== undefined && typeof b.reviewed !== 'boolean') {
      throw this.invalid('reviewed — true или false');
    }

    if (status === 'archived') {
      if (Object.keys(p).length || b.reviewed === true) {
        throw this.invalid('Архивировать — отдельным действием, без правок');
      }
      await this.archive(m, siteId, goldenId);
      return goldenView(
        (await this.row(m.accountId, siteId, goldenId)) as GoldenRow,
        m,
      );
    }

    let current = before;
    if (status === 'active' && before.status === 'archived') {
      // Восстановление из архива: ядро вернёт документ в индекс.
      await this.core.patchFaq(
        m,
        siteId,
        goldenId,
        { status: 'active' },
        this.now(),
      );
      await this.db(m.accountId).assistSiteFaq.updateMany({
        where: { id: goldenId, siteId },
        data: {
          reviewAt: reviewAtFor(before.answer, this.now()),
          conflictNote: null,
        },
      });
      current = (await this.row(m.accountId, siteId, goldenId)) as GoldenRow;
    } else if (
      before.status === 'archived' &&
      (Object.keys(p).length || b.reviewed === true)
    ) {
      throw this.invalid('Ответ в архиве — сначала восстановите его');
    }

    if (Object.keys(p).length) {
      await this.applyPatch(m, siteId, current, p);
      current = (await this.row(m.accountId, siteId, goldenId)) as GoldenRow;
    }

    // «Сделать активным» ответ на пересмотре — то же, что «проверено, верно».
    const reviewed =
      b.reviewed === true ||
      (status === 'active' && current.status === 'needs_review');
    if (reviewed) {
      // «Проверено, верно»: снять пересмотр, источник «запомнить» в
      // нынешнем виде (иначе тот же конфликт вернулся бы следующей ночью).
      const now = this.now();
      const refs = await this.currentRefs(m.accountId, siteId, current);
      await this.db(m.accountId).assistSiteFaq.updateMany({
        where: { id: goldenId, siteId },
        data: {
          status: 'active',
          conflictNote: null,
          reviewAt: reviewAtFor(current.answer, now),
          approvedByTelegramId: m.telegramId,
          approvedAt: now,
          sourceRefs: refs.length ? json(refs) : Prisma.DbNull,
        },
      });
      if (current.status !== 'active') await this.dropAnswerCache(siteId);
      current = (await this.row(m.accountId, siteId, goldenId)) as GoldenRow;
    }
    await this.upsertGoldenCase(current, 'active');
    return goldenView(current, m);
  }

  /**
   * Источники ответа «как на сайте сейчас»: фрагмент, которого больше нет в
   * опубликованной версии, заменяется самым похожим на ответ фрагментом той
   * же страницы (или снимается, если страницы нет).
   */
  async currentRefs(
    accountId: string,
    siteId: string,
    row: Pick<GoldenRow, 'answer' | 'sourceRefs'>,
  ): Promise<SourceRef[]> {
    const refs = parseSourceRefs(row.sourceRefs);
    if (!refs.length) return [];
    const t = this.db(accountId);
    const a = await t.assistSite.findFirst({
      where: { siteId },
      select: { knowledgeVersion: true },
    });
    const v = a?.knowledgeVersion ?? 0;
    const out: SourceRef[] = [];
    for (const ref of refs) {
      const chunks = await t.assistSiteChunk.findMany({
        where: {
          siteId,
          versions: { has: v },
          quarantined: false,
          ugc: false,
          ...(ref.documentId
            ? { documentId: ref.documentId }
            : ref.url
              ? { url: ref.url }
              : { contentHash: ref.chunkHash ?? '' }),
        },
        select: { contentHash: true, text: true, documentId: true, url: true },
        take: 50,
      });
      if (!chunks.length) continue;
      const same = chunks.find((c) => c.contentHash === ref.chunkHash);
      const best = same ?? closestChunk(row.answer, chunks);
      out.push({
        documentId: best.documentId,
        url: best.url ?? ref.url,
        chunkHash: best.contentHash,
      });
    }
    return out;
  }

  async archive(
    m: AccountMembership,
    siteId: string,
    goldenId: string,
  ): Promise<void> {
    requireManager(m);
    await this.requireSite(m, siteId);
    const before = await this.requireGolden(m, siteId, goldenId);
    if (before.status !== 'archived') {
      // Ядро уберёт документ из индекса (новая версия без него).
      await this.core.patchFaq(
        m,
        siteId,
        goldenId,
        { status: 'archived' },
        this.now(),
      );
    }
    await this.db(m.accountId).assistSiteEvalCase.updateMany({
      where: { siteId, kind: 'golden', faqId: goldenId },
      data: { status: 'archived' },
    });
  }

  async copyTo(
    m: AccountMembership,
    siteId: string,
    targetSiteId: string,
    body: GoldenCopyRequest,
  ): Promise<GoldenCopyResult> {
    requireManager(m);
    const src = await this.requireSite(m, siteId);
    const forbidden = () =>
      learningError(
        403,
        'COPY_TARGET_FORBIDDEN',
        'Копировать можно только в другой сайт этого кабинета и того же клиента',
      );
    if (typeof targetSiteId !== 'string' || targetSiteId === siteId) {
      throw forbidden();
    }
    const target = await this.db(m.accountId).site.findFirst({
      where: { id: targetSiteId },
      select: { id: true, endClientId: true },
    });
    // Чужой кабинет и другой конечный клиент — один отказ (не оракул).
    if (!target || (target.endClientId ?? null) !== (src.endClientId ?? null)) {
      throw forbidden();
    }
    const ids = (body as { ids?: unknown } | null)?.ids;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > GOLDEN_LIMITS.copyIds ||
      ids.some((x) => typeof x !== 'string' || !x || x.length > 64)
    ) {
      throw this.invalid('Укажите от 1 до 50 проверенных ответов');
    }
    const t = this.db(m.accountId);
    const existing = await t.assistSiteFaq.findMany({
      where: { siteId: targetSiteId, status: { not: 'archived' } },
      select: { question: true },
    });
    const taken = new Set(existing.map((e) => e.question.trim().toLowerCase()));
    const result: GoldenCopyResult = { copied: 0, skipped: [] };
    for (const id of [...new Set(ids as string[])]) {
      const row = await this.row(m.accountId, siteId, id);
      if (!row || row.status === 'archived') {
        result.skipped.push({ id, reason: 'not_found' });
        continue;
      }
      const key = row.question.trim().toLowerCase();
      if (taken.has(key)) {
        result.skipped.push({ id, reason: 'duplicate' });
        continue;
      }
      // Цитаты посетителей (variantRefs) остаются у оригинала: копия жила
      // бы вне хвоста forget сайта-источника. Источники — документы
      // ДРУГОГО сайта, в копии им не место.
      const quoted = new Set(
        parseVariantRefs(row.variantRefs).map((r) => r.variant),
      );
      await this.createGolden(m, targetSiteId, {
        question: row.question,
        answer: row.answer,
        variants: row.variants.filter((v) => !quoted.has(v)),
        lang: row.lang,
        origin: 'copied',
        sourceRefs: [],
        variantRefs: [],
        fromConversationId: null,
      });
      taken.add(key);
      result.copied++;
    }
    this.logger.log(
      `копирование проверенных ответов: ${siteId} → ${targetSiteId}, ${result.copied}`,
    );
    return result;
  }
}

/** Фрагмент, больше всего похожий на ответ (общие слова) — при равенстве первый. */
export function closestChunk<T extends { text: string }>(
  answer: string,
  chunks: T[],
): T {
  const words = (s: string) =>
    new Set(
      (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((w) =>
        w.slice(0, 6),
      ),
    );
  const a = words(answer);
  let best = chunks[0];
  let bestScore = -1;
  for (const c of chunks) {
    const w = words(c.text);
    let s = 0;
    for (const x of a) if (w.has(x)) s++;
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}
