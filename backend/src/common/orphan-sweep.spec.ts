import {
  orphanSweepPlan,
  ownerIdOf,
  sessionIdOf,
  sweepFileKind,
} from './orphan-sweep';

const NOW = new Date('2026-09-06T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const blob = (pathname: string, ageMs: number) => ({
  pathname,
  uploadedAt: new Date(NOW.getTime() - ageMs),
});

describe('sessionIdOf', () => {
  it('достаёт id из пути сессии и отвергает всё остальное', () => {
    expect(sessionIdOf('sessions/abc/generated.mp4')).toBe('abc');
    expect(sessionIdOf('sessions/abc/previews/scene-s1.jpg')).toBe('abc');
    expect(sessionIdOf('sessions/abc')).toBeNull();
    expect(sessionIdOf('projects/p1/items/i1/photo.jpg')).toBeNull();
    expect(sessionIdOf('library/yt-abc/scene-s1.jpg')).toBeNull();
  });
});

describe('orphanSweepPlan (doc/STORAGE-AUDIT.md, этап 27)', () => {
  it('удаляет только файлы сессий, которых нет в базе', () => {
    const plan = orphanSweepPlan(
      [
        blob('sessions/live/generated.mp4', 3 * DAY),
        blob('sessions/dead/generated.mp4', 3 * DAY),
        blob('sessions/dead/previews/scene-s1.jpg', 3 * DAY),
      ],
      ['live'],
      NOW,
      DAY,
    );
    expect(plan.delete).toEqual([
      'sessions/dead/generated.mp4',
      'sessions/dead/previews/scene-s1.jpg',
    ]);
    expect(plan.ownerIds).toEqual(['live', 'dead']);
    // детальная статистика (этап 29)
    expect(plan.orphanOwners).toBe(1);
    expect(plan.byKind).toMatchObject({ generated: 1, previews: 1 });
    expect(plan.oldestUploadedAt).toBe(
      new Date(NOW.getTime() - 3 * DAY).toISOString(),
    );
  });

  it('раскладывает удаляемое по видам файлов', () => {
    expect(sweepFileKind('sessions/a/generated.mp4')).toBe('generated');
    expect(sweepFileKind('sessions/a/original.mp4')).toBe('original');
    expect(sweepFileKind('sessions/a/previews/scene-s1.jpg')).toBe('previews');
    expect(sweepFileKind('sessions/a/characters/c1/photo.jpg')).toBe(
      'characters',
    );
    expect(sweepFileKind('sessions/a/scenes/sc_a/photo.png')).toBe('scenes');
    expect(sweepFileKind('sessions/a/что-то.bin')).toBe('other');
  });

  it('свежий файл не трогает — страховка от гонки с новой сессией', () => {
    const plan = orphanSweepPlan(
      [blob('sessions/new/original.mp4', 60 * 1000)],
      [],
      NOW,
      DAY,
    );
    expect(plan.delete).toEqual([]);
    expect(plan.skippedTooNew).toBe(1);
  });

  it('непонятные пути считает и не трогает', () => {
    const plan = orphanSweepPlan(
      [
        blob('library/yt-abc/scene-s1.jpg', 10 * DAY),
        blob('sessions/', 10 * DAY),
      ],
      [],
      NOW,
      DAY,
    );
    expect(plan.delete).toEqual([]);
    expect(plan.skippedUnknown).toBe(2);
  });

  it('пустой листинг — пустой план', () => {
    expect(orphanSweepPlan([], [], NOW, DAY)).toMatchObject({
      delete: [],
      ownerIds: [],
      skippedTooNew: 0,
      skippedUnknown: 0,
      orphanOwners: 0,
      oldestUploadedAt: null,
    });
  });
});

/**
 * Этап 41 (Б-1.1, Б-1.2): метла ходит по четырём префиксам.
 *
 * Каскад `users → projects/brand_manifests` (этап 40) сносит строки в
 * обход сервисов с их уборкой блобов — и после него найти эти файлы
 * больше нечем. Копия ролика заявки удалялась только при отзыве PENDING.
 */
