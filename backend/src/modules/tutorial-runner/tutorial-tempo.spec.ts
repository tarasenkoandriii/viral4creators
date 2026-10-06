import {
  normalizeTempoFactor,
  planTempo,
  presetOfFactor,
  SPEECH_GUARD_SECONDS,
  TEMPO_PRESETS,
  TempoFrameInput,
} from './tutorial-tempo';
import {
  frameSpansSeconds,
  MIN_FRAME_SECONDS,
  narrationFrameSeconds,
  planSlideshow,
  SlideshowMotion,
  transitionFrames,
} from './tutorial-video-assembly';
import { captionReadingSeconds } from './tutorial-captions';

const FPS = 30;
const SAMPLES_PER_FRAME = 1470;

/** Детерминированный ГПСЧ — раскладки воспроизводимы по номеру. */
function rng(seed: number): () => number {
  // Перемешиваем номер: у ЛКГ с маленьким зерном первые значения почти
  // одинаковы, и все раскладки вышли бы одной длины.
  let s = Math.imul(seed, 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Раскладка так, как её строит сборка: озвученные кадры — речь + хвост,
 *  немые с подписью — время чтения, немые без подписи — минимум. */
function randomLayout(seed: number, maxFrames = 30): TempoFrameInput[] {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * maxFrames);
  return Array.from({ length: n }, () => {
    const kind = r();
    if (kind < 0.55) {
      const speech = Math.round((0.3 + r() * 14) * 1000) / 1000;
      return {
        baseSeconds: narrationFrameSeconds(speech),
        speech: { seconds: speech },
        readingSeconds: null,
      };
    }
    if (kind < 0.8) {
      const text = 'x'.repeat(1 + Math.floor(r() * 220));
      const reading = captionReadingSeconds(text)!;
      return {
        baseSeconds: Math.max(MIN_FRAME_SECONDS, reading),
        speech: null,
        readingSeconds: reading,
      };
    }
    return { baseSeconds: 2, speech: null, readingSeconds: null };
  });
}

const MOTIONS: SlideshowMotion[] = ['none', 'fade', 'fade+zoom'];
const FACTORS = [0, 0.4, 0.75, 1, 1.5, 2];

describe('planTempo — речь не режется на случайных раскладках', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const frames = randomLayout(seed);
    const motion = MOTIONS[seed % MOTIONS.length];
    it(`раскладка #${seed}: ${frames.length} кадр(ов), ${motion}`, () => {
      for (const factor of FACTORS) {
        const plan = planTempo(frames, { factor, motion })!;
        expect(plan).not.toBeNull();
        expect(plan.seconds).toHaveLength(frames.length);
        const overlap = transitionFrames(
          plan.seconds.map((s) => ({ seconds: s })),
          motion,
        );
        // Нарушения собираются списком и сверяются с пустым — так в
        // выводе видно, КАКОЙ кадр и почему, а не одна строка ожидания.
        const violations: string[] = [];
        plan.seconds.forEach((s, i) => {
          const len = Math.round(s * FPS);
          if (Math.abs(s * FPS - len) >= 1e-9)
            violations.push(`${i}: не на сетке`);
          if (s < MIN_FRAME_SECONDS - 1e-9)
            violations.push(`${i}: короче минимума`);
          const f = frames[i];
          const isLast = i === frames.length - 1;
          // Ровно условие задачи: round(s·30) − overlap ≥ ceil((речь + запас)·30).
          if (
            f.speech?.seconds != null &&
            len - (isLast ? 0 : overlap) <
              Math.ceil((f.speech.seconds + SPEECH_GUARD_SECONDS) * FPS)
          ) {
            violations.push(`${i}: речь режется (×${factor})`);
          }
          if (
            f.speech === null &&
            f.readingSeconds !== null &&
            s + 1e-9 < f.readingSeconds
          ) {
            violations.push(`${i}: подпись не успеть прочитать`);
          }
        });
        expect(violations).toEqual([]);
        // Длительность — из той же сетки, что у сборки.
        const spans = frameSpansSeconds(
          plan.seconds.map((s) => ({ seconds: s })),
          motion,
        );
        expect(plan.durationMs).toBe(
          Math.round((spans.at(-1)?.end ?? 0) * 1000),
        );
      }
    });
  }

  it('звук каждого озвученного кадра в команде не короче речи (сэмплы)', () => {
    for (let seed = 200; seed < 260; seed++) {
      const frames = randomLayout(seed);
      const motion: SlideshowMotion = seed % 2 ? 'fade' : 'none';
      const plan = planTempo(frames, { factor: 0, motion })!;
      const slides = plan.seconds.map((seconds, i) => ({
        stepIndex: i,
        url: `https://b/${i}.png`,
        seconds,
        audioUrl: frames[i].speech ? `https://b/${i}.mp3` : null,
      }));
      const built = planSlideshow(slides, { motion })!;
      expect(built).not.toBeNull();
      expect(built.durationMs).toBe(plan.durationMs);
      const cmd = built.commands[0];
      frames.forEach((f, i) => {
        if (!f.speech?.seconds) return;
        const m = new RegExp(
          `atrim=(?:end_sample=(\\d+)|0:([\\d.]+)),asetpts=N/SR/TB\\[a${i}\\]`,
        ).exec(cmd);
        expect(m).not.toBeNull();
        const samples = m![1]
          ? Number(m![1])
          : Math.round(Number(m![2]) * 44_100);
        expect(samples).toBeGreaterThanOrEqual(
          Math.ceil(f.speech.seconds * 44_100),
        );
        expect(samples % SAMPLES_PER_FRAME).toBe(0);
      });
    }
  });
});

