/**
 * ИИ-скетч (doc/AI-SKETCH-SPEC.md) — стилизованная версия изображения,
 * которая ПОДМЕНЯЕТ оригинал во всех дальнейших вызовах: референсы и
 * первый кадр Veo/Grok, аватар Hedra, публичные страницы.
 *
 * Типы здесь общие для слотов в JSON сессии (замена персонажа, фото
 * товара, сцена) и для слотов в Prisma (персонаж и сцена бренда, товар
 * проекта): резолвер (`common/active-image.ts`) читает и то, и другое
 * одинаково.
 */

export const SKETCH_STYLES = [
  'pencil',
  'lineart',
  'flat',
  'watercolor',
] as const;
export type SketchStyle = (typeof SKETCH_STYLES)[number];

export function isSketchStyle(value: unknown): value is SketchStyle {
  return (SKETCH_STYLES as readonly unknown[]).includes(value);
}

export const SKETCH_MODES = ['from-image', 'from-text'] as const;
export type SketchMode = (typeof SKETCH_MODES)[number];

/**
 * Как ролик должен использовать скетч (§5.5 ТЗ). `realistic` добавляет в
 * промпт строку «это рисунок, задающий форму и позу — рендерить
 * реалистично»; `stylized` не добавляет ничего, и ролик может
 * унаследовать рисованную стилистику.
 */
export const SKETCH_RENDERINGS = ['realistic', 'stylized'] as const;
export type SketchRendering = (typeof SKETCH_RENDERINGS)[number];

export interface SketchOptions {
  /** Люди: черты лица меняются. Для персонажей сервер ставит `true` сам. */
  anonymizeFace?: boolean;
  /** Товары и сцены: убрать логотипы и надписи. */
  removeLogos?: boolean;
  keepColors?: boolean;
  sketchRendering?: SketchRendering;
}

/**
 * Скетч, записанный В САМ СЛОТ (денормализация): резолвер не должен
 * ходить в БД за каждым референсом на горячем пути генерации.
 */
export interface SketchRef {
  sketchId: string;
  url: string;
  /** Есть всегда: файл лежит в нашем Blob (`sketches/…`). */
  pathname: string;
  mimeType: string;
  style: SketchStyle;
  sketchRendering: SketchRendering;
  appliedAt: string;
}

/** Общая часть слота с изображением — то, что добавляет к нему скетч. */
export interface SketchableSlot {
  /** Применённый скетч; пусто — слот работает как раньше. */
  sketch?: SketchRef | null;
  /** Оригинал удалён (§4 п.10 ТЗ) — возврата к нему больше нет. */
  originalDeleted?: boolean;
}

export const SKETCH_TARGET_TYPES = [
  'session-character',
  'session-product',
  'session-scene',
  'brand-character',
  'brand-scene',
  'project-item',
  // GREETING_VIDEO — референсы Grok reference-to-video (см. доккомментарий
  // `Session.greetingReferenceImages`), седьмой слот, а не разновидность
  // 'session-scene': разный массив сессии, разный (отсутствующий) гейт
  // тарифа.
  'session-greeting-reference',
] as const;
export type SketchTargetType = (typeof SKETCH_TARGET_TYPES)[number];

export interface SketchTarget {
  type: SketchTargetType;
  /** sessionId | brandManifestId | productItemId */
  id: string;
  /** characterId | sceneId; пусто у товара. */
  subId?: string | null;
}

export type SketchStatus =
  | 'candidate'
  | 'applied'
  | 'superseded'
  | 'expired'
  | 'refused'
  | 'failed';

export interface SketchView {
  id: string;
  status: SketchStatus;
  mode: SketchMode;
  style: SketchStyle;
  options: SketchOptions;
  url: string | null;
  createdAt: string;
  appliedAt: string | null;
  auto: boolean;
}

export interface SketchQuotaView {
  dayUsed: number;
  dayLimit: number;
  monthUsed: number;
  monthLimit: number;
}

/** Состояние слота после apply/revert/delete-original — то, что рисует UI. */
export interface SketchSlotView {
  target: SketchTarget;
  variant: 'original' | 'sketch';
  url: string | null;
  sketchId: string | null;
  originalDeleted: boolean;
}

/**
 * Машиночитаемая причина 409 при `apply`. Без неё фронтенд трактовал
 * ЛЮБОЙ конфликт как «фото изменилось» и предлагал платную
 * перегенерацию там, где достаточно обновить экран (аудит A-13).
 */
export const SKETCH_CONFLICT = {
  /** Исходное фото слота сменилось после генерации — нужен новый скетч. */
  stale: 'source-changed',
  /** Этот скетч уже активен — перерисовывать нечего. */
  alreadyApplied: 'already-applied',
  /** Запись устарела: файла больше нет (уборка §6.7). */
  gone: 'sketch-gone',
} as const;

export type SketchConflictReason =
  (typeof SKETCH_CONFLICT)[keyof typeof SKETCH_CONFLICT];
