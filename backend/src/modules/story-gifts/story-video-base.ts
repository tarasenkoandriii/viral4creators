/**
 * Р-ST-WP4-1. Registry of published base video packages (§23.7 «базовый
 * пакет»), keyed by the exact edition (`catalogId` = edition id) and bound to
 * its text hash. A revision is immutable: published bytes never change under
 * it, a new staging gets a new revision. Only packages whose assets are
 * actually published under `frontend/public/story-assets/<revision>/` may be
 * listed here — `story-video.spec.ts` verifies hashes and sizes against the
 * files. Music/effects stems are optional and absent in every current package.
 */
export type StoryVideoBaseScene = {
  readonly start: number;
  readonly end: number;
  readonly title: string;
};
export type StoryVideoBaseStem = {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
};
export type StoryVideoBaseManifest = {
  readonly revision: string;
  readonly catalogId: string;
  readonly locale: string;
  /** sha256 of the edition chapters joined by blank lines (story-editions). */
  readonly textSha256: string;
  readonly baseSha256: string;
  readonly baseBytes: number;
  readonly coverSha256: string;
  readonly coverBytes: number;
  readonly durationSeconds: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  /** The video track is always silent: speech is a separate per-family track. */
  readonly audioTracks: 0;
  readonly scenes: readonly StoryVideoBaseScene[];
  readonly rights: string;
  readonly tracks: {
    readonly video: 'base.mp4';
    readonly cover: 'cover.png';
    readonly music: StoryVideoBaseStem | null;
    readonly effects: StoryVideoBaseStem | null;
  };
};

/** «Репка», turnip-v1: values identical to the published manifest.json. */
const TURNIP_V1 = {
  revision: 'turnip-v1',
  catalogId: 'turnip-ushinsky-ru-1949-v1',
  locale: 'ru',
  textSha256:
    '39207ca8c60f88adf5cc9085cf2677fb82dd6da3c7ad41715ea17f7bf3cdaeb7',
  baseSha256:
    'a3a6ee4b67f9f33b5b665d5230316ffce3b98394bc434a500a2b4369e19e8b46',
  baseBytes: 653095,
  coverSha256:
    'e59074639e22abc408129e532d39a74bbc7cad4b4b2d897f788475a85ab17a0a',
  coverBytes: 62898,
  durationSeconds: 55.76,
  fps: 25,
  width: 1280,
  height: 720,
  audioTracks: 0,
  scenes: [
    { start: 0, end: 7, title: 'Посадил дед репку' },
    { start: 7, end: 15, title: 'Тянет-потянет…' },
    { start: 15, end: 23, title: 'Бабка за дедку' },
    { start: 23, end: 33, title: 'Внучка за бабку' },
    { start: 33, end: 45, title: 'Жучка и Машка на помощь' },
    { start: 45, end: 55.76, title: 'Мышка помогла — вытащили репку!' },
  ],
  rights: 'Own vector artwork, no third-party images, music or voice.',
  tracks: { video: 'base.mp4', cover: 'cover.png', music: null, effects: null },
} as const satisfies StoryVideoBaseManifest;

/** Published packages only. Order matters: the last revision of an edition wins. */
export const STORY_VIDEO_BASES: readonly StoryVideoBaseManifest[] = [TURNIP_V1];

/** Backward-compatible alias of the first pilot package (turnip-v1). */
export const STORY_VIDEO_BASE = TURNIP_V1;

/** Current package for an edition, or null when none is published yet. */
export function storyVideoBaseFor(
  catalogId: string,
): StoryVideoBaseManifest | null {
  return (
    STORY_VIDEO_BASES.filter((b) => b.catalogId === catalogId).at(-1) ?? null
  );
}

/** Exact revision pinned by an existing render (old renders never move). */
export function storyVideoBaseRevision(
  revision: string,
): StoryVideoBaseManifest | null {
  return STORY_VIDEO_BASES.find((b) => b.revision === revision) ?? null;
}
