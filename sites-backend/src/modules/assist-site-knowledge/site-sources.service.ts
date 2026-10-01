/**
 * Источники, документы, FAQ, горячие страницы, настройки переобхода и
 * включение помощника для «Сайта» — K3. Индексацию отдаёт
 * SiteKnowledgeService (K2); файлы — KnowledgeBlobStorage + parseDocument
 * (K3). `processPendingFiles` зовёт крон assist-embed-run (K2) перед
 * индексацией: разбор загруженных файлов с lease (lockedUntil/attempts).
 *
 * Общее с «Админкой» (источники, FAQ, исключения, версии, карантин,
 * сводка) — в нейтральном `ModeKnowledgeCore` с адаптером ЭТОГО режима
 * (`core`); здесь — только то, что есть у «Сайта»: включение, горячие
 * страницы, частота и ручной переобход, 5 вопросов «проверьте ответ».
 */
import { Injectable, Logger } from '@nestjs/common';
import { CRAWL_DEFAULTS } from '../../config/assist-defaults';
import { SitesDb } from '../../prisma/sites-db.service';
import type {
  AssistSettingsView,
  CrawlRunView,
  KnowledgeSummary,
} from '../assist-knowledge-core/api-types';
import { KnowledgeBlobStorage } from '../assist-knowledge-core/documents/blob-storage';
import { e1Error } from '../assist-knowledge-core/documents/errors';
import { ModeKnowledgeCore } from '../assist-knowledge-core/documents/mode-knowledge.core';
import { questionLang } from '../assist-knowledge-core/answer/prompt';
import {
  fallbackQuestions,
  generateSuggestedQuestions,
} from '../assist-knowledge-core/answer/suggested-questions';
import { estimateCost } from '../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../shared/gemini-model';
import { LearningBudget } from '../site-ai/learning-budget';
import { GeminiText } from '../site-ai/text-model';
import { AiUsageRecorder } from '../site-ai/usage-recorder';
import {
  AccountMembership,
  REQUIRE_ASSIST_ADMIN_OWNER,
  satisfiesProductRoles,
} from '../site-core/account/roles';
import { HostAccessService } from '../site-core/ownership/host-access.service';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { SiteCrawlService } from '../site-crawl/crawl.service';
import { PublicPageFetcher } from '../site-crawl/page-fetcher';
import {
  AssistCrawlScheduler,
  recrawlIntervalMs,
} from './crawl-scheduler.service';
import { siteModeAdapter } from './site-mode.adapter';
import { SiteKnowledgeService } from './site-knowledge.service';

/** Вопросов «на которые помощник теперь отвечает» (§3.4). */
export const SUGGESTED_QUESTIONS = 5;
/** Оценка резерва бюджета обучения на генерацию вопросов (≈3k вх. + 300 вых.). */
const SUGGEST_EST_UNITS = { inputTokens: 3000, outputTokens: 300 };

@Injectable()
export class SiteSourcesService {
  private readonly logger = new Logger(SiteSourcesService.name);
  readonly core: ModeKnowledgeCore;

  constructor(
    private readonly db: SitesDb,
    knowledge: SiteKnowledgeService,
    blob: KnowledgeBlobStorage,
    fetcher: PublicPageFetcher,
    hosts: HostAccessService,
    private readonly crawl: SiteCrawlService,
    private readonly budget: LearningBudget,
    private readonly scheduler: AssistCrawlScheduler,
    private readonly text: GeminiText,
    private readonly usage: AiUsageRecorder,
  ) {
    this.core = new ModeKnowledgeCore(siteModeAdapter(db, knowledge), {
      db,
      blob,
      fetcher,
      hosts,
      crawl,
      budget,
    });
  }

  async processPendingFiles(budgetMs: number): Promise<{ processed: number }> {
    return this.core.processPending(budgetMs);
  }

  private async hasVerifiedHost(
    m: AccountMembership,
    siteId: string,
    now: Date,
  ): Promise<boolean> {
    const hosts = await this.db
      .forAccount(m.accountId)
      .siteHost.findMany({ where: { siteId } });
    return hosts.some((h) => evaluateHostAccess(h, 'assist-crawl', now).ok);
  }

