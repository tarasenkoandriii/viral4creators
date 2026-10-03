/**
 * Стык iframe-чата с ленивым чанком голоса `dist/v1/voice.js` (Э5, ТЗ
 * помощника §4.10, §5-бис.7). Только типы: чат грузит чанк `import()` по
 * первому нажатию микрофона/озвучки (или заранее, когда голос включён в
 * конфиге — чтобы `getUserMedia` и разблокировка звука шли в том же
 * жесте пользователя, иначе iOS Safari откажет).
 */

/** Параметры записи — из конфига сервера (`voice` в `GET /widget/v1/config`). */
export interface RecordLimits {
  maxRecordMs: number;
  minSpeechMs: number;
  endSilenceMs: number;
  /**
   * Э6-бис (§5-бис.5 «стоп всегда»): начало речи — сразу, ДО конца фразы и
   * распознавания (детектор на устройстве ставит план на паузу).
   */
  onSpeech?: () => void;
}

export type RecordEnd =
  /** Фраза закончилась тишиной или кнопкой — есть запись. */
  | { reason: 'ok'; blob: Blob; speechMs: number }
  | { reason: 'max'; blob: Blob; speechMs: number }
  /** Речи не было или она короче minSpeechMs — запись выброшена на устройстве. */
  | { reason: 'short' }
  /** Бросили без отправки. */
  | { reason: 'cancel' }
  /** Микрофон недоступен: запрещён, нет устройства, политика сайта. */
  | {
      reason: 'error';
      code: 'denied' | 'no_device' | 'unsupported' | 'failed';
    };

export interface Recording {
  /** Закончить фразу сейчас (запись уйдёт на распознавание). */
  stop(): void;
  /** Бросить без отправки (закрыли чат, ушли со вкладки, включили в другой). */
  cancel(): void;
}

export interface VoiceEngine {
  /** Есть ли в браузере всё нужное: getUserMedia + MediaRecorder. */
  canRecord(): boolean;
  /**
   * Начать запись (вызывать синхронно из обработчика нажатия). `onLevel` —
   * уровень 0…1 для индикатора; `onEnd` — ровно один раз.
   */
  record(
    limits: RecordLimits,
    onLevel: (level: number) => void,
    onEnd: (end: RecordEnd) => void
  ): Recording;
  /** Разблокировать воспроизведение — синхронно в жесте пользователя. */
  unlock(): void;
  /** Проиграть mp3/wav ответа; `onEnd` — конец или ошибка. */
  play(bytes: ArrayBuffer, onEnd: () => void): void;
  stopPlayback(): void;
}

export type CreateVoice = () => VoiceEngine;
