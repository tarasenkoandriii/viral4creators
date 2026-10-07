/**
 * Проверка текста, который уходит в промпты кадра и видео поздравления:
 * выбранная обстановка (§3.9) и подписи фото (аудит захода 8). Одна
 * функция на выбор обстановки, правку подписи, правку брифа и старт
 * ролика — иначе правила снова разойдутся по местам записи.
 */

import {
  celebrityLikenessMessage,
  findCelebrityLikeness,
} from './celebrity-likeness';
import { findModerationFlags } from './text-moderation';
import {
  evaluateGreetingPolicy,
  festiveSettingMarker,
  isFestiveRegister,
  policyMessage,
  registerOfBrief,
} from './greeting-policy';
import type { GreetingBriefSnapshot } from './types/greeting.types';
import type { SceneAsset } from './types/reference.types';

type BriefPolicyFields = Pick<
  GreetingBriefSnapshot,
  'occasion' | 'occasionRegister' | 'tone'
>;

export type SceneTextKind = 'обстановки' | 'подписи фото';

/**
 * Что не так с текстом: чужой образ (фича №35), стоп-слова модерации,
 * политика регистра (вне праздника — без праздничной атрибутики).
 * `null` — всё в порядке.
 */
export function sceneTextProblem(
  brief: BriefPolicyFields,
  text: string,
  what: SceneTextKind,
): string | null {
  const likeness = findCelebrityLikeness(text);
  if (likeness) return celebrityLikenessMessage(likeness);
  const flags = findModerationFlags(text);
  if (flags.length) {
    return `Текст ${what} не прошёл автоматическую проверку (${flags.join(', ')}). Измените его.`;
  }
  const verdict = evaluateGreetingPolicy({
    occasion: brief.occasion,
    occasionRegister: brief.occasionRegister ?? null,
    tone: brief.tone,
    sceneSetting: text,
  });
  const own = verdict.violations.filter((v) => v.field === 'sceneSetting');
  return own.length ? policyMessage({ ...verdict, violations: own }) : null;
}

/** Подписи фото, которые уходят в видео-промпт (`label`, `description`). */
export function referenceCaptions(image: SceneAsset): string[] {
  return [image.label, image.description]
    .map((t) => (t ?? '').trim())
    .filter(Boolean);
}

/** Первая проблема среди подписей всех фото — для проверки у денег. */
export function referenceCaptionsProblem(
  brief: BriefPolicyFields,
  images: readonly SceneAsset[] | null | undefined,
): string | null {
  for (const img of images ?? []) {
    for (const caption of referenceCaptions(img)) {
      const problem = sceneTextProblem(brief, caption, 'подписи фото');
      if (problem) return problem;
    }
  }
  return null;
}

/** Нейтральная подпись взамен сброшенной — у фото подпись обязательна. */
export const NEUTRAL_REFERENCE_LABEL = 'Фото';

/**
 * Привести подписи фото к регистру (смена повода в правке брифа): подпись
 * с праздничной атрибутикой вне праздника сбрасывается — описание в
 * `null`, подпись в нейтральную. Только политика регистра: модерацию и
 * чужой образ подпись прошла при записи, и повод их не меняет.
 */
export function reconcileReferenceCaptions(
  brief: BriefPolicyFields,
  images: readonly SceneAsset[] | null | undefined,
): { images: SceneAsset[]; changed: boolean } {
  const list = [...(images ?? [])];
  if (isFestiveRegister(registerOfBrief(brief))) {
    return { images: list, changed: false };
  }
  let changed = false;
  const next = list.map((img) => {
    const labelBad = !!festiveSettingMarker(img.label);
    const descriptionBad = !!festiveSettingMarker(img.description);
    if (!labelBad && !descriptionBad) return img;
    changed = true;
    return {
      ...img,
      ...(labelBad ? { label: NEUTRAL_REFERENCE_LABEL } : {}),
      ...(descriptionBad ? { description: null } : {}),
    };
  });
  return { images: next, changed };
}
