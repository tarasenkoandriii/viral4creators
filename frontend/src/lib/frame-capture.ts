/**
 * Frame capture — preview pictures for the analysed characters and scenes
 * (spec §18.1, Stage 23).
 *
 * The reference video is never stored on the server (upload = transit
 * blob, YouTube = fetched by Gemini itself), so the only place a real
 * frame can come from is the File the user just picked, still in this
 * page. After the analysis returns `previewAt` seconds we seek a hidden
 * <video>, draw the frame onto a canvas and hand back small JPEGs.
 *
 * Pure helpers (`previewRequests`, `clampTime`) are unit-tested; the DOM
 * part degrades to "no previews" on any failure — previews are a
 * convenience, never a gate.
 */

import type { VideoAnalysis } from '../types';

export interface PreviewRequest {
  /** "character:c1" / "scene:s2" — the server's key. */
  key: string;
  /** Seconds to seek to. */
  time: number;
}

/** Longest side of a preview, px. */
export const PREVIEW_MAX_SIDE = 480;
export const PREVIEW_JPEG_QUALITY = 0.82;

/** Keep the seek inside the clip and off the very last frame (often black). */
export function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, time);
  const max = Math.max(0, duration - 0.15);
  return Math.min(Math.max(0, time), max);
}

/**
 * What to capture: every character with a `previewAt`, every scene with a
 * `previewAt`, skipping anything that already has a `previewUrl`.
 */
export function previewRequests(
  analysis: Pick<VideoAnalysis, 'characters' | 'scenes'> | undefined
): PreviewRequest[] {
  const out: PreviewRequest[] = [];
  for (const c of analysis?.characters ?? []) {
    if (c.previewUrl) continue;
    if (typeof c.previewAt === 'number' && c.previewAt >= 0) {
      out.push({ key: `character:${c.id}`, time: c.previewAt });
    }
  }
  for (const s of analysis?.scenes ?? []) {
    if (s.previewUrl) continue;
    const t = s.previewAt ?? (s.start + s.end) / 2;
    if (Number.isFinite(t) && t >= 0)
      out.push({ key: `scene:${s.id}`, time: t });
  }
  return out;
}

/** Target size preserving aspect, longest side ≤ PREVIEW_MAX_SIDE. */
export function previewSize(
  width: number,
  height: number,
  maxSide: number = PREVIEW_MAX_SIDE
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: maxSide, height: maxSide };
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('seek timeout')),
      4000
    );
    const done = () => {
      window.clearTimeout(timer);
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
      resolve();
    };
    const fail = () => {
      window.clearTimeout(timer);
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
      reject(new Error('video error'));
    };
    video.addEventListener('seeked', done);
    video.addEventListener('error', fail);
    video.currentTime = time;
  });
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    const timer = window.setTimeout(
      () => reject(new Error('metadata timeout')),
      8000
    );
    video.addEventListener(
      'loadeddata',
      () => {
        window.clearTimeout(timer);
        resolve(video);
      },
      { once: true }
    );
    video.addEventListener(
      'error',
      () => {
        window.clearTimeout(timer);
        reject(new Error('cannot decode video'));
      },
      { once: true }
    );
    video.load();
  });
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', PREVIEW_JPEG_QUALITY)
  );
}

/**
 * Grab one JPEG per request from the local file. Requests that fail
 * (seek timeout, tainted canvas, unsupported codec) are dropped; an
 * undecodable file yields an empty array.
 */
export async function captureFrames(
  file: File,
  requests: PreviewRequest[]
): Promise<Array<{ key: string; blob: Blob }>> {
  if (requests.length === 0) return [];
  const url = URL.createObjectURL(file);
  const out: Array<{ key: string; blob: Blob }> = [];
  let video: HTMLVideoElement | null = null;
  try {
    video = await loadVideo(url);
    const { width, height } = previewSize(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    // Seek in time order — cheaper for the decoder than jumping around.
    const ordered = [...requests].sort((a, b) => a.time - b.time);
    for (const r of ordered) {
      try {
        await seekTo(video, clampTime(r.time, video.duration));
        ctx.drawImage(video, 0, 0, width, height);
        const blob = await toJpeg(canvas);
        if (blob) out.push({ key: r.key, blob });
      } catch {
        // skip this frame
      }
    }
    return out;
  } catch {
    return out;
  } finally {
    if (video) {
      video.removeAttribute('src');
      video.load();
    }
    URL.revokeObjectURL(url);
  }
}
