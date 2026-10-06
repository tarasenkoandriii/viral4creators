/**
 * tutorial-tempo.ts — планировщик темпа обучалки в постпродакшене
 * (doc/TUTORIAL-POSTPROD-TEMPO-SPEC.md, решение владельца 06.10.2026).
 *
 * Чистая функция: на входе кадры исходного монтажного плана (исходная
 * длительность, измеренная речь или её отсутствие, время чтения
 * подписи), на выходе — новые `seconds[]` для того же `planSlideshow` и
 * предупреждения. Второго движка таймингов здесь НЕТ: картинка, отрезки
 * звука, подписи, указатель, зум и `durationMs` по-прежнему считаются
 * из `frameSpansSeconds` по этим секундам. Планировщик решает одно —
 * сколько держать каждый кадр.
 *
 * ## Что меняется, а что нет
 *
 * Скорость речи не меняется никогда (ни `atempo`, ни `setpts`, ни
 * `playbackRate`). Исходный кадр делится на «пол» — то, без чего кадр
 * нельзя показать честно, — и свободную паузу над ним. Темп масштабирует
 * ТОЛЬКО паузу:
 *
 *     новый = пол + round(k × пауза),   пауза = max(0, исходный − пол)
 *
 * Пол кадра с измеренной речью — `ceil((речь + SPEECH_GUARD_SECONDS) ×
 * fps)` плюс переход у всех кадров, кроме последнего: следующий кадр
 * въезжает поверх хвоста этого, и начало следующей реплики не может
 * наступить раньше конца этой. Это ровно условие «речь не режется»
 * `round(s·fps) − overlap ≥ ceil((речь + запас)·fps)`; ниже
 * `MIN_FRAME_SECONDS` пол не опускается никогда — на нём держится выбор
 * перехода (`transitionFrames` по самому короткому кадру).
 *
 * Пол немого кадра — `max(время чтения подписи, MIN_FRAME_SECONDS)`.
 * Время чтения — `captionReadingSeconds`, оно уже включает хвост
 * `FRAME_TAIL_SECONDS` (0.6 с), который больше перехода (0.3 с), то есть
 * переход съедает паузу, а не время чтения, — то же правило, что у
 * исходной сборки.
 *
 * Кадр с дорожкой неизвестной длины (mp3 не измерился) не трогается:
 * угадывать границу реплики запрещено спецификацией, и сжать такой кадр
 * значило бы, возможно, отрезать речь. Он остаётся исходной длины и
 * попадает в предупреждения.
 *
 * Исходный кадр короче своего пола — дефект ИСХОДНИКА (реплика уже
 * обрезалась), а не «бесплатное ускорение»: такой кадр поднимается до
 * пола при ЛЮБОМ темпе и называется в предупреждениях.
 *
 * Темп считается ВСЕГДА от исходного плана, а не от предыдущей версии:
 * возврат к «обычному» (k = 1) даёт исходную сетку кадр в кадр, без
 * накопленных округлений.
 */

import {
  appliedMotion,
  frameSpansSeconds,
  gridFrames,
  gridFramesCeil,
  gridFramesToSeconds,
  MAX_SLIDESHOW_FRAMES,
  MIN_FRAME_SECONDS,
  SlideshowMotion,
  TRANSITION_FRAMES,
  transitionFrames,
} from './tutorial-video-assembly';

/** Защитный запас после реплики (решение владельца 06.10.2026): кадр
 *  не сменяется на последнем слоге даже на самом быстром темпе. */
export const SPEECH_GUARD_SECONDS = 0.2;

/**
 * Пресеты — множитель ПАУЗЫ, а не скорости ролика. «Быстрее» не значит
 * «вдвое короче»: речь своей длины, и подпись в интерфейсе говорит
 * «меняет паузы; скорость речи сохраняется».
 */
export const TEMPO_PRESETS = {
  calm: 1.5,
  normal: 1,
  fast: 0.4,
} as const;

export type TempoPreset = keyof typeof TEMPO_PRESETS;

