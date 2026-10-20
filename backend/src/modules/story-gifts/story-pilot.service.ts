import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { withdrawStoryShares } from './story-share';
import {
  loadStoryAccess,
  STORY_TERMS_VERSION,
  storyAccessView,
  storyPilotMaxMembers,
  storyTalesMode,
} from './story-access';

type Tx = Prisma.TransactionClient;
const APPLICATION_SELECT = {
  id: true,
  userId: true,
  scenario: true,
  status: true,
  createdAt: true,
  user: { select: { username: true } },
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface StoryPilotActionInput {
  reason?: string;
  requestId?: string;
}
type PilotAction = 'pilot.approve' | 'pilot.reject' | 'pilot.revoke';
const DEFAULT_REASON: Record<PilotAction, string> = {
  'pilot.approve': 'Заявка одобрена владельцем',
  'pilot.reject': 'Заявка отклонена владельцем',
  'pilot.revoke': 'Доступ к пилоту отозван владельцем',
};

/** Normalised optional pilot scenario: trimmed, no control chars, ≤500. */
export function storyPilotScenario(raw: string | null | undefined) {
  if (raw === undefined || raw === null) return null;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (text.length > 500)
    throw new BadRequestException('Сценарий — не длиннее 500 символов');
  return text || null;
}

/**
 * Р-ST3-1/7: access answer, pilot applications from the TMA, Story rules
 * acceptance (18+) and the owner's pilot administration. Admin actions are
 * journaled in `story_operator_actions` (no scenario text, no user id: the
 * target is the application/member row).
 */
@Injectable()
export class StoryPilotService {
  constructor(private readonly prisma: PrismaService) {}

  private activeMembers(client: Tx | PrismaService = this.prisma) {
    return client.storyPilotMember.count({ where: { revokedAt: null } });
  }

  async access(userId: string) {
    const facts = await loadStoryAccess(this.prisma, userId);
    const seats =
      facts.mode === 'pilot'
        ? { active: await this.activeMembers(), max: storyPilotMaxMembers() }
        : undefined;
    return storyAccessView(facts, seats);
  }

  /** Idempotent: a repeat returns the existing application (any status). */
  async apply(userId: string, scenario?: string | null) {
    if (storyTalesMode() !== 'pilot') throw new NotFoundException();
    const text = storyPilotScenario(scenario);
    const facts = await loadStoryAccess(this.prisma, userId);
    if (facts.isOwner)
      throw new ConflictException({
        code: 'STORY_PILOT_OWNER',
        message: 'Владельцу заявка не нужна',
      });
    if (facts.member && !facts.member.revokedAt)
      throw new ConflictException({
        code: 'STORY_PILOT_ALREADY_MEMBER',
        message: 'Вы уже участник пилота',
      });
    const application = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('story-pilot'))::text`;
      const existing = await tx.storyPilotApplication.findUnique({
        where: { userId },
        select: { id: true, status: true, createdAt: true },
      });
      // ST3-S-10: an expired application (pending > 90 days, text erased)
      // may be filed again; any other status is returned as is.
      if (existing && existing.status !== 'expired')
        return { status: existing.status, createdAt: existing.createdAt };
      if ((await this.activeMembers(tx)) >= storyPilotMaxMembers())
        throw new ConflictException({
          code: 'STORY_PILOT_FULL',
          message: 'Мест в пилоте сейчас нет',
        });
      if (existing)
        return tx.storyPilotApplication.update({
          where: { id: existing.id },
          data: {
            status: 'pending',
            decidedAt: null,
            scenario: text,
            createdAt: new Date(),
          },
          select: { status: true, createdAt: true },
        });
      return tx.storyPilotApplication.create({
        data: { userId, scenario: text },
        select: { status: true, createdAt: true },
      });
    });
    return {
      application: {
        status: application.status,
        createdAt: application.createdAt.toISOString(),
      },
    };
  }

  async acceptTerms(userId: string, termsVersion: string, adult: boolean) {
    if (adult !== true)
      throw new BadRequestException(
        'Нужно подтверждение: вам 18 лет или больше',
      );
    if (termsVersion !== STORY_TERMS_VERSION)
      throw new ConflictException({
        code: 'STORY_TERMS_OUTDATED',
        message: 'Правила обновились — откройте актуальную редакцию',
      });
    const facts = await loadStoryAccess(this.prisma, userId);
    if (!facts.isOwner && facts.mode === 'owner') throw new NotFoundException();
    await this.prisma.storyTermsAcceptance.upsert({
      where: { userId_termsVersion: { userId, termsVersion } },
      create: { userId, termsVersion, adult: true },
      update: {},
    });
    return this.access(userId);
  }

  // ───────────── admin ─────────────

  async overview() {
    const [members, applications] = await Promise.all([
      this.prisma.storyPilotMember.findMany({
        where: { revokedAt: null },
        orderBy: { since: 'asc' },
        take: 200,
        select: {
          userId: true,
          since: true,
          freeGiftUsedAt: true,
          user: { select: { username: true } },
        },
      }),
      // ST3-S-11: every pending application (no limit) + the last 200 decided.
      Promise.all([
        this.prisma.storyPilotApplication.findMany({
          where: { status: 'pending' },
          orderBy: { createdAt: 'asc' },
          select: APPLICATION_SELECT,
        }),
        this.prisma.storyPilotApplication.findMany({
          where: { status: { not: 'pending' } },
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: APPLICATION_SELECT,
        }),
      ]).then(([pending, decided]) => [...pending, ...decided]),
    ]);
    const counts = members.length
      ? await this.prisma.storyGift.groupBy({
          by: ['userId'],
          where: {
            userId: { in: members.map((m) => m.userId) },
            status: { not: 'DELETED' },
          },
          _count: { _all: true },
        })
      : [];
    const gifts = new Map(
      (counts as Array<{ userId: string; _count: { _all: number } }>).map(
        (c) => [c.userId, c._count._all],
      ),
    );
    return {
      mode: storyTalesMode(),
      maxMembers: storyPilotMaxMembers(),
      members: members.map((m) => ({
        userId: m.userId,
        shortId: m.userId.slice(0, 8),
        ...(m.user?.username ? { telegramUsername: m.user.username } : {}),
        since: m.since.toISOString(),
        freeGiftUsed: !!m.freeGiftUsedAt,
        giftsCount: gifts.get(m.userId) ?? 0,
      })),
      // Pending first (oldest first), then the decided ones, newest first.
      applications: applications.map((a) => ({
        id: a.id,
        userId: a.userId,
        shortId: a.userId.slice(0, 8),
        ...(a.user?.username ? { telegramUsername: a.user.username } : {}),
        scenario: a.scenario,
        status: a.status,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  }

  approve(actor: string, id: string, input: StoryPilotActionInput = {}) {
    return this.act(
      actor,
      'pilot-application',
      id,
      'pilot.approve',
      input,
      async (tx) => {
        const app = await tx.storyPilotApplication.findUnique({
          where: { id },
          select: { id: true, userId: true, status: true },
        });
        if (!app) throw new NotFoundException('Заявка не найдена');
        if (app.status !== 'pending')
          throw new ConflictException({
            code: 'STORY_PILOT_DECIDED',
            message: 'Заявка уже рассмотрена',
          });
        const member = await tx.storyPilotMember.findUnique({
          where: { userId: app.userId },
          select: { id: true },
        });
        if (member)
          throw new ConflictException({
            code: 'STORY_PILOT_ALREADY_MEMBER',
            message: 'Пользователь уже был участником пилота',
          });
        const max = storyPilotMaxMembers();
        if ((await this.activeMembers(tx)) >= max)
          throw new ConflictException({
            code: 'STORY_PILOT_FULL',
            message: `Мест в пилоте нет (лимит ${max})`,
          });
        await tx.storyPilotApplication.update({
          where: { id },
          data: { status: 'approved', decidedAt: new Date() },
        });
        const created = await tx.storyPilotMember.create({
          data: { userId: app.userId, applicationId: id },
          select: { id: true },
        });
        return {
          previous: { status: 'pending' },
          result: { status: 'approved', memberId: created.id },
        };
      },
    );
  }

  reject(actor: string, id: string, input: StoryPilotActionInput = {}) {
    return this.act(
      actor,
      'pilot-application',
      id,
      'pilot.reject',
      input,
      async (tx) => {
        const done = await tx.storyPilotApplication.updateMany({
          where: { id, status: 'pending' },
          data: { status: 'rejected', decidedAt: new Date() },
        });
        if (!done.count) {
          const app = await tx.storyPilotApplication.findUnique({
            where: { id },
            select: { id: true },
          });
          if (!app) throw new NotFoundException('Заявка не найдена');
          throw new ConflictException({
            code: 'STORY_PILOT_DECIDED',
            message: 'Заявка уже рассмотрена',
          });
        }
        return {
          previous: { status: 'pending' },
          result: { status: 'rejected' },
        };
      },
    );
  }

  /**
   * Revocation: the user's data stay (read/delete), new builds are 404; the
   * user's public links are withdrawn at once (no new public delivery).
   */
  async revoke(
    actor: string,
    userId: string,
    input: StoryPilotActionInput = {},
  ) {
    const member = await this.prisma.storyPilotMember.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Участник не найден');
    return this.act(
      actor,
      'pilot-member',
      member.id,
      'pilot.revoke',
      input,
      async (tx) => {
        const done = await tx.storyPilotMember.updateMany({
          where: { id: member.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (!done.count)
          throw new ConflictException({
            code: 'STORY_PILOT_REVOKED',
            message: 'Доступ уже отозван',
          });
        // ST3-S-01: the whole link window, including the narrator's consent.
        const linksWithdrawn = await withdrawStoryShares(tx, { userId });
        return {
          previous: { revoked: false },
          result: { revoked: true, linksWithdrawn },
        };
      },
    );
  }

  /** Journaled admin action; a repeated `requestId` returns the first result. */
  private async act(
    actor: string,
    targetType: 'pilot-application' | 'pilot-member',
    targetId: string,
    action: PilotAction,
    input: StoryPilotActionInput,
    step: (tx: Tx) => Promise<{ previous: object; result: object }>,
  ) {
    const reason = (input.reason ?? '').trim() || DEFAULT_REASON[action];
    if (reason.length < 3 || reason.length > 500)
      throw new BadRequestException('Укажите причину: от 3 до 500 символов');
    const requestId = (input.requestId ?? randomUUID()).toLowerCase();
    if (!UUID.test(requestId))
      throw new BadRequestException('requestId должен быть UUID');
    const replay = async (client: Tx | PrismaService) => {
      const prev = await client.storyOperatorAction.findUnique({
        where: { requestId },
      });
      if (!prev) return null;
      if (
        prev.action !== action ||
        prev.targetType !== targetType ||
        prev.targetId !== targetId
      )
        throw new ConflictException(
          'Этот requestId уже использован для другого действия',
        );
      return {
        journalId: prev.id,
        action: prev.action,
        targetType: prev.targetType,
        targetId: prev.targetId,
        result: prev.result,
        createdAt: prev.createdAt,
        replayed: true,
      };
    };
    const early = await replay(this.prisma);
    if (early) return early;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('story-pilot'))::text`;
      const again = await replay(tx);
      if (again) return again;
      const { previous, result } = await step(tx);
      const entry = await tx.storyOperatorAction.create({
        data: {
          requestId,
          actorKind: 'admin',
          actorUserId: actor,
          targetType,
          targetId,
          action,
          reason,
          previousState: previous as Prisma.InputJsonValue,
          result: result as Prisma.InputJsonValue,
        },
      });
      return {
        journalId: entry.id,
        action,
        targetType,
        targetId,
        result,
        createdAt: entry.createdAt,
        replayed: false,
      };
    });
  }
}
