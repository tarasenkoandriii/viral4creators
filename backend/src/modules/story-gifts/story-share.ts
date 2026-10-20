import type { Prisma } from '@prisma/client';

/**
 * ST3: a cleared public link — the hash, its 90-day window and the
 * narrator's consent to the link go together (CHECKs story_gift_share_window,
 * story_gift_narrator_public_consent). Dependency-free: user voices and
 * narrator looks withdraw links with it too.
 */
export const STORY_SHARE_CLEARED = {
  shareHash: null,
  sharedAt: null,
  shareExpiresAt: null,
  narratorPublicConsentAt: null,
  narratorPublicConsentVersion: null,
  narratorPublicConsentRenderId: null,
} as const;

type ShareClient = Pick<Prisma.TransactionClient, 'storyGift'>;

/**
 * ST3-S-03/R-04 (ТЗ §11.3, правила 8.7/10.2): revoking a narrator consent
 * (voice, own recording, image) takes the affected releases off the link at
 * once — no silent Nova or audio-only substitute. Returns links withdrawn.
 */
export async function withdrawStoryShares(
  client: ShareClient,
  where: Prisma.StoryGiftWhereInput,
): Promise<number> {
  const done = await client.storyGift.updateMany({
    where: { AND: [where, { shareHash: { not: null } }] },
    data: STORY_SHARE_CLEARED,
  });
  return done.count;
}