  async settingsView(
    m: AccountMembership,
    siteId: string,
    now = new Date(),
  ): Promise<AssistSettingsView> {
    await this.core.requireSite(m, siteId);
    const row = await this.db
      .forAccount(m.accountId)
      .assistSite.findFirst({ where: { siteId } });
    const [lastCrawl, hasVerifiedHost] = await Promise.all([
      this.crawl.latestRun(m.accountId, siteId, 'assist'),
      this.hasVerifiedHost(m, siteId, now),
    ]);
    const every = row?.recrawlEvery;
    return {
      siteId,
      enabled: row?.enabled ?? false,
      knowledgeVersion: row?.knowledgeVersion ?? 0,
      recrawlEvery:
        every === 'manual' || every === 'daily' || every === 'weekly'
          ? every
          : 'weekly',
      nextCrawlAt: row?.nextCrawlAt?.toISOString() ?? null,
      hotPages: row?.hotPages ?? [],
      lastCrawl,
      adminAvailable: satisfiesProductRoles(m, REQUIRE_ASSIST_ADMIN_OWNER),
      hasVerifiedHost,
    };
  }

  /** POST /assist/sites/:id/enable — строка помощника, источник `crawl`, первый обход. */
  async enable(
    m: AccountMembership,
    siteId: string,
  ): Promise<AssistSettingsView> {
    await this.core.requireSite(m, siteId);
    const t = this.db.forAccount(m.accountId);
    await t.assistSite.createMany({
      data: [{ accountId: m.accountId, siteId, enabled: true }],
      skipDuplicates: true,
    });
    await t.assistSite.updateMany({
      where: { siteId },
      data: { enabled: true },
    });
    const crawlSource = await t.assistSiteSource.findFirst({
      where: { siteId, kind: 'crawl' },
    });
    if (!crawlSource) {
      await t.assistSiteSource.create({
        data: {
          accountId: m.accountId,
          siteId,
          kind: 'crawl',
          title: 'Публичный сайт',
          status: 'active',
          createdByTelegramId: m.telegramId,
        },
      });
    }
    if (await this.hasVerifiedHost(m, siteId, new Date())) {
      await this.scheduler.requestNow({
        accountId: m.accountId,
        siteId,
        trigger: 'initial',
        byTelegramId: m.telegramId,
      });
    }
    return this.settingsView(m, siteId);
  }

  private async requireAssist(m: AccountMembership, siteId: string) {
    await this.core.requireSite(m, siteId);
    const row = await this.db
      .forAccount(m.accountId)
      .assistSite.findFirst({ where: { siteId } });
    if (!row) {
      throw e1Error(
        409,
        'ASSIST_NOT_ENABLED',
        'Сначала подключите помощника к сайту',
      );
    }
    return row;
  }

  /** PUT …/hot-pages — ≤ 10 URL только хостов сайта (§4-тер.2). */
  async setHotPages(
    m: AccountMembership,
    siteId: string,
    urls: string[],
  ): Promise<AssistSettingsView> {
    if (urls.length > CRAWL_DEFAULTS.maxHotPages) {
      throw e1Error(
        400,
        'HOT_PAGES_LIMIT',
        `Горячих страниц — не больше ${CRAWL_DEFAULTS.maxHotPages}`,
      );
    }
    await this.requireAssist(m, siteId);
    const list = await this.core.validateUrls(m, siteId, urls);
    const t = this.db.forAccount(m.accountId);
    await t.assistSite.updateMany({
      where: { siteId },
      // Новый список — проверить в ближайший тик, а не через сутки.
      data: { hotPages: list, hotCheckedAt: null },
    });
    await t.assistSiteDocument.updateMany({
      where: { siteId, hot: true, NOT: { url: { in: list } } },
      data: { hot: false },
    });
    if (list.length > 0) {
      await t.assistSiteDocument.updateMany({
        where: { siteId, url: { in: list } },
        data: { hot: true },
      });
    }
    return this.settingsView(m, siteId);
  }

  /** PATCH …/settings — частота переобхода. */
  async updateSettings(
    m: AccountMembership,
    siteId: string,
    recrawlEvery: 'manual' | 'weekly' | 'daily',
    now = new Date(),
  ): Promise<AssistSettingsView> {
    const row = await this.requireAssist(m, siteId);
    const every = recrawlIntervalMs(recrawlEvery);
    let nextCrawlAt: Date | null = null;
    if (every !== null) {
      const candidate = new Date(now.getTime() + every);
      // Чаще стало — ближе следующий обход; реже — не откладываем уже назначенный.
      nextCrawlAt =
        row.nextCrawlAt && row.nextCrawlAt.getTime() < candidate.getTime()
          ? row.nextCrawlAt
          : candidate;
    }
    await this.db.forAccount(m.accountId).assistSite.updateMany({
      where: { siteId },
      data: { recrawlEvery, nextCrawlAt },
    });
    return this.settingsView(m, siteId, now);
  }

