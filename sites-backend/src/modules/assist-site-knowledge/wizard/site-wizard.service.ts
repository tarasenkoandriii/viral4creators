/**
 * Мастер «Научите помощника» — W5 (ТЗ §4-тер.9; приёмка §4-тер.15 п.6).
 *  - start: строка assist_site_wizards (тип бизнеса — из сводки сайта или
 *    выбор владельца), сводка — построить, если нет/устарела;
 *  - runDrafts: для каждой темы — поиск «Сайта» (SiteKnowledgeService.search)
 *    + ответ по фрагментам (AnswerEngine, Э1) → черновик с источником; нет
 *    на сайте — пустое поле. Платит платформа (≤ WIZARD_DEFAULTS.maxDraftRuns,
 *    потолок прогона runCapMicroUsd), учёт `assist-learn`;
 *  - answer: «Да» / исправить / пропустить;
 *  - complete: golden → проверенные ответы origin = 'wizard' тем же путём, что
 *    FAQ Э1 (строка assist_site_faq + indexDocuments, сразу публикуется);
 *    persona_forbid / handoff_rule → в ЧЕРНОВИК персоны (assist_sites.
 *    personaDraft, публикует владелец экраном персоны); страницы источников
 *    черновиков → «горячие» (≤ 10, §4-тер.2).
 * Права: productRoles.assist = manager.
 *
 * Загрузка прайса и условий (§4-тер.9 п.4) — тем же путём, что §3.4:
 * файловые источники Э1 (`POST …/learning/site/sources`); мастер их не
 * дублирует, а полнота подсказывает `add_documents`, пока файлов нет.
 *
 * Язык вопросов — язык базы сайта (uk/ru/en; иначе en): вопрос мастера
 * становится вопросом проверенного ответа и запросом поиска черновика.
 * UGC не идёт ни в черновики, ни в сводку, ни в источники ответа (§4-тер.7).
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WIZARD_DEFAULTS } from '../../../config/assist-defaults';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { estimateCost } from '../../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../../shared/gemini-model';
import { AnswerEngine } from '../../assist-knowledge-core/answer/answer-engine';
import { INVARIANT_CASES } from '../../assist-knowledge-core/eval/invariant-cases';
import { qualified } from '../../assist-knowledge-core/tables';
import type {
  DocumentInput,
  GateReport,
  KnowledgeCtx,
} from '../../assist-knowledge-core/types';
import { knowledgeError } from '../../assist-knowledge-core/versions';
import {
  defaultPersona,
  parsePersona,
  PERSONA_LIMITS,
  type PersonaConfig,
} from '../../assist-site-setup/persona';
import { LearningBudget } from '../../site-ai/learning-budget';
import { GeminiText } from '../../site-ai/text-model';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import type { AccountMembership } from '../../site-core/account/roles';
import { notFoundSite } from '../../site-core/site-core.constants';
import { SiteKnowledgeService } from '../site-knowledge.service';
import { SITE_TABLES } from '../site-tables';
import { generateSiteSummary, parseSiteSummary } from './site-summary';
import { wizardTopics, type WizardLang } from './wizard-topics';
import {
  WIZARD_BUSINESS_TYPES,
  type CompletenessView,
  type SiteSummary,
  type WizardBusinessType,
  type WizardItemView,
  type WizardTopic,
  type WizardView,
} from './wizard-types';

/** Ответ владельца на тему — как проверенный ответ (CreateFaqDto Э1). */
export const WIZARD_ANSWER_MAX = 5000;
/** Горячих страниц на сайт (§4-тер.2). */
export const HOT_PAGES_MAX = 10;
/** Оценка одного черновика: промпт с 6 фрагментами + ответ. */
const DRAFT_EST_UNITS = { inputTokens: 3_000, outputTokens: 400 };
/** Оценка сводки: ≈ 12 тыс. символов данных + JSON. */
const SUMMARY_EST_UNITS = { inputTokens: 5_000, outputTokens: 700 };
/** Фрагментов в сводку (по одному на документ, по порядку страниц). */
const SUMMARY_SEEDS = 24;

