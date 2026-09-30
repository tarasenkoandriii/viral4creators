/**
 * Прослушивание мастера поздравления — исполнитель решения В-15 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.7.5.
 *
 * Что допустимо — решают чистые модули: режим — `lib/voice-listen-mode.ts`,
 * где кончается фраза и когда гаснуть — `lib/voice-listen.ts`. Здесь
 * только браузер: поток микрофона, `AnalyserNode` для громкости кадра,
 * `MediaRecorder` для отрезка речи и уборка всего этого.
 *
 * Уборка — главное. Микрофон принадлежит вкладке, а не компоненту
 * (этап 119, `lib/mic-recorder.ts`): снятый экран, уход по степперу,
 * свёрнутый Telegram — и поток обязан закрыться, иначе индикатор
 * микрофона горит, а условие 3 В-15 («открытый микрофон видно всегда»)
 * нарушено в худшую сторону: открыт, а на экране этого уже нет.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { releaseMicrophone } from '../../lib/mic-recorder';
import {
  SPEECH_DETECTOR_DEFAULTS,
  initialDetector,
  pickRecorderMime,
  pauseDetector,
  resumeDetector,
  rmsOf,
  stepDetector,
  voiceMaxBytesFor,
  type SpeechDetectorEvent,
  type SpeechDetectorState,
} from '../../lib/voice-listen';
import {
  LISTEN_INITIAL,
  autoListenDecision,
  listenReducer,
  isCurrentUtterance,
  watchPageHidden,
  type ListenEvent,
  type ListenState,
  type MicPermission,
} from '../../lib/voice-listen-mode';
import { getTelegramWebApp } from '../../lib/telegram';
import { isMicBusy } from '../../lib/media-playback';

const ARMED_KEY = 'greeting-voice-listen-armed';
const CONFIG = SPEECH_DETECTOR_DEFAULTS;

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function listeningSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    audioContextCtor() !== null
  );
}

// localStorage — с try/catch: приватный режим и WebView без хранилища
// бросают на чтении, а прослушивание без памяти просто ждёт нажатия.
function readArmed(): boolean {
  try {
    return localStorage.getItem(ARMED_KEY) === '1';
  } catch {
    return false;
  }
}
function storeArmed(): void {
  try {
    localStorage.setItem(ARMED_KEY, '1');
  } catch {
    /* без памяти — каждый раз по нажатию */
  }
}

async function micPermission(): Promise<MicPermission> {
  try {
    const status = await navigator.permissions?.query({
      name: 'microphone' as PermissionName,
    });
    return status ? (status.state as MicPermission) : 'unknown';
  } catch {
    // Safari до 16 и часть WebView не знают имени `microphone`.
    return 'unknown';
  }
}

export interface VoiceListening {
  state: ListenState;
  /** Нажатие «управление голосом» — единственный путь к окну разрешения. */
  enable: () => void;
  /** Одно касание — микрофон закрыт (условие 3 В-15). */
  disable: () => void;
  /** Ручной путь: «сказать одну фразу» — и «готово». */
  talkStart: () => void;
  talkStop: () => void;
  /** Потолок голоса исчерпан — закрыть и не открывать до перезагрузки. */
  budgetExhausted: () => void;
  /** Потолок снят (сменился тариф) — кнопка снова работает. */
  unblock: () => void;
}

/** Голос советника (K1) — чтобы не записать его как реплику человека. */
export interface VoicePlayback {
  isPlaying: () => boolean;
  stop: () => void;
}

/** Что известно об отрезке, кроме звука. */
export interface UtteranceMeta {
  /**
   * Фраза упёрлась в потолок длины (`maxUtteranceMs`) и обрезана:
   * отправлена как есть, а человеку стоит проверить, что поняли всё
   * (изменение контракта 4).
   */
  truncated: boolean;
  /**
   * Отрезок больше серверного потолка своего типа
   * (`voiceMaxBytesFor`): загружать его незачем — сервер откажет. Звук
   * не отправляется, помощник говорит «слишком длинно».
   */
  tooLarge: boolean;
}

