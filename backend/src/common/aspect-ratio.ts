/**
 * Aspect ratio of the reference video and of the generated ad
 * (doc/PRODUCT-PROJECT-SPEC.md §16). Pure helpers shared by the video,
 * analysis and generation modules.
 *
 * Two different questions live here and must not be confused:
 *  - what the REFERENCE looks like (detected from pixel dimensions the
 *    browser read from the uploaded file, or from Gemini's look at a
 *    YouTube video) — that is only a DEFAULT for the choice below;
 *  - what the user WANTS the ad to be — one of the standard ratios or a
 *    custom W:H. Veo renders natively only 16:9 and 9:16 (⚠ verified
 *    against the Gemini API docs, Sept 2026), so anything else is rendered
 *    in the nearest native frame with composition guidance for a later
 *    center-crop (the crop itself needs ffmpeg — the media worker of
 *    PUBLISHING-AND-VOICEOVER-SPEC §15.5; until then the user gets the
 *    native render plus the target recorded on the video).
 */

/** Ratios offered in the UI. Order = display order. */
export const STANDARD_ASPECT_RATIOS = [
  '9:16',
  '16:9',
  '3:4',
  '4:3',
  '1:1',
  '4:5',
] as const;
export type StandardAspectRatio = (typeof STANDARD_ASPECT_RATIOS)[number];

/** What Veo 3.1 accepts in `config.aspectRatio`. */
export const VEO_NATIVE_ASPECT_RATIOS = ['16:9', '9:16'] as const;
export type VeoAspectRatio = (typeof VEO_NATIVE_ASPECT_RATIOS)[number];

/** "W:H" with positive integers; custom values are kept as typed (reduced). */
export const ASPECT_RATIO_PATTERN = /^(\d{1,5}):(\d{1,5})$/;

export interface FrameInfo {
  width: number | null;
  height: number | null;
  /** Normalised "W:H" — a standard ratio when within tolerance, else reduced W:H. */
  aspectRatio: string;
  /** How the value was obtained. */
  source: 'file' | 'gemini' | 'manual';
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function parseAspectRatio(
  value: string,
): { w: number; h: number } | null {
  const m = ASPECT_RATIO_PATTERN.exec(value.trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w <= 0 || h <= 0) return null;
  return { w, h };
}

export function ratioValue(value: string): number | null {
  const p = parseAspectRatio(value);
  return p ? p.w / p.h : null;
}

/**
 * Pixel size → "W:H". Snaps to a standard ratio when within `tolerance`
 * (relative, default 3% — 1080×1920 is exactly 9:16, but 1080×1350 (4:5)
 * or phone recordings like 1080×2340 (≈9:19.5) should not be mislabelled).
 */
export function aspectRatioFromSize(
  width: number,
  height: number,
  tolerance = 0.03,
): string {
  if (!(width > 0) || !(height > 0)) return '9:16';
  const r = width / height;
  let best: { ratio: string; diff: number } | null = null;
  for (const std of STANDARD_ASPECT_RATIOS) {
    const v = ratioValue(std)!;
    const diff = Math.abs(r - v) / v;
    if (diff <= tolerance && (!best || diff < best.diff))
      best = { ratio: std, diff };
  }
  if (best) return best.ratio;
  const g = gcd(Math.round(width), Math.round(height));
  return `${Math.round(width) / g}:${Math.round(height) / g}`;
}

/** Normalise a user-typed / model-reported ratio; null when unusable. */
export function normaliseAspectRatio(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/[x×/]/, ':');
  const p = parseAspectRatio(cleaned);
  if (!p) return null;
  // Snap to a standard ratio when close; otherwise keep what was typed
  // ("21:9" stays "21:9", not "7:3") — pixel sizes (>100) still reduce.
  const snapped = aspectRatioFromSize(p.w, p.h);
  return isStandardAspectRatio(snapped) || p.w > 100
    ? snapped
    : `${p.w}:${p.h}`;
}

export function isStandardAspectRatio(
  value: string,
): value is StandardAspectRatio {
  return (STANDARD_ASPECT_RATIOS as readonly string[]).includes(value);
}

export function isVeoNative(value: string): value is VeoAspectRatio {
  return (VEO_NATIVE_ASPECT_RATIOS as readonly string[]).includes(value);
}

