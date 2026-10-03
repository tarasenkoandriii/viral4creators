/**
 * Ленивый чанк голоса iframe-чата — `dist/v1/voice.js` (Э5, ТЗ помощника
 * §4.10, §4-бис.6, §5-бис.7; бюджет — scripts/size-budget.mjs). В загрузчик
 * не входит: живёт только в iframe на origin виджета и грузится, когда голос
 * включён в конфиге сайта.
 *
 * Запись (push-to-talk, Р-29): `getUserMedia` → MediaRecorder (Opus/AAC) +
 * детектор речи по уровню (vad.ts) — фраза кончается тишиной ~1 с, потолок
 * 30 с, короче 0.4 с — выбрасывается на устройстве. Микрофон открыт только
 * между нажатием и концом фразы: в конце треки останавливаются (индикатор
 * браузера гаснет), запись отдаётся чату одним Blob и больше нигде не
 * хранится — ни в Storage, ни в IndexedDB.
 *
 * Воспроизведение озвучки — через WebAudio: контекст разблокируется
 * синхронно в жесте (`unlock`), а байты приходят позже по сети — так
 * работает и в iOS Safari, где `audio.play()` после `await` без жеста
 * запрещён. Нет WebAudio — `<audio>` из Blob-URL (CSP iframe:
 * `media-src blob:`). Никаких HTML-приёмников.
 */
import type {
  RecordEnd,
  RecordLimits,
  Recording,
  VoiceEngine,
} from '../shared/voice-api';
import { Vad, pickMime, rms } from './vad';

type Ctx = typeof AudioContext;

function audioCtx(): Ctx | null {
  const w = window as unknown as {
    AudioContext?: Ctx;
    webkitAudioContext?: Ctx;
  };
  return w.AudioContext || w.webkitAudioContext || null;
}

const TICK_MS = 50;
/** Порог речи, пока звучит своя озвучка (`bargeInFactor` TMA, §5-бис.5). */
const BARGE_IN_FACTOR = 3;

function canRecord(): boolean {
  const md = navigator.mediaDevices;
  return (
    !!md &&
    typeof md.getUserMedia === 'function' &&
    typeof MediaRecorder === 'function' &&
    !!audioCtx()
  );
}

