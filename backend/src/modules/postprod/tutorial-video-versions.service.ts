/**
 * Версии роликов обучалки с другим темпом — постпродакшен обучалок
 * (doc/TUTORIAL-POSTPROD-TEMPO-SPEC.md; решения владельца 06.10.2026).
 *
 * ## Что здесь и почему здесь
 *
 * Сборка ролика обучалки (сценарный раннер, одобрение обучалки клиента)
 * пишет вместе с роликом монтажный manifest (`tutorial-manifest.ts`).
 * Этот сервис — всё, что происходит с роликом ПОСЛЕ: бесплатный расчёт
 * длительности и предпросмотр по manifest, одна платная сборка версии по
 * «Сохранить», опрос её задачи в кроне `tutorial-assembly-poll`,
 * техническая проверка файла, активация и возврат к «обычному».
 *
 * ## Версия не видна никому, пока её не активировали
 *
 * Версия — строка `TutorialVideoVersion`, а не новая строка ролика:
 * синхронизация сайта помощника (`client-site-media`), консультант,
 * лендинг и ночной подметальщик читают только `TutorialVideoAsset` и о
 * версиях не знают. Активация переписывает у строки ролика файл и
 * длительность (`tutorial-video-asset-writes.ts`) — и только тогда
 * потребители видят новый ролик. Исходный файл сохраняется версией
 * `kind = 'source'`: «вернуть обычный» = активировать её.
 *
 * Обучалка клиента активируется САМА после технической проверки файла
 * (`checkTutorialVideo`), без оператора; публичное (сценарное) демо —
 * только после повторного одобрения оператором (решение владельца).
 *
 * ## Темп переживает пересборку (заход 7, 07.10.2026)
 *
 * Новый ночной ролик сценарного пути собирается СРАЗУ с темпом, который
 * оператор выбрал для пары (тема/сценарий, локаль, тема оформления), —
 * одной сборкой, а не «обычный + версия» двумя платными
 * (`inheritedTempoFor` → раннер → `appliedTempo` в manifest →
 * `adoptInheritedTempo` при `complete`). Ролик по-прежнему ждёт
 * одобрения оператором (`reviewed`); «вернуть обычный» у такого ролика —
 * отдельная сборка ×1, исходного «обычного» файла у него нет.
 *
 * Активация файла одобренного ролика штатной обучалки пересылает набор
 * роликов тенанта лендинга (`LandingVideosService.requestSync`, Ш5 (12)):
 * иначе у тенанта осталась бы ссылка на прежний файл.
 *
 * ## Деньги
 *
 * Расчёт и предпросмотр бесплатны (в браузере, по тому же manifest).
 * Платная — одна задача ffmpeg-api на «Сохранить» (≈$0.01), под суточным
 * лимитом пользователя (`PlanService.assertCanSpendUser`), с ключом
 * идемпотентности (двойной клик и повтор крона не создают второй
 * задачи) и замком «уже собирается» на ролик. Синтез речи при смене
 * темпа не вызывается вовсе: дорожки лежат в исходниках manifest.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { FfmpegApiService } from './ffmpeg-api.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PlanService } from '../plan/plan.service';
import { TtsProviderResolverService } from '../tts/tts-provider-resolver.service';
import { ClientSiteMediaService } from '../client-site-media/client-site-media.service';
import { LandingVideosService } from '../client-site-media/landing-videos.service';
import { isSiteTutorialDemoFamilyKey } from '../tutorial-help/site-tutorial-demo';
import {
  assetThemeWhere,
  ScenarioTheme,
} from '../tutorial-runner/tutorial-theme-rotation';
import { pathnameFromBlobUrl } from '../../common/blob-paths';
import { releaseJobLock, tryAcquireJobLock } from '../../common/cron-job-lock';
import { Prisma } from '@prisma/client';
import {
  CANVAS,
  planSlideshow,
} from '../tutorial-runner/tutorial-video-assembly';
import {
  buildTutorialCaptionsAss,
  hasCaptions,
} from '../tutorial-runner/tutorial-captions';
import {
  normalizeTempoFactor,
  planTempo,
  presetOfFactor,
  TempoPreset,
  TempoWarning,
} from '../tutorial-runner/tutorial-tempo';
import {
  ActivationPlan,
  ManifestFrame,
  ManifestSpeech,
  manifestCaptionFrames,
  manifestEditability,
  manifestSlides,
  ManifestUnavailableReason,
  parseTutorialManifest,
  SOURCE_VERSION_KEY,
  sourceFramePathname,
  sourceVoicePathname,
  tempoIdempotencyKey,
  tempoInputs,
  tempoPreview,
  TempoPreview,
  textSha,
  TUTORIAL_MANIFEST_VERSION,
  TUTORIAL_VERSIONS_PREFIX,
  tutorialSourcesPrefix,
  TutorialTimelineManifest,
  tutorialVersionPathname,
  versionCaptionsPathname,
} from '../tutorial-runner/tutorial-manifest';
import { checkTutorialVideo, probeMp4 } from '../tutorial-runner/mp4-probe';
import {
  activateOnAsset,
  markActiveVersionIfUnset,
  writeAssetManifest,
} from './tutorial-video-asset-writes';

/** Потолок ожидания задачи — тот же, что у сборки ролика (10 мин). */
export const VERSION_ASSEMBLY_DEADLINE_MS = 10 * 60 * 1000;
/** Сколько раз пробуем собрать один и тот же темп после провалов. */
export const MAX_VERSION_ATTEMPTS = 3;
/** Замок «уже собирается» на ролик — на время захвата и отправки. */
const VERSION_LOCK_TTL_MS = 2 * 60 * 1000;
const POLL_BATCH = 30;
/** Ожидание строки параллельного запроса того же темпа (двойной клик). */
const LOCK_WAIT_STEPS = 12;
const LOCK_WAIT_MS = 250;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MIN_VIDEO_BYTES = 1024;
/** Кто «заказал» версию, унаследованную новым роликом от темпа пары. */
export const INHERITED_TEMPO_REQUESTER = 'system:tempo-inherit';
/** Провайдер озвучки обучалки клиента — по умолчанию проекта (решение
 *  владельца 06.10.2026: Resemble, не ElevenLabs). */
export const CLIENT_TUTORIAL_TTS_PROVIDER = 'resemble' as const;

/** Почему темп недоступен — человеческими словами для текста отказа. */
const UNAVAILABLE_TEXT: Record<ManifestUnavailableReason, string> = {
  'no-manifest': 'ролик собран до монтажного плана, пересоберите обучалку',
  'whole-track': 'озвучка одной дорожкой не привязана к кадрам',
  'sources-pending': 'исходники ролика не сохранены',
  'not-complete': 'ролик ещё не собран',
  'frames-purged': 'кадры черновика удалены по сроку хранения',
};

export type VersionStatus = 'preparing' | 'pending' | 'complete' | 'failed';

/** Кто просит: пользователь (своя обучалка) или оператор админки. */
export type TempoActor =
  | { kind: 'user'; userId: string }
  | { kind: 'operator'; userId: string };