describe('orphanSweepPlan по областям (этап 41)', () => {
  it('владелец достаётся из пути каждой области', () => {
    expect(ownerIdOf('projects/p1/items/i1/photo.jpg', 'projects')).toBe('p1');
    expect(
      ownerIdOf('brand-manifests/bm1/characters/c1.jpg', 'brand-manifests'),
    ).toBe('bm1');
    expect(ownerIdOf('publications/pr1/video.mp4', 'publications')).toBe('pr1');
    expect(ownerIdOf('shared-videos/sv1/video.mp4', 'shared-videos')).toBe(
      'sv1',
    );
    // Чужой префикс в своей области не разбирается — не удалим лишнего.
    expect(ownerIdOf('sessions/s1/generated.mp4', 'projects')).toBeNull();
    expect(ownerIdOf('projects/p1/items/i1/photo.jpg', 'sessions')).toBeNull();
  });

  it('файлы удалённого проекта — сироты, файлы живого не трогаются', () => {
    // Фото товара и надиктованное описание: имена голосовых записей в
    // базе не хранятся вовсе, поэтому найти их можно только так.
    const plan = orphanSweepPlan(
      [
        blob('projects/live/items/i1/photo.jpg', 3 * DAY),
        blob('projects/dead/items/i1/photo.jpg', 3 * DAY),
        blob('projects/dead/items/i1/voice-1757000000000.webm', 3 * DAY),
      ],
      ['live'],
      NOW,
      DAY,
      'projects',
    );
    expect(plan.delete).toEqual([
      'projects/dead/items/i1/photo.jpg',
      'projects/dead/items/i1/voice-1757000000000.webm',
    ]);
    expect(plan.byKind).toMatchObject({ photo: 1, voice: 1 });
    expect(plan.orphanOwners).toBe(1);
  });

  it('персонажи и сцены удалённого манифеста', () => {
    const plan = orphanSweepPlan(
      [
        blob('brand-manifests/dead/characters/c1.jpg', 3 * DAY),
        blob('brand-manifests/dead/scenes/sc1.png', 3 * DAY),
      ],
      [],
      NOW,
      DAY,
      'brand-manifests',
    );
    expect(plan.delete).toHaveLength(2);
    expect(plan.byKind).toMatchObject({ characters: 1, scenes: 1 });
  });

  it('копия ролика заявки, которой больше нет', () => {
    const plan = orphanSweepPlan(
      [
        blob('publications/gone/video.mp4', 3 * DAY),
        blob('publications/open/video.mp4', 3 * DAY),
      ],
      ['open'],
      NOW,
      DAY,
      'publications',
    );
    expect(plan.delete).toEqual(['publications/gone/video.mp4']);
    expect(plan.byKind).toMatchObject({ video: 1 });
  });

  it('этап 60: собственные копии удалённой страницы шеринга (видео + фото товара)', () => {
    const plan = orphanSweepPlan(
      [
        blob('shared-videos/gone/video.mp4', 3 * DAY),
        blob('shared-videos/gone/photo.jpg', 3 * DAY),
        blob('shared-videos/open/video.mp4', 3 * DAY),
      ],
      ['open'],
      NOW,
      DAY,
      'shared-videos',
    );
    expect(plan.delete).toEqual([
      'shared-videos/gone/video.mp4',
      'shared-videos/gone/photo.jpg',
    ]);
    expect(plan.byKind).toMatchObject({ video: 1, photo: 1 });
  });

  it('порог свежести действует во всех областях одинаково', () => {
    const plan = orphanSweepPlan(
      [blob('projects/new/items/i1/photo.jpg', 60 * 1000)],
      [],
      NOW,
      DAY,
      'projects',
    );
    expect(plan.delete).toEqual([]);
    expect(plan.skippedTooNew).toBe(1);
  });

  it('Е-5.2 шестого аудита, этап 76: сэмпл незавершённого клонирования голоса под users/ — сирота, если владелец (пользователь) удалён', () => {
    expect(ownerIdOf('users/u1/voices/v1/sample.webm', 'users')).toBe('u1');
    expect(sweepFileKind('users/u1/voices/v1/sample.webm', 'users')).toBe(
      'voice',
    );
    const plan = orphanSweepPlan(
      [
        blob('users/dead/voices/v1/sample.webm', 3 * DAY),
        blob('users/live/voices/v2/sample.webm', 3 * DAY),
      ],
      ['live'],
      NOW,
      DAY,
      'users',
    );
    expect(plan.delete).toEqual(['users/dead/voices/v1/sample.webm']);
    expect(plan.byKind).toMatchObject({ voice: 1 });
  });
});
