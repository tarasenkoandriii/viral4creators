/**
 * Р-ST3-4/5: the deletion date the owner sees in the cabinet — the same
 * terms as the nightly `story-retention` cron (class A 30 days without
 * changes, class B 180 days without changes of the gift and its renders) and
 * the 90-day life of a public link (ТЗ §11.4). `warning` — 14 days before.
 */
export const STORY_RETENTION_STALE_DAYS = 30;
export const STORY_RETENTION_READY_DAYS = 180;
export const STORY_RETENTION_QUOTA_DAYS = 3;
export const STORY_SHARE_DAYS = 90;
/** ТЗ §11.4: the source recording of a READY voice clone — 7 days. */
export const STORY_VOICE_SAMPLE_DAYS = 7;
/** Operator/retention journal `story_operator_actions` — at most one year. */
export const STORY_JOURNAL_DAYS = 365;
/** Text of a decided (approved/rejected) pilot application — 90 days. */
export const STORY_PILOT_SCENARIO_DAYS = 90;
export const STORY_RETENTION_WARNING_DAYS = 14;
const DAY = 86_400_000;

export interface StoryRetentionView {
  /** When the cron deletes the gift or the public link ends; null — in progress/deleted. */
  purgeAt: string | null;
  warning: boolean;
  /** unfinished — class A; finished — class B; published — the link ends first. */
  basis: 'unfinished' | 'finished' | 'published' | null;
  /** End of the active public link, if any. */
  shareExpiresAt: string | null;
}

export function storyGiftRetention(
  gift: { status: string; updatedAt: Date; shareExpiresAt?: Date | null },
  lastRenderAt: Date | null = null,
  now: Date = new Date(),
): StoryRetentionView {
  const share =
    gift.shareExpiresAt && gift.shareExpiresAt.getTime() > now.getTime()
      ? gift.shareExpiresAt
      : null;
  let purge: Date | null = null;
  let basis: StoryRetentionView['basis'] = null;
  if (['DRAFT', 'FAILED', 'UNKNOWN'].includes(gift.status)) {
    purge = new Date(
      gift.updatedAt.getTime() + STORY_RETENTION_STALE_DAYS * DAY,
    );
    basis = 'unfinished';
  } else if (['READY', 'APPROVED'].includes(gift.status)) {
    const last = Math.max(
      gift.updatedAt.getTime(),
      lastRenderAt?.getTime() ?? 0,
    );
    purge = new Date(last + STORY_RETENTION_READY_DAYS * DAY);
    basis = 'finished';
  }
  if (purge && share && share.getTime() < purge.getTime()) {
    purge = share;
    basis = 'published';
  }
  return {
    purgeAt: purge ? purge.toISOString() : null,
    warning:
      !!purge &&
      purge.getTime() - now.getTime() <= STORY_RETENTION_WARNING_DAYS * DAY,
    basis,
    shareExpiresAt: share ? share.toISOString() : null,
  };
}
