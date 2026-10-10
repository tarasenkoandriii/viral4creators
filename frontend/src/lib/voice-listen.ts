/**
 * Детектор речи на устройстве — условие 2 решения В-15 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.7.5:
 * «на сервер — только речь; двадцать секунд тишины меряются тоже на
 * телефоне».
 *
 * Энергетический детектор (RMS кадра против порога над уровнем шума) с
 * «хвостом» (hangover) и минимальной длиной речи — по образцу
 * `silence-watchdog` Devil's Advocate, где диктовка сама останавливается
 * после долгой тишины. Не нейросеть и не Web Speech API (§4А.3: его нет и
 * в DA): задача не понять слова, а не отправить на платное распознавание
 * тишину, шум вентилятора и хлопок двери.
 *
 * Модуль чистый: кадры приходят числами, время — счётом кадров, без
 * `Date.now()` и без Web Audio. Поэтому правила «сколько тишины — конец
 * фразы» и «20 с — микрофон гаснет» проверяются синтетическими кадрами
 * (`scripts/voice-listen.test.ts`), а не голосом в браузере.
 */

export interface SpeechDetectorConfig {
  /** Длина кадра, мс: столько времени покрывает одно значение RMS. */
  frameMs: number;
  /** Порог речи не ниже этого RMS, как бы тихо ни было вокруг. */
  minRms: number;
  /** Речь — кадр громче уровня шума во столько раз. */
  noiseFactor: number;
  /** Скорость подстройки уровня шума по тихим кадрам (0..1). */
  noiseAdapt: number;
  /**
   * Запись начинается с кадра громче `порог × onsetRatio` — раньше, чем
   * кадр признан речью: у «да» мягкое начало, и `MediaRecorder` задним
   * числом его не допишет (замена буфера предзаписи, аудит волны 1).
   */
  onsetRatio: number;
  /** Отрезок, в котором речевых кадров меньше, — шум, на сервер не уходит. */
  minSpeechMs: number;
  /** Столько тишины внутри фразы — фраза кончилась. */
  hangoverMs: number;
  /** Потолок отрезка: дольше — режем и отправляем, что есть. */
  maxUtteranceMs: number;
  /** Столько тишины без фразы — микрофон гаснет (В-15). */
  idleStopMs: number;
  /**
   * Перебивание советника: пока звучит его реплика, речью человека
   * считается только кадр громче `порог × bargeInFactor`, и не короче
   * `bargeInMs` подряд — остаток реплики в динамике после эхоподавления
   * так громко не бывает.
   */
  bargeInFactor: number;
  bargeInMs: number;
}

export const SPEECH_DETECTOR_DEFAULTS: SpeechDetectorConfig = {
  frameMs: 50,
  // ≈ −36 dBFS: обычная речь в полуметре от телефона заметно выше, фон
  // тихой комнаты — ниже. Абсолютный пол нужен, чтобы в идеальной
  // тишине порог не опустился до шороха одежды.
  minRms: 0.015,
  noiseFactor: 3,
  noiseAdapt: 0.05,
  onsetRatio: 0.6,
  // Короткое «да» — около 150–200 мс звонкой части; хлопок и щелчок —
  // один-два кадра. Раньше было 250, и «да» терялось (аудит волны 1).
  minSpeechMs: 150,
  // Пауза между словами в спокойной речи — до полусекунды; 0,9 с не
  // режет фразу на вдохе, но и не держит человека в ожидании ответа.
  hangoverMs: 900,
  // Реплика — ответ или команда, но и поздравительный текст голосом:
  // 15 с его обрезали. 45 с — с запасом до потолка сервера
  // (`VOICE_UTTERANCE_MAX_MS` = 60 с, изменение контракта 4): клиент
  // режет раньше, и до отказа `too-long` честная запись не доходит.
  // Обрезанная фраза всё равно уходит на разбор — с предупреждением.
  maxUtteranceMs: 45_000,
  idleStopMs: 20_000,
  bargeInFactor: 2,
  bargeInMs: 150,
};

export interface SpeechDetectorState {
  phase: 'idle' | 'speech';
  /** Оценка уровня шума (RMS), подстраивается по тихим кадрам. */
  noiseFloor: number;
  /** Тишина без фразы, мс — счётчик до `idleStopMs`. */
  quietMs: number;
  /** Длина текущего отрезка (с первого кадра над порогом начала), мс. */
  utterMs: number;
  /** Сколько в текущем отрезке речевых кадров, мс. */
  speechMs: number;
  /** Тишина подряд внутри текущего отрезка, мс. */
  silenceMs: number;
  /** Сумма RMS кадров отрезка — чтобы гул, не ставший речью, учил шум. */
  segRmsSum: number;
  /** Громкая речь подряд поверх реплики советника, мс. */
  bargeMs: number;
  /** Микрофон погашен тишиной; дальше кадры не принимаются. */
  stopped: boolean;
}

