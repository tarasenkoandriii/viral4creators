import { createHash } from 'node:crypto';
import type { StoryVideoBaseScene } from './story-video-base';

/**
 * Р-ST-WP4-2. Segment manifest of one family video (§23.7): an ordered list
 * [intro, gift_note(beginning)?, main, gift_note(end)?, outro?], each with its
 * own speech source. Pure functions only: no network, no database.
 */
export type StorySegmentKind = 'intro' | 'gift_note' | 'main' | 'outro';
/** synth — TTS segment (segment cache); recorded — adult's own recording;
 *  gift — pinned Nova main narration of the gift; parent — main narration of
 *  the selected own clone (reused by `parentNarrationKey`). */
export type StorySegmentSource = 'synth' | 'recorded' | 'gift' | 'parent';
/** narrator — the profile narrator image (WP5) as the static intro frame. */
export type StorySegmentVisual = 'cover' | 'base' | 'photo' | 'narrator';
export type StoryManifestSegment = {
  kind: StorySegmentKind;
  position?: 'beginning' | 'end';
  source: StorySegmentSource;
  /** Exactly what subtitles and the speech QA use (never the respelling). */
  text: string;
  /** What TTS receives, only when pronunciations changed it. */
  ttsText?: string;
  /** Written forms whose respelling was applied to `ttsText`. */
  pronunciations?: string[];
  /** Segment-cache key (synth/recorded), main audio hash or narration key. */
  cacheKey: string;
  voiceId: string | null;
  visual: StorySegmentVisual;
  mime: 'audio/mpeg' | 'audio/wav';
  audioHash: string | null;
  seconds: number | null;
  /** Legacy Nova gifts: the gift note is inside the main narration. */
  includes?: 'gift_note'[];
};
export type StoryTrackRef = { file: string; sha256: string; volume: number };
export type StoryVideoLayout = {
  durationSeconds: number;
  /** Video tempo factor of the base master (main speech / base length). */
  speedFactor: number;
  segments: {
    kind: StorySegmentKind;
    position?: 'beginning' | 'end';
    start: number;
    end: number;
  }[];
  scenes: { title: string; start: number; end: number }[];
};
export type StoryVideoSegmentsManifest = {
  version: 1;
  baseRevision: string;
  baseHash: string;
  segments: StoryManifestSegment[];
  /** Separate tracks: speech is never mixed irreversibly with stems. */
  tracks: {
    speech: string[];
    music: StoryTrackRef[];
    effects: StoryTrackRef[];
  };
  mix: typeof STORY_VIDEO_MIX;
  layout: StoryVideoLayout | null;
  /** WP5↔WP4: the narrator image pinned for the intro frame (no bytes). */
  narrator?: StoryNarratorImageSnapshot;
};
/** Snapshot of `NarratorLooksService.resolveNarratorImage` at render time. */
export type StoryNarratorImageSnapshot = {
  manifestId: string;
  characterId: string;
  kind: 'original' | 'variant';
  lookId: string | null;
  asset: string;
  assetHash: string;
  style: string;
  sketchRendering: string | null;
  consentVersion: string | null;
  mimeType: string;
  bytes: number;
};
/** Default mix for future stems; speech stays at unity gain. */
export const STORY_VIDEO_MIX = {
  speech: 1,
  music: 0.25,
  effects: 0.5,
  ducking: { threshold: 0.03, ratio: 8, attackMs: 20, releaseMs: 400 },
} as const;

const sha = (v: string | Uint8Array) =>
  createHash('sha256').update(v).digest('hex');

/** ST-P2 segment cache key: text actually spoken, voice and consent snapshot. */
export function storySegmentKey(input: {
  text: string;
  voiceId: string;
  userVoiceId: string | null;
  consent: string;
  language: string;
}) {
  return sha(
    JSON.stringify({
      v: 1,
      text: input.text,
      voiceId: input.voiceId,
      userVoiceId: input.userVoiceId,
      consent: input.consent,
      language: input.language,
    }),
  );
}
export function storyRecordingKey(audioSha256: string) {
  return sha(`recorded:v1:${audioSha256}`);
}
/** Edition text hash as pinned by story-editions and the base package. */
export function storyChaptersSha256(chapters: unknown): string | null {
  if (!Array.isArray(chapters) || !chapters.length) return null;
  const texts = chapters.map((c) =>
    c &&
    typeof c === 'object' &&
    typeof (c as { text?: unknown }).text === 'string'
      ? (c as { text: string }).text
      : null,
  );
  if (texts.some((t) => t === null)) return null;
  return sha(texts.join('\n\n'));
}

// ── ST-P2 pronunciations ────────────────────────────────────────────────
export const STORY_PRONUNCIATION_MAX = 5;
export const STORY_PRONUNCIATION_CHARS = 40;
export type StoryPronunciation = { written: string; spoken: string };
/**
 * Drops lone UTF-16 surrogates (a broken emoji half from a client). They are
 * not valid text: PostgreSQL rejects them and TTS would read garbage. Paired
 * surrogates (real emoji) are code points and stay untouched.
 */
