/**
 * AdminAttentionService — очередь «что требует внимания» для первой
 * страницы админки (`GET /api/admin/attention`,
 * doc/TUTORIAL-DEMO-QUALITY-SPEC.md, раздел «Дашборд внимания»).
 *
 * Только чтение. Сервис собирает данные из существующих источников, а
 * решают, что из них карточка, правила в `attention-rules.ts`.
 *
 * ## Источники проверяются независимо
 *
 * Каждый источник — свой `try`: упала модерация — кроны всё равно
 * видны, а сам источник отмечен `status: 'error'` («не удалось
 * проверить»), а не молчаливым нулём. «Всё спокойно» админка
 * показывает, только если все подключённые источники ответили.
 *
 * ## Проверка качества демо (Gemini)
 *
 * Источник `quality` — последние проверки `TutorialDemoQualityCheck`
 * по роликам демо: `fail` — решение оператора, `warn` и исчерпанные
 * повторы — к сведению (`qualityItems`). Состояние источника `ok`,
 * когда проверка включена (`TUTORIAL_DEMO_QUALITY_ENABLED`), иначе
 * `not_configured` — но уже записанные вердикты показываются и тогда:
 * это факты о роликах, а не о флаге.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { readDemoQualityConfig } from '../tutorial-quality/demo-quality-queue';
import { JOB_LOCK_MS } from '../../common/cron-job-lock';
import { AdminCronService } from '../cron/admin-cron.service';
import { DemoStatusService } from '../ops-status/demo-status.service';
import {
  parseTutorialLocales,
  TUTORIAL_LOCALES_SETTING_KEY,
} from '../tutorial-scenario/tutorial-locales';
import {
  ABANDONED_FRAMES_RETENTION_DAYS,
  PENDING_REVIEW_WARN_DAYS,
} from '../client-site-tutorial/draft-retention';
import {
  ASSEMBLY_STUCK_AFTER_MS,
  AttentionItem,
  AttentionSource,
  AttentionSourceKey,
  AttentionView,
  assemblyStuckItems,
  buildView,
  clientDraftItems,
  CRON_WINDOW_MS,
  cronItems,
  CronStuckRow,
  demoMatrixItems,
  HOUR_MS,
  isRealBuild,
  ModerationQueue,
  moderationItems,
  onlySkipItems,
  PendingReviewGroup,
  QualityCheckRow,
  qualityItems,
  scrubText,
  snapshotChangedItems,
  SnapshotChangedGroup,
  snapshotErrorItems,
  SOURCE_LABELS,
  TempoPendingRow,
  tempoApprovalItems,
  tutorialReviewItems,
} from './attention-rules';

/** Черновиков на одобрении за один ответ: их единицы, это страховка. */
export const CLIENT_DRAFTS_CAP = 50;
/** Версий темпа-кандидатов за один ответ. */
export const TEMPO_CANDIDATES_CAP = 200;
/** Последних проверок качества за один ответ (по одной на ролик). */
export const QUALITY_CHECKS_SCAN = 500;
/** «Текущая» сборка фронтенда — по съёмке не старше этого. */
export const CURRENT_BUILD_FRESH_MS = 48 * HOUR_MS;

type Collector = (now: Date) => Promise<AttentionItem[]>;

@Injectable()
export class AdminAttentionService {
  private readonly logger = new Logger(AdminAttentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminCron: AdminCronService,
    private readonly demoStatus: DemoStatusService,
    private readonly settings: PlatformSettingsService,
  ) {}