/** Ползунок точной настройки: 0 — паузы сняты до пола, 2 — вдвое
 *  длиннее исходных. Шаг — чтобы ключ идемпотентности не плодил версии
 *  на 0.4 и 0.4000000001. */
export const TEMPO_FACTOR_MIN = 0;
export const TEMPO_FACTOR_MAX = 2;
export const TEMPO_FACTOR_STEP = 0.05;

/**
 * Множитель паузы, приведённый к шагу ползунка, или `null` — значение
 * вне диапазона или не число. Отказ, а не зажим: «прислали 5» — это
 * ошибка клиента, и тихо собрать ×2 значило бы оплатить не то, что
 * просили.
 */
export function normalizeTempoFactor(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw < TEMPO_FACTOR_MIN || raw > TEMPO_FACTOR_MAX) return null;
  const steps = Math.round(raw / TEMPO_FACTOR_STEP);
  return Number((steps * TEMPO_FACTOR_STEP).toFixed(2));
}

/** Кадр исходного плана — то, что планировщику нужно знать о нём. */
export interface TempoFrameInput {
  /** Исходная длительность кадра в секундах (как ушла в `planSlideshow`). */
  baseSeconds: number;
  /**
   * Реплика кадра: `null` — кадр немой; `{seconds: null}` — дорожка есть,
   * но её длина не измерилась (кадр не сжимается).
   */
  speech: { seconds: number | null } | null;
  /** Время чтения подписи (`captionReadingSeconds`, с хвостом) или `null`. */
  readingSeconds: number | null;
}

export type TempoWarning =
  /** Темп быстрее обычного, а у части кадров пауза уже на минимуме. */
  | { code: 'pauses-at-minimum'; frames: number }
  /** Исходный кадр короче речи/чтения — поднят до пола (дефект исходника). */
  | { code: 'source-frame-too-short'; frameIndexes: number[] }
  /** Дорожка без измеренной длины — кадр оставлен исходной длины. */
  | { code: 'speech-unmeasured'; frameIndexes: number[] }
  /** Ролик вышел длиннее потолка зума — зум снимется при сборке. */
  | { code: 'zoom-dropped' };

export interface TempoPlan {
  /** Новые длительности кадров, на сетке кадров. */
  seconds: number[];
  /** Длительность ролика по той же сетке (`frameSpansSeconds`). */
  durationMs: number;
  /** Самая короткая достижимая длительность (k = 0) — для подсказки
   *  «быстрее нельзя» в интерфейсе. */
  minimumDurationMs: number;
  /** Режим движения, который применит сборка (зум снимается у длинных). */
  motion: SlideshowMotion;
  /** Кадров, у которых пауза на минимуме (новая длина = пол). */
  framesAtMinimum: number;
  warnings: TempoWarning[];
}

interface FloorInfo {
  floor: number;
  base: number;
  /** Кадр не сжимается и не растягивается (дорожка без длины). */
  fixed: boolean;
}

function floorsOf(
  frames: readonly TempoFrameInput[],
  overlap: number,
): FloorInfo[] {
  const minFrames = gridFrames(MIN_FRAME_SECONDS);
  return frames.map((frame, i) => {
    const base = gridFrames(frame.baseSeconds);
    const isLast = i === frames.length - 1;
    if (frame.speech && frame.speech.seconds === null) {
      return { floor: Math.max(base, minFrames), base, fixed: true };
    }
    let floor = minFrames;
    if (frame.speech && frame.speech.seconds !== null) {
      floor = Math.max(
        floor,
        gridFramesCeil(frame.speech.seconds + SPEECH_GUARD_SECONDS) +
          (isLast ? 0 : overlap),
      );
    } else if (frame.readingSeconds !== null && frame.readingSeconds > 0) {
      floor = Math.max(floor, gridFramesCeil(frame.readingSeconds));
    }
    return { floor, base, fixed: false };
  });
}

