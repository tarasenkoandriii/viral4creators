/* eslint-disable @typescript-eslint/no-explicit-any -- isolated Prisma readers */
import { findFfmpegJobOwners } from './ffmpeg-job-owner';

function db(rows: Record<string, unknown> = {}) {
  return Object.fromEntries(
    [
      'storyVideoRender',
      'tutorialVideoAsset',
      'tutorialVideoVersion',
      'tutorialDemoQualityCheck',
      'portfolioItem',
      'videoAudioTrack',
    ].map((key) => [
      key,
      { findFirst: jest.fn().mockResolvedValue(rows[key] ?? null) },
    ]),
  ) as any;
}

describe('FFmpeg Tutorial operation navigation', () => {
  it('opens the exact product video, version and quality result in the videos tab', async () => {
    const owners = await findFfmpegJobOwners(
      db({
        tutorialVideoAsset: { id: 'asset-1', clientSiteDraftId: null },
        tutorialVideoVersion: { id: 'version-1', assetId: 'asset-1' },
        tutorialDemoQualityCheck: { id: 'quality-1', assetId: 'asset-1' },
      }),
      'selfhosted:job-1',
    );
    expect(owners.map((o) => o.href)).toEqual([
      '/assistant?tab=videos&asset=asset-1',
      '/assistant?tab=videos&asset=asset-1',
      '/assistant?tab=videos&asset=asset-1',
    ]);
  });

  it('keeps a client Tutorial on its separate draft screen', async () => {
    const owners = await findFfmpegJobOwners(
      db({
        tutorialVideoAsset: {
          id: 'client-asset',
          clientSiteDraftId: 'draft-1',
        },
        tutorialVideoVersion: {
          id: 'client-version',
          assetId: 'client-asset',
          asset: { clientSiteDraftId: 'draft-1' },
        },
      }),
      'selfhosted:job-2',
    );
    expect(owners.map((o) => o.href)).toEqual([
      '/site-tutorial-drafts?open=draft-1',
      '/site-tutorial-drafts?open=draft-1',
    ]);
  });
});