  async get(now: Date = new Date()): Promise<AttentionView> {
    const collectors: Array<[AttentionSourceKey, Collector]> = [
      ['cron', (n) => this.cronSource(n)],
      ['demo', (n) => this.demoSource(n)],
      ['ui-snapshots', (n) => this.snapshotChangedSource(n)],
      ['tutorial-review', (n) => this.tutorialReviewSource(n)],
      ['tempo', (n) => this.tempoSource(n)],
      ['moderation', (n) => this.moderationSource(n)],
      ['client-drafts', (n) => this.clientDraftsSource(n)],
      ['assembly', (n) => this.assemblySource(n)],
      ['quality', (n) => this.qualitySource(n)],
    ];
    const results = await Promise.all(
      collectors.map(async ([key, collect]) => {
        try {
          return { key, items: await collect(now), error: null };
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          this.logger.warn(`дашборд внимания: источник ${key} — ${text}`);
          return { key, items: [] as AttentionItem[], error: text };
        }
      }),
    );
    const qualityOn = readDemoQualityConfig().enabled;
    const sources: AttentionSource[] = results.map(({ key, error }) =>
      error === null
        ? {
            key,
            label: SOURCE_LABELS[key],
            status: key === 'quality' && !qualityOn ? 'not_configured' : 'ok',
          }
        : {
            key,
            label: SOURCE_LABELS[key],
            status: 'error',
            error: `не удалось проверить: ${scrubText(error, 120) ?? 'ошибка'}`,
          },
    );
    return buildView(
      results.flatMap((r) => r.items),
      sources,
      now,
    );
  }

  private async cronSource(now: Date): Promise<AttentionItem[]> {
    const since = new Date(now.getTime() - CRON_WINDOW_MS);
    const [summary, stuckRows] = await Promise.all([
      this.adminCron.getSummary({ since, until: now }, now),
      this.prisma.cronRunLog.findMany({
        where: {
          status: 'RUNNING',
          startedAt: { gte: since, lt: new Date(now.getTime() - JOB_LOCK_MS) },
        },
        select: { jobKey: true, startedAt: true },
        orderBy: { startedAt: 'asc' },
        take: 200,
      }) as Promise<CronStuckRow[]>,
    ]);
    return cronItems(summary.jobs, stuckRows, summary.lockMs, now);
  }

  private async demoSource(now: Date): Promise<AttentionItem[]> {
    const [demo, localesRaw, latestCapture] = await Promise.all([
      this.demoStatus.get(now),
      this.settings.get(TUTORIAL_LOCALES_SETTING_KEY),
      this.prisma.tutorialVideoAsset.findFirst({
        where: {
          clientSiteDraftId: null,
          captureBuild: { not: null },
          capturedAt: { gte: new Date(now.getTime() - CURRENT_BUILD_FRESH_MS) },
        },
        orderBy: { capturedAt: 'desc' },
        select: { captureBuild: true },
      }) as Promise<{ captureBuild: string | null } | null>,
    ]);
    const currentBuild = isRealBuild(latestCapture?.captureBuild)
      ? (latestCapture?.captureBuild as string)
      : null;
    return [
      ...onlySkipItems(demo.crons, now),
      ...snapshotErrorItems(demo.uiSnapshots.items, now),
      ...demoMatrixItems(
        demo.tutorials.cells,
        { requiredLocales: parseTutorialLocales(localesRaw), currentBuild },
        now,
      ),
    ];
  }

  private async snapshotChangedSource(now: Date): Promise<AttentionItem[]> {
    const groups = (await this.prisma.uiSnapshot.groupBy({
      by: ['routeKey', 'locale', 'theme'],
      where: {
        changed: true,
        createdAt: { gte: new Date(now.getTime() - CRON_WINDOW_MS) },
      },
      _count: { _all: true },
      _min: { createdAt: true },
    })) as unknown as Array<{
      routeKey: string;
      locale: string;
      theme: string;
      _count: { _all: number };
      _min: { createdAt: Date | null };
    }>;
    const input: SnapshotChangedGroup[] = groups
      .filter((g) => g._min.createdAt)
      .map((g) => ({
        routeKey: g.routeKey,
        locale: g.locale,
        theme: g.theme,
        count: g._count._all,
        firstAt: g._min.createdAt as Date,
      }));
    return snapshotChangedItems(input, now);
  }

