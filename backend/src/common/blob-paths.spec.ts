import {
  itemPhotoPathname,
  libraryEntryPathnames,
  pathnameFromBlobUrl,
  sessionBlobPathnames,
} from './blob-paths';
import { Session, SessionStatus } from './types/session.types';
import { VideoSourceType } from './types/video.types';

const base = {
  sessionId: 's1',
  createdAt: new Date(),
  lastActivityAt: new Date(),
  status: SessionStatus.CREATED,
} as Session;

describe('sessionBlobPathnames (doc/STORAGE-AUDIT.md)', () => {
  it('пустая сессия не владеет ничем', () => {
    expect(sessionBlobPathnames(base)).toEqual([]);
  });

  it('собирает транзитный референс, готовый ролик, превью, фото-замены и сцены', () => {
    const session = {
      ...base,
      originalVideo: {
        sourceType: VideoSourceType.UPLOAD,
        blobPathname: 'sessions/s1/original.mp4',
        fileName: 'a.mp4',
        fileSize: 1,
        mimeType: 'video/mp4',
        uploadedAt: new Date(),
      },
      generatedVideo: { pathname: 'sessions/s1/generated.mp4' },
      videoAnalysis: {
        characters: [
          { id: 'c1', previewUrl: 'https://cdn/x.jpg' },
          { id: 'c2', previewUrl: null },
        ],
        scenes: [{ id: 's1', previewUrl: 'https://cdn/y.jpg' }],
        extras: [{ id: 'e1', previewUrl: 'https://cdn/z.jpg' }],
      },
      characterCasting: {
        casts: [
          {
            replacement: {
              photoPathname: 'sessions/s1/characters/c1/photo.jpg',
            },
          },
          { replacement: { photoPathname: null } },
        ],
      },
      scenes: [{ photoPathname: 'sessions/s1/scenes/sc_a/photo.png' }],
      // Референс-кадры поздравления: и загруженный, и нарисованный
      // фичей №6 — оба в префиксе сессии, оба обязаны удалиться вместе
      // с ней. До правки этого прохода они здесь не перечислялись
      // вовсе и оставались в хранилище до суточной метлы.
      greetingReferenceImages: [
        { photoPathname: 'sessions/s1/greeting-refs/gr_a/photo.jpg' },
        {
          photoPathname: 'sessions/s1/greeting-refs/gr_b/photo.png',
          // Скетч живёт в своём префиксе и в список сессии не попадает.
          sketch: { pathname: 'sketches/u1/sk_1.png' },
        },
      ],
    } as unknown as Session;

    expect(sessionBlobPathnames(session).sort()).toEqual(
      [
        'sessions/s1/characters/c1/photo.jpg',
        'sessions/s1/generated.mp4',
        'sessions/s1/original.mp4',
        'sessions/s1/previews/character-c1.jpg',
        'sessions/s1/previews/extra-e1.jpg',
        'sessions/s1/previews/scene-s1.jpg',
        'sessions/s1/scenes/sc_a/photo.png',
        'sessions/s1/greeting-refs/gr_a/photo.jpg',
        'sessions/s1/greeting-refs/gr_b/photo.png',
      ].sort(),
    );
  });

  it('своя музыка удаляется вместе с сессией, а каталожная тема — нет', () => {
    // Загруженный файл живёт под префиксом сессии и принадлежит ей.
    // Тема из каталога платформы общая, одна на всех: удаление одной
    // сессии не вправе её тронуть. Отличает их `source`.
    const uploaded = {
      sessionId: 's1',
      greetingBriefSnapshot: {
        musicTheme: {
          id: 'mt_a',
          title: 'Своя',
          url: 'https://blob.test/mt_a.mp3',
          source: 'upload',
          pathname: 'sessions/s1/music/mt_a.mp3',
        },
      },
    } as unknown as Session;
    expect(sessionBlobPathnames(uploaded)).toEqual([
      'sessions/s1/music/mt_a.mp3',
    ]);

    const fromCatalog = {
      sessionId: 's1',
      greetingBriefSnapshot: {
        musicTheme: {
          id: 'party',
          title: 'Праздничная',
          url: 'https://blob.test/party.mp3',
          source: 'catalog',
        },
      },
    } as unknown as Session;
    expect(sessionBlobPathnames(fromCatalog)).toEqual([]);
  });

  it('трек из библиотеки — тоже наша копия и удаляется вместе с сессией', () => {
    const fromLibrary = {
      sessionId: 's1',
      greetingBriefSnapshot: {
        musicTheme: {
          id: 'ml_a',
          title: 'Тёплое утро',
          url: 'https://blob.test/ml_a.mp3',
          source: 'library',
          pathname: 'sessions/s1/music/ml_a.mp3',
        },
      },
    } as unknown as Session;
    expect(sessionBlobPathnames(fromLibrary)).toEqual([
      'sessions/s1/music/ml_a.mp3',
    ]);
  });

  it('ссылка на чужой хост нам не принадлежит — удалять нечего', () => {
    const asLink = {
      sessionId: 's1',
      greetingBriefSnapshot: {
        musicTheme: {
          id: 'ml_b',
          title: 'Чужая',
          url: 'https://cdn.example.com/t.mp3',
          source: 'link',
        },
      },
    } as unknown as Session;
    expect(sessionBlobPathnames(asLink)).toEqual([]);
  });

  it('старая запись без source каталожной темой и остаётся — не удаляем по догадке', () => {
    const legacy = {
      sessionId: 's1',
      greetingBriefSnapshot: {
        musicTheme: {
          id: 'x',
          title: 'X',
          url: 'https://blob.test/x.mp3',
          pathname: 'sessions/s1/music/x.mp3',
        },
      },
    } as unknown as Session;
    expect(sessionBlobPathnames(legacy)).toEqual([]);
  });

  it('наклейка удаляется вместе с сессией — она всегда наша копия', () => {
    // Условия Pixabay запрещают постоянный хотлинк, поэтому файл
    // скачан к нам и живёт под префиксом сессии.
    const session = {
      sessionId: 's1',
      greetingBriefSnapshot: {
        sticker: {
          id: 'st_1',
          url: 'https://blob.test/st_1.png',
          pathname: 'sessions/s1/stickers/st_1.png',
          sourceUrl: 'https://pixabay.com/x',
          source: 'pixabay',
          placement: 'center',
        },
      },
    } as unknown as Session;
    expect(sessionBlobPathnames(session)).toEqual([
      'sessions/s1/stickers/st_1.png',
    ]);
  });

  it('не трогает чужие файлы: ссылку на YouTube, фото персонажа бренда, путь вне префикса', () => {
    const session = {
      ...base,
      originalVideo: {
        sourceType: VideoSourceType.YOUTUBE,
        youtubeUrl: 'https://youtu.be/x',
        registeredAt: new Date(),
      },
      characterCasting: {
        casts: [
          // персонаж бренда: файл принадлежит манифесту, pathname пуст
          {
            replacement: {
              kind: 'brand',
              photoPathname: null,
              photoUrl: 'https://cdn/brand.png',
            },
          },
          // подделанный путь в чужой префикс — отфильтровывается
          {
            replacement: {
              photoPathname: 'sessions/OTHER/characters/c9/photo.jpg',
            },
          },
        ],
      },
    } as unknown as Session;
    expect(sessionBlobPathnames(session)).toEqual([]);
  });

  it('обрезанный ролик и синтезированная дорожка принадлежат сессии', () => {
    // Это два самых тяжёлых файла после самого ролика, и оба появляются
    // ПОСЛЕ генерации — на шаге постобработки (§15.4/§16.1, этапы 34–35).
    // Пока эти две строки не были покрыты, их удаление оставляло все
    // тесты зелёными, а файлы — в хранилище навсегда: ровно та утечка,
    // которую чинил этап 26. Соседний тест доказывает, что postPathname
    // ЗАПИСЫВАЕТСЯ; здесь доказывается, что он ещё и УБИРАЕТСЯ.
    const session = {
      ...base,
      generatedVideo: {
        pathname: 'sessions/s1/generated.mp4',
        postPathname: 'sessions/s1/generated-post.mp4',
        voiceoverPathname: 'sessions/s1/voiceover.mp3',
      },
    } as unknown as Session;

    expect(sessionBlobPathnames(session).sort()).toEqual([
      'sessions/s1/generated-post.mp4',
      'sessions/s1/generated.mp4',
      'sessions/s1/voiceover.mp3',
    ]);
  });

  it('постобработки не было — лишних путей не выдумывается', () => {
    // Сессия до этапа 34 (и любая, где обрезка не понадобилась) не имеет
    // этих полей вовсе. Список путей уходит прямо в удаление, поэтому
    // «undefined» в нём был бы не косметикой, а попыткой снести не то.
    const session = {
      ...base,
      generatedVideo: {
        pathname: 'sessions/s1/generated.mp4',
        postPathname: null,
        voiceoverPathname: undefined,
      },
    } as unknown as Session;

    expect(sessionBlobPathnames(session)).toEqual([
      'sessions/s1/generated.mp4',
    ]);
  });

  it('файлы автоэкспорта (ярус A, этап 75) принадлежат сессии', () => {
    // Тот же класс дефекта, что чинил этап 26: без этой строки удаление
    // сессии оставляло бы export-*.mp4 немедленным сиротой до следующего
    // прохода метлы.
    const session = {
      ...base,
      generatedVideo: {
        pathname: 'sessions/s1/generated.mp4',
        exportVariants: [
          {
            format: '1:1',
            tier: 'A',
            status: 'complete',
            pathname: 'sessions/s1/export-1x1.mp4',
            requestedAt: 'x',
          },
          {
            format: '4:5',
            tier: 'A',
            status: 'pending',
            requestedAt: 'x',
            // pathname ещё нет — задача не завершилась, выдумывать путь нельзя.
          },
          {
            format: '16:9',
            tier: 'B',
            status: 'complete',
            // Ярус B — файл лежит у ДОЧЕРНЕЙ сессии (свой sessionId,
            // свой префикс) и потому не входит в список родителя.
            pathname: 'sessions/child-1/generated.mp4',
            requestedAt: 'x',
          },
        ],
      },
    } as unknown as Session;

    expect(sessionBlobPathnames(session).sort()).toEqual([
      'sessions/s1/export-1x1.mp4',
      'sessions/s1/generated.mp4',
    ]);
  });

  it('Е-2.6 шестого аудита: жёстко вшитые субтитры основного пайплайна принадлежат сессии', () => {
    const session = {
      ...base,
      generatedVideo: {
        pathname: 'sessions/s1/generated.mp4',
        subtitlePathname: 'sessions/s1/subtitles.srt',
      },
    } as unknown as Session;
    expect(sessionBlobPathnames(session).sort()).toEqual([
      'sessions/s1/generated.mp4',
      'sessions/s1/subtitles.srt',
    ]);
  });

  it('Е-2.6 шестого аудита: субтитров не заказывали — subtitlePathname отсутствует, лишнего не выдумывается', () => {
    const session = {
      ...base,
      generatedVideo: {
        pathname: 'sessions/s1/generated.mp4',
        subtitlePathname: null,
      },
    } as unknown as Session;
    expect(sessionBlobPathnames(session)).toEqual([
      'sessions/s1/generated.mp4',
    ]);
  });

  it('Е-2.6 шестого аудита: все четыре файла пилота аватара принадлежат сессии (без субтитров — downloadUrl===renderedUrl не дублируется)', () => {
    const session = {
      ...base,
      avatarVideo: {
        voiceoverPathname: 'sessions/s1/avatar-voiceover.mp3',
        renderedUrl:
          'https://x.public.blob.vercel-storage.com/sessions/s1/avatar-raw.mp4',
        downloadUrl:
          'https://x.public.blob.vercel-storage.com/sessions/s1/avatar-raw.mp4',
        subtitlePathname: null,
      },
    } as unknown as Session;
    expect(sessionBlobPathnames(session).sort()).toEqual([
      'sessions/s1/avatar-raw.mp4',
      'sessions/s1/avatar-voiceover.mp3',
    ]);
  });

  it('Е-2.6 шестого аудита: аватар с вшитыми субтитрами — downloadUrl отдельный файл, .srt тоже входит', () => {
    const session = {
      ...base,
      avatarVideo: {
        voiceoverPathname: 'sessions/s1/avatar-voiceover.mp3',
        renderedUrl:
          'https://x.public.blob.vercel-storage.com/sessions/s1/avatar-raw.mp4',
        downloadUrl:
          'https://x.public.blob.vercel-storage.com/sessions/s1/avatar.mp4',
        subtitlePathname: 'sessions/s1/avatar-subtitles.srt',
      },
    } as unknown as Session;
    expect(sessionBlobPathnames(session).sort()).toEqual([
      'sessions/s1/avatar-raw.mp4',
      'sessions/s1/avatar-subtitles.srt',
      'sessions/s1/avatar-voiceover.mp3',
      'sessions/s1/avatar.mp4',
    ]);
  });

  it('Е-2.6 шестого аудита: рендер аватара ещё не завершился — renderedUrl/downloadUrl пусты, лишнего не выдумывается', () => {
    const session = {
      ...base,
      avatarVideo: {
        voiceoverPathname: 'sessions/s1/avatar-voiceover.mp3',
        renderedUrl: null,
        downloadUrl: null,
        subtitlePathname: null,
      },
    } as unknown as Session;
    expect(sessionBlobPathnames(session)).toEqual([
      'sessions/s1/avatar-voiceover.mp3',
    ]);
  });

  it('дубли схлопываются', () => {
    const session = {
      ...base,
      generatedVideo: { pathname: 'sessions/s1/generated.mp4' },
      scenes: [
        { photoPathname: 'sessions/s1/generated.mp4' },
        { photoPathname: 'sessions/s1/scenes/a/photo.png' },
      ],
    } as unknown as Session;
    expect(sessionBlobPathnames(session)).toHaveLength(2);
  });
});

