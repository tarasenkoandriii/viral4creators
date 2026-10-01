/**
 * Песочница — K3 (ТЗ §3.1; лендинг-ТЗ §6; §4.16 /public/assist/sandbox*).
 *
 * Общий механизм для кабинетной (онбординг TMA, kind=cabinet, SitesDb) и
 * анонимной (лендинг, kind=public, ВСЯ работа с базой — AssistPublicDb под
 * ролью assist_public). Уровень допуска L0: подтверждение не нужно,
 * opt-out и SSRF — на каждом запросе (PublicPageFetcher, purpose
 * 'assist-sandbox'). Обход — главная + sitemap/ссылки, ≤ pagesLimit,
 * вежливо (≤ 1 запрос/с на хост у публичной). Прогресс — «шаг на опрос»:
 * GET статуса с lease (lockedUntil) делает следующую порцию (1–2 страницы
 * или эмбеддинг), чтобы уложиться в функцию Vercel и честно показывать
 * прогресс. Знания — assist_sandbox_pages/chunks (не assist_site_*), чат —
 * AnswerEngine по своей выдаче (rrfMerge), для подтверждённого и
 * проиндексированного сайта кабинета — SiteKnowledgeService.search.
 *
 * Сеть — ТОЛЬКО через PublicPageFetcher/RobotsService/SitemapService (K1:
 * IP-pin, SSRF, robots, opt-out); своих fetch здесь нет (приёмка C5).
 * Скриншота нет до воркера QA (лендинг-ТЗ §6.4): `screenshotKey` не
 * пишется никогда (C6), фон — `theme-color`.
 * Знаний «Админки» песочница не видит: модуль режима «Сайт», импорт
 * «Админки» роняет граф зависимостей (D1).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AssistSandbox, PrismaClient } from '@prisma/client';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import {
  CRAWL_DEFAULTS,
  KNOWLEDGE_DEFAULTS,
  SANDBOX_LIMITS,
} from '../../config/assist-defaults';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { estimateCost } from '../../shared/ai-pricing';
import { maskSensitiveEcho } from '../../shared/assist-chat-core';
import { GEMINI_MODEL } from '../../shared/gemini-model';
import type {
  SandboxAnswer,
  SandboxMessageView,
  SandboxSourceRef,
  SandboxTransferResult,
  SandboxView,
  PublicSandboxCreated,
  UrlPreview,
} from '../assist-knowledge-core/api-types';
import { AnswerEngine } from '../assist-knowledge-core/answer/answer-engine';
import { questionLang } from '../assist-knowledge-core/answer/prompt';
import { generateSuggestedQuestions } from '../assist-knowledge-core/answer/suggested-questions';
import { chunkBlocks } from '../assist-knowledge-core/chunker';
import { e1Error } from '../assist-knowledge-core/documents/errors';
import { detectInjection } from '../assist-knowledge-core/injection';
import { rrfMerge } from '../assist-knowledge-core/rrf';
import type { SearchHit } from '../assist-knowledge-core/types';
import { SiteKnowledgeService } from '../assist-site-knowledge/site-knowledge.service';
import { GeminiEmbedder, toVectorLiteral } from '../site-ai/embedder';
import type { SiteAiOperation } from '../site-ai/operations';
import { GeminiText, TextModelError } from '../site-ai/text-model';
import { AiUsageRecorder, UsageDb } from '../site-ai/usage-recorder';
import type { AccountMembership } from '../site-core/account/roles';
import {
  isPublicPlatformHost,
  normalizeHostInput,
  registrableDomain,
} from '../site-core/hosts/host-normalize';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { notFoundSite } from '../site-core/site-core.constants';
import { assertCrawlableUrl } from '../site-crawl/net/pinned-fetch';
import { PublicPageFetcher, isOptedOut } from '../site-crawl/page-fetcher';
import { RobotsService } from '../site-crawl/robots';
import { SitemapService } from '../site-crawl/sitemap';
import type { CrawlCacheDb, RobotsRules } from '../site-crawl/types';
import { normalizeCrawlUrl } from '../site-crawl/url';
import {
  PUBLIC_MONEY_KEY,
  adjustCounter,
  blockedCategory,
  bumpCounter,
  landingOriginAllowed,
  publicDailyCapMicroUsd,
  publicSandboxEnabled,
  readCounter,
  sandboxIpHash,
  utcDay,
} from './sandbox-limits';

/** Клиент базы песочницы: PrismaService (кабинет) или AssistPublicDb (лендинг). */
export type SandboxDb = PrismaClient;

type SandboxRow = AssistSandbox;

/** Внутренний прогресс (наружу — только sitemap/found/read/titles). */
interface Progress {
  sitemap: boolean;
  found: number;
  read: number;
  titles: string[];
  queue: string[];
  next: number;
  lastSkip?: string;
}

/** Lease шага и попыток до failed. */
export const SANDBOX_LEASE_MS = 60_000;
export const SANDBOX_MAX_ATTEMPTS = 6;
/** Сколько работы делает один опрос статуса (функция Vercel — с запасом). */
export const SANDBOX_POLL_BUDGET_MS = SANDBOX_LIMITS.pollBudgetMs;
/**
 * Страниц за один опрос (вежливость: публичная — 1 запрос/с на хост, т.е.
 * ~3 с на опрос — в пределах бюджета функции).
 */
const PAGES_PER_POLL = SANDBOX_LIMITS.pagesPerPoll;
/** Вопросов-кнопок песочницы (лендинг-ТЗ §6.2). */
export const SANDBOX_SUGGESTED = 3;
/** Резерв денег на один ответ чата / минимальный на индексацию (µ$). */
const CHAT_EST_UNITS = { inputTokens: 5000, outputTokens: 800 };
const MIN_RESERVE_MICRO = 100;
/** Вес UGC в слиянии выдач (§6.5: мнение посетителя, не факт). */
const UGC_PENALTY = SANDBOX_LIMITS.ugcPenalty;

const ACTIVE = ['queued', 'crawling', 'indexing'];

/**
 * Потолок текста песочницы для эмбеддинга (токены): страница чужого сайта
 * может весить 3 МБ текста. Без потолка 8 таких страниц — миллионы токенов
 * в одном опросе: функция не успевает, её убивают ПОСЛЕ резерва денег (он
 * не возвращается), следующий опрос резервирует снова — одна песочница
 * выбирает суточный потолок всех публичных песочниц. Для демо по сайту
 * хватает начала каждой страницы.
 */
