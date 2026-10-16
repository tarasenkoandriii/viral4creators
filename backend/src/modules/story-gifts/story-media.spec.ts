import { PNG } from 'pngjs';
import { normalizeStoryPhoto } from './story-photo';
import { audioRange } from './story-gifts.controller';
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
