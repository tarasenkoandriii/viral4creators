/**
 * Т-1 (ТЗ §5-бис.12): конвейер голосовых фикстур — чистая часть (без сети):
 * WAV PCM16 моно (запись/чтение), «синтез» мок-провайдера (слоги с огибающей
 * — не речь, но детектор речи и распознавание-мок их принимают), шумы (белый,
 * розовый, «кафе/разговор рядом», «телевизор», «клавиатура»), подмешивание
 * шума при заданном SNR (вместо ffmpeg `amix` — та же формула мощности, без
 * внешних бинарников), склейка «команда + пауза + стоп» для способа 1.
 *
 * Настоящий синтез (Soniox TTS и др.) и записи дикторов (В-31) — у владельца:
 * `scripts/t1/synth.ts --provider=soniox` с ключом; CI — мок-провайдер.
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
  )
    throw new Error('не WAV');
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
      const n = Math.floor(size / 2);
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) s[i] = b.readInt16LE(off + 8 + i * 2) / 32767;
      return { samples: s, rate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('нет блока data');
}

/** Детерминированный ГПСЧ (mulberry32) — фикстуры воспроизводимы. */
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

/**
 * Мок-синтез «голосом» `voice`: по слогу на гласную текста (гармоники
 * основного тона голоса, огибающая слога), скорость 0.9–1.2. Это НЕ речь —
 * распознавание в CI — мок по файлу ожиданий; WER — на живых записях.
 */
export function mockSpeech(
  text: string,
  voice: { f0: number; speed: number },
  rate = RATE
): Float32Array {
  const vowels = (text.match(/[аеєиіїоуюяыэёaeiouy]/giu) || []).length || 3;
  const syl = 0.18 / voice.speed;
  const gap = 0.05 / voice.speed;
  const out = new Float32Array(Math.round((vowels * (syl + gap) + 0.1) * rate));
  const r = rng(seedOf(text + voice.f0));
  for (let k = 0; k < vowels; k++) {
    const start = Math.round(k * (syl + gap) * rate);
    const len = Math.round(syl * rate);
    const f = voice.f0 * (0.9 + 0.2 * r());
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const env = Math.sin((Math.PI * i) / len);
      let v = 0;
      for (let h = 1; h <= 8; h++)
        v += Math.sin(2 * Math.PI * f * h * t + h) / h;
      out[start + i] = 0.3 * env * v;
    }
  }
  return out;
}

export type NoiseKind = 'white' | 'pink' | 'cafe' | 'tv' | 'keyboard';

/** Шум заданного вида и длины (детерминированный). */
export function noise(
  kind: NoiseKind,
  sec: number,
  seed = 1,
  rate = RATE
): Float32Array {
  const n = Math.round(sec * rate);
  const out = new Float32Array(n);
  const r = rng(seed);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    switch (kind) {
      case 'white':
        out[i] = w * 0.3;
        break;
      case 'pink':
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.08;
        break;
      case 'cafe': {
        // «Разговор рядом»: много голосов — амплитудно-модулированный розовый шум.
        b0 = 0.99765 * b0 + w * 0.099046;
        const t = i / rate;
        const am =
          0.6 +
          0.4 *
            Math.sin(2 * Math.PI * 3.1 * t) *
            Math.sin(2 * Math.PI * 0.7 * t);
        out[i] = b0 * 0.6 * am;
        break;
      }
      case 'tv': {
        // ТВ-речь — слоги «чужого голоса» на фоне.
        const t = i / rate;
        const env = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t));
        let v = 0;
        for (let h = 1; h <= 5; h++)
          v += Math.sin(2 * Math.PI * 190 * h * t) / h;
        out[i] = 0.2 * env * v + w * 0.02;
        break;
      }
      case 'keyboard':
        out[i] = r() < 0.0008 ? w * 0.9 : out[i - 1] ? out[i - 1] * 0.6 : 0;
        break;
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
 * Подмешать шум к сигналу так, чтобы SNR по мощности был `db` (как
 * `ffmpeg -filter_complex amix` с уровнем шума, подобранным по мощности).
 * Возвращает смесь и сам масштабированный шум (для проверки).
 */
export function mixAtSnr(
  signal: Float32Array,
  n: Float32Array,
  db: number
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

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Голоса мок-провайдера: 4–6 «голосов» и скорость 0.9–1.2 (§5-бис.12). */
export const MOCK_VOICES = [
  { id: 'm1', f0: 115, speed: 1.0 },
  { id: 'm2', f0: 130, speed: 1.15 },
  { id: 'f1', f0: 205, speed: 0.95 },
  { id: 'f2', f0: 230, speed: 1.2 },
] as const;

export const SNR_LEVELS = [20, 10, 5] as const;
export const NOISE_KINDS: NoiseKind[] = ['cafe', 'tv', 'keyboard', 'pink'];
