/**
 * Проверка входа по профилю лимитов (ТЗ §9): разрешение с учётом поворота
 * и SAR, fps, длительность, мегапиксели, признаки decompression bomb и
 * допустимые форматы (без плейлистов/concat/hls).
 *
 * Профиль «до 1920×1080» трактуется независимо от ориентации: длинная
 * сторона ≤ max(maxWidth, maxHeight), короткая ≤ min(…) — вертикальный
 * 1080×1920 (9:16) тот же профиль, что 1920×1080.
 */
import type { LimitsProfile, ProbeResult } from '../contracts';
import type { ProbeStreamEx } from './probe';

export type LimitCheck =
  | { ok: true }
  | {
      ok: false;
      code: 'INPUT_LIMIT_EXCEEDED' | 'INPUT_INVALID_MEDIA';
      message: string;
    };

/** format_name ffprobe, допустимые для входов. */
export const ALLOWED_INPUT_FORMATS: ReadonlySet<string> = new Set([
  'mov,mp4,m4a,3gp,3g2,mj2',
  'matroska,webm',
  'mp3',
  'wav',
  'aac',
  'flac',
  'ogg',
  'image2',
  'png_pipe',
  'jpeg_pipe',
  'webp_pipe',
  'srt',
  'ass',
]);

const IMAGE_FORMATS = new Set(['image2', 'png_pipe', 'jpeg_pipe', 'webp_pipe']);
const SUBTITLE_FORMATS = new Set(['srt', 'ass']);
const MAX_STREAMS = 16;
const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
const MAX_SAMPLE_RATE = 192_000;
const MAX_CHANNELS = 8;

export function displaySize(
  s: ProbeStreamEx,
): { width: number; height: number } | null {
  if (!s.width || !s.height) return null;
  let w = s.width;
  const h = s.height;
  // Неквадратный пиксель растягивает кадр по ширине при показе.
  if (s.sar && s.sar > 0 && Math.abs(s.sar - 1) > 1e-6)
    w = Math.round(w * s.sar);
  const rot = s.rotation ?? 0;
  return rot === 90 || rot === 270
    ? { width: h, height: w }
    : { width: w, height: h };
}

export function checkInputLimits(
  probe: ProbeResult,
  limits: LimitsProfile,
): LimitCheck {
  const invalid = (message: string): LimitCheck => ({
    ok: false,
    code: 'INPUT_INVALID_MEDIA',
    message,
  });
  const exceeded = (message: string): LimitCheck => ({
    ok: false,
    code: 'INPUT_LIMIT_EXCEEDED',
    message,
  });
  const fmt = probe.formatName;
  if (!fmt || !ALLOWED_INPUT_FORMATS.has(fmt)) {
    return invalid(`input format ${fmt ?? 'unknown'} is not supported`);
  }
  if (probe.bytes <= 0) return invalid('input is empty');
  if (probe.bytes > limits.maxInputBytes)
    return exceeded('input file is too large');
  if (SUBTITLE_FORMATS.has(fmt)) {
    return probe.bytes > MAX_SUBTITLE_BYTES
      ? exceeded('subtitle file is too large')
      : { ok: true };
  }
  const streams = probe.streams as ProbeStreamEx[];
  if (streams.length === 0) return invalid('input has no streams');
  if (streams.length > MAX_STREAMS)
    return invalid('input has too many streams');
  const isImage = IMAGE_FORMATS.has(fmt);
  const media = streams.filter((s) => s.type === 'video' || s.type === 'audio');
  if (media.length === 0) return invalid('input has no audio or video');

  if (!isImage) {
    const d =
      probe.durationSec ?? Math.max(0, ...media.map((s) => s.durationSec ?? 0));
    if (!d || !Number.isFinite(d) || d <= 0)
      return invalid('input duration is unknown');
    if (d > limits.maxInputDurationSec + 0.5) {
      return exceeded(`input is longer than ${limits.maxInputDurationSec} s`);
    }
    for (const s of media) {
      if ((s.durationSec ?? 0) > limits.maxInputDurationSec + 0.5) {
        return exceeded(
          `input stream is longer than ${limits.maxInputDurationSec} s`,
        );
      }
    }
  }

  const longMax = Math.max(limits.maxWidth, limits.maxHeight);
  const shortMax = Math.min(limits.maxWidth, limits.maxHeight);
  for (const s of streams) {
    if (s.type === 'video') {
      if (!s.width || !s.height)
        return invalid('video stream without dimensions');
      // Мегапиксели — по кодированному кадру: столько декодер выделит.
      if (s.width * s.height > limits.maxImagePixels) {
        return exceeded(`frame is larger than ${limits.maxImagePixels} pixels`);
      }
      const disp = displaySize(s)!;
      if (disp.width * disp.height > limits.maxImagePixels) {
        return exceeded(
          `displayed frame is larger than ${limits.maxImagePixels} pixels`,
        );
      }
      if (!isImage) {
        // FF-SEC2-01: кодированный и дисплейный кадр проверяются каждый
        // своей парой (длинная, короткая) — поворот на 90° не смешивает
        // ширину одного с высотой другого.
        const fits = (w: number, h: number) =>
          Math.max(w, h) <= longMax && Math.min(w, h) <= shortMax;
        if (!fits(s.width, s.height) || !fits(disp.width, disp.height)) {
          return exceeded(
            `video is larger than ${limits.maxWidth}x${limits.maxHeight}`,
          );
        }
        if (s.fps !== undefined && s.fps > limits.maxFps + 0.01) {
          return exceeded(`video frame rate is above ${limits.maxFps} fps`);
        }
        // Бомба: заявлено больше кадров, чем допускают fps×длительность.
        const maxFrames = limits.maxFps * limits.maxInputDurationSec * 1.05;
        if (s.nbFrames && s.nbFrames > maxFrames) {
          return exceeded('video has too many frames');
        }
        // Бомба: огромный декодированный объём на крошечный файл.
        const d = s.durationSec ?? probe.durationSec ?? 0;
        const decoded = s.width * s.height * 1.5 * (s.fps ?? 30) * d;
        if (decoded / Math.max(probe.bytes, 1) > 1e6) {
          return exceeded('suspicious compression ratio (decompression bomb)');
        }
      }
    }
    if (s.type === 'audio') {
      if ((s.sampleRate ?? 0) > MAX_SAMPLE_RATE)
        return exceeded('audio sample rate is too high');
      if ((s.channels ?? 0) > MAX_CHANNELS)
        return exceeded('audio has too many channels');
    }
  }
  return { ok: true };
}
