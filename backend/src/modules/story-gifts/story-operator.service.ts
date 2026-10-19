import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import { downloadStoryVideo } from './story-video-result';
import { storyDigest } from './story-video-plan';

/**
 * WP1 (TODO 84): operator reconciliation of Story-Tales results left in
 * UNKNOWN without a receipt. Never synthesizes, submits, runs QA or guesses a
 * result: the only provider call is a read-only `ffmpeg.status(jobId)` for a
 * job id the operator confirmed in the provider dashboard.
 */
export const STORY_REF_PREFIX = 'story-ref:v1:';
const REF_ID = /^([a-f0-9]{64})([A-Za-z0-9_-]{11})$/;
export const STORY_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{3,127}$/;
const REF_RUNNING_STALE_MS = 5 * 60_000;
const GIFT_LIVE = ['READY', 'APPROVED'];

export type StoryOperatorAction =
  | 'gift.close-failed'
  | 'gift.reopen-draft'
  | 'gift.qa-reset'
  | 'render.bind-job'
  | 'render.close-failed'
  | 'render.qa-reset'
  | 'reference.close-unavailable'
  | 'reference.delete'
  | 'segment.close-deleted';
type Target = 'gift' | 'render' | 'reference' | 'segment';
export interface StoryOperatorInput {
  reason: string;
  requestId: string;
}
type Tx = Prisma.TransactionClient;

const hours = (d: Date | string, now = Date.now()) =>
  Math.max(0, Math.round((now - new Date(d).getTime()) / 36e5));
const usd = (micro: number) => micro / 1e6;

const STAGES: Record<string, string> = {
  'проверка базового видео': 'base',
  'озвучка основной сказки': 'main',
  'озвучка преамбулы': 'voice',
  'озвучка реплики о подарке': 'note',
  'озвучка завершения': 'outro',
  'отправка сборщику': 'submit',
};
/** Render-input URL of a submitted job: `…/story-render-input/<token>/<part>`. */
const RENDER_INPUT_TOKEN = /\/story-render-input\/([A-Za-z0-9_-]{43})(?:\/|$)/;
/** Where an UNKNOWN render stopped, from durable fields first, then the system error text. */
export function storyRenderStage(r: {
  status: string;
  qaStatus?: string | null;
  jobId?: string | null;
  error?: string | null;
}) {
  if (r.status === 'READY' && r.qaStatus === 'UNKNOWN') return 'qa';
  if (r.jobId) return 'poll';
  const label = /на этапе «([^»]+)»/.exec(r.error ?? '')?.[1];
  if (label && STAGES[label]) return STAGES[label];
  if ((r.error ?? '').includes('Нет сохранённого задания')) return 'no-job';
  return 'unknown';
}
interface RefRecord {
  id: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  pendingAssessment?: string;
  error?: string;
  [k: string]: unknown;
}
function refState(rec: RefRecord, now = Date.now()) {
  if (rec.status === 'unknown') return 'unknown';
  if (
    rec.status === 'running' &&
    now - Date.parse(rec.startedAt) > REF_RUNNING_STALE_MS
  )
    return 'running-stale';
  return null;
}