export type SpeechDetectorEvent =
  /** Кадр над порогом начала — начать запись (кандидат во фразу). */
  | { type: 'start' }
  /**
   * Отрезок кончился. `keep: false` — шум или отрезок, накрытый репликой
   * советника: запись выбросить, на сервер не отправлять.
   */
  | {
      type: 'end';
      keep: boolean;
      reason: 'silence' | 'max-length' | 'playback';
      speechMs: number;
      durationMs: number;
    }
  /** Человек заговорил поверх советника — заглушить реплику. */
  | { type: 'barge-in' }
  /** 20 с без речи — погасить микрофон, ждать кнопку. */
  | { type: 'idle-timeout' };

export function initialDetector(
  config: SpeechDetectorConfig = SPEECH_DETECTOR_DEFAULTS
): SpeechDetectorState {
  return {
    phase: 'idle',
    noiseFloor: config.minRms / config.noiseFactor,
    quietMs: 0,
    utterMs: 0,
    speechMs: 0,
    silenceMs: 0,
    segRmsSum: 0,
    bargeMs: 0,
    stopped: false,
  };
}

/** Порог речи для текущего уровня шума. */
export function speechThreshold(
  noiseFloor: number,
  config: SpeechDetectorConfig
): number {
  return Math.max(config.minRms, noiseFloor * config.noiseFactor);
}

const idleOf = (state: SpeechDetectorState): SpeechDetectorState => ({
  ...state,
  phase: 'idle',
  utterMs: 0,
  speechMs: 0,
  silenceMs: 0,
  segRmsSum: 0,
  bargeMs: 0,
});

/**
 * Один кадр. Возвращает новое состояние и события, которые хук
 * превращает в действия с `MediaRecorder`.
 *
 * `playing` — звучит реплика советника (K1). Пока она звучит, отрезок
 * не начинается вовсе: иначе советник, услышанный микрофоном, ушёл бы на
 * платный разбор как реплика человека. Громкая речь поверх — перебивание
 * (`barge-in`): хук глушит советника, а слушать начинает заново, с
 * чистого отрезка.
 */
export function stepDetector(
  state: SpeechDetectorState,
  rms: number,
  config: SpeechDetectorConfig = SPEECH_DETECTOR_DEFAULTS,
  playing = false
): { state: SpeechDetectorState; events: SpeechDetectorEvent[] } {
  if (state.stopped) return { state, events: [] };
  const threshold = speechThreshold(state.noiseFloor, config);
  const loud = rms >= threshold;

  if (playing) {
    if (state.phase === 'speech') {
      // Советник заговорил посреди отрезка — отрезок уже не чистый.
      return {
        state: { ...idleOf(state), quietMs: 0 },
        events: [
          {
            type: 'end',
            keep: false,
            reason: 'playback',
            speechMs: state.speechMs,
            durationMs: state.utterMs,
          },
        ],
      };
    }
    const strong = rms >= threshold * config.bargeInFactor;
    const bargeMs = strong ? state.bargeMs + config.frameMs : 0;
    // Пока говорит советник, человек не молчит, а слушает: 20 с тишины
    // считаются после реплики, а не во время неё.
    if (bargeMs >= config.bargeInMs) {
      return {
        state: { ...state, quietMs: 0, bargeMs: 0 },
        events: [{ type: 'barge-in' }],
      };
    }
    return { state: { ...state, quietMs: 0, bargeMs }, events: [] };
  }

  if (state.phase === 'idle') {
    if (rms >= threshold * config.onsetRatio) {
      // Запись начинается с ПЕРВОГО кадра над порогом начала, а не после
      // `minSpeechMs`: `MediaRecorder` не пишет задним числом, и начало
      // слова иначе терялось бы. Короткий шум потом просто выбрасывается.
      return {
        state: {
          ...state,
          phase: 'speech',
          utterMs: config.frameMs,
          speechMs: loud ? config.frameMs : 0,
          silenceMs: loud ? 0 : config.frameMs,
          segRmsSum: rms,
          bargeMs: 0,
        },
        events: [{ type: 'start' }],
      };
    }
    // Уровень шума учится только на тишине вне фразы: внутри фразы паузы
    // между словами подняли бы его к голосу, и конец фразы не наступил бы.
    const noiseFloor =
      state.noiseFloor + config.noiseAdapt * (rms - state.noiseFloor);
    const quietMs = state.quietMs + config.frameMs;
    if (quietMs >= config.idleStopMs) {
      return {
        state: { ...state, noiseFloor, quietMs, stopped: true, bargeMs: 0 },
        events: [{ type: 'idle-timeout' }],
      };
    }
    return { state: { ...state, noiseFloor, quietMs, bargeMs: 0 }, events: [] };
  }

  const utterMs = state.utterMs + config.frameMs;
  const speechMs = state.speechMs + (loud ? config.frameMs : 0);
  const silenceMs = loud ? 0 : state.silenceMs + config.frameMs;
  const segRmsSum = state.segRmsSum + rms;
  const reason: 'silence' | 'max-length' | null =
    silenceMs >= config.hangoverMs
      ? 'silence'
      : utterMs >= config.maxUtteranceMs
        ? 'max-length'
        : null;
  if (!reason) {
    return {
      state: { ...state, utterMs, speechMs, silenceMs, segRmsSum },
      events: [],
    };
  }
  const keep = speechMs >= config.minSpeechMs;
  // Отрезок, в котором не было ни одного речевого кадра, — ровный гул
  // между порогом начала и порогом речи. Он учит уровень шума так же,
  // как тишина (та же формула, применённая по разу на кадр), иначе гул
  // открывал бы запись каждую секунду до самого выключения.
  let noiseFloor = state.noiseFloor;
  if (speechMs === 0) {
    const frames = utterMs / config.frameMs;
    const mean = segRmsSum / frames;
    noiseFloor =
      mean + (noiseFloor - mean) * Math.pow(1 - config.noiseAdapt, frames);
  }
  return {
    state: {
      ...idleOf(state),
      noiseFloor,
      // Речь обнуляет счёт тишины; шум — нет: хлопок двери не должен
      // продлевать открытый микрофон ещё на двадцать секунд. Время
      // отрезка-шума идёт в тишину целиком.
      quietMs: keep ? 0 : state.quietMs + utterMs,
    },
    events: [{ type: 'end', keep, reason, speechMs, durationMs: utterMs }],
  };
}