  private async tutorialReviewSource(now: Date): Promise<AttentionItem[]> {
    // Те же условия, что `pendingReview` в сводке демо: наши (не
    // обучалки заказчиков — у них своя очередь), собранные, не одобренные.
    const groups = (await this.prisma.tutorialVideoAsset.groupBy({
      by: ['subjectKey', 'locale'],
      where: {
        clientSiteDraftId: null,
        reviewed: false,
        assemblyStatus: 'complete',
      },
      _count: { _all: true },
      _min: { createdAt: true },
    })) as unknown as Array<{
      subjectKey: string;
      locale: string;
      _count: { _all: number };
      _min: { createdAt: Date | null };
    }>;
    const input: PendingReviewGroup[] = groups.map((g) => ({
      subjectKey: g.subjectKey,
      locale: g.locale,
      count: g._count._all,
      oldestAt: g._min.createdAt ?? now,
    }));
    return tutorialReviewItems(input, now);
  }

  /**
   * Версия ждёт оператора: собрана и проверена (`complete`), требует
   * одобрения (сценарное демо), не активировалась и новее последней
   * активации у своего ролика — старые несработавшие варианты, после
   * которых оператор уже выбрал другой, решения не ждут.
   */
  private async tempoSource(now: Date): Promise<AttentionItem[]> {
    const candidates = (await this.prisma.tutorialVideoVersion.findMany({
      where: {
        status: 'complete',
        requiresApproval: true,
        activatedAt: null,
        kind: { not: 'source' },
      },
      orderBy: { updatedAt: 'asc' },
      take: TEMPO_CANDIDATES_CAP,
      select: {
        assetId: true,
        createdAt: true,
        updatedAt: true,
        tempoFactor: true,
        asset: { select: { subjectKey: true, locale: true } },
      },
    })) as Array<{
      assetId: string;
      createdAt: Date;
      updatedAt: Date;
      tempoFactor: number | null;
      asset: { subjectKey: string; locale: string };
    }>;
    if (candidates.length === 0) return [];
    const activations = (await this.prisma.tutorialVideoVersion.groupBy({
      by: ['assetId'],
      where: {
        assetId: { in: [...new Set(candidates.map((c) => c.assetId))] },
        activatedAt: { not: null },
      },
      _max: { activatedAt: true },
    })) as unknown as Array<{
      assetId: string;
      _max: { activatedAt: Date | null };
    }>;
    const lastActivated = new Map<string, number>();
    for (const a of activations) {
      if (a._max.activatedAt) {
        lastActivated.set(a.assetId, a._max.activatedAt.getTime());
      }
    }
    const rows: TempoPendingRow[] = candidates
      .filter(
        (c) => c.createdAt.getTime() > (lastActivated.get(c.assetId) ?? 0),
      )
      .map((c) => ({
        assetId: c.assetId,
        subjectKey: c.asset.subjectKey,
        locale: c.asset.locale,
        tempoFactor: c.tempoFactor,
        readyAt: c.updatedAt,
      }));
    return tempoApprovalItems(rows, now);
  }

  private async moderationSource(now: Date): Promise<AttentionItem[]> {
    type Agg = {
      _count: { _all: number };
      _min: { createdAt: Date | null };
    };
    const agg = {
      _count: { _all: true },
      _min: { createdAt: true },
    } as const;
    const [publications, sharedVideos, portfolio, auctions, blog] =
      (await Promise.all([
        this.prisma.publicationRequest.aggregate({
          where: { status: 'PENDING' },
          ...agg,
        }),
        this.prisma.sharedVideoPage.aggregate({
          where: { status: 'PENDING' },
          ...agg,
        }),
        this.prisma.portfolioItem.aggregate({
          where: { status: 'PENDING' },
          ...agg,
        }),
        this.prisma.auctionListing.aggregate({
          where: { status: 'PENDING_MODERATION' },
          ...agg,
        }),
        this.prisma.blogPost.aggregate({
          where: { status: 'DRAFT' },
          ...agg,
        }),
      ])) as unknown as Agg[];
    const queue = (kind: ModerationQueue['kind'], a: Agg): ModerationQueue => ({
      kind,
      count: a._count._all,
      oldestAt: a._min.createdAt,
    });
    return moderationItems(
      [
        queue('publication-review', publications),
        queue('shared-video-review', sharedVideos),
        queue('portfolio-review', portfolio),
        queue('auction-review', auctions),
        queue('blog-review', blog),
      ],
      now,
    );
  }