export interface TutorialVersionView {
  id: string;
  kind: 'source' | 'tempo';
  factor: number;
  preset: TempoPreset | null;
  status: VersionStatus;
  durationMs: number | null;
  /** Файл собранной версии — посмотреть до того, как сделать действующей. */
  url: string | null;
  active: boolean;
  requiresApproval: boolean;
  approved: boolean;
  createdAt: string;
  /** Причина провала — только оператору; пользователю — сам факт. */
  error?: string | null;
}

export interface TutorialTempoEstimate {
  assetId: string;
  title: string;
  /** Файл, который сейчас отдаётся (активная версия или исходный). */
  url: string | null;
  /** Его длительность. */
  currentDurationMs: number | null;
  editable: boolean;
  reason: ManifestUnavailableReason | null;
  factor: number;
  preset: TempoPreset | null;
  durationMs: number | null;
  sourceDurationMs: number | null;
  minimumDurationMs: number | null;
  warnings: TempoWarning[];
  preview: TempoPreview | null;
  /** У ролика есть покадровая речь (иначе — немой темп). */
  voiced: boolean;
  activeFactor: number;
  inFlight: TutorialVersionView | null;
}

export interface UserTutorialItem {
  assetId: string;
  draftId: string;
  title: string;
  url: string;
  durationMs: number | null;
  createdAt: string;
  editable: boolean;
  reason: ManifestUnavailableReason | null;
  activeFactor: number;
  voiced: boolean;
  inFlight: boolean;
}

export interface VersionRequestResult {
  version: TutorialVersionView;
  /** true — ничего не отправлялось (тот же ключ уже собран/собирается,
   *  или возврат к обычному без сборки). */
  reused: boolean;
}

interface AssetRow {
  id: string;
  subjectKey: string;
  /** Одобрен ли ролик (публичная выдача) — повод пересылки набора лендинга. */
  reviewed?: boolean;
  theme?: string | null;
  locale: string;
  title: string;
  clientSiteDraftId: string | null;
  scenarioId: string | null;
  assemblyStatus: string;
  blobUrl: string | null;
  durationMs: number | null;
  contentHash: string | null;
  tempoManifest: unknown;
  activeVersionId: string | null;
  createdAt: Date;
}

