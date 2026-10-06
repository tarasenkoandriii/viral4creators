/**
 * TutorialDemoQualityService — проверка качества демо обучалки через
 * Gemini в существующем кроне `tutorial-assembly-poll`
 * (doc/TUTORIAL-DEMO-QUALITY-SPEC.md, 06.10.2026).
 *
 * ## Фаза — наблюдение
 *
 * Проверка пишет отчёт и вердикт `ok | warn | fail` в свою запись
 * `TutorialDemoQualityCheck` и больше ничего: `reviewed` ролика, его
 * файл, публичная выдача и баланс пользователей не трогаются. Сигнал
 * оператору — бейдж на «Видео-контенте» и карточки «Обзора».
 *
 * ## Очередь между тиками
 *
 * `processQueue` зовётся из `pollAssemblies` ПОСЛЕ опроса сборок, под
 * тем же джоб-замком, с ограниченным куском работы (`TICK_MAX_JOBS`
 * заданий, `TICK_BUDGET_MS`, анализ — по одному за раз). Фазы:
 *
 *  1. `upload` — скачать файл, посчитать sha (ключ дедупликации),
 *     бесплатная техпроверка; провал — `fail` без Gemini; выбранный
 *     суточный бюджет — запись остаётся `pending` до следующих суток;
 *     иначе загрузка в Gemini Files, имя файла пишется СРАЗУ.
 *  2. `wait` — файл стал ACTIVE? Нет — следующий тик.
 *  3. `analyze` — запрос по рубрике с `responseSchema`, таймаут — из
 *     остатка бюджета тика; расход — в `AiUsage`; вердикт — сервером.
 *
 * Захват — атомарный `updateMany` по условию «pending и срок наступил»
 * или «running и аренда истекла»; каждая запись дальше идёт под
 * условием `leaseOwner = этот тик`. Упавший тик подбирается после
 * истечения аренды, и это считается неудачной попыткой: три подряд —
 * `error`. Временные ошибки (429, сеть, 5xx, таймаут) — до трёх
 * попыток с паузой 2 → 4 мин; `error` отделён от вердикта «плохое
 * видео». Невалидный ответ или отказ модели — `warn`, не `ok`.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { pathnameFromBlobUrl } from '../../common/blob-paths';
import { estimateCost } from '../../common/ai-pricing';
import { languageNameForLocale } from '../../common/locale';
import { probeMp4 } from '../tutorial-runner/mp4-probe';
import {
  parseTutorialManifest,
  TutorialTimelineManifest,
} from '../tutorial-runner/tutorial-manifest';
import { frameSpansSeconds } from '../tutorial-runner/tutorial-video-assembly';
import { DemoQualityGemini } from './demo-quality-gemini';
import {
  buildDemoQualityPrompt,
  computeDemoQualityVerdict,
  DEMO_QUALITY_RESPONSE_SCHEMA,
  DEMO_QUALITY_RUBRIC_VERSION,
  DemoQualityContext,
  DemoQualityReport,
  parseDemoQualityResponse,
  QualityVerdict,
  refusedReport,
  scrubQualityText,
} from './demo-quality-rubric';
import {
  demoPreflight,
  preflightIssues,
  PreflightResult,
} from './demo-quality-preflight';
import {
  analyzeTimeoutMs,
  backoffMs,
  budgetAllows,
  demoQualityDedupeKey,
  isTransientError,
  LEASE_MS,
  MAX_ATTEMPTS,
  nextUtcDay,
  PROVIDER_FILE_TTL_MS,
  readDemoQualityConfig,
  sha256Hex,
  startOfUtcDay,
  TICK_BUDGET_MS,
  TICK_MAX_JOBS,
  WAIT_ACTIVE_TIMEOUT_MS,
} from './demo-quality-queue';

/** Операция журнала расходов. */
export const DEMO_QUALITY_OPERATION = 'tutorial-demo-quality' as const;

export type DemoQualityStatus = 'pending' | 'running' | 'complete' | 'error';
export type DemoQualityPhase = 'upload' | 'wait' | 'analyze';
export type DemoQualityTrigger = 'assembly' | 'operator' | 'approved-backfill';

/** «Текущая» сборка фронтенда — по съёмке не старше этого (как в «Обзоре»). */
const CURRENT_BUILD_FRESH_MS = 48 * 3_600_000;
/** Сколько раз за тик спрашивать состояние файла и с какой паузой. */
const WAIT_POLL_MS = 3_000;
const WAIT_IN_TICK_MS = 15_000;
/** Кандидатов на захват за один запрос. */
const CLAIM_SCAN = 5;
/** Просмотр одобренных роликов за одно нажатие «Проверить все одобренные». */
const APPROVED_SCAN = 500;
/** Последних проверок на страницу админки. */
const LATEST_SCAN = 500;

