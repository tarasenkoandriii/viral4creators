/**
 * ffprobe по argv (без shell): JSON → ProbeResult, sha256 и mime.
 *
 * Недоверенные медиа лучше разбирать в изолированном executor
 * (`ExecutorClient.probe`); `probeFile` — та же логика локально (тесты,
 * проверка в executor, запасной путь).
 */
import { spawn } from 'node:child_process';
import { createReadStream, promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { ProbeResult, ProbeStream } from '../contracts';
import { INPUT_DEMUXERS, OUTPUT_EXTENSIONS } from '../command/allowlist';

/** Расширение ProbeStream пакета EXEC: SAR и пиксельный формат. */
export interface ProbeStreamEx extends ProbeStream {
  /** sample_aspect_ratio числом (1 — квадратный пиксель). */
  sar?: number;
  pixFmt?: string | null;
  nbFrames?: number | null;
}

export class ProbeError extends Error {
  readonly code = 'INPUT_INVALID_MEDIA' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ProbeError';
  }
}

/** Демультиплексоры, которые ffprobe вправе открыть (входы + субтитры). */
export const PROBE_DEMUXERS = [...INPUT_DEMUXERS, 'srt', 'ass'];

export function ffprobeArgs(file: string): string[] {
  return [
    '-v',
    'error',
    '-hide_banner',
    '-protocol_whitelist',
    'file',
    '-format_whitelist',
    PROBE_DEMUXERS.join(','),
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    // `file:` — имя не истолковывается как протокол.
    `file:${file}`,
  ];
}

/** Запустить ffprobe и вернуть разобранный JSON. */
export function runFfprobe(
  bin: string,
  file: string,
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ffprobeArgs(file), {
      cwd: opts.cwd,
      env: opts.env ?? { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      opts.timeoutMs ?? 30_000,
    );
    child.stdout.on('data', (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > 4 * 1024 * 1024) child.kill('SIGKILL');
      else out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 4096) err += c.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new ProbeError(`ffprobe failed to start: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new ProbeError(
            signal
              ? `ffprobe killed (${signal})`
              : `ffprobe rejected the file: ${sanitize(err)}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString('utf8')));
      } catch {
        reject(new ProbeError('ffprobe returned invalid JSON'));
      }
    });
  });
}

/** Убрать пути из сообщения ffprobe. */
function sanitize(s: string): string {
  return s
    .replace(/file:[^\s:'"]+/g, 'file:<path>')
    .replace(/\/[^\s:'"]+/g, '<path>')
    .trim()
    .slice(0, 300);
}

export async function sha256File(
  file: string,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (c) => {
        const b = c as Buffer;
        bytes += b.length;
        hash.update(b);
      })
      .on('error', reject)
      .on('end', () => resolve());
  });
  return { bytes, sha256: hash.digest('hex') };
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === 'N/A') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function ratio(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)[/:](\d+)$/.exec(v);
  if (!m) return num(v);
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!b || !a) return null;
  return a / b;
}

function rotationOf(s: Record<string, unknown>): number | undefined {
  const sd = s.side_data_list;
  if (Array.isArray(sd)) {
    for (const d of sd as Array<Record<string, unknown>>) {
      const r = num(d.rotation);
      if (r !== null) return ((Math.round(r) % 360) + 360) % 360;
    }
  }
  const tags = s.tags as Record<string, unknown> | undefined;
  const r = num(tags?.rotate);
  return r !== null ? ((Math.round(r) % 360) + 360) % 360 : undefined;
}

const TYPES: Record<string, ProbeStream['type']> = {
  video: 'video',
  audio: 'audio',
  subtitle: 'subtitle',
  data: 'data',
  attachment: 'attachment',
};

