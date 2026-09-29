/**
 * Карточка мастера поздравления → тема справки (29.09.2026).
 *
 * Девять карточек, пять тем: голос, музыка, титры, наклейка и
 * раскадровка — это одна тема «настройте ролик», потому что и на экране
 * они одна группа, и на лендинге их нет вовсе.
 *
 * ## Почему ключи — те же `data-qa`
 *
 * Идентификатор карточки уже существует: это её хук, по которому её
 * находят сценарии обучалки, и он сверяется швом с каталогом бэкенда в
 * обе стороны. Завести рядом второй, «свой» идентификатор значило бы
 * получить два списка карточек, которые однажды разойдутся, — и справка
 * начнёт показывать ролик не про то, что на экране.
 *
 * ## Один резолвер на кнопку и на голос
 *
 * Этим же соответствием пользуется голосовое управление (§4А.7.3 ТЗ
 * поздравления): слово «помощь» открывает ролик ТОЙ карточки, на
 * которой человек стоит. Две копии соответствия разойдутся так же, как
 * два списка карточек.
 */

export type GreetingHelpTopic =
  | 'greeting-brief'
  | 'greeting-references'
  | 'greeting-script'
  | 'greeting-settings'
  | 'greeting-video';

export const GREETING_CARD_TOPIC: Readonly<Record<string, GreetingHelpTopic>> =
  {
    'greeting-brief-card': 'greeting-brief',
    'greeting-references-card': 'greeting-references',
    'greeting-script-card': 'greeting-script',
    // Пять карточек одной темы — «настройте ролик».
    'greeting-voice-card': 'greeting-settings',
    'greeting-music-card': 'greeting-settings',
    'greeting-cards-card': 'greeting-settings',
    'greeting-sticker-card': 'greeting-settings',
    'greeting-scenes-card': 'greeting-settings',
    'greeting-video-card': 'greeting-video',
  };

/** Тема справки карточки или `null` — у карточки без справки кнопки (i) нет. */
export function helpTopicOf(cardHook: string): GreetingHelpTopic | null {
  return GREETING_CARD_TOPIC[cardHook] ?? null;
}
