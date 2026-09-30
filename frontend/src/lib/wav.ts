/**
 * WAV (RIFF, PCM 16-bit, моно) из декодированного звука — чистые функции,
 * без DOM и без npm-пакетов.
 *
 * Зачем: образец голоса для клонирования уходит в Resemble ссылкой
 * (`dataset_url`), а документация Resemble называет формат образца
 * «Single WAV file (≥10 seconds)», длина — «10 seconds – 3 minutes»
 * (docs.resemble.ai/voice-creation/voices/clone-overview). Запись
 * `MediaRecorder` — webm/opus (Chrome, Android WebView Telegram) или
 * mp4/aac (Safari); ни то, ни другое Resemble не гарантирует. Браузер
 * сам декодирует свою запись (`decodeAudioData`), а здесь из PCM
 * собирается WAV — у него, в отличие от webm MediaRecorder, длительность
 * записана в заголовке, и плеер показывает её честно, а не «18:19».
 */

/** Нижняя граница, которую Resemble называет для клона. */
export const VOICE_SAMPLE_MIN_SEC = 10;

/**
 * Потолок образца. Resemble принимает до 3 минут; два — с запасом и
 * по размеру: 120 с × 44 100 Гц × 2 байта ≈ 10,6 МБ < 15 МБ лимита
 * `POST /voices/upload-url`.
 */
export const VOICE_SAMPLE_MAX_SEC = 120;

/** Потолок самого Resemble: «10 seconds – 3 minutes». Длиннее — не отправляем. */
export const VOICE_SAMPLE_PROVIDER_MAX_SEC = 180;

/**
 * Допуск обрезки: автостоп записи на 2:00 срабатывает по секундному
 * счётчику, и запись выходит на доли секунды длиннее. Это не «обрезали
 * вашу запись» — предупреждение только сверх секунды.
 */
export const TRIM_TOLERANCE_SEC = 1;

/**
 * Частота WAV — не выше 44,1 кГц (размер). Запись микрофона декодируется
 * в 44,1/48 кГц, так что на деле это 44,1; ниже исходной не опускаем и
 * выше не тянем (16 кГц файл вверх качества не получит).
 */
export const WAV_MAX_RATE = 44100;

export const WAV_HEADER_BYTES = 44;

/** Сведение каналов в моно — среднее по каналам. */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const len = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (const c of channels) sum += c[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/** Линейная передискретизация. Для речи этого достаточно. */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const outLen = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const step = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = pos - i0;
    const a = samples[Math.min(i0, samples.length - 1)];
    out[i] = a + (samples[i1] - a) * frac;
  }
  return out;
}

/** Частота WAV для исходной: 48 кГц → 44,1; 16 кГц остаётся 16 (вверх не тянем). */
export function wavTargetRate(sourceRate: number): number {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) return WAV_MAX_RATE;
  if (sourceRate > WAV_MAX_RATE) return WAV_MAX_RATE;
  return Math.round(sourceRate);
}

/** RIFF/WAVE, PCM 16-bit little-endian, моно. */
export function encodeWavPcm16(
  samples: Float32Array,
  sampleRate: number
): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // размер fmt-блока PCM
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // моно
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate = rate × каналы × 2
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // бит на отсчёт
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  let off = WAV_HEADER_BYTES;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const x = Math.max(-1, Math.min(1, samples[i] || 0));
    v.setInt16(
      off,
      x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff),
      true
    );
  }
  return buf;
}

export interface DecodedAudioLike {
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface WavResult {
  wav: ArrayBuffer;
  sampleRate: number;
  /** Длительность того, что попало в WAV (после обрезки). */
  durationSec: number;
  /** Длительность исходной записи. */
  sourceDurationSec: number;
  trimmed: boolean;
}

/**
 * Декодированный звук → моно WAV не длиннее `maxSec`. Каждый канал
 * обрезается (`subarray` — без копии) ДО сведения в моно и
 * передискретизации: длинный стерео-файл не порождает копий на всю свою
 * длину (18 минут стерео — это сотни мегабайт, WebView Telegram падал бы).
 */
export function audioToWav(
  audio: DecodedAudioLike,
  maxSec: number = VOICE_SAMPLE_MAX_SEC
): WavResult {
  const srcRate = audio.sampleRate;
  const maxSamples = Math.floor(maxSec * srcRate);
  let sourceLen = 0;
  const channels: Float32Array[] = [];
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const data = audio.getChannelData(c);
    sourceLen = Math.max(sourceLen, data.length);
    channels.push(
      data.length > maxSamples ? data.subarray(0, maxSamples) : data
    );
  }
  const cut = downmixToMono(channels);
  const sourceDurationSec = srcRate > 0 ? sourceLen / srcRate : 0;
  const trimmed = sourceLen > maxSamples + TRIM_TOLERANCE_SEC * srcRate;
  const rate = wavTargetRate(srcRate);
  const pcm = resampleLinear(cut, srcRate, rate);
  return {
    wav: encodeWavPcm16(pcm, rate),
    sampleRate: rate,
    durationSec: pcm.length / rate,
    sourceDurationSec,
    trimmed,
  };
}
