/**
 * Звук для замеров распознавания — чистая часть: WAV PCM16 моно (запись и
 * чтение), детерминированные шумы и подмешивание шума при заданном SNR.
 *
 * Приём тот же, что у Т-1 помощника (`widget/scripts/t1/audio.ts`): синтез
 * речи → обёртка тишиной → шум по мощности, без внешних бинарников. Копия, а
 * не импорт: widget — отдельный пакет со своей сборкой, а здесь нужна малая
 * часть (без мок-речи и детектора). Расхождение формул безвредно —
 * результаты двух наборов друг с другом не сравниваются.
 */

export const RATE = 16_000;

/** WAV PCM16 моно → Buffer. */
export function encodeWav(samples: Float32Array, rate = RATE): Buffer {
  const n = samples.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    b.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return b;
}

/** WAV PCM16 моно → сэмплы и частота (другое — ошибка). */
export function decodeWav(b: Buffer): { samples: Float32Array; rate: number } {
  if (
    b.toString('latin1', 0, 4) !== 'RIFF' ||
    b.toString('latin1', 8, 12) !== 'WAVE'
  ) {
    throw new Error('не WAV');
  }
  let off = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('latin1', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = b.readUInt16LE(off + 10);
      rate = b.readUInt32LE(off + 12);
      bits = b.readUInt16LE(off + 22);
    } else if (id === 'data') {
      if (channels !== 1 || bits !== 16) throw new Error('нужен PCM16 моно');
      const n = Math.floor(Math.min(size, b.length - off - 8) / 2);
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) s[i] = b.readInt16LE(off + 8 + i * 2) / 32767;
      return { samples: s, rate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('нет блока data');
}

/** Детерминированный ГПСЧ (mulberry32) — шум воспроизводим. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Хеш строки → seed (FNV-1a). */
export function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function silence(sec: number, rate = RATE): Float32Array {
  return new Float32Array(Math.round(sec * rate));
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Обёртка реплики: 0.5 с тишины до и 1 с после — как запись «нажал — сказал». */
export function framed(speech: Float32Array): Float32Array {
  return concat(silence(0.5), speech, silence(1));
}

/** Секунды обёртки — для оценки длительности до синтеза. */
export const FRAME_SECONDS = 1.5;

/**
 * Виды шума: розовый (вентилятор, улица), «кафе» (гул голосов рядом),
 * «телевизор» (чужая речь фоном). Белого нет: в квартире его не бывает.
 */
export type NoiseKind = 'pink' | 'cafe' | 'tv';
export const NOISE_KINDS: readonly NoiseKind[] = ['cafe', 'tv', 'pink'];

export function noise(
  kind: NoiseKind,
  sec: number,
  seed = 1,
  rate = RATE,
): Float32Array {
  const n = Math.round(sec * rate);
  const out = new Float32Array(n);
  const r = rng(seed);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    const t = i / rate;
    switch (kind) {
      case 'pink':
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.08;
        break;
      case 'cafe': {
        b0 = 0.99765 * b0 + w * 0.099046;
        const am =
          0.6 +
          0.4 *
            Math.sin(2 * Math.PI * 3.1 * t) *
            Math.sin(2 * Math.PI * 0.7 * t);
        out[i] = b0 * 0.6 * am;
        break;
      }
      case 'tv': {
        const env = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t));
        let v = 0;
        for (let h = 1; h <= 5; h++) {
          v += Math.sin(2 * Math.PI * 190 * h * t) / h;
        }
        out[i] = 0.2 * env * v + w * 0.02;
        break;
      }
    }
  }
  return out;
}

function power(s: Float32Array): number {
  let p = 0;
  for (let i = 0; i < s.length; i++) p += s[i] * s[i];
  return s.length ? p / s.length : 0;
}

/** SNR, дБ (сигнал к шуму по мощности). */
export function snrDb(signal: Float32Array, noiseOnly: Float32Array): number {
  return 10 * Math.log10(power(signal) / Math.max(1e-12, power(noiseOnly)));
}

/**
 * Подмешать шум так, чтобы SNR по мощности был `db`. Возвращает смесь и
 * сам масштабированный шум (для проверки).
 */
export function mixAtSnr(
  signal: Float32Array,
  n: Float32Array,
  db: number,
): { mix: Float32Array; scaledNoise: Float32Array } {
  const ps = power(signal);
  const pn = power(n.subarray(0, signal.length));
  const k = pn > 0 ? Math.sqrt(ps / (pn * Math.pow(10, db / 10))) : 0;
  const mix = new Float32Array(signal.length);
  const scaledNoise = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    const v = (n[i % n.length] || 0) * k;
    scaledNoise[i] = v;
    mix[i] = Math.max(-1, Math.min(1, signal[i] + v));
  }
  return { mix, scaledNoise };
}

/**
 * Реплика в обёртке тишиной и шум на ВСЕЙ записи (в паузах он тоже есть).
 * SNR — по мощности самой речи, без пауз: иначе тишина обёртки занижала бы
 * мощность сигнала, и шум выходил бы тише заявленного.
 */
export function noisyFramed(
  speech: Float32Array,
  kind: NoiseKind,
  db: number,
  seed: number,
): Float32Array {
  const clean = framed(speech);
  const n = noise(kind, clean.length / RATE, seed);
  const ps = power(speech);
  const pn = power(n);
  const k = pn > 0 ? Math.sqrt(ps / (pn * Math.pow(10, db / 10))) : 0;
  const out = new Float32Array(clean.length);
  for (let i = 0; i < clean.length; i++) {
    out[i] = Math.max(-1, Math.min(1, clean[i] + n[i] * k));
  }
  return out;
}
