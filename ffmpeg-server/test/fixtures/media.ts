import { spawnSync } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG_BIN ?? 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_BIN ?? 'ffprobe';

/** Синтетический fixture тем же ffmpeg (lavfi testsrc/sine и т.п.). */
export function ff(args: string[], cwd?: string): void {
  const r = spawnSync(
    FFMPEG,
    ['-nostdin', '-hide_banner', '-v', 'error', '-y', ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  );
  if (r.status !== 0) {
    throw new Error(`ffmpeg fixture failed: ${args.join(' ')}\n${r.stderr}`);
  }
}

/** Видео testsrc (+ sine), кодек по расширению (mp4 → h264/aac). */
export function makeVideo(
  file: string,
  o: { w?: number; h?: number; d?: number; fps?: number; audio?: boolean } = {},
): void {
  const w = o.w ?? 320;
  const h = o.h ?? 240;
  const d = o.d ?? 3;
  const args = [
    '-f',
    'lavfi',
    '-i',
    `testsrc=s=${w}x${h}:r=${o.fps ?? 25}:d=${d}`,
  ];
  if (o.audio !== false) args.push('-f', 'lavfi', '-i', `sine=f=440:d=${d}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (o.audio !== false) args.push('-c:a', 'aac', '-shortest');
  args.push('-f', 'mp4', file);
  ff(args);
}

/** Аудио: «речь» — тональные импульсы, чтобы компрессор и loudnorm работали. */
export function makeAudio(
  file: string,
  o: { d?: number; f?: number; format?: 'mp3' | 'wav' | 'm4a' } = {},
): void {
  const d = o.d ?? 3;
  const fmt = o.format ?? 'mp3';
  const codec =
    fmt === 'mp3'
      ? ['-c:a', 'libmp3lame', '-f', 'mp3']
      : fmt === 'wav'
        ? ['-c:a', 'pcm_s16le', '-f', 'wav']
        : ['-c:a', 'aac', '-f', 'ipod'];
  ff([
    '-f',
    'lavfi',
    '-i',
    `sine=f=${o.f ?? 330}:d=${d}`,
    '-af',
    "volume='if(lt(mod(t,1),0.6),1,0.05)':eval=frame",
    ...codec,
    file,
  ]);
}

export function makeImage(
  file: string,
  o: { w?: number; h?: number } = {},
): void {
  ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc=s=${o.w ?? 360}x${o.h ?? 780}:d=0.04`,
    '-frames:v',
    '1',
    '-f',
    'image2',
    '-c:v',
    'png',
    file,
  ]);
}
