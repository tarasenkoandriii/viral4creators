/**
 * Активное изображение слота (doc/AI-SKETCH-SPEC.md §6.3).
 *
 * ГЛАВНЫЙ ИНВАРИАНТ фичи: при применённом скетче оригинал не уходит
 * никуда наружу — ни референсом, ни первым кадром Veo/Grok, ни в Hedra,
 * ни на публичную страницу. Единственный способ этого добиться —
 * чтобы ВСЕ такие места читали изображение слота только отсюда, а не
 * `photoUrl`/`productImagePathname` напрямую. Поэтому функции здесь
 * чистые и без исключений: их зовут и из горячего пути генерации, и из
 * чистых сборщиков (`reference-plan.ts`, `snapshot.ts`).
 *
 * Если у слота нет ни оригинала, ни скетча — `null`, как и раньше
 * означало «картинки нет, описываем словами».
 */

import { CastReplacement } from './types/casting.types';
import { ProductInformation } from './types/product.types';
import { SceneAsset } from './types/reference.types';
import {
  BrandCharacterSnapshot,
  BrandSceneSnapshot,
} from './types/brand-manifest.types';
import { SketchRef, SketchRendering } from './types/sketch.types';

export interface ActiveImage {
  url: string;
  /** Путь в нашем Blob; у снимка бренда его нет — только публичный URL. */
  pathname: string | null;
  mimeType: string;
  variant: 'original' | 'sketch';
  /** Только у скетча (§5.5): как его должен трактовать ролик. */
  sketchRendering: SketchRendering | null;
}

export function mimeFromPath(
  s: string | null | undefined,
  fallback = 'image/jpeg',
): string {
  if (!s) return fallback;
  const ext = s.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return fallback;
}

function fromSketch(sketch: SketchRef): ActiveImage {
  return {
    url: sketch.url,
    pathname: sketch.pathname,
    mimeType: sketch.mimeType || mimeFromPath(sketch.pathname, 'image/png'),
    variant: 'sketch',
    sketchRendering: sketch.sketchRendering ?? 'realistic',
  };
}

function original(
  url: string | null | undefined,
  pathname: string | null | undefined,
  mimeType?: string | null,
): ActiveImage | null {
  if (!url && !pathname) return null;
  return {
    url: url ?? '',
    pathname: pathname ?? null,
    mimeType: mimeType || mimeFromPath(pathname ?? url),
    variant: 'original',
    sketchRendering: null,
  };
}

/**
 * Слот сессии: замена персонажа (`photo` — своё фото, `brand` — из бренда).
 *
 * Для `kind:'brand'` сама замена хранит только URL оригинала из снимка
 * (её пишет `casting.service`, и он не знает про скетчи). Поэтому активное
 * изображение такой замены резолвится ЧЕРЕЗ снимок бренда: там скетч
 * поддерживается в актуальном состоянии `syncSnapshotSketches` перед
 * каждым рендером. Без снимка поведение прежнее — аудит A-1.
 */
export function activeCastImage(
  r: CastReplacement,
  brandCharacters?: readonly BrandCharacterSnapshot[] | null,
): ActiveImage | null {
  if (r.sketch) return fromSketch(r.sketch);
  if (r.kind === 'brand' && brandCharacters?.length) {
    const snap = brandCharacterFor(r, brandCharacters);
    if (snap) {
      const image = activeSnapshotCharacterImage(snap);
      if (image) return image;
    }
  }
  return original(r.photoUrl, r.photoPathname);
}

/**
 * Какому персонажу снимка соответствует brand-замена. По id — надёжно;
 * по URL — для замен, сохранённых до появления `brandCharacterId`.
 */
export function brandCharacterFor(
  r: CastReplacement,
  brandCharacters: readonly BrandCharacterSnapshot[],
): BrandCharacterSnapshot | null {
  if (r.brandCharacterId) {
    const byId = brandCharacters.find(
      (c) => c.sourceCharacterId === r.brandCharacterId,
    );
    if (byId) return byId;
  }
  if (r.photoUrl) {
    const byUrl = brandCharacters.find((c) => c.photoUrl === r.photoUrl);
    if (byUrl) return byUrl;
  }
  return null;
}

export function activeProductImage(
  p: ProductInformation | undefined | null,
): ActiveImage | null {
  if (!p) return null;
  if (p.sketch) return fromSketch(p.sketch);
  return original(
    p.productImageUrl ?? null,
    p.productImagePathname ?? null,
    p.productImageMimeType,
  );
}

export function activeSessionSceneImage(s: SceneAsset): ActiveImage | null {
  if (s.sketch) return fromSketch(s.sketch);
  return original(s.photoUrl, s.photoPathname);
}

export function activeSnapshotCharacterImage(
  c: BrandCharacterSnapshot,
): ActiveImage | null {
  if (c.sketch) return fromSketch(c.sketch);
  // У снимка бренда сохранён только публичный URL — pathname здесь
  // никогда не было, и это не потеря: `fetchReference` умеет забирать
  // по URL, проверив, что он наш (`isOwnBlobUrl`).
  return original(c.photoUrl, null);
}

export function activeSnapshotSceneImage(
  s: BrandSceneSnapshot,
): ActiveImage | null {
  if (s.sketch) return fromSketch(s.sketch);
  return original(s.photoUrl, null);
}

/**
 * Слоты из Prisma (персонаж и сцена бренда, товар проекта). Скетч лежит
 * не в самой строке, а в связанной `ImageSketch` — вызывающий подаёт её
 * через `include: { activeSketch: true }`. Форма описана структурно, а
 * не типом Prisma: чистый модуль не должен зависеть от сгенерированного
 * клиента (и его тестам не нужна БД).
 */
export interface SketchRowLike {
  id: string;
  url: string | null;
  pathname: string | null;
  mimeType: string | null;
  style: string;
  options: unknown;
  appliedAt: Date | string | null;
}

export interface SketchableRow {
  photoUrl?: string | null;
  activeSketch?: SketchRowLike | null;
  originalDeletedAt?: Date | string | null;
}

export function sketchRefFromRow(row: SketchRowLike): SketchRef | null {
  if (!row.url || !row.pathname) return null;
  const options = (row.options ?? {}) as { sketchRendering?: SketchRendering };
  return {
    sketchId: row.id,
    url: row.url,
    pathname: row.pathname,
    mimeType: row.mimeType || mimeFromPath(row.pathname, 'image/png'),
    style: row.style as SketchRef['style'],
    sketchRendering: options.sketchRendering ?? 'realistic',
    appliedAt:
      row.appliedAt instanceof Date
        ? row.appliedAt.toISOString()
        : (row.appliedAt ?? new Date().toISOString()),
  };
}

export function activeRowImage(row: SketchableRow): ActiveImage | null {
  const ref = row.activeSketch ? sketchRefFromRow(row.activeSketch) : null;
  if (ref) return fromSketch(ref);
  return original(row.photoUrl ?? null, null);
}

/** URL для показа и для копий (публичная страница, миниатюра в UI). */
export function activeRowPhotoUrl(row: SketchableRow): string | null {
  return activeRowImage(row)?.url ?? null;
}