  private async clientDraftsSource(now: Date): Promise<AttentionItem[]> {
    // Только служебные поля: ни заголовка, ни адреса сайта заказчика.
    const drafts = (await this.prisma.clientSiteTutorialDraft.findMany({
      where: { status: 'PENDING_REVIEW' },
      select: { id: true, updatedAt: true, framesPurgedAt: true },
      orderBy: { updatedAt: 'asc' },
      take: CLIENT_DRAFTS_CAP,
    })) as Array<{ id: string; updatedAt: Date; framesPurgedAt: Date | null }>;
    return clientDraftItems(
      drafts,
      {
        retentionDays: ABANDONED_FRAMES_RETENTION_DAYS,
        warnDays: PENDING_REVIEW_WARN_DAYS,
      },
      now,
    );
  }

  /**
   * Последняя проверка качества каждого ролика демо (не обучалок по
   * сайтам заказчиков — у них своя очередь). Самые свежие первыми; из
   * каждой пары (ролик) берётся первая встреченная.
   */
  private async qualitySource(now: Date): Promise<AttentionItem[]> {
    const rows = (await this.prisma.tutorialDemoQualityCheck.findMany({
      where: { asset: { clientSiteDraftId: null } },
      orderBy: { createdAt: 'desc' },
      take: QUALITY_CHECKS_SCAN,
      select: {
        assetId: true,
        status: true,
        verdict: true,
        checkedAt: true,
        updatedAt: true,
        report: true,
        asset: { select: { subjectKey: true, locale: true, theme: true } },
      },
    })) as Array<{
      assetId: string;
      status: string;
      verdict: string | null;
      checkedAt: Date | null;
      updatedAt: Date;
      report: unknown;
      asset: { subjectKey: string; locale: string; theme: string | null };
    }>;
    const seen = new Set<string>();
    const latest: QualityCheckRow[] = [];
    for (const r of rows) {
      if (seen.has(r.assetId)) continue;
      seen.add(r.assetId);
      const report = (r.report ?? {}) as {
        summary?: unknown;
        issues?: unknown;
      };
      latest.push({
        assetId: r.assetId,
        status: r.status,
        verdict: r.verdict,
        checkedAt: r.checkedAt,
        updatedAt: r.updatedAt,
        subjectKey: r.asset.subjectKey,
        locale: r.asset.locale,
        theme: r.asset.theme,
        summary: typeof report.summary === 'string' ? report.summary : null,
        issueCount: Array.isArray(report.issues) ? report.issues.length : 0,
      });
    }
    return qualityItems(latest, now);
  }

  private async assemblySource(now: Date): Promise<AttentionItem[]> {
    const before = new Date(now.getTime() - ASSEMBLY_STUCK_AFTER_MS);
    type Agg = {
      _count: { _all: number };
      _min: { createdAt: Date | null };
    };
    const [assets, versions] = (await Promise.all([
      this.prisma.tutorialVideoAsset.aggregate({
        where: {
          assemblyStatus: { in: ['preparing', 'pending'] },
          OR: [
            { assemblyStartedAt: { lt: before } },
            { assemblyStartedAt: null, createdAt: { lt: before } },
          ],
        },
        _count: { _all: true },
        _min: { createdAt: true },
      }),
      this.prisma.tutorialVideoVersion.aggregate({
        where: {
          status: { in: ['preparing', 'pending'] },
          OR: [
            { startedAt: { lt: before } },
            { startedAt: null, createdAt: { lt: before } },
          ],
        },
        _count: { _all: true },
        _min: { createdAt: true },
      }),
    ])) as unknown as [Agg, Agg];
    return assemblyStuckItems(
      {
        assets: assets._count._all,
        assetsOldestAt: assets._min.createdAt,
        versions: versions._count._all,
        versionsOldestAt: versions._min.createdAt,
      },
      now,
    );
  }
}
