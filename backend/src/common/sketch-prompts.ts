/**
 * Промпты ИИ-скетча (doc/AI-SKETCH-SPEC.md §5.2). Чистый модуль — весь
 * смысл фичи держится на тексте, и проверять его надо юнит-тестом, а не
 * глазами на проде.
 *
 * Три правила, которые НЕ должны исчезнуть ни в одной ветке:
 *  - результат обязан выглядеть рисунком, а не фотографией (иначе вся
 *    юридическая идея теряется);
 *  - лицо меняется всегда, кроме слота persona-look проверенной
 *    персоны: у человека, срисованного с фото, черты лица меняются, даже
 *    если клиент прислал `anonymizeFace: false`. Единственное исключение
 *    — скетч-аватар образа самого автора («Я в кадре», ТЗ TZ-Greeting-2.0
 *    §4.5, Т-3): слот `persona-look`, персона с действующим согласием и
 *    пройденной живостью. Решает это ТОЛЬКО сервер по типу слота и
 *    состоянию персоны (`sketchLikenessFor`) — ни поле клиента, ни
 *    описание не превращают `character`/`scene`/`product` в `self`;
 *  - запреты на несовершеннолетних, откровенный контент и реальных
 *    людей идут в КАЖДЫЙ промпт.
 *
 * Описание пользователя подставляется как ДАННЫЕ: в кавычках, без
 * управляющих символов — иначе «ignore previous instructions…» в поле
 * описания становится инструкцией модели.
 */

import { SketchMode, SketchOptions, SketchStyle } from './types/sketch.types';

/** Какого рода слот рисуем — от этого зависит, что сохранять. */
export type SketchSlotKind = 'character' | 'product' | 'scene';

/**
 * Что делать с лицом человека на исходном фото. `anonymise` — по
 * умолчанию и для всех слотов; `self` — только слот `persona-look`
 * проверенной персоны (см. инвариант в шапке файла).
 */
export type SketchLikeness = 'anonymise' | 'self';

/** Тип слота, для которого вообще возможен `self`. Один. */
export const SELF_LIKENESS_TARGET_TYPE = 'persona-look';

/**
 * Единственное место, где решается `likeness`. Принимает ТОЛЬКО то, что
 * сервер знает сам: тип слота и признак «персона с действующим согласием
 * и пройденной живостью». Входа клиента здесь нет по построению — поэтому
 * `character`, `scene` и `product` не получают `self` ни при каком
 * запросе (Т-3; тест `sketch-prompts.spec.ts`).
 */
export function sketchLikenessFor(
  targetType: string,
  personaVerified: boolean,
): SketchLikeness {
  return targetType === SELF_LIKENESS_TARGET_TYPE && personaVerified === true
    ? 'self'
    : 'anonymise';
}

const STYLE_FRAGMENT: Record<SketchStyle, { plain: string; colour: string }> = {
  pencil: {
    plain: 'graphite pencil sketch with light shading',
    colour: 'coloured pencil sketch with light shading',
  },
  lineart: {
    plain: 'clean black ink line art, no shading',
    colour: 'clean coloured ink line art, no shading',
  },
  flat: {
    plain: 'flat vector illustration with solid colours',
    colour: 'flat vector illustration with solid colours',
  },
  watercolor: {
    plain: 'loose watercolor illustration',
    colour: 'loose watercolor illustration',
  },
};

export const SAFETY_LINE =
  'Do not depict minors. No nudity or sexual content. Do not depict any real, identifiable or famous person.';

export const ANONYMISE_LINE =
  'Change facial features so the person is NOT recognisable as the individual in the photo.';

/**
 * Скетч-аватар САМОГО автора (`likeness: 'self'`): лицо сохраняется —
 * человек дал согласие на своё лицо и прошёл проверку живости.
 */
export const SELF_LIKENESS_LINE =
  'Keep the facial features of the person in the photo so the drawing is recognisably them.';

/**
 * Запреты для `self`. Строка «не изображать реальных людей» здесь была бы
 * противоречием (человек на фото реален и согласился), поэтому она
 * сужена до «никого, кроме него», а запреты на несовершеннолетних и
 * откровенное — те же, дословно.
 */
export const SELF_SAFETY_LINE =
  'Do not depict minors; the person must look like an adult. No nudity or sexual content. Do not depict any other real, identifiable or famous person.';

/**
 * Описание пользователя для промпта: без управляющих символов и двойных
 * кавычек (они закрыли бы цитату), не длиннее 2000 символов.
 */