function validInput(frames: readonly TempoFrameInput[]): boolean {
  if (frames.length === 0 || frames.length > MAX_SLIDESHOW_FRAMES) {
    return false;
  }
  return frames.every(
    (f) =>
      Number.isFinite(f.baseSeconds) &&
      f.baseSeconds > 0 &&
      (f.speech === null ||
        f.speech.seconds === null ||
        (Number.isFinite(f.speech.seconds) && f.speech.seconds >= 0)) &&
      (f.readingSeconds === null || Number.isFinite(f.readingSeconds)),
  );
}

function durationMsOf(
  seconds: readonly number[],
  motion: SlideshowMotion,
): number {
  const spans = frameSpansSeconds(
    seconds.map((s) => ({ seconds: s })),
    motion,
  );
  return Math.round((spans.at(-1)?.end ?? 0) * 1000);
}

/**
 * Новые длительности кадров для множителя паузы `factor`.
 *
 * `null` — вход негоден (кадров нет, больше потолка слайд-шоу,
 * неположительная/неконечная длительность, отрицательная речь) или
 * множитель вне диапазона. Вызывающий отвечает отказом, а не сборкой.
 */
export function planTempo(
  frames: readonly TempoFrameInput[],
  opts: { factor: number; motion: SlideshowMotion },
): TempoPlan | null {
  const factor = normalizeTempoFactor(opts.factor);
  if (factor === null || !validInput(frames)) return null;
  // Переход выбирается по самому короткому кадру (`transitionFrames`).
  // Пол кадра не ниже `MIN_FRAME_SECONDS` (45 кадров против 18 у двух
  // переходов), так что переход будет всегда, когда он вообще возможен,
  // — и этим числом можно пользоваться ДО расчёта длительностей.
  const overlap =
    opts.motion === 'none' || frames.length < 2 ? 0 : TRANSITION_FRAMES;
  const info = floorsOf(frames, overlap);

  const tooShort: number[] = [];
  const unmeasured: number[] = [];
  let atMinimum = 0;
  const lengths = info.map((f, i) => {
    if (f.fixed) {
      unmeasured.push(i);
      return f.floor;
    }
    if (f.base < f.floor) tooShort.push(i);
    const pause = Math.max(0, f.base - f.floor);
    const length = f.floor + Math.round(factor * pause);
    if (length === f.floor) atMinimum++;
    return length;
  });
  const minimumLengths = info.map((f) => f.floor);

  const seconds = lengths.map((n) => gridFramesToSeconds(n));
  // Страховка инварианта, а не логика: переход, который выберет сборка
  // по этим длительностям, обязан совпасть с тем, под который считался
  // пол. Разойдутся — значит изменили `transitionFrames` или
  // `MIN_FRAME_SECONDS`, и обещание «речь не режется» больше не
  // проверено; честнее отказать, чем собрать.
  if (
    transitionFrames(
      seconds.map((s) => ({ seconds: s })),
      opts.motion,
    ) !== overlap
  ) {
    return null;
  }

  const motion = appliedMotion(
    seconds.map((s) => ({ seconds: s })),
    opts.motion,
  );
  const warnings: TempoWarning[] = [];
  if (factor < 1 && atMinimum > 0) {
    warnings.push({ code: 'pauses-at-minimum', frames: atMinimum });
  }
  if (tooShort.length > 0) {
    warnings.push({ code: 'source-frame-too-short', frameIndexes: tooShort });
  }
  if (unmeasured.length > 0) {
    warnings.push({ code: 'speech-unmeasured', frameIndexes: unmeasured });
  }
  if (motion !== opts.motion) warnings.push({ code: 'zoom-dropped' });

  return {
    seconds,
    durationMs: durationMsOf(seconds, opts.motion),
    minimumDurationMs: durationMsOf(
      minimumLengths.map((n) => gridFramesToSeconds(n)),
      opts.motion,
    ),
    motion,
    framesAtMinimum: atMinimum,
    warnings,
  };
}

/** Пресет по множителю (для подписи активной версии), иначе `null`. */
export function presetOfFactor(factor: number): TempoPreset | null {
  const hit = (Object.keys(TEMPO_PRESETS) as TempoPreset[]).find(
    (p) => TEMPO_PRESETS[p] === factor,
  );
  return hit ?? null;
}
