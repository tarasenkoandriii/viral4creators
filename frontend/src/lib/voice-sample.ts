/**
 * Подготовка образца голоса к клонированию (Resemble) — общая для
 * «Моих клонированных голосов» (features/brand/VoicePicker.tsx) и голоса
 * персоны (features/persona/PersonaVoice.tsx).
 *
 * Прод-дефект 30.09.2026: Telegram Android записывал
 * `audio/webm;codecs=opus`, тип целиком уходил в `POST /voices/upload-url`,
 * а сервер сверял голые типы — человек видел английское «mimeType must be
 * one of…». Теперь:
 *  1. запись/файл декодируется браузером и уходит WAV'ом (`audio/wav`) —
 *     единственный формат, который Resemble называет для образца;
 *  2. не декодировалось — уходит исходник под НОРМАЛИЗОВАННЫМ типом
 *     (`normalizeAudioMime`), тем же, что сервер нормализует у себя
 *     (`normalizeVoiceSampleMime` в user-voices.dto.ts): presigned-адрес
 *     Blob подписан под один тип, и PUT с другим получил бы 400.
 */

import {
  audioToWav,
  VOICE_SAMPLE_MAX_SEC,
  VOICE_SAMPLE_PROVIDER_MAX_SEC,
  type DecodedAudioLike,
} from './wav';

/**
 * Что принимает `POST /voices/upload-url` — зеркало `ALLOWED_MIME_TYPES`
 * в backend/src/modules/user-voices/dto/user-voices.dto.ts (сверяет тест).
 */
export const VOICE_SAMPLE_MIME_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/webm',
] as const;

/** Лимит размера — тот же, что `@Max` у `fileSize` на сервере. */
export const VOICE_SAMPLE_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Синонимы одного и того же контейнера → тип из списка сервера. Та же
 * таблица — `MIME_ALIASES` на сервере (сверяет тест).
 */
export const MIME_ALIASES: Readonly<Record<string, string>> = {
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
};

/** `Audio/WebM; codecs=opus` → `audio/webm`; `audio/x-m4a` → `audio/mp4`. */
export function normalizeAudioMime(
  mime: string | null | undefined,
  fallback = ''
): string {
  const base = String(mime ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!base) return fallback;
  return MIME_ALIASES[base] ?? base;
}

export function isAcceptedVoiceSampleMime(mime: string): boolean {
  return (VOICE_SAMPLE_MIME_TYPES as readonly string[]).includes(
    normalizeAudioMime(mime)
  );
}

/** Тип файла по расширению — Android отдаёт у части файлов пустой `type`. */
export function mimeFromFileName(name: string | undefined): string {
  const ext = String(name ?? '')
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'webm':
      return 'audio/webm';
    case 'ogg':
    case 'oga':
    case 'opus':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    default:
      return '';
  }
}

export interface PreparedVoiceSample {
  blob: Blob;
  /** Уже нормализованный тип — его же и в upload-url, и в PUT. */
  mime: string;
  /** Известна, если запись декодировалась; иначе `null`. */
  durationSec: number | null;
  /** Длиннее потолка — в WAV ушло начало. */
  trimmed: boolean;
  /** Ушёл WAV, а не исходник. */
  converted: boolean;
  /** Исходник не декодировался и его тип сервер не примет (или тип неизвестен). */
  unsupported: boolean;
  /**
   * Длиннее потолка Resemble (3 минуты) — не отправляем: иначе клон
   * уйдёт в обучение и позже вернётся FAILED.
   */
  tooLong: boolean;
}

/**
 * Файл неизвестной длительности декодируется, только если он не больше
 * этого: декодированный звук — float32 на каждый отсчёт, и большой mp3
 * развернулся бы в сотни мегабайт.
 */
export const DECODE_UNKNOWN_MAX_BYTES = 6 * 1024 * 1024;

export type DurationProbe = (
  blob: Blob,
  signal?: AbortSignal
) => Promise<number | null>;

/**
 * Длительность файла без декодирования — по метаданным `<audio>`.
 * `Infinity`/`NaN` (webm MediaRecorder) и таймаут → `null`. Адрес
 * объекта освобождается при любом исходе, в том числе при отмене.
 */
export function browserDurationProbe(timeoutMs = 4000): DurationProbe | null {
  if (typeof document === 'undefined' || typeof URL === 'undefined')
    return null;
  return (blob, signal) =>
    new Promise<number | null>((resolve) => {
      let url: string | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const el = document.createElement('audio');
      const done = (v: number | null) => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        el.onloadedmetadata = null;
        el.onerror = null;
        signal?.removeEventListener('abort', onAbort);
        el.removeAttribute('src');
        if (url) URL.revokeObjectURL(url);
        url = null;
        resolve(v);
      };
      const onAbort = () => done(null);
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      signal?.addEventListener('abort', onAbort);
      el.preload = 'metadata';
      el.onloadedmetadata = () =>
        done(
          Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null
        );
      el.onerror = () => done(null);
      timer = setTimeout(() => done(null), timeoutMs);
      try {
        url = URL.createObjectURL(blob);
        el.src = url;
      } catch {
        done(null);
      }
    });
}

