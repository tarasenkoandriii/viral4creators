/**
 * Звук предпросмотра темпа обучалки (`features/postprod/TutorialPreview`)
 * — выбор пути и расписание запасного пути (TODO L1966, 07.10.2026).
 *
 * ## Два пути
 *
 * - **WebAudio** (основной): mp3 реплик качаются `fetch` и
 *   раскладываются по часам `AudioContext` с точностью до сэмпла. Для
 *   `fetch` и `decodeAudioData` нужен CORS хранилища — на проде его может
 *   не быть, и раньше превью тогда шло «без звука».
 * - **`<audio>`-элементы** (запасной): воспроизведение элементом CORS не
 *   требует (без `crossOrigin` — «непрозрачный» ответ можно слушать, но
 *   нельзя прочитать). Реплики запускаются по тем же часам, что двигают
 *   картинку (`performance.now()`), каждая — в начале своего кадра; анализа
 *   сигнала нет, точность — кадр анимации (~16 мс), для превью темпа
 *   этого достаточно.
 *
 * Пометка «без звука» остаётся только для случая, когда не сработал и
 * запасной путь (нет `Audio`, ошибка загрузки элемента, браузер отказал в
 * `play()`).
 */

export type PreviewAudioPath = 'webaudio' | 'element' | 'silent';

export interface PreviewAudioEnv {
  /** Есть `AudioContext` (или `webkitAudioContext`). */
  webAudio: boolean;
  /** Есть `HTMLAudioElement` (`typeof Audio !== 'undefined'`). */
  elementAudio: boolean;
  /** Сколько реплик в расписании. */
  clips: number;
  /** Хотя бы одна реплика не скачалась или не декодировалась WebAudio. */
  webAudioFailed: boolean;
}

/**
 * Какой путь играть. Смешанного нет: если хоть одна реплика не прошла
 * через WebAudio, все идут элементами — иначе часть фраз звучала бы по
 * часам `AudioContext`, часть по `performance.now()`, и разъезд между
 * ними был бы ровно тем, что превью темпа должно показывать честно.
 */
export function previewAudioPath(env: PreviewAudioEnv): PreviewAudioPath {
  if (env.clips === 0) return env.webAudio ? 'webaudio' : 'silent';
  if (env.webAudio && !env.webAudioFailed) return 'webaudio';
  return env.elementAudio ? 'element' : 'silent';
}

/**
 * Насколько реплика может опоздать и всё ещё прозвучать. Больше — это
 * не задержка кадра, а вкладка в фоне (rAF стоит): по возвращении все
 * пропущенные реплики грянули бы разом. Пропущенная — пропускается.
 */
export const ELEMENT_MAX_LATE_S = 0.75;

/**
 * Какие реплики запустить в момент `now` (секунды от старта): ещё не
 * запущенные, чьё время наступило и не прошло дальше допуска. Опоздавшие
 * сверх допуска возвращаются в `skipped` — вызывающий отмечает их, чтобы
 * не проверять снова.
 */
export function dueClips(
  schedule: ReadonlyArray<{ at: number }>,
  fired: ReadonlySet<number>,
  now: number
): { start: number[]; skipped: number[] } {
  const start: number[] = [];
  const skipped: number[] = [];
  schedule.forEach((clip, index) => {
    if (fired.has(index) || clip.at > now) return;
    if (now - clip.at > ELEMENT_MAX_LATE_S) skipped.push(index);
    else start.push(index);
  });
  return { start, skipped };
}

/** То, что нужно от `<audio>` — для подмены в тесте. */
export interface AudioLike {
  muted: boolean;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
}

export interface PrimedClip<T extends AudioLike> {
  el: T;
  /** Запустить реплику со звуком с начала (из расписания, вне жеста). */
  start(): Promise<void>;
}

/**
 * «Разблокировать» элемент в жесте нажатия (аудит захода 7, P3).
 *
 * WebKit (Safari, Telegram на iOS) разрешает `play()` со звуком только
 * элементу, которому `play()` уже вызывали внутри жеста пользователя.
 * Запасной путь запускает реплики из `requestAnimationFrame` после
 * `await fetch` — жеста там давно нет, и без разблокировки каждая
 * реплика получала бы `NotAllowedError`. Поэтому элемент создаётся и
 * разблокируется СИНХРОННО в обработчике нажатия, до первого `await`:
 * `play()` без звука (`muted`), сразу после старта — `pause()` и
 * перемотка в начало. Звука при разблокировке нет.
 *
 * Если расписание запустило реплику раньше, чем разрешился промис
 * разблокировки, пауза не ставится — иначе она оборвала бы реплику.
 */
export function primeClip<T extends AudioLike>(el: T): PrimedClip<T> {
  let started = false;
  el.muted = true;
  try {
    void Promise.resolve(el.play()).then(
      () => {
        if (started) return;
        el.pause();
        el.currentTime = 0;
      },
      () => undefined
    );
  } catch {
    /* старый браузер: play() без промиса бросил — разблокировки нет */
  }
  return {
    el,
    start() {
      started = true;
      el.currentTime = 0;
      el.muted = false;
      return Promise.resolve(el.play());
    },
  };
}
