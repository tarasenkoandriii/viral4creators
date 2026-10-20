import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { estimateCost } from '../../common/ai-pricing';
import { STORY_VIDEO_BASE } from './story-video-base';
import type {
  StorySegmentKind,
  StorySegmentVisual,
} from './story-video-segments';
export const storyDigest = (input: string | Uint8Array) =>
  createHash('sha256').update(input).digest('hex');
/** Main narration is not synthesized here. Reserve includes intro TTS, one render and one QA. */
export function storyVideoReserve(preamble: string, mainText = ''): number {
  const tts = estimateCost('resemble-tts', {
    characters: preamble.length + mainText.length,
  });
  const assembly = estimateCost('ffmpeg-api', {});
  if (tts.unpriced || assembly.unpriced)
    throw new Error('Story assembly rate unavailable');
  return Math.ceil(
    tts.costMicroUsd * 4 +
      Math.max(500000, assembly.costMicroUsd * 50) +
      STORY_VIDEO_QA_RESERVE_MICRO_USD,
  );
}
/** QA part of `storyVideoReserve` (one Soniox check of the export). */
export const STORY_VIDEO_QA_RESERVE_MICRO_USD = 20000;
/** Soniox price of the export check by its length; null — rate unavailable. */
export function storyVideoQaEstimate(seconds: number): number | null {
  const qa = estimateCost('soniox-stt-async', {
    seconds: Math.max(0, seconds),
  });
  return qa.unpriced ? null : qa.costMicroUsd;
}
/**
 * Speech-only part of `storyVideoReserve` (same 4× safety factor). A render
 * stopped before the provider submit keeps exactly this for the speech it
 * actually requested; the assembly and QA parts are released (A-S3-4).
 */
export function storyVideoTtsReserve(characters: number): number {
  if (characters <= 0) return 0;
  const tts = estimateCost('resemble-tts', { characters });
  if (tts.unpriced) throw new Error('Story assembly rate unavailable');
  return Math.ceil(tts.costMicroUsd * 4);
}
/**
 * Two-argument form is the original (version 1) key and stays byte-identical
 * for renders without extra segments, so old exports keep deduplicating.
 * `segments` is the stable segment descriptor (kinds, sources, cache keys)
 * and enters the hash only when the render differs from the legacy layout.
 */
export function storyVideoConfigHash(
  audioHash: string,
  preamble: string,
  segments?: unknown,
  baseSha256: string = STORY_VIDEO_BASE.baseSha256,
) {
  return storyDigest(
    JSON.stringify({
      version: 1,
      base: baseSha256,
      audioHash,
      preamble,
      ...(segments === undefined || segments === null ? {} : { segments }),
    }),
  );
}
/** Only fixed placeholders and finite server-validated durations enter the command. Never user text/URLs. */
export function planStoryVideo(
  mainSeconds: number,
  introSeconds: number,
  baseSeconds: number = STORY_VIDEO_BASE.durationSeconds,
) {
  if (
    !Number.isFinite(mainSeconds) ||
    mainSeconds < 40 ||
    mainSeconds > 90 ||
    !Number.isFinite(introSeconds) ||
    introSeconds < 1 ||
    introSeconds > 20 ||
    !Number.isFinite(baseSeconds) ||
    baseSeconds <= 0
  )
    throw new Error('Invalid story durations');
  const main = mainSeconds.toFixed(6),
    intro = introSeconds.toFixed(6);
  const factor = (mainSeconds / baseSeconds).toFixed(8);
  return {
    durationSeconds: mainSeconds + introSeconds,
    outputs: ['story.mp4'],
    commands: [
      `ffmpeg -i {{base}} -i {{main}} -loop 1 -framerate 25 -i {{cover}} -i {{intro}} -filter_complex "[2:v]scale=1280:720,setsar=1,fps=25,trim=duration=${intro},setpts=PTS-STARTPTS[iv];[3:a]aresample=48000,apad,atrim=duration=${intro},asetpts=PTS-STARTPTS[ia];[0:v]setpts=${factor}*(PTS-STARTPTS),fps=25,trim=duration=${main},scale=1280:720,setsar=1[v];[1:a]aresample=48000,apad,atrim=duration=${main},asetpts=PTS-STARTPTS[a];[iv][ia][v][a]concat=n=2:v=1:a=1[outv][outa]" -map "[outv]" -map "[outa]" -c:v libx264 -preset veryfast -crf 25 -pix_fmt yuv420p -c:a aac -b:a 128k -ar 48000 -movflags +faststart -t ${(mainSeconds + introSeconds).toFixed(6)} {{story.mp4}}`,
    ],
  };
}