export function createVoice(): VoiceEngine {
  let player: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let element: HTMLAudioElement | null = null;
  let elementUrl: string | null = null;

  const stopPlayback = () => {
    if (source) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* уже остановлен */
      }
      source = null;
    }
    if (element) {
      element.onended = null;
      element.pause();
      element = null;
    }
    if (elementUrl) {
      URL.revokeObjectURL(elementUrl);
      elementUrl = null;
    }
  };

  return {
    canRecord,

    record(limits: RecordLimits, onLevel, onEnd): Recording {
      let ended = false;
      let stream: MediaStream | null = null;
      let rec: MediaRecorder | null = null;
      let meter: AudioContext | null = null;
      let timer = 0;
      let cancelled = false;
      const chunks: Blob[] = [];
      const vad = new Vad({
        minSpeechMs: limits.minSpeechMs,
        endSilenceMs: limits.endSilenceMs,
        maxMs: limits.maxRecordMs,
        // Звучит своя озвучка — порог перебивания выше (§5-бис.5).
        boost: () => (source || element ? BARGE_IN_FACTOR : 1),
      });
      let spoke = false;
      let why: 'ok' | 'max' = 'ok';

      const release = () => {
        clearInterval(timer);
        if (stream) for (const t of stream.getTracks()) t.stop();
        stream = null;
        if (meter) void meter.close().catch(() => undefined);
        meter = null;
      };
      const finish = (end: RecordEnd) => {
        if (ended) return;
        ended = true;
        release();
        chunks.length = 0;
        onEnd(end);
      };
      let stopping = false;
      const stopNow = (reason: 'ok' | 'max') => {
        // Второй «Стоп» или тик детектора до `onstop` (state уже inactive):
        // запись уже отдаётся — не выбрасывать её как «короткую».
        if (ended || stopping) return;
        why = reason;
        if (rec && rec.state !== 'inactive') {
          stopping = true;
          clearInterval(timer);
          rec.stop();
        } else finish({ reason: 'short' });
      };

      const C = audioCtx();
      if (!canRecord() || !C) {
        finish({ reason: 'error', code: 'unsupported' });
        return { stop() {}, cancel() {} };
      }
      navigator.mediaDevices
        .getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        .then((s) => {
          // Отменили, пока браузер спрашивал разрешение, — микрофон сразу гасим.
          if (ended || cancelled) {
            for (const t of s.getTracks()) t.stop();
            return finish({ reason: 'cancel' });
          }
          stream = s;
          const mime = pickMime((m) => MediaRecorder.isTypeSupported(m));
          rec = mime
            ? new MediaRecorder(s, { mimeType: mime })
            : new MediaRecorder(s);
          rec.ondataavailable = (e) => {
            if (e.data && e.data.size) chunks.push(e.data);
          };
          rec.onstop = () => {
            if (cancelled) return finish({ reason: 'cancel' });
            if (!vad.heardSpeech || vad.speechMs < limits.minSpeechMs)
              return finish({ reason: 'short' });
            const type = (rec && rec.mimeType) || mime || 'audio/webm';
            const blob = new Blob(chunks, { type: type.split(';')[0] });
            finish(
              why === 'max'
                ? { reason: 'max', blob, speechMs: vad.speechMs }
                : { reason: 'ok', blob, speechMs: vad.speechMs }
            );
          };
          rec.onerror = () => finish({ reason: 'error', code: 'failed' });
          rec.start(250);
          meter = new C();
          const an = meter.createAnalyser();
          an.fftSize = 1024;
          meter.createMediaStreamSource(s).connect(an);
          const buf = new Float32Array(an.fftSize);
          const t0 = Date.now();
          timer = window.setInterval(() => {
            an.getFloatTimeDomainData(buf);
            const level = rms(buf);
            onLevel(Math.min(1, level * 4));
            const step = vad.push(level, Date.now() - t0);
            // Э6-бис: начало речи — сразу (план на паузу до распознавания).
            if (!spoke && vad.heardSpeech) {
              spoke = true;
              if (limits.onSpeech) limits.onSpeech();
            }
            if (step !== 'listen') stopNow(step === 'max' ? 'max' : 'ok');
          }, TICK_MS);
        })
        .catch((e: { name?: string }) => {
          const code =
            e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
              ? 'denied'
              : e &&
                  (e.name === 'NotFoundError' ||
                    e.name === 'OverconstrainedError')
                ? 'no_device'
                : 'failed';
          finish({ reason: 'error', code });
        });

      return {
        stop: () => stopNow('ok'),
        cancel: () => {
          cancelled = true;
          if (rec && rec.state !== 'inactive') rec.stop();
          else finish({ reason: 'cancel' });
        },
      };
    },

    unlock() {
      const C = audioCtx();
      if (!C) return;
      try {
        if (!player) player = new C();
        if (player.state === 'suspended') void player.resume();
      } catch {
        player = null;
      }
    },

    play(bytes: ArrayBuffer, onEnd: () => void) {
      stopPlayback();
      const viaElement = () => {
        try {
          elementUrl = URL.createObjectURL(
            new Blob([bytes], { type: 'audio/mpeg' })
          );
          const el = new Audio();
          element = el;
          el.onended = () => {
            stopPlayback();
            onEnd();
          };
          el.src = elementUrl;
          el.play().catch(() => {
            stopPlayback();
            onEnd();
          });
        } catch {
          onEnd();
        }
      };
      if (!player) return viaElement();
      const ctx = player;
      ctx.decodeAudioData(
        bytes.slice(0),
        (decoded) => {
          const node = ctx.createBufferSource();
          node.buffer = decoded;
          node.connect(ctx.destination);
          node.onended = () => {
            if (source === node) source = null;
            onEnd();
          };
          source = node;
          node.start();
        },
        () => viaElement()
      );
    },

    stopPlayback,
  };
}

// ── Т-1, способ 2: подача звука через WebAudio (ТОЛЬКО тестовая сборка) ──

/**
 * Хук тестовой сборки (§5-бис.12): `getUserMedia` отдаёт поток
 * `MediaStreamAudioDestinationNode`, а тест подаёт в него декодированную
 * фикстуру в нужный момент (`window.__v4cTestAudio.feed(pcm, rate)` →
 * время начала подачи). В боевой сборке этого кода нет (define = false,
 * проверка отсутствия маркера — scripts/size-budget.mjs).
 */
function installTestAudio() {
  const C = audioCtx();
  const md = navigator.mediaDevices;
  if (!C || !md) return;
  let ctx: AudioContext | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
  let opened = 0;
  md.getUserMedia = async () => {
    if (!ctx) ctx = new C();
    if (ctx.state === 'suspended') await ctx.resume();
    dest = ctx.createMediaStreamDestination();
    opened++;
    return dest.stream;
  };
  (window as unknown as Record<string, unknown>).__v4cTestAudio = {
    feed(pcm: number[], rate: number): Promise<number> {
      if (!ctx || !dest) return Promise.resolve(-1);
      const buf = ctx.createBuffer(1, pcm.length, rate);
      buf.getChannelData(0).set(pcm);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      const at = Date.now();
      src.start();
      return new Promise((r) => {
        src.onended = () => r(at);
      });
    },
    /** Сколько раз открыт «микрофон» (каждая запись — новый поток). */
    opened: () => opened,
  };
}
if (typeof __V4C_TEST_AUDIO__ !== 'undefined' && __V4C_TEST_AUDIO__)
  installTestAudio();
