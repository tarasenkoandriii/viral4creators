import {
  downloadStoryVideo,
  StoryVideoRejectedError,
} from './story-video-result';
import { probeMp4, type Mp4Probe } from '../tutorial-runner/mp4-probe';
import {
  fetchPubliclyRoutable,
  readBodyWithLimit,
} from '../../common/external-url-guard';
jest.mock('../tutorial-runner/mp4-probe', () => ({ probeMp4: jest.fn() }));
jest.mock('../../common/external-url-guard', () => ({
  fetchPubliclyRoutable: jest.fn(),
  readBodyWithLimit: jest.fn(),
  BodyTooLargeError: jest.requireActual('../../common/external-url-guard')
    .BodyTooLargeError,
}));
const probe = (): Mp4Probe => ({
  durationSeconds: 60,
  tracks: [
    {
      kind: 'video',
      timescale: 12800,
      duration: 768000,
      durationSeconds: 60,
      samples: 1500,
      width: 1280,
      height: 720,
    },
    {
      kind: 'audio',
      timescale: 48000,
      duration: 2880000,
      durationSeconds: 60,
      samples: 2813,
      width: null,
      height: null,
    },
  ],
});
beforeEach(() => {
  jest.clearAllMocks();
  (fetchPubliclyRoutable as jest.Mock).mockResolvedValue({
    ok: true,
    headers: new Headers(),
  });
  (readBodyWithLimit as jest.Mock).mockResolvedValue(Buffer.alloc(2048));
  (probeMp4 as jest.Mock).mockReturnValue(probe());
});
describe('Story final container acceptance', () => {
  it('accepts one aligned audio/video pair and normal AAC rounding', async () => {
    const p = probe();
    p.tracks[1].durationSeconds += 0.022;
    (probeMp4 as jest.Mock).mockReturnValue(p);
    expect(
      (await downloadStoryVideo('https://result.test/story.mp4', 60)).videoHash,
    ).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    [
      'short video',
      (p: Mp4Probe) => {
        p.tracks[0].durationSeconds = 3;
      },
    ],
    [
      'long video',
      (p: Mp4Probe) => {
        p.tracks[0].durationSeconds = 80;
      },
    ],
    [
      'long audio',
      (p: Mp4Probe) => {
        p.tracks[1].durationSeconds = 80;
      },
    ],
    [
      'short audio',
      (p: Mp4Probe) => {
        p.tracks[1].durationSeconds = 3;
      },
    ],
    [
      'non-finite movie',
      (p: Mp4Probe) => {
        p.durationSeconds = NaN;
      },
    ],
    [
      'non-finite video',
      (p: Mp4Probe) => {
        p.tracks[0].durationSeconds = NaN;
      },
    ],
    [
      'non-finite audio',
      (p: Mp4Probe) => {
        p.tracks[1].durationSeconds = NaN;
      },
    ],
    [
      'empty video',
      (p: Mp4Probe) => {
        p.tracks[0].samples = 0;
      },
    ],
    [
      'empty audio',
      (p: Mp4Probe) => {
        p.tracks[1].samples = 0;
      },
    ],
    [
      'ambiguous audio',
      (p: Mp4Probe) => {
        p.tracks.push({ ...p.tracks[1] });
      },
    ],
    [
      'ambiguous video',
      (p: Mp4Probe) => {
        p.tracks.push({ ...p.tracks[0] });
      },
    ],
  ] as const)(
    'rejects %s even when the movie header looks correct',
    async (_name, change) => {
      const p = probe();
      change(p);
      (probeMp4 as jest.Mock).mockReturnValue(p);
      await expect(
        downloadStoryVideo('https://result.test/story.mp4', 60),
      ).rejects.toBeInstanceOf(StoryVideoRejectedError);
    },
  );
  it.each([0, -1, NaN, Infinity])(
    'rejects an invalid planned duration %s before downloading',
    async (expected) => {
      await expect(
        downloadStoryVideo('https://result.test/story.mp4', expected),
      ).rejects.toBeInstanceOf(StoryVideoRejectedError);
      expect(fetchPubliclyRoutable).not.toHaveBeenCalled();
    },
  );
});