type ItemStatus = WizardItemView['status'];

interface WizardRow {
  siteId: string;
  accountId: string;
  businessType: string;
  items: Prisma.JsonValue;
  status: string;
  draftRuns: number;
  spentMicroUsd: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asBusinessType(v: unknown): WizardBusinessType | null {
  return typeof v === 'string' &&
    (WIZARD_BUSINESS_TYPES as readonly string[]).includes(v)
    ? (v as WizardBusinessType)
    : null;
}

const STATUSES: readonly ItemStatus[] = [
  'pending',
  'confirmed',
  'edited',
  'skipped',
  'saved',
];

/** Строки items из базы — строго (JSON мог править кто угодно с SQL). */
function parseItems(v: unknown): WizardItemView[] {
  if (!Array.isArray(v)) return [];
  const out: WizardItemView[] = [];
  for (const x of v) {
    if (!isObj(x) || typeof x.topic !== 'string') continue;
    const status = STATUSES.includes(x.status as ItemStatus)
      ? (x.status as ItemStatus)
      : 'pending';
    out.push({
      topic: x.topic as WizardTopic,
      question: typeof x.question === 'string' ? x.question : '',
      target:
        x.target === 'persona_forbid' || x.target === 'handoff_rule'
          ? x.target
          : 'golden',
      draft: typeof x.draft === 'string' ? x.draft : null,
      draftSources: Array.isArray(x.draftSources)
        ? x.draftSources.filter(isObj).map((s) => ({
            url: typeof s.url === 'string' ? s.url : null,
            title: typeof s.title === 'string' ? s.title : null,
          }))
        : [],
      answer: typeof x.answer === 'string' ? x.answer : null,
      status,
      faqId: typeof x.faqId === 'string' ? x.faqId : null,
    });
  }
  return out;
}

/** Текст владельца: без управляющих символов (кроме перевода строки). */
function cleanAnswer(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, '')
    .trim();
}

