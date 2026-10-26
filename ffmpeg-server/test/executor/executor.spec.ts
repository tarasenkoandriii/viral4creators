import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { groupMembers, sampleProc } from '../../src/executor/proc';
import {
  clampThreadArgs,
  sanitizeStderr,
  validateFiltergraphArg,
  validateStepArgv,
} from '../../src/executor/executor';
import {
  CONTROL,
  controlPath,
  writeJsonAtomic,
} from '../../src/executor/protocol';
import type { ExecutorState } from '../../src/contracts';
import { verifyOutputs } from '../../src/probe/outputs';
import { PILOT_LIMITS } from '../fixtures/limits';
import { loadCorpus } from '../fixtures/corpus';
import {
  FFMPEG_ABS,
  Harness,
  MediaLib,
  ids,
  makeHarness,
  mustParse,
  runToDone,
  startPlan,
  waitFor,
} from './harness';

jest.setTimeout(180_000);

let h: Harness;
let lib: MediaLib;

beforeAll(async () => {
  h = makeHarness();
  lib = new MediaLib();
  await h.executor.init({ capabilities: false });
});

afterAll(async () => {
  await h.executor.shutdown();
  h.cleanup();
  lib.cleanup();
});

const corpus = loadCorpus();
const entry = (id: string) => {
  const e = corpus.find((x) => x.id === id);
  if (!e) throw new Error(`no corpus entry ${id}`);
  return e;
};

/** Бесконечная команда: вход зациклен, выход — null. */
const endless = () =>
  mustParse({
    input_files: { src: 'https://inputs.test/src.mp4' },
    output_files: ['sig.txt'],
    ffmpeg_commands: [
      '-stream_loop -1 -i {{src}} -vf "metadata=mode=print:file={{sig.txt}}" -an -t 600 -f null -',
    ],
  });

