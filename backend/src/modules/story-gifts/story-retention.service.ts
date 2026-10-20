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
 * unknown/unavailable/stuck references and stale reference quota keys, and
 * (ST2-S-03) the exact text of speech segments left UNKNOWN/PENDING (an
 * unconfirmed TTS attempt) together with the purge of their render, or after
 * 30 days without changes: text '' and a journal record; the row stays UNKNOWN so the cache key remains blocked (a maybe
 * billed synthesis is never re-bought without an operator).
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
import {
  STORY_JOURNAL_DAYS,
  STORY_PILOT_SCENARIO_DAYS,
  STORY_RETENTION_QUOTA_DAYS,
  STORY_RETENTION_READY_DAYS,
  STORY_RETENTION_STALE_DAYS,
  STORY_VOICE_SAMPLE_DAYS,
} from './story-retention-view';
import { BlobService } from '../storage/blob.service';
import { pathnameFromBlobUrl } from '../../common/blob-paths';
// ST3: the cabinet shows the same terms (story-retention-view.ts).
export {
  STORY_JOURNAL_DAYS,
  STORY_PILOT_SCENARIO_DAYS,
  STORY_VOICE_SAMPLE_DAYS,
  STORY_RETENTION_QUOTA_DAYS,
  STORY_RETENTION_READY_DAYS,
  STORY_RETENTION_STALE_DAYS,
};
const BATCH = 50;
const DEADLINE_MS = 120_000;
const DAY = 86_400_000;
const QUOTA_PREFIX = 'story-ref-quota:';

/** Cache keys of synthesized segments in a render manifest (WP4 v1). */
function storyManifestSynthKeys(raw: unknown): string[] {
  const m = raw as { version?: number; segments?: unknown } | null;
  if (!m || m.version !== 1 || !Array.isArray(m.segments)) return [];
  return [
    ...new Set(
      (m.segments as Array<{ source?: string; cacheKey?: unknown }>)
        .filter((x) => x.source === 'synth' && typeof x.cacheKey === 'string')
        .map((x) => x.cacheKey as string),
    ),
  ];
}
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
  /** ST2-S-03: UNKNOWN/PENDING segments whose text is erased (30 days). */
  staleSegments: number;
  staleReferences: number;
  quotaKeys: number;
  readyGifts: number;
  readyReferences: number;
  /** ST3 (ТЗ §11.4): source recordings of READY voice clones older than 7 days. */
  voiceSamples: number;
  /** ST3: scenario texts of pilot applications decided over 90 days ago. */
  pilotScenarios: number;
  /** ST3-S-10: pending applications older than 90 days → expired. */
  pilotExpired: number;
  /** ST3: journal entries older than one year (deleted, not journaled). */
  journalEntries: number;
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
    voiceSamples: string[];
    pilotScenarios: string[];
    pilotExpired: string[];
  };
}

