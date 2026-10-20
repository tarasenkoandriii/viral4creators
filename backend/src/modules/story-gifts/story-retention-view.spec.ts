import { storyGiftRetention } from './story-retention-view';
import {
  STORY_RETENTION_READY_DAYS,
  STORY_RETENTION_STALE_DAYS,
} from './story-retention.service';

const DAY = 86_400_000;
const now = new Date('2026-10-20T12:00:00Z');
const ago = (d: number) => new Date(now.getTime() - d * DAY);
const at = (d: number) => new Date(now.getTime() + d * DAY).toISOString();

describe('ST3 retention in the cabinet (same terms as the story-retention cron)', () => {
  it('uses the cron constants: 30 days unfinished, 180 days finished', () => {
    expect(STORY_RETENTION_STALE_DAYS).toBe(30);
    expect(STORY_RETENTION_READY_DAYS).toBe(180);
  });
  it('class A: DRAFT/FAILED/UNKNOWN — updatedAt + 30 days, warning 14 days before', () => {
    for (const status of ['DRAFT', 'FAILED', 'UNKNOWN']) {
      expect(
        storyGiftRetention({ status, updatedAt: ago(1) }, null, now),
      ).toEqual({
        purgeAt: at(29),
        warning: false,
        basis: 'unfinished',
        shareExpiresAt: null,
      });
      expect(
        storyGiftRetention({ status, updatedAt: ago(16) }, null, now).warning,
      ).toBe(true);
    }
  });
  it('class B: READY/APPROVED — the last change of the gift or any render + 180 days', () => {
    const r = storyGiftRetention(
      { status: 'APPROVED', updatedAt: ago(170) },
      ago(10),
      now,
    );
    expect(r).toMatchObject({
      purgeAt: at(170),
      warning: false,
      basis: 'finished',
    });
    expect(
      storyGiftRetention({ status: 'READY', updatedAt: ago(170) }, null, now),
    ).toMatchObject({ purgeAt: at(10), warning: true });
  });
  it('published: the 90-day link ends first — its date and the warning', () => {
    expect(
      storyGiftRetention(
        {
          status: 'APPROVED',
          updatedAt: ago(80),
          shareExpiresAt: new Date(at(10)),
        },
        null,
        now,
      ),
    ).toEqual({
      purgeAt: at(10),
      warning: true,
      basis: 'published',
      shareExpiresAt: at(10),
    });
    // An expired link no longer counts.
    expect(
      storyGiftRetention(
        { status: 'APPROVED', updatedAt: ago(1), shareExpiresAt: ago(1) },
        null,
        now,
      ),
    ).toMatchObject({ basis: 'finished', shareExpiresAt: null });
  });
  it('in progress or deleted: no date', () => {
    for (const status of ['SYNTHESIZING', 'DELETED'])
      expect(
        storyGiftRetention({ status, updatedAt: ago(400) }, null, now),
      ).toEqual({
        purgeAt: null,
        warning: false,
        basis: null,
        shareExpiresAt: null,
      });
  });
});
