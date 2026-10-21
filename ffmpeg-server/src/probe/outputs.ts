/**
 * Проверка результатов попытки перед публикацией (ТЗ §8, §10): каждый
 * объявленный файл существует, это обычный файл внутри outputs/ (не
 * symlink/hardlink/устройство), суммарный размер ≤ лимита, медиа-файлы
 * открываются ffprobe и содержат нужные потоки. sha256 и mime — для
 * outputs_metadata.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { ExecPlan, LimitsProfile, ProbeResult } from '../contracts';
import { OUTPUT_EXTENSIONS } from '../command/allowlist';
import { mimeFor, probeFile, sha256File } from './probe';

export interface VerifiedOutput {
  name: string;
  localName: string;
  bytes: number;
  sha256: string;
  mime: string;
  probe: ProbeResult | null;
}

export type VerifyOutputsResult =
  | { ok: true; files: VerifiedOutput[]; totalBytes: number }
  | {
      ok: false;
      code: 'OUTPUT_MISSING' | 'OUTPUT_TOO_LARGE' | 'OUTPUT_INVALID_MEDIA';
      name: string;
      message: string;
    };

export interface VerifyOutputsOptions {
  /**
   * ffprobe для медиа-результатов по путям относительно каталога попытки.
   * Для CORE: `(f) => executorClient.probe(jobId, attemptId, f)`.
   * По умолчанию — локальный `probeFile`.
   */
  probe?: (relPaths: string[]) => Promise<Array<ProbeResult | null>>;
}

export async function verifyOutputs(
  attemptDir: string,
  outputs: ExecPlan['outputs'],
  limits: LimitsProfile,
  opts: VerifyOutputsOptions = {},
): Promise<VerifyOutputsResult> {
  const root = path.resolve(attemptDir);
  const outDir = path.join(root, 'outputs');
  const realOut = await fsp.realpath(outDir).catch(() => null);
  if (!realOut) {
    return outputs.length
      ? {
          ok: false,
          code: 'OUTPUT_MISSING',
          name: outputs[0].name,
          message: 'outputs directory is missing',
        }
      : { ok: true, files: [], totalBytes: 0 };
  }
  const files: Array<{
    name: string;
    localName: string;
    abs: string;
    bytes: number;
  }> = [];
  let total = 0;
  for (const o of outputs) {
    const abs = path.resolve(root, o.localName);
    if (path.dirname(abs) !== outDir) {
      return {
        ok: false,
        code: 'OUTPUT_MISSING',
        name: o.name,
        message: 'output path is outside outputs/',
      };
    }
    const st = await fsp.lstat(abs).catch(() => null);
    if (!st) {
      return {
        ok: false,
        code: 'OUTPUT_MISSING',
        name: o.name,
        message: `output ${o.name} was not created`,
      };
    }
    if (!st.isFile() || st.nlink !== 1) {
      return {
        ok: false,
        code: 'OUTPUT_INVALID_MEDIA',
        name: o.name,
        message: `output ${o.name} is not a regular file`,
      };
    }
    // Пустой текстовый результат допустим (нет чёрных/замерших кадров —
    // пустой signals.txt); пустой медиафайл — нет.
    if (
      st.size === 0 &&
      OUTPUT_EXTENSIONS[path.extname(o.name).toLowerCase()]?.media !== false
    ) {
      return {
        ok: false,
        code: 'OUTPUT_INVALID_MEDIA',
        name: o.name,
        message: `output ${o.name} is empty`,
      };
    }
    total += st.size;
    if (total > limits.maxTotalOutputBytes) {
      return {
        ok: false,
        code: 'OUTPUT_TOO_LARGE',
        name: o.name,
        message: `outputs exceed ${limits.maxTotalOutputBytes} bytes`,
      };
    }
    files.push({ name: o.name, localName: o.localName, abs, bytes: st.size });
  }

  const mediaIdx = files
    .map((f, i) =>
      OUTPUT_EXTENSIONS[path.extname(f.name).toLowerCase()]?.media ? i : -1,
    )
    .filter((i) => i >= 0);
  const probe =
    opts.probe ??
    (async (rel: string[]) =>
      Promise.all(
        rel.map((r) => probeFile(path.join(root, r)).catch(() => null)),
      ));
  const probes = mediaIdx.length
    ? await probe(mediaIdx.map((i) => files[i].localName))
    : [];
  const byIdx = new Map<number, ProbeResult | null>();
  mediaIdx.forEach((fi, k) => byIdx.set(fi, probes[k] ?? null));

  const result: VerifiedOutput[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const ext = path.extname(f.name).toLowerCase();
    const isMedia = byIdx.has(i);
    const pr = byIdx.get(i) ?? null;
    if (isMedia) {
      const bad = (m: string): VerifyOutputsResult => ({
        ok: false,
        code: 'OUTPUT_INVALID_MEDIA',
        name: f.name,
        message: `output ${f.name}: ${m}`,
      });
      if (!pr) return bad('ffprobe cannot read it');
      const video = pr.streams.filter((s) => s.type === 'video');
      const audio = pr.streams.filter((s) => s.type === 'audio');
      if (ext === '.mp4') {
        if (!video.length) return bad('no video stream');
        if (!pr.durationSec || pr.durationSec <= 0) return bad('zero duration');
      }
      if (ext === '.m4a') {
        if (!audio.length) return bad('no audio stream');
        if (!pr.durationSec || pr.durationSec <= 0) return bad('zero duration');
      }
      if (ext === '.jpg' && (!video.length || !video[0].width))
        return bad('not an image');
      result.push({
        name: f.name,
        localName: f.localName,
        bytes: pr.bytes,
        sha256: pr.sha256,
        mime: pr.mime,
        probe: pr,
      });
      continue;
    }
    const { bytes, sha256 } = await sha256File(f.abs);
    result.push({
      name: f.name,
      localName: f.localName,
      bytes,
      sha256,
      mime: OUTPUT_EXTENSIONS[ext]?.mime ?? mimeFor(f.name, null),
      probe: null,
    });
  }
  return { ok: true, files: result, totalBytes: total };
}