  /** POST …/recrawl — нет verified-хоста → 409 HOST_NOT_VERIFIED (K1). */
  async recrawl(m: AccountMembership, siteId: string): Promise<CrawlRunView> {
    await this.requireAssist(m, siteId);
    if (!(await this.hasVerifiedHost(m, siteId, new Date()))) {
      throw e1Error(
        409,
        'HOST_NOT_VERIFIED',
        'Подтвердите владение хотя бы одним адресом сайта — без этого обход невозможен',
      );
    }
    const { runId } = await this.scheduler.requestNow({
      accountId: m.accountId,
      siteId,
      trigger: 'manual',
      byTelegramId: m.telegramId,
    });
    const run = await this.crawl.getRun(m.accountId, runId);
    if (!run) throw new Error(`Прогон ${runId} не найден сразу после запроса`);
    return run;
  }

  async summary(
    m: AccountMembership,
    siteId: string,
  ): Promise<KnowledgeSummary> {
    const questions = await this.suggestedQuestions(m, siteId).catch(
      (e: unknown) => {
        this.logger.warn(
          `вопросы сайта ${siteId}: ${(e as Error | null)?.name ?? 'Error'}`,
        );
        return [] as string[];
      },
    );
    return this.core.summary(m, siteId, { suggestedQuestions: questions });
  }

  /**
   * 5 вопросов по опубликованной версии (§3.4, У-8: только из знаний
   * «Сайта»). Пересчёт — при смене версии, деньги — из бюджета обучения
   * (`assist-learn`); бюджета нет — вопросы из заголовков, без модели.
   */
  private async suggestedQuestions(
    m: AccountMembership,
    siteId: string,
  ): Promise<string[]> {
    const t = this.db.forAccount(m.accountId);
    const row = await t.assistSite.findFirst({ where: { siteId } });
    if (!row || row.knowledgeVersion === 0) return [];
    if (row.suggestedForVersion === row.knowledgeVersion) {
      const saved = row.suggestedQuestions;
      return Array.isArray(saved)
        ? saved.filter((q): q is string => typeof q === 'string')
        : [];
    }
    const seeds = await t.assistSiteChunk.findMany({
      where: {
        siteId,
        versions: { has: row.knowledgeVersion },
        quarantined: false,
        ugc: false,
      },
      select: { title: true, headingPath: true, text: true, lang: true },
      orderBy: [{ sourceType: 'asc' }, { ordinal: 'asc' }],
      take: 12,
    });
    const lang = questionLang(
      seeds
        .map((s) => s.text)
        .join(' ')
        .slice(0, 2000),
      seeds[0]?.lang,
    );
    const est =
      estimateCost(GEMINI_MODEL, SUGGEST_EST_UNITS).costMicroUsd || 2000;
    const reserved = await this.budget.reserve(m.accountId, siteId, est);
    const gen = reserved
      ? await generateSuggestedQuestions(
          this.text,
          seeds,
          lang,
          SUGGESTED_QUESTIONS,
        )
      : {
          questions: fallbackQuestions(seeds, lang, SUGGESTED_QUESTIONS),
          usage: null,
        };
    if (reserved) {
      let actual = 0;
      if (gen.usage) {
        const r = await this.usage.record(
          this.db.system('учёт расходов ИИ: вопросы сайта (assist-learn)'),
          {
            accountId: m.accountId,
            siteId,
            operation: 'assist-learn',
            model: gen.usage.model,
            units: {
              inputTokens: gen.usage.inputTokens,
              cachedInputTokens: gen.usage.cachedInputTokens,
              outputTokens: gen.usage.outputTokens,
            },
          },
        );
        actual = r.costMicroUsd;
      }
      await this.budget.adjust(m.accountId, siteId, actual - est);
    }
    // Без бюджета — не запоминаем: появится бюджет — вопросы сделает модель.
    if (reserved) {
      await t.assistSite.updateMany({
        where: { siteId },
        data: {
          suggestedQuestions: gen.questions,
          suggestedForVersion: row.knowledgeVersion,
        },
      });
    }
    return gen.questions;
  }
}
