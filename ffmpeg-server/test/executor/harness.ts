import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Executor } from '../../src/executor/executor';
import { ExecutorClient, ExecutorPoll } from '../../src/executor/client';
import { parseJob } from '../../src/command/parse';
import type {
  ExecPlan,
  ExecutorDone,
  JobRequestBody,
} from '../../src/contracts';
import { PILOT_LIMITS } from '../fixtures/limits';
import {
  FFMPEG,
  FFPROBE,
  makeAudio,
  makeImage,
  makeVideo,
} from '../fixtures/media';

export interface Harness {
  root: string;
  executor: Executor;
  client: ExecutorClient;
  cleanup: () => void;
}

export function makeHarness(
  over: Partial<ConstructorParameters<typeof Executor>[0]> = {},
): Harness {
  const root = mkdtempSync(join(tmpdir(), 'ffexec-'));
  const tmp = mkdtempSync(join(tmpdir(), 'ffexec-tmp-'));
  const executor = new Executor({
    workspaceRoot: root,
    ffmpegBin: FFMPEG_ABS,
    ffprobeBin: FFPROBE_ABS,
    pollMs: 50,
    heartbeatMs: 100,
    monitorMs: 50,
    tmpDir: tmp,
    ...over,
  });
  const client = new ExecutorClient({ workspaceRoot: root });
  return {
    root,
    executor,
    client,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function which(bin: string): string {
  if (bin.startsWith('/')) return bin;
  for (const d of ['/usr/bin', '/usr/local/bin', '/bin']) {
    if (existsSync(join(d, bin))) return join(d, bin);
  }
  return bin;
}
export const FFMPEG_ABS = which(FFMPEG);
export const FFPROBE_ABS = which(FFPROBE);

let seq = 0;
export function ids(): { jobId: string; attemptId: string } {
  seq++;
  return { jobId: `job${seq}`, attemptId: `att${seq}-${Date.now()}` };
}

export function mustParse(body: JobRequestBody): ExecPlan {
  const r = parseJob(body, PILOT_LIMITS);
  if (!r.ok) throw new Error(`parseJob: ${r.code} ${r.message}`);
  return r.plan;
}

/** Библиотека синтетических исходников, копируемых во входы попыток. */
export class MediaLib {
  readonly dir = mkdtempSync(join(tmpdir(), 'ffmedia-'));
  private cache = new Map<string, string>();

  get(kind: string): string {
    const hit = this.cache.get(kind);
    if (hit) return hit;
    const f = join(this.dir, kind);
    switch (kind) {
      case 'video':
        makeVideo(f, { d: 3 });
        break;
      case 'video-silent':
        makeVideo(f, { d: 3, audio: false });
        break;
      case 'video-long':
        makeVideo(f, { d: 20, w: 160, h: 120 });
        break;
      case 'story-base':
        makeVideo(f, { d: 62.5, w: 64, h: 36, audio: false });
        break;
      case 'mp3':
        makeAudio(f, { d: 2.5, format: 'mp3' });
        break;
      case 'wav':
        makeAudio(f, { d: 3, format: 'wav', f: 220 });
        break;
      case 'mp3-long':
        makeAudio(f, { d: 12, format: 'mp3', f: 180 });
        break;
      case 'png':
        makeImage(f);
        break;
      case 'preamble':
        makeVideo(f, { d: 6.5, w: 360, h: 640 });
        break;
      default:
        throw new Error(`unknown media kind ${kind}`);
    }
    this.cache.set(kind, f);
    return f;
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Вид медиа по ключу и расширению локального имени. */
export function kindFor(key: string, localName: string): string {
  const ext = localName.split('/').pop()!.includes('.')
    ? localName.slice(localName.lastIndexOf('.'))
    : '';
  if (ext === '.mp4') return key === 'preamble' ? 'preamble' : 'video';
  if (ext === '.mp3') return 'mp3';
  if (ext === '.wav') return 'wav';
  if (ext === '.png') return 'png';
  // Story: входы без расширения.
  if (key === 'base') return 'story-base';
  if (['cover', 'narrator', 'note_visual', 'outro_visual'].includes(key))
    return 'png';
  if (key === 'music') return 'mp3-long';
  return 'mp3';
}

export function stageInputs(
  attemptDir: string,
  plan: ExecPlan,
  lib: MediaLib,
  text: Record<string, string> = {},
): void {
  for (const i of plan.inputs) {
    const dest = join(attemptDir, i.localName);
    mkdirSync(dirname(dest), { recursive: true });
    if (text[i.key] !== undefined) writeFileSync(dest, text[i.key]);
    else copyFileSync(lib.get(kindFor(i.key, i.localName)), dest);
  }
}

export async function startPlan(
  h: Harness,
  plan: ExecPlan,
  lib: MediaLib,
  o: {
    text?: Record<string, string>;
    deadlineMs?: number;
    maxWriteBytes?: number;
  } = {},
): Promise<{ jobId: string; attemptId: string; dir: string }> {
  const { jobId, attemptId } = ids();
  const p = await h.client.prepareAttempt(jobId, attemptId);
  stageInputs(p.dir, plan, lib, o.text);
  await h.client.start({
    version: 1,
    jobId,
    attemptId,
    steps: plan.steps,
    deadlineAt: Date.now() + (o.deadlineMs ?? 170_000),
    maxThreads: 2,
    stderrTailBytes: 64 * 1024,
    maxWriteBytes: o.maxWriteBytes ?? 512 * 1024 * 1024,
  });
  return { jobId, attemptId, dir: p.dir };
}

export async function runToDone(
  h: Harness,
  attemptId: string,
): Promise<ExecutorDone> {
  await h.executor.tick();
  const st: ExecutorPoll = await h.client.poll(attemptId);
  if (st.kind !== 'done') throw new Error(`attempt not done: ${st.kind}`);
  return st.done;
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}
