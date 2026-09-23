/**
 * Геометрия наклейки поверх кадра — фича №8. Чистые функции, без сети.
 *
 * ## Почему размер считаем мы, а не ffmpeg
 *
 * Естественный способ — `scale2ref`: масштабировать наклейку
 * относительно кадра прямо в фильтре. Он объявлен устаревшим в
 * ffmpeg 7 и в следующих версиях может исчезнуть, а какая версия
 * стоит на чужом хостед-сервисе, мы не знаем. Поэтому ширина
 * считается здесь, в пикселях, и уходит обычным `scale=<W>:-1`,
 * который работает во всех версиях.
 *
 * Расплата честная и мелкая: если исходный ролик отрендерился в
 * непредвиденном разрешении, наклейка окажется чуть крупнее или чуть
 * мельче задуманного. Это косметика. Упавший фильтр — не косметика.
 */

export const STICKER_PLACEMENTS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'center',
  'full',
] as const;

export type StickerPlacement = (typeof STICKER_PLACEMENTS)[number];

export const DEFAULT_STICKER_PLACEMENT: StickerPlacement = 'bottom-right';

/** Доля ширины кадра, которую занимает наклейка в углу или по центру. */
const CORNER_SCALE = 0.28;
/** Отступ от края — тоже доля ширины, чтобы он не «плыл» по разрешениям. */
const MARGIN_SCALE = 0.04;

export function isStickerPlacement(value: unknown): value is StickerPlacement {
  return (
    typeof value === 'string' &&
    (STICKER_PLACEMENTS as readonly string[]).includes(value)
  );
}

export function normalizeStickerPlacement(value: unknown): StickerPlacement {
  return isStickerPlacement(value) ? value : DEFAULT_STICKER_PLACEMENT;
}

/**
 * Ширина кадра в пикселях по метке разрешения и формату.
 *
 * Метка провайдера («720p») означает КОРОТКУЮ сторону — так её
 * понимают и Veo, и Grok. У вертикального ролика короткая сторона это
 * ширина, у горизонтального — высота; отсюда две ветки, а не одна
 * формула.
 */
export function frameWidth(
  resolution: string | null | undefined,
  aspectRatio: string | null | undefined,
): number {
  const short =
    resolution === '1080p'
      ? 1080
      : resolution === '480p'
        ? 480
        : resolution === '720p'
          ? 720
          : 1080;
  const [w, h] = (aspectRatio ?? '9:16').split(':').map(Number);
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return short;
  // Горизонтальный кадр: короткая сторона — высота, ширину считаем от неё.
  return w >= h ? Math.round((short * w) / h) : short;
}

/**
 * Шаги фильтра для наклейки: как её уменьшить и куда положить.
 *
 * `x`/`y` — выражения ffmpeg, а не числа: `W`/`H` это кадр, `w`/`h` —
 * наклейка, и пусть их сопоставляет сам overlay. Так положение
 * остаётся верным, даже если наш расчёт ширины промахнулся.
 */
export function stickerOverlay(
  placement: StickerPlacement,
  frameWidthPx: number,
): { scale: string; x: string; y: string } {
  const margin = Math.round(frameWidthPx * MARGIN_SCALE);
  const width =
    placement === 'full'
      ? frameWidthPx
      : Math.round(frameWidthPx * CORNER_SCALE);
  // `-2`, а не `-1`: обе стороны сохраняют пропорции, но округляются до
  // чётного. Нечётная сторона — классический способ получить отказ
  // кодировщика на ровном месте, и чинить его потом дороже, чем
  // поставить двойку здесь.
  const scale = `scale=${width}:-2`;
  const position: Record<StickerPlacement, { x: string; y: string }> = {
    'top-left': { x: `${margin}`, y: `${margin}` },
    'top-right': { x: `W-w-${margin}`, y: `${margin}` },
    'bottom-left': { x: `${margin}`, y: `H-h-${margin}` },
    'bottom-right': { x: `W-w-${margin}`, y: `H-h-${margin}` },
    center: { x: '(W-w)/2', y: '(H-h)/2' },
    full: { x: '(W-w)/2', y: '(H-h)/2' },
  };
  return { scale, ...position[placement] };
}