describe('itemPhotoPathname', () => {
  it('выводит путь из публичного URL и игнорирует всё остальное', () => {
    expect(
      itemPhotoPathname(
        'https://x.public.blob.vercel-storage.com/projects/p1/items/i1/photo.jpg',
      ),
    ).toBe('projects/p1/items/i1/photo.jpg');
    expect(
      itemPhotoPathname('https://x.test/sessions/s1/generated.mp4'),
    ).toBeNull();
    expect(itemPhotoPathname('не url')).toBeNull();
    expect(itemPhotoPathname(null)).toBeNull();
  });
});

describe('фото товара в сессии (этап 39, А-2.14)', () => {
  it('фото, загруженное прямо в сессию, принадлежит ей', () => {
    // У быстрой генерации без проекта другого владельца нет: без этой
    // строки файл оставался в хранилище навсегда.
    expect(
      sessionBlobPathnames({
        ...base,
        productInformation: {
          productImagePathname: 'sessions/s1/product-image.jpg',
        },
      } as Session),
    ).toEqual(['sessions/s1/product-image.jpg']);
  });

  it('фото из товара проекта сессии НЕ принадлежит', () => {
    // Там владелец — товар: он переживает сессию и своё фото уносит сам.
    expect(
      sessionBlobPathnames({
        ...base,
        productInformation: {
          productImagePathname: 'projects/p1/items/i1/photo.jpg',
        },
      } as Session),
    ).toEqual([]);
  });
});

