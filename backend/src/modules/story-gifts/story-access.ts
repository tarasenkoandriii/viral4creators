/**
 * Р-ST3-1: who may use Story-Tales. One env switch, closed by default:
 *
 * - `owner`  (default, and any unknown value) — only the configured owner;
 * - `pilot`  — the owner plus active pilot members (invite-only, approved in
 *   the admin), at most `STORY_PILOT_MAX_MEMBERS` (default 15, ТЗ §18);
 * - `public` — any user after the 18+ confirmation and the Story rules.
 *
 * Members and users accept the current rules (`STORY_TERMS_VERSION`) before
 * any build; the owner does not. In `pilot` a revoked member keeps read/delete
 * access to the data already created (GET/DELETE, `role: 'revoked'`,
 * `readOnly: true`), never a new build; in `public` he is an ordinary user.
 */
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';

export type StoryTalesMode = 'owner' | 'pilot' | 'public';
export type StoryRole = 'owner' | 'member' | 'user' | 'revoked';
export type StoryAccessReason =
  | 'closed'
  | 'pilot_revoked'
  | 'not_invited'
  | 'application_pending'
  | 'terms_required';

/** Version of the published Story rules (appendix to the offer). */
export const STORY_TERMS_VERSION = 'story-rules-2026-10-20';
export const STORY_PILOT_DEFAULT_MAX_MEMBERS = 15;
/** Правила Story 2.1: «не больше 15 участников» — the env cannot raise it. */
export const STORY_PILOT_MAX_MEMBERS_CAP = 15;
let capWarned = false;

export function storyTalesMode(
  env: NodeJS.ProcessEnv = process.env,
): StoryTalesMode {
  const value = (env.STORY_TALES_ACCESS ?? '').trim().toLowerCase();
  return value === 'pilot' || value === 'public' ? value : 'owner';
}

/**
 * Integer 0–15 (ST3-R-06, правила 2.1); above 15 → 15 with a warning in the
 * log (once per process); anything else — the default 15.
 */
export function storyPilotMaxMembers(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = (env.STORY_PILOT_MAX_MEMBERS ?? '').trim();
  const n = Number(raw);
  if (raw === '' || !Number.isInteger(n) || n < 0)
    return STORY_PILOT_DEFAULT_MAX_MEMBERS;
  if (n > STORY_PILOT_MAX_MEMBERS_CAP) {
    if (!capWarned) {
      capWarned = true;
      new Logger('StoryAccess').warn(
        `STORY_PILOT_MAX_MEMBERS=${n} выше лимита правил Story (${STORY_PILOT_MAX_MEMBERS_CAP}) — используется ${STORY_PILOT_MAX_MEMBERS_CAP}`,
      );
    }
    return STORY_PILOT_MAX_MEMBERS_CAP;
  }
  return n;
}

export interface StoryAccessFacts {
  mode: StoryTalesMode;
  isOwner: boolean;
  member: {
    id: string;
    since: Date;
    revokedAt: Date | null;
    freeGiftUsedAt: Date | null;
    freeGiftId: string | null;
  } | null;
  application: { id: string; status: string; createdAt: Date } | null;
  /** Accepted the current rules version with 18+. */
  termsAccepted: boolean;
  /** Accepted any version (may still read/delete own data). */
  termsEverAccepted: boolean;
}

export interface StoryAccessView {
  mode: StoryTalesMode;
  allowed: boolean;
  role: StoryRole | null;
  reason?: StoryAccessReason;
  application?: {
    status: 'pending' | 'approved' | 'rejected' | 'expired';
    createdAt: string;
  };
  freeGiftAvailable: boolean;
  /** ST3-U-01: a revoked pilot member — own data readable and deletable only. */
  readOnly: boolean;
  termsVersion: string;
  seatsLeft?: number;
  /** Pilot seat limit (`STORY_PILOT_MAX_MEMBERS`), only in `pilot`. */
  maxMembers?: number;
}

const activeMember = (f: StoryAccessFacts) => !!f.member && !f.member.revokedAt;
/** Revoked pilot member — only in `pilot`; in `public` an ordinary user. */
const revokedInPilot = (f: StoryAccessFacts) =>
  f.mode === 'pilot' && !!f.member?.revokedAt;

/** Role for pricing and the access answer (null — no access at all). */
export function storyRole(f: StoryAccessFacts): StoryRole | null {
  if (f.isOwner) return 'owner';
  if (f.mode === 'owner') return null;
  if (revokedInPilot(f)) return 'revoked';
  return activeMember(f) ? 'member' : 'user';
}

/** Full use (POST): owner, or member/user allowed by the mode with current rules. */
export function storyCanBuild(f: StoryAccessFacts): boolean {
  if (f.isOwner) return true;
  if (f.mode === 'pilot') return activeMember(f) && f.termsAccepted;
  if (f.mode === 'public') return f.termsAccepted;
  return false;
}