export const SANDBOX_MAX_PAGE_TOKENS = 4_000;
export const SANDBOX_MAX_TOKENS = 30_000;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function keyMatches(key: string | undefined, hash: string | null): boolean {
  if (!key || !hash || key.length > 200) return false;
  const a = Buffer.from(sha256(key), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseProgress(v: Prisma.JsonValue): Progress {
  const o =
    v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  const strings = (x: unknown) =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
  return {
    sitemap: o.sitemap === true,
    found: typeof o.found === 'number' ? o.found : 0,
    read: typeof o.read === 'number' ? o.read : 0,
    titles: strings(o.titles),
    queue: strings(o.queue),
    next: typeof o.next === 'number' ? o.next : 0,
    ...(typeof o.lastSkip === 'string' ? { lastSkip: o.lastSkip } : {}),
  };
}

function progressJson(p: Progress): Prisma.InputJsonValue {
  return { ...p } as unknown as Prisma.InputJsonValue;
}

/**
 * Кэш robots и отказ доменов для fetcher'а K1 под ролью assist_public.
 * Почему не сам клиент: Prisma 7 в любой `findFirst` добавляет в SELECT
 * первичный ключ (`id`), а роли выдан только столбец `domain`
 * (GRANT SELECT ("domain") — миграция Э1) → 42501 на каждом запросе
 * (проверено на PG16, лог сервера). Здесь — тот же вопрос сырым SQL ровно
 * по `domain`. Запрос координатору — в отчёте K3.
 */
function crawlCacheFor(db: SandboxDb): CrawlCacheDb {
  const optOut = {
    findFirst: async (args: { where?: { domain?: { in?: string[] } } }) => {
      const list = args.where?.domain?.in ?? [];
      if (list.length === 0) return null;
      const rows = await db.$queryRaw<Array<{ domain: string }>>(Prisma.sql`
        SELECT "domain" FROM "sites"."site_opt_out_domains"
        WHERE "domain" = ANY(${list}::text[]) LIMIT 1`);
      return rows[0] ?? null;
    },
  };
  return {
    siteCrawlRobots: db.siteCrawlRobots,
    siteOptOutDomain: optOut,
  } as unknown as CrawlCacheDb;
}

/** site_ai_usage под assist_public: recorder пишет через createMany (без RETURNING). */
function insertOnlyUsageDb(db: SandboxDb): UsageDb {
  return {
    siteAiUsage: { createMany: (args) => db.siteAiUsage.createMany(args) },
  };
}

@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);
  /** Подменяются в тестах. */
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();
  pollBudgetMs = SANDBOX_POLL_BUDGET_MS;
  /** Пауза между запросами к хосту: публичная — ≤ 1 запрос/с (лендинг-ТЗ §6.3). */
  minDelayMs: { public: number; cabinet: number } = {
    public: SANDBOX_LIMITS.public.minDelayMsPerHost,
    cabinet: CRAWL_DEFAULTS.minDelayMsPerHost,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicDb: AssistPublicDb,
    private readonly sitesDb: SitesDb,
    private readonly fetcher: PublicPageFetcher,
    private readonly robots: RobotsService,
    private readonly sitemaps: SitemapService,
    private readonly embedder: GeminiEmbedder,
    private readonly answers: AnswerEngine,
    private readonly text: GeminiText,
    private readonly usage: AiUsageRecorder,
    private readonly siteKnowledge: SiteKnowledgeService,
  ) {}

  // ── Проверки URL (L0: SSRF-форма, opt-out, категории) ─────────────────

  /**
   * Адрес песочницы: только https, порт 443, без `user:pass@`, без
   * IP-литералов (любой записи), без внутренних имён (лендинг-ТЗ §6.3).
   * Ввод без схемы — https; `http://` — отказ, а не «молча https».
   */
  checkUrl(raw: string): { url: string; host: string; domain: string } {
    const input = raw.trim();
    const reject = (why: string) =>
      e1Error(400, 'URL_REJECTED', `Этот адрес проверить нельзя: ${why}`);
    if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^https:\/\//i.test(input)) {
      throw reject('нужен адрес https://');
    }
    const withScheme = /^https:\/\//i.test(input) ? input : `https://${input}`;
    let host: string;
    try {
      host = normalizeHostInput(withScheme).host;
    } catch (e) {
      throw reject((e as Error).message.toLowerCase());
    }
    let u: URL;
    try {
      u = assertCrawlableUrl(withScheme);
    } catch {
      throw reject('адрес недоступен извне');
    }
    const url = normalizeCrawlUrl(u.toString()) ?? `https://${host}/`;
    const domain = registrableDomain(host);
    if (!domain) throw reject('у имени нет регистрируемого домена');
    return { url, host, domain };
  }

  private async assertAllowedHost(
    db: CrawlCacheDb,
    host: string,
  ): Promise<void> {
    if (await isOptedOut(db, host)) {
      throw e1Error(
        403,
        'OPTED_OUT',
        'Владелец этого сайта отказался от обходов',
      );
    }
    if (blockedCategory(host)) {
      throw e1Error(
        403,
        'BLOCKED_CATEGORY',
        'Сайты этой категории в песочнице не открываются',
      );
    }
  }

  /** Шаг 2 онбординга: что нашли на главной — без записи (L0). */
  async urlPreview(raw: string): Promise<UrlPreview> {
    const { url, host } = this.checkUrl(raw);
    const db = this.prisma;
    await this.assertAllowedHost(db, host);
    const origin = new URL(url).origin;
    const home = await this.fetcher.fetchPage(`${origin}/`, {
      purpose: 'assist-sandbox',
      db,
    });
    let sitemapFound = false;
    try {
      const rules = await this.robots.rulesFor(origin, db);
      sitemapFound =
        rules.sitemaps.length > 0 ||
        (await this.sitemaps.discover(origin, rules, 1)).length > 0;
    } catch {
      sitemapFound = false;
    }
    return {
      url,
      host,
      title: home.ok ? home.page.title : null,
      lang: home.ok ? home.page.lang : null,
      sitemapFound,
      themeColor: home.ok ? home.page.themeColor : null,
    };
  }

  // ── Публичная песочница лендинга ──────────────────────────────────────

  async createPublic(p: {
    url: string;
    ip: string;
    origin?: string;
  }): Promise<PublicSandboxCreated> {
    const now = this.now();
    const db = this.publicDb;
    const unavailable = () =>
      e1Error(
        503,
        'SANDBOX_DISABLED',
        'Песочница сейчас недоступна — оставьте заявку',
      );
    if (!publicSandboxEnabled(this.env)) throw unavailable();
    if (!landingOriginAllowed(p.origin, this.env)) {
      throw e1Error(403, 'ORIGIN_FORBIDDEN', 'Запрос не с нашего сайта');
    }
    const target = this.checkUrl(p.url);
    await this.assertAllowedHost(crawlCacheFor(db), target.host);
    const ipKey = sandboxIpHash(p.ip, this.env, now);
    if (!ipKey) throw unavailable();
    const day = utcDay(now);
    const cap = publicDailyCapMicroUsd(this.env);
    if (
      (await readCounter(db, 'sandbox-money', PUBLIC_MONEY_KEY, day)) >= cap
    ) {
      throw e1Error(
        503,
        'SANDBOX_BUDGET',
        'Песочница сейчас недоступна — оставьте заявку',
      );
    }
    if (
      !(await bumpCounter(
        db,
        'sandbox-ip',
        ipKey,
        day,
        1,
        SANDBOX_LIMITS.public.perIpPerDay,
      ))
    ) {
      throw e1Error(
        429,
        'SANDBOX_LIMIT_IP',
        'Лимит песочниц на сегодня исчерпан — войдите через Telegram, чтобы продолжить',
      );
    }

    const since = new Date(now.getTime() - SANDBOX_LIMITS.public.domainCacheMs);
    const reusable = {
      kind: 'public',
      reusedFromId: null,
      status: { notIn: ['failed', 'blocked', 'expired'] },
      createdAt: { gte: since },
      expiresAt: { gt: now },
    };
    // Тот же хост за 24 ч — из кэша, без нового обхода (лендинг-ТЗ §6.3).
    let source = await db.assistSandbox.findFirst({
      where: { ...reusable, host: target.host },
      orderBy: { createdAt: 'desc' },
    });
    if (!source) {
      const fresh = await bumpCounter(
        db,
        'sandbox-domain',
        target.domain,
        day,
        1,
        SANDBOX_LIMITS.public.newCrawlsPerDomainPerDay,
      );
      if (!fresh) {
        // Обходов домена на сегодня хватит: перебор поддоменов жертвы с
        // разных IP не делает песочницу распределённым краулером — дальше кэш.
        source = await db.assistSandbox.findFirst({
          where: { ...reusable, registrableDomain: target.domain },
          orderBy: { createdAt: 'desc' },
        });
        if (!source) {
          throw e1Error(
            429,
            'SANDBOX_LIMIT_DOMAIN',
            'Этот сайт сегодня уже проверяли много раз — попробуйте завтра',
          );
        }
      }
    }

    const id = randomBytes(16).toString('base64url');
    const sandboxKey = randomBytes(24).toString('base64url');
    const ttl = new Date(now.getTime() + SANDBOX_LIMITS.public.ttlMs);
    const row = await db.assistSandbox.create({
      data: {
        id,
        kind: 'public',
        browserKeyHash: sha256(sandboxKey),
        url: source ? source.url : target.url,
        host: source ? source.host : target.host,
        registrableDomain: target.domain,
        ipKey,
        status: 'queued',
        progress: progressJson({
          sitemap: false,
          found: 0,
          read: 0,
          titles: [],
          queue: [],
          next: 0,
        }),
        pagesLimit: SANDBOX_LIMITS.public.pages,
        questionsLimit: SANDBOX_LIMITS.public.questions,
        reusedFromId: source?.id ?? null,
        // Знания кэша живут, пока жива песочница-источник.
        expiresAt: source && source.expiresAt < ttl ? source.expiresAt : ttl,
      },
    });
    return {
      id: row.id,
      sandboxKey,
      status: row.status as SandboxView['status'],
    };
  }

  /** Публичная песочница по id + ключу браузера; чужая/перенесённая — 404. */
  private async publicRow(
    id: string,
    key: string | undefined,
  ): Promise<SandboxRow> {
    const notFound = () =>
      e1Error(404, 'SANDBOX_NOT_FOUND', 'Песочница не найдена');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw notFound();
    const row = await this.publicDb.assistSandbox.findUnique({ where: { id } });
    if (!row || row.kind !== 'public' || row.accountId !== null)
      throw notFound();
    if (!keyMatches(key, row.browserKeyHash)) throw notFound();
    return row;
  }

  async getPublic(id: string, key: string | undefined): Promise<SandboxView> {
    let row = await this.publicRow(id, key);
    row = await this.advance(row, this.publicDb);
    return this.view(row, this.publicDb, 'sandbox');
  }

  async chatPublic(
    id: string,
    key: string | undefined,
    question: string,
  ): Promise<SandboxAnswer> {
    const row = await this.publicRow(id, key);
    return this.chat(row, this.publicDb, question, null);
  }

  // ── Кабинетная песочница (онбординг TMA) ──────────────────────────────

  private async requireSite(m: AccountMembership, siteId: string) {
    const site = await this.sitesDb
      .forAccount(m.accountId)
      .site.findFirst({ where: { id: siteId } });
    if (!site) throw notFoundSite();
    return site;
  }

  private async currentCabinetRow(
    m: AccountMembership,
    siteId: string,
  ): Promise<SandboxRow | null> {
    return this.prisma.assistSandbox.findFirst({
      where: {
        siteId,
        accountId: m.accountId,
        expiresAt: { gt: this.now() },
        status: { notIn: ['failed', 'blocked'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** «Сайт» отвечает из опубликованной базы, если сайт подтверждён и проиндексирован. */
  private async answersFrom(
    accountId: string,
    siteId: string | null,
  ): Promise<'sandbox' | 'knowledge'> {
    if (!siteId) return 'sandbox';
    const t = this.sitesDb.forAccount(accountId);
    const assist = await t.assistSite.findFirst({
      where: { siteId },
      select: { knowledgeVersion: true },
    });
    if (!assist || assist.knowledgeVersion === 0) return 'sandbox';
    const hosts = await t.siteHost.findMany({ where: { siteId } });
    const now = this.now();
    return hosts.some((h) => evaluateHostAccess(h, 'assist-crawl', now).ok)
      ? 'knowledge'
      : 'sandbox';
  }

  async createCabinet(
    m: AccountMembership,
    siteId: string,
  ): Promise<SandboxView> {
    await this.requireSite(m, siteId);
    const existing = await this.currentCabinetRow(m, siteId);
    if (existing) return this.getCabinet(m, siteId);

    const host = await this.sitesDb.forAccount(m.accountId).siteHost.findFirst({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
    });
    if (!host) throw e1Error(400, 'URL_INVALID', 'У сайта нет адреса');
    const target = this.checkUrl(`https://${host.host}/`);
    await this.assertAllowedHost(crawlCacheFor(this.prisma), target.host);
    const now = this.now();
    const ok = await bumpCounter(
      this.prisma,
      'sandbox-cabinet',
      m.accountId,
      utcDay(now),
      1,
      SANDBOX_LIMITS.cabinet.perAccountPerDay,
    );
    if (!ok) {
      throw e1Error(
        429,
        'SANDBOX_LIMIT_ACCOUNT',
        'Лимит песочниц кабинета на сегодня исчерпан — попробуйте завтра',
      );
    }
    await this.prisma.assistSandbox.create({
      data: {
        id: randomBytes(16).toString('base64url'),
        kind: 'cabinet',
        accountId: m.accountId,
        siteId,
        createdByTelegramId: m.telegramId,
        url: target.url,
        host: target.host,
        registrableDomain: target.domain,
        status: 'queued',
        progress: progressJson({
          sitemap: false,
          found: 0,
          read: 0,
          titles: [],
          queue: [],
          next: 0,
        }),
        pagesLimit: SANDBOX_LIMITS.cabinet.pages,
        questionsLimit: SANDBOX_LIMITS.cabinet.questions,
        expiresAt: new Date(now.getTime() + SANDBOX_LIMITS.cabinet.ttlMs),
      },
    });
    return this.getCabinet(m, siteId);
  }

  async getCabinet(m: AccountMembership, siteId: string): Promise<SandboxView> {
    await this.requireSite(m, siteId);
    let row = await this.currentCabinetRow(m, siteId);
    if (!row) {
      throw e1Error(
        404,
        'SANDBOX_NOT_FOUND',
        'Песочницы для этого сайта ещё нет',
      );
    }
    row = await this.advance(row, this.prisma);
    return this.view(
      row,
      this.prisma,
      await this.answersFrom(m.accountId, siteId),
    );
  }

  async chatCabinet(
    m: AccountMembership,
    siteId: string,
    question: string,
  ): Promise<SandboxAnswer> {
    await this.requireSite(m, siteId);
    const row = await this.currentCabinetRow(m, siteId);
    if (!row) {
      throw e1Error(
        404,
        'SANDBOX_NOT_FOUND',
        'Песочницы для этого сайта ещё нет',
      );
    }
    return this.chat(row, this.prisma, question, m.accountId);
  }

  /**
   * Перенос анонимной песочницы в кабинет по `sb_<id>` (лендинг-ТЗ §7.3,
   * контракт Э1 п.5): сайт и хост `pending` (или уже существующий хост
   * кабинета), привязка песочницы, срок — 7 дней, вопросы — лимит TMA.
   * Полный обход — после подтверждения владения.
   */
  async transfer(
    m: AccountMembership,
    sandboxId: string,
  ): Promise<SandboxTransferResult> {
    const notFound = () =>
      e1Error(404, 'SANDBOX_NOT_FOUND', 'Песочница не найдена');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(sandboxId)) throw notFound();
    const now = this.now();
    const row = await this.prisma.assistSandbox.findUnique({
      where: { id: sandboxId },
    });
    if (!row || row.kind !== 'public') throw notFound();
    if (row.accountId !== null) {
      if (row.accountId === m.accountId && row.siteId) {
        const h = await this.sitesDb
          .forAccount(m.accountId)
          .siteHost.findFirst({
            where: { siteId: row.siteId, host: row.host },
          });
        if (h) return { siteId: row.siteId, hostId: h.id };
      }
      throw e1Error(
        409,
        'SANDBOX_TRANSFERRED',
        'Эта песочница уже перенесена в кабинет',
      );
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw e1Error(
        410,
        'SANDBOX_EXPIRED',
        'Песочница истекла — запустите новую',
      );
    }
    await this.assertAllowedHost(crawlCacheFor(this.prisma), row.host);

    const { siteId, hostId } = await this.siteForHost(m, row);
    const moved = await this.prisma.assistSandbox.updateMany({
      where: { id: row.id, accountId: null },
      data: {
        accountId: m.accountId,
        siteId,
        createdByTelegramId: m.telegramId,
        transferredAt: now,
        expiresAt: new Date(now.getTime() + SANDBOX_LIMITS.cabinet.ttlMs),
        questionsLimit: Math.max(
          row.questionsLimit,
          SANDBOX_LIMITS.cabinet.questions,
        ),
      },
    });
    if (moved.count === 0) {
      throw e1Error(
        409,
        'SANDBOX_TRANSFERRED',
        'Эта песочница уже перенесена в кабинет',
      );
    }
    if (row.reusedFromId) await this.detachFromCache(row.id, row.reusedFromId);
    return { siteId, hostId };
  }

  private async siteForHost(
    m: AccountMembership,
    row: SandboxRow,
  ): Promise<{ siteId: string; hostId: string }> {
    const addr = normalizeHostInput(row.host);
    const t = this.sitesDb.forAccount(m.accountId);
    const existing = await t.siteHost.findFirst({
      where: { scheme: addr.scheme, host: addr.host, port: addr.port },
    });
    if (existing) return { siteId: existing.siteId, hostId: existing.id };
    const site = await t.site.create({
      data: {
        accountId: m.accountId,
        name: (row.title ?? addr.host).slice(0, 120),
      },
    });
    try {
      const host = await t.siteHost.create({
        data: {
          accountId: m.accountId,
          siteId: site.id,
          scheme: addr.scheme,
          host: addr.host,
          port: addr.port,
          publicPlatform: isPublicPlatformHost(addr.host),
          status: 'pending',
        },
      });
      return { siteId: site.id, hostId: host.id };
    } catch (e) {
      await t.site
        .deleteMany({ where: { id: site.id } })
        .catch(() => undefined);
      // Гонка двух переносов одного хоста — второй берёт созданный первым.
      const again = await t.siteHost.findFirst({
        where: { scheme: addr.scheme, host: addr.host, port: addr.port },
      });
      if (again) return { siteId: again.siteId, hostId: again.id };
      throw e;
    }
  }

  /**
   * Песочница «из кэша» после переноса живёт 7 дней, а источник — 24 ч:
   * знания копируются к ней (страницы и фрагменты вместе с векторами —
   * без нового обхода и без новых денег).
   */
  private async detachFromCache(id: string, fromId: string): Promise<void> {
    const src = await this.prisma.assistSandbox.findUnique({
      where: { id: fromId },
    });
    await this.prisma.$transaction([
      this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "sites"."assist_sandbox_pages"
          ("id","sandboxId","url","title","lang","text","blocks","contentHash","fetchedAt")
        SELECT md5(random()::text || p."id"), ${id}, p."url", p."title", p."lang", p."text",
               p."blocks", p."contentHash", p."fetchedAt"
        FROM "sites"."assist_sandbox_pages" p WHERE p."sandboxId" = ${fromId}
        ON CONFLICT ("sandboxId","url") DO NOTHING`),
      this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "sites"."assist_sandbox_chunks"
          ("id","sandboxId","pageId","url","title","headingPath","lang","ordinal","text",
           "tokens","contentHash","ugc","quarantined","quarantineReason","embedModel","embedding","createdAt")
        SELECT md5(random()::text || c."id"), ${id}, np."id", c."url", c."title", c."headingPath",
               c."lang", c."ordinal", c."text", c."tokens", c."contentHash", c."ugc",
               c."quarantined", c."quarantineReason", c."embedModel", c."embedding", c."createdAt"
        FROM "sites"."assist_sandbox_chunks" c
        JOIN "sites"."assist_sandbox_pages" op ON op."id" = c."pageId"
        JOIN "sites"."assist_sandbox_pages" np ON np."sandboxId" = ${id} AND np."url" = op."url"
        WHERE c."sandboxId" = ${fromId}`),
      this.prisma.assistSandbox.update({
        where: { id },
        data: {
          reusedFromId: null,
          ...(src
            ? {
                status: src.status === 'ready' ? 'ready' : 'queued',
                title: src.title,
                lang: src.lang,
                themeColor: src.themeColor,
                pagesRead: src.pagesRead,
                progress: src.progress as Prisma.InputJsonValue,
                suggestedQuestions: (src.suggestedQuestions ??
                  Prisma.DbNull) as
                  Prisma.InputJsonValue | typeof Prisma.DbNull,
              }
            : { status: 'queued' }),
        },
      }),
    ]);
  }

  // ── Шаги обхода и индексации («шаг на опрос») ─────────────────────────

  private async advance(row: SandboxRow, db: SandboxDb): Promise<SandboxRow> {
    const deadline = this.now().getTime() + this.pollBudgetMs;
    let cur = row;
    while (ACTIVE.includes(cur.status) && this.now().getTime() < deadline) {
      if (cur.expiresAt.getTime() <= this.now().getTime()) break;
      const next = cur.reusedFromId
        ? await this.mirror(cur, db)
        : await this.step(cur, db);
      if (
        !next ||
        (next.status === cur.status &&
          next.updatedAt.getTime() === cur.updatedAt.getTime())
      ) {
        return next ?? cur;
      }
      cur = next;
      if (cur.reusedFromId) break;
    }
    return cur;
  }

  /** Песочница «из кэша»: состояние — как у источника (его шаги делает он сам). */
  private async mirror(
    row: SandboxRow,
    db: SandboxDb,
  ): Promise<SandboxRow | null> {
    let src = await db.assistSandbox.findUnique({
      where: { id: row.reusedFromId as string },
    });
    if (!src) {
      return db.assistSandbox.update({
        where: { id: row.id },
        data: { status: 'failed', statusReason: 'cache_gone' },
      });
    }
    if (ACTIVE.includes(src.status)) src = await this.advance(src, db);
    if (ACTIVE.includes(src.status) && src.status === row.status) return row;
    return db.assistSandbox.update({
      where: { id: row.id },
      data: {
        status: src.status,
        statusReason: src.statusReason,
        title: src.title,
        lang: src.lang,
        themeColor: src.themeColor,
        pagesRead: src.pagesRead,
        progress: src.progress as Prisma.InputJsonValue,
        suggestedQuestions: (src.suggestedQuestions ?? Prisma.DbNull) as
          Prisma.InputJsonValue | typeof Prisma.DbNull,
      },
    });
  }

  private async step(
    row: SandboxRow,
    db: SandboxDb,
  ): Promise<SandboxRow | null> {
    const now = this.now();
    const due = { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] };
    const claimed = await db.assistSandbox.updateMany({
      where: { id: row.id, status: row.status, ...due },
      data: {
        lockedUntil: new Date(now.getTime() + SANDBOX_LEASE_MS),
        attempts: { increment: 1 },
      },
    });
    // Шаг уже делает другой опрос — показываем, что есть.
    if (claimed.count === 0)
      return db.assistSandbox.findUnique({ where: { id: row.id } });
    if (row.attempts >= SANDBOX_MAX_ATTEMPTS) {
      // Попытки кончились без итога: прошлые опросы не дожили до catch
      // (функцию убили по времени/памяти). Без этого каждый опрос снова
      // резервировал бы деньги и снова падал.
      return db.assistSandbox.update({
        where: { id: row.id },
        data: { status: 'failed', statusReason: 'error', lockedUntil: null },
      });
    }
    try {
      if (row.status === 'queued') await this.seed(row, db);
      else if (row.status === 'crawling') await this.crawlSome(row, db);
      else await this.index(row, db);
      await db.assistSandbox.update({
        where: { id: row.id },
        data: { lockedUntil: null, attempts: 0 },
      });
    } catch (e) {
      const giveUp = row.attempts + 1 >= SANDBOX_MAX_ATTEMPTS;
      this.logger.warn(
        `песочница ${row.id} (${row.status}): ${(e as Error | null)?.name ?? 'Error'}`,
      );
      await db.assistSandbox.update({
        where: { id: row.id },
        data: giveUp
          ? { status: 'failed', statusReason: 'error', lockedUntil: null }
          : { lockedUntil: null },
      });
      if (!giveUp) return null;
    }
    return db.assistSandbox.findUnique({ where: { id: row.id } });
  }

  private minDelay(row: SandboxRow): number {
    return row.kind === 'public'
      ? this.minDelayMs.public
      : this.minDelayMs.cabinet;
  }

  /** queued → crawling: главная + sitemap (короткие пути — первыми: там обзор). */
  private async seed(row: SandboxRow, db: SandboxDb): Promise<void> {
    const origin = new URL(row.url).origin;
    let rules: RobotsRules | null = null;
    try {
      rules = await this.robots.rulesFor(origin, crawlCacheFor(db));
    } catch {
      rules = null;
    }
    let fromSitemap: string[] = [];
    if (rules) {
      try {
        const entries = await this.sitemaps.discover(
          origin,
          rules,
          row.pagesLimit * 5,
        );
        fromSitemap = entries
          .map((e) => normalizeCrawlUrl(e.url))
          .filter((u): u is string => !!u && new URL(u).hostname === row.host)
          .sort(
            (a, b) => new URL(a).pathname.length - new URL(b).pathname.length,
          );
      } catch {
        fromSitemap = [];
      }
    }
    const home = normalizeCrawlUrl(`${origin}/`) ?? `${origin}/`;
    const queue = [...new Set([row.url, home, ...fromSitemap])];
    const p = parseProgress(row.progress);
    await db.assistSandbox.update({
      where: { id: row.id },
      data: {
        status: 'crawling',
        progress: progressJson({
          ...p,
          sitemap: fromSitemap.length > 0,
          found: queue.length,
          queue,
          next: 0,
        }),
      },
    });
  }

  private async crawlSome(row: SandboxRow, db: SandboxDb): Promise<void> {
    const p = parseProgress(row.progress);
    let read = row.pagesRead;
    let first = read === 0;
    const meta: {
      title?: string | null;
      lang?: string | null;
      themeColor?: string | null;
    } = {};
    for (
      let i = 0;
      i < PAGES_PER_POLL && p.next < p.queue.length && read < row.pagesLimit;
      i++
    ) {
      const url = p.queue[p.next++];
      const r = await this.fetcher.fetchPage(url, {
        purpose: 'assist-sandbox',
        db: crawlCacheFor(db),
        minDelayMsPerHost: this.minDelay(row),
      });
      if (!r.ok) {
        p.lastSkip = r.reason ?? 'http_4xx';
        continue;
      }
      const page = r.page;
      const saved = await db.assistSandboxPage.upsert({
        where: { sandboxId_url: { sandboxId: row.id, url: page.url } },
        create: {
          sandboxId: row.id,
          url: page.url,
          title: page.title,
          lang: page.lang,
          text: page.text,
          blocks: page.blocks as unknown as Prisma.InputJsonValue,
          contentHash: page.contentHash,
        },
        update: {},
      });
      void saved;
      read++;
      if (p.titles.length < 10)
        p.titles.push((page.title ?? new URL(page.url).pathname).slice(0, 120));
      // Название, язык и цвет — с главной (её «лицо»), иначе — с первой прочитанной.
      if (first || new URL(page.url).pathname === '/') {
        meta.title = page.title;
        meta.lang = page.lang;
        meta.themeColor = page.themeColor;
        first = false;
      }
      // Без sitemap — дальше по ссылкам того же хоста.
      if (!p.sitemap) {
        for (const l of page.links) {
          if (p.queue.length >= row.pagesLimit * 5) break;
          const n = normalizeCrawlUrl(l);
          if (n && new URL(n).hostname === row.host && !p.queue.includes(n))
            p.queue.push(n);
        }
      }
    }
    p.read = read;
    p.found = p.queue.length;
    const done = read >= row.pagesLimit || p.next >= p.queue.length;
    let status = row.status;
    let statusReason: string | null = row.statusReason;
    if (done) {
      if (read === 0) {
        const reason = p.lastSkip ?? 'no_pages';
        status =
          reason === 'opted_out' || reason === 'ssrf' ? 'blocked' : 'failed';
        statusReason = reason;
      } else status = 'indexing';
    }
    await db.assistSandbox.update({
      where: { id: row.id },
      data: {
        status,
        statusReason,
        pagesRead: read,
        progress: progressJson(p),
        ...(meta.title !== undefined ? { title: meta.title } : {}),
        ...(meta.lang !== undefined ? { lang: meta.lang } : {}),
        ...(meta.themeColor !== undefined
          ? { themeColor: meta.themeColor }
          : {}),
      },
    });
  }

  /** Деньги платформы: публичные — суточный потолок; кабинетные — лимит штук. */
  private async reserve(
    row: SandboxRow,
    db: SandboxDb,
    est: number,
  ): Promise<boolean> {
    if (row.kind !== 'public' || row.accountId !== null) return true;
    return bumpCounter(
      db,
      'sandbox-money',
      PUBLIC_MONEY_KEY,
      utcDay(this.now()),
      Math.max(Math.ceil(est), MIN_RESERVE_MICRO),
      publicDailyCapMicroUsd(this.env),
    );
  }

  private async settle(
    row: SandboxRow,
    db: SandboxDb,
    reserved: number,
    actual: number,
  ) {
    if (row.kind === 'public' && row.accountId === null) {
      await adjustCounter(
        db,
        'sandbox-money',
        PUBLIC_MONEY_KEY,
        utcDay(this.now()),
        actual - Math.max(Math.ceil(reserved), MIN_RESERVE_MICRO),
      );
    }
    if (actual > 0) {
      await db.$executeRaw(Prisma.sql`
        UPDATE "sites"."assist_sandboxes" SET "costMicroUsd" = "costMicroUsd" + ${Math.round(actual)}
        WHERE "id" = ${row.id}`);
    }
  }

  private async record(
    row: SandboxRow,
    db: SandboxDb,
    operation: SiteAiOperation,
    model: string,
    units: {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
    },
  ): Promise<number> {
    if (!model) return 0;
    const r = await this.usage.record(insertOnlyUsageDb(db), {
      accountId: row.accountId,
      siteId: row.siteId,
      operation,
      model,
      units,
    });
    return r.costMicroUsd;
  }

  /** indexing → ready: резка (K2), карантин инъекций (K2), эмбеддинги, 3 вопроса. */
  private async index(row: SandboxRow, db: SandboxDb): Promise<void> {
    const pages = await db.assistSandboxPage.findMany({
      where: { sandboxId: row.id },
      orderBy: { fetchedAt: 'asc' },
    });
    type Draft = {
      pageId: string;
      url: string;
      title: string | null;
      headingPath: string | null;
      lang: string | null;
      ordinal: number;
      text: string;
      tokens: number;
      contentHash: string;
      ugc: boolean;
      quarantineReason: string | null;
    };
    const drafts: Draft[] = [];
    let totalTokens = 0;
    for (const page of pages) {
      const blocks = Array.isArray(page.blocks) ? (page.blocks as never[]) : [];
      let pageTokens = 0;
      for (const c of chunkBlocks(blocks, {
        minTokens: KNOWLEDGE_DEFAULTS.chunkMinTokens,
        maxTokens: KNOWLEDGE_DEFAULTS.chunkMaxTokens,
        overlapTokens: KNOWLEDGE_DEFAULTS.chunkOverlapTokens,
        lang: page.lang,
      })) {
        if (
          pageTokens + c.tokens > SANDBOX_MAX_PAGE_TOKENS ||
          totalTokens + c.tokens > SANDBOX_MAX_TOKENS
        ) {
          break;
        }
        pageTokens += c.tokens;
        totalTokens += c.tokens;
        // Карантин — только текст владельца сайта: отзыв и так «не факт» (§4-тер.7).
        const verdict = c.ugc
          ? { quarantine: false, reason: null }
          : detectInjection(c.text);
        drafts.push({
          pageId: page.id,
          url: page.url,
          title: page.title,
          headingPath: c.headingPath,
          lang: c.lang,
          ordinal: c.ordinal,
          text: c.text,
          tokens: c.tokens,
          contentHash: c.contentHash,
          ugc: c.ugc,
          quarantineReason: verdict.quarantine
            ? (verdict.reason ?? 'injection')
            : null,
        });
      }
    }
    const toEmbed = drafts.filter((d) => !d.quarantineReason);
    const tokens = toEmbed.reduce((s, d) => s + d.tokens, 0);
    const est =
      estimateCost(KNOWLEDGE_DEFAULTS.embedModel, { inputTokens: tokens })
        .costMicroUsd +
      estimateCost(GEMINI_MODEL, { inputTokens: 3000, outputTokens: 300 })
        .costMicroUsd;
    if (!(await this.reserve(row, db, est))) {
      await db.assistSandbox.update({
        where: { id: row.id },
        data: { status: 'blocked', statusReason: 'budget' },
      });
      return;
    }
    let actual = 0;
    try {
      const vectors: number[][] = [];
      if (toEmbed.length > 0) {
        const r = await this.embedder.embed(
          toEmbed.map((d) => d.text),
          'document',
        );
        vectors.push(...r.vectors);
        actual += await this.record(row, db, 'assist-sandbox-embed', r.model, {
          inputTokens: r.inputTokens,
        });
      }
      const vec = new Map(toEmbed.map((d, i) => [d, vectors[i]]));
      await db.assistSandboxChunk.deleteMany({ where: { sandboxId: row.id } });
      for (const d of drafts) {
        const v = vec.get(d);
        const embedding = v
          ? Prisma.sql`CAST(${toVectorLiteral(v)} AS "extensions"."vector")`
          : Prisma.sql`NULL`;
        await db.$executeRaw(Prisma.sql`
          INSERT INTO "sites"."assist_sandbox_chunks"
            ("id","sandboxId","pageId","url","title","headingPath","lang","ordinal","text",
             "tokens","contentHash","ugc","quarantined","quarantineReason","embedModel","embedding","createdAt")
          VALUES (${randomUUID()}, ${row.id}, ${d.pageId}, ${d.url}, ${d.title}, ${d.headingPath},
                  ${d.lang}, ${d.ordinal}, ${d.text}, ${d.tokens}, ${d.contentHash}, ${d.ugc},
                  ${d.quarantineReason !== null}, ${d.quarantineReason},
                  ${v ? KNOWLEDGE_DEFAULTS.embedModel : null}, ${embedding}, now())`);
      }
      const lang = questionLang(
        toEmbed
          .map((d) => d.text)
          .join(' ')
          .slice(0, 2000),
        row.lang,
      );
      const seeds = toEmbed.filter((d) => !d.ugc);
      const q = await generateSuggestedQuestions(
        this.text,
        seeds,
        lang,
        SANDBOX_SUGGESTED,
      );
      if (q.usage) {
        actual += await this.record(
          row,
          db,
          'assist-sandbox-chat',
          q.usage.model,
          {
            inputTokens: q.usage.inputTokens,
            cachedInputTokens: q.usage.cachedInputTokens,
            outputTokens: q.usage.outputTokens,
          },
        );
      }
      await db.assistSandbox.update({
        where: { id: row.id },
        data: {
          status: toEmbed.length > 0 ? 'ready' : 'failed',
          statusReason: toEmbed.length > 0 ? null : 'empty',
          suggestedQuestions: q.questions,
        },
      });
    } finally {
      await this.settle(row, db, est, actual);
    }
  }

  // ── Чат ───────────────────────────────────────────────────────────────

  /** Гибридный поиск по фрагментам песочницы: вектор + полнотекст + триграмма → RRF. */
  private async searchSandbox(
    db: SandboxDb,
    sandboxId: string,
    question: string,
    queryVector: number[],
  ): Promise<SearchHit[]> {
    const k = KNOWLEDGE_DEFAULTS.search;
    const lit = toVectorLiteral(queryVector);
    // pgvector без iterative scan, но фрагментов песочницы — десятки:
    // точный перебор по sandboxId дешевле индекса.
    const vec = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "sites"."assist_sandbox_chunks"
      WHERE "sandboxId" = ${sandboxId} AND "embedding" IS NOT NULL AND NOT "quarantined"
      ORDER BY "embedding" OPERATOR("extensions".<=>) CAST(${lit} AS "extensions"."vector")
      LIMIT ${k.vectorTopK}`);
    const fts = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "sites"."assist_sandbox_chunks"
      WHERE "sandboxId" = ${sandboxId} AND "embedding" IS NOT NULL AND NOT "quarantined"
        AND to_tsvector('simple'::regconfig, "text") @@ websearch_to_tsquery('simple', ${question})
      ORDER BY ts_rank(to_tsvector('simple'::regconfig, "text"),
                       websearch_to_tsquery('simple', ${question})) DESC, "id"
      LIMIT ${k.textTopK}`);
    const trgm = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "sites"."assist_sandbox_chunks"
      WHERE "sandboxId" = ${sandboxId} AND "embedding" IS NOT NULL AND NOT "quarantined"
        AND "extensions".word_similarity(${question}, "text") > 0.3
      ORDER BY "extensions".word_similarity(${question}, "text") DESC, "id"
      LIMIT ${k.textTopK}`);
    const rank = (rows: Array<{ id: string }>) =>
      rows.map((r, i) => ({ id: r.id, rank: i + 1 }));
    const chunks = await db.assistSandboxChunk.findMany({
      where: {
        sandboxId,
        id: { in: [...new Set([...vec, ...fts, ...trgm].map((r) => r.id))] },
      },
    });
    const byId = new Map(chunks.map((c) => [c.id, c]));
    const merged = rrfMerge([rank(vec), rank(fts), rank(trgm)], {
      k: k.rrfK,
      limit: k.resultTopK,
      bonus: (id) => (byId.get(id)?.ugc ? -UGC_PENALTY : 0),
    });
    const vRank = new Map(vec.map((r, i) => [r.id, i + 1]));
    const tRank = new Map(fts.map((r, i) => [r.id, i + 1]));
    return merged
      .map((m) => {
        const c = byId.get(m.id);
        if (!c) return null;
        const hit: SearchHit = {
          chunkId: c.id,
          documentId: c.pageId,
          sourceType: 'page',
          url: c.url,
          title: c.title,
          headingPath: c.headingPath,
          text: c.text,
          lang: c.lang,
          ugc: c.ugc,
          score: m.score,
          vectorRank: vRank.get(c.id) ?? null,
          textRank: tRank.get(c.id) ?? null,
        };
        return hit;
      })
      .filter((h): h is SearchHit => h !== null);
  }

  private async chat(
    row: SandboxRow,
    db: SandboxDb,
    rawQuestion: string,
    accountId: string | null,
  ): Promise<SandboxAnswer> {
    const now = this.now();
    const question = rawQuestion
      .trim()
      .slice(0, SANDBOX_LIMITS.maxQuestionChars);
    if (!question) throw e1Error(400, 'URL_INVALID', 'Задайте вопрос');
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw e1Error(
        410,
        'SANDBOX_EXPIRED',
        'Песочница истекла — запустите новую',
      );
    }
    const from = accountId
      ? await this.answersFrom(accountId, row.siteId)
      : 'sandbox';
    if (from === 'sandbox' && row.status !== 'ready') {
      throw e1Error(
        409,
        'SANDBOX_NOT_READY',
        'Ещё читаем сайт — подождите немного',
      );
    }
    // Вопрос — атомарно (параллельные запросы не обходят лимит).
    const counted = await db.$queryRaw<
      Array<{ questions: number; questionsLimit: number }>
    >(
      Prisma.sql`
        UPDATE "sites"."assist_sandboxes" SET "questions" = "questions" + 1, "updatedAt" = now()
        WHERE "id" = ${row.id} AND "questions" < "questionsLimit"
        RETURNING "questions", "questionsLimit"`,
    );
    if (counted.length === 0) {
      throw e1Error(
        429,
        'SANDBOX_QUESTIONS_EXHAUSTED',
        'Вопросы песочницы закончились — подключите сайт, чтобы продолжить',
      );
    }
    const refundQuestion = () =>
      db.$executeRaw(Prisma.sql`
        UPDATE "sites"."assist_sandboxes" SET "questions" = GREATEST(0, "questions" - 1)
        WHERE "id" = ${row.id}`);
    const est = estimateCost(GEMINI_MODEL, CHAT_EST_UNITS).costMicroUsd || 5000;
    if (!(await this.reserve(row, db, est))) {
      await refundQuestion();
      throw e1Error(
        503,
        'SANDBOX_BUDGET',
        'Песочница сейчас недоступна — оставьте заявку',
      );
    }

    let actual = 0;
    try {
      let hits: SearchHit[];
      if (from === 'knowledge' && row.siteId) {
        hits = await this.siteKnowledge.search({
          siteId: row.siteId,
          query: question,
        });
      } else {
        const q = await this.embedder.embed([question], 'query');
        actual += await this.record(row, db, 'assist-sandbox-chat', q.model, {
          inputTokens: q.inputTokens,
        });
        const effective = row.reusedFromId ?? row.id;
        hits = await this.searchSandbox(db, effective, question, q.vectors[0]);
      }
      const ans = await this.answers.answer({
        question,
        hits,
        lang: row.lang,
        siteName: row.title,
      });
      actual += await this.record(row, db, 'assist-sandbox-chat', ans.model, {
        inputTokens: ans.inputTokens,
        cachedInputTokens: ans.cachedInputTokens,
        outputTokens: ans.outputTokens,
      });
      const sources: SandboxSourceRef[] = ans.sources.map((s) => ({
        n: s.n,
        url: s.url,
        title: s.title,
      }));
      // Журнал — с маскированием ПД (§4.7): вопрос анонима и ответ.
      await db.assistSandboxMessage.createMany({
        data: [
          {
            sandboxId: row.id,
            role: 'visitor',
            text: maskSensitiveEcho(question),
            createdAt: now,
          },
          {
            sandboxId: row.id,
            role: 'assistant',
            text: maskSensitiveEcho(ans.text),
            sources: sources as unknown as Prisma.InputJsonValue,
            createdAt: new Date(now.getTime() + 1),
          },
        ],
      });
      return {
        answer: ans.text,
        sources,
        refused: ans.refused,
        questionsLeft: Math.max(
          0,
          counted[0].questionsLimit - counted[0].questions,
        ),
      };
    } catch (e) {
      if (e instanceof TextModelError) {
        await refundQuestion();
        throw e1Error(
          503,
          'ANSWER_UNAVAILABLE',
          'Помощник сейчас не может ответить — попробуйте ещё раз',
        );
      }
      throw e;
    } finally {
      await this.settle(row, db, est, actual);
    }
  }

  // ── Вид для экрана ────────────────────────────────────────────────────

  private async view(
    row: SandboxRow,
    db: SandboxDb,
    answersFrom: 'sandbox' | 'knowledge',
  ): Promise<SandboxView> {
    const msgs = await db.assistSandboxMessage.findMany({
      where: { sandboxId: row.id },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const p = parseProgress(row.progress);
    const expired = row.expiresAt.getTime() <= this.now().getTime();
    const suggested = Array.isArray(row.suggestedQuestions)
      ? row.suggestedQuestions.filter((q): q is string => typeof q === 'string')
      : [];
    const messages: SandboxMessageView[] = msgs.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'visitor',
      text: m.text,
      sources: Array.isArray(m.sources)
        ? (m.sources as unknown as SandboxSourceRef[])
        : [],
      createdAt: m.createdAt.toISOString(),
    }));
    return {
      id: row.id,
      kind: row.kind === 'cabinet' ? 'cabinet' : 'public',
      status: expired ? 'expired' : (row.status as SandboxView['status']),
      statusReason: row.statusReason,
      url: row.url,
      host: row.host,
      title: row.title,
      lang: row.lang,
      themeColor: row.themeColor,
      progress: {
        sitemap: p.sitemap,
        found: p.found,
        read: p.read,
        titles: p.titles,
      },
      pagesRead: row.pagesRead,
      pagesLimit: row.pagesLimit,
      questions: row.questions,
      questionsLimit: row.questionsLimit,
      suggestedQuestions: suggested,
      messages,
      expiresAt: row.expiresAt.toISOString(),
      answersFrom,
    };
  }

  // ── Крон assist-retention ─────────────────────────────────────────────

  /**
   * Истёкшие песочницы — каскадом страницы, фрагменты, сообщения
   * (лендинг-ТЗ §6.3: 24 ч анонимно, 7 дней в кабинете); суточные
   * счётчики старше 2 дней. Системный клиент: у assist_public нет DELETE
   * на assist_sandboxes (и не нужно).
   */
  async retention(
    now = this.now(),
  ): Promise<{ sandboxesDeleted: number; countersDeleted: number }> {
    const sb = await this.prisma.assistSandbox.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    const cutoff = utcDay(new Date(now.getTime() - 2 * 86_400_000));
    const counters = await this.prisma.assistDailyCounter.deleteMany({
      where: { day: { lt: cutoff } },
    });
    return { sandboxesDeleted: sb.count, countersDeleted: counters.count };
  }
}