/** Правила персоны из ответа: по одному в строке (или через «;»). */
export function personaLines(answer: string): string[] {
  return answer
    .split(/[\n;]+/)
    .map((x) => x.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

/** Маркеры источников [S1] из ответа модели — черновик показывается текстом. */
function stripMarkers(s: string): string {
  return s
    .replace(/\s*\[S\d+\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

@Injectable()
export class SiteWizardService {
  private readonly logger = new Logger(SiteWizardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesDb: SitesDb,
    private readonly knowledge: SiteKnowledgeService,
    private readonly answers: AnswerEngine,
    private readonly text: GeminiText,
    private readonly usage: AiUsageRecorder,
    private readonly budget: LearningBudget,
  ) {}

  // ── общее ─────────────────────────────────────────────────────────────

  private db(m: AccountMembership) {
    return this.sitesDb.forAccount(m.accountId);
  }

  private async requireSite(m: AccountMembership, siteId: string) {
    const site = await this.db(m).site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!site) throw notFoundSite();
  }

  private async row(
    m: AccountMembership,
    siteId: string,
  ): Promise<WizardRow | null> {
    return this.db(m).assistSiteWizard.findFirst({ where: { siteId } });
  }

  private async requireRow(
    m: AccountMembership,
    siteId: string,
  ): Promise<WizardRow> {
    const r = await this.row(m, siteId);
    if (!r) {
      throw knowledgeError(
        'WIZARD_NOT_STARTED',
        'Мастер ещё не запущен — начните с выбора типа бизнеса',
      );
    }
    return r;
  }

  private async summaryOf(
    m: AccountMembership,
    siteId: string,
  ): Promise<SiteSummary | null> {
    const a = await this.db(m).assistSite.findFirst({
      where: { siteId },
      select: { siteSummary: true },
    });
    return a?.siteSummary ? parseSiteSummary(a.siteSummary) : null;
  }

  private view(r: WizardRow, summary: SiteSummary | null): WizardView {
    return {
      siteId: r.siteId,
      businessType: asBusinessType(r.businessType) ?? 'shop',
      status: r.status === 'done' ? 'done' : 'in_progress',
      items: parseItems(r.items),
      draftRunsLeft: Math.max(0, WIZARD_DEFAULTS.maxDraftRuns - r.draftRuns),
      siteSummary: summary,
    };
  }

  private async save(
    m: AccountMembership,
    siteId: string,
    data: Prisma.AssistSiteWizardUpdateManyMutationInput,
  ): Promise<void> {
    await this.db(m).assistSiteWizard.updateMany({ where: { siteId }, data });
  }

  /** Опубликованная версия и язык её фрагментов (uk/ru/en; иначе en). */
  private async base(
    ctx: KnowledgeCtx,
  ): Promise<{ version: number; lang: WizardLang }> {
    const a = await this.prisma.$queryRawUnsafe<{ knowledgeVersion: number }[]>(
      `SELECT "knowledgeVersion" FROM ${qualified(SITE_TABLES.settings)}
        WHERE "siteId" = $1 AND "accountId" = $2`,
      ctx.siteId,
      ctx.accountId,
    );
    const version = a[0]?.knowledgeVersion ?? 0;
    if (!version) return { version, lang: 'uk' };
    const rows = await this.prisma.$queryRawUnsafe<{ lang: string | null }[]>(
      `SELECT "lang" FROM ${qualified(SITE_TABLES.chunks)}
        WHERE "siteId" = $1 AND "accountId" = $2 AND $3 = ANY("versions")
          AND NOT "quarantined" AND NOT "ugc"
        GROUP BY "lang" ORDER BY count(*) DESC LIMIT 1`,
      ctx.siteId,
      ctx.accountId,
      version,
    );
    const l = rows[0]?.lang;
    return {
      version,
      lang: l === 'uk' || l === 'ru' || l === 'en' ? l : 'en',
    };
  }

  // ── сводка сайта ──────────────────────────────────────────────────────

  /**
   * Сводка по опубликованной версии (бюджет обучения, `assist-learn`).
   * Уже есть для этой версии / базы нет / бюджета нет / модель дала
   * негодное — без записи (null — «сводки нет», это не ошибка мастера).
   */
  async refreshSummary(ctx: KnowledgeCtx): Promise<SiteSummary | null> {
    const t = this.sitesDb.forAccount(ctx.accountId);
    const a = await t.assistSite.findFirst({
      where: { siteId: ctx.siteId },
      select: {
        knowledgeVersion: true,
        siteSummary: true,
        siteSummaryVersion: true,
      },
    });
    if (!a || !a.knowledgeVersion) return null;
    const current = a.siteSummary ? parseSiteSummary(a.siteSummary) : null;
    if (current && a.siteSummaryVersion === a.knowledgeVersion) return current;

    // По одному фрагменту с документа: разделы, контакты, «о нас».
    const seeds = await this.prisma.$queryRawUnsafe<
      Array<{
        url: string | null;
        title: string | null;
        headingPath: string | null;
        text: string;
      }>
    >(
      `SELECT DISTINCT ON ("documentId") "url", "title", "headingPath", "text"
         FROM ${qualified(SITE_TABLES.chunks)}
        WHERE "siteId" = $1 AND "accountId" = $2 AND $3 = ANY("versions")
          AND NOT "quarantined" AND NOT "ugc"
        ORDER BY "documentId", "ordinal"
        LIMIT $4`,
      ctx.siteId,
      ctx.accountId,
      a.knowledgeVersion,
      SUMMARY_SEEDS,
    );
    if (!seeds.length) return current;
    const est = estimateCost(GEMINI_MODEL, SUMMARY_EST_UNITS).costMicroUsd;
    if (!(await this.budget.reserve(ctx.accountId, ctx.siteId, est))) {
      return current;
    }
    let actual = 0;
    try {
      const { summary, usage } = await generateSiteSummary(this.text, seeds);
      const r = await this.usage.record(t, {
        accountId: ctx.accountId,
        siteId: ctx.siteId,
        operation: 'assist-learn',
        model: usage.model,
        units: {
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
        },
      });
      actual = r.costMicroUsd;
      if (!summary) {
        this.logger.warn(
          `Сводка сайта ${ctx.siteId} отклонена проверкой (императив/URL/формат)`,
        );
        return current;
      }
      await t.assistSite.updateMany({
        where: { siteId: ctx.siteId },
        data: {
          siteSummary: summary as unknown as Prisma.InputJsonValue,
          siteSummaryVersion: a.knowledgeVersion,
        },
      });
      return summary;
    } catch (e) {
      this.logger.warn(
        `Сводка сайта ${ctx.siteId} не построена: ${(e as Error).name}`,
      );
      return current;
    } finally {
      await this.budget.adjust(ctx.accountId, ctx.siteId, actual - est);
    }
  }

  // ── маршруты ──────────────────────────────────────────────────────────

  async get(m: AccountMembership, siteId: string): Promise<WizardView> {
    await this.requireSite(m, siteId);
    const r = await this.requireRow(m, siteId);
    return this.view(r, await this.summaryOf(m, siteId));
  }

  async start(
    m: AccountMembership,
    siteId: string,
    businessType: WizardBusinessType | null,
  ): Promise<WizardView> {
    await this.requireSite(m, siteId);
    const ctx = { accountId: m.accountId, siteId };
    await this.knowledge.ensureSettings(ctx);
    const summary = await this.refreshSummary(ctx);
    const type =
      businessType ??
      asBusinessType(summary?.businessType) ??
      asBusinessType((await this.row(m, siteId))?.businessType) ??
      'shop';
    const { lang } = await this.base(ctx);
    const existing = await this.row(m, siteId);
    const old = new Map(
      parseItems(existing?.items).map((i) => [i.topic, i] as const),
    );
    // Смена типа — новый набор тем; ответы на общие темы сохраняются.
    const items: WizardItemView[] = wizardTopics(type).map((d) => {
      const prev = old.get(d.topic);
      return prev
        ? { ...prev, target: d.target }
        : {
            topic: d.topic,
            question: d.question[lang],
            target: d.target,
            draft: null,
            draftSources: [],
            answer: null,
            status: 'pending',
            faqId: null,
          };
    });
    const json = items as unknown as Prisma.InputJsonValue;
    if (existing) {
      await this.save(m, siteId, {
        businessType: type,
        items: json,
        status: 'in_progress',
        completedAt: null,
      });
    } else {
      try {
        await this.db(m).assistSiteWizard.create({
          data: {
            accountId: m.accountId,
            siteId,
            businessType: type,
            items: json,
          },
        });
      } catch (e) {
        // Двойное нажатие «Начать» — строка уже есть, отдаём её.
        if (!(
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        )) {
          throw e;
        }
      }
    }
    return this.view(await this.requireRow(m, siteId), summary);
  }

  async runDrafts(m: AccountMembership, siteId: string): Promise<WizardView> {
    await this.requireSite(m, siteId);
    const r = await this.requireRow(m, siteId);
    const ctx = { accountId: m.accountId, siteId };
    const summary = await this.summaryOf(m, siteId);
    const { version, lang } = await this.base(ctx);
    // Базы ещё нет (обход идёт) — искать негде: прогон не тратится.
    if (!version) return this.view(r, summary);
    // Прогон «занимается» условным UPDATE: два параллельных нажатия не
    // проведут больше прогонов, чем положено.
    const took = await this.db(m).assistSiteWizard.updateMany({
      where: {
        siteId,
        draftRuns: { lt: WIZARD_DEFAULTS.maxDraftRuns },
      },
      data: { draftRuns: { increment: 1 } },
    });
    if (took.count !== 1) {
      throw knowledgeError(
        'WIZARD_DRAFT_LIMIT',
        'Черновики по сайту уже собраны максимальное число раз — ответьте на вопросы сами',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const items = parseItems(r.items);
    const defs = new Map(
      wizardTopics(asBusinessType(r.businessType) ?? 'shop').map(
        (d) => [d.topic, d] as const,
      ),
    );
    const est = estimateCost(GEMINI_MODEL, DRAFT_EST_UNITS).costMicroUsd;
    let spent = 0;
    for (const item of items) {
      // Ответ владельца не перезаписывается; запреты и правила передачи
      // на сайте не ищутся (это решение владельца, а не факт страницы).
      if (item.target !== 'golden') continue;
      if (!['pending', 'skipped'].includes(item.status)) continue;
      if (spent + est > WIZARD_DEFAULTS.runCapMicroUsd) break;
      const question = defs.get(item.topic)?.question[lang] ?? item.question;
      try {
        const hits = (
          await this.knowledge.search({
            siteId,
            query: question,
            includeUgc: false,
          })
        ).filter((h) => !h.ugc);
        const res = await this.answers.answer({ question, hits, lang });
        if (res.model) {
          const u = await this.usage.record(this.db(m), {
            accountId: m.accountId,
            siteId,
            operation: 'assist-learn',
            model: res.model,
            units: {
              inputTokens: res.inputTokens,
              cachedInputTokens: res.cachedInputTokens,
              outputTokens: res.outputTokens,
            },
          });
          spent += u.costMicroUsd;
        }
        const ok = !res.refused && res.sources.length > 0;
        item.draft = ok ? stripMarkers(res.text) || null : null;
        item.draftSources = ok
          ? res.sources.map((s) => ({ url: s.url, title: s.title }))
          : [];
      } catch (e) {
        // Сбой модели — черновик пустой (владелец ответит сам), прогон идёт дальше.
        this.logger.warn(
          `Черновик мастера (${item.topic}) не получен: ${(e as Error).name}`,
        );
      }
    }
    await this.save(m, siteId, {
      items: items as unknown as Prisma.InputJsonValue,
      spentMicroUsd: { increment: Math.round(spent) },
    });
    return this.view(await this.requireRow(m, siteId), summary);
  }

  async answer(
    m: AccountMembership,
    siteId: string,
    topic: WizardTopic,
    body: { status: 'confirmed' | 'edited' | 'skipped'; answer?: string },
  ): Promise<WizardView> {
    await this.requireSite(m, siteId);
    const r = await this.requireRow(m, siteId);
    const items = parseItems(r.items);
    const item = items.find((i) => i.topic === topic);
    if (!item) {
      throw knowledgeError(
        'BAD_REQUEST',
        'Такой темы нет в наборе мастера',
        HttpStatus.BAD_REQUEST,
      );
    }
    const text = cleanAnswer(body.answer ?? '');
    let answer: string | null;
    if (body.status === 'skipped') {
      answer = null;
    } else if (body.status === 'confirmed') {
      // «Да» — черновик по сайту как есть.
      answer = item.draft ? cleanAnswer(item.draft) : null;
      if (!answer) {
        throw knowledgeError(
          'BAD_REQUEST',
          'Подтверждать нечего: черновика по сайту нет — впишите ответ',
          HttpStatus.BAD_REQUEST,
        );
      }
    } else {
      if (!text || text.length > WIZARD_ANSWER_MAX) {
        throw knowledgeError(
          'BAD_REQUEST',
          `Ответ пустой или длиннее ${WIZARD_ANSWER_MAX} символов`,
          HttpStatus.BAD_REQUEST,
        );
      }
      answer = text;
    }
    if (answer && item.target !== 'golden') {
      const L = PERSONA_LIMITS;
      const lines = personaLines(answer);
      const [maxItems, maxLen] =
        item.target === 'persona_forbid'
          ? [L.forbiddenTopics, L.forbiddenTopic]
          : [L.handoffTriggers, L.handoffTrigger];
      if (
        !lines.length ||
        lines.length > maxItems ||
        lines.some((x) => Array.from(x).length > maxLen)
      ) {
        throw knowledgeError(
          'BAD_REQUEST',
          `По одному правилу в строке: не больше ${maxItems} строк по ${maxLen} символов`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    item.answer = answer;
    item.status = body.status;
    await this.save(m, siteId, {
      items: items as unknown as Prisma.InputJsonValue,
    });
    return this.view(
      await this.requireRow(m, siteId),
      await this.summaryOf(m, siteId),
    );
  }

  async complete(m: AccountMembership, siteId: string): Promise<WizardView> {
    await this.requireSite(m, siteId);
    const r = await this.requireRow(m, siteId);
    const ctx = { accountId: m.accountId, siteId };
    const items = parseItems(r.items);
    const ready = items.filter(
      (i) => (i.status === 'confirmed' || i.status === 'edited') && i.answer,
    );
    const golden = ready.filter((i) => i.target === 'golden');
    const { lang } = await this.base(ctx);
    const t = this.db(m);

    if (golden.length) {
      const src = await this.faqSource(m, siteId);
      const now = new Date();
      const created: string[] = [];
      const docs: DocumentInput[] = [];
      try {
        for (const i of golden) {
          // Источник — только у подтверждённого черновика: исправленный
          // ответ — слово владельца, страница его не подтверждает.
          const sourceRefs =
            i.status === 'confirmed' && i.draftSources.length
              ? (i.draftSources as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull;
          const data = {
            question: i.question,
            answer: i.answer as string,
            lang,
            origin: 'wizard',
            sourceRefs,
            status: 'active',
            approvedByTelegramId: m.telegramId,
            approvedAt: now,
          };
          const existing = i.faqId
            ? await t.assistSiteFaq.findFirst({
                where: { id: i.faqId, siteId },
                select: { id: true },
              })
            : null;
          let id: string;
          if (existing) {
            await t.assistSiteFaq.updateMany({
              where: { id: existing.id, siteId },
              data,
            });
            id = existing.id;
          } else {
            const row = await t.assistSiteFaq.create({
              data: {
                ...data,
                accountId: m.accountId,
                siteId,
                variants: [],
                createdByTelegramId: m.telegramId,
              },
              select: { id: true },
            });
            id = row.id;
            created.push(id);
          }
          i.faqId = id;
          docs.push({
            ref: `faq:${id}`,
            kind: 'faq',
            title: i.question,
            lang,
            blocks: [],
            faq: { question: i.question, answer: i.answer as string },
          });
        }
        // Одна версия на все ответы мастера — тот же путь, что FAQ Э1.
        await this.knowledge.indexDocuments(ctx, src, docs, {
          trigger: 'faq',
          byTelegramId: m.telegramId,
        });
      } catch (e) {
        // Без индексации ответ «висел» бы в списке, но не работал бы.
        if (created.length) {
          await t.assistSiteFaq
            .deleteMany({ where: { id: { in: created } } })
            .catch(() => undefined);
        }
        throw e;
      }
      const indexed = await t.assistSiteDocument.findMany({
        where: { sourceId: src, ref: { in: docs.map((d) => d.ref) } },
        select: { id: true, ref: true },
      });
      for (const d of indexed) {
        await t.assistSiteFaq.updateMany({
          where: { id: d.ref.slice('faq:'.length), siteId },
          data: { documentId: d.id },
        });
      }
      const n = await t.assistSiteFaq.count({
        where: { siteId, status: 'active' },
      });
      await t.assistSiteSource.updateMany({
        where: { id: src },
        data: { documentsCount: n, lastSyncAt: new Date() },
      });
    }

    const persona = ready.filter((i) => i.target !== 'golden');
    if (persona.length) await this.writePersonaDraft(m, siteId, persona);

    await this.markHotPages(m, siteId, golden);

    for (const i of ready) i.status = 'saved';
    await this.save(m, siteId, {
      items: items as unknown as Prisma.InputJsonValue,
      status: 'done',
      completedAt: new Date(),
    });
    return this.view(
      await this.requireRow(m, siteId),
      await this.summaryOf(m, siteId),
    );
  }

  /** Источник `faq` «Сайта» (тот же, что у FAQ Э1). */
  private async faqSource(m: AccountMembership, siteId: string) {
    const t = this.db(m);
    const found = await t.assistSiteSource.findFirst({
      where: { siteId, kind: 'faq' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (found) return found.id;
    const created = await t.assistSiteSource.create({
      data: {
        accountId: m.accountId,
        siteId,
        kind: 'faq',
        title: 'FAQ',
        status: 'active',
        createdByTelegramId: m.telegramId,
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Запреты и правила передачи — в ЧЕРНОВИК персоны (публикует владелец).
   * Черновик не разбирается — начинаем с персоны по умолчанию W4.
   */
  private async writePersonaDraft(
    m: AccountMembership,
    siteId: string,
    items: WizardItemView[],
  ): Promise<void> {
    const t = this.db(m);
    const a = await t.assistSite.findFirst({
      where: { siteId },
      select: { personaDraft: true },
    });
    const parsed = a?.personaDraft ? parsePersona(a.personaDraft) : null;
    const { lang } = await this.base({ accountId: m.accountId, siteId });
    const p: PersonaConfig = parsed?.ok ? parsed.persona : defaultPersona(lang);
    const add = (list: string[], lines: string[], max: number) => {
      for (const x of lines) {
        if (list.length >= max) break;
        if (!list.some((y) => y.toLowerCase() === x.toLowerCase()))
          list.push(x);
      }
    };
    for (const i of items) {
      const lines = personaLines(i.answer ?? '');
      if (i.target === 'persona_forbid') {
        add(p.forbiddenTopics, lines, PERSONA_LIMITS.forbiddenTopics);
      } else {
        add(p.handoffTriggers, lines, PERSONA_LIMITS.handoffTriggers);
      }
    }
    const check = parsePersona(p);
    if (!check.ok) {
      throw knowledgeError(
        'BAD_REQUEST',
        'Правила не помещаются в персону — сократите формулировки',
        HttpStatus.BAD_REQUEST,
      );
    }
    await t.assistSite.updateMany({
      where: { siteId },
      data: {
        personaDraft: check.persona as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Страницы, где нашлись ответы на темы мастера, — «горячие» (§4-тер.9
   * п.5): только страницы обхода этого сайта, ≤ 10 вместе с прежними.
   */
  private async markHotPages(
    m: AccountMembership,
    siteId: string,
    golden: WizardItemView[],
  ): Promise<void> {
    const urls = [
      ...new Set(
        golden
          .filter((i) => i.status === 'confirmed')
          .flatMap((i) => i.draftSources.map((s) => s.url))
          .filter((u): u is string => !!u),
      ),
    ];
    if (!urls.length) return;
    const t = this.db(m);
    const pages = await t.sitePage.findMany({
      where: {
        siteId,
        OR: [{ url: { in: urls } }, { finalUrl: { in: urls } }],
      },
      select: { url: true, finalUrl: true },
    });
    const crawlForm = new Map<string, string>();
    for (const p of pages) {
      crawlForm.set(p.url, p.url);
      if (p.finalUrl) crawlForm.set(p.finalUrl, p.url);
    }
    const a = await t.assistSite.findFirst({
      where: { siteId },
      select: { hotPages: true },
    });
    const hot = [...(a?.hotPages ?? [])];
    for (const u of urls) {
      const url = crawlForm.get(u);
      if (!url || hot.includes(url)) continue;
      if (hot.length >= HOT_PAGES_MAX) break;
      hot.push(url);
    }
    await t.assistSite.updateMany({
      where: { siteId },
      data: { hotPages: hot },
    });
  }

  // ── полнота знаний ────────────────────────────────────────────────────

  async completeness(
    m: AccountMembership,
    siteId: string,
  ): Promise<CompletenessView> {
    await this.requireSite(m, siteId);
    const ctx = { accountId: m.accountId, siteId };
    const t = this.db(m);
    const w = await this.row(m, siteId);
    const summary = await this.summaryOf(m, siteId);
    const type =
      asBusinessType(w?.businessType) ??
      asBusinessType(summary?.businessType) ??
      'shop';
    const topics = wizardTopics(type).map((d) => d.topic);
    const items = new Map(
      parseItems(w?.items).map((i) => [i.topic, i] as const),
    );
    const faqIds = [...items.values()]
      .map((i) => i.faqId)
      .filter((x): x is string => !!x);
    const activeFaq = new Set(
      (
        await t.assistSiteFaq.findMany({
          where: { siteId, id: { in: faqIds }, status: 'active' },
          select: { id: true },
        })
      ).map((f) => f.id),
    );
    // Тема покрыта: активный проверенный ответ мастера (golden) или
    // сохранённое правило персоны. (Автокейсы eval по теме — Э3.)
    const covered = topics.filter((topic) => {
      const i = items.get(topic);
      if (!i || i.status !== 'saved') return false;
      return i.target === 'golden' ? !!i.faqId && activeFaq.has(i.faqId) : true;
    });
    const missing = topics.filter((x) => !covered.includes(x));

    const [pageRows, excluded, quarantined, eval_, needsReview, files, a] =
      await Promise.all([
        t.sitePage.groupBy({
          by: ['status'],
          where: { siteId },
          _count: { _all: true },
        }),
        t.assistSiteDocument.count({ where: { siteId, status: 'excluded' } }),
        this.quarantinedDocs(ctx),
        this.lastEval(ctx),
        t.assistSiteFaq.count({ where: { siteId, status: 'needs_review' } }),
        t.assistSiteSource.count({ where: { siteId, kind: 'file' } }),
        t.assistSite.findFirst({
          where: { siteId },
          select: { widgetVersion: true },
        }),
      ]);
    const byStatus = new Map(
      pageRows.map((p) => [p.status, p._count._all] as const),
    );
    const read =
      (byStatus.get('ok') ?? 0) + (byStatus.get('not_modified') ?? 0);
    const skipped =
      (byStatus.get('skipped') ?? 0) + (byStatus.get('failed') ?? 0);

    const next: CompletenessView['next'] = [];
    if (!w || w.status !== 'done') next.push('run_wizard');
    else if (missing.length) next.push('answer_topics');
    if (quarantined > 0) next.push('review_quarantine');
    if (files === 0) next.push('add_documents');
    if (!a?.widgetVersion) next.push('publish_widget');

    return {
      siteId,
      topics: { covered: covered.length, total: topics.length, missing },
      pages: { read, skipped, quarantined, excluded },
      quality: eval_,
      openGapsOlderThan7d: 0,
      goldenNeedsReview: needsReview,
      next,
    };
  }

  /** Документы с фрагментами в карантине в опубликованной версии. */
  private async quarantinedDocs(ctx: KnowledgeCtx): Promise<number> {
    const r = await this.prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(DISTINCT c."documentId")::int AS n
         FROM ${qualified(SITE_TABLES.chunks)} c
         JOIN ${qualified(SITE_TABLES.settings)} a
           ON a."siteId" = c."siteId" AND a."accountId" = c."accountId"
        WHERE c."siteId" = $1 AND c."accountId" = $2 AND c."quarantined"
          AND a."knowledgeVersion" = ANY(c."versions")`,
      ctx.siteId,
      ctx.accountId,
    );
    return r[0]?.n ?? 0;
  }

  /** Последний ПРОШЕДШИЙ инвариантный eval в воротах версии. */
  private async lastEval(
    ctx: KnowledgeCtx,
  ): Promise<CompletenessView['quality']> {
    const rows = await this.sitesDb
      .forAccount(ctx.accountId)
      .assistSiteKnowledgeVersion.findMany({
        where: {
          siteId: ctx.siteId,
          status: { in: ['published', 'held'] },
          NOT: { gateReport: { equals: Prisma.DbNull } },
        },
        orderBy: { number: 'desc' },
        select: { gateReport: true, checkedAt: true, createdAt: true },
        take: 20,
      });
    for (const v of rows) {
      const report = v.gateReport as unknown as GateReport | null;
      const c = report?.checks?.find((x) => x.check === 'invariant_eval');
      if (!c || (c.note ?? '').startsWith('отложен')) continue;
      const total = INVARIANT_CASES.length;
      return {
        lastEvalAt: (v.checkedAt ?? v.createdAt).toISOString(),
        passed: Math.max(0, total - c.value),
        failed: c.value,
      };
    }
    return { lastEvalAt: null, passed: null, failed: null };
  }
}