describe('executor: функциональные сценарии', () => {
  it('постер (корпус shared-video/poster) → succeeded, JPEG проходит проверку', async () => {
    const e = entry('shared-video/poster');
    const plan = mustParse(e.request);
    const a = await startPlan(h, plan, lib);
    const done = await runToDone(h, a.attemptId);
    expect(done).toMatchObject({
      outcome: 'succeeded',
      failedStep: null,
      exitCode: 0,
    });
    expect(done.ffmpegVersion).toMatch(/^\d/);
    const v = await verifyOutputs(a.dir, plan.outputs, PILOT_LIMITS);
    expect(v).toMatchObject({ ok: true, files: [{ mime: 'image/jpeg' }] });
    // state.json — exited, процессов группы нет.
    const st = JSON.parse(
      readFileSync(controlPath(a.dir, CONTROL.state), 'utf8'),
    ) as ExecutorState;
    expect(st.status).toBe('exited');
  });

  it('цепочка из двух команд с промежуточным файлом', async () => {
    const plan = mustParse({
      input_files: { src: 'https://inputs.test/a.mp4' },
      output_files: ['final.mp4'],
      ffmpeg_commands: [
        '-i {{src}} -t 1 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac {{tmp.mp4}}',
        'ffmpeg -i {{tmp.mp4}} -vf "scale=160:-2" -c:v libx264 -preset veryfast -c:a copy -movflags +faststart {{final.mp4}}',
      ],
    });
    expect(plan.intermediates).toEqual(['work/tmp.mp4']);
    const a = await startPlan(h, plan, lib);
    const done = await runToDone(h, a.attemptId);
    expect(done.outcome).toBe('succeeded');
    expect(existsSync(join(a.dir, 'work', 'tmp.mp4'))).toBe(true);
    const v = await verifyOutputs(a.dir, plan.outputs, PILOT_LIMITS);
    if (!v.ok) throw new Error(v.message);
    const video = v.files[0].probe!.streams.find((s) => s.type === 'video')!;
    expect(video.width).toBe(160);
    expect(v.files[0].probe!.durationSec).toBeLessThan(1.2);
  });

  it('отказ второй команды → failed, failedStep=1, результат не объявлен полным', async () => {
    const plan = mustParse({
      input_files: { src: 'https://inputs.test/a.mp4' },
      output_files: ['first.mp4', 'second.mp4'],
      ffmpeg_commands: [
        '-i {{src}} -t 1 -c:v libx264 -preset veryfast -c:a aac {{first.mp4}}',
        '-i {{first.mp4}} -map 7:v -c:v libx264 {{second.mp4}}',
      ],
    });
    const a = await startPlan(h, plan, lib);
    const done = await runToDone(h, a.attemptId);
    expect(done).toMatchObject({ outcome: 'failed', failedStep: 1 });
    expect(done.exitCode).not.toBe(0);
    expect(done.stderrTail.length).toBeGreaterThan(0);
    expect(done.stderrTail).not.toContain(h.root);
    expect(
      await verifyOutputs(a.dir, plan.outputs, PILOT_LIMITS),
    ).toMatchObject({
      ok: false,
      code: 'OUTPUT_MISSING',
      name: 'second.mp4',
    });
  });

  it('timeout: дедлайн убивает группу процессов, сирот нет', async () => {
    const a = await startPlan(h, endless(), lib, { deadlineMs: 800 });
    const t0 = Date.now();
    const done = await runToDone(h, a.attemptId);
    expect(done.outcome).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(10_000);
    const st = JSON.parse(
      readFileSync(controlPath(a.dir, CONTROL.state), 'utf8'),
    ) as ExecutorState & {
      procStartTime: number;
    };
    expect(st.status).toBe('exited');
    expect(done.signal).toBe('SIGKILL');
  });

  it('cancel во время работы: heartbeat с прогрессом, затем canceled без сирот', async () => {
    const a = await startPlan(h, endless(), lib);
    const running = h.executor.tick();
    const st = await waitFor(async () => {
      const p = await h.client.poll(a.attemptId);
      return p.kind === 'running' && p.state.pid && p.state.outTimeSec !== null
        ? p.state
        : null;
    });
    const pgid = st.pid!;
    // Ресурсы для overview: CPU/RSS ffmpeg в state.json.
    const res = await waitFor(async () => {
      const raw = JSON.parse(
        readFileSync(controlPath(a.dir, CONTROL.state), 'utf8'),
      ) as Record<string, number | null>;
      return raw.rssKb && raw.sampledAt ? raw : null;
    });
    expect(res.rssKb).toBeGreaterThan(0);
    expect(res.peakRssKb).toBeGreaterThanOrEqual(res.rssKb!);
    expect(typeof res.cpuMs).toBe('number');
    expect(Date.now() - res.sampledAt!).toBeLessThan(5000);
    expect(await h.client.isAlive(a.attemptId, 2000)).toBe(true);
    expect((await groupMembers(pgid)).length).toBeGreaterThan(0);
    await h.client.cancel(a.attemptId);
    await h.client.cancel(a.attemptId); // идемпотентно
    await running;
    const p = await h.client.poll(a.attemptId);
    expect(p).toMatchObject({ kind: 'done', done: { outcome: 'canceled' } });
    expect(await groupMembers(pgid)).toEqual([]);
    expect(await sampleProc(pgid)).toBeNull();
    expect(await h.client.isAlive(a.attemptId, 60_000)).toBe(false);
  });

  it('превышение записи → too_large', async () => {
    const plan = mustParse({
      input_files: { src: 'https://inputs.test/a.mp4' },
      output_files: ['big.mp4'],
      ffmpeg_commands: [
        '-stream_loop -1 -i {{src}} -c:v libx264 -preset ultrafast -crf 0 -c:a aac -t 600 {{big.mp4}}',
      ],
    });
    const a = await startPlan(h, plan, lib, { maxWriteBytes: 300_000 });
    const done = await runToDone(h, a.attemptId);
    expect(done.outcome).toBe('too_large');
  });

  it('субтитры ASS с кириллицей и украинскими буквами: глифы найдены, кадр изменён', async () => {
    const e = entry('client-site-tutorial/voiced-fade-captions');
    const plan = mustParse(e.request);
    expect(e.textInputs.captions).toMatch(/ґудзик/);
    const a = await startPlan(h, plan, lib, { text: e.textInputs });
    const done = await runToDone(h, a.attemptId);
    expect(done.outcome).toBe('succeeded');
    expect(done.stderrTail).not.toMatch(
      /Glyph 0x|failed to find any fallback|fontselect: failed/i,
    );
    // Тот же рендер без подписей отличается в кадре с подписью.
    const out = join(a.dir, 'outputs', 'tutorial.mp4');
    const frame = (file: string, at: number) =>
      spawnSync(
        FFMPEG_ABS,
        [
          '-v',
          'error',
          '-ss',
          String(at),
          '-i',
          file,
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'gray',
          '-',
        ],
        {
          maxBuffer: 64 * 1024 * 1024,
        },
      ).stdout;
    const plain = mustParse({
      ...e.request,
      ffmpeg_commands: [
        e.request.ffmpeg_commands[0]
          .replace(';[outv]subtitles={{captions}}[outc]', '')
          .replace('-map "[outc]"', '-map "[outv]"'),
      ],
      input_files: Object.fromEntries(
        Object.entries(e.request.input_files).filter(([k]) => k !== 'captions'),
      ),
    });
    const b = await startPlan(h, plain, lib);
    expect((await runToDone(h, b.attemptId)).outcome).toBe('succeeded');
    const withSubs = frame(out, 1);
    const without = frame(join(b.dir, 'outputs', 'tutorial.mp4'), 1);
    expect(withSubs.length).toBe(without.length);
    let diff = 0;
    for (let i = 0; i < withSubs.length; i++)
      if (Math.abs(withSubs[i] - without[i]) > 40) diff++;
    expect(diff).toBeGreaterThan(500);
  });

  it('SRT с UK/RU/EN через force_style (корпус actors/subtitle-burn)', async () => {
    const e = entry('actors/subtitle-burn');
    const plan = mustParse(e.request);
    const a = await startPlan(h, plan, lib, { text: e.textInputs });
    const done = await runToDone(h, a.attemptId);
    expect(done.outcome).toBe('succeeded');
    expect(done.stderrTail).not.toMatch(
      /Glyph 0x|failed to find any fallback/i,
    );
  });

  it('некорректный request → failed без запуска ffmpeg', async () => {
    const { jobId, attemptId } = ids();
    const p = await h.client.prepareAttempt(jobId, attemptId);
    await writeJsonAtomic(controlPath(p.dir, CONTROL.request), {
      version: 1,
      jobId,
      attemptId,
      steps: [{ argv: ['-i', '/etc/passwd', 'outputs/x.mp4'] }],
      deadlineAt: Date.now() + 10_000,
      maxThreads: 2,
      stderrTailBytes: 1000,
      maxWriteBytes: 1000,
    });
    const done = await runToDone(h, attemptId);
    expect(done).toMatchObject({ outcome: 'failed', failedStep: null });
    expect(done.stderrTail).toMatch(/invalid request/);
  });

  it('отмена до старта → canceled без запуска', async () => {
    const a = await startPlan(h, endless(), lib);
    await h.client.cancel(a.attemptId);
    expect(await runToDone(h, a.attemptId)).toMatchObject({
      outcome: 'canceled',
      exitCode: null,
    });
  });

  it('повторный start той же попытки отклоняется', async () => {
    const plan = endless();
    const a = await startPlan(h, plan, lib);
    await expect(
      h.client.start({
        version: 1,
        jobId: a.jobId,
        attemptId: a.attemptId,
        steps: plan.steps,
        deadlineAt: Date.now() + 1000,
        maxThreads: 2,
        stderrTailBytes: 100,
        maxWriteBytes: 100,
      }),
    ).rejects.toMatchObject({ reason: 'already_started' });
    await h.client.cancel(a.attemptId);
    await runToDone(h, a.attemptId);
  });

  it('probe через executor: ffprobe внутри, sha256 на стороне API', async () => {
    const plan = mustParse(entry('shared-video/poster').request);
    const a = await startPlan(h, plan, lib);
    await h.client.cancel(a.attemptId);
    await runToDone(h, a.attemptId);
    writeFileSync(
      join(a.dir, 'inputs', 'bad.srt'),
      '#EXTM3U\n#EXTINF:1,\nhttp://10.0.0.1/a.ts\n',
    );
    const probing = h.client.probe(
      a.jobId,
      a.attemptId,
      ['inputs/video.mp4', 'inputs/bad.srt', '../x'],
      {
        timeoutMs: 20_000,
        pollMs: 20,
      },
    );
    const ticker = setInterval(() => void h.executor.tick(), 30);
    const res = await probing.finally(() => clearInterval(ticker));
    expect(res[0]).toMatchObject({
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      mime: 'video/mp4',
    });
    expect(res[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res[1]).toBeNull();
    expect(res[2]).toBeNull();
  });
});

describe('executor: Story-фильтры на синтетике (loudnorm, sidechaincompress, amix normalize=0)', () => {
  it.each([
    'story/stems-music-ducking-effects',
    'story/segments-recorded-narrator-note-outro',
  ])('%s', async (id) => {
    const e = entry(id);
    const plan = mustParse(e.request);
    const a = await startPlan(h, plan, lib);
    const done = await runToDone(h, a.attemptId);
    if (done.outcome !== 'succeeded') throw new Error(done.stderrTail);
    expect(done.outcome).toBe('succeeded');
    const v = await verifyOutputs(a.dir, plan.outputs, PILOT_LIMITS);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const pr = v.files[0].probe!;
    const video = pr.streams.find((s) => s.type === 'video')!;
    const audio = pr.streams.find((s) => s.type === 'audio')!;
    expect([video.width, video.height]).toEqual([1280, 720]);
    expect(audio.sampleRate).toBe(48000);
    const expected = Number(
      /-t (\d+\.\d+)/.exec(e.request.ffmpeg_commands[0])![1],
    );
    expect(Math.abs((pr.durationSec ?? 0) - expected)).toBeLessThan(0.15);
    expect(done.peakRssKb).toBeGreaterThan(0);
    expect(done.cpuMs).toBeGreaterThan(0);
  });
});

describe('executor: восстановление после рестарта', () => {
  it('попытка прежнего процесса: группа убита, abandoned.json — доказательство', async () => {
    const h2 = makeHarness();
    try {
      const { jobId, attemptId } = ids();
      const p = await h2.client.prepareAttempt(jobId, attemptId);
      // «Старый» ffmpeg, оставшийся от упавшего executor.
      const orphan = spawn(
        FFMPEG_ABS,
        [
          '-nostdin',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc',
          '-f',
          'null',
          '-',
        ],
        {
          detached: true,
          stdio: 'ignore',
        },
      );
      const pid = orphan.pid!;
      const sample = await waitFor(() => sampleProc(pid));
      await writeJsonAtomic(controlPath(p.dir, CONTROL.request), {
        version: 1,
      });
      await writeJsonAtomic(controlPath(p.dir, CONTROL.state), {
        version: 1,
        attemptId,
        status: 'running',
        pid,
        startedAt: Date.now() - 5000,
        heartbeatAt: Date.now() - 5000,
        stepIndex: 0,
        outTimeSec: 1,
        executorInstance: 'old',
        procStartTime: sample.startTime,
      });
      expect(await h2.client.isAlive(attemptId, 1000)).toBe(false); // устарел, но не доказательство
      expect((await h2.client.poll(attemptId)).kind).toBe('running');
      const exited = new Promise((r) => orphan.on('exit', r));
      await h2.executor.init({ capabilities: false });
      await exited;
      const st = await h2.client.poll(attemptId);
      expect(st).toMatchObject({
        kind: 'abandoned',
        marker: { killed: true, pgid: pid },
      });
      expect(await groupMembers(pid)).toEqual([]);
    } finally {
      await h2.executor.shutdown();
      h2.cleanup();
    }
  });
});

describe('executor: цикл, heartbeat, capability self-test', () => {
  it('loop подбирает попытку по сканированию, глобальный heartbeat свежий', async () => {
    const h3 = makeHarness();
    const ac = new AbortController();
    try {
      await h3.executor.init({ capabilities: false });
      const loop = h3.executor.loop(ac.signal);
      const plan = mustParse(entry('shared-video/poster').request);
      const a = await startPlan(h3, plan, lib);
      const done = await waitFor(async () => {
        const p = await h3.client.poll(a.attemptId);
        return p.kind === 'done' ? p.done : null;
      });
      expect(done.outcome).toBe('succeeded');
      // done.json is published before the executor's finally block clears
      // busyAttemptId and atomically updates the global heartbeat.
      const status = await waitFor(async () => {
        const current = await h3.client.executorStatus(5000);
        return current?.fresh && current.heartbeat.busyAttemptId === null
          ? current
          : null;
      });
      expect(status.fresh).toBe(true);
      expect(status.heartbeat.busyAttemptId).toBeNull();
      ac.abort();
      await loop;
    } finally {
      ac.abort();
      await h3.executor.shutdown();
      h3.cleanup();
    }
  });

  it('self-test: все компоненты корпуса есть, смоук libass+x264+aac прошёл', async () => {
    const caps = await h.executor.selfTest();
    expect(caps.missing).toEqual([]);
    expect(caps.smokeError).toBeNull();
    expect(caps).toMatchObject({ ok: true, smokeOk: true });
    expect(caps.buildConfiguration).toMatch(/--enable-libx264/);
    expect(await h.client.capabilities()).toMatchObject({ ok: true });
  });
});

describe('executor: чистые функции', () => {
  it('validateStepArgv', () => {
    expect(
      validateStepArgv(['-i', 'inputs/a.mp4', 'outputs/b.mp4']),
    ).toBeNull();
    expect(validateStepArgv(['-i', '/etc/passwd', 'outputs/b.mp4'])).toMatch(
      /-i/,
    );
    expect(validateStepArgv(['-i', 'inputs/a.mp4', '/tmp/b.mp4'])).toMatch(
      /absolute/,
    );
    expect(validateStepArgv(['-i', 'inputs/../x', 'o'])).toMatch(/-i/);
    expect(validateStepArgv(['-i', 'inputs/a.mp4', 'https://x/a.mp4'])).toMatch(
      /URL/,
    );
    expect(validateStepArgv(['a\u0000'])).toMatch(/NUL/);
  });

  it('clampThreadArgs', () => {
    expect(
      clampThreadArgs(
        ['-threads', '16', '-filter_threads', '0', '-threads', '1'],
        2,
      ),
    ).toEqual(['-threads', '2', '-filter_threads', '2', '-threads', '1']);
  });

  it('sanitizeStderr убирает пути вне workspace и режет хвост по байтам', () => {
    const s = sanitizeStderr(
      "Error opening /work/ws/j/a/inputs/x.mp4 and '/etc/fonts/x.conf' (/usr/lib/libass.so)",
      '/work/ws/j/a',
      1000,
    );
    expect(s).toBe("Error opening inputs/x.mp4 and '<path>' (<path>)");
    expect(
      Buffer.byteLength(sanitizeStderr('ж'.repeat(100), '/x', 11), 'utf8'),
    ).toBeLessThanOrEqual(11);
  });
});

describe('executor: только DejaVu (минимальный набор шрифтов образа)', () => {
  const DEJAVU = '/usr/share/fonts/truetype/dejavu';
  let hd: Harness;
  let fcDir: string;

  beforeAll(async () => {
    fcDir = mkdtempSync(join(tmpdir(), 'fc-'));
    const conf = join(fcDir, 'fonts.conf');
    // Ровно то, что предлагается образу: каталог DejaVu и алиас Arial.
    writeFileSync(
      conf,
      `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${DEJAVU}</dir>
  <cachedir>${fcDir}/cache</cachedir>
  <alias binding="same"><family>Arial</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias binding="same"><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
</fontconfig>
`,
    );
    hd = makeHarness({ passEnv: { FONTCONFIG_FILE: conf } });
    await hd.executor.init({ capabilities: false });
  });

  afterAll(async () => {
    await hd.executor.shutdown();
    hd.cleanup();
    rmSync(fcDir, { recursive: true, force: true });
  });

  it.each([
    'actors/subtitle-burn',
    'postprod/voiceover-crop-subs-cards-music-sticker',
    'tutorial-video-versions/preamble-captions',
    'portfolio/watermark-slight-cyrillic',
  ])('%s: глифы кириллицы/UK найдены без Arial', async (id) => {
    expect(existsSync(join(DEJAVU, 'DejaVuSans.ttf'))).toBe(true);
    const e = entry(id);
    const plan = mustParse(e.request);
    const a = await startPlan(hd, plan, lib, { text: e.textInputs });
    const done = await runToDone(hd, a.attemptId);
    if (done.outcome !== 'succeeded') throw new Error(done.stderrTail);
    expect(done.stderrTail).not.toMatch(
      /Glyph 0x|failed to find any fallback|fontselect: failed|Could not load font/i,
    );
  });
});

describe('аудит SEC FF-SEC-01: вторая линия в executor (в обход parseJob)', () => {
  const argvFor = (graph: string, out = 'outputs/o.jpg') => [
    '-nostdin',
    '-y',
    '-i',
    'inputs/v.mp4',
    '-vf',
    graph,
    '-frames:v',
    '1',
    out,
  ];

  it.each([
    [
      'drawtext /text= чужой задачи',
      'drawtext=/text=../../victimjob/att1/outputs/private.txt',
    ],
    ['drawtext /text= абсолютный', 'drawtext=/text=/etc/hostname'],
    ['metadata /file= из входа', 'metadata=mode=print:/file=inputs/p.txt'],
    ['экранированный ключ', 'drawtext=\\/text=x'],
    ['textfile', 'drawtext=textfile=inputs/p.txt'],
    [
      'subtitles вне попытки',
      'subtitles=../../victimjob/att1/outputs/private.txt',
    ],
    ['movie', 'movie=inputs/v.mp4'],
  ])('%s → failed, файл соседней задачи не тронут', async (_n, graph) => {
    const victim = join(h.root, 'victimjob', 'att1', 'outputs');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'private.txt'), 'VICTIM-PRIVATE-99');
    const { jobId, attemptId } = ids();
    const p = await h.client.prepareAttempt(jobId, attemptId);
    copyFileSync(lib.get('video'), join(p.dir, 'inputs', 'v.mp4'));
    writeFileSync(join(p.dir, 'inputs', 'p.txt'), join(victim, 'private.txt'));
    await writeJsonAtomic(controlPath(p.dir, CONTROL.request), {
      version: 1,
      jobId,
      attemptId,
      steps: [{ argv: argvFor(graph) }],
      deadlineAt: Date.now() + 30_000,
      maxThreads: 2,
      stderrTailBytes: 4096,
      maxWriteBytes: 50_000_000,
    });
    const done = await runToDone(h, attemptId);
    expect(done).toMatchObject({ outcome: 'failed', failedStep: null });
    expect(done.stderrTail).toMatch(/invalid request/);
    expect(readFileSync(join(victim, 'private.txt'), 'utf8')).toBe(
      'VICTIM-PRIVATE-99',
    );
    expect(existsSync(join(p.dir, 'outputs', 'o.jpg'))).toBe(false);
  });

  it('validateFiltergraphArg: корпусные графы проходят', () => {
    for (const e of corpus) {
      const plan = mustParse(e.request);
      for (const s of plan.steps) expect(validateStepArgv(s.argv)).toBeNull();
    }
    expect(
      validateFiltergraphArg('subtitles=inputs/s.srt:force_style=A=1'),
    ).toBeNull();
    expect(validateFiltergraphArg('[0:v]drawtext=/text=/x[v]')).toMatch(
      /\/key/,
    );
    expect(validateFiltergraphArg("drawtext=text='a b'")).toBeNull();
    expect(validateFiltergraphArg("drawtext=text='%{pts}'")).toMatch(
      /expansion/,
    );
    expect(
      validateFiltergraphArg("drawtext=expansion=none:text='100%'"),
    ).toBeNull();
    expect(validateStepArgv(['-/vf', 'inputs/x', 'outputs/o.mp4'])).toMatch(
      /-\/opt/,
    );
    expect(
      validateStepArgv(['-filter_complex_script', 'inputs/x', 'outputs/o.mp4']),
    ).toMatch(/not allowed/);
  });
});

describe('bounded Tutorial in one executor attempt', () => {
  it.each(['none', 'fade', 'fade+zoom', 'whole', 'mixed', 'decorated'])(
    '%s: parts produce one timed final video',
    async (motion) => {
      const e = entry(`tutorial-runner/bounded-${motion}`);
      const plan = mustParse(e.request);
      expect(plan.steps).toHaveLength(3);
      expect(plan.intermediates).toHaveLength(2);
      const a = await startPlan(h, plan, lib, { text: e.textInputs });
      const done = await runToDone(h, a.attemptId);
      if (done.outcome !== 'succeeded') throw new Error(done.stderrTail);
      const result = await verifyOutputs(a.dir, plan.outputs, PILOT_LIMITS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const probe = result.files[0].probe!;
      const expected =
        motion === 'none' ? 13.5 : motion === 'decorated' ? 17.5 : 11.1;
      expect(Math.abs(probe.durationSec! - expected)).toBeLessThanOrEqual(
        1 / 30,
      );
      expect(probe.streams.some((s) => s.type === 'audio')).toBe(true);
      expect(result.files).toHaveLength(1);
    },
  );
});
