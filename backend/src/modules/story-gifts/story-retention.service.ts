import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StoryGiftsService, storyRenderWipe } from './story-gifts.service';
import { STORY_REF_PREFIX } from './story-operator.service';

/**
 * WP1 (ST-P0, TODO 77/9952): Story-Tales retention.
 *
 * Class A (unfinished, 30 days): DRAFT/FAILED/UNKNOWN gifts without changes,
 * FAILED/UNKNOWN renders of a live gift (by creation: the cron poll rotates
 * `updatedAt`), renders whose parent voice was deleted (consent withdrawn, any
 * age) and cached speech segments synthesized by a deleted voice (any age),
 * unknown/unavailable/stuck references and stale reference quota keys.
 * A purged render frees its configuration slot (`<hash>:purged:<id>`) and
 * keeps `parentNarrationKey` while the parent main narration was never saved
 * (an unconfirmed main synthesis is never re-bought without an operator).
 * Class B (finished, 180 days without changes of the gift and its renders):
 * READY/APPROVED gifts and complete/partial references — report only unless
 * explicitly enabled.
 *
 * Default is dry-run: nothing is deleted until
 * `STORY_RETENTION_PURGE_ENABLED=true`; class B additionally needs
 * `STORY_RETENTION_READY_PURGE_ENABLED=true`. Gift deletion is exactly the
 * owner's `remove()`; render deletion uses the same wipe.
 */
export const STORY_RETENTION_STALE_DAYS = 30;
export const STORY_RETENTION_READY_DAYS = 180;
export const STORY_RETENTION_QUOTA_DAYS = 3;
const BATCH = 50;
const DEADLINE_MS = 120_000;
const DAY = 86_400_000;
const QUOTA_PREFIX = 'story-ref-quota:';

const enabled = (value: string | undefined) =>
  ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
/** Literal reads so `scripts/check-docs.mjs` sees both variables. */
export function storyRetentionFlags() {
  const purge = enabled(process.env.STORY_RETENTION_PURGE_ENABLED);
  return {
    purge,
    ready: purge && enabled(process.env.STORY_RETENTION_READY_PURGE_ENABLED),
  };
}

export interface StoryRetentionResult {
  dryRun: boolean;
  readyPurgeEnabled: boolean;
  staleGifts: number;
  staleRenders: number;
  revokedVoiceRenders: number;
  /** Cached speech segments synthesized by a deleted voice (F1, A-S2-3). */
  revokedVoiceSegments: number;
  staleReferences: number;
  quotaKeys: number;
  readyGifts: number;
  readyReferences: number;
  purged: number;
  raced: number;
  errors: number;
  candidates?: {
    gifts: string[];
    renders: string[];
    segments: string[];
    references: string[];
    readyGifts: string[];
    readyReferences: string[];
  };
}

@Injectable()
export class StoryRetentionService {
  private readonly logger = new Logger(StoryRetentionService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly gifts: StoryGiftsService,
  ) {}