/**
 * Which native Veo frame to render a target ratio in. Portrait and square
 * → 9:16 (social-first; a square crop from 9:16 loses top/bottom, which is
 * usually sky/floor), landscape → 16:9.
 */
export function veoFrameFor(target: string): VeoAspectRatio {
  if (isVeoNative(target)) return target;
  const r = ratioValue(target);
  if (r === null) return '9:16';
  return r > 1 ? '16:9' : '9:16';
}

export interface RenderPlan {
  /** What the user asked for. */
  target: string;
  /** What Veo is asked to render. */
  rendered: VeoAspectRatio;
  /** True when target ≠ rendered — a center-crop is still owed. */
  reframe: boolean;
  /** Prompt sentence telling the model to keep everything inside the crop. */
  compositionNote: string | null;
}

/**
 * Семейство форматов (TODO §III, «Уровень 6», п.35 — автоэкспорт под
 * площадки; `doc/MULTI-FORMAT-EXPORT-SPEC.md` §2.3/§8.1, этап 75).
 *
 * Портрет и квадрат (`9:16, 3:4, 1:1, 4:5`) обрезаются из одного
 * нативного кадра `9:16`; ландшафт (`16:9, 4:3`) — из `16:9`. Внутри
 * одного семейства дешёвая обрезка (`common/reframe.ts`) забирает только
 * верх/низ или бока — вне семейства обрезка забрала бы бо́льшую часть
 * кадра, и это уже не автоэкспорт, а второй платный рендер Veo (ярус B,
 * `modules/export`). Обёртка над уже существующим `veoFrameFor` — расчёт
 * идентичен, здесь только более подходящее для контекста автоэкспорта
 * имя: вопрос не «в каком нативном кадре рендерить», а «из какого файла
 * этот формат можно дёшево вырезать».
 */
export function aspectRatioFamily(target: string): VeoAspectRatio {
  return veoFrameFor(target);
}

/** Один готовый вариант экспорта под конкретную площадку/соцсеть
 * (`doc/MULTI-FORMAT-EXPORT-SPEC.md` §5) — константа в коде, не таблица
 * в базе: пресеты меняются с требованиями площадок, то есть редко и
 * решением разработчика, а не пользователя. */
export interface ExportPreset {
  key: string;
  /** Человекочитаемый ярлык для чекбокса на экране результата. */
  label: string;
  format: string;
  /** Публикация на площадку уже реализована под этим значением enum (§14). */
  publicationPlatform?: 'YOUTUBE' | 'TIKTOK';
}

export const PLATFORM_EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    key: 'tiktok',
    label: 'TikTok',
    format: '9:16',
    publicationPlatform: 'TIKTOK',
  },
  {
    key: 'youtube',
    label: 'YouTube',
    format: '16:9',
    publicationPlatform: 'YOUTUBE',
  },
  // Тот же физический формат, что tiktok (`9:16`), — отдельный пресет
  // нужен ради ярлыка: Shorts и обычный YouTube-ролик разных пропорций
  // читаются пользователем по-разному, хотя `PublicationPlatform` пока
  // не различает их (открытый вопрос §7.5 документа, не решается здесь).
  {
    key: 'youtube-shorts',
    label: 'YouTube Shorts',
    format: '9:16',
    publicationPlatform: 'YOUTUBE',
  },
  { key: 'instagram-feed', label: 'Instagram — лента', format: '4:5' },
  { key: 'instagram-reels', label: 'Instagram — Reels', format: '9:16' },
  { key: 'square', label: 'Квадрат (соцсети)', format: '1:1' },
  { key: 'classic', label: 'Классический экран', format: '4:3' },
] as const;

export function presetByKey(key: string): ExportPreset | null {
  return PLATFORM_EXPORT_PRESETS.find((p) => p.key === key) ?? null;
}

export function planRender(target: string): RenderPlan {
  const rendered = veoFrameFor(target);
  if (rendered === target) {
    return { target, rendered, reframe: false, compositionNote: null };
  }
  return {
    target,
    rendered,
    reframe: true,
    compositionNote: `FRAMING: the final ad will be center-cropped from ${rendered} to ${target}. Compose every shot so the subject, the product and all on-screen text stay inside the central ${target} safe area; keep the outer margins free of anything essential.`,
  };
}
