/**
 * Чистые правила окна скетча (doc/AI-SKETCH-SPEC.md §3.2, §8.2).
 *
 * Отдельный модуль без React, потому что ломается здесь дороже всего:
 * «убрать логотипы» у персонажа означало бы обещание, которого модель не
 * даёт, а неверный остаток квоты — счётчик, который говорит «осталось 3»
 * после того, как третий уже потрачен. Такое проверяется тестом
 * (scripts/sketch-model.test.ts), а не глазами в интерфейсе.
 */

import type {
  SketchMode,
  SketchOptions,
  SketchQuota,
  SketchStyle,
  SketchTargetType,
} from '../../types/sketch';

/** Порядок пилюль в окне — «Карандаш» первым, он же по умолчанию. */
export const SKETCH_STYLES: SketchStyle[] = [
  'pencil',
  'lineart',
  'flat',
  'watercolor',
];

export const DEFAULT_SKETCH_STYLE: SketchStyle = 'pencil';

/**
 * Шесть слотов сводятся к трём видам содержимого: у правил §4 (п. 3–5)
 * нет разницы между персонажем сессии и персонажем бренда — разница
 * только в том, где он хранится.
 */
export type SketchSubject = 'character' | 'product' | 'scene';

export function sketchSubject(type: SketchTargetType): SketchSubject {
  if (type === 'session-character' || type === 'brand-character') {
    return 'character';
  }
  if (type === 'session-scene' || type === 'brand-scene') return 'scene';
  return 'product';
}

/**
 * Обезличивание (§4, п. 3): у персонажей в режиме «по фото» оно всегда
 * включено, и сервер игнорирует попытку его снять. Переключатель
 * показывается заблокированным, а не прячется — иначе пользователь не
 * узнает, что лицо меняется.
 */
export function isAnonymizeForced(
  type: SketchTargetType,
  mode: SketchMode
): boolean {
  return sketchSubject(type) === 'character' && mode === 'from-image';
}

/** «Убрать логотипы и надписи» — только у товаров и сцен (§3.2, п. 3). */
export function supportsRemoveLogos(type: SketchTargetType): boolean {
  return sketchSubject(type) !== 'character';
}

/**
 * Значения по умолчанию из §3.2, п. 3: у сцен логотипы и вывески
 * убираются сразу (в кадр попадают чужие витрины), у товаров — нет
 * (обычно это как раз свой товар, и надписи на упаковке нужны).
 */
export function defaultSketchOptions(type: SketchTargetType): SketchOptions {
  return {
    removeLogos: supportsRemoveLogos(type) && sketchSubject(type) === 'scene',
    keepColors: true,
    sketchRendering: 'realistic',
  };
}

/**
 * Режимы источника. «По фото» уместно только когда фото есть; для
 * текстовой замены персонажа (`kind:'text'`, аудит А-10) его нет, и
 * остаётся один режим — окно тогда не показывает выбор вовсе.
 */
export function availableModes(hasImage: boolean): SketchMode[] {
  return hasImage ? ['from-image', 'from-text'] : ['from-text'];
}

/** По умолчанию «по фото», если фото есть: качество заметно выше (§3.2). */
export function defaultMode(hasImage: boolean): SketchMode {
  return hasImage ? 'from-image' : 'from-text';
}

/** Остаток, а не израсходованное: пользователю важно «сколько ещё можно». */
export function quotaLeft(quota: SketchQuota): { day: number; month: number } {
  return {
    day: Math.max(0, quota.dayLimit - quota.dayUsed),
    month: Math.max(0, quota.monthLimit - quota.monthUsed),
  };
}

/**
 * Какая из двух границ уже упёрлась. Месячная важнее суточной: суточная
 * обновится завтра сама, а месячная — повод перейти на старший режим
 * (§8.4), и текст с CTA у них поэтому разный.
 */
export type SketchQuotaState = 'ok' | 'day-over' | 'month-over';

export function quotaState(quota: SketchQuota | null): SketchQuotaState {
  if (!quota) return 'ok';
  const left = quotaLeft(quota);
  if (left.month <= 0) return 'month-over';
  if (left.day <= 0) return 'day-over';
  return 'ok';
}

/**
 * «Скетчей: осталось 3 сегодня · 17 в этом месяце» — шаблон приходит из
 * словаря (этап 56), подстановка здесь, чтобы её можно было проверить
 * тестом без словаря конкретного языка.
 */
export function quotaLine(quota: SketchQuota, template: string): string {
  const left = quotaLeft(quota);
  return template
    .replace('{{day}}', String(left.day))
    .replace('{{month}}', String(left.month));
}

/**
 * Что показать под кнопкой «Применить» (§3.2, п. 5): напоминание про
 * «Реалистично» имеет смысл только там, где слот действительно уходит в
 * Veo/Grok, то есть у любого нашего слота — но только при выбранном
 * реалистичном рендере.
 */
export function showsRealisticNote(options: SketchOptions): boolean {
  return (options.sketchRendering ?? 'realistic') === 'realistic';
}

/**
 * Минимальная длина описания — та же, что в DTO (`@Length(3, 2000)`).
 * Раньше форма пускала один символ, и пользователь получал сырую
 * непереведённую ошибку валидации (аудит A-15).
 */
export const SKETCH_DESCRIPTION_MIN = 3;
export const SKETCH_DESCRIPTION_MAX = 2000;

/**
 * Можно ли вообще жать «Сгенерировать»: в режиме «по описанию» слишком
 * короткий текст — это гарантированный отказ сервера и потраченная
 * попытка.
 */
export function canGenerate(mode: SketchMode, description: string): boolean {
  if (mode === 'from-image') return true;
  const len = description.trim().length;
  return len >= SKETCH_DESCRIPTION_MIN && len <= SKETCH_DESCRIPTION_MAX;
}
