import {
  ageBounds,
  ageOverlap,
  ageStart,
  libraryFacets,
  scoreEntry,
  sourceKeyOf,
  uploadSourceKey,
  youtubeSourceKey,
  youtubeVideoId,
} from './library';
import { AnalysisStatus, VideoAnalysis } from './types/analysis.types';
import { VideoSourceType } from './types/video.types';

describe('source keys (§21 cache)', () => {
  it('reads the video id from every YouTube URL shape', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
    expect(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=12')).toBe(
      'dQw4w9WgXcQ',
    );
    expect(youtubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
    expect(
      youtubeVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x'),
    ).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://vimeo.com/123')).toBeNull();
    expect(youtubeVideoId('not a url')).toBeNull();
  });
  it('keys: yt:<id> and sha256:<hex>; an upload has no key without its bytes', () => {
    expect(youtubeSourceKey('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'yt:dQw4w9WgXcQ',
    );
    expect(uploadSourceKey('abc')).toBe('sha256:abc');
    expect(
      sourceKeyOf({
        sourceType: VideoSourceType.YOUTUBE,
        youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
        registeredAt: new Date(),
      }),
    ).toBe('yt:dQw4w9WgXcQ');
    expect(
      sourceKeyOf({
        sourceType: VideoSourceType.UPLOAD,
        blobPathname: 'sessions/s/original.mp4',
        fileName: 'a.mp4',
        fileSize: 1,
        mimeType: 'video/mp4',
        uploadedAt: new Date(),
      }),
    ).toBeNull();
    expect(sourceKeyOf(undefined)).toBeNull();
  });
});

describe('libraryFacets', () => {
  it('denormalises category, audience, counts, first scene title and first preview', () => {
    const analysis = {
      analysisId: 'a',
      analyzedAt: new Date(),
      status: AnalysisStatus.COMPLETE,
      sceneBreakdown: 'x',
      characters: [
        {
          id: 'c1',
          label: 'A',
          role: null,
          appearance: 'x',
          prominence: 'main',
        },
      ],
      scenes: [
        {
          id: 's1',
          start: 0,
          end: 2,
          title: 'Hook',
          previewAt: 1,
          previewUrl: null,
        },
        {
          id: 's2',
          start: 2,
          end: 4,
          title: 'CTA',
          previewAt: 3,
          previewUrl: 'https://cdn/s2.jpg',
        },
      ],
      audience: {
        ageRange: '25-34',
        gender: 'women',
        interests: ['бег'],
        summary: null,
        source: 'gemini',
      },
      promotedProduct: {
        category: 'кроссовки',
        description: null,
        priceTier: 'mid',
      },
    } as unknown as VideoAnalysis;
    expect(libraryFacets(analysis)).toEqual({
      category: 'кроссовки',
      audienceGender: 'women',
      audienceAgeRange: '25-34',
      audienceInterests: ['бег'],
      sceneCount: 2,
      characterCount: 1,
      title: 'Hook',
      thumbnailUrl: 'https://cdn/s2.jpg',
    });
  });
});

describe('scoreEntry — recommendations (§21)', () => {
  const product = {
    category: 'кроссовки',
    audience: {
      ageRange: '25-34',
      gender: 'women' as const,
      interests: ['бег', 'ЗОЖ'],
      summary: null,
      source: 'gemini' as const,
    },
  };
  const entry = {
    category: 'кроссовки',
    audienceGender: 'women',
    audienceAgeRange: '25-34',
    audienceInterests: ['бег'],
    usageCount: 3,
  };

  it('perfect match scores high and explains every point', () => {
    const r = scoreEntry(entry, product);
    expect(r.score).toBe(91); // 40 + 20 + 20 + 8 + 3
    expect(r.reasons).toEqual([
      'та же категория — «кроссовки»',
      'совпадает пол аудитории',
      'тот же возраст — 25-34',
      'общие интересы: бег',
      'уже использован 3 раз(а)',
    ]);
  });

  it('partial category, "any" gender and a near age still earn points', () => {
    const r = scoreEntry(
      {
        ...entry,
        category: 'беговые кроссовки',
        audienceGender: 'any',
        audienceAgeRange: '30-39',
        audienceInterests: [],
        usageCount: 0,
      },
      product,
    );
    expect(r.score).toBe(47); // 25 + 10 + 12 (25-34 vs 30-39 overlap 4 of 9)
    expect(r.reasons).toContain('близкая категория — «беговые кроссовки»');
    expect(r.reasons).toContain('близкий возраст — 30-39');
  });

  it('nothing in common → 0, and a product without facets scores nothing', () => {
    expect(
      scoreEntry(
        {
          category: 'гарнитуры',
          audienceGender: 'men',
          audienceAgeRange: '18-24',
          audienceInterests: ['гейминг'],
          usageCount: 0,
        },
        product,
      ).score,
    ).toBe(0);
    expect(scoreEntry(entry, { category: null, audience: null }).score).toBe(3);
  });

  it('age ranges compare by overlap, not by their first number', () => {
    expect(ageBounds('25-34')).toEqual([25, 34]);
    expect(ageBounds('45+')).toEqual([45, 99]);
    expect(ageBounds('18-24 и 25-34')).toEqual([18, 34]);
    expect(ageBounds('взрослые')).toBeNull();
    expect(ageStart('25-34')).toBe(25);
    expect(ageStart(null)).toBeNull();
    // adjacent brackets do not overlap → no points at all
    expect(ageOverlap([18, 24], [25, 34])).toBeLessThan(0);
    expect(ageOverlap([25, 34], [30, 39])).toBe(4);
  });
});