interface VersionRow {
  id: string;
  assetId: string;
  kind: string;
  tempoFactor: number | null;
  motion: string;
  manifestVersion: number;
  idempotencyKey: string;
  status: string;
  error: string | null;
  jobId: string | null;
  startedAt: Date | null;
  attempts: number;
  blobUrl: string | null;
  videoMs: number | null;
  requiresApproval: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  requestedBy: string;
  activatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ASSET_SELECT = {
  id: true,
  subjectKey: true,
  reviewed: true,
  theme: true,
  locale: true,
  title: true,
  clientSiteDraftId: true,
  scenarioId: true,
  assemblyStatus: true,
  blobUrl: true,
  durationMs: true,
  contentHash: true,
  tempoManifest: true,
  activeVersionId: true,
  createdAt: true,
} as const;

function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class TutorialVideoVersionsService {
  private readonly logger = new Logger(TutorialVideoVersionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly ffmpeg: FfmpegApiService,
    private readonly aiUsage: AiUsageService,
    private readonly plan: PlanService,
    private readonly tts: TtsProviderResolverService,
    @Optional() private readonly siteMedia?: ClientSiteMediaService,
    // Ш5 (12), заход 7: активация файла одобренного ролика штатной
    // обучалки — набор роликов тенанта лендинга переслать. Необязателен —
    // стенды и тесты без sites-backend.
    @Optional() private readonly landingVideos?: LandingVideosService,
  ) {}

  // ── чтение ─────────────────────────────────────────────────────────

  /**
   * Обучалки пользователя для вкладки «Постпрод»: по одному ролику на
   * черновик — последний собранный (тот же, что видит экран мастера).
   * Владелец — через `draft.project.userId`; удалённые проекты не видны.
   */
  async listForUser(userId: string): Promise<UserTutorialItem[]> {
    const drafts = (await this.prisma.clientSiteTutorialDraft.findMany({
      where: { project: { userId, deletedAt: null } },
      select: { id: true, title: true, baseUrl: true, framesPurgedAt: true },
    })) as Array<{
      id: string;
      title: string | null;
      baseUrl: string;
      framesPurgedAt: Date | null;
    }>;
    if (drafts.length === 0) return [];
    const assets = (await this.prisma.tutorialVideoAsset.findMany({
      where: {
        clientSiteDraftId: { in: drafts.map((d) => d.id) },
        assemblyStatus: 'complete',
        blobUrl: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: ASSET_SELECT,
    })) as AssetRow[];
    const latest = new Map<string, AssetRow>();
    for (const a of assets) {
      if (a.clientSiteDraftId && !latest.has(a.clientSiteDraftId)) {
        latest.set(a.clientSiteDraftId, a);
      }
    }
    const ids = [...latest.values()].map((a) => a.id);
    const versions = ids.length
      ? ((await this.prisma.tutorialVideoVersion.findMany({
          where: { assetId: { in: ids } },
        })) as VersionRow[])
      : [];
    const out: UserTutorialItem[] = [];
    for (const d of drafts) {
      const a = latest.get(d.id);
      if (!a || !a.blobUrl) continue;
      const m = parseTutorialManifest(a.tempoManifest);
      const ed = this.editability(a, m, d.framesPurgedAt);
      const own = versions.filter((v) => v.assetId === a.id);
      out.push({
        assetId: a.id,
        draftId: d.id,
        title: d.title ?? a.title ?? d.baseUrl,
        url: a.blobUrl,
        durationMs: a.durationMs,
        createdAt: a.createdAt.toISOString(),
        editable: ed.editable,
        reason: ed.editable ? null : ed.reason,
        activeFactor: this.activeFactor(a, own),
        voiced: !!m?.frames.some((f) => f.speech),
        inFlight: own.some(
          (v) => v.status === 'preparing' || v.status === 'pending',
        ),
      });
    }
    return out.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  }

  /** Ролик, доступный актёру: пользователю — только свой (чужой — 404,
   *  без различия «нет» и «не ваш»); оператору — любой. */
  async requireAsset(
    actor: TempoActor,
    assetId: string,
  ): Promise<{
    asset: AssetRow;
    framesPurgedAt: Date | null;
    ownerUserId: string | null;
    projectId: string | null;
  }> {
    const asset = (await this.prisma.tutorialVideoAsset.findUnique({
      where: { id: assetId },
      select: ASSET_SELECT,
    })) as AssetRow | null;
    if (!asset) throw new NotFoundException('ролик не найден');
    let framesPurgedAt: Date | null = null;
    let ownerUserId: string | null = null;
    let projectId: string | null = null;
    if (asset.clientSiteDraftId) {
      const draft = (await this.prisma.clientSiteTutorialDraft.findUnique({
        where: { id: asset.clientSiteDraftId },
        select: {
          framesPurgedAt: true,
          projectId: true,
          project: { select: { userId: true, deletedAt: true } },
        },
      })) as {
        framesPurgedAt: Date | null;
        projectId: string;
        project: { userId: string | null; deletedAt: Date | null } | null;
      } | null;
      if (draft?.project && !draft.project.deletedAt) {
        ownerUserId = draft.project.userId;
        projectId = draft.projectId;
      }
      framesPurgedAt = draft?.framesPurgedAt ?? null;
      if (!draft) framesPurgedAt = new Date(0);
    }
    if (
      actor.kind === 'user' &&
      (!ownerUserId || ownerUserId !== actor.userId)
    ) {
      throw new NotFoundException('ролик не найден');
    }
    return { asset, framesPurgedAt, ownerUserId, projectId };
  }

  private editability(
    asset: Pick<AssetRow, 'assemblyStatus' | 'blobUrl'>,
    m: TutorialTimelineManifest | null,
    framesPurgedAt: Date | null,
  ):
    | { editable: true }
    | { editable: false; reason: ManifestUnavailableReason } {
    const ed = manifestEditability(asset, m);
    if (!ed.editable) return ed;
    if (m?.storage === 'draft-frames' && framesPurgedAt) {
      return { editable: false, reason: 'frames-purged' };
    }
    return ed;
  }

  private activeFactor(
    asset: AssetRow,
    versions: readonly VersionRow[],
  ): number {
    if (!asset.activeVersionId) return 1;
    const v = versions.find((x) => x.id === asset.activeVersionId);
    return v?.tempoFactor ?? 1;
  }

  private view(
    v: VersionRow,
    asset: AssetRow,
    withError: boolean,
  ): TutorialVersionView {
    const factor = v.tempoFactor ?? 1;
    const active =
      asset.activeVersionId === v.id ||
      (v.kind === 'source' && asset.activeVersionId === null);
    return {
      id: v.id,
      kind: v.kind === 'source' ? 'source' : 'tempo',
      factor,
      preset: presetOfFactor(factor),
      status: (['preparing', 'pending', 'complete', 'failed'].includes(v.status)
        ? v.status
        : 'pending') as VersionStatus,
      durationMs: v.videoMs,
      url: v.status === 'complete' ? v.blobUrl : null,
      active,
      requiresApproval: v.requiresApproval,
      approved: !!v.approvedAt,
      createdAt: v.createdAt.toISOString(),
      ...(withError ? { error: v.error } : {}),
    };
  }

  async listVersions(
    actor: TempoActor,
    assetId: string,
  ): Promise<TutorialVersionView[]> {
    const { asset } = await this.requireAsset(actor, assetId);
    const rows = (await this.prisma.tutorialVideoVersion.findMany({
      where: { assetId },
      orderBy: { createdAt: 'desc' },
    })) as VersionRow[];
    return rows.map((v) => this.view(v, asset, actor.kind === 'operator'));
  }

  /**
   * Бесплатный расчёт: итоговая длительность, предупреждения и
   * предпросмотр по manifest. Ни ffmpeg, ни синтеза.
   */
  async estimate(
    actor: TempoActor,
    assetId: string,
    rawFactor: unknown,
  ): Promise<TutorialTempoEstimate> {
    const factor = normalizeTempoFactor(rawFactor);
    if (factor === null) {
      throw new BadRequestException('темп вне диапазона 0…2');
    }
    const { asset, framesPurgedAt } = await this.requireAsset(actor, assetId);
    const versions = (await this.prisma.tutorialVideoVersion.findMany({
      where: { assetId },
      orderBy: { createdAt: 'desc' },
    })) as VersionRow[];
    const m = parseTutorialManifest(asset.tempoManifest);
    const ed = this.editability(asset, m, framesPurgedAt);
    const inFlightRow = versions.find(
      (v) => v.status === 'preparing' || v.status === 'pending',
    );
    const base: TutorialTempoEstimate = {
      assetId,
      title: asset.title,
      url: asset.blobUrl,
      currentDurationMs: asset.durationMs,
      editable: ed.editable,
      reason: ed.editable ? null : ed.reason,
      factor,
      preset: presetOfFactor(factor),
      durationMs: null,
      sourceDurationMs: null,
      minimumDurationMs: null,
      warnings: [],
      preview: null,
      voiced: !!m?.frames.some((f) => f.speech),
      activeFactor: this.activeFactor(asset, versions),
      inFlight: inFlightRow
        ? this.view(inFlightRow, asset, actor.kind === 'operator')
        : null,
    };
    if (!ed.editable || !m) return base;
    const inputs = tempoInputs(m);
    const tempo = planTempo(inputs, { factor, motion: m.motion });
    const normal = planTempo(inputs, { factor: 1, motion: m.motion });
    if (!tempo || !normal)
      return { ...base, editable: false, reason: 'no-manifest' };
    return {
      ...base,
      durationMs: tempo.durationMs,
      sourceDurationMs: normal.durationMs,
      minimumDurationMs: tempo.minimumDurationMs,
      warnings: tempo.warnings,
      preview: tempoPreview(m, tempo, m.motion),
    };
  }

  // ── сборка версии ──────────────────────────────────────────────────

  /**
   * «Сохранить» с выбранным темпом: одна платная сборка версии. Темп
   * «обычный» (×1) не собирается — это возврат к исходному файлу.
   */
  async requestVersion(
    actor: TempoActor,
    assetId: string,
    rawFactor: unknown,
  ): Promise<VersionRequestResult> {
    const factor = normalizeTempoFactor(rawFactor);
    if (factor === null) {
      throw new BadRequestException('темп вне диапазона 0…2');
    }
    const ctx = await this.requireAsset(actor, assetId);
    if (factor === 1) return this.revertOrBuild(actor, ctx);
    return this.buildVersion(actor, ctx, factor);
  }

  /**
   * Платная сборка версии темпа `factor` — с ключом идемпотентности,
   * замком и лимитом. Темп ×1 сюда попадает только у ролика, собранного
   * сразу с унаследованным темпом (у него нет исходного «обычного» файла).
   */
  private async buildVersion(
    actor: TempoActor,
    ctx: Awaited<ReturnType<TutorialVideoVersionsService['requireAsset']>>,
    factor: number,
  ): Promise<VersionRequestResult> {
    const { asset } = ctx;
    const assetId = asset.id;
    const m = parseTutorialManifest(asset.tempoManifest);
    const ed = this.editability(asset, m, ctx.framesPurgedAt);
    if (!ed.editable || !m) {
      throw new BadRequestException(
        `темп для этого ролика недоступен: ${UNAVAILABLE_TEXT[ed.editable ? 'no-manifest' : ed.reason]}`,
      );
    }
    const tempo = planTempo(tempoInputs(m), { factor, motion: m.motion });
    if (!tempo) {
      throw new BadRequestException('кадры ролика не годятся для пересборки');
    }
    const requiresApproval = asset.clientSiteDraftId === null;
    const key = tempoIdempotencyKey(m, factor, m.motion);

    const existing = (await this.prisma.tutorialVideoVersion.findUnique({
      where: { assetId_idempotencyKey: { assetId, idempotencyKey: key } },
    })) as VersionRow | null;
    if (existing && existing.status !== 'failed') {
      // Двойной клик / повтор: та же версия уже собрана или собирается.
      if (
        existing.status === 'complete' &&
        !existing.requiresApproval &&
        asset.activeVersionId !== existing.id
      ) {
        await this.activateVersion(asset, existing, null);
      }
      return {
        version: this.view(
          existing,
          await this.reloadAsset(assetId),
          actor.kind === 'operator',
        ),
        reused: true,
      };
    }
    if (existing && existing.attempts >= MAX_VERSION_ATTEMPTS) {
      throw new BadRequestException(
        `сборка этого темпа уже проваливалась ${existing.attempts} раз(а) — выберите другой темп`,
      );
    }
    if (!this.ffmpeg.configured()) {
      throw new ServiceUnavailableException(
        'сборка видео не настроена на этом стенде (FFMPEG_API_KEY)',
      );
    }

    const lockKey = `tutorial-version:${assetId}`;
    const lock = await tryAcquireJobLock(
      this.prisma,
      lockKey,
      VERSION_LOCK_TTL_MS,
    );
    if (!lock) {
      // Замок держит параллельный запрос. Если это тот же темп (двойной
      // клик), его строка появится через мгновение — отдаём её, а не
      // 409: человеку важно «сохраняется», а не «вы нажали дважды».
      for (let i = 0; i < LOCK_WAIT_STEPS; i++) {
        const raced = (await this.prisma.tutorialVideoVersion.findUnique({
          where: { assetId_idempotencyKey: { assetId, idempotencyKey: key } },
        })) as VersionRow | null;
        if (raced && raced.status !== 'failed') {
          return {
            version: this.view(raced, asset, actor.kind === 'operator'),
            reused: true,
          };
        }
        await new Promise((r) => setTimeout(r, LOCK_WAIT_MS));
      }
      throw new ConflictException(
        'версия этого ролика уже собирается — дождитесь её',
      );
    }
    try {
      const busy = (await this.prisma.tutorialVideoVersion.findFirst({
        where: { assetId, status: { in: ['preparing', 'pending'] } },
      })) as VersionRow | null;
      if (busy) {
        throw new ConflictException(
          'версия этого ролика уже собирается — дождитесь её',
        );
      }
      // Лимит — у того, на кого пишется расход: пользователь — своя
      // обучалка, оператор — свой (решение владельца: расход на
      // пользователя, суточный лимит как у других платных операций).
      await this.plan.assertCanSpendUser(actor.userId, {
        projectId: actor.kind === 'user' ? ctx.projectId : null,
      });
      await this.ensureSourceVersion(asset, m, actor.userId);

      let version: VersionRow;
      if (existing) {
        const claim = (await this.prisma.tutorialVideoVersion.updateMany({
          where: { id: existing.id, status: 'failed' },
          data: {
            status: 'preparing',
            error: null,
            jobId: null,
            startedAt: null,
            attempts: { increment: 1 },
            requestedBy: actor.userId,
          },
        })) as { count: number };
        if (claim.count === 0) {
          throw new ConflictException(
            'версия этого ролика уже собирается — дождитесь её',
          );
        }
        version = {
          ...existing,
          status: 'preparing',
          attempts: existing.attempts + 1,
        };
      } else {
        try {
          version = (await this.prisma.tutorialVideoVersion.create({
            data: {
              assetId,
              kind: 'tempo',
              tempoFactor: factor,
              motion: m.motion,
              manifestVersion: TUTORIAL_MANIFEST_VERSION,
              idempotencyKey: key,
              status: 'preparing',
              attempts: 1,
              requiresApproval,
              requestedBy: actor.userId,
            },
          })) as VersionRow;
        } catch (err) {
          if (isUniqueViolation(err)) {
            const raced = (await this.prisma.tutorialVideoVersion.findUnique({
              where: {
                assetId_idempotencyKey: { assetId, idempotencyKey: key },
              },
            })) as VersionRow | null;
            if (raced) {
              return {
                version: this.view(raced, asset, actor.kind === 'operator'),
                reused: true,
              };
            }
          }
          throw err;
        }
      }
      await this.submitVersion(asset, m, version, tempo.seconds, actor.userId);
      const fresh = (await this.prisma.tutorialVideoVersion.findUnique({
        where: { id: version.id },
      })) as VersionRow | null;
      return {
        version: this.view(fresh ?? version, asset, actor.kind === 'operator'),
        reused: false,
      };
    } finally {
      await releaseJobLock(this.prisma, lockKey, lock);
    }
  }

  private async reloadAsset(assetId: string): Promise<AssetRow> {
    const a = (await this.prisma.tutorialVideoAsset.findUnique({
      where: { id: assetId },
      select: ASSET_SELECT,
    })) as AssetRow | null;
    if (!a) throw new NotFoundException('ролик не найден');
    return a;
  }

  /**
   * Исходный файл ролика — версией `source`, один раз, до первой версии
   * темпа: «вернуть обычный» всегда есть куда, и исходник не теряется,
   * когда `blobUrl` строки переписан активной версией.
   */
  private async ensureSourceVersion(
    asset: AssetRow,
    m: TutorialTimelineManifest,
    requestedBy: string,
  ): Promise<void> {
    if (asset.activeVersionId !== null || !asset.blobUrl) return;
    try {
      await this.prisma.tutorialVideoVersion.create({
        data: {
          assetId: asset.id,
          kind: 'source',
          tempoFactor: null,
          motion: m.motion,
          manifestVersion: TUTORIAL_MANIFEST_VERSION,
          idempotencyKey: SOURCE_VERSION_KEY,
          status: 'complete',
          blobUrl: asset.blobUrl,
          videoMs: asset.durationMs,
          requiresApproval: false,
          requestedBy,
          activatedAt: asset.createdAt,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }

  /**
   * Подготовка и отправка задачи. Порядок тот же, что у сборки ролика:
   * строка уже заведена (`preparing`), подписи — под префиксом исходников,
   * затем `submit`, расход и только потом `pending` с `jobId`. Провал до
   * отправки — `failed` с инфраструктурной причиной, ролик не трогается.
   */
  private async submitVersion(
    asset: AssetRow,
    m: TutorialTimelineManifest,
    version: VersionRow,
    seconds: number[],
    spendUserId: string,
  ): Promise<void> {
    try {
      let captionsUrl: string | null = null;
      const captionFrames = manifestCaptionFrames(m, seconds);
      if (m.captions && hasCaptions(captionFrames)) {
        const ass = buildTutorialCaptionsAss(captionFrames, m.motion);
        const { url } = await this.blob.uploadBuffer(
          versionCaptionsPathname(asset.id, version.id),
          Buffer.from(ass, 'utf8'),
          'text/x-ssa; charset=utf-8',
        );
        captionsUrl = url;
      }
      const plan = planSlideshow(manifestSlides(m, seconds), {
        captionsUrl,
        motion: m.motion,
        outputName: 'tutorial.mp4',
      });
      if (!plan) {
        await this.failVersion(version.id, 'кадры не годятся для сборки');
        throw new BadRequestException('кадры ролика не годятся для пересборки');
      }
      const job = await this.ffmpeg.submit({
        inputs: plan.inputs,
        outputs: plan.outputs,
        commands: plan.commands,
      });
      await this.aiUsage.record({
        operation: 'tutorial-video-assembly',
        model: 'ffmpeg-api',
        userId: spendUserId,
      });
      await this.prisma.tutorialVideoVersion.updateMany({
        where: { id: version.id, status: 'preparing' },
        data: {
          status: 'pending',
          jobId: job.jobId,
          startedAt: new Date(),
          videoMs: plan.durationMs,
          motion: plan.motion,
        },
      });
      this.logger.log(
        `ролик ${asset.id}: версия ${version.id} (темп ×${version.tempoFactor}) отправлена на сборку (задача ${job.jobId})`,
      );
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      await this.failVersion(version.id, `infra: ${message(err)}`);
      throw new ServiceUnavailableException(
        'не удалось отправить версию на сборку — попробуйте ещё раз через минуту',
      );
    }
  }

  private async failVersion(versionId: string, reason: string): Promise<void> {
    await this.prisma.tutorialVideoVersion
      .updateMany({
        where: { id: versionId, status: { in: ['preparing', 'pending'] } },
        data: { status: 'failed', error: reason.slice(0, 500) },
      })
      .catch(() => undefined);
  }

  // ── опрос (крон tutorial-assembly-poll) ─────────────────────────────

  /**
   * Опрос незавершённых версий. Зовётся из `pollAssemblies` раннера —
   * под его замком, тем же тиком, что сборки роликов. Никогда не
   * бросает: сбой одной версии не роняет тик.
   *
   * @returns сколько версий опрошено.
   */
  async pollVersions(): Promise<{
    polled: number;
    completed: number;
    failed: number;
  }> {
    const result = { polled: 0, completed: 0, failed: 0 };
    try {
      const stale = (await this.prisma.tutorialVideoVersion.findMany({
        where: {
          status: 'preparing',
          updatedAt: {
            lt: new Date(Date.now() - VERSION_ASSEMBLY_DEADLINE_MS),
          },
        },
        take: POLL_BATCH,
        select: { id: true },
      })) as Array<{ id: string }>;
      for (const s of stale) {
        await this.failVersion(
          s.id,
          'infra: подготовка оборвалась, задача не отправлена',
        );
        result.failed++;
      }
      const pending = (await this.prisma.tutorialVideoVersion.findMany({
        where: { status: 'pending' },
        take: POLL_BATCH,
      })) as VersionRow[];
      for (const v of pending) {
        result.polled++;
        const outcome = await this.pollOne(v).catch((err) => {
          this.logger.warn(`версия ${v.id}: опрос не удался (${message(err)})`);
          return 'pending' as const;
        });
        if (outcome === 'complete') result.completed++;
        if (outcome === 'failed') result.failed++;
      }
    } catch (err) {
      this.logger.warn(`опрос версий обучалки не удался: ${message(err)}`);
    }
    return result;
  }

  private async pollOne(v: VersionRow): Promise<VersionStatus> {
    if (!v.jobId) {
      await this.failVersion(v.id, 'infra: задача не была отправлена');
      return 'failed';
    }
    if (
      v.startedAt &&
      Date.now() - v.startedAt.getTime() > VERSION_ASSEMBLY_DEADLINE_MS
    ) {
      await this.failVersion(
        v.id,
        `сборка не завершилась за ${VERSION_ASSEMBLY_DEADLINE_MS / 60000} мин`,
      );
      await this.dropCaptions(v);
      return 'failed';
    }
    if (!this.ffmpeg.configured()) return 'pending';
    let status;
    try {
      status = await this.ffmpeg.status(v.jobId);
    } catch (err) {
      this.logger.warn(
        `версия ${v.id}: статус сборки недоступен (${message(err)})`,
      );
      return 'pending';
    }
    if (status.status === 'pending') return 'pending';
    if (status.status === 'failed') {
      await this.failVersion(
        v.id,
        status.error ?? 'ffmpeg-api вернул ошибку без текста',
      );
      await this.dropCaptions(v);
      return 'failed';
    }
    const url = status.outputs
      ? Object.values(status.outputs).find(Boolean)
      : undefined;
    if (!url) {
      await this.failVersion(v.id, 'задача завершилась, но файла нет');
      await this.dropCaptions(v);
      return 'failed';
    }
    const asset = (await this.prisma.tutorialVideoAsset.findUnique({
      where: { id: v.assetId },
      select: ASSET_SELECT,
    })) as AssetRow | null;
    if (!asset) {
      await this.failVersion(v.id, 'ролик удалён, пока собиралась версия');
      return 'failed';
    }
    let bytes: Buffer;
    try {
      bytes = await this.download(url);
    } catch (err) {
      await this.failVersion(
        v.id,
        `infra: скачивание результата: ${message(err)}`,
      );
      return 'failed';
    }
    const m = parseTutorialManifest(asset.tempoManifest);
    const check = checkTutorialVideo(
      bytes.length >= MIN_VIDEO_BYTES ? probeMp4(bytes) : null,
      {
        durationMs: v.videoMs ?? 0,
        hasAudio: !!m?.frames.some((f) => f.speech),
        width: CANVAS.width,
        height: CANVAS.height,
      },
    );
    if (!check.ok) {
      // Провал проверки НЕ трогает действующий ролик: файл не заливается,
      // активировать нечего.
      await this.prisma.tutorialVideoVersion.updateMany({
        where: { id: v.id, status: 'pending' },
        data: {
          status: 'failed',
          error: `техническая проверка: ${check.problems.join('; ')}`.slice(
            0,
            500,
          ),
          probe: check as unknown as Prisma.InputJsonValue,
        },
      });
      await this.dropCaptions(v);
      return 'failed';
    }
    let ourUrl: string;
    try {
      ({ url: ourUrl } = await this.blob.uploadBuffer(
        tutorialVersionPathname(v.assetId, v.id),
        bytes,
        'video/mp4',
      ));
    } catch (err) {
      await this.failVersion(v.id, `infra: заливка версии: ${message(err)}`);
      return 'failed';
    }
    const done = (await this.prisma.tutorialVideoVersion.updateMany({
      where: { id: v.id, status: 'pending' },
      data: {
        status: 'complete',
        blobUrl: ourUrl,
        error: null,
        probe: check as unknown as Prisma.InputJsonValue,
      },
    })) as { count: number };
    await this.dropCaptions(v);
    if (done.count === 0) return 'pending';
    this.logger.log(`ролик ${v.assetId}: версия ${v.id} собрана и проверена`);
    if (!v.requiresApproval) {
      await this.activateVersion(
        asset,
        { ...v, status: 'complete', blobUrl: ourUrl },
        null,
      ).catch((err) =>
        this.logger.warn(
          `версия ${v.id}: активация не удалась (${message(err)})`,
        ),
      );
    }
    return 'complete';
  }

  private async dropCaptions(
    v: Pick<VersionRow, 'assetId' | 'id'>,
  ): Promise<void> {
    await this.blob
      .deleteBlob(versionCaptionsPathname(v.assetId, v.id))
      .catch(() => undefined);
  }

  private async download(url: string): Promise<Buffer> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // ── активация и возврат ────────────────────────────────────────────

  private async activateVersion(
    asset: AssetRow,
    v: VersionRow,
    approvedBy: string | null,
  ): Promise<void> {
    if (v.status !== 'complete' || !v.blobUrl) {
      throw new ConflictException('версия ещё не собрана');
    }
    const plan: ActivationPlan = { durationMs: v.videoMs };
    const ok = await activateOnAsset(this.prisma, asset.id, {
      versionId: v.kind === 'source' ? null : v.id,
      blobUrl: v.blobUrl,
      plan,
    });
    if (!ok) throw new ConflictException('ролик недоступен для замены');
    await this.prisma.tutorialVideoVersion.update({
      where: { id: v.id },
      data: {
        activatedAt: new Date(),
        ...(approvedBy ? { approvedBy, approvedAt: new Date() } : {}),
      },
    });
    if (asset.clientSiteDraftId && this.siteMedia) {
      await this.siteMedia.syncForDraft(asset.clientSiteDraftId);
    }
    // Ш5 (12): файл ОДОБРЕННОГО ролика штатной обучалки сменился — набор
    // тенанта лендинга иначе держал бы ссылку на прежний файл. Не демо
    // обучающего лендинга и не черновик клиента (у них свой путь выше и
    // в набор лендинга они не входят). Не ждём: `requestSync` с дебаунсом
    // и не бросает, а активацию по сети не задерживаем.
    if (
      this.landingVideos &&
      asset.reviewed === true &&
      !asset.clientSiteDraftId &&
      !isSiteTutorialDemoFamilyKey(asset.subjectKey)
    ) {
      void this.landingVideos.requestSync().catch(() => false);
    }
  }

  /**
   * Сделать собранную версию активной. Пользователю — только свои и не
   * требующие одобрения; оператору — любые, и это и есть повторное
   * одобрение публичного демо.
   */
  async activate(
    actor: TempoActor,
    assetId: string,
    versionId: string,
  ): Promise<TutorialVersionView> {
    const { asset } = await this.requireAsset(actor, assetId);
    const v = (await this.prisma.tutorialVideoVersion.findFirst({
      where: { id: versionId, assetId },
    })) as VersionRow | null;
    if (!v) throw new NotFoundException('версия не найдена');
    if (v.requiresApproval && actor.kind !== 'operator') {
      throw new ConflictException('эту версию делает активной оператор');
    }
    await this.activateVersion(
      asset,
      v,
      actor.kind === 'operator' && v.requiresApproval ? actor.userId : null,
    );
    const fresh = await this.reloadAsset(assetId);
    const row = (await this.prisma.tutorialVideoVersion.findUnique({
      where: { id: versionId },
    })) as VersionRow;
    return this.view(row, fresh, actor.kind === 'operator');
  }

  /**
   * Возврат к обычному темпу — исходный файл, без сборки. У ролика,
   * собранного сразу с унаследованным темпом, исходного «обычного» файла
   * нет — тогда это сборка версии ×1 (как любая версия: оплачивается, у
   * публичного демо ждёт одобрения оператора).
   */
  async revert(
    actor: TempoActor,
    assetId: string,
  ): Promise<TutorialVersionView> {
    const ctx = await this.requireAsset(actor, assetId);
    return (await this.revertOrBuild(actor, ctx)).version;
  }

  private async revertOrBuild(
    actor: TempoActor,
    ctx: Awaited<ReturnType<TutorialVideoVersionsService['requireAsset']>>,
  ): Promise<VersionRequestResult> {
    const { asset } = ctx;
    const assetId = asset.id;
    const source = (await this.prisma.tutorialVideoVersion.findUnique({
      where: {
        assetId_idempotencyKey: { assetId, idempotencyKey: SOURCE_VERSION_KEY },
      },
    })) as VersionRow | null;
    if (!source && asset.activeVersionId !== null) {
      return this.buildVersion(actor, ctx, 1);
    }
    if (!source) {
      // Версий темпа не было — ролик и так обычный.
      const version: TutorialVersionView = {
        id: 'source',
        kind: 'source',
        factor: 1,
        preset: 'normal',
        status: 'complete',
        durationMs: asset.durationMs,
        url: asset.blobUrl,
        active: true,
        requiresApproval: false,
        approved: false,
        createdAt: asset.createdAt.toISOString(),
      };
      return { version, reused: true };
    }
    if (asset.activeVersionId !== null) {
      await this.activateVersion(asset, source, null);
    }
    return {
      version: this.view(
        source,
        await this.reloadAsset(assetId),
        actor.kind === 'operator',
      ),
      reused: true,
    };
  }

  // ── темп пары переживает пересборку (заход 7) ───────────────────────

  /**
   * Темп, выбранный для пары (сценарий/тема, локаль, тема оформления):
   * множитель ПОСЛЕДНЕЙ активированной версии штатной обучалки этой пары.
   * `null` — обычный темп (версий не было, последним активировали
   * исходный файл или ×1). Никогда не бросает: без ответа новый ролик
   * соберётся обычным, как до захода 7.
   */
  async inheritedTempoFor(pair: {
    subjectKey: string;
    locale: string;
    theme: ScenarioTheme;
  }): Promise<{ factor: number; versionId: string } | null> {
    try {
      const v = await this.lastPairChoice(pair);
      if (!v || v.kind !== 'tempo') return null;
      const factor = normalizeTempoFactor(v.tempoFactor);
      if (factor === null || factor === 1) return null;
      return { factor, versionId: v.id };
    } catch (err) {
      this.logger.warn(
        `темп пары ${pair.subjectKey}/${pair.locale}/${pair.theme} не прочитан (${message(err)}) — ролик соберётся обычным`,
      );
      return null;
    }
  }

  /**
   * Последний выбор темпа в паре — по времени активации. Версии,
   * заведённые наследованием (`INHERITED_TEMPO_REQUESTER`), — только если
   * ручных нет вовсе (заход 7, аудит): иначе наследование, доехавшее до
   * `complete` позже ручной смены темпа, перебивало бы её.
   */
  private async lastPairChoice(pair: {
    subjectKey: string;
    locale: string;
    theme: ScenarioTheme;
  }): Promise<{
    id: string;
    kind: string;
    tempoFactor: number | null;
    activatedAt: Date | null;
  } | null> {
    const base = {
      status: 'complete',
      activatedAt: { not: null },
      asset: {
        subjectKey: pair.subjectKey,
        locale: pair.locale,
        clientSiteDraftId: null,
        AND: [assetThemeWhere(pair.theme)],
      },
    };
    const query = (requestedBy: string | { not: string }) =>
      this.prisma.tutorialVideoVersion.findFirst({
        where: { ...base, requestedBy },
        orderBy: [{ activatedAt: 'desc' }, { createdAt: 'desc' }],
        select: { id: true, kind: true, tempoFactor: true, activatedAt: true },
      }) as Promise<{
        id: string;
        kind: string;
        tempoFactor: number | null;
        activatedAt: Date | null;
      } | null>;
    return (
      (await query({ not: INHERITED_TEMPO_REQUESTER })) ??
      (await query(INHERITED_TEMPO_REQUESTER))
    );
  }

  /**
   * Сценарный ролик, собранный сразу с унаследованным темпом
   * (`manifest.appliedTempo`), при `complete`: его файл — уже версия
   * этого темпа. Заводим строку версии (complete, файл ролика) и делаем
   * её активной — постпродакшен показывает выбранный темп, «вернуть
   * обычный» знает, что обычного файла нет. Никогда не бросает.
   */
  async adoptInheritedTempo(assetId: string): Promise<void> {
    try {
      const asset = (await this.prisma.tutorialVideoAsset.findUnique({
        where: { id: assetId },
        select: ASSET_SELECT,
      })) as AssetRow | null;
      const m = parseTutorialManifest(asset?.tempoManifest);
      if (
        !asset ||
        !m?.appliedTempo ||
        asset.assemblyStatus !== 'complete' ||
        !asset.blobUrl ||
        asset.activeVersionId !== null
      ) {
        return;
      }
      // Без постоянных исходников версия темпа — ловушка: ни «вернуть
      // обычный», ни другой темп собрать не из чего (заход 7, аудит).
      // Раннер такие ролики собирает обычными; сюда это доходит только при
      // ручной правке строки.
      if (m.storage !== 'sources') {
        this.logger.warn(
          `ролик ${assetId}: темп пары записан, но исходников нет — версия не заводится`,
        );
        return;
      }
      const factor = normalizeTempoFactor(m.appliedTempo.factor);
      if (factor === null || factor === 1) return;
      const key = tempoIdempotencyKey(m, factor, m.motion);
      // Время активации — то же, что у версии, от которой темп унаследован
      // (заход 7, аудит): наследование отражает ТО решение оператора и не
      // должно выглядеть более поздним, чем его ручная смена после него.
      const from = (await this.prisma.tutorialVideoVersion.findUnique({
        where: { id: m.appliedTempo.fromVersionId },
        select: { activatedAt: true },
      })) as { activatedAt: Date | null } | null;
      const latest = await this.lastPairChoice({
        subjectKey: asset.subjectKey,
        locale: asset.locale,
        theme: asset.theme === 'dark' ? 'dark' : 'light',
      });
      if (latest && latest.id !== m.appliedTempo.fromVersionId) {
        // Файл уже собран в этом темпе — версия отражает правду файла, но
        // выбор пары оператор с тех пор сменил: следующий ролик возьмёт
        // его, а не этот.
        this.logger.warn(
          `ролик ${assetId}: темп пары сменился, пока собирался ролик (×${factor} → версия ${latest.id})`,
        );
      }
      let version: VersionRow | null = null;
      try {
        version = (await this.prisma.tutorialVideoVersion.create({
          data: {
            assetId,
            kind: 'tempo',
            tempoFactor: factor,
            motion: m.motion,
            manifestVersion: TUTORIAL_MANIFEST_VERSION,
            idempotencyKey: key,
            status: 'complete',
            attempts: 1,
            blobUrl: asset.blobUrl,
            videoMs: asset.durationMs,
            // Одобрение — у самого ролика (`reviewed`): новый ролик и так
            // ждёт оператора целиком.
            requiresApproval: false,
            requestedBy: INHERITED_TEMPO_REQUESTER,
            activatedAt: from?.activatedAt ?? new Date(),
          },
        })) as VersionRow;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        version = (await this.prisma.tutorialVideoVersion.findUnique({
          where: { assetId_idempotencyKey: { assetId, idempotencyKey: key } },
        })) as VersionRow | null;
      }
      if (!version) return;
      await markActiveVersionIfUnset(this.prisma, assetId, version.id);
      this.logger.log(
        `ролик ${assetId}: собран с темпом пары ×${factor} (версия ${version.id})`,
      );
    } catch (err) {
      this.logger.warn(
        `ролик ${assetId}: унаследованный темп не записан (${message(err)}) — постпродакшен покажет его как обычный`,
      );
    }
  }

  // ── исходники ──────────────────────────────────────────────────────

  /**
   * Сценарный путь, `complete`: перенести кадры и дорожки из транзита и
   * кеша озвучки в постоянный префикс исходников — ДО уборки транзитных
   * кадров. Копия, а не ссылка: транзит стирается сразу, кеш озвучки
   * вытесняет себя при правке реплик. Сбой — manifest остаётся
   * `transit`, темп для ролика недоступен с объяснением; ролик не
   * страдает. Никогда не бросает.
   */
  async captureScenarioSources(assetId: string): Promise<void> {
    try {
      const asset = (await this.prisma.tutorialVideoAsset.findUnique({
        where: { id: assetId },
        select: ASSET_SELECT,
      })) as AssetRow | null;
      const m = parseTutorialManifest(asset?.tempoManifest);
      if (!asset || !m || m.storage !== 'transit') return;
      const frames = await this.copyFramesToSources(assetId, m.frames);
      if (!frames) return;
      await writeAssetManifest(this.prisma, assetId, {
        ...m,
        storage: 'sources',
        frames,
      });
    } catch (err) {
      this.logger.warn(
        `ролик ${assetId}: исходники для темпа не сохранены (${message(err)}) — темп для него будет недоступен`,
      );
    }
  }

  /**
   * Кадры и дорожки — из транзита и кеша озвучки в постоянный префикс
   * исходников ролика. `null` — хоть одна копия не удалась (или у кадра
   * нет пути): исходников нет. Никогда не бросает.
   *
   * Раннер зовёт это ДО отправки сборки, когда собирается сразу с
   * унаследованным темпом (заход 7, аудит): ролик в темпе без исходников
   * навсегда остался бы без «вернуть обычный», поэтому без исходников он
   * собирается обычным — одной сборкой, не двумя.
   */
  async copyFramesToSources(
    assetId: string,
    source: readonly ManifestFrame[],
  ): Promise<ManifestFrame[] | null> {
    try {
      const frames: ManifestFrame[] = [];
      for (const f of source) {
        if (!f.image.pathname) return null;
        const to = sourceFramePathname(assetId, f.stepIndex);
        const url = await this.blob.copyBlob(f.image.pathname, to, 'image/png');
        if (!url) return null;
        let speech: ManifestSpeech | null = f.speech;
        if (f.speech) {
          if (!f.speech.pathname) return null;
          const vto = sourceVoicePathname(
            assetId,
            f.stepIndex,
            f.speech.provenance.textSha || textSha(f.speech.text),
            f.speech.seconds === null ? null : f.speech.seconds * 1000,
          );
          const vurl = await this.blob.copyBlob(
            f.speech.pathname,
            vto,
            'audio/mpeg',
          );
          if (!vurl) return null;
          speech = { ...f.speech, url: vurl, pathname: vto };
        }
        frames.push({ ...f, image: { url, pathname: to }, speech });
      }
      return frames;
    } catch (err) {
      this.logger.warn(
        `ролик ${assetId}: исходники не скопированы (${message(err)})`,
      );
      return null;
    }
  }

  /**
   * Всё, что принадлежит ролику сверх его строки и основного файла:
   * файлы версий (включая исходный, если `blobUrl` строки уже указывает
   * на версию), исходники для темпа. Зовётся ПЕРЕД удалением строки
   * (подметальщик раннера). Бросает — вызывающий оставит строку до
   * следующего тика, иначе пути к файлам потеряются.
   */
  async deleteAssetExtras(assetId: string): Promise<void> {
    const versions = (await this.prisma.tutorialVideoVersion.findMany({
      where: { assetId },
      select: { blobUrl: true },
    })) as Array<{ blobUrl: string | null }>;
    const paths = versions
      .map((v) => pathnameFromBlobUrl(v.blobUrl, 'tutorial-videos/'))
      .filter((p): p is string => !!p);
    if (paths.length > 0) await this.blob.deleteMany(paths);
    await this.wipePrefix(tutorialSourcesPrefix(assetId));
    await this.wipePrefix(`${TUTORIAL_VERSIONS_PREFIX}${assetId}/`);
  }

  /** Исходники ролика (дорожки озвучки клиента) — при удалении черновика. */
  async wipeSources(assetId: string): Promise<void> {
    await this.wipePrefix(tutorialSourcesPrefix(assetId));
  }

  private async wipePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.blob.listByPrefix(prefix, { cursor });
      if (page.blobs.length > 0) {
        await this.blob.deleteMany(page.blobs.map((b) => b.pathname));
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }

  // ── озвучка обучалки клиента ───────────────────────────────────────

  /**
   * Покадровая озвучка обучалки по сайту клиента (решение владельца
   * 06.10.2026). Провайдер — Resemble (по умолчанию проекта), язык —
   * язык черновика, текст — `clientFrameNarrations` (уже без ПД),
   * расход — на владельца проекта под его суточным лимитом.
   *
   * Дорожка с тем же текстом из прошлой сборки этого черновика
   * копируется, а не синтезируется заново: повторное одобрение после
   * провала не платит за ту же речь второй раз.
   *
   * Немой кадр — штатный исход (синтез отказал, лимит, провайдер не
   * настроен); `skipped` объясняет, почему озвучки нет вовсе.
   */
  async synthesizeClientVoices(input: {
    assetId: string;
    draftId: string;
    ownerUserId: string;
    projectId: string;
    locale: string;
    texts: readonly (string | null)[];
    stepIndexes: readonly number[];
  }): Promise<{ speech: (ManifestSpeech | null)[]; skipped: string | null }> {
    const none = input.texts.map(() => null);
    const provider = this.tts.resolveByKey(CLIENT_TUTORIAL_TTS_PROVIDER);
    if (!provider.configured()) {
      return { speech: none, skipped: 'tts-not-configured' };
    }
    try {
      await this.plan.assertCanSpendUser(input.ownerUserId, {
        projectId: input.projectId,
      });
    } catch {
      return { speech: none, skipped: 'daily-limit' };
    }
    const reuse = await this.previousTracks(input.draftId, input.assetId);
    const speech: (ManifestSpeech | null)[] = [];
    for (const [i, text] of input.texts.entries()) {
      const stepIndex = input.stepIndexes[i];
      if (!text) {
        speech.push(null);
        continue;
      }
      const sha = textSha(
        `${input.locale}\u0000${provider.providerKey}\u0000${text}`,
      );
      try {
        const prev = reuse.get(sha);
        if (prev?.pathname) {
          const to = sourceVoicePathname(
            input.assetId,
            stepIndex,
            sha,
            prev.seconds === null ? null : prev.seconds * 1000,
          );
          const url = await this.blob.copyBlob(prev.pathname, to, 'audio/mpeg');
          if (url) {
            speech.push({ ...prev, url, pathname: to });
            continue;
          }
        }
        // Лимит — перед КАЖДЫМ синтезом: сорок реплик это сорок трат,
        // остановиться надо на той, что перевалила.
        if (i > 0) {
          try {
            await this.plan.assertCanSpendUser(input.ownerUserId, {
              projectId: input.projectId,
            });
          } catch {
            speech.push(null);
            continue;
          }
        }
        const outcome = await provider.synthesize({
          text,
          language: input.locale,
          voiceId: null,
        });
        if (!outcome.ok) {
          this.logger.warn(
            `черновик ${input.draftId}: синтез кадра ${stepIndex} не состоялся (${outcome.reason}) — кадр будет немым`,
          );
          speech.push(null);
          continue;
        }
        await this.aiUsage.record({
          operation: 'tutorial-voiceover',
          model: `${provider.providerKey}-tts`,
          characters: outcome.characters,
          userId: input.ownerUserId,
        });
        const seconds =
          outcome.durationSeconds !== null &&
          Number.isFinite(outcome.durationSeconds)
            ? outcome.durationSeconds
            : null;
        const pathname = sourceVoicePathname(
          input.assetId,
          stepIndex,
          sha,
          seconds === null ? null : seconds * 1000,
        );
        const { url } = await this.blob.uploadBuffer(
          pathname,
          outcome.audio,
          outcome.mimeType,
        );
        speech.push({
          url,
          pathname,
          seconds,
          text,
          provenance: {
            provider: provider.providerKey,
            voiceId: outcome.voiceId ?? null,
            locale: input.locale,
            textSha: sha,
          },
        });
      } catch (err) {
        this.logger.warn(
          `черновик ${input.draftId}: дорожка кадра ${stepIndex} не получилась (${message(err)}) — кадр будет немым`,
        );
        speech.push(null);
      }
    }
    return {
      speech,
      skipped: speech.some(Boolean) ? null : 'synthesis-failed',
    };
  }

  /** Дорожки прошлых сборок черновика по ключу (язык, провайдер, текст). */
  private async previousTracks(
    draftId: string,
    exceptAssetId: string,
  ): Promise<Map<string, ManifestSpeech>> {
    const out = new Map<string, ManifestSpeech>();
    const rows = (await this.prisma.tutorialVideoAsset
      .findMany({
        where: { clientSiteDraftId: draftId, id: { not: exceptAssetId } },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { tempoManifest: true },
      })
      .catch(() => [])) as Array<{ tempoManifest: unknown }>;
    for (const r of rows) {
      const m = parseTutorialManifest(r.tempoManifest);
      for (const f of m?.frames ?? []) {
        if (f.speech && !out.has(f.speech.provenance.textSha)) {
          out.set(f.speech.provenance.textSha, f.speech);
        }
      }
    }
    return out;
  }
}
