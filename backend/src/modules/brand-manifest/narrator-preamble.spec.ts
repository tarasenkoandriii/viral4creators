import { parseNarratorPreamble, preambleMp4Seconds } from './narrator-preamble';
import { planSlideshow } from '../tutorial-runner/tutorial-video-assembly';
import {
  buildTutorialManifest,
  parseTutorialManifest,
} from '../tutorial-runner/tutorial-manifest';
const atom = (type: string, data: Buffer) => {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(data.length + 8);
  h.write(type, 4);
  return Buffer.concat([h, data]);
};
function mp4(seconds: number, sound = true, v = 0) {
  const mvhd = Buffer.alloc(v === 1 ? 32 : 24);
  mvhd[0] = v;
  const offset = v === 1 ? 20 : 12;
  mvhd.writeUInt32BE(1000, offset);
  if (v === 1) mvhd.writeBigUInt64BE(BigInt(seconds * 1000), offset + 4);
  else mvhd.writeUInt32BE(seconds * 1000, offset + 4);
  const track = (type: string) => {
    const h = Buffer.alloc(12);
    h.write(type, 8);
    return atom('trak', atom('mdia', atom('hdlr', h)));
  };
  return atom(
    'moov',
    Buffer.concat([
      atom('mvhd', mvhd),
      track('vide'),
      ...(sound ? [track('soun')] : []),
    ]),
  );
}
export const preambleFixture = {
  version: 1 as const,
  manifestId: 'brand',
  characterId: null,
  imageUrl: null,
  voiceId: null,
  voiceProvider: null,
  pathname: 'brand-manifests/brand/preambles/abc123.mp4',
  url: 'https://store.public.blob.vercel-storage.com/brand-manifests/brand/preambles/abc123.mp4',
  seconds: 6,
  locale: 'ru',
  approvedAt: '2026-10-16T10:00:00.000Z',
};
describe('approved narrator recording', () => {
  it.each([0, 1])('reads duration from version %i metadata', (v) =>
    expect(preambleMp4Seconds(mp4(6, true, v))).toBe(6),
  );
  it.each([4, 11])('rejects out of range %i seconds', (s) =>
    expect(preambleMp4Seconds(mp4(s))).toBeNull(),
  );
  it('rejects missing audio', () =>
    expect(preambleMp4Seconds(mp4(6, false))).toBeNull());
  it('rejects truncated atoms', () =>
    expect(preambleMp4Seconds(mp4(6).subarray(0, 30))).toBeNull());
  it('rejects fragmented recordings', () =>
    expect(
      preambleMp4Seconds(
        Buffer.concat([mp4(6), atom('moof', Buffer.alloc(0))]),
      ),
    ).toBeNull());
  it('rejects arbitrary remote URLs and mismatching paths', () => {
    expect(
      parseNarratorPreamble({
        ...preambleFixture,
        url: 'https://example.org/a.mp4',
      }),
    ).toBeNull();
    expect(
      parseNarratorPreamble({
        ...preambleFixture,
        pathname: 'brand-manifests/other/preambles/abc123.mp4',
      }),
    ).toBeNull();
  });
  it('prepends clip without altering body captions or speech', () => {
    const frames = [
      {
        stepIndex: 0,
        url: 'https://frame',
        seconds: 3,
        audioUrl: 'https://speech',
      },
    ];
    const original = planSlideshow(frames, {
      motion: 'none',
      captionsUrl: 'https://captions',
    })!;
    const plan = planSlideshow(frames, {
      motion: 'none',
      captionsUrl: 'https://captions',
      preamble: preambleFixture,
    })!;
    expect(plan.durationMs).toBe(original.durationMs + 6000);
    expect(plan.commands[0]).toContain('[outv]subtitles={{captions}}[outc]');
    expect(plan.commands[0]).toContain('[outc]fps=');
    expect(plan.commands[0]).toContain('[2:v]scale=');
    expect(plan.commands[0]).toContain(
      '[introv][introa][bodyv][bodya]concat=n=2:v=1:a=1',
    );
    expect(plan.inputs.preamble).toBe(preambleFixture.url);
  });
  it('supplies silence for a silent tutorial body', () => {
    const plan = planSlideshow(
      [{ stepIndex: 0, url: 'https://frame', seconds: 3 }],
      { motion: 'none', preamble: preambleFixture },
    )!;
    expect(plan.commands[0]).toContain(
      'anullsrc=r=44100:cl=stereo,atrim=duration=3',
    );
    expect(plan.commands[0]).toContain('-c:a aac');
  });
  it('rejects invalid preamble instead of silently dropping it', () =>
    expect(
      planSlideshow([{ stepIndex: 0, url: 'f', seconds: 3 }], {
        motion: 'none',
        preamble: { ...preambleFixture, seconds: 20 },
      }),
    ).toBeNull());
  it('preserves preamble in manifest and source identity during tempo changes', () => {
    const input = {
      sourceAssetId: 'asset',
      owner: {
        kind: 'client-site' as const,
        draftId: 'draft',
        userId: 'owner',
      },
      assetContentHash: 'hash',
      locale: 'ru',
      theme: null,
      motion: 'none' as const,
      captions: false,
      narration: 'none' as const,
      storage: 'draft-frames' as const,
      voiceSkipped: null,
      frames: [
        {
          frameId: 'f',
          stepIndex: 0,
          image: { url: 'frame', pathname: null },
          baseSeconds: 3,
          speech: null,
          caption: null,
          readingSeconds: null,
          pointer: null,
        },
      ],
    };
    const plain = buildTutorialManifest(input);
    const voiced = buildTutorialManifest({
      ...input,
      preamble: preambleFixture,
    });
    expect(voiced.sourceHash).not.toBe(plain.sourceHash);
    expect(parseTutorialManifest(voiced)?.preamble).toEqual(preambleFixture);
    expect(
      parseTutorialManifest({
        ...voiced,
        preamble: { ...preambleFixture, seconds: 90 },
      }),
    ).toBeNull();
  });
});