export function useVoiceListening(opts: {
  /** Голос включён («голосом» советника). Выключили — микрофон закрыт. */
  active: boolean;
  /** Потолок на сегодня уже исчерпан (память устройства). */
  blocked: boolean;
  /**
   * Отрезок речи готов; прослушивание ждёт, пока промис не завершится.
   * `isCurrent()` — ответ ещё нужен: после выключения или нового отрезка
   * результат выбрасывается, а не показывается.
   */
  onUtterance: (
    audio: Blob,
    mimeType: string,
    isCurrent: () => boolean,
    meta: UtteranceMeta
  ) => Promise<void>;
  playback?: VoicePlayback;
  /**
   * Микрофон занят другой записью (образец голоса) — детектор на паузе,
   * начатый отрезок выбрасывается. По умолчанию — общий `isMicBusy`.
   */
  micBusy?: () => boolean;
}): VoiceListening {
  const supported = listeningSupported();
  const [state, setState] = useState<ListenState>(() =>
    supported ? LISTEN_INITIAL : { ...LISTEN_INITIAL, phase: 'unsupported' }
  );
  // Интервал кадров и колбэки `MediaRecorder` живут вне рендера — им
  // нужен текущий режим, а не тот, что был в замыкании.
  const stateRef = useRef(state);
  const apply = useCallback((event: ListenEvent) => {
    const next = listenReducer(stateRef.current, event);
    stateRef.current = next;
    setState(next);
  }, []);

  const onUtteranceRef = useRef(opts.onUtterance);
  onUtteranceRef.current = opts.onUtterance;
  const playbackRef = useRef(opts.playback);
  playbackRef.current = opts.playback;
  const micBusyRef = useRef(opts.micBusy ?? isMicBusy);
  micBusyRef.current = opts.micBusy ?? isMicBusy;

  const mountedRef = useRef(true);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const detectorRef = useRef<SpeechDetectorState>(initialDetector(CONFIG));
  const talkTimerRef = useRef<number | null>(null);
  const talkStartedRef = useRef(0);
  /**
   * Номер запроса микрофона. Выключили и снова включили, пока браузер
   * держал окно разрешения, — первый `getUserMedia` вернётся позже
   * второго, и без номера у вкладки оказалось бы два потока, один из
   * которых никто никогда не закроет (аудит волны 1).
   */
  const requestRef = useRef(0);

  const releaseAll = useCallback(() => {
    requestRef.current += 1;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    if (talkTimerRef.current !== null)
      window.clearTimeout(talkTimerRef.current);
    talkTimerRef.current = null;
    // Прерванная посреди фразы запись выбрасывается (обработчики снимает
    // `releaseMicrophone`); уже остановленная — доедет до сервера сама.
    const interrupted = releaseMicrophone(
      recorderRef.current,
      streamRef.current
    );
    if (interrupted) chunksRef.current = [];
    // Поток общий на все фразы, и его дорожки не останавливает ничей
    // `onstop` — закрываем явно в любом случае.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    recorderRef.current = null;
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
  }, []);

  const process = useCallback(
    async (
      blob: Blob,
      mime: string,
      seq: number,
      meta: Omit<UtteranceMeta, 'tooLarge'>
    ) => {
      const isCurrent = () =>
        mountedRef.current && isCurrentUtterance(stateRef.current, seq);
      try {
        if (blob.size > 0 && isCurrent()) {
          await onUtteranceRef.current(blob, mime, isCurrent, {
            ...meta,
            tooLarge: blob.size > voiceMaxBytesFor(mime),
          });
        }
      } finally {
        if (mountedRef.current && isCurrent()) {
          apply({ type: 'processed', seq });
          const phase = stateRef.current.phase;
          if (phase === 'listening') {
            detectorRef.current = resumeDetector(detectorRef.current);
          } else if (phase === 'off') {
            // Ручная фраза разобрана — микрофон уже отпущен, добираем
            // остатки (контекст, таймеры), если что-то осталось.
            releaseAll();
          }
        }
      }
    },
    [apply, releaseAll]
  );

  const startRecorder = useCallback((stream: MediaStream): boolean => {
    try {
      const mime = pickRecorderMime(
        (m) => MediaRecorder.isTypeSupported?.(m) ?? false
      );
      // Ни один формат не подтверждён — пусть браузер выберет сам, чем
      // упасть в конструкторе; формат потом берётся из `rec.mimeType`.
      const rec = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      const chunks: Blob[] = [];
      chunksRef.current = chunks;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.start();
      recorderRef.current = rec;
      return true;
    } catch {
      return false;
    }
  }, []);

  /**
   * Остановить отрезок: `keep` — отправить, иначе выбросить. `seq` —
   * номер отрезка, уже присвоенный режимом. `releaseStream` — ручная
   * фраза: поток больше не нужен, и микрофон гаснет сразу по «Готово»,
   * а не после ответа сервера.
   */
  const stopRecorder = useCallback(
    (keep: boolean, seq: number, releaseStream = false, truncated = false) => {
      const rec = recorderRef.current;
      recorderRef.current = null;
      if (!rec) return;
      if (!keep) {
        rec.ondataavailable = null;
        rec.onstop = null;
        if (rec.state !== 'inactive') rec.stop();
        chunksRef.current = [];
        return;
      }
      const chunks = chunksRef.current;
      const stream = releaseStream ? streamRef.current : null;
      rec.onstop = () => {
        if (stream) {
          stream.getTracks().forEach((t) => t.stop());
          if (streamRef.current === stream) streamRef.current = null;
        }
        const mime = rec.mimeType || 'audio/webm';
        void process(new Blob(chunks, { type: mime }), mime, seq, {
          truncated,
        });
      };
      if (rec.state !== 'inactive') rec.stop();
    },
    [process]
  );

  const onDetector = useCallback(
    (event: SpeechDetectorEvent, stream: MediaStream) => {
      switch (event.type) {
        case 'start':
          if (startRecorder(stream)) apply({ type: 'speech-start' });
          return;
        case 'end':
          apply({ type: 'utterance', keep: event.keep });
          stopRecorder(
            event.keep,
            stateRef.current.seq,
            false,
            event.reason === 'max-length'
          );
          return;
        case 'barge-in':
          // Человек заговорил поверх советника: советник замолкает, а
          // отрезок начнётся заново со следующего кадра — то, что микрофон
          // слышал под репликой, на разбор не уходит.
          playbackRef.current?.stop();
          return;
        case 'idle-timeout':
          releaseAll();
          apply({ type: 'idle-timeout' });
          return;
      }
    },
    [apply, releaseAll, startRecorder, stopRecorder]
  );

  /** Поток микрофона для запроса `token`; устаревший — закрывается. */
  const openStream = useCallback(
    async (token: number): Promise<MediaStream | null> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // Эхоподавление — чтобы голос самого советника (K1) из динамика
          // не считался речью человека.
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (!mountedRef.current || token !== requestRef.current) {
          // Пока браузер спрашивал, человек выключил голос, ушёл с
          // экрана или включил заново (новый запрос уже идёт).
          stream.getTracks().forEach((t) => t.stop());
          return null;
        }
        streamRef.current = stream;
        return stream;
      } catch {
        if (mountedRef.current && token === requestRef.current) {
          apply({ type: 'denied' });
        }
        return null;
      }
    },
    [apply]
  );

  const enable = useCallback(() => {
    if (stateRef.current.phase !== 'off') return;
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    apply({ type: 'enable' });
    const token = ++requestRef.current;
    // Контекст создаётся и будится СИНХРОННО, внутри нажатия: iOS
    // разрешает звук только в самом жесте, а после `await getUserMedia`
    // жеста уже нет — контекст остался бы приостановленным, кадры
    // тихими, и через 20 с микрофон бы молча погас (аудит волны 1).
    const ctx = new Ctor();
    ctxRef.current = ctx;
    void ctx.resume().catch(() => undefined);
    void (async () => {
      const stream = await openStream(token);
      if (!stream) {
        if (ctxRef.current === ctx) ctxRef.current = null;
        void ctx.close().catch(() => undefined);
        return;
      }
      storeArmed();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      // Граф без выхода в `destination` Safari не крутит вовсе — анализатор
      // отдаёт нули. Выход через нулевую громкость: граф живёт, в динамике
      // тишина (своего голоса человек не слышит).
      const mute = ctx.createGain();
      mute.gain.value = 0;
      ctx.createMediaStreamSource(stream).connect(analyser);
      analyser.connect(mute);
      mute.connect(ctx.destination);
      const buf = new Float32Array(analyser.fftSize);
      detectorRef.current = initialDetector(CONFIG);
      apply({ type: 'granted' });
      timerRef.current = window.setInterval(() => {
        const phase = stateRef.current.phase;
        // Во время разбора детектор на паузе: ответ помощника и
        // следующая фраза не должны наложиться.
        if (phase !== 'listening' && phase !== 'recording') return;
        // Микрофон взяла запись образца голоса — пауза, как под
        // репликой советника, но без перебивания (изменение контракта 5).
        if (micBusyRef.current()) {
          const r = pauseDetector(detectorRef.current);
          detectorRef.current = r.state;
          for (const ev of r.events) onDetector(ev, stream);
          return;
        }
        analyser.getFloatTimeDomainData(buf);
        const playing = playbackRef.current?.isPlaying() ?? false;
        const r = stepDetector(
          detectorRef.current,
          rmsOf(buf),
          CONFIG,
          playing
        );
        detectorRef.current = r.state;
        for (const ev of r.events) onDetector(ev, stream);
      }, CONFIG.frameMs);
    })();
  }, [apply, onDetector, openStream]);

  const disable = useCallback(() => {
    releaseAll();
    apply({ type: 'disable' });
  }, [apply, releaseAll]);

  const talkStopWith = useCallback(
    (truncated: boolean) => {
      if (stateRef.current.phase !== 'holding') return;
      if (talkTimerRef.current !== null)
        window.clearTimeout(talkTimerRef.current);
      talkTimerRef.current = null;
      const keep =
        !!recorderRef.current &&
        Date.now() - talkStartedRef.current >= CONFIG.minSpeechMs;
      apply({ type: 'hold-end', keep });
      if (keep) {
        stopRecorder(true, stateRef.current.seq, true, truncated);
      } else {
        stopRecorder(false, stateRef.current.seq);
        releaseAll();
      }
    },
    [apply, releaseAll, stopRecorder]
  );
  const talkStop = useCallback(() => talkStopWith(false), [talkStopWith]);

  const talkStart = useCallback(() => {
    if (stateRef.current.phase !== 'off') return;
    // Человек сам нажал «сказать» — советник замолкает, иначе ручная
    // фраза записала бы его голос вместе со своим.
    playbackRef.current?.stop();
    apply({ type: 'hold-start' });
    const token = ++requestRef.current;
    void (async () => {
      const stream = await openStream(token);
      if (!stream) return;
      if (!startRecorder(stream)) {
        releaseAll();
        apply({ type: 'hold-end', keep: false });
        return;
      }
      talkStartedRef.current = Date.now();
      // Потолок ручной фразы (§4А.3, строка «Тишина»: «у „удерживать и
      // говорить“ — потолок длительности записи»).
      talkTimerRef.current = window.setTimeout(
        () => talkStopWith(true),
        CONFIG.maxUtteranceMs
      );
    })();
  }, [apply, openStream, releaseAll, startRecorder, talkStopWith]);

  const budgetExhausted = useCallback(() => {
    releaseAll();
    apply({ type: 'budget-exhausted' });
  }, [apply, releaseAll]);

  const unblock = useCallback(() => apply({ type: 'unblock' }), [apply]);

  // Выключили «голосом» — микрофон закрыт немедленно.
  useEffect(() => {
    if (!opts.active) disable();
  }, [opts.active, disable]);

  useEffect(() => {
    if (opts.blocked) budgetExhausted();
  }, [opts.blocked, budgetExhausted]);

  // Условие 1 В-15: сам — только у того, кто уже включал нажатием, и
  // только если браузер подтверждает разрешение. Один раз за монтирование:
  // после 20 с тишины микрофон ждёт кнопку, а не открывается снова.
  const autoTriedRef = useRef(false);
  useEffect(() => {
    if (autoTriedRef.current || !opts.active) return;
    let cancelled = false;
    void micPermission().then((permission) => {
      // Флаг ставится здесь, а не до запроса: StrictMode снимает и снова
      // ставит эффект, и отменённый первый запуск не должен съесть попытку.
      if (cancelled || autoTriedRef.current) return;
      autoTriedRef.current = true;
      const decision = autoListenDecision({
        voiceOn: opts.active,
        armed: readArmed(),
        permission,
        blocked: opts.blocked,
        supported,
      });
      if (decision === 'listen') enable();
    });
    return () => {
      cancelled = true;
    };
  }, [opts.active, opts.blocked, supported, enable]);

  // Свёрнутый Telegram (`deactivated`), другая вкладка, закрытие страницы
  // — микрофон закрывается: слушать того, кто ушёл, незачем, а индикатора
  // он не видит. В Telegram на iOS свёрнутый мини-апп не всегда шлёт
  // `visibilitychange` — поэтому и его собственное событие.
  useEffect(
    () =>
      watchPageHidden(
        {
          window,
          document,
          telegram: getTelegramWebApp() as Parameters<
            typeof watchPageHidden
          >[0]['telegram'],
        },
        disable
      ),
    [disable]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releaseAll();
    };
  }, [releaseAll]);

  return {
    state,
    enable,
    disable,
    talkStart,
    talkStop,
    budgetExhausted,
    unblock,
  };
}
