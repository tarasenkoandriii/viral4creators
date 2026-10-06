/**
 * mp4-probe.ts — техническая проверка собранной версии обучалки без
 * внешнего бинаря (темп в постпродакшене, 06.10.2026).
 *
 * Решение владельца: версия обучалки клиента с другим темпом становится
 * активной после технической проверки (ffprobe), без повторного
 * одобрения оператора. На Vercel `ffprobe` нет, а отдельная задача
 * ffmpeg-api ради одного `ffprobe` — ещё ≈$0.01 на каждую версию. Нужные
 * проверке числа лежат в самом контейнере MP4 (`moov`): длительность и
 * число сэмплов видеодорожки, размер кадра, длительность звука в
 * сэмплах. Этот разбор читает ровно их и сверяется с настоящим
 * `ffprobe` в тестах (`mp4-probe.spec.ts`) на файлах, собранных
 * локальным ffmpeg по командам `planSlideshow`.
 *
 * Чистый модуль, на входе — байты файла.
 */

import { gridFrames } from './tutorial-video-assembly';

export interface Mp4TrackProbe {
  kind: 'video' | 'audio' | 'other';
  timescale: number;
  /** Длительность дорожки в единицах `timescale` (`mdhd`). */
  duration: number;
  durationSeconds: number;
  /** Число сэмплов (`stsz`): кадров у видео, aac-пакетов у звука. */
  samples: number;
  width: number | null;
  height: number | null;
}

export interface Mp4Probe {
  durationSeconds: number;
  tracks: Mp4TrackProbe[];
}

interface Box {
  type: string;
  start: number;
  end: number;
  body: number;
}

function boxes(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(buf.readBigUInt64BE(at + 8));
      body = at + 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < 8 || at + size > to) break;
    out.push({ type, start: at, end: at + size, body });
    at += size;
  }
  return out;
}

function child(buf: Buffer, box: Box, type: string): Box | null {
  return boxes(buf, box.body, box.end).find((b) => b.type === type) ?? null;
}

function fullBoxTimes(
  buf: Buffer,
  box: Box,
): { timescale: number; duration: number } {
  const version = buf.readUInt8(box.body);
  if (version === 1) {
    return {
      timescale: buf.readUInt32BE(box.body + 20),
      duration: Number(buf.readBigUInt64BE(box.body + 24)),
    };
  }
  return {
    timescale: buf.readUInt32BE(box.body + 12),
    duration: buf.readUInt32BE(box.body + 16),
  };
}

function trackOf(buf: Buffer, trak: Box): Mp4TrackProbe | null {
  const mdia = child(buf, trak, 'mdia');
  if (!mdia) return null;
  const mdhd = child(buf, mdia, 'mdhd');
  const hdlr = child(buf, mdia, 'hdlr');
  if (!mdhd || !hdlr) return null;
  const { timescale, duration } = fullBoxTimes(buf, mdhd);
  const handler = buf.toString('latin1', hdlr.body + 8, hdlr.body + 12);
  const kind =
    handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other';
  let samples = 0;
  const minf = child(buf, mdia, 'minf');
  const stbl = minf ? child(buf, minf, 'stbl') : null;
  const stsz = stbl ? child(buf, stbl, 'stsz') : null;
  if (stsz) samples = buf.readUInt32BE(stsz.body + 8);
  let width: number | null = null;
  let height: number | null = null;
  const tkhd = child(buf, trak, 'tkhd');
  if (tkhd && kind === 'video') {
    // Ширина и высота — последние 8 байт `tkhd`, фиксированная 16.16.
    width = buf.readUInt32BE(tkhd.end - 8) >>> 16;
    height = buf.readUInt32BE(tkhd.end - 4) >>> 16;
  }
  return {
    kind,
    timescale,
    duration,
    durationSeconds: timescale > 0 ? duration / timescale : 0,
    samples,
    width,
    height,
  };
}

/** Разбор `moov`; `null` — это не MP4 или контейнер повреждён. */
export function probeMp4(buf: Buffer): Mp4Probe | null {
  try {
    const moov = boxes(buf, 0, buf.length).find((b) => b.type === 'moov');
    if (!moov) return null;
    const mvhd = child(buf, moov, 'mvhd');
    if (!mvhd) return null;
    const { timescale, duration } = fullBoxTimes(buf, mvhd);
    const tracks = boxes(buf, moov.body, moov.end)
      .filter((b) => b.type === 'trak')
      .map((t) => trackOf(buf, t))
      .filter((t): t is Mp4TrackProbe => t !== null);
    return {
      durationSeconds: timescale > 0 ? duration / timescale : 0,
      tracks,
    };
  } catch {
    return null;
  }
}

export interface TutorialVideoCheck {
  ok: boolean;
  problems: string[];
  videoFrames: number | null;
  expectedFrames: number;
  audioSeconds: number | null;
  width: number | null;
  height: number | null;
}

/**
 * Сверка собранного файла с планом версии: размер холста, число кадров
 * видео (± 1 — у `-shortest` и aac своё округление на хвосте), звук есть
 * там, где он заказан, и не короче картинки больше чем на один aac-пакет
 * с запасом (речь в хвосте не срезана).
 */
export function checkTutorialVideo(
  probe: Mp4Probe | null,
  expected: {
    durationMs: number;
    hasAudio: boolean;
    width: number;
    height: number;
  },
): TutorialVideoCheck {
  const expectedFrames = gridFrames(expected.durationMs / 1000);
  const base: TutorialVideoCheck = {
    ok: false,
    problems: [],
    videoFrames: null,
    expectedFrames,
    audioSeconds: null,
    width: null,
    height: null,
  };
  if (!probe) {
    return { ...base, problems: ['файл не разбирается как MP4'] };
  }
  const video = probe.tracks.find((t) => t.kind === 'video') ?? null;
  const audio = probe.tracks.find((t) => t.kind === 'audio') ?? null;
  const problems: string[] = [];
  if (!video) problems.push('нет видеодорожки');
  if (
    video &&
    (video.width !== expected.width || video.height !== expected.height)
  ) {
    problems.push(
      `кадр ${video.width}×${video.height} вместо ${expected.width}×${expected.height}`,
    );
  }
  if (video && Math.abs(video.samples - expectedFrames) > 1) {
    problems.push(`кадров ${video.samples} вместо ${expectedFrames}`);
  }
  if (expected.hasAudio && !audio) problems.push('нет звуковой дорожки');
  if (audio && video && expected.hasAudio) {
    // Один aac-пакет (1024 сэмпла ≈ 23 мс) плюс кадр сетки (33 мс).
    const shortBy = video.durationSeconds - audio.durationSeconds;
    if (shortBy > 0.06) {
      problems.push(
        `звук короче картинки на ${Math.round(shortBy * 1000)} мс — хвост речи мог срезаться`,
      );
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    videoFrames: video?.samples ?? null,
    expectedFrames,
    audioSeconds: audio ? audio.durationSeconds : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
  };
}