describe('pathnameFromBlobUrl — префикс обязателен (этап 27)', () => {
  it('возвращает путь только внутри ожидаемого префикса', () => {
    expect(
      pathnameFromBlobUrl(
        'https://x.public.blob.vercel-storage.com/brand-manifests/bm1/scenes/bs1/photo.jpg',
        'brand-manifests/bm1/',
      ),
    ).toBe('brand-manifests/bm1/scenes/bs1/photo.jpg');
    // подсунутый URL из чужого манифеста не проходит
    expect(
      pathnameFromBlobUrl(
        'https://x.test/brand-manifests/OTHER/scenes/bs1/photo.jpg',
        'brand-manifests/bm1/',
      ),
    ).toBeNull();
    expect(pathnameFromBlobUrl(null, 'projects/')).toBeNull();
    expect(pathnameFromBlobUrl('не url', 'projects/')).toBeNull();
  });
  it('декодирует проценты в пути', () => {
    expect(
      pathnameFromBlobUrl(
        'https://x.test/projects/p%201/photo.jpg',
        'projects/',
      ),
    ).toBe('projects/p 1/photo.jpg');
  });
});

describe('libraryEntryPathnames — копии кадров записи (§21, этап 27)', () => {
  it('собирает только свои копии, дубли схлопывает, чужое отбрасывает', () => {
    expect(
      libraryEntryPathnames('yt:abc', {
        characters: [
          { previewUrl: 'https://cdn/library/yt-abc/character-c1.jpg' },
          { previewUrl: null },
        ],
        scenes: [
          { previewUrl: 'https://cdn/library/yt-abc/scene-s1.jpg' },
          // кадр всё ещё в сессии (копия не удалась) — не наш файл
          { previewUrl: 'https://cdn/sessions/s1/previews/scene-s2.jpg' },
          // дубль
          { previewUrl: 'https://cdn/library/yt-abc/scene-s1.jpg' },
        ],
        extras: [{ previewUrl: 'https://cdn/library/OTHER/extra-e1.jpg' }],
      }),
    ).toEqual([
      'library/yt-abc/character-c1.jpg',
      'library/yt-abc/scene-s1.jpg',
    ]);
    expect(libraryEntryPathnames('sha256:zz', null)).toEqual([]);
  });
});
