/**
 * Приёмка темпа обучалок на НАСТОЯЩЕМ ffmpeg (спецификация, «Приёмка»):
 * проверяется декодированное видео и звук, а не текст команды.
 *
 * Внешний ffmpeg-api подменён локальным ffmpeg: та же команда
 * `planSlideshow`, плейсхолдеры `{{ключ}}` заменены путями к файлам.
 * Набор пропускается, если ffmpeg/ffprobe в окружении нет (CI без
 * бинаря) — тогда инварианты держат юнит-тесты планировщика.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  planSlideshow,
  frameSpansSeconds,
  narrationFrameSeconds,
  SlideshowMotion,
} from '../tutorial-runner/tutorial-video-assembly';
import {
  buildTutorialManifest,
  manifestCaptionFrames,
  manifestSlides,
  ManifestFrame,
  tempoInputs,
} from '../tutorial-runner/tutorial-manifest';
import {
  planTempo,
  SPEECH_GUARD_SECONDS,
  TEMPO_PRESETS,
} from '../tutorial-runner/tutorial-tempo';
import {
  buildTutorialCaptionsAss,
  captionReadingSeconds,
} from '../tutorial-runner/tutorial-captions';
import { checkTutorialVideo, probeMp4 } from '../tutorial-runner/mp4-probe';

const HAS_FFMPEG =
  spawnSync('ffmpeg', ['-version']).status === 0 &&
  spawnSync('ffprobe', ['-version']).status === 0;
const maybe = HAS_FFMPEG ? describe : describe.skip;

function run(cmd: string): void {
  const r = spawnSync('bash', ['-c', cmd], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON ffprobe
function ffprobeJson(file: string, args: string): any {
  const r = spawnSync(
    'bash',
    ['-c', `ffprobe -v error ${args} -of json "${file}"`],
    {
      encoding: 'utf8',
    },
  );
  return JSON.parse(r.stdout);
}

/** Локальный «ffmpeg-api»: та же команда, плейсхолдеры → файлы. */
function localAssemble(
  plan: {
    inputs: Record<string, string>;
    commands: string[];
    outputName: string;
  },
  files: Record<string, string>,
  out: string,
): void {
  let cmd = plan.commands[0];
  for (const [key, url] of Object.entries(plan.inputs)) {
    cmd = cmd.split(`{{${key}}}`).join(files[url] ?? url);
  }
  cmd = cmd.split(`{{${plan.outputName}}}`).join(out);
  run(`ffmpeg -y -hide_banner -loglevel error ${cmd}`);
}

/** Интервалы звучания по 10-мс окнам (моно 44.1 кГц, s16le). */
function voicedRuns(
  file: string,
  dir: string,
): Array<{ start: number; end: number }> {
  const pcm = join(dir, 'a.raw');
  run(
    `ffmpeg -y -hide_banner -loglevel error -i "${file}" -vn -ac 1 -ar 44100 -f s16le "${pcm}"`,
  );
  const buf = readFileSync(pcm);
  const samples = buf.length / 2;
  const win = 441;
  const runs: Array<{ start: number; end: number }> = [];
  let open: number | null = null;
  for (let w = 0; w * win < samples; w++) {
    let sum = 0;
    const n = Math.min(win, samples - w * win);
    for (let i = 0; i < n; i++) {
      const v = buf.readInt16LE((w * win + i) * 2);
      sum += v * v;
    }
    const loud = Math.sqrt(sum / n) > 1500;
    if (loud && open === null) open = w;
    if (!loud && open !== null) {
      runs.push({ start: open * 0.01, end: w * 0.01 });
      open = null;
    }
  }
  if (open !== null)
    runs.push({ start: open * 0.01, end: Math.ceil(samples / win) * 0.01 });
  return runs;
}

