/**
 * Субтитры альтернативной звуковой дорожки (этап 141, ТЗ
 * TZ-Multilingual-YouTube.md §9, последний пункт «Делаем» этапа 138).
 *
 * ## Откуда берётся тайминг — и откуда он брался до аудита
 *
 * Первая редакция раскладывала строки ПЕРЕВОДА по секундам ОРИГИНАЛА и
 * растягивала их до конца ролика. Обе половины были неверны, и аудит
 * этапа это показал:
 *
 * - раскладка считалась по длине строк оригинала, хотя звучит в этой
 *   дорожке перевод, и его строки другой длины;
 * - конец последнего субтитра ставился в конец ролика, хотя речь может
 *   кончиться заметно раньше — недобор у альтернативной дорожки штатен
 *   (этап 138: «тишина в хвосте штатна, под ней играет подложка»). На
 *   короткой реплике субтитр отставал от голоса на секунды.
 *
 * Теперь тайминг берётся у САМОЙ речи, и в первую очередь — настоящий:
 * синтез возвращает посимвольную разметку (`SynthesisResult.alignment`)
 * тем же вызовом, за который уже заплачено. Продукт давно так и делает
 * для вшитых субтитров (`PostProductionService`), а дорожка эту
 * разметку просто выбрасывала.
 *
 * Разметка отсчитывается от начала файла голоса, а в миксе голос
 * сначала ускоряется (`atempo`), потом сдвигается (`adelay`) — порядок
 * задан в `common/postprod.ts`. Значит секунда субтитра — это
 * `speechStartSeconds + t / tempoRate`.
 *
 * Провайдер разметки не дал — остаётся прикидка по длине строк, но уже
 * по строкам перевода и внутри ИЗМЕРЕННОГО отрезка речи, а не до конца
 * ролика.
 *
 * ## Почему файл кладётся в строку дорожки, а не считается на лету
 *
 * Дорожка переживает TTL сессии (`sessionId` без внешнего ключа), а
 * сессия — источник и сценария, и длины ролика. Считать субтитр на
 * чтении значило бы потерять его ровно тогда, когда оператор до него
 * дойдёт. Та же причина, по которой рядом лежит `speech`.
 */

import { SubtitleAlignment, buildSrt } from '../../common/subtitles';
import { cueTimings, heuristicCueTimings } from '../../common/voiceover-script';

export interface TrackSubtitlesInput {
  /** Переведённая реплика — то, что звучит в этой дорожке. */
  speech: string;
  /** Секунда, на которой голос вступает в миксе (`adelay`). */
  speechStartSeconds: number;
  /** Длина ролика: дальше неё субтитра быть не может. */
  videoSeconds: number;
  /** Измеренная длина речи ДО ускорения. Пусто — измерить не удалось. */
  voiceSeconds: number | null;
  /** Во сколько раз речь ускорят при сборке (`atempo`). */
  tempoRate: number | null;
  /** Посимвольная разметка синтеза, если провайдер её дал. */
  alignment?: SubtitleAlignment;
}

/** `.srt` дорожки. `null` — говорить нечего, субтитру взяться неоткуда. */
export function buildTrackSubtitles(input: TrackSubtitlesInput): string | null {
  // Ускорение ноль или отрицательное — это не ускорение, а деление на
  // ноль в секундах субтитра.
  const tempo = input.tempoRate && input.tempoRate > 0 ? input.tempoRate : 1;
  const start = input.speechStartSeconds;

  const cues = input.alignment
    ? cueTimings(input.speech, input.alignment).map((cue) => ({
        ...cue,
        startSeconds: shift(cue.startSeconds, start, tempo, input.videoSeconds),
        endSeconds: shift(cue.endSeconds, start, tempo, input.videoSeconds),
      }))
    : heuristicCueTimings(input.speech, start, spokenEnd(input, tempo));

  return buildSrt(cues).trim() || null;
}

/** Секунда разметки → секунда ролика. Дальше конца ролика её нет. */
function shift(
  seconds: number,
  start: number,
  tempo: number,
  videoSeconds: number,
): number {
  return Math.min(start + seconds / tempo, videoSeconds);
}

/**
 * Где речь кончается на самом деле. Длину не измерили — остаётся конец
 * ролика: растянутый субтитр хуже точного, но лучше обрезанного.
 */
function spokenEnd(input: TrackSubtitlesInput, tempo: number): number {
  if (input.voiceSeconds === null) return input.videoSeconds;
  return Math.min(
    input.speechStartSeconds + input.voiceSeconds / tempo,
    input.videoSeconds,
  );
}
