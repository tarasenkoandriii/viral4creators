/**
 * Прогоны обхода сайта — K1 (ТЗ помощника §3.4, §4.14, §4-тер.2; QA общая).
 *
 * `requestRun` — продукт просит обход (дубль активного прогона того же
 * сайта и продукта не создаётся — возвращается существующий; гонка двух
 * запросов закрыта `pg_advisory_xact_lock` внутри короткой транзакции).
 * `tick(budgetMs)` — крон: берёт прогоны с lease (lockedUntil/attempts,
 * НЕ SKIP LOCKED — пулер Supabase в transaction-режиме, ТЗ §4.14), на
 * каждый — seed (главная + sitemap; для hot/urls — список), очередь
 * `site_crawl_queue` с поштучным lease, ≤ pagesPerTick страниц за заход,
 * только хосты сайта, подтверждённые для назначения продукта
 * (`evaluateHostAccess` — та же функция ядра, что в assertHostVerified;
 * opt-out проверяет fetcher на каждом запросе). Неподтверждённый хост
 * сайта или поддомен, найденный по ссылкам, — пропуск `unverified_host` с
 * перечнем хостов в stats. Пишет `site_pages`: contentHash/changedAt —
 * только при смене текста (или возвращении страницы в строй); `gone` —
 * 404/410 на ранее `ok`; 5xx/таймаут — повтор, затем `failed` с СОХРАНЁННЫМ
 * текстом (сбой сайта не стирает знания — ворота K2 рассчитаны на это).
 * `done` ставится последним, после записи всех страниц прогона: K2
 * индексирует только `done`.
 *
 * Только публичный обход: без cookie и сессии (У-9). Ничего не знает о
 * знаниях помощника: индексацию запускают сами конвейеры (K2), читая
 * завершённые прогоны и site_pages.
 *
 * Заход 10:
 *  - `excludeHosts` (Р-З10-10): хосты, которых прогон не касается вовсе —
 *    ни robots, ни sitemap, ни страниц; у прогонов `assist` хосты «Админки»
 *    (`assistRole = admin`) исключаются сами (Р-З9-24);
 *  - рендер SPA (Ш3 (20), Р-З10-20): страница-оболочка SPA прогона
 *    `assist` при подключённом порте (`spaRender` — браузерный воркер)
 *    ждёт рендера (строка очереди `render` → `rendering`), страница сайта
 *    до итога не трогается; итог разбирает ТОТ ЖЕ `extractPage` и пишет
 *    тот же `storePage` под арендой прогона (гонки с тиком нет), ссылки
 *    отрисованного меню идут в обход. Не поставлен (воркер выключен,
 *    суточный лимит), не удался, не дождались `RENDER_WAIT_MS` — прежний
 *    `skipped/spa`. `done` прогона — после итогов рендера.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  SiteCrawlQueueItem,
  SiteCrawlRun,
  SiteHost,
} from '@prisma/client';
import { CRAWL_DEFAULTS } from '../../config/assist-defaults';
import { PUBLIC_SITE_HOST } from '../site-core/ownership/host-roles';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { registrableDomain } from '../site-core/hosts/host-normalize';
import { uiMapKey } from '../site-core/ui-map/ui-map';
import { ingestUiSnapshot } from '../site-core/ui-map/ui-map-store';
import {
  evaluateHostAccess,
  HostPurpose,
} from '../site-core/ownership/host-access';
import { extractPage } from './extract/extractor';
import { PublicPageFetcher } from './page-fetcher';
import { RobotsService } from './robots';
import { SitemapService } from './sitemap';
import type {
  CrawlRequest,
  CrawlRunView,
  CrawlTickResult,
  ExtractedPage,
  SkipReason,
  SpaRenderPoll,
  SpaRenderPort,
  SpaRenderedPage,
} from './types';
import { hostOf, matchesExcluded, normalizeCrawlUrl } from './url';

type TenantDb = ReturnType<SitesDb['forAccount']>;

/** Параметры прогона в `site_crawl_runs.options`. */
interface RunOptions {
  urls?: string[];
  excludePrefixes?: string[];
  excludeUrls?: string[];
  excludeHosts?: string[];
}

/** Ш3 (20): задание рендера, которого прогон ждёт. */
interface RenderJobRef {
  id: string;
  /** Когда поставлено (ISO) — ждём не дольше `RENDER_WAIT_MS`. */
  at: string;
  urls: string[];
}

/** Ш3 (20): ход рендера SPA прогона (в `stats.render`). */
export interface CrawlRenderStats {
  jobs: RenderJobRef[];
  requested: number;
  rendered: number;
  failed: number;
  /** Почему остальные страницы не поставлены (воркер выключен, лимит). */
  refused?: string;
  /** Очередь сайта занята с этого момента (ISO) — ждём не дольше `RENDER_WAIT_MS`. */
  busySince?: string;
}

/** Сводка прогона в `site_crawl_runs.stats` (форма — для экрана и K2). */
export interface CrawlRunStats {
  seeded?: boolean;
  /** Сколько строк очереди поставлено к обходу (для лимита maxPages). */
  enqueued?: number;
  /** Не поставлено из-за лимита страниц. */
  limitDropped?: number;
  /** Хосты сайта/поддомены без подтверждения — не обходились. */
  unverifiedHosts?: string[];
  /** URL, найденных в sitemap. */
  sitemapUrls?: number;
  skippedByReason?: Partial<Record<SkipReason, number>>;
  langs?: Record<string, number>;
  errors?: number;
  lastError?: string;
  /** Р-З10-10: исключённые хосты сайта (не обходились вовсе). */
  excludedHosts?: string[];
  render?: CrawlRenderStats;
}

const ACTIVE = ['queued', 'running'];
const MAX_RUN_ERRORS = 5;
/** Прогон дольше — закрывается как failed (застрял, сайт «бесконечный»). */
const MAX_RUN_AGE_MS = 24 * 60 * 60 * 1000;
/** Запас до конца бюджета тика: последняя страница успевает записаться. */
const TICK_SAFETY_MS = 2_000;
const MAX_UNVERIFIED_LISTED = 50;
/** Ш3 (20): страниц в задании рендера (`WORKER_LIMITS.renderPages`). */
export const RENDER_PAGES_PER_JOB = 4;
/** Ш3 (20): дольше задание рендера (или занятая очередь) не ждём. */
export const RENDER_WAIT_MS = 2 * 60 * 60 * 1000;
/**
 * Аудит P3 (7): задание, которое никто не взял, при воркере без heartbeat
 * дольше этого — не ждём `RENDER_WAIT_MS`.
 */
export const RENDER_STALE_MS = 15 * 60 * 1000;
/**
 * Аудит P2-1 (по желанию): страницу, отрисованную недавно, не рендерим
 * снова — суточный лимит воркера тратится на новые страницы.
 */
