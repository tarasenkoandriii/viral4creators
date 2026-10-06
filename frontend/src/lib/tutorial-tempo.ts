/**
 * Темп обучалок в постпродакшене (06.10.2026) — чистые правила экрана.
 *
 * Расчёт темпа живёт на СЕРВЕРЕ (`tutorial-tempo.ts` бэкенда): экран
 * спрашивает `GET /postprod/tutorials/:id/tempo?factor=…` и получает
 * итоговую длительность, предупреждения и кадры предпросмотра по той же
 * сетке, что уйдёт в платную сборку. Второго планировщика здесь нет —
 * разошёлся бы с экспортом. Здесь только то, что нужно экрану: пресеты,
 * шаг ползунка, формат длительности и разбор времени предпросмотра.
 *
 * Скорость речи не меняется никогда: предпросмотр — кадры и покадровые
 * реплики через WebAudio по расписанию, а не `playbackRate`.
 */

/** Множитель ПАУЗЫ (решение владельца): спокойнее ×1.5, быстрее ×0.4. */
export const TEMPO_PRESETS = {
  calm: 1.5,
  normal: 1,
  fast: 0.4,
} as const;

export type TempoPreset = keyof typeof TEMPO_PRESETS;
export const TEMPO_PRESET_ORDER: TempoPreset[] = ['calm', 'normal', 'fast'];

export const TEMPO_MIN = 0;
export const TEMPO_MAX = 2;
export const TEMPO_STEP = 0.05;

/** К шагу ползунка и в диапазон — то же правило, что у сервера. */
export function snapFactor(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  const clamped = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, raw));
  return Number((Math.round(clamped / TEMPO_STEP) * TEMPO_STEP).toFixed(2));
}

export function presetOf(factor: number): TempoPreset | null {
  return TEMPO_PRESET_ORDER.find((p) => TEMPO_PRESETS[p] === factor) ?? null;
}

/** 65 400 мс → «1:05»; меньше минуты — «0:42». */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export type TempoWarning =
  | { code: 'pauses-at-minimum'; frames: number }
  | { code: 'source-frame-too-short'; frameIndexes: number[] }
  | { code: 'speech-unmeasured'; frameIndexes: number[] }
  | { code: 'zoom-dropped' };

export type TempoUnavailableReason =
  | 'no-manifest'
  | 'whole-track'
  | 'sources-pending'
  | 'not-complete'
  | 'frames-purged';

export interface PreviewFrame {
  frameId: string;
  stepIndex: number;
  imageUrl: string;
  start: number;
  end: number;
  speech: { url: string; seconds: number | null } | null;
  caption: string | null;
  pointer: { x: number; y: number } | null;
}

export interface TempoPreview {
  frames: PreviewFrame[];
  durationMs: number;
  transitionSeconds: number;
  motion: 'none' | 'fade' | 'fade+zoom';
}

/**
 * Что показывать в момент `t` (секунды от начала): текущий кадр и,
 * во время перехода, следующий с долей проявления. Переход — последние
 * `transitionSeconds` ПЕРЕД началом следующего кадра по сетке сервера:
 * следующий кадр «начинается» там, где начинается переход к нему, — в
 * этот миг меняются подпись и реплика (так же устроен `xfade` сборки).
 */
export function previewAt(
  preview: TempoPreview,
  t: number
): { index: number; next: number | null; mix: number } {
  const frames = preview.frames;
  if (frames.length === 0) return { index: 0, next: null, mix: 0 };
  let index = frames.findIndex((f) => t >= f.start && t < f.end);
  if (index < 0) index = t < 0 ? 0 : frames.length - 1;
  const ts = preview.transitionSeconds;
  if (ts > 0 && index > 0) {
    // В первые `ts` секунд кадра предыдущий ещё растворяется.
    const into = t - frames[index].start;
    if (into < ts) {
      return { index: index - 1, next: index, mix: Math.max(0, into / ts) };
    }
  }
  return { index, next: null, mix: 0 };
}

/** Когда запускать каждую реплику: в начале её кадра (как в сборке). */
export function speechSchedule(
  preview: TempoPreview
): Array<{ url: string; at: number; frameId: string }> {
  return preview.frames
    .filter((f) => f.speech)
    .map((f) => ({ url: f.speech!.url, at: f.start, frameId: f.frameId }));
}

/** Подпись в момент `t` — подпись текущего кадра сетки (без перехода). */
export function captionAt(preview: TempoPreview, t: number): string | null {
  const f = preview.frames.find((x) => t >= x.start && t < x.end);
  return f?.caption ?? null;
}

/** Разница с исходной длительностью, в процентах (−35 → «на 35 % короче»). */
export function durationChangePercent(
  ms: number | null,
  sourceMs: number | null
): number | null {
  if (!ms || !sourceMs) return null;
  return Math.round(((ms - sourceMs) / sourceMs) * 100);
}
