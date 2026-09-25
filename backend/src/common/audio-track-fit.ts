/**
 * Влезает ли переведённая реплика в ролик — правила §5 ТЗ
 * TZ-Multilingual-YouTube.md (этап 138).
 *
 * ## Что на самом деле не совпадает по длине
 *
 * ТЗ говорит: «YouTube требует, чтобы дорожка была примерно той же
 * длины, что видео, а переведённая реплика почти никогда не совпадает
 * по длине с оригинальной». Первая половина в продукте выполняется
 * САМА: альтернативная дорожка собирается тем же рецептом, что и
 * оригинальный звук (`common/postprod.ts`), а там подложка приводится
 * к длине ролика (`atrim`/`apad`) и микшер работает с
 * `duration=first` — то есть длина готовой дорожки равна длине ролика,
 * какой бы ни была речь.
 *
 * Ломается другое, и об этом стоит говорить прямо: **длинная реплика не
 * удлиняет дорожку, а обрывается на полуслове**. Зритель на немецком
 * услышит фразу, которая кончилась ничем. Поэтому проверки ниже — не
 * про длину файла, а про то, укладывается ли РЕЧЬ в ролик вместе со
 * своим сдвигом от начала.
 *
 * ## Короткая реплика — не беда
 *
 * Тишина в хвосте штатна: она бывает и у оригинала, и подложка (музыка,
 * атмосфера ролика) под ней играет как ни в чём не бывало. Поэтому
 * недобор длины не считается дефектом вовсе — правила реагируют только
 * на перебор.
 *
 * ## Порядок ходов — из ТЗ, и он не случаен
 *
 * 1. Попросить перевод короче — ОДИН раз, с явным «на N процентов».
 *    Текст правится бесплатно и без потери качества звука.
 * 2. Только потом — подгонка темпа при сборке.
 * 3. Не вышло — не выдавать молча, а отдать оператору с причиной.
 *
 * ## Почему предел подгонки темпа именно такой
 *
 * `common/postprod.ts` в своё время сознательно отказался от `atempo`:
 * «ускорить речь на 20 %, чтобы она влезла, технически просто, но
 * звучит как испорченная запись». Это решение здесь не отменяется, а
 * уточняется: у альтернативной дорожки текста «под восемь секунд» нет
 * и быть не может — он задан оригиналом, — поэтому маленькая подгонка
 * остаётся последним средством. Предел — 10 %: вдвое меньше тех
 * двадцати, на которых прежнее решение поставило крест.
 *
 * Сама подгонка применяется НЕ отдельным проходом: сборка дорожки и
 * так задача ffmpeg, и `atempo` там — ещё один фильтр в том же
 * вызове, а не второй счёт.
 */

/** Допуск §5: переполнение в пределах этой доли длины ролика терпим. */
export const LENGTH_TOLERANCE = 0.05;

/** Предел подгонки темпа — см. шапку. */
export const MAX_TEMPO_CHANGE = 0.1;

export interface TrackFitInput {
  /**
   * Длительность синтезированной речи в секундах — измеренная
   * (`common/mp3-duration.ts`), не оценённая. `null` означает «измерить
   * не удалось»: решать по нему нельзя.
   */
  voiceSeconds: number | null;
  /** Длина ролика. */
  videoSeconds: number;
  /** Сдвиг речи от начала ролика — реплика редко начинается с нуля. */
  speechStartSeconds?: number;
  /** Просили ли уже перевод короче: второй раз просить не будем. */
  retranslated?: boolean;
}

export type TrackFit =
  /** Влезает — дорожку можно собирать. */
  | { action: 'accept'; overflowSeconds: number }
  /** Первый ход: перевести короче на столько процентов. */
  | { action: 'retranslate'; shorterByPercent: number; overflowSeconds: number }
  /** Второй ход: ускорить речь при сборке (atempo). */
  | { action: 'retempo'; rate: number; overflowSeconds: number }
  /** Не вышло — оператору, с причиной на человеческом языке. */
  | { action: 'handover'; reason: string; overflowSeconds: number };

/**
 * На сколько секунд речь вылезает за конец ролика. Отрицательное —
 * запас, то есть тишина в хвосте.
 */
export function overflowSeconds(input: TrackFitInput): number {
  const start = Math.max(0, input.speechStartSeconds ?? 0);
  return round((input.voiceSeconds ?? 0) + start - input.videoSeconds);
}

export function planTrackFit(input: TrackFitInput): TrackFit {
  if (input.voiceSeconds === null || !Number.isFinite(input.voiceSeconds)) {
    return {
      action: 'handover',
      reason: 'длительность дорожки измерить не удалось',
      overflowSeconds: 0,
    };
  }
  if (!(input.videoSeconds > 0)) {
    return {
      action: 'handover',
      reason: 'длина ролика неизвестна',
      overflowSeconds: 0,
    };
  }

  const overflow = overflowSeconds(input);
  // Недобор — не дефект: в хвосте играет подложка, как у оригинала.
  if (overflow <= input.videoSeconds * LENGTH_TOLERANCE) {
    return { action: 'accept', overflowSeconds: overflow };
  }

  const start = Math.max(0, input.speechStartSeconds ?? 0);
  // Сколько речи помещается: считаем от того, что реально осталось под
  // неё после сдвига, а не от всей длины ролика.
  const budget = input.videoSeconds * (1 + LENGTH_TOLERANCE) - start;
  if (budget <= 0) {
    return {
      action: 'handover',
      reason: 'реплика начинается позже конца ролика',
      overflowSeconds: overflow,
    };
  }

  const excess = input.voiceSeconds / budget - 1;

  if (!input.retranslated) {
    // Просим с запасом: модель почти никогда не попадает ровно, а
    // недобор безвреден — в отличие от перебора. Округляем вверх, чтобы
    // «на 3,2 %» не превратилось в «на 3 %» и не вернулось тем же.
    const shorterByPercent = Math.min(
      60,
      Math.max(5, Math.ceil(excess * 100) + 5),
    );
    return {
      action: 'retranslate',
      shorterByPercent,
      overflowSeconds: overflow,
    };
  }

  if (excess <= MAX_TEMPO_CHANGE) {
    // `atempo` больше единицы — ускорение: во сколько раз речь должна
    // стать быстрее, чтобы уложиться в оставшийся бюджет.
    return {
      action: 'retempo',
      rate: round(input.voiceSeconds / budget),
      overflowSeconds: overflow,
    };
  }

  return {
    action: 'handover',
    reason:
      `речь длиннее ролика на ${Math.round(excess * 100)} % даже после ` +
      'сокращения перевода — ускорение сверх 10 % звучит как испорченная запись',
    overflowSeconds: overflow,
  };
}

function round(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}
