/**
 * Запрет правки карточек поздравления, пока ролик считается (CONTRACT6,
 * G-B2 п.2).
 *
 * Голос, музыка, наклейка, число сцен, карточки и фото читаются рендером
 * и постобработкой ИЗ СНИМКА СЕССИИ — не из копии на момент старта.
 * Смена посреди рендера давала ролик, не совпадающий ни с прежним, ни с
 * новым выбором: картинка снята под одно, озвучка и музыка кладутся
 * поверх уже по другому, а кредит списан за первое. Тот же принцип, что у
 * правки брифа (`editModeOf` → 'busy', `GREETING_EDIT_BUSY_MESSAGE`), но
 * с кодом: экран гасит кнопку по коду, а не разбирает текст.
 *
 * Готовый (COMPLETE) и упавший ролик не держат: выбор после них — это
 * подготовка следующего рендера, её запрещать незачем.
 */

import { ConflictException } from '@nestjs/common';
import { editModeOf } from './greeting-session-edit';
import { GREETING_ERROR_CODES, greetingError } from './greeting-errors';
import type { GeneratedVideo } from './types/generation.types';

export const GREETING_CHANGE_DURING_RENDER_MESSAGE =
  'Ролик сейчас собирается — менять голос, музыку, фото и оформление можно, когда он будет готов.';

/** Бросает 409 с кодом, если рендер сессии в работе (PENDING/PROCESSING). */
export function assertGreetingNotRendering(session: {
  generatedVideo?: Pick<GeneratedVideo, 'status'> | null;
}): void {
  if (editModeOf(session.generatedVideo) === 'busy') {
    throw new ConflictException(
      greetingError(
        GREETING_ERROR_CODES.GREETING_CHANGE_DURING_RENDER,
        GREETING_CHANGE_DURING_RENDER_MESSAGE,
      ),
    );
  }
}