/**
 * Кадр, пока микрофон нужен другому (изменение контракта 5: запись
 * образца голоса, `isMicBusy`): детектор на паузе так же, как под
 * репликой советника, но без перебивания — человек говорит не нам.
 * Начатый отрезок выбрасывается (`end`, `keep: false`): в нём уже
 * голос, записанный для образца, а не реплика помощнику. Тишина на это
 * время не копится — 20 с считаются после записи, а не во время неё.
 */
export function pauseDetector(state: SpeechDetectorState): {
  state: SpeechDetectorState;
  events: SpeechDetectorEvent[];
} {
  if (state.stopped) return { state, events: [] };
  if (state.phase === 'speech') {
    return {
      state: { ...idleOf(state), quietMs: 0 },
      events: [
        {
          type: 'end',
          keep: false,
          reason: 'playback',
          speechMs: state.speechMs,
          durationMs: state.utterMs,
        },
      ],
    };
  }
  return { state: { ...state, quietMs: 0, bargeMs: 0 }, events: [] };
}

/**
 * Снова слушать после ответа помощника: 20 с считаются с этого момента,
 * а не с конца фразы — пока шёл разбор, человек ждал, а не молчал.
 */
export function resumeDetector(
  state: SpeechDetectorState
): SpeechDetectorState {
  return { ...idleOf(state), quietMs: 0, stopped: false };
}

/** Среднеквадратичная амплитуда кадра (`getFloatTimeDomainData`, −1..1). */
export function rmsOf(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Потолок байт отрезка по типу — зеркало `greetingVoiceMaxBytesFor`
 * сервера (`backend/src/common/greeting-voice.ts`; сверка —
 * `scripts/voice-sync.test.ts`): минута речи по щедрому битрейту типа,
 * но не больше общих 4 МБ. Отрезок больше — сервер откажет ещё на
 * выдаче ссылки загрузки, поэтому клиент его не шлёт вовсе, а сразу
 * говорит «слишком длинно».
 */
export const VOICE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const VOICE_UPLOAD_MAX_MS = 60_000;
const VOICE_BYTES_PER_SECOND: Readonly<Record<string, number>> = {
  'audio/webm': 24_000,
  'audio/ogg': 24_000,
  'audio/opus': 24_000,
  'audio/mp4': 32_000,
  'audio/m4a': 32_000,
  'audio/x-m4a': 32_000,
  'audio/aac': 32_000,
  'audio/mpeg': 40_000,
  'audio/mp3': 40_000,
  'audio/wav': 96_000,
  'audio/flac': 96_000,
};

export function voiceMaxBytesFor(mimeType: string | null | undefined): number {
  const base = String(mimeType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const rate = VOICE_BYTES_PER_SECOND[base];
  if (!rate) return VOICE_UPLOAD_MAX_BYTES;
  return Math.min(
    VOICE_UPLOAD_MAX_BYTES,
    Math.ceil((rate * VOICE_UPLOAD_MAX_MS) / 1000)
  );
}

/**
 * Формат записи — первый, который умеет браузер. Тот же список, что у
 * голосового описания товара (`ItemScreen.tsx`), и те же форматы, что
 * принимает сервер (`ALLOWED_AUDIO_MIME`).
 */
export const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

/**
 * `null` — ни один из списка не подтверждён: тогда `MediaRecorder`
 * создаётся без `mimeType` (формат выберет браузер, узнаётся из
 * `rec.mimeType`). Навязать «audio/webm» браузеру, который его не умеет
 * (старый Safari), значило бы исключение в конструкторе и мёртвый
 * микрофон.
 */
export function pickRecorderMime(
  isSupported: (mime: string) => boolean
): string | null {
  for (const c of RECORDER_MIME_CANDIDATES) {
    try {
      if (isSupported(c)) return c;
    } catch {
      /* Старые WebView могут бросать. */
    }
  }
  return null;
}