export function stripStoryLoneSurrogates(value: string): string {
  return value.replace(/\p{Cs}/gu, '');
}
const clean = (v: unknown) =>
  typeof v === 'string'
    ? stripStoryLoneSurrogates(v).normalize('NFC').replace(/\s+/g, ' ').trim()
    : '';
/** Comparison form of a respelling: case, stress marks, «+», hyphens, apostrophes and «ё» folded. */
export function foldStoryPronunciation(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[+\-'’ʼ\s.]/g, '')
    .normalize('NFC');
}
function levenshtein(a: string, b: string): number {
  const x = [...a],
    y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++)
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[y.length];
}
/**
 * A respelling must sound like the written word (stress, a letter or two),
 * never be another word: after folding, the edit distance is at most 40% of
 * the longer form, or the two share a prefix of at least half the written
 * form; the spoken form is at most 1.5× (+1) the written length.
 */
export function storyPronunciationClose(written: string, spoken: string) {
  const w = [...foldStoryPronunciation(written)],
    s = [...foldStoryPronunciation(spoken)];
  if (!w.length || !s.length) return false;
  // Not a longer phrase glued to the word ("вернусь" → "вернусь-завтра").
  if (s.length > Math.ceil(w.length * 1.5) + 1) return false;
  if (levenshtein(w.join(''), s.join('')) <= 0.4 * Math.max(w.length, s.length))
    return true;
  let prefix = 0;
  while (prefix < Math.min(w.length, s.length) && w[prefix] === s[prefix])
    prefix++;
  return prefix >= Math.ceil(w.length / 2);
}
/** Throws Error(message for the adult) on invalid input. */
export function parseStoryPronunciations(raw: unknown): StoryPronunciation[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > STORY_PRONUNCIATION_MAX)
    throw new Error(
      `Произношение: не больше ${STORY_PRONUNCIATION_MAX} пар «как написано → как произнести»`,
    );
  const seen = new Set<string>();
  return raw.map((item) => {
    const written = clean((item as StoryPronunciation | null)?.written);
    const spoken = clean((item as StoryPronunciation | null)?.spoken);
    if (
      !written ||
      !spoken ||
      written.length > STORY_PRONUNCIATION_CHARS ||
      spoken.length > STORY_PRONUNCIATION_CHARS
    )
      throw new Error(
        `Произношение: обе части от 1 до ${STORY_PRONUNCIATION_CHARS} символов`,
      );
    if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N} '’ʼ.-]*$/u.test(written))
      throw new Error('Произношение: «как написано» — слово или имя из текста');
    // Respelling only: letters, stress marks, apostrophe, hyphen, space, «+».
    // No digits/punctuation, so it cannot smuggle a sentence past subtitles.
    if (!/^[\p{L}\p{M} '’ʼ+-]+$/u.test(spoken))
      throw new Error(
        'Произношение: «как произнести» — только буквы, ударение, дефис и апостроф',
      );
    // One word, close to the written form: a respelling, not a new phrase.
    if (/\s/u.test(spoken))
      throw new Error(
        'Произношение: «как произнести» — одно слово без пробелов',
      );
    if (!storyPronunciationClose(written, spoken))
      throw new Error(
        `Произношение: «${spoken}» не похоже на «${written}». Укажите то же слово с ударением («+») или уточнёнными буквами, а не другое слово`,
      );
    const key = written.toLocaleLowerCase();
    if (seen.has(key))
      throw new Error('Произношение: каждое слово указывается один раз');
    seen.add(key);
    return { written, spoken };
  });
}
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-word, case-insensitive respelling for TTS only. */
export function applyStoryPronunciations(
  text: string,
  list: readonly StoryPronunciation[],
): { text: string; applied: string[] } {
  if (!list.length) return { text, applied: [] };
  const sorted = [...list].sort((a, b) => b.written.length - a.written.length);
  const map = new Map(sorted.map((p) => [p.written.toLocaleLowerCase(), p]));
  const rx = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${sorted.map((p) => escapeRx(p.written)).join('|')})(?![\\p{L}\\p{N}])`,
    'giu',
  );
  const applied = new Set<string>();
  const out = text.replace(rx, (m) => {
    const p = map.get(m.toLocaleLowerCase());
    if (!p) return m;
    applied.add(p.written);
    return p.spoken;
  });
  return {
    text: out,
    applied: list.map((p) => p.written).filter((w) => applied.has(w)),
  };
}

// ── Layout: base scene timecodes + segment durations ───────────────────
export function storyVideoLayout(
  segments: {
    kind: StorySegmentKind;
    position?: 'beginning' | 'end';
    seconds: number;
  }[],
  base: { durationSeconds: number; scenes: readonly StoryVideoBaseScene[] },
): StoryVideoLayout {
  let t = 0;
  const placed = segments.map((s) => {
    const start = t;
    t += s.seconds;
    return {
      kind: s.kind,
      ...(s.position ? { position: s.position } : {}),
      start: round(start),
      end: round(t),
    };
  });
  const main = placed.find((s) => s.kind === 'main');
  const mainSeconds = segments.find((s) => s.kind === 'main')?.seconds ?? 0;
  const factor = mainSeconds / base.durationSeconds;
  return {
    durationSeconds: round(t),
    speedFactor: Number(factor.toFixed(8)),
    segments: placed,
    scenes: main
      ? base.scenes.map((s) => ({
          title: s.title,
          start: round(main.start + s.start * factor),
          end: round(Math.min(main.end, main.start + s.end * factor)),
        }))
      : [],
  };
}
const round = (n: number) => Math.round(n * 1000) / 1000;

// ── WebVTT without paid STT: sentences, proportional timing ────────────
export function storySentences(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split(/\n+/)
    .flatMap((line) => line.match(/[^.!?…]+(?:[.!?…]+["»”)]*|$)/gu) ?? [])
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}
/** Wrap into lines ≤ max chars and cues of ≤ 2 lines. */
export function storyCueChunks(sentence: string, max = 42): string[][] {
  const lines: string[] = [];
  let line = '';
  for (const word of sentence.split(' ')) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  const cues: string[][] = [];
  for (let i = 0; i < lines.length; i += 2) cues.push(lines.slice(i, i + 2));
  return cues;
}
const weight = (s: string) =>
  Math.max(1, (s.match(/[\p{L}\p{N}]/gu) ?? []).length);
const vttTime = (sec: number) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000),
    m = Math.floor((ms % 3600000) / 60000),
    s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
const vttEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export type StoryCue = { start: number; end: number; lines: string[] };
export function storyCues(
  items: { text: string; start: number; end: number }[],
): StoryCue[] {
  const cues: StoryCue[] = [];
  for (const item of items) {
    const chunks = storySentences(item.text).flatMap((s) => storyCueChunks(s));
    const total = chunks.reduce((n, c) => n + weight(c.join(' ')), 0);
    let t = item.start;
    for (const chunk of chunks) {
      const d = ((item.end - item.start) * weight(chunk.join(' '))) / total;
      cues.push({ start: round(t), end: round(t + d), lines: chunk });
      t += d;
    }
  }
  return cues;
}
export function buildStoryVtt(
  items: { text: string; start: number; end: number }[],
): string {
  const body = storyCues(items)
    .map(
      (c, i) =>
        `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.lines.map(vttEscape).join('\n')}`,
    )
    .join('\n\n');
  return `WEBVTT\n\n${body}${body ? '\n' : ''}`;
}

// ── ST-P1 own recorded preamble: WAV PCM16 mono only ───────────────────
export const STORY_RECORDING_MAX_BYTES = 1_000_000;
export const STORY_RECORDING_MIN_SECONDS = 1;
export const STORY_RECORDING_MAX_SECONDS = 20;
/**
 * The client decodes its MediaRecorder file and re-encodes canonical WAV
 * (frontend lib/wav.ts): the duration is in the header, not guessed from a
 * webm. Returns null for anything else, including truncated chunks.
 */
export function parseStoryWav(
  bytes: Uint8Array,
): { sampleRate: number; seconds: number; rms: number; peak: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    b.length < 44 ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.toString('ascii', 8, 12) !== 'WAVE'
  )
    return null;
  let fmt: { rate: number } | null = null;
  let data: { start: number; size: number } | null = null;
  for (let pos = 12, chunks = 0; pos + 8 <= b.length; chunks++) {
    if (chunks > 64) return null;
    const id = b.toString('ascii', pos, pos + 4),
      size = b.readUInt32LE(pos + 4),
      start = pos + 8;
    if (start + size > b.length) return null;
    if (id === 'fmt ') {
      if (size < 16) return null;
      const format = b.readUInt16LE(start),
        channels = b.readUInt16LE(start + 2),
        rate = b.readUInt32LE(start + 4),
        align = b.readUInt16LE(start + 12),
        bits = b.readUInt16LE(start + 14);
      if (
        format !== 1 ||
        channels !== 1 ||
        bits !== 16 ||
        align !== 2 ||
        rate < 16000 ||
        rate > 48000
      )
        return null;
      fmt = { rate };
    } else if (id === 'data') {
      data = { start, size: size - (size % 2) };
      break;
    }
    pos = start + size + (size % 2);
  }
  if (!fmt || !data || !data.size) return null;
  let sum = 0,
    peak = 0;
  const n = data.size / 2;
  for (let i = 0; i < n; i++) {
    const v = b.readInt16LE(data.start + i * 2) / 32768;
    sum += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  return {
    sampleRate: fmt.rate,
    seconds: n / fmt.rate,
    rms: Math.sqrt(sum / n),
    peak,
  };
}
