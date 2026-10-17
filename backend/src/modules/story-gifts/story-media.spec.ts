import { STORY_CATALOG } from './story-catalog';
import { storyAudioReservation } from './story-budget';
import { storySpeechScore } from './story-audio-qa';
import { PNG } from 'pngjs';
import { normalizeStoryPhoto } from './story-photo';
import { audioRange, StoryGiftsController } from './story-gifts.controller';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import { escapeStoryHtml, storyText } from './story-catalog';
describe('Story public media boundary', () => {
  it('supports full, closed, open and suffix ranges while rejecting malformed ranges', () => {
    expect(audioRange(undefined, 100)).toBeNull();
    expect(audioRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(audioRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(audioRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    for (const value of [
      'bytes=100-',
      'bytes=30-10',
      'bytes=0-1,5-6',
      'bytes=-0',
      'bytes=-',
      'wat',
    ])
      expect(audioRange(value, 100)).toBe(false);
  });
  it('does not cache or index private owner metadata and media', () => {
    for (const method of [
      'referenceList',
      'videoList',
      'videoStatus',
      'videoFile',
      'videoIntro',
      'videoMain',
      'catalog',
      'list',
      'get',
      'photoGet',
      'audio',
    ] as const) {
      const headers = Reflect.getMetadata(
        HEADERS_METADATA,
        StoryGiftsController.prototype[method],
      );
      expect(headers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Cache-Control',
            value: expect.stringContaining('no-store'),
          }),
          expect.objectContaining({
            name: 'X-Robots-Tag',
            value: 'noindex, nofollow, noarchive',
          }),
        ]),
      );
    }
  });
  it('normalizes a valid photo and rejects arbitrary or over-dimensioned files', () => {
    const source = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    expect(
      PNG.sync.read(normalizeStoryPhoto(source.toString('base64'))).width,
    ).toBe(2);
    expect(() =>
      normalizeStoryPhoto(Buffer.from('<script>').toString('base64')),
    ).toThrow();
    const large = PNG.sync.write(new PNG({ width: 1025, height: 1 }));
    expect(() => normalizeStoryPhoto(large.toString('base64'))).toThrow();
  });
  it('escapes user captions in public HTML and fits one bounded Nova request', () => {
    expect(escapeStoryHtml('<img src=x onerror="x">')).toBe(
      '&lt;img src=x onerror=&quot;x&quot;&gt;',
    );
    expect(storyText().length + 182).toBeLessThan(3000);
  });
});

describe('Short catalogue budget and speech scoring', () => {
  it('keeps classic editions short and priced, while detecting missing narration', () => {
    expect(STORY_CATALOG.some((s) => s.kind === 'classic')).toBe(true);
    for (const story of STORY_CATALOG.filter((s) => s.kind === 'classic')) {
      expect(story.sourceEdition?.textSha256).toBe(
        '39207ca8c60f88adf5cc9085cf2677fb82dd6da3c7ad41715ea17f7bf3cdaeb7',
      );
      expect(story.chapters.at(-1)?.text).toContain('вытащили репку!');
      expect(storyText(story.id).length).toBeLessThan(1800);
      expect(story.targetSeconds).toBeLessThanOrEqual(90);
      expect(story.sourceUrl).toMatch(/^https:/);
      expect(storyAudioReservation(storyText(story.id))).toBeLessThan(1000000);
    }
    expect(storySpeechScore('Ёжик идёт домой.', 'ежик идет домой').wer).toBe(0);
    expect(storySpeechScore('раз два три четыре', 'раз два').wer).toBe(0.5);
  });
});