/** Only the rules are missing: answer 403 STORY_TERMS_REQUIRED, not 404. */
export function storyNeedsTerms(f: StoryAccessFacts): boolean {
  if (f.isOwner || f.termsAccepted) return false;
  if (f.mode === 'pilot') return activeMember(f);
  if (f.mode === 'public') return true;
  return false;
}

/** Reading and deleting own data (GET/DELETE). Never in `owner` mode for others. */
export function storyCanRead(f: StoryAccessFacts): boolean {
  if (f.isOwner) return true;
  if (f.mode === 'owner') return false;
  if (storyCanBuild(f)) return true;
  return !!f.member || (f.mode === 'public' && f.termsEverAccepted);
}

export function storyFreeGiftAvailable(f: StoryAccessFacts): boolean {
  return (
    !f.isOwner &&
    f.mode !== 'owner' &&
    activeMember(f) &&
    !f.member!.freeGiftUsedAt
  );
}

export function storyAccessView(
  f: StoryAccessFacts,
  seats?: { active: number; max: number },
): StoryAccessView {
  const base = {
    mode: f.mode,
    termsVersion: STORY_TERMS_VERSION,
    ...(f.mode === 'pilot' && seats
      ? {
          seatsLeft: Math.max(0, seats.max - seats.active),
          maxMembers: seats.max,
        }
      : {}),
  };
  if (f.isOwner)
    return {
      ...base,
      allowed: true,
      role: 'owner',
      freeGiftAvailable: false,
      readOnly: false,
    };
  if (f.mode === 'owner')
    return {
      mode: 'owner',
      allowed: false,
      role: null,
      reason: 'closed',
      freeGiftAvailable: false,
      readOnly: false,
      termsVersion: STORY_TERMS_VERSION,
    };
  const application = f.application
    ? {
        application: {
          status: f.application.status as NonNullable<
            StoryAccessView['application']
          >['status'],
          createdAt: f.application.createdAt.toISOString(),
        },
      }
    : {};
  const role = storyRole(f);
  const freeGiftAvailable = storyFreeGiftAvailable(f);
  if (storyCanBuild(f))
    return {
      ...base,
      ...application,
      allowed: true,
      role,
      freeGiftAvailable,
      readOnly: false,
    };
  if (revokedInPilot(f))
    return {
      ...base,
      ...application,
      allowed: false,
      role: 'revoked',
      reason: 'pilot_revoked',
      freeGiftAvailable: false,
      readOnly: true,
    };
  if (storyNeedsTerms(f))
    return {
      ...base,
      ...application,
      allowed: false,
      role,
      reason: 'terms_required',
      freeGiftAvailable,
      readOnly: false,
    };
  return {
    ...base,
    ...application,
    allowed: false,
    role,
    reason:
      f.mode === 'pilot' && f.application?.status === 'pending'
        ? 'application_pending'
        : 'not_invited',
    freeGiftAvailable: false,
    readOnly: false,
  };
}

type AccessPrisma = Pick<
  PrismaService,
  'user' | 'storyPilotMember' | 'storyPilotApplication' | 'storyTermsAcceptance'
>;

/**
 * Facts for one authenticated user. Identity is the validated internal user
 * id (TelegramIdentityGuard), never a caller-supplied Telegram id; roles and
 * paid plans of the main product confer nothing. In `owner` mode a
 * non-owner costs one query and learns nothing else.
 */
export async function loadStoryAccess(
  prisma: AccessPrisma,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoryAccessFacts> {
  const mode = storyTalesMode(env);
  const ownerTelegramId = env.STORY_TALES_OWNER_TELEGRAM_ID?.trim();
  const isOwner = ownerTelegramId
    ? !!(await prisma.user.findFirst({
        where: { id: userId, telegramId: ownerTelegramId },
        select: { id: true },
      }))
    : false;
  const empty: StoryAccessFacts = {
    mode,
    isOwner,
    member: null,
    application: null,
    termsAccepted: false,
    termsEverAccepted: false,
  };
  if (isOwner || mode === 'owner') return empty;
  const [member, application, terms] = await Promise.all([
    prisma.storyPilotMember.findUnique({
      where: { userId },
      select: {
        id: true,
        since: true,
        revokedAt: true,
        freeGiftUsedAt: true,
        freeGiftId: true,
      },
    }),
    prisma.storyPilotApplication.findUnique({
      where: { userId },
      select: { id: true, status: true, createdAt: true },
    }),
    prisma.storyTermsAcceptance.findMany({
      where: { userId },
      select: { termsVersion: true },
    }),
  ]);
  return {
    ...empty,
    member,
    application,
    termsAccepted: terms.some((t) => t.termsVersion === STORY_TERMS_VERSION),
    termsEverAccepted: terms.length > 0,
  };
}