/** A whole export must stay within the legacy maximum (90 s story + 20 s intro): 3 MiB MP4 cap. */
export const STORY_VIDEO_MAX_SECONDS = 110;
/** Short personal segment bounds (intro, gift note, outro). */
export const STORY_SEGMENT_MIN_SECONDS = 1;
export const STORY_SEGMENT_MAX_SECONDS = 20;
export type StoryPlanSegment = {
  kind: StorySegmentKind;
  position?: 'beginning' | 'end';
  seconds: number;
  visual: StorySegmentVisual;
  /** Adult's own recording: EBU R128 loudness normalisation in the graph. */
  normalize?: boolean;
};
export type StoryPlanStem = { volume: number };
/** Input placeholder → private render-input part served by the backend. */
export type StoryPlanInputs = Record<string, string>;
const FIT_PAD =
  'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x102b35,setsar=1';
const VISUAL_SCALE: Record<'cover' | 'photo' | 'narrator', string> = {
  cover: 'scale=1280:720,setsar=1',
  photo: FIT_PAD,
  // A portrait narrator photo/sketch is letterboxed, never cropped or stretched.
  narrator: FIT_PAD,
};
const ORDER: Record<string, number> = {
  intro: 0,
  'gift_note:beginning': 1,
  main: 2,
  'gift_note:end': 3,
  outro: 4,
};
/**
 * Р-ST-WP4-3. Segment assembly with separate speech/music/effects tracks.
 * The legacy layout (synthesized intro + main, no stems) returns exactly the
 * live-verified `planStoryVideo` command. Otherwise every speech segment is
 * normalised to 48 kHz mono, own recordings get `loudnorm`, music is looped,
 * attenuated and ducked under speech (sidechaincompress), effects are
 * attenuated; speech stays at unity gain (`amix … normalize=0`).
 */
