import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  copyFileSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ProbeError,
  probeFile,
  probeFromFfprobeJson,
} from '../../src/probe/probe';
import { checkInputLimits, displaySize } from '../../src/probe/limits';
import { verifyOutputs } from '../../src/probe/outputs';
import { PILOT_LIMITS } from '../fixtures/limits';
import { ff, FFPROBE, rotateVideo } from '../fixtures/media';

let dir: string;
const p = (n: string) => join(dir, n);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ffprobe-'));
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=320x240:r=25:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=d=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    p('ok.mp4'),
  ]);
  rotateVideo(p('ok.mp4'), p('rot.mp4'));
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=1440x1080:r=25:d=0.2',
    '-vf',
    'setsar=4/3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    p('sar-ok.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=1600x1080:r=25:d=0.2',
    '-vf',
    'setsar=4/3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    p('sar-wide.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=1080x1920:r=25:d=0.2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    p('vertical.mp4'),
  ]);
  // FF-SEC2-01: повёрнутые кадры (display matrix 90°).
  rotateVideo(p('vertical.mp4'), p('vertical-rot90.mp4'));
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=1920x1080:r=25:d=0.2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    p('landscape.mp4'),
  ]);
  rotateVideo(p('landscape.mp4'), p('landscape-rot90.mp4'));
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=2560x1440:r=25:d=0.2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    p('qhd.mp4'),
  ]);
  rotateVideo(p('qhd.mp4'), p('qhd-rot90.mp4'));
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=320x240:r=120:d=0.5',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    p('fps120.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=6000x5000:d=0.04',
    '-frames:v',
    '1',
    p('huge.png'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=720x1560:d=0.04',
    '-frames:v',
    '1',
    p('frame.png'),
  ]);
  copyFileSync(p('frame.png'), p('frame-noext'));
  ff(['-f', 'lavfi', '-i', 'sine=d=2', '-c:a', 'libmp3lame', p('voice.mp3')]);
  writeFileSync(
    p('subs.srt'),
    '1\n00:00:00,000 --> 00:00:01,000\nПривіт, ґанок!\n',
  );
  writeFileSync(
    p('playlist.srt'),
    '#EXTM3U\n#EXTINF:1,\nhttp://169.254.169.254/x.ts\n#EXT-X-ENDLIST\n',
  );
  writeFileSync(p('list.txt'), 'ffconcat version 1.0\nfile /etc/passwd\n');
  writeFileSync(p('garbage.mp4'), Buffer.alloc(2000, 9));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const probe = (n: string) => probeFile(p(n), { ffprobeBin: FFPROBE });

describe('probeFile', () => {
  it('JSON → ProbeResult, sha256, mime', async () => {
    const r = await probe('ok.mp4');
    expect(r.formatName).toBe('mov,mp4,m4a,3gp,3g2,mj2');
    expect(r.mime).toBe('video/mp4');
    expect(r.sha256).toBe(
      createHash('sha256')
        .update(readFileSync(p('ok.mp4')))
        .digest('hex'),
    );
    const v = r.streams.find((s) => s.type === 'video')!;
    expect(v).toMatchObject({
      codec: 'h264',
      width: 320,
      height: 240,
      fps: 25,
    });
    expect(r.streams.find((s) => s.type === 'audio')).toMatchObject({
      codec: 'aac',
    });
    expect(r.durationSec).toBeGreaterThan(0.9);
  });

  it('поворот и SAR', async () => {
    const rot = await probe('rot.mp4');
    const v = rot.streams.find((s) => s.type === 'video')!;
    expect(v.rotation === 90 || v.rotation === 270).toBe(true);
    expect(displaySize(v)).toEqual({ width: 240, height: 320 });
    const sar = (await probe('sar-ok.mp4')).streams[0];
    expect(displaySize(sar)).toEqual({ width: 1920, height: 1080 });
  });

  it('изображения без расширения и mp3', async () => {
    expect((await probe('frame-noext')).mime).toBe('image/png');
    expect((await probe('voice.mp3')).mime).toBe('audio/mpeg');
    expect((await probe('subs.srt')).formatName).toBe('srt');
  });

  it('плейлист под видом субтитров и concat-список не открываются', async () => {
    await expect(probe('playlist.srt')).rejects.toBeInstanceOf(ProbeError);
    await expect(probe('list.txt')).rejects.toBeInstanceOf(ProbeError);
    await expect(probe('garbage.mp4')).rejects.toBeInstanceOf(ProbeError);
    await expect(probe('missing.mp4')).rejects.toBeInstanceOf(ProbeError);
  });

  it('probeFromFfprobeJson: displaymatrix -90 → 270, SAR дробью', () => {
    const r = probeFromFfprobeJson(
      {
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.5' },
        streams: [
          {
            index: 0,
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
            avg_frame_rate: '30000/1001',
            sample_aspect_ratio: '1:1',
            side_data_list: [{ rotation: -90 }],
          },
        ],
      },
      { bytes: 10, sha256: 'x', mime: 'video/mp4' },
    );
    expect(r.streams[0]).toMatchObject({
      rotation: 270,
      fps: 29.97,
      width: 1920,
    });
  });
});

