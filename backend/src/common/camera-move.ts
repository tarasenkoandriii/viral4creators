/**
 * Движение камеры в ролике (ТЗ §29, этап 46).
 *
 * ## Зачем
 *
 * Статичный кадр читается как сток; медленный непрерывный наезд — как
 * работа оператора. Это самый дешёвый приём, отличающий
 * «сгенерированное видео» от «снятого», и он не стоит ни одного
 * дополнительного вызова: Veo умеет движение камеры сам, надо только
 * попросить.
 *
 * ## Почему промптом, а не постобработкой
 *
 * Программный зум по готовому кадру (`zoompan` в ffmpeg) теряет
 * резкость и выдаёт себя дрожанием на краях: кадр интерполируется, а не
 * снимается. Просьба к модели даёт настоящее движение — с параллаксом и
 * правильным размытием. Постобработка остаётся запасным вариантом на
 * случай, если модель просьбу проигнорирует, и в этом случае решение
 * будет приниматься заново.
 *
 * ## Почему амплитуда зависит от формата
 *
 * При неродном для Veo формате ролик снимается с композицией под
 * центральную обрезку (§16.1): по краям остаётся запас, который потом
 * срежут. Наезд сужает безопасную зону ещё раз — товар, помещавшийся в
 * кадр, к концу ролика упирается в границу обрезки. Поэтому в
 * неродном формате просим движение меньшей амплитуды, а не отменяем его.
 *
 * ## Что здесь НЕ решается
 *
 * Выбор направления (наезд на товар, отъезд к общему плану, проезд
 * вбок). Начинаем с одного значения: три варианта в интерфейсе, из
 * которых два никто не выберет, — это не выбор, а шум. Список расширяем,
 * когда появится, из чего выбирать осознанно.
 */

export const CAMERA_MOVES = ['none', 'push-in'] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export const DEFAULT_CAMERA_MOVE: CameraMove = 'none';

/** Форматы, которые Veo рендерит нативно (§16.1). */
const NATIVE_FRAMES = new Set(['16:9', '9:16']);

export function normalizeCameraMove(value: unknown): CameraMove {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (CAMERA_MOVES as readonly string[]).includes(raw)
    ? (raw as CameraMove)
    : DEFAULT_CAMERA_MOVE;
}

export function isNativeFrame(aspectRatio?: string | null): boolean {
  return NATIVE_FRAMES.has((aspectRatio ?? '').trim());
}

/**
 * Кусок брифа для GPT-5 — на английском, как и остальной промпт.
 *
 * @param move        что просил бренд
 * @param aspectRatio целевой формат кадра; неродной означает обрезку,
 *                    а значит меньшую амплитуду
 */
export function cameraBriefText(
  move: CameraMove,
  aspectRatio?: string | null,
): string {
  if (move !== 'push-in') return '';

  const tight = !isNativeFrame(aspectRatio);
  return [
    'CAMERA MOVEMENT: one slow, continuous push-in over the whole clip —',
    "the camera creeps toward the product (or the speaker's face in the",
    'final beat) and never stops, cuts or changes shot size abruptly.',
    tight
      ? `Keep the movement SMALL (about 5% of the frame): the clip is shot for a ${aspectRatio ?? 'non-native'} centre crop, so the safe area is already narrow and a wider push would cut the product off.`
      : 'A gentle 10–15% push is enough; anything faster reads as a zoom, not as camera work.',
    'No handheld shake, no snap zoom, no orbit.',
  ].join(' ');
}