describe('planTempo — пресеты и возврат к обычному', () => {
  const frames: TempoFrameInput[] = [
    {
      baseSeconds: narrationFrameSeconds(3.2),
      speech: { seconds: 3.2 },
      readingSeconds: null,
    },
    { baseSeconds: 2, speech: null, readingSeconds: null },
    {
      baseSeconds: narrationFrameSeconds(1.1),
      speech: { seconds: 1.1 },
      readingSeconds: null,
    },
    {
      baseSeconds: 4,
      speech: null,
      readingSeconds: captionReadingSeconds('a'.repeat(30)),
    },
  ];

  it('пресеты — ровно решение владельца', () => {
    expect(TEMPO_PRESETS).toEqual({ calm: 1.5, normal: 1, fast: 0.4 });
    expect(presetOfFactor(0.4)).toBe('fast');
    expect(presetOfFactor(0.45)).toBeNull();
  });

  it('«обычный» восстанавливает исходную сетку кадр в кадр', () => {
    for (const motion of MOTIONS) {
      const plan = planTempo(frames, { factor: 1, motion })!;
      expect(plan.seconds.map((s) => Math.round(s * FPS))).toEqual(
        frames.map((f) => Math.round(f.baseSeconds * FPS)),
      );
      expect(plan.warnings).toEqual([]);
    }
  });

  it('«быстрее» сжимает паузу до 0.4, речь не трогает', () => {
    const plan = planTempo(frames, {
      factor: TEMPO_PRESETS.fast,
      motion: 'none',
    })!;
    // Кадр 0: пол = ceil((3.2+0.2)·30) = 102, исходный 114 → 102 + round(0.4·12) = 107.
    expect(Math.round(plan.seconds[0] * FPS)).toBe(107);
    // Немой без подписи: пол 45, исходный 60 → 45 + 6.
    expect(Math.round(plan.seconds[1] * FPS)).toBe(51);
    expect(plan.durationMs).toBeLessThan(
      planTempo(frames, { factor: 1, motion: 'none' })!.durationMs,
    );
  });

  it('«спокойнее» удлиняет только паузы (×1.5)', () => {
    const plan = planTempo(frames, {
      factor: TEMPO_PRESETS.calm,
      motion: 'none',
    })!;
    expect(Math.round(plan.seconds[0] * FPS)).toBe(102 + 18);
    expect(Math.round(plan.seconds[1] * FPS)).toBe(45 + 23);
  });

  it('длительность монотонна по множителю', () => {
    for (let seed = 1; seed < 40; seed++) {
      const layout = randomLayout(seed);
      let prev = -1;
      for (const factor of [0, 0.2, 0.4, 0.6, 1, 1.3, 1.5, 2]) {
        const d = planTempo(layout, { factor, motion: 'fade' })!.durationMs;
        expect(d).toBeGreaterThanOrEqual(prev);
        prev = d;
      }
    }
  });

  it('минимум достигнут — предупреждение и minimumDurationMs', () => {
    const plan = planTempo(frames, { factor: 0, motion: 'fade' })!;
    expect(plan.durationMs).toBe(plan.minimumDurationMs);
    expect(plan.warnings).toContainEqual({
      code: 'pauses-at-minimum',
      frames: 4,
    });
  });

  it('с переходами пол озвученного кадра включает переход (кроме последнего)', () => {
    const two: TempoFrameInput[] = [
      { baseSeconds: 5, speech: { seconds: 2 }, readingSeconds: null },
      { baseSeconds: 5, speech: { seconds: 2 }, readingSeconds: null },
    ];
    const plan = planTempo(two, { factor: 0, motion: 'fade' })!;
    expect(Math.round(plan.seconds[0] * FPS)).toBe(66 + 9);
    expect(Math.round(plan.seconds[1] * FPS)).toBe(66);
  });
});

