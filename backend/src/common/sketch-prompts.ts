/**
 * Промпты ИИ-скетча (doc/AI-SKETCH-SPEC.md §5.2). Чистый модуль — весь
 * смысл фичи держится на тексте, и проверять его надо юнит-тестом, а не
 * глазами на проде.
 *
 * Три правила, которые НЕ должны исчезнуть ни в одной ветке:
 *  - результат обязан выглядеть рисунком, а не фотографией (иначе вся
 *    юридическая идея теряется);
 *  - лицо человека, срисованного с фото, меняется всегда — даже если
 *    клиент прислал `anonymizeFace: false`;
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
      // сам, здесь оно просто всегда в тексте (§4 п.3 ТЗ).
      return [
        'Redraw the person from the reference image.',
        'Keep pose, clothing, body type, approximate age group and hairstyle silhouette.',
        ANONYMISE_LINE,
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
    SAFETY_LINE,
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
