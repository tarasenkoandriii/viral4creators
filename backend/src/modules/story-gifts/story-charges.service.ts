import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditLedgerService } from '../credit-ledger/credit-ledger.service';
import { loadStoryAccess, type StoryAccessFacts } from './story-access';
import {
  STORY_CHARGE_NONE,
  storyCreditMicroUsd,
  storyCreditPrice,
  type StoryChargeView,
} from './story-pricing';

type Tx = Prisma.TransactionClient;
export type StoryChargeKind = 'audio' | 'video';
export interface StoryChargeStep {
  kind: StoryChargeKind;
  giftId: string;
  /** Required for `video` (the render being created). */
  renderId?: string;
  reserveMicroUsd: number;
}
export interface StoryChargeRecordView extends StoryChargeView {
  /** reserved — held; captured — the step delivered (paid); refunded. */
  status: 'reserved' | 'captured' | 'refunded';
}

/** Video: one key per render (a new attempt is a new render). */
export const storyVideoChargeKey = (renderId: string) => `video:${renderId}`;
/** Audio: one key per attempt (ST3-R-05) — a refunded gift may be voiced again. */
export const storyAudioChargeKey = (giftId: string, attempt: number) =>
  `audio:${giftId}:${attempt}`;
/** ST3-S-02: UNKNOWN without an operator decision — automatic refund (правила 7.5). */
export const STORY_UNKNOWN_REFUND_DAYS = 14;
/** CreditLedger.generatedVideoId of a Story charge. */
export const storyLedgerKey = (key: string) => `story:${key}`;

/** The owner never pays; in `owner` mode payment is not switched on at all. */
const pays = (f: StoryAccessFacts) => !f.isOwner && f.mode !== 'owner';
const CHARGE_SELECT = {
  key: true,
  credits: true,
  free: true,
  status: true,
} as const;

/**
 * Р-ST3-2: credits for the paid Story steps — the audio render (Resemble +
 * Soniox) and the video export (TTS segments + FFmpeg API + Soniox). The
 * reservation is written in the step's own claim transaction: a step that
 * does not start writes no charge, a 402 rolls the claim back, and a repeat
 * of the same step (same key) never charges twice. Refund — on a final
 * FAILED; UNKNOWN keeps the reserve until the operator decides.
 */
@Injectable()
export class StoryChargesService {
  private readonly logger = new Logger(StoryChargesService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: CreditLedgerService,
  ) {}

  facts(userId: string): Promise<StoryAccessFacts> {
    return loadStoryAccess(this.prisma, userId);
  }

  private view(
    row: { credits: number; free: boolean; status: string },
    credit = storyCreditMicroUsd(),
  ): StoryChargeRecordView {
    return {
      credits: row.credits,
      usdEquivalent: credit
        ? Math.round((row.credits * credit) / 1e4) / 100
        : 0,
      free: row.free,
      status:
        row.status === 'REFUNDED'
          ? 'refunded'
          : row.status === 'CAPTURED'
            ? 'captured'
            : 'reserved',
    };
  }

  private price(reserveMicroUsd: number) {
    const price = storyCreditPrice(reserveMicroUsd);
    if (!price)
      throw new ServiceUnavailableException({
        code: 'STORY_PRICING_UNAVAILABLE',
        message: 'Цена в кредитах сейчас недоступна; платная сборка отключена',
      });
    return price;
  }

  private async freeVideo(
    client: Tx | PrismaService,
    userId: string,
    giftId: string,
  ) {
    const member = await client.storyPilotMember.findUnique({
      where: { userId },
      select: { revokedAt: true, freeGiftId: true },
    });
    if (!member || member.revokedAt || member.freeGiftId !== giftId)
      return false;
    const used = await client.storyCreditCharge.findFirst({
      // A free video once reserved or delivered is used; a refunded one is not.
      where: {
        giftId,
        kind: 'video',
        free: true,
        status: { in: ['RESERVED', 'CAPTURED'] },
      },
      select: { id: true },
    });
    return !used;
  }