describe('planTempo — немые кадры и дефекты исходника', () => {
  it('минимум немого кадра — max(время чтения, 1.5 с)', () => {
    const reading = captionReadingSeconds('b'.repeat(90))!; // 6 + 0.6
    const plan = planTempo(
      [
        { baseSeconds: 9, speech: null, readingSeconds: reading },
        { baseSeconds: 9, speech: null, readingSeconds: null },
      ],
      { factor: 0, motion: 'fade' },
    )!;
    expect(plan.seconds[0]).toBeCloseTo(Math.ceil(reading * FPS) / FPS, 9);
    expect(plan.seconds[1]).toBe(MIN_FRAME_SECONDS);
  });

  it('исходный кадр короче речи — поднят до пола при любом темпе и назван', () => {
    const plan = planTempo(
      [{ baseSeconds: 1.5, speech: { seconds: 4 }, readingSeconds: null }],
      { factor: 1, motion: 'none' },
    )!;
    expect(Math.round(plan.seconds[0] * FPS)).toBe(Math.ceil(4.2 * FPS));
    expect(plan.warnings).toContainEqual({
      code: 'source-frame-too-short',
      frameIndexes: [0],
    });
  });

  it('дорожка без длины — кадр не сжимается', () => {
    const plan = planTempo(
      [
        { baseSeconds: 3, speech: { seconds: null }, readingSeconds: null },
        { baseSeconds: 3, speech: null, readingSeconds: null },
      ],
      { factor: 0, motion: 'none' },
    )!;
    expect(plan.seconds[0]).toBe(3);
    expect(plan.seconds[1]).toBe(MIN_FRAME_SECONDS);
    expect(plan.warnings).toContainEqual({
      code: 'speech-unmeasured',
      frameIndexes: [0],
    });
  });

  it('длинный ролик с зумом — предупреждение о снятом зуме', () => {
    const long = Array.from({ length: 30 }, () => ({
      baseSeconds: 8,
      speech: { seconds: 7 },
      readingSeconds: null,
    }));
    const plan = planTempo(long, { factor: 1, motion: 'fade+zoom' })!;
    expect(plan.motion).toBe('fade');
    expect(plan.warnings).toContainEqual({ code: 'zoom-dropped' });
  });

  it('негодный вход и множитель — null', () => {
    expect(planTempo([], { factor: 1, motion: 'none' })).toBeNull();
    expect(
      planTempo([{ baseSeconds: 0, speech: null, readingSeconds: null }], {
        factor: 1,
        motion: 'none',
      }),
    ).toBeNull();
    expect(
      planTempo(
        Array.from({ length: 41 }, () => ({
          baseSeconds: 2,
          speech: null,
          readingSeconds: null,
        })),
        { factor: 1, motion: 'none' },
      ),
    ).toBeNull();
    expect(
      planTempo([{ baseSeconds: 2, speech: null, readingSeconds: null }], {
        factor: 2.5,
        motion: 'none',
      }),
    ).toBeNull();
  });
});

describe('normalizeTempoFactor', () => {
  it('к шагу 0.05, вне диапазона — null', () => {
    expect(normalizeTempoFactor(0.4000001)).toBe(0.4);
    expect(normalizeTempoFactor(0.43)).toBe(0.45);
    expect(normalizeTempoFactor(2)).toBe(2);
    expect(normalizeTempoFactor(-0.1)).toBeNull();
    expect(normalizeTempoFactor(2.01)).toBeNull();
    expect(normalizeTempoFactor('1')).toBeNull();
    expect(normalizeTempoFactor(NaN)).toBeNull();
  });
});