export function planStorySegments(input: {
  segments: StoryPlanSegment[];
  baseSeconds: number;
  music?: StoryPlanStem | null;
  effects?: StoryPlanStem | null;
  ducking?: {
    threshold: number;
    ratio: number;
    attackMs: number;
    releaseMs: number;
  };
}) {
  const segs = input.segments;
  const keys = segs.map((s) =>
    s.kind === 'gift_note' ? `gift_note:${s.position ?? ''}` : s.kind,
  );
  const ordered = keys.every(
    (k, i) => k in ORDER && (i === 0 || ORDER[keys[i - 1]] < ORDER[k]),
  );
  const main = segs.find((s) => s.kind === 'main');
  const intro = segs[0];
  if (
    !ordered ||
    !main ||
    intro?.kind !== 'intro' ||
    segs.filter((s) => s.kind === 'gift_note').length > 1 ||
    segs.some(
      (s) =>
        !Number.isFinite(s.seconds) ||
        (s.kind === 'main'
          ? s.seconds < 40 || s.seconds > 90
          : s.seconds < STORY_SEGMENT_MIN_SECONDS ||
            s.seconds > STORY_SEGMENT_MAX_SECONDS) ||
        (s.kind === 'main') !== (s.visual === 'base') ||
        (s.visual === 'photo' && s.kind !== 'gift_note') ||
        (s.visual === 'narrator' && s.kind !== 'intro') ||
        (s.normalize && s.kind !== 'intro'),
    ) ||
    [input.music, input.effects].some(
      (t) => t && (!Number.isFinite(t.volume) || t.volume < 0 || t.volume > 1),
    ) ||
    !Number.isFinite(input.baseSeconds) ||
    input.baseSeconds <= 0
  )
    throw new Error('Invalid story segments');
  const total = segs.reduce((n, s) => n + s.seconds, 0);
  if (total > STORY_VIDEO_MAX_SECONDS) throw new Error('Story video too long');
  const legacy =
    segs.length === 2 &&
    !intro.normalize &&
    intro.visual === 'cover' &&
    !input.music &&
    !input.effects;
  const inputs: StoryPlanInputs = {
    base: 'base',
    main: 'main',
    cover: 'cover',
    intro: 'intro',
  };
  if (legacy) {
    return {
      ...planStoryVideo(main.seconds, intro.seconds, input.baseSeconds),
      inputs,
      legacy: true,
    };
  }
  const f = (n: number) => n.toFixed(6);
  // The intro still is the cover, or the profile narrator image (WP5).
  const introVisual = intro.visual === 'narrator' ? 'narrator' : 'cover';
  if (introVisual === 'narrator') {
    delete inputs.cover;
    inputs.narrator = 'narrator';
  }
  const args = [
    '-i {{base}}',
    '-i {{main}}',
    `-loop 1 -framerate 25 -i {{${introVisual}}}`,
    '-i {{intro}}',
  ];
  let next = 4;
  const audio = (idx: number, label: string, d: number, normalize = false) =>
    `[${idx}:a]${normalize ? 'loudnorm=I=-16:TP=-1.5:LRA=11,' : ''}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,apad,atrim=duration=${f(d)},asetpts=PTS-STARTPTS[${label}]`;
  const still = (
    idx: number,
    visual: 'cover' | 'photo' | 'narrator',
    label: string,
    d: number,
  ) =>
    `[${idx}:v]${VISUAL_SCALE[visual]},fps=25,trim=duration=${f(d)},setpts=PTS-STARTPTS[${label}]`;
  const filters: string[] = [];
  const concat: string[] = [];
  for (const s of segs) {
    if (s.kind === 'intro') {
      filters.push(still(2, introVisual, 'iv', s.seconds));
      filters.push(audio(3, 'ia', s.seconds, s.normalize));
      concat.push('[iv][ia]');
    } else if (s.kind === 'main') {
      const factor = (s.seconds / input.baseSeconds).toFixed(8);
      filters.push(
        `[0:v]setpts=${factor}*(PTS-STARTPTS),fps=25,trim=duration=${f(s.seconds)},scale=1280:720,setsar=1[v]`,
      );
      filters.push(audio(1, 'a', s.seconds));
      concat.push('[v][a]');
    } else {
      const name = s.kind === 'gift_note' ? 'note' : 'outro';
      const tag = s.kind === 'gift_note' ? 'g' : 'o';
      const visual = s.visual === 'photo' ? 'photo' : 'cover';
      args.push(
        `-loop 1 -framerate 25 -i {{${name}_visual}}`,
        `-i {{${name}}}`,
      );
      inputs[`${name}_visual`] = visual;
      inputs[name] = name;
      filters.push(still(next, visual, `${tag}v`, s.seconds));
      filters.push(audio(next + 1, `${tag}a`, s.seconds));
      concat.push(`[${tag}v][${tag}a]`);
      next += 2;
    }
  }
  const stems = !!(input.music || input.effects);
  filters.push(
    `${concat.join('')}concat=n=${segs.length}:v=1:a=1[outv][${stems ? 'speech' : 'outa'}]`,
  );
  if (stems) {
    const mix: string[] = [];
    const duck = input.music && input.ducking;
    if (duck) {
      filters.push('[speech]asplit=2[sp][sc]');
      mix.push('[sp]');
    } else mix.push('[speech]');
    if (input.music) {
      args.push('-stream_loop -1 -i {{music}}');
      inputs.music = 'music';
      filters.push(
        `[${next}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,volume=${input.music.volume.toFixed(3)},atrim=duration=${f(total)},asetpts=PTS-STARTPTS[mus]`,
      );
      if (duck) {
        const d = input.ducking!;
        filters.push(
          `[mus][sc]sidechaincompress=threshold=${d.threshold}:ratio=${d.ratio}:attack=${d.attackMs}:release=${d.releaseMs}[musd]`,
        );
        mix.push('[musd]');
      } else mix.push('[mus]');
      next++;
    }
    if (input.effects) {
      args.push('-i {{effects}}');
      inputs.effects = 'effects';
      filters.push(
        `[${next}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,volume=${input.effects.volume.toFixed(3)},apad,atrim=duration=${f(total)},asetpts=PTS-STARTPTS[sfx]`,
      );
      mix.push('[sfx]');
      next++;
    }
    filters.push(
      `${mix.join('')}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0[outa]`,
    );
  }
  return {
    durationSeconds: total,
    outputs: ['story.mp4'],
    inputs,
    legacy: false,
    commands: [
      `ffmpeg ${args.join(' ')} -filter_complex "${filters.join(';')}" -map "[outv]" -map "[outa]" -c:v libx264 -preset veryfast -crf 25 -pix_fmt yuv420p -c:a aac -b:a 128k -ar 48000 -movflags +faststart -t ${f(total)} {{story.mp4}}`,
    ],
  };
}