export const RENDER_FRESH_MS = 6 * 60 * 60 * 1000;
/** Строки очереди: ждут постановки рендера / ждут итога задания. */
const RENDER = 'render';
const RENDERING = 'rendering';
const OPEN_ITEMS = ['pending', RENDER, RENDERING];

const PRIORITY = {
  seed: 1_000_000,
  hot: 900_000,
  sitemap: 500_000,
  link: 100_000,
};

function purposeFor(product: string): HostPurpose {
  return product === 'qa' ? 'qa-crawl' : 'assist-crawl';
}

function asStats(v: Prisma.JsonValue | null): CrawlRunStats {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? { ...(v as CrawlRunStats) }
    : {};
}

function asOptions(v: Prisma.JsonValue): RunOptions {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as RunOptions)
    : {};
}

type ItemOutcome =
  | { kind: 'changed' | 'unchanged' | 'gone' }
  | {
      kind: 'skipped';
      reason: SkipReason;
      /** Редирект: исходный URL — дубль, а текст записан под финальным. */
      stored?: 'changed' | 'unchanged';
    }
  | { kind: 'failed'; reason: SkipReason }
  | { kind: 'retry' }
  /** Ш3 (20): оболочка SPA — ждёт рендера, страница пока не трогается. */
  | { kind: 'render' };

interface RunCtx {
  run: SiteCrawlRun;
  db: TenantDb;
  opts: RunOptions;
  stats: CrawlRunStats;
  purpose: HostPurpose;
  /** Подтверждённые хосты сайта по имени. */
  verified: Map<string, SiteHost>;
  /** Все хосты сайта (имена) и их регистрируемые домены. */
  siteHostNames: Set<string>;
  siteDomains: Set<string>;
  unverified: Set<string>;
  /** Р-З10-10: строки хостов (https:443), которых прогон не касается. */
  excludedHostIds: Set<string>;
  /** Ш3 (20): оболочки SPA этого прогона рендерятся воркером. */
  render: boolean;
}

