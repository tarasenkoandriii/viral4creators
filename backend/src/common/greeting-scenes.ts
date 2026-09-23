/**
 * Мультисценовый ролик — фича №7 компаньон-ТЗ.
 *
 * ## Как это устроено и почему так просто
 *
 * Несколько сцен описываются ОДНИМ промптом, по порядку, и модель
 * рендерит их одним клипом. Ровно так уже работает товарная ветка:
 * `scenesBriefText` (`common/analysis-selection.ts`) отдаёт
 * «SCENES TO KEEP (in this order): …», и никакой склейки в конвейере
 * нет.
 *
 * Первый подход был другой — по клипу на сцену параллельно и склейка
 * в ffmpeg. Он давал больше власти над каждым кадром, но взамен
 * требовал: состояния на каждый клип в `GeneratedVideo`, параллельного
 * опроса, отдельной задачи склейки со своим опросом, новой зависимости
 * `FfmpegApiService` в генерации поздравлений и лишнего прохода
 * перекодирования. Пять новых мест, где может сломаться, ради того,
 * что уже умеет одна строка промпта. Выброшено целиком.
 *
 * ## Что осталось
 *
 * Раскадровка: сколько сцен, по скольку секунд и что в каждой
 * происходит. Дальше это приписывается к описанию сцены и уходит тем
 * же единственным вызовом, что и раньше.
 */

/**
 * Общая длина поздравления. Живёт здесь, а не только в
 * `GreetingVideoService`, потому что её должен знать и экран: человек
 * выбирает число сцен и вправе видеть, по скольку секунд они выйдут.
 */
export const GREETING_SCENE_SECONDS = 15;

/** Больше четырёх сцен в пятнадцати секундах — это клип, а не поздравление. */
export const MAX_GREETING_SCENES = 4;
export const MIN_GREETING_SCENES = 1;

export function normalizeSceneCount(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return MIN_GREETING_SCENES;
  return Math.min(MAX_GREETING_SCENES, Math.max(MIN_GREETING_SCENES, n));
}

/**
 * Как поделить общую длительность между сценами.
 *
 * Остаток отдаётся ПЕРВЫМ сценам, а не последней: последняя — это
 * прощание, и лишняя секунда там заметнее как пауза, чем в середине.
 */
export function splitSceneDurations(
  totalSeconds: number,
  sceneCount: number,
): number[] {
  const n = normalizeSceneCount(sceneCount);
  const total = Math.max(n, Math.round(totalSeconds));
  const base = Math.floor(total / n);
  let rest = total - base * n;
  return Array.from({ length: n }, () => {
    const extra = rest > 0 ? 1 : 0;
    rest -= extra;
    return base + extra;
  });
}

/**
 * Драматургия по числу сцен. Английский — как и весь остальной текст,
 * уходящий в Grok (`buildSceneDescription`).
 *
 * Формулировки про КАМЕРУ и ДЕЙСТВИЕ, а не про сюжет: сюжет уже
 * описан в основном промпте, и повторять его здесь значило бы спорить
 * с ним.
 */
const BEATS: Record<number, string[]> = {
  1: [],
  2: [
    'open on the presenter, warm and direct, establishing the moment',
    'a closer, calmer shot — the presenter finishes the thought and lets it land',
  ],
  3: [
    'a wider establishing shot — the presenter arrives into the moment',
    'a medium shot — the heart of the message, closest to the viewer',
    'a closing shot — a gesture, a smile, the moment settling',
  ],
  4: [
    'a wide establishing shot of the setting, the presenter entering it',
    'a medium shot — the presenter turns to the viewer',
    'a close shot — the heart of the message',
    'a closing shot — a gesture of farewell, the setting again',
  ],
};

/**
 * Блок раскадровки для промпта.
 *
 * Пустая строка при одной сцене — не мелочь: односценовый ролик обязан
 * собираться ровно тем же промптом, что и до этой фичи, иначе она
 * молча изменила бы все существующие ролики.
 */
export function buildStoryboard(
  sceneCount: number,
  totalSeconds: number = GREETING_SCENE_SECONDS,
): string {
  const n = normalizeSceneCount(sceneCount);
  const beats = BEATS[n] ?? [];
  if (beats.length < 2) return '';
  const durations = splitSceneDurations(totalSeconds, n);
  return [
    `Structure the video as ${n} consecutive shots with hard cuts between them, in this order:`,
    ...beats.map((beat, i) => `- Shot ${i + 1} (~${durations[i]}s): ${beat}.`),
    'Keep the same presenter, wardrobe, setting and lighting across all shots — it is one message, not a montage of different people.',
  ].join('\n');
}

/** Промпт сцены = общее описание плюс раскадровка, если сцен больше одной. */
export function withStoryboard(
  basePrompt: string,
  sceneCount: number,
  totalSeconds: number = GREETING_SCENE_SECONDS,
): string {
  const storyboard = buildStoryboard(sceneCount, totalSeconds);
  return storyboard ? `${basePrompt}\n${storyboard}` : basePrompt;
}