/** Строка проверки — то, что сервис читает из базы. */
export interface CheckRow {
  id: string;
  createdAt: Date;
  assetId: string;
  versionId: string | null;
  videoUrl: string;
  trigger: string;
  contentSha: string | null;
  rubricVersion: string;
  modelId: string;
  dedupeKey: string | null;
  reusedFromId: string | null;
  status: string;
  phase: string;
  attempts: number;
  nextAttemptAt: Date | null;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  providerFileName: string | null;
  providerFileUri: string | null;
  providerFileMime: string | null;
  uploadedAt: Date | null;
  verdict: string | null;
  report: unknown;
  preflight: unknown;
  error: string | null;
  costMicroUsd: number | null;
  unpriced: boolean;
  durationMs: number | null;
  theme: string | null;
  locale: string;
  captureBuild: string | null;
  captureMode: string | null;
  checkedAt: Date | null;
}

/** Что отдаётся админке: без имён файлов провайдера и аренды. */
export interface DemoQualityCheckView {
  id: string;
  assetId: string;
  versionId: string | null;
  trigger: string;
  status: DemoQualityStatus;
  phase: DemoQualityPhase;
  verdict: QualityVerdict | null;
  attempts: number;
  nextAttemptAt: string | null;
  error: string | null;
  report: DemoQualityReport | null;
  preflight: PreflightResult | null;
  costMicroUsd: number | null;
  unpriced: boolean;
  modelId: string;
  rubricVersion: string;
  reusedFromId: string | null;
  durationMs: number | null;
  theme: string | null;
  locale: string;
  captureBuild: string | null;
  captureMode: string | null;
  createdAt: string;
  checkedAt: string | null;
}

export interface EnqueueResult {
  check: DemoQualityCheckView;
  created: boolean;
  /** Почему новая запись не заведена: уже в очереди, уже проверено
   *  этой рубрикой, или прежняя ошибочная поставлена заново. */
  reason: 'already-queued' | 'already-checked' | 'retry' | null;
}

export interface DemoQualityTickResult {
  skipped?: string;
  /** Сколько проверок взято в работу за тик. */
  processed: number;
  completed: number;
  /** Отложены: ждут файл, бюджет или время следующего тика. */
  deferred: number;
  /** Временная ошибка — повтор с паузой. */
  retried: number;
  /** Окончательная ошибка проверки (не вердикт видео). */
  errors: number;
}

interface AssetMeta {
  id: string;
  subjectKey: string;
  title: string;
  locale: string;
  theme: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  captureBuild: string | null;
  tempoManifest: unknown;
  clientSiteDraftId: string | null;
  activeVersionId: string | null;
  assemblyStatus: string;
  blobUrl: string | null;
}

interface TargetMeta {
  asset: AssetMeta;
  manifest: TutorialTimelineManifest | null;
  /** Длительность по плану: версии (`videoMs`) или ролика. */
  plannedMs: number | null;
}

type Outcome =
  | 'complete'
  | 'deferred'
  | 'budget'
  | 'retried'
  | 'error'
  | 'lost';
type Step = { kind: 'continue'; row: CheckRow } | { kind: Outcome };

const ASSET_SELECT = {
  id: true,
  subjectKey: true,
  title: true,
  locale: true,
  theme: true,
  durationMs: true,
  width: true,
  height: true,
  captureBuild: true,
  tempoManifest: true,
  clientSiteDraftId: true,
  activeVersionId: true,
  assemblyStatus: true,
  blobUrl: true,
} as const;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function json(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue;
}