@Injectable()
export class StoryOperatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ffmpeg: FfmpegApiService,
  ) {}

  /** Records that need an operator. Ids, stage, age and reserve only: no text, media or owner identity. */
  async queue() {
    const now = Date.now();
    const gifts = await this.prisma.storyGift.findMany({
      where: {
        OR: [
          { status: 'UNKNOWN' },
          { status: { in: GIFT_LIVE }, audioQaStatus: 'UNKNOWN' },
        ],
      },
      select: {
        id: true,
        status: true,
        audioQaStatus: true,
        catalogId: true,
        reservedMicroUsd: true,
        budgetCents: true,
        error: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
    });
    const renders = await this.prisma.storyVideoRender.findMany({
      where: {
        OR: [{ status: 'UNKNOWN' }, { status: 'READY', qaStatus: 'UNKNOWN' }],
        gift: { status: { in: GIFT_LIVE } },
      },
      select: {
        id: true,
        giftId: true,
        status: true,
        qaStatus: true,
        jobId: true,
        preambleDuration: true,
        durationSeconds: true,
        reservedMicroUsd: true,
        userVoiceId: true,
        error: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
    });
    const refRows = await this.prisma.platformSetting.findMany({
      where: {
        key: { startsWith: STORY_REF_PREFIX },
        OR: [
          { value: { contains: '"status":"unknown"' } },
          { value: { contains: '"status":"running"' } },
        ],
      },
      select: { key: true, value: true, updatedAt: true },
      orderBy: { updatedAt: 'asc' },
      take: 100,
    });
    const references = refRows.flatMap((row) => {
      let rec: RefRecord;
      try {
        rec = JSON.parse(row.value) as RefRecord;
      } catch {
        return [];
      }
      const state = refState(rec, now);
      if (!state) return [];
      return [
        {
          ref: row.key.slice(STORY_REF_PREFIX.length).replace(':', ''),
          videoId: rec.id,
          state,
          hasPendingAssessment: !!rec.pendingAssessment,
          startedAt: rec.startedAt,
          ageHours: hours(rec.startedAt, now),
          error: rec.error?.slice(0, 300) ?? null,
        },
      ];
    });
    return {
      generatedAt: new Date(now).toISOString(),
      gifts: gifts.map((g) => ({
        id: g.id,
        stage: g.status === 'UNKNOWN' ? 'synthesis' : 'qa',
        status: g.status,
        audioQaStatus: g.audioQaStatus,
        catalogId: g.catalogId,
        reservedUsd: usd(g.reservedMicroUsd),
        budgetUsd: g.budgetCents / 100,
        ageHours: hours(g.createdAt, now),
        idleHours: hours(g.updatedAt, now),
        error: g.error?.slice(0, 300) ?? null,
      })),
      renders: renders.map((r) => ({
        id: r.id,
        giftId: r.giftId,
        status: r.status,
        qaStatus: r.qaStatus,
        stage: storyRenderStage(r),
        hasJobId: !!r.jobId,
        submitReached: r.preambleDuration != null && r.durationSeconds != null,
        voice: r.userVoiceId ? 'parent' : 'nova',
        reservedUsd: usd(r.reservedMicroUsd),
        ageHours: hours(r.createdAt, now),
        idleHours: hours(r.updatedAt, now),
        error: r.error?.slice(0, 300) ?? null,
      })),
      references,
      segments: await this.unknownSegments(now),
    };
  }

  /**
   * WP4 segment cache rows left in UNKNOWN (a TTS attempt without a confirmed
   * result). Never the text or audio: ids, source, the segment kind as
   * planned in a render manifest of the same gift, age and a key prefix.
   */
  private async unknownSegments(now: number) {
    const rows = await this.prisma.storyVideoSegment.findMany({
      where: { status: 'UNKNOWN', gift: { status: { in: GIFT_LIVE } } },
      select: {
        id: true,
        giftId: true,
        source: true,
        cacheKey: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
    });
    if (!rows.length) return [];
    const renders = await this.prisma.storyVideoRender.findMany({
      where: { giftId: { in: [...new Set(rows.map((r) => r.giftId))] } },
      select: { id: true, giftId: true, segments: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map((row) => {
      let kind: string | null = null;
      let renderId: string | null = null;
      for (const r of renders) {
        if (r.giftId !== row.giftId) continue;
        const list = (r.segments as { segments?: unknown } | null)?.segments;
        const hit = Array.isArray(list)
          ? (list as { kind?: unknown; cacheKey?: unknown }[]).find(
              (s) => s?.cacheKey === row.cacheKey,
            )
          : undefined;
        if (hit && typeof hit.kind === 'string') {
          kind = hit.kind;
          renderId = r.id;
          break;
        }
      }
      return {
        id: row.id,
        giftId: row.giftId,
        renderId,
        kind,
        source: row.source,
        cacheKeyPrefix: row.cacheKey.slice(0, 12),
        ageHours: hours(row.createdAt, now),
        idleHours: hours(row.updatedAt, now),
      };
    });
  }

  journal(targetId?: string, limit = 100) {
    return this.prisma.storyOperatorAction.findMany({
      where: targetId ? { targetId } : {},
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  // ───────────── gifts ─────────────

  async closeGift(actor: string, id: string, input: StoryOperatorInput) {
    return this.act(actor, 'gift', id, 'gift.close-failed', input, async () => {
      const prev = await this.prisma.storyGift.findFirst({
        where: { id, status: 'UNKNOWN' },
        select: this.giftState,
      });
      if (!prev) return null;
      return {
        previous: prev,
        mutate: async (tx: Tx) =>
          (
            await tx.storyGift.updateMany({
              where: { id, status: 'UNKNOWN' },
              data: {
                status: 'FAILED',
                error:
                  'Закрыто оператором: результат озвучки не подтверждён и не восстанавливается. Создайте новую сказку или удалите эту.',
              },
            })
          ).count === 1,
        result: { status: 'FAILED' },
      };
    });
  }

  async reopenGift(
    actor: string,
    id: string,
    input: StoryOperatorInput & { providerChargeConfirmedAbsent?: boolean },
  ) {
    this.requireNoCharge(input.providerChargeConfirmedAbsent);
    return this.act(actor, 'gift', id, 'gift.reopen-draft', input, async () => {
      const prev = await this.prisma.storyGift.findFirst({
        where: { id, status: 'UNKNOWN' },
        select: this.giftState,
      });
      if (!prev) return null;
      return {
        previous: prev,
        mutate: async (tx: Tx) =>
          (
            await tx.storyGift.updateMany({
              where: { id, status: 'UNKNOWN' },
              data: {
                status: 'DRAFT',
                error: null,
                audioQaStatus: 'PENDING',
                audioQa: Prisma.DbNull,
              },
            })
          ).count === 1,
        result: { status: 'DRAFT', providerChargeConfirmedAbsent: true },
      };
    });
  }

  async resetGiftQa(
    actor: string,
    id: string,
    input: StoryOperatorInput & { providerChargeConfirmedAbsent?: boolean },
  ) {
    this.requireNoCharge(input.providerChargeConfirmedAbsent);
    return this.act(actor, 'gift', id, 'gift.qa-reset', input, async () => {
      const where = {
        id,
        status: { in: GIFT_LIVE },
        audioQaStatus: 'UNKNOWN',
      };
      const prev = await this.prisma.storyGift.findFirst({
        where,
        select: this.giftState,
      });
      if (!prev) return null;
      return {
        previous: prev,
        mutate: async (tx: Tx) =>
          (
            await tx.storyGift.updateMany({
              where,
              data: { audioQaStatus: 'PENDING' },
            })
          ).count === 1,
        result: {
          audioQaStatus: 'PENDING',
          providerChargeConfirmedAbsent: true,
        },
      };
    });
  }

  // ───────────── renders ─────────────

  async bindRenderJob(
    actor: string,
    id: string,
    input: StoryOperatorInput & { jobId: string; renderInputUrl?: string },
  ) {
    const jobId = (input.jobId ?? '').trim();
    if (!STORY_JOB_ID.test(jobId))
      throw new BadRequestException('Неверный формат id задания сборщика');
    // A-S3-9: optional fingerprint — any input URL of that job as shown in the
    // provider dashboard; its token must hash to the one kept at UNKNOWN.
    const inputToken = input.renderInputUrl
      ? RENDER_INPUT_TOKEN.exec(input.renderInputUrl)?.[1]
      : undefined;
    if (input.renderInputUrl && !inputToken)
      throw new BadRequestException(
        'Ссылка на вход задания: нужна ссылка вида …/story-render-input/<токен>/<часть>',
      );
    return this.act(actor, 'render', id, 'render.bind-job', input, async () => {
      const r = await this.prisma.storyVideoRender.findFirst({
        where: { id, status: 'UNKNOWN' },
        select: {
          ...this.renderState,
          voiceId: true,
          gift: { select: { status: true, userId: true } },
        },
      });
      if (!r) return null;
      if (r.jobId)
        throw new ConflictException(
          'У сборки уже есть сохранённое задание; его проверяет крон без оплаты',
        );
      if (r.preambleDuration == null || r.durationSeconds == null)
        throw new ConflictException(
          'Сборка не дошла до отправки сборщику — задания у провайдера быть не может. Закройте её как FAILED',
        );
      if (!GIFT_LIVE.includes(r.gift.status))
        throw new ConflictException('Сказка больше не готова или удалена');
      const fingerprint = await this.prisma.storyVideoRender.findFirst({
        where: { id },
        select: { assetTokenHash: true },
      });
      if (
        inputToken &&
        (!fingerprint?.assetTokenHash ||
          storyDigest(inputToken) !== fingerprint.assetTokenHash)
      )
        throw new ConflictException(
          'Входы этого задания выданы другой сборке (или отпечаток отправки не сохранён); ничего не изменено',
        );
      const inputVerified = !!inputToken;
      if (r.userVoiceId) {
        const voice = await this.prisma.userVoice.findFirst({
          where: {
            id: r.userVoiceId,
            userId: r.gift.userId,
            resembleVoiceId: r.voiceId,
            status: 'READY',
          },
          select: { consentAt: true },
        });
        if (!voice?.consentAt)
          throw new ConflictException(
            'Голос рассказчика отозван или не готов: результат с ним не привязывается',
          );
      }
      const taken = await this.prisma.storyVideoRender.findFirst({
        where: { jobId, id: { not: id } },
        select: { id: true },
      });
      if (taken)
        throw new ConflictException(
          'Это задание уже привязано к другой сборке',
        );
      if (!this.ffmpeg.configured())
        throw new ServiceUnavailableException('Сборщик не настроен');
      let job: Awaited<ReturnType<FfmpegApiService['status']>>;
      try {
        job = await this.ffmpeg.status(jobId, 20000);
      } catch {
        throw new ConflictException(
          'Сборщик не подтвердил это задание (неверный id или сбой связи); ничего не изменено',
        );
      }
      const { gift: _gift, voiceId: _voice, ...previous } = r;
      const where = {
        id,
        status: 'UNKNOWN',
        jobId: null,
        gift: { status: { in: GIFT_LIVE } },
      };
      // A-S3-8: "job already bound" is re-checked inside the transaction under
      // a per-job lock (plus the unique index on jobId as a backstop).
      const bind = async (
        tx: Tx,
        data: Prisma.StoryVideoRenderUpdateManyMutationInput,
      ) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-operator:job:${jobId}`}))::text`;
        if (
          await tx.storyVideoRender.findFirst({
            where: { jobId, id: { not: id } },
            select: { id: true },
          })
        )
          throw new ConflictException(
            'Это задание уже привязано к другой сборке',
          );
        return (
          (await tx.storyVideoRender.updateMany({ where, data })).count === 1
        );
      };
      if (job.status === 'failed')
        throw new ConflictException(
          'Задание завершилось ошибкой у сборщика: закройте сборку как FAILED',
        );
      if (job.status === 'pending')
        return {
          previous,
          mutate: (tx: Tx) =>
            bind(tx, {
              jobId,
              error:
                'Задание сборщика привязано оператором; результат будет проверен без новой сборки и оплаты.',
            }),
          result: {
            outcome: 'bound-pending',
            status: 'UNKNOWN',
            inputVerified,
          },
        };
      let out: Awaited<ReturnType<typeof downloadStoryVideo>>;
      try {
        out = await downloadStoryVideo(
          job.outputs?.['story.mp4'],
          r.durationSeconds,
        );
      } catch (e) {
        throw new ConflictException(
          e instanceof Error && e.message === 'Invalid container'
            ? 'Готовое видео не прошло проверку формата, размера или длительности этой сборки; ничего не изменено'
            : 'Не удалось скачать результат задания; ничего не изменено',
        );
      }
      return {
        previous,
        mutate: (tx: Tx) =>
          bind(tx, {
            status: 'READY',
            jobId,
            video: new Uint8Array(out.bytes),
            videoHash: out.videoHash,
            durationSeconds: out.durationSeconds,
            assetTokenHash: null,
            assetExpiresAt: null,
            error: null,
          }),
        result: {
          inputVerified,
          outcome: 'ready',
          status: 'READY',
          videoHash: out.videoHash,
          durationSeconds: out.durationSeconds,
        },
      };
    });
  }

  async closeRender(
    actor: string,
    id: string,
    input: StoryOperatorInput & {
      releaseReserve: boolean;
      providerChargeConfirmedAbsent?: boolean;
    },
  ) {
    if (typeof input.releaseReserve !== 'boolean')
      throw new BadRequestException('Явно укажите, освобождать ли резерв');
    return this.act(
      actor,
      'render',
      id,
      'render.close-failed',
      input,
      async () => {
        const r = await this.prisma.storyVideoRender.findFirst({
          where: { id, status: 'UNKNOWN' },
          select: {
            ...this.renderState,
            configHash: true,
            parentNarrationKey: true,
            mainDuration: true,
          },
        });
        if (!r) return null;
        const stage = storyRenderStage(r);
        // Before the base check nothing paid ran; otherwise the operator must confirm.
        if (
          input.releaseReserve &&
          stage !== 'base' &&
          input.providerChargeConfirmedAbsent !== true
        )
          throw new BadRequestException(
            'Резерв освобождается только при подтверждении, что провайдеры не списали средства',
          );
        const { configHash, parentNarrationKey, mainDuration, ...previous } = r;
        // A-S2-1: the main-narration key is released only when nothing paid
        // could have run (base) or the operator confirmed no provider charge.
        // Otherwise it stays: every new parent render with the same narration
        // is refused (409) instead of buying the main speech a second time.
        const unsavedNarration = !!parentNarrationKey && mainDuration == null;
        const releaseNarration =
          unsavedNarration &&
          (stage === 'base' || input.providerChargeConfirmedAbsent === true);
        return {
          previous: { ...previous, stage },
          mutate: async (tx: Tx) =>
            (
              await tx.storyVideoRender.updateMany({
                where: { id, status: 'UNKNOWN', configHash },
                data: {
                  status: 'FAILED',
                  assetTokenHash: null,
                  assetExpiresAt: null,
                  // Frees the (gift, config) slot so the owner may start a new attempt explicitly.
                  configHash: `${configHash}:closed:${input.requestId}`,
                  ...(input.releaseReserve ? { reservedMicroUsd: 0 } : {}),
                  ...(releaseNarration ? { parentNarrationKey: null } : {}),
                  error: `Закрыто оператором: сборка не подтверждена. Новую сборку можно запустить вручную.${input.releaseReserve ? '' : ' Резерв бюджета этой попытки сохранён.'}${unsavedNarration && !releaseNarration ? ' Основная речь этим голосом не подтверждена и повторно не покупается.' : ''}`,
                },
              })
            ).count === 1,
          result: {
            status: 'FAILED',
            stage,
            releasedUsd: input.releaseReserve ? usd(r.reservedMicroUsd) : 0,
            narrationKey: !unsavedNarration
              ? 'none'
              : releaseNarration
                ? 'released'
                : 'blocked',
            providerChargeConfirmedAbsent:
              input.providerChargeConfirmedAbsent === true,
          },
        };
      },
    );
  }

  async resetRenderQa(
    actor: string,
    id: string,
    input: StoryOperatorInput & { providerChargeConfirmedAbsent?: boolean },
  ) {
    this.requireNoCharge(input.providerChargeConfirmedAbsent);
    return this.act(actor, 'render', id, 'render.qa-reset', input, async () => {
      const where = { id, status: 'READY', qaStatus: 'UNKNOWN' };
      const prev = await this.prisma.storyVideoRender.findFirst({
        where,
        select: this.renderState,
      });
      if (!prev) return null;
      return {
        previous: prev,
        mutate: async (tx: Tx) =>
          (
            await tx.storyVideoRender.updateMany({
              where,
              data: { qaStatus: 'PENDING' },
            })
          ).count === 1,
        result: { qaStatus: 'PENDING', providerChargeConfirmedAbsent: true },
      };
    });
  }

  // ───────────── video speech segments (WP4 cache) ─────────────

  /**
   * UNKNOWN → DELETED: frees the cache key so the owner's next render may
   * synthesize it again (one new paid attempt, explicitly started by the
   * owner). Only after the operator confirmed no provider charge.
   */
  async closeSegment(
    actor: string,
    id: string,
    input: StoryOperatorInput & { providerChargeConfirmedAbsent?: boolean },
  ) {
    this.requireNoCharge(input.providerChargeConfirmedAbsent);
    return this.act(
      actor,
      'segment',
      id,
      'segment.close-deleted',
      input,
      async () => {
        const where = { id, status: 'UNKNOWN' };
        const row = await this.prisma.storyVideoSegment.findFirst({
          where,
          select: {
            giftId: true,
            status: true,
            source: true,
            cacheKey: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        if (!row) return null;
        const { cacheKey, ...rest } = row;
        return {
          previous: { ...rest, cacheKeyPrefix: cacheKey.slice(0, 12) },
          mutate: async (tx: Tx) =>
            (
              await tx.storyVideoSegment.updateMany({
                where: { ...where, cacheKey },
                data: {
                  status: 'DELETED',
                  text: '',
                  audio: null,
                  audioHash: null,
                  durationSeconds: null,
                },
              })
            ).count === 1,
          result: {
            status: 'DELETED',
            cacheReleased: true,
            providerChargeConfirmedAbsent: true,
          },
        };
      },
    );
  }

  // ───────────── references (PlatformSetting `story-ref:v1:*`) ─────────────

  closeReference(actor: string, ref: string, input: StoryOperatorInput) {
    return this.referenceAction(
      actor,
      ref,
      input,
      'reference.close-unavailable',
    );
  }
  deleteReference(actor: string, ref: string, input: StoryOperatorInput) {
    return this.referenceAction(actor, ref, input, 'reference.delete');
  }
  private async referenceAction(
    actor: string,
    ref: string,
    input: StoryOperatorInput,
    action: 'reference.close-unavailable' | 'reference.delete',
  ) {
    const m = REF_ID.exec(ref);
    if (!m) throw new BadRequestException('Неверный идентификатор референса');
    const key = `${STORY_REF_PREFIX}${m[1]}:${m[2]}`;
    return this.act(actor, 'reference', ref, action, input, async () => {
      const row = await this.prisma.platformSetting.findUnique({
        where: { key },
      });
      if (!row) return null;
      let rec: RefRecord;
      try {
        rec = JSON.parse(row.value) as RefRecord;
      } catch {
        return null;
      }
      const state = refState(rec);
      if (!state) return null;
      const previous = {
        state,
        videoId: rec.id,
        hasPendingAssessment: !!rec.pendingAssessment,
        startedAt: rec.startedAt,
        completedAt: rec.completedAt ?? null,
      };
      if (action === 'reference.delete')
        return {
          previous,
          mutate: async (tx: Tx) =>
            (
              await tx.platformSetting.deleteMany({
                where: { key, value: row.value },
              })
            ).count === 1,
          result: { deleted: true },
        };
      const { pendingAssessment: _p, ...rest } = rec;
      const closed = {
        ...rest,
        status: 'unavailable',
        completedAt: new Date().toISOString(),
        error:
          'Закрыто оператором: разбор не подтверждён. Повторный разбор — только по явному запросу владельца, с новой суточной квотой.',
      };
      return {
        previous,
        mutate: async (tx: Tx) =>
          (
            await tx.platformSetting.updateMany({
              where: { key, value: row.value },
              data: { value: JSON.stringify(closed), updatedBy: actor },
            })
          ).count === 1,
        result: { status: 'unavailable' },
      };
    });
  }

  // ───────────── shared ─────────────

  private readonly giftState = {
    status: true,
    audioQaStatus: true,
    reservedMicroUsd: true,
    budgetCents: true,
    error: true,
    updatedAt: true,
  } as const;
  private readonly renderState = {
    status: true,
    qaStatus: true,
    jobId: true,
    preambleDuration: true,
    durationSeconds: true,
    reservedMicroUsd: true,
    userVoiceId: true,
    error: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  private requireNoCharge(flag: boolean | undefined) {
    if (flag !== true)
      throw new BadRequestException(
        'Повтор разрешён только при подтверждении, что провайдер не списал средства (providerChargeConfirmedAbsent: true)',
      );
  }

  private async replay(
    requestId: string,
    targetType: Target,
    targetId: string,
    action: StoryOperatorAction,
  ) {
    const prev = await this.prisma.storyOperatorAction.findUnique({
      where: { requestId },
    });
    if (!prev) return null;
    if (
      prev.targetType !== targetType ||
      prev.targetId !== targetId ||
      prev.action !== action
    )
      throw new ConflictException(
        'Этот requestId уже использован для другого действия',
      );
    return this.view(prev, true);
  }

  private view(
    entry: {
      id: string;
      action: string;
      targetType: string;
      targetId: string;
      result: Prisma.JsonValue;
      createdAt: Date;
    },
    replayed: boolean,
  ) {
    return {
      journalId: entry.id,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      result: entry.result,
      createdAt: entry.createdAt,
      replayed,
    };
  }

  /**
   * Idempotent, race-safe operator action: repeated `requestId` returns the
   * first result; the state change is a conditional `updateMany` under a
   * per-target advisory lock, journaled in the same transaction.
   */
  private async act(
    actor: string,
    targetType: Target,
    targetId: string,
    action: StoryOperatorAction,
    input: StoryOperatorInput,
    plan: () => Promise<{
      previous: object;
      mutate: (tx: Tx) => Promise<boolean>;
      result: object;
    } | null>,
  ) {
    const reason = (input.reason ?? '').trim();
    if (reason.length < 3 || reason.length > 500)
      throw new BadRequestException('Укажите причину: от 3 до 500 символов');
    const requestId = (input.requestId ?? '').toLowerCase();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        requestId,
      )
    )
      throw new BadRequestException('requestId должен быть UUID');
    const early = await this.replay(requestId, targetType, targetId, action);
    if (early) return early;
    const step = await plan();
    if (!step)
      throw new ConflictException(
        'Запись не найдена или уже не требует этого действия; обновите список',
      );
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-operator:${targetType}:${targetId}`}))::text`;
        const again = await tx.storyOperatorAction.findUnique({
          where: { requestId },
        });
        if (again) return this.view(again, true);
        if (!(await step.mutate(tx)))
          throw new ConflictException(
            'Состояние уже изменилось (другой оператор или крон); ничего не изменено',
          );
        const entry = await tx.storyOperatorAction.create({
          data: {
            requestId,
            actorKind: 'admin',
            actorUserId: actor,
            targetType,
            targetId,
            action,
            reason,
            previousState: JSON.parse(
              JSON.stringify(step.previous),
            ) as Prisma.InputJsonValue,
            result: step.result as Prisma.InputJsonValue,
          },
        });
        return this.view(entry, false);
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        const done = await this.replay(requestId, targetType, targetId, action);
        if (done) return done;
        // Another unique key (e.g. the job id bound concurrently elsewhere).
        throw new ConflictException(
          'Состояние уже изменилось (уникальное значение занято другой записью); ничего не изменено',
        );
      }
      throw e;
    }
  }
}