  /** Charge preview of a step for the estimate (`charge`); no writes. */
  async quote(
    facts: StoryAccessFacts,
    userId: string,
    step: StoryChargeStep,
  ): Promise<StoryChargeView | StoryChargeRecordView> {
    if (!pays(facts)) return { ...STORY_CHARGE_NONE };
    if (step.kind === 'audio' && step.giftId) {
      const existing = await this.reservedAudio(this.prisma, step.giftId);
      if (existing) return this.view(existing);
    }
    const member =
      facts.member && !facts.member.revokedAt ? facts.member : null;
    if (
      member &&
      (step.kind === 'audio'
        ? !member.freeGiftId
        : await this.freeVideo(this.prisma, userId, step.giftId))
    )
      return { credits: 0, usdEquivalent: 0, free: true };
    const price = this.price(step.reserveMicroUsd);
    return {
      credits: price.credits,
      usdEquivalent: price.usdEquivalent,
      free: false,
    };
  }

  private reservedAudio(client: Tx | PrismaService, giftId: string) {
    return client.storyCreditCharge.findFirst({
      where: { giftId, kind: 'audio', status: 'RESERVED' },
      orderBy: { createdAt: 'desc' },
      select: CHARGE_SELECT,
    });
  }

  /** Latest audio-step charge of each gift (list/card), one query. */
  async audioCharges(giftIds: string[]) {
    const out = new Map<string, StoryChargeRecordView>();
    if (!giftIds.length) return out;
    const rows = await this.prisma.storyCreditCharge.findMany({
      where: { giftId: { in: giftIds }, kind: 'audio' },
      orderBy: { createdAt: 'desc' },
      select: { giftId: true, credits: true, free: true, status: true },
    });
    const credit = storyCreditMicroUsd();
    for (const r of rows)
      if (!out.has(r.giftId)) out.set(r.giftId, this.view(r, credit));
    return out;
  }

  /**
   * ST3-S-12/U-04: the price the user confirmed. When the client sends
   * `expectedCredits` and it differs from the charge about to be applied —
   * 409 `STORY_PRICE_CHANGED` with the current `{charge}`; nothing is
   * written (the caller's transaction rolls back).
   */
  private assertExpected(charge: StoryChargeView, expected?: number) {
    if (expected === undefined || expected === null) return;
    if (charge.credits !== expected)
      throw new ConflictException({
        code: 'STORY_PRICE_CHANGED',
        message: `Цена изменилась: сейчас ${charge.credits} кр. Проверьте смету и подтвердите снова`,
        upstreamDetails: { charge },
      });
  }