@Injectable()
export class TutorialDemoQualityService {
  private readonly logger = new Logger(TutorialDemoQualityService.name);
  /** Часы и пауза — свойства, чтобы тесты шли без настоящего времени. */
  clock: () => number = () => Date.now();
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly gemini: DemoQualityGemini,
    private readonly aiUsage: AiUsageService,
  ) {}

  isEnabled(): boolean {
    return readDemoQualityConfig().enabled;
  }

  // ── постановка в очередь ─────────────────────────────────────────

  /**
   * Новый собранный ролик (из опроса сборок). Только при включённой
   * проверке; никогда не бросает — ошибка постановки не делает
   * собранный ролик несобранным.
   */
  async enqueueAssembled(assetId: string, bytes?: Buffer): Promise<boolean> {
    if (!this.isEnabled()) return false;
    try {
      const res = await this.enqueue({
        assetId,
        trigger: 'assembly',
        contentSha: bytes ? sha256Hex(bytes) : null,
      });
      return res.created;
    } catch (err) {
      this.logger.warn(
        `проверка качества ролика ${assetId} не поставлена: ${errMessage(err)}`,
      );
      return false;
    }
  }

  /** Кнопка «Проверить» оператора. */
  async enqueueByOperator(
    assetId: string,
    operatorId: string,
    versionId?: string | null,
  ): Promise<EnqueueResult> {
    this.assertEnabled();
    return this.enqueue({
      assetId,
      versionId: versionId ?? null,
      trigger: 'operator',
      requestedBy: operatorId,
    });
  }

  /**
   * «Проверить все одобренные» — с потолком за нажатие. Ролик, у
   * которого этот файл уже проверялся (или стоит в очереди) этой
   * рубрикой и моделью, пропускается: повтор не оплачивается.
   */
  async enqueueApproved(operatorId: string): Promise<{
    queued: number;
    skipped: number;
    remaining: number;
    cap: number;
  }> {
    this.assertEnabled();
    const cfg = readDemoQualityConfig();
    const assets = (await this.prisma.tutorialVideoAsset.findMany({
      where: {
        reviewed: true,
        assemblyStatus: 'complete',
        blobUrl: { not: null },
        clientSiteDraftId: null,
      },
      orderBy: { createdAt: 'desc' },
      take: APPROVED_SCAN,
      select: { id: true, blobUrl: true },
    })) as Array<{ id: string; blobUrl: string | null }>;
    if (assets.length === 0) {
      return { queued: 0, skipped: 0, remaining: 0, cap: cfg.backfillCap };
    }
    const existing = (await this.prisma.tutorialDemoQualityCheck.findMany({
      where: {
        assetId: { in: assets.map((a) => a.id) },
        rubricVersion: DEMO_QUALITY_RUBRIC_VERSION,
        modelId: cfg.model,
      },
      select: { assetId: true, videoUrl: true },
    })) as Array<{ assetId: string; videoUrl: string }>;
    const seen = new Set(existing.map((e) => `${e.assetId}|${e.videoUrl}`));
    const todo = assets.filter(
      (a) => a.blobUrl && !seen.has(`${a.id}|${a.blobUrl}`),
    );
    let queued = 0;
    for (const a of todo.slice(0, cfg.backfillCap)) {
      try {
        const res = await this.enqueue({
          assetId: a.id,
          trigger: 'approved-backfill',
          requestedBy: operatorId,
        });
        if (res.created) queued++;
      } catch (err) {
        this.logger.warn(
          `одобренный ролик ${a.id} не поставлен на проверку: ${errMessage(err)}`,
        );
      }
    }
    return {
      queued,
      skipped: assets.length - todo.length,
      remaining: Math.max(0, todo.length - cfg.backfillCap),
      cap: cfg.backfillCap,
    };
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new BadRequestException(
        'Проверка качества демо выключена — включите TUTORIAL_DEMO_QUALITY_ENABLED',
      );
    }
  }

  private async enqueue(input: {
    assetId: string;
    versionId?: string | null;
    trigger: DemoQualityTrigger;
    requestedBy?: string | null;
    contentSha?: string | null;
  }): Promise<EnqueueResult> {
    const cfg = readDemoQualityConfig();
    const asset = (await this.prisma.tutorialVideoAsset.findUnique({
      where: { id: input.assetId },
      select: ASSET_SELECT,
    })) as AssetMeta | null;
    if (!asset) throw new NotFoundException('Видео не найдено');
    if (asset.assemblyStatus !== 'complete' || !asset.blobUrl) {
      throw new BadRequestException('Ролик ещё не собран — проверять нечего');
    }
    if (asset.clientSiteDraftId) {
      throw new BadRequestException(
        'Это ролик обучалки по сайту заказчика — проверка качества демо его не касается',
      );
    }
    let versionId: string | null;
    let videoUrl: string;
    let durationMs: number | null;
    if (input.versionId) {
      const version = (await this.prisma.tutorialVideoVersion.findFirst({
        where: { id: input.versionId, assetId: asset.id },
        select: { id: true, status: true, blobUrl: true, videoMs: true },
      })) as {
        id: string;
        status: string;
        blobUrl: string | null;
        videoMs: number | null;
      } | null;
      if (!version || version.status !== 'complete' || !version.blobUrl) {
        throw new BadRequestException('Версия не собрана — проверять нечего');
      }
      versionId = version.id;
      videoUrl = version.blobUrl;
      durationMs = version.videoMs;
    } else {
      versionId = asset.activeVersionId;
      videoUrl = asset.blobUrl;
      durationMs = asset.durationMs;
    }

    const dedupeKey = input.contentSha
      ? demoQualityDedupeKey(
          asset.id,
          input.contentSha,
          DEMO_QUALITY_RUBRIC_VERSION,
          cfg.model,
        )
      : null;
    const existing = (await this.prisma.tutorialDemoQualityCheck.findFirst({
      where: {
        assetId: asset.id,
        rubricVersion: DEMO_QUALITY_RUBRIC_VERSION,
        modelId: cfg.model,
        OR: [{ videoUrl }, ...(dedupeKey ? [{ dedupeKey }] : [])],
      },
      orderBy: { createdAt: 'desc' },
    })) as CheckRow | null;
    if (existing) {
      if (existing.status === 'pending' || existing.status === 'running') {
        return {
          check: toView(existing),
          created: false,
          reason: 'already-queued',
        };
      }
      if (existing.status === 'error' && input.trigger === 'operator') {
        // Исчерпанные повторы оператор вправе запустить заново: это
        // новая серия попыток той же проверки, а не вторая запись.
        const reset = (await this.prisma.tutorialDemoQualityCheck.update({
          where: { id: existing.id },
          data: {
            status: 'pending',
            phase: 'upload',
            attempts: 0,
            nextAttemptAt: null,
            error: null,
            leaseOwner: null,
            leaseUntil: null,
            providerFileName: null,
            providerFileUri: null,
            providerFileMime: null,
            uploadedAt: null,
            requestedBy: input.requestedBy ?? null,
          },
        })) as CheckRow;
        return { check: toView(reset), created: false, reason: 'retry' };
      }
      return {
        check: toView(existing),
        created: false,
        reason: 'already-checked',
      };
    }

    const row = (await this.prisma.tutorialDemoQualityCheck.create({
      data: {
        assetId: asset.id,
        versionId,
        videoUrl,
        trigger: input.trigger,
        requestedBy: input.requestedBy ?? null,
        contentSha: input.contentSha ?? null,
        dedupeKey,
        rubricVersion: DEMO_QUALITY_RUBRIC_VERSION,
        modelId: cfg.model,
        status: 'pending',
        phase: 'upload',
        durationMs,
        theme: asset.theme,
        locale: asset.locale,
        captureBuild: asset.captureBuild,
        // Режим съёмки (browser/TMA) у ролика не записан — не угадываем.
        captureMode: null,
      },
    })) as CheckRow;
    return { check: toView(row), created: true, reason: null };
  }

  // ── чтение для админки ───────────────────────────────────────────

  /** Последняя проверка каждого из роликов страницы. */
  async latestForAssets(assetIds: string[]): Promise<{
    enabled: boolean;
    checks: Record<string, DemoQualityCheckView>;
  }> {
    const ids = [...new Set(assetIds.filter(Boolean))].slice(0, 100);
    const checks: Record<string, DemoQualityCheckView> = {};
    if (ids.length > 0) {
      const rows = (await this.prisma.tutorialDemoQualityCheck.findMany({
        where: { assetId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        take: LATEST_SCAN,
      })) as CheckRow[];
      for (const r of rows) {
        if (!checks[r.assetId]) checks[r.assetId] = toView(r);
      }
    }
    return { enabled: this.isEnabled(), checks };
  }

  // ── тик очереди ──────────────────────────────────────────────────

  /**
   * Ограниченный кусок работы в тике `tutorial-assembly-poll`. Зовётся
   * под замком опроса; никогда не бросает.
   */
  async processQueue(
    opts: { budgetMs?: number; maxJobs?: number } = {},
  ): Promise<DemoQualityTickResult> {
    const result: DemoQualityTickResult = {
      processed: 0,
      completed: 0,
      deferred: 0,
      retried: 0,
      errors: 0,
    };
    if (!this.isEnabled()) return { ...result, skipped: 'выключено' };
    const budgetMs = Math.min(opts.budgetMs ?? TICK_BUDGET_MS, TICK_BUDGET_MS);
    const maxJobs = opts.maxJobs ?? TICK_MAX_JOBS;
    const deadline = this.clock() + Math.max(0, budgetMs);
    const owner = randomUUID();
    try {
      const tried = new Set<string>();
      while (result.processed < maxJobs && this.clock() < deadline) {
        const row = await this.claimNext(owner, tried);
        if (!row) break;
        result.processed++;
        const outcome = await this.advance(row, owner, deadline);
        if (outcome === 'complete') result.completed++;
        else if (outcome === 'retried') result.retried++;
        else if (outcome === 'error') result.errors++;
        else result.deferred++;
        // Бюджет выбран — у остальных он выбран тоже: не качать их
        // файлы зря до следующего окна.
        if (outcome === 'budget') break;
      }
    } catch (err) {
      this.logger.warn(`очередь проверки качества: ${errMessage(err)}`);
    }
    return result;
  }

  private dueWhere(now: Date) {
    return {
      OR: [
        {
          status: 'pending',
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        { status: 'running', leaseUntil: { lt: now } },
      ],
    };
  }

  /** Атомарный захват: первая подходящая запись, которую не взял другой. */
  private async claimNext(
    owner: string,
    tried: Set<string>,
  ): Promise<CheckRow | null> {
    const now = new Date(this.clock());
    const candidates = (await this.prisma.tutorialDemoQualityCheck.findMany({
      where: { ...this.dueWhere(now), id: { notIn: [...tried] } },
      orderBy: { createdAt: 'asc' },
      take: CLAIM_SCAN,
      select: { id: true, status: true },
    })) as Array<{ id: string; status: string }>;
    for (const c of candidates) {
      tried.add(c.id);
      const recovered = c.status === 'running';
      const claimed = await this.prisma.tutorialDemoQualityCheck.updateMany({
        where: recovered
          ? { id: c.id, status: 'running', leaseUntil: { lt: now } }
          : {
              id: c.id,
              status: 'pending',
              OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
            },
        data: {
          status: 'running',
          leaseOwner: owner,
          leaseUntil: new Date(now.getTime() + LEASE_MS),
          // Аренда истекла — прежний тик упал посреди работы: это
          // неудачная попытка, иначе ролик, роняющий функцию, крутился
          // бы вечно.
          ...(recovered ? { attempts: { increment: 1 } } : {}),
        },
      });
      if (claimed.count !== 1) continue;
      const row = (await this.prisma.tutorialDemoQualityCheck.findUnique({
        where: { id: c.id },
      })) as CheckRow | null;
      if (!row) continue;
      if (recovered && row.attempts >= MAX_ATTEMPTS) {
        await this.finishError(
          row,
          owner,
          `проверка обрывалась ${row.attempts} раз(а) — тик функции не доходил до конца`,
        );
        continue;
      }
      return row;
    }
    return null;
  }

  private async advance(
    first: CheckRow,
    owner: string,
    deadline: number,
  ): Promise<Outcome> {
    let row = first;
    for (;;) {
      if (this.clock() >= deadline) {
        return (await this.release(row, owner, {})) ? 'deferred' : 'lost';
      }
      let step: Step;
      try {
        if (row.phase === 'wait')
          step = await this.phaseWait(row, owner, deadline);
        else if (row.phase === 'analyze') {
          step = await this.phaseAnalyze(row, owner, deadline);
        } else step = await this.phaseUpload(row, owner);
      } catch (err) {
        step = { kind: await this.failAttempt(row, owner, err) };
      }
      if (step.kind !== 'continue') return step.kind;
      row = step.row;
    }
  }

  // ── фазы ─────────────────────────────────────────────────────────

  private async phaseUpload(row: CheckRow, owner: string): Promise<Step> {
    const target = await this.loadTarget(row);
    if (!target) {
      return {
        kind: await this.finishError(
          row,
          owner,
          'проверяемый файл больше не существует',
        ),
      };
    }
    const pathname = pathnameFromBlobUrl(row.videoUrl, 'tutorial-videos/');
    if (!pathname) {
      return {
        kind: await this.finishError(
          row,
          owner,
          'ссылка на ролик не из хранилища роликов обучалки',
        ),
      };
    }
    const bytes = await this.blob.downloadBuffer(pathname);
    const contentSha = sha256Hex(bytes);
    const dedupeKey = demoQualityDedupeKey(
      row.assetId,
      contentSha,
      row.rubricVersion,
      row.modelId,
    );

    // То же содержимое уже проверено этой рубрикой и моделью — берём
    // готовый результат, Gemini не зовём.
    const done = (await this.prisma.tutorialDemoQualityCheck.findFirst({
      where: { dedupeKey, status: 'complete', id: { not: row.id } },
      orderBy: { createdAt: 'desc' },
    })) as CheckRow | null;
    if (done) {
      return {
        kind: await this.finish(row, owner, {
          status: 'complete',
          contentSha,
          dedupeKey,
          reusedFromId: done.id,
          verdict: done.verdict,
          report: done.report === null ? Prisma.DbNull : json(done.report),
          preflight:
            done.preflight === null ? Prisma.DbNull : json(done.preflight),
          durationMs: done.durationMs,
          costMicroUsd: 0,
          unpriced: false,
          error: null,
          checkedAt: new Date(this.clock()),
        }),
      };
    }

    const m = target.manifest;
    const pre = demoPreflight(probeMp4(bytes), {
      durationMs: target.plannedMs,
      width: target.asset.width,
      height: target.asset.height,
      hasAudio: m ? m.narration !== 'none' : null,
      declaredTheme: target.asset.theme,
      capturedTheme: m?.theme ?? null,
    });
    const base = {
      contentSha,
      dedupeKey,
      preflight: json(pre),
      durationMs: pre.durationMs || target.plannedMs,
    };
    if (!pre.ok) {
      const ctx = await this.context(row, target, pre.durationMs);
      const report: DemoQualityReport = {
        rubricVersion: row.rubricVersion,
        summary: `Техническая проверка не пройдена: ${pre.problems.join('; ')}.`,
        scores: null,
        issues: preflightIssues(pre),
        missingEvidence: [],
        theme: {
          expected: ctx.expectedTheme,
          observed: 'unknown',
          result: 'unknown',
        },
        language: {
          expected: ctx.locale,
          speech: 'unknown',
          captions: 'unknown',
          result: 'unknown',
        },
        freshness: ctx.freshness,
        invalid: null,
        droppedIssues: 0,
      };
      return {
        kind: await this.finish(row, owner, {
          ...base,
          status: 'complete',
          verdict: 'fail',
          report: json(report),
          costMicroUsd: 0,
          unpriced: false,
          error: null,
          checkedAt: new Date(this.clock()),
        }),
      };
    }

    const gate = await this.budgetGate(pre.durationMs);
    if (!gate.allowed) {
      // Бюджет выбран — до следующего окна, попытка не тратится.
      const ok = await this.release(row, owner, {
        ...base,
        nextAttemptAt: gate.retryAt,
        error: gate.reason,
      });
      return { kind: ok ? 'budget' : 'lost' };
    }

    const file = await this.gemini.upload(bytes, 'video/mp4');
    // Имя файла — сразу: упади функция дальше, уборка его найдёт.
    const updated = await this.write(row, owner, {
      ...base,
      phase: 'wait',
      providerFileName: file.name,
      providerFileUri: file.state === 'ACTIVE' ? file.uri : null,
      providerFileMime: file.mimeType,
      uploadedAt: new Date(this.clock()),
      error: null,
    });
    return updated ? { kind: 'continue', row: updated } : { kind: 'lost' };
  }

  private async phaseWait(
    row: CheckRow,
    owner: string,
    deadline: number,
  ): Promise<Step> {
    if (!row.providerFileName) {
      const back = await this.write(row, owner, { phase: 'upload' });
      return back ? { kind: 'continue', row: back } : { kind: 'lost' };
    }
    const waitUntil = Math.min(deadline, this.clock() + WAIT_IN_TICK_MS);
    for (;;) {
      const f = await this.gemini.getFile(row.providerFileName);
      if (f.state === 'ACTIVE' && f.uri) {
        const next = await this.write(row, owner, {
          phase: 'analyze',
          providerFileUri: f.uri,
          providerFileMime: f.mimeType ?? row.providerFileMime ?? 'video/mp4',
        });
        return next ? { kind: 'continue', row: next } : { kind: 'lost' };
      }
      const uploadedAt = row.uploadedAt?.getTime() ?? 0;
      if (
        f.state === 'FAILED' ||
        this.clock() - uploadedAt > WAIT_ACTIVE_TIMEOUT_MS
      ) {
        const reason =
          f.state === 'FAILED'
            ? `Gemini не обработал файл: ${f.error ?? 'без текста'}`
            : 'Gemini не обработал файл за 10 мин';
        await this.gemini.deleteFile(row.providerFileName);
        const reset = await this.write(row, owner, {
          phase: 'upload',
          providerFileName: null,
          providerFileUri: null,
          uploadedAt: null,
        });
        if (!reset) return { kind: 'lost' };
        const err = Object.assign(new Error(reason), { status: 503 });
        return { kind: await this.failAttempt(reset, owner, err) };
      }
      if (this.clock() + WAIT_POLL_MS >= waitUntil) {
        const ok = await this.release(row, owner, {});
        return { kind: ok ? 'deferred' : 'lost' };
      }
      await this.sleep(WAIT_POLL_MS);
    }
  }

  private async phaseAnalyze(
    row: CheckRow,
    owner: string,
    deadline: number,
  ): Promise<Step> {
    const uploadedAt = row.uploadedAt?.getTime() ?? 0;
    if (
      !row.providerFileName ||
      !row.providerFileUri ||
      this.clock() - uploadedAt > PROVIDER_FILE_TTL_MS
    ) {
      // Файла нет или он вот-вот истечёт у Google — загрузить заново.
      if (row.providerFileName) {
        await this.gemini.deleteFile(row.providerFileName);
      }
      const back = await this.write(row, owner, {
        phase: 'upload',
        providerFileName: null,
        providerFileUri: null,
        uploadedAt: null,
      });
      return back ? { kind: 'continue', row: back } : { kind: 'lost' };
    }
    const timeoutMs = analyzeTimeoutMs(deadline - this.clock());
    if (timeoutMs === null) {
      // Не успеет в этом тике — следующий начнёт с анализа.
      const ok = await this.release(row, owner, {});
      return { kind: ok ? 'deferred' : 'lost' };
    }
    const target = await this.loadTarget(row);
    if (!target) {
      return {
        kind: await this.finishError(
          row,
          owner,
          'проверяемый файл больше не существует',
        ),
      };
    }
    const ctx = await this.context(
      row,
      target,
      row.durationMs ?? target.plannedMs ?? 0,
    );
    const res = await this.gemini.generate({
      model: row.modelId,
      fileUri: row.providerFileUri,
      mimeType: row.providerFileMime ?? 'video/mp4',
      prompt: buildDemoQualityPrompt(ctx),
      schema: DEMO_QUALITY_RESPONSE_SCHEMA,
      timeoutMs,
    });
    // Расход — в журнал (никогда не бросает) и в саму проверку.
    await this.aiUsage.recordGemini(res.response, {
      operation: DEMO_QUALITY_OPERATION,
      model: row.modelId,
      userId: null,
    });
    const meta = (
      res.response as {
        usageMetadata?: {
          promptTokenCount?: number;
          cachedContentTokenCount?: number;
          candidatesTokenCount?: number;
          thoughtsTokenCount?: number;
        };
      } | null
    )?.usageMetadata;
    const units = {
      inputTokens: meta?.promptTokenCount ?? 0,
      cachedInputTokens: meta?.cachedContentTokenCount ?? 0,
      outputTokens:
        (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
      calls: 1,
    };
    const cost = estimateCost(row.modelId, units);
    const report = res.refusal
      ? refusedReport(ctx, res.refusal)
      : parseDemoQualityResponse(res.text, ctx);
    const verdict = computeDemoQualityVerdict(report);
    const kind = await this.finish(row, owner, {
      status: 'complete',
      verdict,
      report: json(report),
      costMicroUsd: cost.costMicroUsd,
      unpriced: cost.unpriced,
      tokenUsage: json(units),
      error: null,
      checkedAt: new Date(this.clock()),
    });
    return { kind };
  }

  // ── контекст и бюджет ────────────────────────────────────────────

  private async loadTarget(row: CheckRow): Promise<TargetMeta | null> {
    const asset = (await this.prisma.tutorialVideoAsset.findUnique({
      where: { id: row.assetId },
      select: ASSET_SELECT,
    })) as AssetMeta | null;
    if (!asset) return null;
    let plannedMs = asset.durationMs;
    if (row.versionId) {
      const v = (await this.prisma.tutorialVideoVersion.findFirst({
        where: { id: row.versionId, assetId: row.assetId },
        select: { videoMs: true },
      })) as { videoMs: number | null } | null;
      if (!v) return null;
      plannedMs = v.videoMs;
    }
    return {
      asset,
      manifest: parseTutorialManifest(asset.tempoManifest),
      plannedMs,
    };
  }

  /** Ожидаемый сценарий из метаданных съёмки и manifest. */
  private async context(
    row: CheckRow,
    target: TargetMeta,
    durationMs: number,
  ): Promise<DemoQualityContext> {
    const { asset, manifest } = target;
    // Таймкоды шагов — только у исходного файла: у версии темпа они
    // другие, а угадывать их по общей длине нельзя.
    const spans =
      manifest && !row.versionId
        ? frameSpansSeconds(
            manifest.frames.map((f) => ({ seconds: f.baseSeconds })),
            manifest.motion,
          )
        : null;
    return {
      subjectKey: asset.subjectKey,
      title: asset.title,
      locale: asset.locale,
      languageName: languageNameForLocale(asset.locale),
      expectedTheme: asset.theme,
      durationMs,
      narration: manifest ? manifest.narration : 'unknown',
      captions: manifest ? manifest.captions : null,
      steps: (manifest?.frames ?? []).map((f, i) => ({
        index: f.stepIndex,
        caption: f.caption ?? f.speech?.text ?? null,
        startSec: spans ? Math.round(spans[i].start * 10) / 10 : null,
        endSec: spans ? Math.round(spans[i].end * 10) / 10 : null,
      })),
      captureBuild: asset.captureBuild,
      freshness: await this.freshness(asset.captureBuild),
    };
  }

  /** Сборка интерфейса на съёмке против самой свежей снятой. */
  private async freshness(
    build: string | null,
  ): Promise<DemoQualityReport['freshness']> {
    if (!build || build === 'dev') return 'unknown';
    try {
      const latest = (await this.prisma.tutorialVideoAsset.findFirst({
        where: {
          clientSiteDraftId: null,
          captureBuild: { not: null },
          capturedAt: { gte: new Date(this.clock() - CURRENT_BUILD_FRESH_MS) },
        },
        orderBy: { capturedAt: 'desc' },
        select: { captureBuild: true },
      })) as { captureBuild: string | null } | null;
      const current = latest?.captureBuild;
      if (!current || current === 'dev') return 'unknown';
      return current === build ? 'current' : 'stale_candidate';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Суточный бюджет: деньги по журналу `AiUsage`, минуты — по уже
   * загруженным сегодня роликам. Журнал недоступен — не тратим
   * (безопасная сторона) и пробуем через паузу.
   */
  private async budgetGate(
    durationMs: number,
  ): Promise<{ allowed: boolean; reason: string | null; retryAt: Date }> {
    const cfg = readDemoQualityConfig();
    const now = new Date(this.clock());
    try {
      const [spent, agg] = await Promise.all([
        this.aiUsage.spentTodayForOperation(DEMO_QUALITY_OPERATION, now),
        this.prisma.tutorialDemoQualityCheck.aggregate({
          where: { uploadedAt: { gte: startOfUtcDay(now) } },
          _sum: { durationMs: true },
        }) as Promise<{ _sum: { durationMs: number | null } }>,
      ]);
      const verdict = budgetAllows(
        {
          limitMicroUsd: cfg.dailyLimitMicroUsd,
          spentMicroUsd: spent,
          limitVideoMs: cfg.dailyVideoMs,
          analyzedVideoMs: agg._sum.durationMs ?? 0,
        },
        durationMs,
      );
      return { ...verdict, retryAt: nextUtcDay(now) };
    } catch (err) {
      return {
        allowed: false,
        reason: `бюджет не прочитан: ${scrubQualityText(errMessage(err), 120)}`,
        retryAt: new Date(now.getTime() + backoffMs(1)),
      };
    }
  }

  // ── записи под арендой ───────────────────────────────────────────

  /** Запись под условием владения арендой; `null` — аренду потеряли. */
  private async write(
    row: CheckRow,
    owner: string,
    data: Prisma.TutorialDemoQualityCheckUpdateManyMutationInput,
  ): Promise<CheckRow | null> {
    const res = await this.prisma.tutorialDemoQualityCheck.updateMany({
      where: { id: row.id, leaseOwner: owner },
      data,
    });
    if (res.count !== 1) return null;
    return { ...row, ...(data as Partial<CheckRow>) };
  }

  /** Вернуть в очередь (`pending`), сняв аренду. */
  private async release(
    row: CheckRow,
    owner: string,
    data: Prisma.TutorialDemoQualityCheckUpdateManyMutationInput,
  ): Promise<boolean> {
    return (
      (await this.write(row, owner, {
        ...data,
        status: 'pending',
        leaseOwner: null,
        leaseUntil: null,
      })) !== null
    );
  }

  /** Завершить (`complete`) и убрать файл провайдера. */
  private async finish(
    row: CheckRow,
    owner: string,
    data: Prisma.TutorialDemoQualityCheckUpdateManyMutationInput,
  ): Promise<'complete' | 'lost'> {
    const ok = await this.write(row, owner, {
      ...data,
      leaseOwner: null,
      leaseUntil: null,
      nextAttemptAt: null,
    });
    if (!ok) return 'lost';
    await this.cleanupProviderFile(row);
    return 'complete';
  }

  private async finishError(
    row: CheckRow,
    owner: string,
    reason: string,
  ): Promise<'error' | 'lost'> {
    const ok = await this.write(row, owner, {
      status: 'error',
      error: scrubQualityText(reason, 300),
      leaseOwner: null,
      leaseUntil: null,
      nextAttemptAt: null,
    });
    if (!ok) return 'lost';
    await this.cleanupProviderFile(row);
    return 'error';
  }

  /**
   * Неудачная попытка: временная — повтор с паузой, пока попыток меньше
   * `MAX_ATTEMPTS`; постоянная или последняя — `error`.
   */
  private async failAttempt(
    row: CheckRow,
    owner: string,
    err: unknown,
  ): Promise<'retried' | 'error' | 'lost'> {
    const attempts = row.attempts + 1;
    const message = scrubQualityText(errMessage(err), 300);
    const transient = isTransientError(err);
    this.logger.warn(
      `проверка качества ${row.id} (${row.phase}), попытка ${attempts}: ${message}`,
    );
    if (!transient || attempts >= MAX_ATTEMPTS) {
      const ok = await this.write(row, owner, { attempts });
      if (!ok) return 'lost';
      return this.finishError(
        { ...row, attempts },
        owner,
        transient ? `после ${attempts} попыток: ${message}` : message,
      );
    }
    const ok = await this.release(row, owner, {
      attempts,
      error: message,
      nextAttemptAt: new Date(this.clock() + backoffMs(attempts)),
    });
    return ok ? 'retried' : 'lost';
  }

  private async cleanupProviderFile(row: CheckRow): Promise<void> {
    if (!row.providerFileName) return;
    await this.gemini.deleteFile(row.providerFileName).catch(() => undefined);
    await this.prisma.tutorialDemoQualityCheck
      .updateMany({
        where: { id: row.id, providerFileName: row.providerFileName },
        data: { providerFileName: null, providerFileUri: null },
      })
      .catch(() => undefined);
  }
}

function iso(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString() : null;
}

export function toView(r: CheckRow): DemoQualityCheckView {
  return {
    id: r.id,
    assetId: r.assetId,
    versionId: r.versionId,
    trigger: r.trigger,
    status: r.status as DemoQualityStatus,
    phase: r.phase as DemoQualityPhase,
    verdict: (r.verdict as QualityVerdict | null) ?? null,
    attempts: r.attempts,
    nextAttemptAt: iso(r.nextAttemptAt),
    error: r.error,
    report: (r.report as DemoQualityReport | null) ?? null,
    preflight: (r.preflight as PreflightResult | null) ?? null,
    costMicroUsd: r.costMicroUsd,
    unpriced: r.unpriced,
    modelId: r.modelId,
    rubricVersion: r.rubricVersion,
    reusedFromId: r.reusedFromId,
    durationMs: r.durationMs,
    theme: r.theme,
    locale: r.locale,
    captureBuild: r.captureBuild,
    captureMode: r.captureMode,
    createdAt: new Date(r.createdAt).toISOString(),
    checkedAt: iso(r.checkedAt),
  };
}
