/**
 * Чего не хватает брифу, чтобы его можно было сохранить, — для строки
 * после «Да» на карточке «я понял так» (аудит ветки K, §4А.2 п. 3–4 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`, §3.4).
 *
 * Голос заполнил поля, но кнопка «Сохранить» погашена (`canSave` в
 * `BriefStep`): «Особый повод» без описания или без ответа о настроении,
 * пустой получатель. Строка «нажмите «Сохранить»» тогда звала бы к
 * кнопке, которую нажать нельзя, — вместо неё помощник называет, что
 * осталось сказать, и тем самым задаёт обязательный вопрос о настроении.
 *
 * Правило ровно то же, что у кнопки: пусто ⇔ `recipientName.trim()` и
 * `occasionFieldsComplete` — тест держит их в согласии.
 *
 * Чистый модуль — `scripts/brief-voice-missing.test.ts`.
 */

import type { OccasionFieldsState } from './greeting-occasion-fields';

export type BriefMissing = 'customOccasion' | 'mood' | 'recipient';

/** Недостающее в порядке полей на экране: описание → настроение → кому. */
export function briefVoiceMissing(
  state: Pick<OccasionFieldsState, 'occasion' | 'customOccasionText' | 'mood'>,
  recipientName: string
): BriefMissing[] {
  const missing: BriefMissing[] = [];
  if (state.occasion === 'OTHER') {
    if (!state.customOccasionText.trim()) missing.push('customOccasion');
    if (state.mood === null) missing.push('mood');
  }
  if (!recipientName.trim()) missing.push('recipient');
  return missing;
}