describe('checkInputLimits', () => {
  const check = async (n: string, limits = PILOT_LIMITS) =>
    checkInputLimits(await probe(n), limits);

  it.each([
    'ok.mp4',
    'rot.mp4',
    'sar-ok.mp4',
    'vertical.mp4',
    'vertical-rot90.mp4',
    'landscape.mp4',
    'landscape-rot90.mp4',
    'frame.png',
    'voice.mp3',
    'subs.srt',
  ])('%s — в лимитах', async (n) => {
    expect(await check(n)).toEqual({ ok: true });
  });

  it.each([
    ['sar-wide.mp4', 'с SAR шире 1920'],
    ['qhd.mp4', '2560x1440'],
    ['qhd-rot90.mp4', '2560x1440 с поворотом 90'],
    ['fps120.mp4', '120 fps'],
    ['huge.png', '30 MP'],
  ])('%s (%s) → INPUT_LIMIT_EXCEEDED', async (n) => {
    expect(await check(n)).toMatchObject({
      ok: false,
      code: 'INPUT_LIMIT_EXCEEDED',
    });
  });

  it('длительность', async () => {
    expect(
      await check('voice.mp3', { ...PILOT_LIMITS, maxInputDurationSec: 1 }),
    ).toMatchObject({
      ok: false,
      code: 'INPUT_LIMIT_EXCEEDED',
    });
  });

  it('decompression bomb: заявленные кадры и степень сжатия', () => {
    const base = {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSec: 600,
      bytes: 20_000,
      sha256: 'x',
      mime: 'video/mp4',
    };
    expect(
      checkInputLimits(
        {
          ...base,
          streams: [
            {
              index: 0,
              type: 'video',
              codec: 'h264',
              width: 1920,
              height: 1080,
              fps: 60,
              durationSec: 600,
            },
          ],
        },
        PILOT_LIMITS,
      ),
    ).toMatchObject({ ok: false, code: 'INPUT_LIMIT_EXCEEDED' });
    expect(
      checkInputLimits(
        {
          ...base,
          bytes: 50_000_000,
          streams: [
            {
              index: 0,
              type: 'video',
              codec: 'h264',
              width: 640,
              height: 360,
              fps: 30,
              durationSec: 60,
              nbFrames: 99_999_999,
            } as never,
          ],
        },
        PILOT_LIMITS,
      ),
    ).toMatchObject({ ok: false, code: 'INPUT_LIMIT_EXCEEDED' });
  });

  it('неизвестный формат и неизвестная длительность → INPUT_INVALID_MEDIA', () => {
    const r = {
      formatName: 'hls',
      durationSec: 1,
      bytes: 10,
      sha256: 'x',
      mime: 'x',
      streams: [],
    };
    expect(checkInputLimits(r, PILOT_LIMITS)).toMatchObject({
      code: 'INPUT_INVALID_MEDIA',
    });
    expect(
      checkInputLimits(
        {
          ...r,
          formatName: 'mp3',
          durationSec: null,
          streams: [{ index: 0, type: 'audio', codec: 'mp3' }],
        },
        PILOT_LIMITS,
      ),
    ).toMatchObject({ code: 'INPUT_INVALID_MEDIA' });
  });
});