export type AudioDecoder = (data: ArrayBuffer) => Promise<DecodedAudioLike>;

/**
 * Декодер браузера. `OfflineAudioContext` — без устройства вывода и без
 * жеста пользователя; декодированное он сразу передискретизирует в свою
 * частоту (44,1 кГц). Колбэк-форма `decodeAudioData` — для старого Safari,
 * где промис не возвращается.
 */
export function browserAudioDecoder(): AudioDecoder | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Offline = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  const Online = w.AudioContext ?? w.webkitAudioContext;
  if (!Offline && !Online) return null;
  return (data) =>
    new Promise<DecodedAudioLike>((resolve, reject) => {
      let ctx: BaseAudioContext;
      try {
        ctx = Offline ? new Offline(1, 1, 44100) : new Online!();
      } catch (e) {
        reject(e);
        return;
      }
      const close = () => {
        const c = ctx as Partial<AudioContext>;
        if (typeof c.close === 'function') void c.close().catch(() => {});
      };
      const ok = (b: AudioBuffer) => {
        close();
        resolve(b);
      };
      const fail = (e: unknown) => {
        close();
        reject(e ?? new Error('decodeAudioData failed'));
      };
      try {
        const p = ctx.decodeAudioData(data, ok, fail) as
          | Promise<AudioBuffer>
          | undefined;
        if (p && typeof p.then === 'function') p.catch(fail);
      } catch (e) {
        fail(e);
      }
    });
}

/**
 * Запись/файл → то, что уйдёт в `uploadVoiceSample`. Никогда не бросает.
 *
 *  1. Длительность — известная (счётчик записи, `knownDurationSec`) или
 *     по метаданным файла. Длиннее 3 минут — `tooLong`, без декодирования.
 *  2. Декодирование → WAV (обрезка до `maxSec`). Длительность неизвестна
 *     — декодируем, только если файл не больше `DECODE_UNKNOWN_MAX_BYTES`.
 *  3. Не вышло — исходник под нормализованным типом; тип неизвестен или
 *     сервер его не примет — `unsupported`.
 *
 * `null` — подготовку отменили (`signal`): ни результата, ни ссылок.
 */
export async function prepareVoiceSample(
  source: Blob,
  mimeHint: string,
  opts: {
    decoder?: AudioDecoder | null;
    probe?: DurationProbe | null;
    knownDurationSec?: number | null;
    maxSec?: number;
    signal?: AbortSignal;
  } = {}
): Promise<PreparedVoiceSample | null> {
  const { signal } = opts;
  const decoder =
    opts.decoder === undefined ? browserAudioDecoder() : opts.decoder;
  const probe = opts.probe === undefined ? browserDurationProbe() : opts.probe;
  const maxSec = opts.maxSec ?? VOICE_SAMPLE_MAX_SEC;
  const mime = normalizeAudioMime(mimeHint || source.type, '');
  const original = (durationSec: number | null): PreparedVoiceSample => ({
    blob: source,
    mime,
    durationSec,
    trimmed: false,
    converted: false,
    unsupported: !isAcceptedVoiceSampleMime(mime),
    tooLong:
      durationSec !== null && durationSec > VOICE_SAMPLE_PROVIDER_MAX_SEC,
  });

  let knownSec: number | null = null;
  if (opts.knownDurationSec !== undefined && opts.knownDurationSec !== null) {
    knownSec = opts.knownDurationSec;
  } else if (probe) {
    try {
      knownSec = await probe(source, signal);
    } catch {
      knownSec = null;
    }
  }
  if (signal?.aborted) return null;
  if (knownSec !== null && knownSec > VOICE_SAMPLE_PROVIDER_MAX_SEC)
    return original(knownSec);

  const mayDecode =
    !!decoder && (knownSec !== null || source.size <= DECODE_UNKNOWN_MAX_BYTES);
  if (mayDecode && decoder) {
    try {
      const bytes =
        typeof source.arrayBuffer === 'function'
          ? await source.arrayBuffer()
          : await new Response(source).arrayBuffer();
      if (signal?.aborted) return null;
      const decoded = await decoder(bytes);
      if (signal?.aborted) return null;
      const r = audioToWav(decoded, maxSec);
      if (r.sourceDurationSec > VOICE_SAMPLE_PROVIDER_MAX_SEC)
        return original(r.sourceDurationSec);
      if (r.durationSec > 0) {
        return {
          blob: new Blob([r.wav], { type: 'audio/wav' }),
          mime: 'audio/wav',
          durationSec: r.durationSec,
          trimmed: r.trimmed,
          converted: true,
          unsupported: false,
          tooLong: false,
        };
      }
    } catch {
      // ниже — исходник как есть
    }
  }
  if (signal?.aborted) return null;
  return original(knownSec);
}

/** «0:42» — для подписи длительности (секунды округляются). */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