  /**
   * Reserve inside the step's claim transaction. Not enough credits — 402
   * `STORY_CREDITS_REQUIRED` with `{required, balance}`; the caller's claim
   * rolls back with it. Audio: an already RESERVED charge of the gift (after
   * an operator reopen) is reused; otherwise a new attempt key.
   */
  async reserve(
    tx: Tx,
    facts: StoryAccessFacts,
    userId: string,
    step: StoryChargeStep,
    expectedCredits?: number,
  ): Promise<StoryChargeView> {
    if (!pays(facts)) {
      this.assertExpected(STORY_CHARGE_NONE, expectedCredits);
      return { ...STORY_CHARGE_NONE };
    }
    if (step.kind === 'video' && !step.renderId)
      throw new Error('Story video charge needs the render id');
    let key: string;
    if (step.kind === 'audio') {
      const existing = await this.reservedAudio(tx, step.giftId);
      if (existing) {
        const view = this.view(existing);
        this.assertExpected(view, expectedCredits);
        return view;
      }
      key = storyAudioChargeKey(
        step.giftId,
        (await tx.storyCreditCharge.count({
          where: { giftId: step.giftId, kind: 'audio' },
        })) + 1,
      );
    } else {
      key = storyVideoChargeKey(step.renderId!);
      const existing = await tx.storyCreditCharge.findUnique({
        where: { key },
        select: CHARGE_SELECT,
      });
      if (existing) {
        // A render is reserved once; a refunded render never runs again.
        if (existing.status !== 'RESERVED')
          throw new ConflictException({
            code: 'STORY_CHARGE_CLOSED',
            message:
              'Оплата этой сборки уже возвращена; запустите новую сборку',
          });
        const view = this.view(existing);
        this.assertExpected(view, expectedCredits);
        return view;
      }
    }
    const base = {
      userId,
      key,
      kind: step.kind,
      giftId: step.giftId,
      renderId: step.kind === 'video' ? step.renderId! : null,
      reserveMicroUsd: Math.max(0, Math.ceil(step.reserveMicroUsd)),
    };
    const member = facts.member && !facts.member.revokedAt;
    if (member) {
      const free =
        step.kind === 'audio'
          ? (
              await tx.storyPilotMember.updateMany({
                where: { userId, revokedAt: null, freeGiftId: null },
                data: { freeGiftId: step.giftId, freeGiftUsedAt: new Date() },
              })
            ).count === 1
          : await this.freeVideo(tx, userId, step.giftId);
      if (free) {
        const view = { credits: 0, usdEquivalent: 0, free: true };
        this.assertExpected(view, expectedCredits);
        await tx.storyCreditCharge.create({
          data: { ...base, credits: 0, priceMicroUsd: 0, free: true },
        });
        return view;
      }
    }
    const price = this.price(step.reserveMicroUsd);
    this.assertExpected(
      {
        credits: price.credits,
        usdEquivalent: price.usdEquivalent,
        free: false,
      },
      expectedCredits,
    );
    const result = await this.ledger.reserveKeyed(
      tx,
      userId,
      storyLedgerKey(key),
      price.credits,
    );
    if (!result.reserved)
      throw new HttpException(
        {
          code: 'STORY_CREDITS_REQUIRED',
          message: `Недостаточно кредитов: нужно ${price.credits}, на балансе ${Math.max(0, result.balance)}`,
          // Passed through as error.details by HttpExceptionFilter.
          upstreamDetails: {
            required: price.credits,
            balance: result.balance,
          },
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    await tx.storyCreditCharge.create({
      data: {
        ...base,
        credits: price.credits,
        priceMicroUsd: price.priceMicroUsd,
        free: false,
      },
    });
    return {
      credits: price.credits,
      usdEquivalent: price.usdEquivalent,
      free: false,
    };
  }

  /**
   * Return the credits of a step that ended in a final FAILED (the user got
   * nothing). A free charge gives the free first gift back. Idempotent:
   * returns the credits refunded now (0 — nothing reserved or done before).
   */
  async refund(
    key: string,
    client?: Tx,
  ): Promise<{ refunded: boolean; credits: number }> {
    const run = async (tx: Tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-charge:${key}`}))::text`;
      const charge = await tx.storyCreditCharge.findUnique({
        where: { key },
        select: {
          userId: true,
          kind: true,
          giftId: true,
          credits: true,
          free: true,
          status: true,
        },
      });
      if (!charge || charge.status !== 'RESERVED')
        return { refunded: false, credits: 0 };
      const credits =
        charge.credits > 0
          ? await this.ledger.refundKeyed(tx, storyLedgerKey(key))
          : 0;
      await tx.storyCreditCharge.updateMany({
        where: { key, status: 'RESERVED' },
        data: { status: 'REFUNDED', refundedAt: new Date() },
      });
      if (charge.free && charge.kind === 'audio')
        await tx.storyPilotMember.updateMany({
          where: { userId: charge.userId, freeGiftId: charge.giftId },
          data: { freeGiftId: null, freeGiftUsedAt: null },
        });
      return { refunded: true, credits };
    };
    return client ? run(client) : this.prisma.$transaction(run);
  }

  /** All RESERVED audio charges of a gift (operator close, owner deletion). */
  async refundAudio(giftId: string, client?: Tx) {
    const run = async (tx: Tx) => {
      const rows = await tx.storyCreditCharge.findMany({
        where: { giftId, kind: 'audio', status: 'RESERVED' },
        select: { key: true },
      });
      let credits = 0;
      for (const r of rows) credits += (await this.refund(r.key, tx)).credits;
      return { refunded: rows.length > 0, credits };
    };
    return client ? run(client) : this.prisma.$transaction(run);
  }

  /**
   * ST3-S-02 (правила 7.5): a step left UNKNOWN for 14 days without an
   * operator decision gets its credits back automatically, journaled. The
   * risk of a double provider charge is the platform's.
   */
  async autoRefundStale(now = new Date()) {
    const cutoff = new Date(
      now.getTime() - STORY_UNKNOWN_REFUND_DAYS * 86_400_000,
    );
    // ST3-S-14/R-14: only charges of steps that ARE in UNKNOWN, selected in
    // the query itself — delivered steps can never fill the batch.
    const rows = await this.prisma.$queryRaw<
      Array<{
        key: string;
        kind: string;
        giftId: string;
        renderId: string | null;
      }>
    >`SELECT c."key", c."kind", c."giftId", c."renderId"
        FROM "story_credit_charges" c
        LEFT JOIN "story_gifts" g ON c."kind" = 'audio' AND g."id" = c."giftId"
        LEFT JOIN "story_video_renders" r ON c."kind" = 'video' AND r."id" = c."renderId"
       WHERE c."status" = 'RESERVED' AND c."createdAt" < ${cutoff}
         AND ((c."kind" = 'audio' AND g."status" = 'UNKNOWN')
           OR (c."kind" = 'video' AND r."status" = 'UNKNOWN'))
       ORDER BY c."createdAt" ASC
       LIMIT 50`;
    let refunded = 0;
    for (const r of rows) {
      try {
        const done = await this.prisma.$transaction(async (tx) => {
          const res = await this.refund(r.key, tx);
          if (!res.refunded) return false;
          await tx.storyOperatorAction.create({
            data: {
              actorKind: 'cron',
              targetType: r.kind === 'audio' ? 'gift' : 'render',
              targetId: r.kind === 'audio' ? r.giftId : r.renderId!,
              action: 'charge.auto-refund',
              reason: `Правила 7.5: результат не подтверждён ${STORY_UNKNOWN_REFUND_DAYS} дней без решения оператора — кредиты возвращены автоматически`,
              previousState: { status: 'UNKNOWN', charge: 'RESERVED' },
              result: { creditsRefunded: res.credits },
            },
          });
          return true;
        });
        if (done) refunded++;
      } catch (e) {
        this.logger.warn(
          `Story auto-refund ${r.key} failed: ${e instanceof Error ? e.name : 'error'}`,
        );
      }
    }
    return refunded;
  }

  /**
   * ST3-S-14: a delivered step (audio READY, render READY) is paid —
   * RESERVED → CAPTURED, so RESERVED holds only what may still be refunded.
   */
  async capture(key: string, client?: Tx | PrismaService) {
    const done = await (client ?? this.prisma).storyCreditCharge.updateMany({
      where: { key, status: 'RESERVED' },
      data: { status: 'CAPTURED', capturedAt: new Date() },
    });
    return done.count;
  }
  async captureAudio(giftId: string, client?: Tx | PrismaService) {
    const done = await (client ?? this.prisma).storyCreditCharge.updateMany({
      where: { giftId, kind: 'audio', status: 'RESERVED' },
      data: { status: 'CAPTURED', capturedAt: new Date() },
    });
    return done.count;
  }
  /** Capture outside a transaction; a miss is caught by `captureDelivered`. */
  async captureQuietly(step: { audioGiftId?: string; key?: string }) {
    await (
      step.audioGiftId
        ? this.captureAudio(step.audioGiftId)
        : this.capture(step.key!)
    ).catch(() => 0);
  }
  /**
   * Sweep (story-finalize cron) and the data fix for rows written before
   * capture existed: RESERVED charges of delivered steps → CAPTURED.
   */
  async captureDelivered(): Promise<number> {
    return this.prisma.$executeRaw`UPDATE "story_credit_charges" c
         SET "status" = 'CAPTURED', "capturedAt" = now()
       WHERE c."status" = 'RESERVED' AND (
         (c."kind" = 'audio' AND EXISTS (SELECT 1 FROM "story_gifts" g
            WHERE g."id" = c."giftId" AND g."status" IN ('READY','APPROVED')))
         OR (c."kind" = 'video' AND EXISTS (SELECT 1 FROM "story_video_renders" r
            WHERE r."id" = c."renderId" AND r."status" = 'READY')))`;
  }

  /** Best-effort refund after a FAILED transition outside a transaction. */
  async refundQuietly(key: string): Promise<void> {
    await this.refund(key).catch((e: unknown) => {
      // The step is already FAILED; a lost refund is visible here and in
      // story_credit_charges (RESERVED next to a FAILED step).
      this.logger.warn(
        `Story refund ${key} failed: ${e instanceof Error ? e.name : 'error'}`,
      );
    });
  }
}
