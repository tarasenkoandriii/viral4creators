import { GREETING_OCCASION_SPECS } from '../../common/greeting-occasions';
import {
  GreetingOccasion,
  GreetingPresenterProvider,
  GreetingTone,
} from '../../common/types/greeting.types';

/**
 * Промпт для СТАТИЧНОГО референс-кадра поздравления — фича №6
 * компаньон-ТЗ, этап 5 плана
 * `docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md`.
 *
 * ## Зачем кадр вообще
 *
 * Фича закрывает находку №2 первого аудита буквально: grok-путь
 * поздравления сегодня — text-to-video без изображения, если человек
 * сам ничего не загрузил (см. доккомментарий `GreetingVideoService`).
 * Видео-рендер — самая дорогая операция продукта, и увидеть «не то
 * лицо, не та сцена» можно было только после неё. Кадр стоит центы,
 * рисуется секунды и даёт отказаться от неудачного варианта ДО
 * дорогого шага.
 *
 * Готовый кадр сохраняется в те же `session.greetingReferenceImages`,
 * куда попадают загруженные человеком: дальше он идёт в Grok как
 * родной `reference_images` без единой правки в `GreetingVideoService`.
 *
 * ## Что в промпт НЕ попадает, и это не упущение
 *
 * **Имя получателя.** Оно есть в брифе, но в кадр не идёт по двум
 * причинам, и каждой хватило бы одной. Первая: это персональные данные
 * третьего лица, которое о генерации не знает, — тот же принцип, по
 * которому `snapshotFromSession` не выносит имя в публичный заголовок.
 * Вторая: модели изображений рисуют текст плохо, и «Марина» на торте
 * с большой вероятностью станет «Мaрuна» — дефект, который человек
 * заметит, а исправить не сможет.
 *
 * **Личное сообщение.** Это текст РЕЧИ, он озвучивается в
 * постпродакшене. В картинке ему делать нечего.
 *
 * ## Чувствительные поводы
 *
 * `sceneMood` у соболезнования, извинения и поддержки — `CALM_SCENE`
 * («no decorations, no confetti, no balloons»). Эта строка идёт в
 * промпт как есть и вместе с явным запретом ниже: модель, увидев слово
 * greeting, охотно дорисовывает шарики, а шарики на соболезновании —
 * ровно та ошибка, ради которой каталог поводов и заведён.
 */
export function buildGreetingFramePrompt(input: {
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  tone: GreetingTone;
  presenter: GreetingPresenterProvider;
  /** Выбранный сеттинг (фича №36). Пусто — сцена из каталога поводов. */
  setting?: string | null;
}): string {
  const spec = GREETING_OCCASION_SPECS[input.occasion];
  const occasionText =
    input.occasion === 'OTHER' && input.customOccasionText?.trim()
      ? input.customOccasionText.trim()
      : spec.label;

  const lines = [
    'Generate a single photorealistic still frame that will be used as the',
    'opening reference frame of a short greeting video.',
    `Occasion: ${occasionText}.`,
    // Выбранный человеком сеттинг ЗАМЕЩАЕТ общую сцену повода, а не
    // дописывается к ней (фича №36): две сцены в одном промпте —
    // «bright festive decor» и «snowy balcony at night» — модель
    // сводит в кашу, а не выбирает лучшую.
    `Scene: ${input.setting?.trim() || spec.sceneMood}.`,
    `Mood of the person on camera: ${TONE_LOOK[input.tone]}.`,
    PRESENTER_LOOK[input.presenter],
    'Vertical or horizontal framing is acceptable; keep the subject centred',
    'with room around the head so the frame works as a video start.',
    // Запреты — отдельным блоком и в конце: модели изображений держат
    // последние инструкции лучше, чем середину промпта.
    'Do not render any text, letters, numbers, captions or watermarks.',
    'Do not include any recognisable real person or celebrity.',
  ];
  if (!spec.festive) {
    lines.push(
      'This is NOT a celebration: no balloons, no confetti, no cake, no gifts,',
      'no party decorations of any kind.',
    );
  }
  return lines.join('\n');
}

/**
 * Как тон выглядит НА ЛИЦЕ. Отдельно от `GREETING_TONE_LABELS`: те
 * подписи русские и описывают речь («с юмором, но уважительно») —
 * в промпт изображения они не годятся ни языком, ни смыслом.
 */
const TONE_LOOK: Readonly<Record<GreetingTone, string>> = {
  WARM: 'warm, genuine smile; relaxed and friendly',
  FUNNY: 'playful, light-hearted expression; a hint of mischief, never mocking',
  FORMAL: 'composed, polite, professional expression',
  SUPPORTIVE: 'calm, kind, attentive expression; gentle, not cheerful',
  RESPECTFUL: 'serious, respectful, quiet expression; no smile',
};

/**
 * Кто в кадре. `grok` — единственный путь, ради которого фича и
 * делается (у `hedra` кадр приходит из самого аватара), но промпт
 * строится для обоих: выбор провайдера меняется тарифом, и молчаливая
 * зависимость «для hedra кадр не рисуем» жила бы здесь невидимой.
 */
const PRESENTER_LOOK: Readonly<Record<GreetingPresenterProvider, string>> = {
  grok: 'A single friendly person facing the camera, upper body in frame.',
  hedra:
    'A single friendly person facing the camera, head and shoulders, neutral background suitable for an animated avatar.',
};
