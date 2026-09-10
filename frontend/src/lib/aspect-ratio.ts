/**
 * Picture format helpers (spec §16) — client side of
 * backend/src/common/aspect-ratio.ts. Same standard list, same snapping.
 */

export const STANDARD_ASPECT_RATIOS = [
  { value: '9:16', label: '9:16', subKey: 'shortsReels' },
  { value: '16:9', label: '16:9', subKey: 'youtube' },
  { value: '3:4', label: '3:4', subKey: 'portrait' },
  { value: '4:3', label: '4:3', subKey: 'classic' },
  { value: '1:1', label: '1:1', subKey: 'square' },
  { value: '4:5', label: '4:5', subKey: 'feedIg' },
] as const;

export const VEO_NATIVE = ['16:9', '9:16'];

const PATTERN = /^(\d{1,5}):(\d{1,5})$/;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function aspectRatioFromSize(
  width: number,
  height: number,
  tolerance = 0.03
): string {
  if (!(width > 0) || !(height > 0)) return '9:16';
  const r = width / height;
  let best: { ratio: string; diff: number } | null = null;
  for (const std of STANDARD_ASPECT_RATIOS) {
    const [w, h] = std.value.split(':').map(Number);
    const v = w / h;
    const diff = Math.abs(r - v) / v;
    if (diff <= tolerance && (!best || diff < best.diff))
      best = { ratio: std.value, diff };
  }
  if (best) return best.ratio;
  const g = gcd(Math.round(width), Math.round(height));
  return `${Math.round(width) / g}:${Math.round(height) / g}`;
}

/** User-typed "W:H" (also WxH, W/H) → normalised, or null. */
export function normaliseAspectRatio(value: string): string | null {
  const m = PATTERN.exec(value.trim().replace(/[x×/]/, ':'));
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w <= 0 || h <= 0) return null;
  // Snap to a standard ratio when close; otherwise keep what was typed
  // ("21:9" stays "21:9", not "7:3") — pixel sizes still reduce.
  const snapped = aspectRatioFromSize(w, h);
  return STANDARD_ASPECT_RATIOS.some((s) => s.value === snapped) || w > 100
    ? snapped
    : `${w}:${h}`;
}

export function isVeoNative(value: string): boolean {
  return VEO_NATIVE.includes(value);
}

/** Which native frame a non-native target renders in (mirrors backend). */
export function veoFrameFor(target: string): '16:9' | '9:16' {
  if (isVeoNative(target)) return target as '16:9' | '9:16';
  const m = PATTERN.exec(target);
  if (!m) return '9:16';
  return Number(m[1]) / Number(m[2]) > 1 ? '16:9' : '9:16';
}

/**
 * Семейство формата (TODO §III, п.35, автоэкспорт под площадки, этап
 * 75) — та же обёртка над `veoFrameFor`, что и на бэкенде
 * (`common/aspect-ratio.ts`): решает, обрежется ли формат дёшево из
 * уже отрендеренного файла (ярус A) или нужен второй платный рендер
 * (ярус B) — см. `ExportPanel.tsx`.
 */
export const aspectRatioFamily = veoFrameFor;

/**
 * Пресеты площадок для автоэкспорта — зеркало
 * `backend/src/common/aspect-ratio.ts`'s `PLATFORM_EXPORT_PRESETS`.
 * Ярлыки берутся из словаря (`dict.exportPanel.presets.*`), здесь —
 * только ключ и формат.
 */
export const EXPORT_PRESETS = [
  { key: 'tiktok', format: '9:16' },
  { key: 'youtube', format: '16:9' },
  { key: 'youtube-shorts', format: '9:16' },
  { key: 'instagram-feed', format: '4:5' },
  { key: 'instagram-reels', format: '9:16' },
  { key: 'square', format: '1:1' },
  { key: 'classic', format: '4:3' },
] as const;

export type ExportPresetKey = (typeof EXPORT_PRESETS)[number]['key'];

/**
 * Read a video file's pixel size in the browser (loadedmetadata). Resolves
 * null when the browser cannot decode the container — the server then
 * falls back to Gemini's read.
 */
export function readVideoSize(
  file: File
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    const done = (v: { width: number; height: number } | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = window.setTimeout(() => done(null), 8000);
    video.onloadedmetadata = () => {
      window.clearTimeout(timer);
      done(
        video.videoWidth > 0 && video.videoHeight > 0
          ? { width: video.videoWidth, height: video.videoHeight }
          : null
      );
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      done(null);
    };
    video.src = url;
  });
}