@Injectable()
export class StoryRetentionService {
  private readonly logger = new Logger(StoryRetentionService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly gifts: StoryGiftsService,
    private readonly blob: BlobService,
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

    const staleGiftRows = await this.prisma.storyGift.findMany({
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
    const staleRenderRows = await this.prisma.storyVideoRender.findMany({
      where: {
        status: { in: ['FAILED', 'UNKNOWN'] },
        createdAt: { lt: stale },
        gift: { status: { in: ['READY', 'APPROVED'] } },
      },
      select: { id: true, giftId: true, status: true },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });
    // ST3-S-02: an UNKNOWN step with RESERVED credits is never purged before
    // its charge is closed (operator decision or the 14-day auto-refund).
    const held = await this.reservedUnknown(
      staleGiftRows.filter((g) => g.status === 'UNKNOWN').map((g) => g.id),
      staleRenderRows.filter((r) => r.status === 'UNKNOWN').map((r) => r.id),
    );
    const staleGifts = staleGiftRows.filter((g) => !held.gifts.has(g.id));
    const staleRenders = staleRenderRows.filter((r) => !held.renders.has(r.id));
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

    // ST2-S-03: an unconfirmed attempt keeps the exact text (a child's name,
    // the address) only as long as class A allows. `updatedAt`: a reused
    // DELETED row keeps its old `createdAt`; nothing touches UNKNOWN later.
    const revokedSegmentIds = new Set(revokedSegments.map((r) => r.id));
    const staleSegments = (
      await this.prisma.storyVideoSegment.findMany({
        where: {
          status: { in: ['UNKNOWN', 'PENDING'] },
          source: 'synth',
          text: { not: '' },
          updatedAt: { lt: stale },
        },
        select: {
          id: true,
          giftId: true,
          status: true,
          cacheKey: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
        take: BATCH,
      })
    ).filter((r) => !revokedSegmentIds.has(r.id));

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

    // ST3 (ТЗ §11.4, правила 9.6): the consented source recording is needed
    // only to clone. It lives 7 days after the last change of the voice —
    // after a READY clone, and also of an unfinished or failed cloning (the
    // explicit retry after HTTP 400 is possible within those 7 days; then it
    // needs a new recording). Persona voices keep their own flow.
    const voiceSamples = await this.prisma.userVoice.findMany({
      where: {
        personaId: null,
        // ST3-S-05: only users who accepted the Story rules (9.6); the rest
        // of the product keeps its own terms.
        user: { storyTermsAcceptances: { some: {} } },
        sampleUrl: { not: '' },
        updatedAt: { lt: new Date(started - STORY_VOICE_SAMPLE_DAYS * DAY) },
      },
      select: { id: true, status: true, sampleUrl: true, updatedAt: true },
      orderBy: { updatedAt: 'asc' },
      take: BATCH,
    });
    const pilotScenarios = await this.prisma.storyPilotApplication.findMany({
      where: {
        status: { in: ['approved', 'rejected'] },
        scenario: { not: null },
        decidedAt: {
          lt: new Date(started - STORY_PILOT_SCENARIO_DAYS * DAY),
        },
      },
      select: { id: true, status: true },
      orderBy: { decidedAt: 'asc' },
      take: BATCH,
    });
    // ST3-S-10: pending applications older than 90 days expire, text erased.
    const pilotExpired = await this.prisma.storyPilotApplication.findMany({
      where: {
        status: 'pending',
        createdAt: {
          lt: new Date(started - STORY_PILOT_SCENARIO_DAYS * DAY),
        },
      },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });
    const journalCutoff = new Date(started - STORY_JOURNAL_DAYS * DAY);
    const journalEntries = await this.prisma.storyOperatorAction.count({
      where: { createdAt: { lt: journalCutoff } },
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
      staleSegments: staleSegments.length,
      staleReferences: staleRefs.length,
      quotaKeys: quotaRows.length,
      readyGifts: readyGifts.length,
      readyReferences: oldReadyRefs.length,
      voiceSamples: voiceSamples.length,
      pilotScenarios: pilotScenarios.length,
      pilotExpired: pilotExpired.length,
      journalEntries,
      purged: 0,
      raced: 0,
      errors: 0,
    };
    if (opts.withCandidates)
      result.candidates = {
        gifts: staleGifts.map((g) => g.id),
        renders: [...staleRenders, ...revoked].map((r) => r.id),
        segments: [...revokedSegments, ...staleSegments].map((r) => r.id),
        references: staleRefs.map((r) => refId(r.key)),
        readyGifts: readyGifts.map((g) => g.id),
        readyReferences: oldReadyRefs.map((r) => refId(r.key)),
        voiceSamples: voiceSamples.map((v) => v.id),
        pilotScenarios: pilotScenarios.map((a) => a.id),
        pilotExpired: pilotExpired.map((a) => a.id),
      };
    if (dryRun) return result;

    const late = () => Date.now() - started > DEADLINE_MS;
    const journal = (
      targetType:
        | 'gift'
        | 'render'
        | 'reference'
        | 'segment'
        | 'voice-sample'
        | 'pilot-application',
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
            segments: true,
          },
        });
        if (!row) return false;
        // ST2-S-03: synth segments this render left UNKNOWN (exact text of an
        // unconfirmed attempt) lose their text together with the render.
        const keys = storyManifestSynthKeys(row.segments);
        const unknown = keys.length
          ? await tx.storyVideoSegment.findMany({
              where: {
                giftId: r.giftId,
                cacheKey: { in: keys },
                source: 'synth',
                status: 'UNKNOWN',
                text: { not: '' },
              },
              select: { id: true, cacheKey: true },
            })
          : [];
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
        for (const seg of unknown) {
          const erased = await tx.storyVideoSegment.updateMany({
            where: { id: seg.id, status: 'UNKNOWN', cacheKey: seg.cacheKey },
            data: {
              audio: null,
              audioHash: null,
              durationSeconds: null,
              text: '',
            },
          });
          if (!erased.count) continue;
          await journal(
            'segment',
            seg.id,
            {
              status: 'UNKNOWN',
              class: 'with-render',
              renderId: r.id,
              keyBlocked: true,
            },
            'Срок хранения: текст неподтверждённой озвучки удаляется вместе с её сборкой; ключ остаётся заблокирован до решения оператора',
            tx,
          );
        }
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
          { status: s.status },
          'Голос рассказчика удалён (согласие отозвано): речь, синтезированная им, удаляется',
          tx,
        );
        return true;
      });
      if (!done) return void result.raced++;
      result.purged++;
    };
    const purgeStaleSegment = async (s: (typeof staleSegments)[number]) => {
      const done = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-video:${s.giftId}`}))::text`;
        // Conditional on the state seen: a claim/save in between is a skip.
        const wiped = await tx.storyVideoSegment.updateMany({
          where: {
            id: s.id,
            status: s.status,
            cacheKey: s.cacheKey,
            updatedAt: s.updatedAt,
          },
          data: {
            status: 'UNKNOWN',
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
          {
            status: s.status,
            class: 'stale',
            keyBlocked: true,
          },
          `Срок хранения: текст неподтверждённой озвучки сегмента старше ${STORY_RETENTION_STALE_DAYS} дней удаляется; ключ остаётся заблокирован до решения оператора`,
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
    const purgeVoiceSample = async (v: (typeof voiceSamples)[number]) => {
      const pathname = pathnameFromBlobUrl(v.sampleUrl, 'users/');
      // Not our Blob (no `users/` path): only the reference is dropped.
      if (pathname && !(await this.blob.deleteBlob(pathname))) {
        result.errors++;
        return;
      }
      const done = await this.prisma.$transaction(async (tx) => {
        const cleared = await tx.userVoice.updateMany({
          where: {
            id: v.id,
            status: v.status,
            sampleUrl: v.sampleUrl,
            updatedAt: v.updatedAt,
          },
          data: { sampleUrl: '' },
        });
        if (!cleared.count) return false;
        await journal(
          'voice-sample',
          v.id,
          { status: v.status, hadBlob: !!pathname },
          v.status === 'READY'
            ? `Срок хранения: исходная запись голоса удаляется через ${STORY_VOICE_SAMPLE_DAYS} дней после готового клона`
            : `Срок хранения: запись незавершённого или неудачного клонирования удаляется через ${STORY_VOICE_SAMPLE_DAYS} дней после последнего изменения`,
          tx,
        );
        return true;
      });
      if (!done) return void result.raced++;
      result.purged++;
    };
    const purgeScenario = async (a: (typeof pilotScenarios)[number]) => {
      const done = await this.prisma.$transaction(async (tx) => {
        const erased = await tx.storyPilotApplication.updateMany({
          where: { id: a.id, status: a.status, scenario: { not: null } },
          data: { scenario: null },
        });
        if (!erased.count) return false;
        await journal(
          'pilot-application',
          a.id,
          { status: a.status },
          `Срок хранения: текст заявки в пилот удаляется через ${STORY_PILOT_SCENARIO_DAYS} дней после решения`,
          tx,
        );
        return true;
      });
      if (!done) return void result.raced++;
      result.purged++;
    };
    const expireApplication = async (a: (typeof pilotExpired)[number]) => {
      const done = await this.prisma.$transaction(async (tx) => {
        const expired = await tx.storyPilotApplication.updateMany({
          where: { id: a.id, status: 'pending', createdAt: a.createdAt },
          data: { status: 'expired', decidedAt: new Date(), scenario: null },
        });
        if (!expired.count) return false;
        await journal(
          'pilot-application',
          a.id,
          { status: 'pending' },
          `Срок хранения: заявка в пилот без решения ${STORY_PILOT_SCENARIO_DAYS} дней — закрыта, текст удалён`,
          tx,
        );
        return true;
      });
      if (!done) return void result.raced++;
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
      ...staleSegments.map((s) => () => purgeStaleSegment(s)),
      ...staleRefs.map((r) => () => purgeRef(r, 'stale')),
      ...voiceSamples.map((v) => () => purgeVoiceSample(v)),
      ...pilotScenarios.map((a) => () => purgeScenario(a)),
      ...pilotExpired.map((a) => () => expireApplication(a)),
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
    // The journal itself lives at most a year (append-only: DELETE only).
    if (journalEntries && !late()) {
      try {
        const old = await this.prisma.storyOperatorAction.deleteMany({
          where: { createdAt: { lt: journalCutoff } },
        });
        result.purged += old.count;
      } catch {
        result.errors++;
      }
    }
    return result;
  }

  /** UNKNOWN gifts/renders whose credits are still RESERVED. */
  private async reservedUnknown(giftIds: string[], renderIds: string[]) {
    const rows =
      giftIds.length || renderIds.length
        ? await this.prisma.storyCreditCharge.findMany({
            where: {
              status: 'RESERVED',
              OR: [
                { kind: 'audio', giftId: { in: giftIds } },
                { kind: 'video', renderId: { in: renderIds } },
              ],
            },
            select: { kind: true, giftId: true, renderId: true },
          })
        : [];
    return {
      gifts: new Set(
        rows.filter((r) => r.kind === 'audio').map((r) => r.giftId),
      ),
      renders: new Set(
        rows
          .filter((r) => r.kind === 'video' && r.renderId)
          .map((r) => r.renderId!),
      ),
    };
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