maybe('приёмка темпа на настоящем ffmpeg', () => {
  jest.setTimeout(240_000);
  let dir: string;
  const files: Record<string, string> = {};
  /** Реплики — тон известной длины; длина измеряется ffprobe, как у TTS. */
  const SPEECH = [2.37, null, 0.91, null, 4.12];
  const frames: ManifestFrame[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tempo-acc-'));
    const colors = ['red', 'green', 'blue', 'yellow', 'white'];
    SPEECH.forEach((speech, i) => {
      const png = join(dir, `f${i}.png`);
      run(
        `ffmpeg -y -hide_banner -loglevel error -f lavfi -i color=c=${colors[i]}:s=780x1688 -frames:v 1 "${png}"`,
      );
      const imageUrl = `https://blob/frames/${i}.png`;
      files[imageUrl] = png;
      let speechEntry: ManifestFrame['speech'] = null;
      if (speech !== null) {
        const mp3 = join(dir, `v${i}.mp3`);
        run(
          `ffmpeg -y -hide_banner -loglevel error -f lavfi -i sine=frequency=440:sample_rate=44100:duration=${speech} -c:a libmp3lame -b:a 128k "${mp3}"`,
        );
        const measured = Number(
          ffprobeJson(mp3, '-show_entries format=duration').format.duration,
        );
        const url = `https://blob/voice/${i}.mp3`;
        files[url] = mp3;
        speechEntry = {
          url,
          pathname: null,
          seconds: measured,
          text: `Реплика ${i}`,
          provenance: {
            provider: 'resemble',
            voiceId: null,
            locale: 'ru',
            textSha: `s${i}`,
          },
        };
      }
      const caption =
        i === 3
          ? 'Немой кадр с подписью, которую надо успеть прочитать.'
          : (speechEntry?.text ?? null);
      const reading = caption ? captionReadingSeconds(caption) : null;
      const base = narrationFrameSeconds(speechEntry?.seconds ?? null);
      frames.push({
        frameId: `step-${i}`,
        stepIndex: i,
        image: { url: imageUrl, pathname: null },
        baseSeconds:
          speechEntry || reading === null ? base : Math.max(base, reading),
        speech: speechEntry,
        caption,
        readingSeconds: reading,
        pointer: i === 2 ? { x: 0.5, y: 0.8 } : null,
      });
    });
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const cases: Array<{
    factor: number;
    motion: SlideshowMotion;
    captions: boolean;
  }> = [
    { factor: TEMPO_PRESETS.fast, motion: 'fade', captions: true },
    { factor: 0, motion: 'none', captions: false },
    { factor: TEMPO_PRESETS.calm, motion: 'fade', captions: false },
  ];

  for (const c of cases) {
    it(`×${c.factor}, ${c.motion}${c.captions ? ', с подписями' : ''}: кадры и сэмплы сходятся с планом, речь не обрезана`, () => {
      const m = buildTutorialManifest({
        sourceAssetId: 'a1',
        owner: { kind: 'client-site', draftId: 'd1', userId: 'u1' },
        assetContentHash: 'h',
        locale: 'ru',
        theme: null,
        motion: c.motion,
        captions: c.captions,
        narration: 'per-frame',
        storage: 'draft-frames',
        frames,
      });
      const tempo = planTempo(tempoInputs(m), {
        factor: c.factor,
        motion: c.motion,
      })!;
      let captionsUrl: string | null = null;
      if (c.captions) {
        const ass = join(dir, `c-${c.factor}.ass`);
        writeFileSync(
          ass,
          buildTutorialCaptionsAss(
            manifestCaptionFrames(m, tempo.seconds),
            c.motion,
          ),
        );
        captionsUrl = 'https://blob/captions.ass';
        files[captionsUrl] = ass;
      }
      const plan = planSlideshow(manifestSlides(m, tempo.seconds), {
        captionsUrl,
        motion: c.motion,
      })!;
      expect(plan.durationMs).toBe(tempo.durationMs);
      const out = join(dir, `out-${c.factor}-${c.motion}.mp4`);
      localAssemble(plan, files, out);

      // ffprobe: число кадров видео и размер.
      const v = ffprobeJson(
        out,
        '-count_frames -select_streams v:0 -show_entries stream=nb_read_frames,width,height',
      ).streams[0];
      const expectedFrames = Math.round((tempo.durationMs / 1000) * 30);
      expect(Number(v.nb_read_frames)).toBe(expectedFrames);
      expect([v.width, v.height]).toEqual([720, 1560]);

      // Наш разбор контейнера совпадает с ffprobe — и проверка проходит.
      const bytes = readFileSync(out);
      const probe = probeMp4(bytes)!;
      const video = probe.tracks.find((t) => t.kind === 'video')!;
      const audio = probe.tracks.find((t) => t.kind === 'audio')!;
      expect(video.samples).toBe(Number(v.nb_read_frames));
      const a = ffprobeJson(
        out,
        '-select_streams a:0 -show_entries stream=duration',
      ).streams[0];
      expect(Math.abs(audio.durationSeconds - Number(a.duration))).toBeLessThan(
        0.03,
      );
      const check = checkTutorialVideo(probe, {
        durationMs: tempo.durationMs,
        hasAudio: true,
        width: 720,
        height: 1560,
      });
      expect(check).toMatchObject({ ok: true, problems: [] });

      // Речь: каждая реплика звучит целиком, начинается в начале своего
      // кадра и кончается до начала следующего; немые кадры молчат.
      const spans = frameSpansSeconds(
        tempo.seconds.map((s) => ({ seconds: s })),
        c.motion,
      );
      const runs = voicedRuns(out, dir);
      const violations: string[] = [];
      SPEECH.forEach((nominal, i) => {
        // Окно 10 мс: начало реплики следующего кадра может попасть в
        // последнее окно этого — сравнение с допуском в три окна.
        const inside = runs.filter(
          (r) =>
            r.start >= spans[i].start - 0.03 && r.start < spans[i].end - 0.03,
        );
        if (nominal === null) {
          if (inside.length > 0) violations.push(`${i}: немой кадр звучит`);
          return;
        }
        const speech = frames[i].speech!.seconds!;
        const r = inside[0];
        if (inside.length !== 1) {
          violations.push(`${i}: реплик в кадре ${inside.length}`);
          return;
        }
        if (Math.abs(r.start - spans[i].start) > 0.03) {
          violations.push(`${i}: реплика не с начала кадра`);
        }
        if (r.end - r.start < speech - 0.04) {
          violations.push(
            `${i}: реплика обрезана (${r.end - r.start} < ${speech})`,
          );
        }
        if (i < SPEECH.length - 1) {
          if (r.end > spans[i + 1].start + 0.01) {
            violations.push(`${i}: реплика заходит на следующий кадр`);
          }
          // Запас после речи сохранён и на самом быстром темпе.
          if (
            spans[i + 1].start - (spans[i].start + speech) <
            SPEECH_GUARD_SECONDS - 0.035
          ) {
            violations.push(`${i}: нет запаса после речи`);
          }
        }
      });
      expect(violations).toEqual([]);
    });
  }

  it('техническая проверка ловит файл не той длины', () => {
    const m = buildTutorialManifest({
      sourceAssetId: 'a1',
      owner: { kind: 'client-site', draftId: 'd1', userId: 'u1' },
      assetContentHash: 'h',
      locale: 'ru',
      theme: null,
      motion: 'none',
      captions: false,
      narration: 'per-frame',
      storage: 'draft-frames',
      frames,
    });
    const tempo = planTempo(tempoInputs(m), { factor: 1, motion: 'none' })!;
    const plan = planSlideshow(manifestSlides(m, tempo.seconds), {
      motion: 'none',
    })!;
    const out = join(dir, 'normal.mp4');
    localAssemble(plan, files, out);
    const probe = probeMp4(readFileSync(out));
    // Файл честный, но план «обещал» на две секунды больше.
    const check = checkTutorialVideo(probe, {
      durationMs: tempo.durationMs + 2000,
      hasAudio: true,
      width: 720,
      height: 1560,
    });
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toMatch(/кадров/);
    expect(
      checkTutorialVideo(probeMp4(Buffer.from('not a video')), {
        durationMs: 1000,
        hasAudio: false,
        width: 720,
        height: 1560,
      }).ok,
    ).toBe(false);
  });
});