@Injectable()
export class SiteCrawlService {
  private readonly logger = new Logger(SiteCrawlService.name);
  /** Пауза между запросами к хосту; тесты ставят 0. */
  minDelayMsPerHost: number = CRAWL_DEFAULTS.minDelayMsPerHost;
  /** Отложенный повтор 5xx/таймаута (× номер попытки); тесты ставят 0. */
  retryBackoffMs = 30_000;
  /**
   * Только тесты: брать прогоны лишь этих кабинетов (наборы на общей базе
   * идут параллельно и не должны обходить чужие прогоны своим стендом).
   * В проде — null: крон обходит все кабинеты.
   */
  onlyAccountIds: string[] | null = null;
  /**
   * Ш3 (20): рендер SPA браузерным воркером. Вешает допущенный к очереди
   * воркера модуль (`assist-site-voice-map/voice-map-worker.knowledge-render.ts`);
   * нет — оболочки SPA, как раньше, `skipped/spa`.
   */
  spaRender: SpaRenderPort | null = null;

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly robots: RobotsService,
    private readonly sitemaps: SitemapService,
    private readonly fetcher: PublicPageFetcher,
  ) {}

  private system(): PrismaService {
    return this.sitesDb.system(
      'обход сайтов: прогоны и кэш robots/opt-out по всем кабинетам',
    );
  }

  async requestRun(
    req: CrawlRequest,
  ): Promise<{ runId: string; deduplicated: boolean }> {
    if (!Number.isInteger(req.maxPages) || req.maxPages <= 0) {
      throw new Error('requestRun: maxPages должен быть > 0');
    }
    if (req.mode !== 'full' && (!req.urls || req.urls.length === 0)) {
      throw new Error(`requestRun: режим ${req.mode} без urls`);
    }
    const site = await this.sitesDb
      .forAccount(req.accountId)
      .site.findFirst({ where: { id: req.siteId }, select: { id: true } });
    if (!site) throw new NotFoundException('Сайт не найден');

    const options: RunOptions = {};
    if (req.urls?.length) {
      options.urls = [
        ...new Set(
          req.urls
            .map((u) => normalizeCrawlUrl(u))
            .filter((u): u is string => !!u),
        ),
      ];
    }
    if (req.excludePrefixes?.length)
      options.excludePrefixes = req.excludePrefixes;
    if (req.excludeUrls?.length) options.excludeUrls = req.excludeUrls;
    if (req.excludeHosts?.length) {
      options.excludeHosts = [
        ...new Set(
          req.excludeHosts.map((h) =>
            h.trim().toLowerCase().replace(/\.$/, ''),
          ),
        ),
      ].filter(Boolean);
    }

    return this.system().$transaction(async (tx) => {
      // Два «переобойти» подряд (двойной клик, крон + кнопка) — один прогон.
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${`site-crawl:${req.siteId}:${req.product}`}))`;
      const active = await tx.siteCrawlRun.findMany({
        where: {
          accountId: req.accountId,
          siteId: req.siteId,
          product: req.product,
          status: { in: ACTIVE },
        },
        orderBy: { createdAt: 'desc' },
      });
      // Полный прогон покрывает и «горячие», и список URL; одинаковый режим — дубль.
      const covering = active.find(
        (r) => r.mode === 'full' || r.mode === req.mode,
      );
      if (covering) return { runId: covering.id, deduplicated: true };
      const run = await tx.siteCrawlRun.create({
        data: {
          accountId: req.accountId,
          siteId: req.siteId,
          product: req.product,
          trigger: req.trigger,
          mode: req.mode,
          maxPages: req.maxPages,
          options: options as Prisma.InputJsonValue,
          requestedByTelegramId: req.requestedByTelegramId ?? null,
        },
      });
      return { runId: run.id, deduplicated: false };
    });
  }

  async tick(budgetMs: number): Promise<CrawlTickResult> {
    const deadline = Date.now() + budgetMs;
    const out: CrawlTickResult = {
      runsTouched: 0,
      pagesFetched: 0,
      pagesChanged: 0,
      finishedRunIds: [],
      budgetExhausted: false,
    };
    const touched = new Set<string>();
    const stalled = new Set<string>();
    for (;;) {
      if (Date.now() >= deadline - TICK_SAFETY_MS) {
        out.budgetExhausted = true;
        break;
      }
      const run = await this.claimRun([...stalled]);
      if (!run) break;
      touched.add(run.id);
      let finished = false;
      try {
        const r = await this.processRun(run, deadline);
        out.pagesFetched += r.fetched;
        out.pagesChanged += r.changed;
        finished = r.finished;
        if (finished) out.finishedRunIds.push(run.id);
        // Прогон без продвижения (все URL на паузе повтора или под чужим
        // lease) в этом тике больше не берём — иначе крутились бы впустую.
        if (!finished && r.fetched === 0) stalled.add(run.id);
      } catch (e) {
        stalled.add(run.id);
        await this.recordRunError(run, e);
      } finally {
        if (!finished) {
          await this.system()
            .siteCrawlRun.updateMany({
              where: { id: run.id, status: 'running' },
              data: { lockedUntil: null },
            })
            .catch(() => undefined);
        }
      }
    }
    out.runsTouched = touched.size;
    return out;
  }

  /**
   * Retention очереди: строки завершённых прогонов старше `olderThan`.
   * Сводка пропусков к этому моменту уже лежит в `stats.skippedByReason`
   * прогона (пишется до статуса done), строки очереди больше не нужны.
   * Активные (queued/running) прогоны не трогаются никогда.
   */
  async purgeFinishedQueue(olderThan: Date): Promise<number> {
    const r = await this.system().siteCrawlQueueItem.deleteMany({
      where: {
        run: {
          status: { in: ['done', 'failed', 'cancelled'] },
          finishedAt: { lt: olderThan },
        },
      },
    });
    return r.count;
  }

  async getRun(accountId: string, runId: string): Promise<CrawlRunView | null> {
    const run = await this.sitesDb
      .forAccount(accountId)
      .siteCrawlRun.findFirst({
        where: { id: runId },
      });
    return run ? toRunView(run) : null;
  }

  async latestRun(
    accountId: string,
    siteId: string,
    product: 'assist' | 'qa',
  ): Promise<CrawlRunView | null> {
    const run = await this.sitesDb
      .forAccount(accountId)
      .siteCrawlRun.findFirst({
        where: { siteId, product },
        orderBy: { createdAt: 'desc' },
      });
    return run ? toRunView(run) : null;
  }

  // ── прогон ──────────────────────────────────────────────────────────

  /** Взять прогон под lease условным UPDATE (выигрывает один тик). */
  private async claimRun(skip: string[]): Promise<SiteCrawlRun | null> {
    const db = this.system();
    for (let attempt = 0; attempt < 5; attempt++) {
      const now = new Date();
      const free = {
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      };
      const candidate = await db.siteCrawlRun.findFirst({
        where: {
          status: { in: ACTIVE },
          id: { notIn: skip },
          ...(this.onlyAccountIds
            ? { accountId: { in: this.onlyAccountIds } }
            : {}),
          ...free,
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!candidate) return null;
      const claimed = await db.siteCrawlRun.updateMany({
        where: { id: candidate.id, status: { in: ACTIVE }, ...free },
        data: {
          lockedUntil: new Date(now.getTime() + CRAWL_DEFAULTS.leaseMs),
          attempts: { increment: 1 },
          status: 'running',
          startedAt: candidate.startedAt ?? now,
        },
      });
      if (claimed.count === 1) {
        return db.siteCrawlRun.findUnique({ where: { id: candidate.id } });
      }
    }
    return null;
  }

  private async recordRunError(run: SiteCrawlRun, e: unknown): Promise<void> {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    this.logger.error(`обход ${run.id}: ${msg}`);
    const stats = asStats(run.stats);
    stats.errors = (stats.errors ?? 0) + 1;
    stats.lastError = msg.slice(0, 500);
    const fatal = stats.errors >= MAX_RUN_ERRORS;
    await this.system()
      .siteCrawlRun.update({
        where: { id: run.id },
        data: {
          stats: stats as Prisma.InputJsonValue,
          ...(fatal
            ? {
                status: 'failed',
                error: stats.lastError,
                finishedAt: new Date(),
                lockedUntil: null,
              }
            : {}),
        },
      })
      .catch(() => undefined);
  }

  private async processRun(
    run: SiteCrawlRun,
    deadline: number,
  ): Promise<{ fetched: number; changed: number; finished: boolean }> {
    const db = this.sitesDb.forAccount(run.accountId);
    const now = new Date();
    if (
      run.startedAt &&
      now.getTime() - run.startedAt.getTime() > MAX_RUN_AGE_MS
    ) {
      await this.closeRun(run, db, 'failed', 'Обход не завершился за сутки');
      return { fetched: 0, changed: 0, finished: true };
    }
    const purpose = purposeFor(run.product);
    const hosts = await db.siteHost.findMany({ where: { siteId: run.siteId } });
    const verified = new Map<string, SiteHost>();
    for (const h of hosts) {
      if (h.scheme !== 'https' || h.port !== 443) continue;
      if (evaluateHostAccess(h, purpose, now).ok) verified.set(h.host, h);
    }
    const stats = asStats(run.stats);
    const opts = asOptions(run.options);
    // Р-З10-10: исключённые хосты — заданные продуктом и (для `assist`)
    // хосты «Админки» по роли хоста (Р-З9-24), без участия продукта.
    // Аудит P3 (2): решение — по СТРОКЕ хоста, которую обход обходит
    // (https:443), а не по имени: роль у `http://shop` (admin) не исключает
    // `https://shop` (public) того же имени.
    const byName = new Set(opts.excludeHosts ?? []);
    const excludedHostIds = new Set<string>();
    const excludedHosts = new Set<string>();
    for (const h of hosts) {
      if (h.scheme !== 'https' || h.port !== 443) continue;
      if (
        byName.has(h.host) ||
        (run.product === 'assist' &&
          h.assistRole !== PUBLIC_SITE_HOST.assistRole)
      ) {
        excludedHostIds.add(h.id);
        excludedHosts.add(h.host);
      }
    }
    const ctx: RunCtx = {
      run,
      db,
      opts,
      stats,
      purpose,
      verified,
      siteHostNames: new Set(hosts.map((h) => h.host)),
      siteDomains: new Set(
        hosts
          .map((h) => registrableDomain(h.host))
          .filter((d): d is string => !!d),
      ),
      unverified: new Set(stats.unverifiedHosts ?? []),
      excludedHostIds,
      render: run.product === 'assist' && this.spaRender !== null,
    };
    for (const h of hosts)
      if (!verified.has(h.host) && !excludedHostIds.has(h.id))
        this.noteUnverified(ctx, h.host);
    if (excludedHosts.size)
      stats.excludedHosts = [...excludedHosts].slice(0, MAX_UNVERIFIED_LISTED);

    if (![...verified.values()].some((h) => !excludedHostIds.has(h.id))) {
      // Нечего обходить: подтверждение отозвано/истекло или его не было.
      await this.saveStats(ctx);
      await this.closeRun(run, db, 'failed', 'Нет подтверждённых хостов сайта');
      return { fetched: 0, changed: 0, finished: true };
    }

    if (!stats.seeded) {
      await this.seed(ctx);
      stats.seeded = true;
      await this.saveStats(ctx);
    }

    let fetched = 0;
    let changed = 0;
    while (
      Date.now() < deadline - TICK_SAFETY_MS &&
      fetched < CRAWL_DEFAULTS.pagesPerTick
    ) {
      const items = await this.claimItems(
        ctx,
        CRAWL_DEFAULTS.pagesPerTick - fetched,
      );
      if (items.length === 0) break;
      for (const item of items) {
        if (Date.now() >= deadline - TICK_SAFETY_MS) {
          // Не успеваем — отдаём строку следующему тику без штрафа попыткой.
          await db.siteCrawlQueueItem.updateMany({
            where: { id: item.id, status: 'pending' },
            data: { lockedUntil: null, attempts: { decrement: 1 } },
          });
          continue;
        }
        const outcome = await this.processItem(ctx, item);
        if (outcome.kind !== 'retry') fetched++;
        if (
          outcome.kind === 'changed' ||
          (outcome.kind === 'skipped' && outcome.stored === 'changed')
        ) {
          changed++;
        }
        await this.applyOutcome(ctx, item, outcome);
      }
    }
    changed += await this.renderStep(ctx);
    await this.saveStats(ctx);
    const finished = await this.maybeFinish(ctx);
    return { fetched, changed, finished };
  }

  // ── рендер SPA (Ш3 (20)) ────────────────────────────────────────────

  /**
   * Под арендой прогона: итоги поставленных заданий → страницы (тот же
   * `extractPage` + `storePage`), затем — когда обычные страницы прогона
   * кончились — постановка новых пачками по хосту. Возвращает число
   * изменённых страниц.
   */
  private async renderStep(ctx: RunCtx): Promise<number> {
    const port = this.spaRender;
    const st: CrawlRenderStats = ctx.stats.render ?? {
      jobs: [],
      requested: 0,
      rendered: 0,
      failed: 0,
    };
    const now = Date.now();
    let changed = 0;
    const left: RenderJobRef[] = [];
    for (const job of st.jobs) {
      const res: SpaRenderPoll = port
        ? await port
            .poll(ctx.run.accountId, job.id)
            .catch(() => ({ status: 'waiting' as const }))
        : { status: 'failed' as const };
      if (res.status === 'waiting') {
        const age = now - Date.parse(job.at);
        // Никто не взял, а воркер давно молчит — не держим прогон 2 ч.
        const stale =
          !res.claimed &&
          age > RENDER_STALE_MS &&
          !(await port!.workerAlive(RENDER_STALE_MS).catch(() => false));
        if (age <= RENDER_WAIT_MS && !stale) {
          left.push(job);
          continue;
        }
        await port?.cancel(ctx.run.accountId, job.id).catch(() => undefined);
        st.failed += await this.renderFallback(ctx, job.urls);
        continue;
      }
      if (res.status === 'failed') {
        st.failed += await this.renderFallback(ctx, job.urls);
        await port?.release(ctx.run.accountId, job.id).catch(() => undefined);
        continue;
      }
      const r = await this.ingestRendered(ctx, job.urls, res.pages);
      st.rendered += r.rendered;
      st.failed += r.failed;
      changed += r.changed;
      // HTML разобран — в очереди больше не нужен (аудит P3 (6)).
      await port?.release(ctx.run.accountId, job.id).catch(() => undefined);
    }
    st.jobs = left;
    // Сводка — только у прогонов, где рендер был (или ещё будет).
    ctx.stats.render = st;

    // Новые — когда обычные страницы прогона кончились (пачки полнее).
    const pending = await ctx.db.siteCrawlQueueItem.count({
      where: { runId: ctx.run.id, status: 'pending' },
    });
    if (pending > 0) return changed;
    const waiting = await ctx.db.siteCrawlQueueItem.findMany({
      where: { runId: ctx.run.id, status: RENDER },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 50,
    });
    if (!waiting.length) {
      if (!st.requested && !st.failed && !st.jobs.length)
        delete ctx.stats.render;
      return changed;
    }
    if (!port || st.refused) {
      st.failed += await this.renderFallback(
        ctx,
        waiting.map((w) => w.url),
      );
      return changed;
    }
    const requested = new Set<string>();
    const byHost = new Map<string, SiteCrawlQueueItem[]>();
    for (const w of waiting) {
      const list = byHost.get(w.hostId) ?? [];
      list.push(w);
      byHost.set(w.hostId, list);
    }
    for (const [hostId, rows] of byHost) {
      const host = [...ctx.verified.values()].find((h) => h.id === hostId);
      for (let i = 0; i < rows.length; i += RENDER_PAGES_PER_JOB) {
        const chunk = rows.slice(i, i + RENDER_PAGES_PER_JOB);
        const urls = chunk.map((c) => c.url);
        if (!host || ctx.excludedHostIds.has(host.id)) {
          st.failed += await this.renderFallback(ctx, urls);
          continue;
        }
        const t = await port
          .request({
            accountId: ctx.run.accountId,
            siteId: ctx.run.siteId,
            hostId,
            host: host.host,
            runId: ctx.run.id,
            urls,
          })
          .catch(() => ({ refused: 'error' as const }));
        if ('jobId' in t) {
          delete st.busySince;
          await ctx.db.siteCrawlQueueItem.updateMany({
            where: { runId: ctx.run.id, url: { in: urls }, status: RENDER },
            data: { status: RENDERING, lockedUntil: null },
          });
          st.jobs.push({ id: t.jobId, at: new Date(now).toISOString(), urls });
          st.requested += urls.length;
          for (const u of urls) requested.add(u);
          continue;
        }
        if ('retry' in t) {
          // Очередь сайта занята — следующий тик; не дольше RENDER_WAIT_MS.
          st.busySince = st.busySince ?? new Date(now).toISOString();
          if (now - Date.parse(st.busySince) <= RENDER_WAIT_MS) return changed;
          st.refused = 'busy';
        } else {
          st.refused = t.refused;
        }
        // Сегодня больше не поставится — остальные страницы как раньше.
        st.failed += await this.renderFallback(
          ctx,
          waiting.filter((w) => !requested.has(w.url)).map((w) => w.url),
        );
        return changed;
      }
    }
    return changed;
  }

  /**
   * Рендер не случился. Страница с сохранённым текстом (отрисована раньше) —
   * как при 5xx: `failed` с ПРЕЖНИМ текстом (сбой рендера знания не
   * стирает, аудит P2-1); без текста — как раньше, `skipped/spa`.
   */
  private async renderFallback(ctx: RunCtx, urls: string[]): Promise<number> {
    if (!urls.length) return 0;
    const rows = await ctx.db.siteCrawlQueueItem.findMany({
      where: {
        runId: ctx.run.id,
        url: { in: urls },
        status: { in: [RENDER, RENDERING] },
      },
    });
    for (const row of rows) {
      const host = ctx.verified.get(hostOf(row.url));
      if (!host || host.id !== row.hostId) {
        await this.applyOutcome(ctx, row, {
          kind: 'skipped',
          reason: 'unverified_host',
        });
        continue;
      }
      const existing = await ctx.db.sitePage.findFirst({
        where: { hostId: host.id, url: row.url },
      });
      if (
        existing &&
        existing.text &&
        (existing.status === 'ok' || existing.status === 'failed')
      ) {
        await ctx.db.sitePage.update({
          where: { id: existing.id },
          data: {
            status: 'failed',
            skipReason: 'spa',
            failCount: { increment: 1 },
          },
        });
        await this.applyOutcome(ctx, row, { kind: 'failed', reason: 'spa' });
        continue;
      }
      await this.markSkipped(ctx, row, host, existing, 'spa', 200);
      await this.applyOutcome(ctx, row, { kind: 'skipped', reason: 'spa' });
    }
    return rows.length;
  }

  /** Итог задания рендера → страницы прогона (адреса — из запроса). */
  private async ingestRendered(
    ctx: RunCtx,
    urls: string[],
    pages: SpaRenderedPage[],
  ): Promise<{ rendered: number; failed: number; changed: number }> {
    const out = { rendered: 0, failed: 0, changed: 0 };
    const got = new Map<string, SpaRenderedPage>();
    for (const p of pages) {
      const url = Number.isInteger(p.i) ? urls[p.i] : undefined;
      if (url && !got.has(url)) got.set(url, p);
    }
    const lost: string[] = [];
    for (const url of urls) {
      const pg = got.get(url);
      const item = await ctx.db.siteCrawlQueueItem.findFirst({
        where: { runId: ctx.run.id, url, status: RENDERING },
      });
      if (!item) continue;
      const host = ctx.verified.get(hostOf(url));
      if (
        !pg?.ok ||
        !pg.html ||
        !host ||
        host.id !== item.hostId ||
        ctx.excludedHostIds.has(host.id) ||
        matchesExcluded(
          url,
          ctx.opts.excludePrefixes ?? [],
          ctx.opts.excludeUrls ?? [],
        )
      ) {
        lost.push(url);
        continue;
      }
      // Тот же извлекатель, что у обычного обхода: блоки, путь
      // заголовков, UGC, FAQ, noindex, canonical, язык, хеш.
      const page = extractPage(pg.html, url);
      page.url = url;
      const links = new Set(page.links);
      for (const l of pg.links) {
        const n = normalizeCrawlUrl(l);
        if (n) links.add(n);
      }
      page.links = [...links];
      const existing = await ctx.db.sitePage.findFirst({
        where: { hostId: host.id, url },
      });
      let outcome: ItemOutcome;
      if (page.noindex) {
        await this.markSkipped(ctx, item, host, existing, 'noindex', 200);
        outcome = { kind: 'skipped', reason: 'noindex' };
      } else if (!page.text) {
        lost.push(url);
        continue;
      } else {
        outcome = await this.storePage(
          ctx,
          item,
          host,
          existing,
          page,
          // Оболочка SPA та же при новых данных — условный запрос по её
          // ETag скрыл бы изменения: валидаторы не храним.
          { httpStatus: 200, etag: null, lastModified: null },
          { uiMap: false },
        );
      }
      await this.applyOutcome(ctx, item, outcome);
      out.rendered += 1;
      if (
        outcome.kind === 'changed' ||
        (outcome.kind === 'skipped' && outcome.stored === 'changed')
      )
        out.changed += 1;
    }
    out.failed += await this.renderFallback(ctx, lost);
    return out;
  }

  private noteUnverified(ctx: RunCtx, host: string): void {
    if (
      ctx.unverified.has(host) ||
      ctx.unverified.size >= MAX_UNVERIFIED_LISTED
    )
      return;
    ctx.unverified.add(host);
  }

  /** Главная + sitemap каждого подтверждённого хоста; для hot/urls — список. */
  private async seed(ctx: RunCtx): Promise<void> {
    const { run } = ctx;
    if (run.mode === 'full') {
      for (const host of ctx.verified.values()) {
        // Р-З10-10: исключённый хост — ни главной, ни robots, ни sitemap.
        if (ctx.excludedHostIds.has(host.id)) continue;
        const origin = `https://${host.host}`;
        await this.enqueue(ctx, [
          {
            url: `${origin}/`,
            depth: 0,
            source: 'seed',
            priority: PRIORITY.seed,
          },
        ]);
        const rules = await this.robots.rulesFor(origin, this.system());
        const entries = await this.sitemaps.discover(
          origin,
          rules,
          run.maxPages,
        );
        ctx.stats.sitemapUrls = (ctx.stats.sitemapUrls ?? 0) + entries.length;
        await this.enqueue(
          ctx,
          entries.map((e, i) => ({
            url: e.url,
            depth: 0,
            source: 'sitemap',
            // lastmod задаёт ПОРЯДОК (§4-тер.2): discover уже отсортировал.
            priority: PRIORITY.sitemap - i,
          })),
        );
      }
      return;
    }
    const source = run.mode === 'hot' ? 'hot' : 'manual';
    await this.enqueue(
      ctx,
      (ctx.opts.urls ?? []).map((url) => ({
        url,
        depth: 0,
        source,
        priority: PRIORITY.hot,
      })),
    );
  }

  /**
   * В очередь: только хосты из подтверждённых; исключённые — сразу
   * `skipped/excluded` (обход их не берёт вовсе, §4-тер.12); сверх
   * maxPages — не ставятся (`limit`).
   */
  private async enqueue(
    ctx: RunCtx,
    items: Array<{
      url: string;
      depth: number;
      source: string;
      priority: number;
    }>,
  ): Promise<void> {
    const rows: Prisma.SiteCrawlQueueItemCreateManyInput[] = [];
    const seen = new Set<string>();
    let room = ctx.run.maxPages - (ctx.stats.enqueued ?? 0);
    for (const it of items) {
      const url = normalizeCrawlUrl(it.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const host = ctx.verified.get(hostOf(url));
      if (!host) {
        const name = hostOf(url);
        const d = registrableDomain(name);
        // Чужой сайт по ссылке — не наш вопрос; поддомен/хост этого сайта — пропуск с причиной.
        if (ctx.siteHostNames.has(name) || (d && ctx.siteDomains.has(d))) {
          this.noteUnverified(ctx, name);
        }
        continue;
      }
      const excluded =
        ctx.excludedHostIds.has(host.id) ||
        matchesExcluded(
          url,
          ctx.opts.excludePrefixes ?? [],
          ctx.opts.excludeUrls ?? [],
        );
      if (!excluded && room <= 0) {
        ctx.stats.limitDropped = (ctx.stats.limitDropped ?? 0) + 1;
        continue;
      }
      rows.push({
        accountId: ctx.run.accountId,
        runId: ctx.run.id,
        siteId: ctx.run.siteId,
        hostId: host.id,
        url,
        depth: it.depth,
        priority: it.priority,
        source: it.source,
        status: excluded ? 'skipped' : 'pending',
        lastError: excluded ? 'excluded' : null,
      });
      if (!excluded) room--;
    }
    if (rows.length === 0) return;
    // Уже стоящие в очереди URL (ссылка на ту же страницу) — не дубли.
    const existing = await ctx.db.siteCrawlQueueItem.findMany({
      where: { runId: ctx.run.id, url: { in: rows.map((r) => r.url) } },
      select: { url: true },
    });
    const have = new Set(existing.map((e) => e.url));
    const fresh = rows.filter((r) => !have.has(r.url));
    if (fresh.length === 0) return;
    const res = await ctx.db.siteCrawlQueueItem.createMany({
      data: fresh,
      skipDuplicates: true,
    });
    const pending = fresh.filter((r) => r.status === 'pending').length;
    // Гонки здесь нет (прогон под lease одного тика); skipDuplicates — страховка.
    ctx.stats.enqueued =
      (ctx.stats.enqueued ?? 0) + Math.min(pending, res.count);
  }

  private async claimItems(
    ctx: RunCtx,
    n: number,
  ): Promise<SiteCrawlQueueItem[]> {
    const now = new Date();
    const free = { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] };
    const candidates = await ctx.db.siteCrawlQueueItem.findMany({
      where: { runId: ctx.run.id, status: 'pending', ...free },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: n,
    });
    const claimed: SiteCrawlQueueItem[] = [];
    for (const c of candidates) {
      if (c.attempts >= CRAWL_DEFAULTS.maxAttempts) {
        // Попытки кончились на упавших тиках (lease истёк без итога).
        await ctx.db.siteCrawlQueueItem.updateMany({
          where: { id: c.id, status: 'pending' },
          data: { status: 'failed', lastError: 'timeout', lockedUntil: null },
        });
        await this.bump(ctx, 'pagesFailed');
        continue;
      }
      const r = await ctx.db.siteCrawlQueueItem.updateMany({
        where: { id: c.id, status: 'pending', ...free },
        data: {
          lockedUntil: new Date(now.getTime() + CRAWL_DEFAULTS.leaseMs),
          attempts: { increment: 1 },
        },
      });
      if (r.count === 1) claimed.push({ ...c, attempts: c.attempts + 1 });
    }
    return claimed;
  }

  private async processItem(
    ctx: RunCtx,
    item: SiteCrawlQueueItem,
  ): Promise<ItemOutcome> {
    const host = ctx.verified.get(hostOf(item.url));
    if (!host || host.id !== item.hostId) {
      // Подтверждение отозвали посреди прогона.
      this.noteUnverified(ctx, hostOf(item.url));
      return { kind: 'skipped', reason: 'unverified_host' };
    }
    if (
      ctx.excludedHostIds.has(host.id) ||
      matchesExcluded(
        item.url,
        ctx.opts.excludePrefixes ?? [],
        ctx.opts.excludeUrls ?? [],
      )
    ) {
      return { kind: 'skipped', reason: 'excluded' };
    }
    const existing = await ctx.db.sitePage.findFirst({
      where: { hostId: host.id, url: item.url },
    });
    const serving = existing?.status === 'ok' && !!existing.contentHash;
    const res = await this.fetcher.fetchPage(item.url, {
      purpose: ctx.purpose,
      db: this.system(),
      conditional: serving
        ? { etag: existing!.etag, lastModified: existing!.lastModified }
        : undefined,
      minDelayMsPerHost: this.minDelayMsPerHost,
    });
    const now = new Date();

    if (!res.ok && res.notModified) {
      if (!existing) return { kind: 'skipped', reason: 'empty' };
      await ctx.db.sitePage.update({
        where: { id: existing.id },
        data: { fetchedAt: now, failCount: 0, httpStatus: 304 },
      });
      return { kind: 'unchanged' };
    }

    if (res.ok)
      return this.storePage(ctx, item, host, existing, res.page, {
        httpStatus: res.httpStatus,
        etag: res.etag,
        lastModified: res.lastModified,
      });

    const reason = res.reason ?? 'empty';
    const status = res.httpStatus ?? null;
    // Ш3 (20): оболочка SPA — ждёт рендера; страница (и прежний текст
    // отрисованной версии) до итога не трогается.
    if (reason === 'spa' && ctx.render) {
      // Отрисована недавно — текст свежий, лимит воркера не тратим.
      if (
        existing?.status === 'ok' &&
        existing.text &&
        existing.fetchedAt &&
        now.getTime() - existing.fetchedAt.getTime() < RENDER_FRESH_MS
      )
        return { kind: 'unchanged' };
      return { kind: 'render' };
    }
    if (
      reason === 'http_4xx' &&
      (status === 404 || status === 410) &&
      existing &&
      existing.status !== 'skipped'
    ) {
      if (existing.status === 'gone') {
        await ctx.db.sitePage.update({
          where: { id: existing.id },
          data: { fetchedAt: now, httpStatus: status },
        });
        return { kind: 'skipped', reason: 'http_4xx' };
      }
      await ctx.db.sitePage.update({
        where: { id: existing.id },
        data: {
          status: 'gone',
          goneAt: now,
          fetchedAt: now,
          httpStatus: status,
          changedAt: now,
        },
      });
      return { kind: 'gone' };
    }
    if (reason === 'http_5xx' || reason === 'timeout') {
      if (item.attempts < CRAWL_DEFAULTS.maxAttempts) return { kind: 'retry' };
      if (existing) {
        // Текст и хеш остаются: упавший сайт не должен стереть знания.
        await ctx.db.sitePage.update({
          where: { id: existing.id },
          data: {
            status: existing.status === 'gone' ? 'gone' : 'failed',
            skipReason: reason,
            failCount: { increment: 1 },
            fetchedAt: now,
            httpStatus: status,
          },
        });
      } else {
        await this.createPage(ctx, item, host, {
          status: 'failed',
          skipReason: reason,
          httpStatus: status,
          failCount: 1,
        });
      }
      return { kind: 'failed', reason };
    }
    await this.markSkipped(ctx, item, host, existing, reason, status);
    return { kind: 'skipped', reason };
  }

  private async storePage(
    ctx: RunCtx,
    item: SiteCrawlQueueItem,
    host: SiteHost,
    existing: Awaited<ReturnType<TenantDb['sitePage']['findFirst']>>,
    page: ExtractedPage,
    meta: {
      httpStatus: number;
      etag: string | null;
      lastModified: string | null;
    },
    opts: { uiMap: boolean } = { uiMap: true },
  ): Promise<ItemOutcome> {
    const now = new Date();
    let target = existing;
    // Редирект в пределах хоста (`/old` → `/new`): страница живёт под
    // финальным URL, исходный помечается дублем.
    let redirected = false;
    if (page.url !== item.url) {
      const finalRow = await ctx.db.siteCrawlQueueItem.findFirst({
        where: { runId: ctx.run.id, url: page.url },
        select: { id: true, status: true },
      });
      await this.markSkipped(
        ctx,
        item,
        host,
        existing,
        'duplicate',
        meta.httpStatus,
        page.url,
      );
      if (finalRow && finalRow.status !== 'pending') {
        return { kind: 'skipped', reason: 'duplicate' };
      }
      // Финальный URL обработан здесь — его строка очереди закрывается
      // (не тянуть второй раз), а исходный URL всегда считается дублем:
      // итог прогона не зависит от того, что в очереди стояло раньше.
      if (finalRow) {
        await ctx.db.siteCrawlQueueItem.updateMany({
          where: { id: finalRow.id, status: 'pending' },
          data: { status: 'done', lastError: null, lockedUntil: null },
        });
      } else {
        await ctx.db.siteCrawlQueueItem.createMany({
          data: [
            {
              accountId: ctx.run.accountId,
              runId: ctx.run.id,
              siteId: ctx.run.siteId,
              hostId: host.id,
              url: page.url,
              depth: item.depth,
              source: item.source,
              status: 'done',
            },
          ],
          skipDuplicates: true,
        });
      }
      redirected = true;
      target = await ctx.db.sitePage.findFirst({
        where: { hostId: host.id, url: page.url },
      });
    }
    // canonical на другую страницу того же сайта — эта страница дубль.
    if (
      page.canonical &&
      page.canonical !== page.url &&
      ctx.verified.get(hostOf(page.canonical))
    ) {
      await this.markSkipped(
        ctx,
        item,
        host,
        target,
        'duplicate',
        meta.httpStatus,
      );
      await this.enqueue(ctx, [
        {
          url: page.canonical,
          depth: item.depth,
          source: 'link',
          priority: PRIORITY.link - item.depth,
        },
      ]);
      return { kind: 'skipped', reason: 'duplicate' };
    }
    // Тот же текст уже записан в этом прогоне под другим URL.
    const twin = await ctx.db.sitePage.findFirst({
      where: {
        siteId: ctx.run.siteId,
        contentHash: page.contentHash,
        status: 'ok',
        url: { not: page.url },
        fetchedAt: { gte: ctx.run.startedAt ?? ctx.run.createdAt },
      },
      select: { id: true },
    });
    if (twin) {
      await this.markSkipped(
        ctx,
        item,
        host,
        target,
        'duplicate',
        meta.httpStatus,
      );
      return { kind: 'skipped', reason: 'duplicate' };
    }

    const wasServing = target?.status === 'ok' || target?.status === 'failed';
    const changed =
      !target || !wasServing || target.contentHash !== page.contentHash;
    const data = {
      status: 'ok',
      skipReason: null,
      finalUrl: null,
      httpStatus: meta.httpStatus,
      title: page.title,
      lang: page.lang,
      text: page.text,
      blocks: page.blocks as unknown as Prisma.InputJsonValue,
      contentHash: page.contentHash,
      etag: meta.etag,
      lastModified: meta.lastModified,
      fetchedAt: now,
      failCount: 0,
      goneAt: null,
      ...(changed ? { changedAt: now } : {}),
    };
    if (target) {
      await ctx.db.sitePage.update({ where: { id: target.id }, data });
    } else {
      await ctx.db.sitePage.create({
        data: {
          ...data,
          accountId: ctx.run.accountId,
          siteId: ctx.run.siteId,
          hostId: host.id,
          url: page.url,
          source: item.source,
          depth: item.depth,
          changedAt: now,
        },
      });
    }
    // Рендер SPA (Ш3 (20)) карту интерфейса не пишет: «очищенный» HTML без
    // кнопок и полей снял бы снимок обхода этой страницы.
    if (opts.uiMap) await this.storeUiMap(ctx, host, page, now);
    if (page.lang) {
      ctx.stats.langs = ctx.stats.langs ?? {};
      ctx.stats.langs[page.lang] = (ctx.stats.langs[page.lang] ?? 0) + 1;
    }
    if (ctx.run.mode === 'full' && item.depth < CRAWL_DEFAULTS.maxLinkDepth) {
      await this.enqueue(
        ctx,
        page.links.map((url) => ({
          url,
          depth: item.depth + 1,
          source: 'link',
          priority: PRIORITY.link - (item.depth + 1) * 1000,
        })),
      );
    }
    if (redirected) {
      return {
        kind: 'skipped',
        reason: 'duplicate',
        stored: changed ? 'changed' : 'unchanged',
      };
    }
    return { kind: changed ? 'changed' : 'unchanged' };
  }

  /**
   * Э6 (§4.12): карта интерфейса страницы — источник `crawl`, вид `any`
   * (браузера у обхода нет). Э-С Ш4: общая дверь `ingestUiSnapshot` —
   * версия и история при новом наборе, слияние с обучалкой и QA по
   * стабильному ключу; обход только отмечает «видели» (`lastSeenAt`), а
   * промахи посетителей не снимает (разметка ≠ видимость). Нет элементов —
   * снимок обхода снимается. Сбой записи карты (в т.ч. потолок страниц
   * карты) прогон не роняет: знания важнее подсветки.
   */
  private async storeUiMap(
    ctx: RunCtx,
    host: SiteHost,
    page: ExtractedPage,
    now: Date,
  ): Promise<void> {
    const key = uiMapKey(page.url);
    if (!key) return;
    try {
      await ingestUiSnapshot(ctx.db, {
        accountId: ctx.run.accountId,
        siteId: ctx.run.siteId,
        hostId: host.id,
        host: key.host,
        path: key.path,
        source: 'crawl',
        viewport: 'any',
        elements: page.uiElements ?? [],
        now,
      });
    } catch (e) {
      this.logger.warn(
        `карта интерфейса ${key.host}${key.path}: ${e instanceof Error ? e.name : 'error'}`,
      );
    }
  }

  /** Страница пропущена: текст убираем — пропущенное не должно попасть в знания. */
  private async markSkipped(
    ctx: RunCtx,
    item: SiteCrawlQueueItem,
    host: SiteHost,
    existing: Awaited<ReturnType<TenantDb['sitePage']['findFirst']>>,
    reason: SkipReason,
    httpStatus: number | null,
    finalUrl?: string,
  ): Promise<void> {
    const now = new Date();
    if (existing) {
      const wasServing =
        existing.status === 'ok' || existing.status === 'failed';
      await ctx.db.sitePage.update({
        where: { id: existing.id },
        data: {
          status: 'skipped',
          skipReason: reason,
          httpStatus,
          fetchedAt: now,
          text: null,
          blocks: Prisma.DbNull,
          contentHash: null,
          ...(finalUrl ? { finalUrl } : {}),
          ...(wasServing ? { changedAt: now } : {}),
        },
      });
      return;
    }
    await this.createPage(ctx, item, host, {
      status: 'skipped',
      skipReason: reason,
      httpStatus,
      finalUrl: finalUrl ?? null,
    });
  }

  private async createPage(
    ctx: RunCtx,
    item: SiteCrawlQueueItem,
    host: SiteHost,
    data: {
      status: string;
      skipReason: string;
      httpStatus: number | null;
      failCount?: number;
      finalUrl?: string | null;
    },
  ): Promise<void> {
    await ctx.db.sitePage.create({
      data: {
        accountId: ctx.run.accountId,
        siteId: ctx.run.siteId,
        hostId: host.id,
        url: item.url,
        source: item.source,
        depth: item.depth,
        fetchedAt: new Date(),
        ...data,
      },
    });
  }

  private async applyOutcome(
    ctx: RunCtx,
    item: SiteCrawlQueueItem,
    o: ItemOutcome,
  ): Promise<void> {
    const db = ctx.db;
    if (o.kind === 'render') {
      await db.siteCrawlQueueItem.update({
        where: { id: item.id },
        data: { status: RENDER, lastError: 'spa', lockedUntil: null },
      });
      return;
    }
    if (o.kind === 'retry') {
      await db.siteCrawlQueueItem.update({
        where: { id: item.id },
        data: {
          lockedUntil: new Date(
            Date.now() + this.retryBackoffMs * item.attempts,
          ),
          lastError: 'retry',
        },
      });
      return;
    }
    const status =
      o.kind === 'skipped'
        ? 'skipped'
        : o.kind === 'failed'
          ? 'failed'
          : 'done';
    const lastError =
      o.kind === 'skipped' || o.kind === 'failed'
        ? o.reason
        : o.kind === 'gone'
          ? 'gone'
          : null;
    await db.siteCrawlQueueItem.update({
      where: { id: item.id },
      data: { status, lastError, lockedUntil: null },
    });
    if (o.kind === 'skipped' && o.stored) {
      await this.bump(
        ctx,
        o.stored === 'changed' ? 'pagesChanged' : 'pagesUnchanged',
      );
    }
    if (o.kind === 'changed') await this.bump(ctx, 'pagesChanged');
    else if (o.kind === 'unchanged') await this.bump(ctx, 'pagesUnchanged');
    else if (o.kind === 'gone') await this.bump(ctx, 'pagesGone');
    else if (o.kind === 'failed') await this.bump(ctx, 'pagesFailed');
  }

  private async bump(
    ctx: RunCtx,
    field: 'pagesChanged' | 'pagesUnchanged' | 'pagesGone' | 'pagesFailed',
  ): Promise<void> {
    await ctx.db.siteCrawlRun.update({
      where: { id: ctx.run.id },
      data: { [field]: { increment: 1 } },
    });
  }

  /** Пропуски по причинам: очередь + хосты без подтверждения + лимит. */
  private async skippedByReason(
    ctx: RunCtx,
  ): Promise<Partial<Record<SkipReason, number>>> {
    const groups = await ctx.db.siteCrawlQueueItem.groupBy({
      by: ['lastError'],
      where: { runId: ctx.run.id, status: 'skipped' },
      _count: { _all: true },
    });
    const out: Partial<Record<SkipReason, number>> = {};
    for (const g of groups) {
      const r = (g.lastError ?? 'empty') as SkipReason;
      out[r] = (out[r] ?? 0) + g._count._all;
    }
    if (ctx.unverified.size > 0)
      out.unverified_host = (out.unverified_host ?? 0) + ctx.unverified.size;
    if (ctx.stats.limitDropped)
      out.limit = (out.limit ?? 0) + ctx.stats.limitDropped;
    return out;
  }

  private async saveStats(ctx: RunCtx): Promise<void> {
    ctx.stats.unverifiedHosts = [...ctx.unverified];
    ctx.stats.skippedByReason = await this.skippedByReason(ctx);
    const skipped = Object.values(ctx.stats.skippedByReason).reduce(
      (a, b) => a + (b ?? 0),
      0,
    );
    const counts = await ctx.db.siteCrawlRun.findFirst({
      where: { id: ctx.run.id },
      select: {
        pagesChanged: true,
        pagesUnchanged: true,
        pagesGone: true,
        pagesFailed: true,
      },
    });
    const seen =
      skipped +
      (counts
        ? counts.pagesChanged +
          counts.pagesUnchanged +
          counts.pagesGone +
          counts.pagesFailed
        : 0);
    await ctx.db.siteCrawlRun.update({
      where: { id: ctx.run.id },
      data: {
        stats: ctx.stats as Prisma.InputJsonValue,
        pagesSkipped: skipped,
        pagesSeen: seen,
      },
    });
  }

  /** Очередь пуста — итоги и `done` (последним, после всех страниц). */
  private async maybeFinish(ctx: RunCtx): Promise<boolean> {
    const pending = await ctx.db.siteCrawlQueueItem.count({
      where: { runId: ctx.run.id, status: { in: OPEN_ITEMS } },
    });
    if (pending > 0 || (ctx.stats.render?.jobs.length ?? 0) > 0) return false;
    await this.closeRun(ctx.run, ctx.db, 'done', null);
    return true;
  }

  private async closeRun(
    run: SiteCrawlRun,
    db: TenantDb,
    status: 'done' | 'failed',
    error: string | null,
  ): Promise<void> {
    await db.siteCrawlRun.updateMany({
      where: { id: run.id, status: { in: ACTIVE } },
      data: { status, error, finishedAt: new Date(), lockedUntil: null },
    });
  }
}

export function toRunView(run: SiteCrawlRun): CrawlRunView {
  const stats = asStats(run.stats);
  return {
    id: run.id,
    status: run.status as CrawlRunView['status'],
    trigger: run.trigger,
    mode: run.mode,
    pagesSeen: run.pagesSeen,
    pagesChanged: run.pagesChanged,
    pagesUnchanged: run.pagesUnchanged,
    pagesSkipped: run.pagesSkipped,
    pagesFailed: run.pagesFailed,
    pagesGone: run.pagesGone,
    skippedByReason: stats.skippedByReason ?? {},
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    error: run.error,
  };
}