describe('verifyOutputs', () => {
  const attempt = () => {
    const a = mkdtempSync(join(dir, 'att-'));
    mkdirSync(join(a, 'outputs'));
    return a;
  };

  it('проверяет существование, ffprobe и считает sha256', async () => {
    const a = attempt();
    copyFileSync(p('ok.mp4'), join(a, 'outputs', 'final.mp4'));
    writeFileSync(join(a, 'outputs', 'signals.txt'), 'lavfi.black_start=0\n');
    const r = await verifyOutputs(
      a,
      [
        { name: 'final.mp4', localName: 'outputs/final.mp4' },
        { name: 'signals.txt', localName: 'outputs/signals.txt' },
      ],
      PILOT_LIMITS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0]).toMatchObject({ name: 'final.mp4', mime: 'video/mp4' });
    expect(r.files[0].probe?.streams.length).toBe(2);
    expect(r.files[1]).toMatchObject({
      mime: 'text/plain; charset=utf-8',
      probe: null,
    });
  });

  it('отсутствующий, пустой, битый, symlink, hardlink, слишком большой', async () => {
    const out = [{ name: 'final.mp4', localName: 'outputs/final.mp4' }];
    let a = attempt();
    expect(await verifyOutputs(a, out, PILOT_LIMITS)).toMatchObject({
      ok: false,
      code: 'OUTPUT_MISSING',
    });

    a = attempt();
    writeFileSync(join(a, 'outputs', 'final.mp4'), '');
    expect(await verifyOutputs(a, out, PILOT_LIMITS)).toMatchObject({
      code: 'OUTPUT_INVALID_MEDIA',
    });

    a = attempt();
    copyFileSync(p('garbage.mp4'), join(a, 'outputs', 'final.mp4'));
    expect(await verifyOutputs(a, out, PILOT_LIMITS)).toMatchObject({
      code: 'OUTPUT_INVALID_MEDIA',
    });

    a = attempt();
    symlinkSync(p('ok.mp4'), join(a, 'outputs', 'final.mp4'));
    expect(await verifyOutputs(a, out, PILOT_LIMITS)).toMatchObject({
      code: 'OUTPUT_INVALID_MEDIA',
    });

    a = attempt();
    linkSync(p('ok.mp4'), join(a, 'outputs', 'final.mp4'));
    expect(await verifyOutputs(a, out, PILOT_LIMITS)).toMatchObject({
      code: 'OUTPUT_INVALID_MEDIA',
    });

    a = attempt();
    copyFileSync(p('ok.mp4'), join(a, 'outputs', 'final.mp4'));
    expect(
      await verifyOutputs(a, out, {
        ...PILOT_LIMITS,
        maxTotalOutputBytes: 100,
      }),
    ).toMatchObject({ code: 'OUTPUT_TOO_LARGE' });
  });

  it.each([
    'dimensions',
    'fps',
    'sar',
    'duration',
    'probe-bytes',
    'probe-hash',
    'mime',
  ])('rejects actual output beyond the contract: %s', async (kind) => {
    const a = attempt();
    const file = join(a, 'outputs', 'final.mp4');
    copyFileSync(p('ok.mp4'), file);
    const pr = await probeFile(file);
    if (kind === 'dimensions') pr.streams[0].width = 4000;
    if (kind === 'fps') pr.streams[0].fps = 120;
    if (kind === 'sar') Object.assign(pr.streams[0], { sar: 20 });
    if (kind === 'duration') pr.durationSec = Infinity;
    if (kind === 'probe-bytes') pr.bytes++;
    if (kind === 'probe-hash') pr.sha256 = 'not-a-hash';
    if (kind === 'mime') pr.mime = 'audio/mp4';
    expect(
      await verifyOutputs(
        a,
        [{ name: 'final.mp4', localName: 'outputs/final.mp4' }],
        PILOT_LIMITS,
        { probe: async () => [pr] },
      ),
    ).toMatchObject({ code: 'OUTPUT_INVALID_MEDIA' });
  });

  it('m4a без аудио и mp4 без видео — невалидны', async () => {
    const a = attempt();
    ff(['-i', p('voice.mp3'), '-c:a', 'aac', join(a, 'outputs', 'final.mp4')]);
    expect(
      await verifyOutputs(
        a,
        [{ name: 'final.mp4', localName: 'outputs/final.mp4' }],
        PILOT_LIMITS,
      ),
    ).toMatchObject({ code: 'OUTPUT_INVALID_MEDIA' });
  });
});

describe('embedded MP3 artwork', () => {
  const artwork = (attached: number, width = 300) =>
    probeFromFfprobeJson(
      {
        format: { format_name: 'mp3', duration: '2' },
        streams: [
          {
            codec_type: 'audio',
            codec_name: 'mp3',
            sample_rate: '44100',
            channels: 2,
          },
          {
            codec_type: 'video',
            codec_name: 'mjpeg',
            width,
            height: 300,
            r_frame_rate: '90000/1',
            disposition: { attached_pic: attached },
          },
        ],
      },
      { bytes: 10000, sha256: 'a'.repeat(64), mime: 'audio/mpeg' },
    );

  it('accepts a bounded attached image without treating its time base as video fps', () => {
    expect(checkInputLimits(artwork(1), PILOT_LIMITS)).toEqual({ ok: true });
  });
  it('continues rejecting excessive fps on timed video', () => {
    expect(checkInputLimits(artwork(0), PILOT_LIMITS).ok).toBe(false);
  });
  it('continues checking dimensions of attached artwork', () => {
    expect(checkInputLimits(artwork(1, 30000), PILOT_LIMITS).ok).toBe(false);
  });
});