export function probeFromFfprobeJson(
  json: unknown,
  meta: { bytes: number; sha256: string; mime: string },
): ProbeResult {
  const root = (json ?? {}) as Record<string, unknown>;
  const format = (root.format ?? {}) as Record<string, unknown>;
  const rawStreams = Array.isArray(root.streams)
    ? (root.streams as Array<Record<string, unknown>>)
    : [];
  const streams: ProbeStreamEx[] = rawStreams.map((s, i) => {
    const type = TYPES[String(s.codec_type)] ?? 'unknown';
    const st: ProbeStreamEx = {
      index: num(s.index) ?? i,
      type,
      codec: typeof s.codec_name === 'string' ? s.codec_name : null,
      durationSec: num(s.duration),
    };
    if (type === 'video') {
      const w = num(s.width);
      const h = num(s.height);
      if (w !== null) st.width = w;
      if (h !== null) st.height = h;
      const fps = ratio(s.avg_frame_rate) ?? ratio(s.r_frame_rate);
      if (fps !== null) st.fps = Math.round(fps * 1000) / 1000;
      const sar = ratio(s.sample_aspect_ratio);
      if (sar !== null) st.sar = sar;
      const rot = rotationOf(s);
      if (rot !== undefined) st.rotation = rot;
      st.pixFmt = typeof s.pix_fmt === 'string' ? s.pix_fmt : null;
      st.nbFrames = num(s.nb_frames);
    }
    if (type === 'audio') {
      const sr = num(s.sample_rate);
      const ch = num(s.channels);
      if (sr !== null) st.sampleRate = sr;
      if (ch !== null) st.channels = ch;
    }
    return st;
  });
  return {
    formatName:
      typeof format.format_name === 'string' ? format.format_name : null,
    durationSec: num(format.duration),
    bytes: meta.bytes,
    sha256: meta.sha256,
    mime: meta.mime,
    streams,
  };
}

/** MIME по формату ffprobe (приоритет) и расширению. */
export function mimeFor(file: string, json: unknown): string {
  const root = (json ?? {}) as Record<string, unknown>;
  const format = String(
    ((root.format ?? {}) as Record<string, unknown>).format_name ?? '',
  );
  const streams = Array.isArray(root.streams)
    ? (root.streams as Array<Record<string, unknown>>)
    : [];
  const hasVideo = streams.some(
    (s) =>
      s.codec_type === 'video' &&
      !(s.disposition as Record<string, unknown> | undefined)?.attached_pic,
  );
  if (format.startsWith('mov,mp4')) {
    if (path.extname(file).toLowerCase() === '.m4a' || !hasVideo)
      return 'audio/mp4';
    return 'video/mp4';
  }
  if (format === 'matroska,webm') return hasVideo ? 'video/webm' : 'audio/webm';
  const byFormat: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    aac: 'audio/aac',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    png_pipe: 'image/png',
    jpeg_pipe: 'image/jpeg',
    webp_pipe: 'image/webp',
    srt: 'application/x-subrip',
    ass: 'text/x-ssa',
  };
  if (byFormat[format]) return byFormat[format];
  if (format === 'image2') {
    const codec = streams[0]?.codec_name;
    if (codec === 'png') return 'image/png';
    if (codec === 'mjpeg') return 'image/jpeg';
    if (codec === 'webp') return 'image/webp';
  }
  const ext = OUTPUT_EXTENSIONS[path.extname(file).toLowerCase()];
  return ext?.mime ?? 'application/octet-stream';
}

/** Локальный ffprobe + sha256 (+ mime). */
export async function probeFile(
  file: string,
  opts: { ffprobeBin?: string; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const st = await fsp.lstat(file).catch(() => null);
  if (!st || !st.isFile()) throw new ProbeError('not a regular file');
  const json = await runFfprobe(
    opts.ffprobeBin ?? process.env.FFPROBE_BIN ?? 'ffprobe',
    file,
    {
      timeoutMs: opts.timeoutMs,
    },
  );
  const { bytes, sha256 } = await sha256File(file);
  return probeFromFfprobeJson(json, {
    bytes,
    sha256,
    mime: mimeFor(file, json),
  });
}
