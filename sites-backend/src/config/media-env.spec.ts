/**
 * env Э6 (config/media-env.ts): где лежат ролики, CSP media-src, ключ
 * ссылки, deep-link в визард обучалки.
 */
import {
  generatorTutorialLink,
  isAllowedVideoUrl,
  videoLinkKey,
  videoMediaSources,
} from './media-env';

describe('isAllowedVideoUrl — ролик только из хранилища роликов', () => {
  it('умолчание — публичный Vercel Blob по https', () => {
    expect(
      isAllowedVideoUrl(
        'https://abc123.public.blob.vercel-storage.com/tutorial-videos/a.mp4',
        {},
      ),
    ).toBe(true);
    for (const bad of [
      'http://abc.public.blob.vercel-storage.com/a.mp4',
      'https://public.blob.vercel-storage.com/a.mp4',
      'https://evil.com/a.mp4',
      'https://abc.public.blob.vercel-storage.com.evil.com/a.mp4',
      'https://u:p@abc.public.blob.vercel-storage.com/a.mp4',
      'javascript:alert(1)',
      42,
    ]) {
      expect(isAllowedVideoUrl(bad, {})).toBe(false);
    }
  });

  it('ASSIST_VIDEO_HOSTS: свой список (стенд — localhost по http)', () => {
    const env = { ASSIST_VIDEO_HOSTS: 'localhost, .cdn.example.com' };
    expect(isAllowedVideoUrl('http://localhost:5181/v.mp4', env)).toBe(true);
    expect(isAllowedVideoUrl('https://x.cdn.example.com/v.mp4', env)).toBe(
      true,
    );
    expect(
      isAllowedVideoUrl('https://a.public.blob.vercel-storage.com/v.mp4', env),
    ).toBe(false);
    expect(videoMediaSources(env)).toEqual([
      'http://localhost:*',
      'https://*.cdn.example.com',
    ]);
    expect(videoMediaSources({})).toEqual([
      'https://*.public.blob.vercel-storage.com',
    ]);
  });
});

describe('ключ ссылки и deep-link', () => {
  it('ключ — производный от ASSIST_SECRETS_KEY; нет секрета — null', () => {
    expect(videoLinkKey({})).toBeNull();
    const a = videoLinkKey({ ASSIST_SECRETS_KEY: 'k' });
    expect(a).toHaveLength(32);
    expect(a!.equals(videoLinkKey({ ASSIST_SECRETS_KEY: 'k2' })!)).toBe(false);
  });

  it('GENERATOR_TMA_URL → ?startapp=cst_<siteId>; нет или не https — null', () => {
    expect(
      generatorTutorialLink('site_1', {
        GENERATOR_TMA_URL: 'https://t.me/gen_bot/app',
      }),
    ).toBe('https://t.me/gen_bot/app?startapp=cst_site_1');
    expect(generatorTutorialLink('site_1', {})).toBeNull();
    expect(
      generatorTutorialLink('site_1', { GENERATOR_TMA_URL: 'http://t.me/x' }),
    ).toBeNull();
    expect(
      generatorTutorialLink('../x', {
        GENERATOR_TMA_URL: 'https://t.me/gen_bot/app',
      }),
    ).toBeNull();
  });
});