  async run(
    opts: { dryRun?: boolean; withCandidates?: boolean } = {},
  ): Promise<StoryRetentionResult> {
    const started = Date.now();
    const { purge: purgeEnabled, ready: readyPurgeEnabled } =
      storyRetentionFlags();
    const dryRun = opts.dryRun === true || !purgeEnabled;
    const stale = new Date(started - STORY_RETENTION_STALE_DAYS * DAY);
    const ready = new Date(started - STORY_RETENTION_READY_DAYS * DAY);
    const quota = new Date(started - STORY_RETENTION_QUOTA_DAYS * DAY);

    const staleGifts = await this.prisma.storyGift.findMany({
      where: {
        status: { in: ['DRAFT', 'FAILED', 'UNKNOWN'] },
        updatedAt: { lt: stale },
      },
      select: { id: true, userId: true, status: true, updatedAt: true },
      orderBy: { updatedAt: 'asc' },
      take: BATCH,
    });
    const readyGifts = await this.prisma.storyGift.findMany({
      where: {
        status: { in: ['READY', 'APPROVED'] },
        updatedAt: { lt: ready },
        videoRenders: { none: { updatedAt: { gte: ready } } },
      },
      select: { id: true, userId: true, status: true, updatedAt: true },
      orderBy: { updatedAt: 'asc' },
      take: BATCH,
    });
    const staleRenders = await this.prisma.storyVideoRender.findMany({
      where: {
        status: { in: ['FAILED', 'UNKNOWN'] },
        createdAt: { lt: stale },
        gift: { status: { in: ['READY', 'APPROVED'] } },
      },
      select: { id: true, giftId: true, status: true },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });
    // Deleted narrator voices (UserVoice row gone): filtered in the query by
    // the distinct voice ids still referenced, never "the first N renders".
    const dead = await this.deadVoiceIds();
    const staleIds = new Set(staleRenders.map((r) => r.id));
    const revoked = dead.length
      ? (
          await this.prisma.storyVideoRender.findMany({
            where: {
              status: { not: 'DELETED' },
              userVoiceId: { in: dead },
              id: { notIn: [...staleIds] },
            },
            select: { id: true, giftId: true, status: true },
            orderBy: { createdAt: 'asc' },
            take: BATCH,
          })
        ).filter((r) => !staleIds.has(r.id))
      : [];
    // A-S2-3: cached speech synthesized by a deleted clone — erased at once,
    // like the renders (the cache key embeds the voice: it can never be reused).
    const revokedSegments = dead.length
      ? await this.prisma.storyVideoSegment.findMany({
          where: { status: { not: 'DELETED' }, userVoiceId: { in: dead } },
          select: { id: true, giftId: true, status: true, cacheKey: true },
          orderBy: { createdAt: 'asc' },
          take: BATCH,
        })
      : [];

    const refRows = await this.prisma.platformSetting.findMany({
      where: {
        key: { startsWith: STORY_REF_PREFIX },
        updatedAt: { lt: stale },
      },
      select: { key: true, value: true, updatedAt: true },
      orderBy: { updatedAt: 'asc' },
      take: 200,
    });
    const staleRefs: { key: string; value: string }[] = [];
    const oldReadyRefs: { key: string; value: string }[] = [];
    for (const row of refRows) {
      let status = '';
      try {
        status = String((JSON.parse(row.value) as { status?: string }).status);
      } catch {
        status = 'unknown';
      }
      if (['unknown', 'unavailable', 'running'].includes(status))
        staleRefs.push(row);
      else if (row.updatedAt < ready) oldReadyRefs.push(row);
    }
    const quotaRows = await this.prisma.platformSetting.findMany({
      where: { key: { startsWith: QUOTA_PREFIX }, updatedAt: { lt: quota } },
      select: { key: true },
      take: 500,
    });

    const refId = (key: string) =>
      key.slice(STORY_REF_PREFIX.length).replace(':', '');
    const result: StoryRetentionResult = {
      dryRun,
      readyPurgeEnabled,
      staleGifts: staleGifts.length,
      staleRenders: staleRenders.length,
      revokedVoiceRenders: revoked.length,
      revokedVoiceSegments: revokedSegments.length,
      staleReferences: staleRefs.length,
      quotaKeys: quotaRows.length,
      readyGifts: readyGifts.length,
      readyReferences: oldReadyRefs.length,
      purged: 0,
      raced: 0,
      errors: 0,
    };
    if (opts.withCandidates)
      result.candidates = {
        gifts: staleGifts.map((g) => g.id),
        renders: [...staleRenders, ...revoked].map((r) => r.id),
        segments: revokedSegments.map((r) => r.id),
        references: staleRefs.map((r) => refId(r.key)),
        readyGifts: readyGifts.map((g) => g.id),
        readyReferences: oldReadyRefs.map((r) => refId(r.key)),
      };
    if (dryRun) return result;

    const late = () => Date.now() - started > DEADLINE_MS;
    const journal = (
      targetType: 'gift' | 'render' | 'reference' | 'segment',
      targetId: string,
      previousState: object,
      reason: string,
      db: Pick<Prisma.TransactionClient, 'storyOperatorAction'> = this.prisma,
    ) =>
      db.storyOperatorAction.create({
        data: {
          actorKind: 'cron',
          targetType,
          targetId,
          action: 'retention.purge',
          reason,
          previousState: JSON.parse(JSON.stringify(previousState)),
          result: { purged: true },
        },
      });
    const purgeGift = async (
      g: (typeof staleGifts)[number],
      cls: 'stale' | 'ready',
    ) => {
      // Re-check right before the owner's own deletion: any activity resets the term.
      const still = await this.prisma.storyGift.findFirst({
        where: { id: g.id, status: g.status, updatedAt: g.updatedAt },
        select: { id: true },
      });
      if (!still) return void result.raced++;
      // Conditional on the same state, under the gift lock, journal in the same
      // transaction (A-S3-5): an owner change in between is a skip, not a purge.
      const done = await this.gifts.remove(g.userId, g.id, {
        expect: { status: g.status, updatedAt: g.updatedAt },
        journal: (tx) =>
          journal(
            'gift',
            g.id,
            { status: g.status, updatedAt: g.updatedAt, class: cls },
            cls === 'stale'
              ? `Срок хранения: незавершённая сказка без изменений ${STORY_RETENTION_STALE_DAYS} дней`
              : `Срок хранения: готовая сказка без изменений ${STORY_RETENTION_READY_DAYS} дней`,
            tx,
          ),
      });
      if (!done.deleted) return void result.raced++;
      result.purged++;
    };
    const purgeRender = async (
      r: { id: string; giftId: string; status: string },
      reason: string,
    ) => {
      // Same locks as video create (gift) and the operator (render): a bind-job
      // or a close in flight finishes first; the update is conditional (A-S3-5).
      const done = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-video:${r.giftId}`}))::text`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-operator:render:${r.id}`}))::text`;
        const row = await tx.storyVideoRender.findFirst({
          where: { id: r.id, status: r.status },
          select: {
            configHash: true,
            jobId: true,
            parentNarrationKey: true,
            mainDuration: true,
          },
        });
        if (!row) return false;
        const wiped = await tx.storyVideoRender.updateMany({
          where: {
            id: r.id,
            status: r.status,
            configHash: row.configHash,
            jobId: row.jobId,
          },
          data: storyRenderWipe({
            // A-S2-2: the same configuration may be ordered again.
            release: { id: r.id, configHash: row.configHash },
            // A-S2-1: an unsaved parent narration stays blocked (never re-bought).
            keepNarrationKey:
              !!row.parentNarrationKey && row.mainDuration == null,
          }),
        });
        if (!wiped.count) return false;
        await journal(
          'render',
          r.id,
          {
            status: r.status,
            hasJobId: !!row.jobId,
            narrationBlocked:
              !!row.parentNarrationKey && row.mainDuration == null,
          },
          reason,
          tx,
        );
        return true;
      });
      if (!done) return void result.raced++;
      result.purged++;
    };
    const purgeSegment = async (s: (typeof revokedSegments)[number]) => {
      const done = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-video:${s.giftId}`}))::text`;
        const wiped = await tx.storyVideoSegment.updateMany({
          where: { id: s.id, status: s.status, cacheKey: s.cacheKey },
          data: {
            status: 'DELETED',
            audio: null,
            audioHash: null,
            durationSeconds: null,
            text: '',
          },
        });
        if (!wiped.count) return false;
        await journal(
          'segment',
          s.id,
          { status: s.status, cacheKeyPrefix: s.cacheKey.slice(0, 12) },
          'Голос рассказчика удалён (согласие отозвано): речь, синтезированная им, удаляется',
          tx,
        );
        return true;
      });
      if (!done) return void result.raced++;
      result.purged++;
    };
    const purgeRef = async (
      row: { key: string; value: string },
      cls: 'stale' | 'ready',
    ) => {
      const done = await this.prisma.platformSetting.deleteMany({
        where: { key: row.key, value: row.value },
      });
      if (!done.count) return void result.raced++;
      let status = 'unknown';
      try {
        status = String((JSON.parse(row.value) as { status?: string }).status);
      } catch {
        /* malformed record is still purged */
      }
      await journal(
        'reference',
        refId(row.key),
        { status, class: cls },
        cls === 'stale'
          ? `Срок хранения: неподтверждённый разбор референса старше ${STORY_RETENTION_STALE_DAYS} дней`
          : `Срок хранения: разбор референса без изменений ${STORY_RETENTION_READY_DAYS} дней`,
      );
      result.purged++;
    };
    const steps: (() => Promise<void>)[] = [
      ...staleGifts.map((g) => () => purgeGift(g, 'stale')),
      ...staleRenders.map(
        (r) => () =>
          purgeRender(
            r,
            `Срок хранения: неподтверждённая или неудачная сборка старше ${STORY_RETENTION_STALE_DAYS} дней`,
          ),
      ),
      ...revoked.map(
        (r) => () =>
          purgeRender(
            r,
            'Голос рассказчика удалён (согласие отозвано): сборка с ним удаляется',
          ),
      ),
      ...revokedSegments.map((s) => () => purgeSegment(s)),
      ...staleRefs.map((r) => () => purgeRef(r, 'stale')),
      ...(readyPurgeEnabled
        ? [
            ...readyGifts.map((g) => () => purgeGift(g, 'ready')),
            ...oldReadyRefs.map((r) => () => purgeRef(r, 'ready')),
          ]
        : []),
    ];
    for (const step of steps) {
      if (late()) break;
      try {
        await step();
      } catch (e) {
        result.errors++;
        this.logger.warn(
          `Story retention item failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (quotaRows.length && !late()) {
      try {
        const q = await this.prisma.platformSetting.deleteMany({
          where: {
            key: { in: quotaRows.map((r) => r.key) },
            updatedAt: { lt: quota },
          },
        });
        result.purged += q.count;
      } catch {
        result.errors++;
      }
    }
    return result;
  }

  /** Voice ids referenced by renders/segments whose UserVoice row is gone. */
  private async deadVoiceIds(): Promise<string[]> {
    const referenced = new Set<string>();
    for (const r of await this.prisma.storyVideoRender.findMany({
      where: { status: { not: 'DELETED' }, userVoiceId: { not: null } },
      distinct: ['userVoiceId'],
      select: { userVoiceId: true },
    }))
      if (r.userVoiceId) referenced.add(r.userVoiceId);
    for (const s of await this.prisma.storyVideoSegment.findMany({
      where: { status: { not: 'DELETED' }, userVoiceId: { not: null } },
      distinct: ['userVoiceId'],
      select: { userVoiceId: true },
    }))
      if (s.userVoiceId) referenced.add(s.userVoiceId);
    if (!referenced.size) return [];
    const alive = new Set(
      (
        await this.prisma.userVoice.findMany({
          where: { id: { in: [...referenced] } },
          select: { id: true },
        })
      ).map((v) => v.id),
    );
    return [...referenced].filter((id) => !alive.has(id));
  }
}
