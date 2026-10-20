/**
 * Фото физического подарка (ST2-U-02): подгонка под лимит сервера.
 *
 * Сервер (`backend/.../story-gifts/story-photo.ts`, `normalizeStoryPhoto`)
 * принимает только PNG до 1024×1024 и до 1 МиБ, затем перекодирует его
 * заново (pngjs) — JPEG/WebP он не примет. Раньше клиент ужимал фото до
 * фиксированных 960 px и при PNG > 1 МиБ отказывал «выберите поменьше»:
 * обычный снимок с телефона (960×720 ≈ 1,1 МиБ PNG) не проходил никогда,
 * а выбор файла «поменьше» ничего не менял — его ужимало до тех же 960.
 *
 * Теперь размер подбирается шагами: старт — 1024 по длинной стороне (или
 * меньше, если фото меньше), дальше сторона уменьшается пропорционально
 * перерасходу (с запасом) до попадания в лимит base64. Без React и DOM —
 * кодировщик передаётся снаружи; проверяется `scripts/story-photo-fit.test.ts`.
 */

/** Длинная сторона, которую принимает сервер. */
export const STORY_PHOTO_MAX_SIDE = 1024;
/** Лимит сервера на PNG, байт (1 МиБ). */
export const STORY_PHOTO_MAX_BYTES = 1024 * 1024;
/**
 * Цель клиента — с запасом ниже лимита: сервер перекодирует PNG своим
 * кодировщиком, и его файл может оказаться чуть больше браузерного.
 */
export const STORY_PHOTO_TARGET_BYTES = 960 * 1024;
/** Меньше этой стороны фото уже бесполезно для карточки подарка. */
export const STORY_PHOTO_MIN_SIDE = 240;
/** Попыток кодирования — каждая заметно уменьшает площадь. */
export const STORY_PHOTO_MAX_ATTEMPTS = 8;

/** Лимит DTO сервера на строку base64 (`@MaxLength(1398104)`). */
export const STORY_PHOTO_MAX_BASE64 = base64Length(STORY_PHOTO_MAX_BYTES);

/** Длина base64 без переносов для `bytes` байт. */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}
/** Байт в строке base64 (с учётом `=`). */
export function base64Bytes(value: string): number {
  const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - pad;
}

/** Размер холста для длинной стороны `side`, пропорции сохраняются. */
export function fitSize(
  width: number,
  height: number,
  side: number
): { width: number; height: number } {
  const scale = Math.min(1, side / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Следующая длинная сторона после перерасхода: площадь PNG примерно
 * пропорциональна размеру файла, поэтому сторона — корень отношения,
 * с запасом 0,92 и не меньше чем на 8 % за шаг (иначе цикл топчется).
 */
export function nextSide(side: number, bytes: number, target: number): number {
  const ratio = Math.sqrt(target / Math.max(1, bytes)) * 0.92;
  return Math.floor(side * Math.min(0.92, Math.max(0.35, ratio)));
}

export type PhotoEncoder = (width: number, height: number) => Promise<string>;

export class StoryPhotoTooLarge extends Error {
  constructor() {
    super(
      'Не удалось сжать фото до 1 МБ даже после уменьшения — выберите другой снимок (например, без мелкого шума или в меньшем разрешении).'
    );
    this.name = 'StoryPhotoTooLarge';
  }
}

/**
 * Подгоняет фото под лимит: кодирует, при перерасходе уменьшает и
 * повторяет. Возвращает base64 PNG и итоговый размер.
 */
export async function fitStoryPhoto(
  width: number,
  height: number,
  encode: PhotoEncoder,
  opts: { targetBytes?: number } = {}
): Promise<{
  base64: string;
  width: number;
  height: number;
  attempts: number;
}> {
  const target = Math.min(
    opts.targetBytes ?? STORY_PHOTO_TARGET_BYTES,
    STORY_PHOTO_MAX_BYTES
  );
  let side = Math.min(STORY_PHOTO_MAX_SIDE, Math.max(width, height));
  for (let attempt = 1; attempt <= STORY_PHOTO_MAX_ATTEMPTS; attempt++) {
    const size = fitSize(width, height, side);
    const base64 = await encode(size.width, size.height);
    const bytes = base64Bytes(base64);
    if (bytes <= target && base64.length <= STORY_PHOTO_MAX_BASE64)
      return { base64, ...size, attempts: attempt };
    const next = nextSide(side, bytes, target);
    if (next >= STORY_PHOTO_MIN_SIDE) side = next;
    else if (side > STORY_PHOTO_MIN_SIDE) side = STORY_PHOTO_MIN_SIDE;
    else break;
  }
  throw new StoryPhotoTooLarge();
}