/** Versioned, per-export authorization; clone creation consent is independently required. */
export const STORY_PARENT_CONSENT_VERSION = 'story-parent-voice-v1';
export const STORY_PARENT_CONSENT_TEXT =
  'Подтверждаю: это мой голос либо у меня есть явное разрешение его владельца. Разрешаю использовать выбранный клон для отдельной озвучки текста «Репки» и преамбулы через Resemble; сборку видео через FFmpeg API и проверку речи через Soniox. Получатели ссылки смогут услышать голос после моего одобрения видео.';
/** ST-P1: the adult's own recorded preamble (no cloning, no TTS). */
export const STORY_RECORDING_CONSENT_VERSION = 'story-preamble-recording-v1';
export const STORY_RECORDING_CONSENT_TEXT =
  'Подтверждаю: на записи мой голос либо у меня есть явное разрешение человека, который говорит. Запись хранится приватно в этом подарке и используется только как вступление этой сказки: для сборки видео она передаётся во временной ссылке в FFmpeg API, для проверки речи готового видео — в Soniox. Голос не клонируется. Получатели услышат запись только после моего отдельного одобрения видео.';
export type StoryVoiceChoice = {
  narratorManifestId?: string;
  voiceConsentVersion?: string;
  voiceConsentAccepted?: boolean;
};
/** Full create/quote input: voice choice plus WP4 segment options. */
export type StoryVideoInput = StoryVoiceChoice & {
  preambleSource?: 'synth' | 'recorded';
  recordingId?: string;
  outroText?: string;
  pronunciations?: { written: string; spoken: string }[];
  /** WP5↔WP4: intro frame = profile narrator image (needs a profile voice). */
  useNarratorImage?: boolean;
  /** ST3-S-12: confirmed price; not part of the configuration hash. */
  expectedCredits?: number;
};
/**
 * Public API base (`API_PUBLIC_URL`, https only, trailing `/api/`): render
 * inputs for the provider and public gift links (ST3).
 */
export function storyPublicApiBase() {
  const u = new URL(
    process.env.API_PUBLIC_URL ||
      'https://backend-iota-ruddy-57.vercel.app/api',
  );
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
    throw new ServiceUnavailableException('Публичный адрес сборки не настроен');
  u.pathname =
    u.pathname === '/' ? '/api/' : `${u.pathname.replace(/\/$/, '')}/`;
  return u.toString();
}
/**
 * ТЗ §11.1: a release is narrated not only by Nova — a voice clone, the
 * adult's own recorded intro or a narrator image. Publishing such a release
 * by link needs the narrator's consent to that distribution.
 */
export function storyRenderNeedsPublicConsent(r: {
  userVoiceId?: string | null;
  segments?: unknown;
}): boolean {
  if (r.userVoiceId) return true;
  const m = r.segments as {
    segments?: Array<{ source?: string } | null>;
    narrator?: unknown;
  } | null;
  if (!m || typeof m !== 'object') return false;
  return (
    !!m.narrator ||
    (Array.isArray(m.segments) &&
      m.segments.some((s) => s?.source === 'recorded'))
  );
}
/**
 * ST3-S-08/S-09: a TTS outcome that certainly cost nothing — the provider
 * was never called (`skipped`: no key, empty text, no voice) or answered a
 * final HTTP 4xx (rejected request, not billed). Everything else — 5xx,
 * timeouts, a broken body, a result failing our checks — stays uncertain
 * (UNKNOWN, operator; automatic refund after 14 days).
 */
export function storyTtsUnbilled(outcome: {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
}): boolean {
  if (outcome.ok) return false;
  if (outcome.skipped) return true;
  return /^Resemble 4\d\d$/.test(outcome.reason ?? '');
}
