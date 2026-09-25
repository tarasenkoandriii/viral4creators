/**
 * Ролик на других языках — чистые правила панели (этап 148,
 * TODO §III п.12).
 *
 * Отдельно от компонента по той же причине, что и у ключей API: у
 * фронтенда тесты — обычные скрипты, и всё, что можно из компонента
 * вынести, проверяется ими, а не глазами.
 */

export interface AudioTrackView {
  id: string;
  locale: string;
  status: string;
  /** Что произносит дорожка — по ней человек понимает, что заливает. */
  speech: string | null;
  /** Готовый полный звук; пока его нет — заливать нечем. */
  trackUrl: string | null;
  /** Только голос: полезен, когда сборка не удалась, а речь есть. */
  voiceUrl: string | null;
  /** Субтитры этого языка (этап 141). */
  subtitlesSrt: string | null;
  mixing: boolean;
  /** Собрана для ПРЕЖНЕЙ версии ролика — заливать её нельзя. */
  stale: boolean;
  voiceSeconds: number | null;
  overflowSeconds: number | null;
  tempoRate: number | null;
  attempts: number;
  note: string | null;
  mixError: string | null;
  uploadedAt: string | null;
  uploadedById: string | null;
}

export interface AudioTracksResult {
  sourceLocale: string;
  /** Локали, которые есть смысл собрать сейчас — считает сервер. */
  toBuild: string[];
  tracks: AudioTrackView[];
}

export type TrackState =
  | 'stale'
  | 'mixing'
  | 'handover'
  | 'failed'
  | 'ready'
  | 'voiceOnly';

/**
 * Состояние строки. Порядок проверок важнее самих проверок:
 * «устаревшая» идёт первой, потому что у дорожки от прежней версии
 * ролика «готова» — вранье худшее, чем молчание (находка аудита этапа
 * 139 у операторского экрана; правило то же и здесь).
 */
export function trackState(track: AudioTrackView): TrackState {
  if (track.stale) return 'stale';
  if (track.mixing) return 'mixing';
  if (track.status === 'HANDOVER') return 'handover';
  if (track.status === 'FAILED') return 'failed';
  return track.trackUrl ? 'ready' : 'voiceOnly';
}

/**
 * Стоит ли опрашивать сервер дальше.
 *
 * Только пока что-то собирается. Экран, который опрашивает вечно,
 * тратит чужой ffmpeg и наш счёт на каждом открытом окне — а узнать
 * ему уже нечего.
 */
export function needsPolling(result: AudioTracksResult | null): boolean {
  return !!result?.tracks.some((t) => t.mixing);
}

/** Можно ли скачивать и заливать эту дорожку. */
export function isDownloadable(track: AudioTrackView): boolean {
  return trackState(track) === 'ready';
}

/**
 * Языки, которые предлагаем собрать.
 *
 * Основной список считает сервер (`toBuild`), но одно он туда
 * намеренно включает: язык, у которого сборка ИДЁТ ПРЯМО СЕЙЧАС —
 * «задача есть, файла нет» для него неотличимо от «файла нет вовсе».
 * Оператору это безразлично (он открывает список раз в несколько
 * минут), а здесь рядом оказались бы строка «собирается» и кнопка
 * «Собрать» на тот же язык — и «собрать недостающие» заказала бы и
 * оплатила вторую сборку того, что уже собирается.
 */
export function buildable(result: AudioTracksResult | null): string[] {
  if (!result) return [];
  const mixing = new Set(
    result.tracks.filter((t) => t.mixing).map((t) => t.locale)
  );
  return result.toBuild.filter((locale) => !mixing.has(locale));
}

/**
 * Ссылка для скачивания субтитров.
 *
 * Субтитры приходят не адресом, а текстом (этап 141), поэтому браузеру
 * их отдаём `data:`-ссылкой: она не требует отзыва, в отличие от
 * `blob:` (см. `lib/object-url.ts`), а файл здесь — килобайты.
 *
 * `stale` закрывает и субтитры тоже. Они размечены по хронометражу
 * ПРЕЖНЕЙ версии ролика: залитые к новой, они разъедутся с картинкой —
 * а выглядеть при этом будут исправными, и человек поймёт это уже от
 * зрителей.
 */
export function subtitlesHref(track: AudioTrackView): string | null {
  if (track.stale || !track.subtitlesSrt) return null;
  return `data:text/plain;charset=utf-8,${encodeURIComponent(track.subtitlesSrt)}`;
}

/** Имя скачиваемого файла субтитров: язык человеку виден в списке. */
export function subtitlesFileName(track: AudioTrackView): string {
  return `${track.locale}.srt`;
}

/**
 * Что панель показывает при данном тарифе и состоянии ролика.
 *
 * Отдельной функцией, а не клубком `if`-ов в компоненте: аудит этапа
 * 148 нашёл здесь ДВЕ ошибки подряд (А-1 и А-6), и обе одного рода —
 * право СОБИРАТЬ закрывало ПРОСМОТР уже собранного. Пока правило жило
 * в разметке, проверить его можно было только глазами; тут оно под
 * тестом.
 *
 * - `hidden` — панели нет вовсе;
 * - `locked` — только замок: собирать нельзя и показывать нечего;
 * - `locked-list` — дорожки видны и скачиваются, вместо кнопок замок;
 * - `list` — дорожки видны, но замок не рисуем: режим неизвестен, и
 *   подпись «доступно в Premium» была бы выдумкой;
 * - `full` — всё.
 */
export type PanelAccess = 'hidden' | 'locked' | 'locked-list' | 'list' | 'full';

export function panelAccess(input: {
  /** Постобработка ролика завершена — раньше собирать нечего и рано. */
  videoReady: boolean;
  /** Матрица режимов ещё не пришла ИЛИ не загрузилась. */
  planLoading: boolean;
  /** Именно НЕ ЗАГРУЗИЛАСЬ: по одному `planLoading` это неотличимо. */
  planFailed: boolean;
  allowed: boolean;
  hasTracks: boolean;
}): PanelAccess {
  if (!input.videoReady) return 'hidden';
  // Ещё грузится — честнее не рисовать ни кнопку, ни замок, чем мигнуть
  // замком у премиум-пользователя.
  if (input.planLoading && !input.planFailed) return 'hidden';
  if (input.allowed) return 'full';
  if (!input.hasTracks) return input.planFailed ? 'hidden' : 'locked';
  return input.planFailed ? 'list' : 'locked-list';
}

/**
 * Предлагать ли отдельный файл голоса.
 *
 * Только когда полной дорожки нет. Рядом с готовой он ловушка: это речь
 * без подложки, и залитый вместо дорожки он даёт ролик без фона —
 * заметить это можно только по уже опубликованному результату (аудит
 * этапа 148, А-4). Когда сборка не удалась, он, наоборот, полезен:
 * человек сведёт звук сам, не дожидаясь нашего ffmpeg. У устаревшей
 * закрыт и он — голос там от прежнего ролика.
 */
export function offersVoice(track: AudioTrackView): boolean {
  if (isDownloadable(track)) return false;
  if (trackState(track) === 'stale') return false;
  return !!track.voiceUrl;
}
