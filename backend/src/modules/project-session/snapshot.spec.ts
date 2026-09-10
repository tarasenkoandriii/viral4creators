import {
  blobPathnameFromUrl,
  brandManifestSnapshotFrom,
  imageMimeFromPathname,
  productInformationFromItem,
} from './snapshot';

describe('blobPathnameFromUrl', () => {
  it('returns the URL path without the leading slash', () => {
    expect(
      blobPathnameFromUrl(
        'https://abc.public.blob.vercel-storage.com/projects/p1/items/i1/photo.jpg',
      ),
    ).toBe('projects/p1/items/i1/photo.jpg');
  });
  it('decodes percent-encoding', () => {
    expect(blobPathnameFromUrl('https://x.test/a%20b/photo.png')).toBe(
      'a b/photo.png',
    );
  });
  it('returns null for non-URLs and empty paths', () => {
    expect(blobPathnameFromUrl('not a url')).toBeNull();
    expect(blobPathnameFromUrl('https://x.test/')).toBeNull();
  });
});

describe('imageMimeFromPathname', () => {
  it('maps known extensions and falls back to jpeg', () => {
    expect(imageMimeFromPathname('a/photo.png')).toBe('image/png');
    expect(imageMimeFromPathname('a/photo.JPG')).toBe('image/jpeg');
    expect(imageMimeFromPathname('a/photo.webp')).toBe('image/webp');
    expect(imageMimeFromPathname('a/photo')).toBe('image/jpeg');
  });
});

describe('productInformationFromItem', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const project = {
    title: 'Кроссовки Pegasus',
    currency: 'UAH',
    countryCode: 'UA',
  };

  it('copies item fields and derives the Blob pathname from photoUrl', () => {
    const info = productInformationFromItem(
      {
        id: 'i1',
        title: 'Размер 42',
        photoUrl:
          'https://s.public.blob.vercel-storage.com/projects/p1/items/i1/photo.png',
        description: '  Лёгкие беговые  ',
        category: 'кроссовки',
        price: { toString: () => '4799.00' },
      },
      project,
      now,
    );
    expect(info).toEqual({
      productName: 'Размер 42',
      productDescription: 'Лёгкие беговые',
      productImagePathname: 'projects/p1/items/i1/photo.png',
      productImageMimeType: 'image/png',
      productImageUrl:
        'https://s.public.blob.vercel-storage.com/projects/p1/items/i1/photo.png',
      category: 'кроссовки',
      audience: null,
      price: 4799,
      currency: 'UAH',
      countryCode: 'UA',
      languageCode: 'uk',
      sourceProductItemId: 'i1',
      addedAt: now,
    });
  });

  it('copies a stored audience profile and drops a malformed one (Stage 23)', () => {
    const base = {
      id: 'i1',
      title: 't',
      photoUrl: null,
      description: null,
      category: null,
      price: null,
    };
    expect(
      productInformationFromItem(
        {
          ...base,
          audience: {
            ageRange: '25-34',
            gender: 'women',
            interests: ['бег', 7],
            summary: 's',
            source: 'user',
          },
        },
        project,
        now,
      ).audience,
    ).toEqual({
      ageRange: '25-34',
      gender: 'women',
      interests: ['бег'],
      summary: 's',
      source: 'user',
    });
    expect(
      productInformationFromItem({ ...base, audience: [1, 2] }, project, now)
        .audience,
    ).toBeNull();
  });

  it('falls back to the project title and omits image fields without a photo', () => {
    const info = productInformationFromItem(
      {
        id: 'i2',
        title: null,
        photoUrl: null,
        description: null,
        category: null,
        price: null,
      },
      project,
      now,
    );
    expect(info.productName).toBe('Кроссовки Pegasus');
    expect(info.productDescription).toBe('');
    expect(info.productImagePathname).toBeUndefined();
    expect(info.productImageUrl).toBeUndefined();
    expect(info.price).toBeNull();
  });

  it('treats a blank title as missing', () => {
    const info = productInformationFromItem(
      {
        id: 'i3',
        title: '   ',
        photoUrl: null,
        description: 'd',
        category: null,
        price: 10,
      },
      project,
      now,
    );
    expect(info.productName).toBe('Кроссовки Pegasus');
    expect(info.price).toBe(10);
  });
});

describe('brandManifestSnapshotFrom', () => {
  it('copies manifest fields, characters and scenes with their source ids', () => {
    const now = new Date('2026-09-05T12:00:00Z');
    const snap = brandManifestSnapshotFrom(
      {
        id: 'bm1',
        title: 'Бренд',
        styleNotes: 'тёплые тона',
        filters: { preset: 'warm' },
        effects: null,
        characters: [
          {
            id: 'c1',
            label: 'Аня',
            photoUrl: 'https://x.test/c1.png',
            description: null,
          },
          { id: 'c2', label: 'Лис', photoUrl: null, description: 'плюшевый' },
        ],
        scenes: [
          {
            id: 's1',
            label: 'Шоурум',
            photoUrl: 'https://x.test/s1.jpg',
            description: 'белые стены',
          },
        ],
      },
      now,
    );
    expect(snap).toEqual({
      brandManifestId: 'bm1',
      title: 'Бренд',
      styleNotes: 'тёплые тона',
      // Этап 35: озвучка замораживается вместе с остальным брендом.
      voiceMode: 'veo',
      ttsVoiceId: null,
      ttsModel: null,
      ttsProvider: null,
      // Этап 46: движение камеры замораживается тем же снимком.
      cameraMove: 'none',
      voiceNotes: null,
      // Не относится к этому этапу (Resemble) — значения по умолчанию
      // normalizeSubtitlesMode/normalizeSubtitleTheme, когда исходный
      // манифест их не задаёт; тест не перечислял их до сих пор, из-за
      // чего расхождение всплыло только сейчас, при первом запуске
      // jest в этой сессии.
      subtitlesMode: 'off',
      subtitleTheme: 'classic',
      filters: { preset: 'warm' },
      effects: null,
      characters: [
        {
          sourceCharacterId: 'c1',
          label: 'Аня',
          photoUrl: 'https://x.test/c1.png',
          description: null,
        },
        {
          sourceCharacterId: 'c2',
          label: 'Лис',
          photoUrl: null,
          description: 'плюшевый',
        },
      ],
      scenes: [
        {
          sourceSceneId: 's1',
          label: 'Шоурум',
          photoUrl: 'https://x.test/s1.jpg',
          description: 'белые стены',
        },
      ],
      snapshotAt: '2026-09-05T12:00:00.000Z',
      editedAt: null,
    });
  });

  it('copies ttsProvider through when set on the manifest (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.2)', () => {
    const snap = brandManifestSnapshotFrom({
      id: 'bm1',
      title: 't',
      styleNotes: null,
      ttsVoiceId: 'v1',
      ttsProvider: 'resemble',
      filters: null,
      effects: null,
      characters: [],
      scenes: [],
    });
    expect(snap.ttsVoiceId).toBe('v1');
    expect(snap.ttsProvider).toBe('resemble');
  });

  it('drops non-object JSON in filters/effects instead of propagating it', () => {
    const snap = brandManifestSnapshotFrom({
      id: 'bm1',
      title: 't',
      styleNotes: null,
      filters: [1, 2],
      effects: 'oops',
      characters: [],
    });
    expect(snap.filters).toBeNull();
    expect(snap.effects).toBeNull();
    // Pre-Stage-22 callers pass no scenes → empty list, never undefined.
    expect(snap.scenes).toEqual([]);
  });
});
