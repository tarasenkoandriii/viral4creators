import { checkTutorialVideo, probeMp4 } from './mp4-probe';

/** Минимальный MP4-контейнер: только те коробки, что читает разбор. */
function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function u32(...n: number[]): Buffer {
  const b = Buffer.alloc(4 * n.length);
  n.forEach((v, i) => b.writeUInt32BE(v, i * 4));
  return b;
}

function mvhd(timescale: number, duration: number): Buffer {
  return box('mvhd', u32(0, 0, 0, timescale, duration), Buffer.alloc(80));
}

function trak(
  handler: 'vide' | 'soun',
  timescale: number,
  duration: number,
  samples: number,
  size: [number, number] = [0, 0],
): Buffer {
  const tkhd = box(
    'tkhd',
    u32(0, 0, 0, 1, 0, duration),
    Buffer.alloc(8 + 8 + 36),
    u32(size[0] << 16, size[1] << 16),
  );
  const mdhd = box('mdhd', u32(0, 0, 0, timescale, duration), Buffer.alloc(4));
  const hdlr = box(
    'hdlr',
    u32(0, 0),
    Buffer.from(handler, 'latin1'),
    Buffer.alloc(12),
  );
  const stsz = box('stsz', u32(0, 0, samples));
  const minf = box('minf', box('stbl', stsz));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
}

function mp4(opts: {
  frames: number;
  audioSeconds: number | null;
  size?: [number, number];
}): Buffer {
  const videoDur = opts.frames * 512; // timescale 15360 = 30 к/с × 512
  return Buffer.concat([
    box('ftyp', Buffer.from('isom', 'latin1'), u32(512)),
    box(
      'moov',
      mvhd(1000, Math.round((opts.frames / 30) * 1000)),
      trak('vide', 15360, videoDur, opts.frames, opts.size ?? [720, 1560]),
      ...(opts.audioSeconds === null
        ? []
        : [trak('soun', 44100, Math.round(opts.audioSeconds * 44100), 100)]),
    ),
    box('mdat', Buffer.alloc(16)),
  ]);
}

describe('probeMp4', () => {
  it('читает кадры, размер и длину звука из moov', () => {
    const p = probeMp4(mp4({ frames: 300, audioSeconds: 10.02 }))!;
    const v = p.tracks.find((t) => t.kind === 'video')!;
    const a = p.tracks.find((t) => t.kind === 'audio')!;
    expect(v).toMatchObject({ samples: 300, width: 720, height: 1560 });
    expect(v.durationSeconds).toBeCloseTo(10, 6);
    expect(a.durationSeconds).toBeCloseTo(10.02, 4);
    expect(p.durationSeconds).toBeCloseTo(10, 3);
  });

  it('не MP4 / обрезанный файл — null, а не исключение', () => {
    expect(probeMp4(Buffer.from('hello world'))).toBeNull();
    expect(
      probeMp4(mp4({ frames: 30, audioSeconds: 1 }).subarray(0, 60)),
    ).toBeNull();
  });
});

describe('checkTutorialVideo', () => {
  const expected = {
    durationMs: 10_000,
    hasAudio: true,
    width: 720,
    height: 1560,
  };

  it('сходится с планом — ok', () => {
    expect(
      checkTutorialVideo(
        probeMp4(mp4({ frames: 300, audioSeconds: 10.02 })),
        expected,
      ),
    ).toMatchObject({ ok: true, videoFrames: 300, expectedFrames: 300 });
  });

  it('кадров не столько, сколько в плане — провал', () => {
    const c = checkTutorialVideo(
      probeMp4(mp4({ frames: 290, audioSeconds: 9.7 })),
      expected,
    );
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toMatch(/кадров 290 вместо 300/);
  });

  it('звук заметно короче картинки — провал (хвост речи мог срезаться)', () => {
    const c = checkTutorialVideo(
      probeMp4(mp4({ frames: 300, audioSeconds: 9.5 })),
      expected,
    );
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toMatch(/звук короче/);
  });

  it('звука нет, а заказан — провал; немой ролик без звука — ok', () => {
    expect(
      checkTutorialVideo(
        probeMp4(mp4({ frames: 300, audioSeconds: null })),
        expected,
      ).ok,
    ).toBe(false);
    expect(
      checkTutorialVideo(probeMp4(mp4({ frames: 300, audioSeconds: null })), {
        ...expected,
        hasAudio: false,
      }).ok,
    ).toBe(true);
  });

  it('чужой размер кадра — провал', () => {
    const c = checkTutorialVideo(
      probeMp4(mp4({ frames: 300, audioSeconds: 10, size: [640, 360] })),
      expected,
    );
    expect(c.problems.join(' ')).toMatch(/640×360/);
  });
});