export function sanitizeSketchDescription(description: string): string {
  return (
    description
      // eslint-disable-next-line no-control-regex -- управляющие символы и есть цель
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/"/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000)
  );
}

export interface SketchPromptInput {
  slotKind: SketchSlotKind;
  mode: SketchMode;
  style: SketchStyle;
  options: SketchOptions;
  /** Текст для `from-text`; у `from-image` — необязательная подсказка. */
  description?: string | null;
  /** Название товара — попадает в промпт вместе с описанием. */
  name?: string | null;
  /**
   * Что делать с лицом (`sketchLikenessFor`). Учитывается ТОЛЬКО у
   * человека по фото (`character` + `from-image`); отсутствует или любое
   * другое значение — лицо меняется.
   */
  likeness?: SketchLikeness;
}

/** `self` действует только для человека, срисованного с фото. */
function keepsOwnFace(input: SketchPromptInput): boolean {
  return (
    input.likeness === 'self' &&
    input.slotKind === 'character' &&
    input.mode === 'from-image'
  );
}

function styleSentence(style: SketchStyle, keepColors: boolean): string {
  const fragment = STYLE_FRAGMENT[style];
  return `Non-photorealistic ${keepColors ? fragment.colour : fragment.plain}. It must clearly look like a drawing, not a photograph.`;
}

function bodyFor(input: SketchPromptInput): string {
  const description = input.description
    ? sanitizeSketchDescription(input.description)
    : '';
  const quoted = description ? `"${description}"` : '';
  const removeLogos = input.options.removeLogos === true;

  if (input.slotKind === 'character') {
    if (input.mode === 'from-image') {
      // Обезличивание — не опция для фото человека: сервер ставит его
      // сам, здесь оно в тексте всегда (§4 п.3 ТЗ), кроме `self` слота
      // persona-look проверенной персоны (см. шапку файла).
      return [
        'Redraw the person from the reference image.',
        'Keep pose, clothing, body type, approximate age group and hairstyle silhouette.',
        keepsOwnFace(input) ? SELF_LIKENESS_LINE : ANONYMISE_LINE,
        quoted ? `Extra notes about the person: ${quoted}.` : '',
        'Plain light background.',
      ]
        .filter(Boolean)
        .join(' ');
    }
    return `Draw a fictional adult person: ${quoted || '"a neutral adult person"'}. Waist-up, facing the camera, plain light background.`;
  }

  if (input.slotKind === 'product') {
    const name = input.name ? sanitizeSketchDescription(input.name) : '';
    if (input.mode === 'from-image') {
      return [
        'Redraw this product.',
        'Keep exact shape, proportions, colours and packaging layout.',
        removeLogos
          ? 'Replace all logos, brand names and text with blank shapes.'
          : 'Keep existing product lettering legible.',
        quoted ? `The product is ${quoted}.` : '',
        'Plain background, single object, centred.',
      ]
        .filter(Boolean)
        .join(' ');
    }
    return [
      `Draw a product${name ? `: "${name}"` : ''}.`,
      quoted ? `Details: ${quoted}.` : '',
      'No brand names or logos.',
      'Plain background, single object, centred.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (input.mode === 'from-image') {
    return [
      'Redraw this location.',
      'Keep layout, perspective and key objects.',
      'Remove all people.',
      removeLogos ? 'Remove signage, logos and readable text.' : '',
      quoted ? `The location is ${quoted}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return [
    `Draw a location: ${quoted || '"a neutral interior"'}.`,
    'No people.',
    removeLogos ? 'No signage or logos.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function buildSketchPrompt(input: SketchPromptInput): string {
  return [
    styleSentence(input.style, input.options.keepColors !== false),
    bodyFor(input),
    'No captions, watermarks or signatures.',
    keepsOwnFace(input) ? SELF_SAFETY_LINE : SAFETY_LINE,
  ].join(' ');
}

/**
 * Строка для промпта ГЕНЕРАЦИИ ролика, когда референс — скетч в режиме
 * `realistic` (§5.5 ТЗ): модель должна взять из рисунка форму и позу, а
 * нарисовать реалистично. `stylized` строки не получает — там рисованная
 * стилистика и есть то, чего хотел пользователь.
 */
export function sketchReferenceNote(index: number): string {
  return `Reference image ${index} is a stylized drawing used only as a guide for shape, pose and layout. Render it photorealistically in the video's style; do not copy the drawing style.`;
}

/** Отпечаток промпта для журнала (§6.6 ТЗ) — без хранения текста целиком. */
export function promptFingerprint(prompt: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < prompt.length; i += 1) {
    const c = prompt.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
