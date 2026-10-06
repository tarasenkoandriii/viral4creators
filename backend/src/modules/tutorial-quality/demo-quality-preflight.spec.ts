import { Mp4Probe } from '../tutorial-runner/mp4-probe';
import {
  DEMO_MAX_DURATION_MS,
  demoPreflight,
  PreflightExpectations,
  preflightIssues,
} from './demo-quality-preflight';

/** Ролик 10 с, 30 к/с, 720×1560, со звуком той же длины. */
function probe(
  over: {
    video?: Partial<Mp4Probe['tracks'][0]> | null;
    audio?: Partial<Mp4Probe['tracks'][0]> | null;
    durationSeconds?: number;
  } = {},
): Mp4Probe {
  const tracks: Mp4Probe['tracks'] = [];
  if (over.video !== null) {
    tracks.push({
      kind: 'video',
      timescale: 15360,
      duration: 153600,
      durationSeconds: 10,
      samples: 300,
      width: 720,
      height: 1560,
      ...(over.video ?? {}),
    });
  }
  if (over.audio !== null) {
    tracks.push({
      kind: 'audio',
      timescale: 44100,
      duration: 441000,
      durationSeconds: 10,
      samples: 431,
      width: null,
      height: null,
      ...(over.audio ?? {}),
    });
  }
  return { durationSeconds: over.durationSeconds ?? 10, tracks };
}

const expect0 = (
  over: Partial<PreflightExpectations> = {},
): PreflightExpectations => ({
  durationMs: 10_000,
  width: 720,
  height: 1560,
  hasAudio: true,
  declaredTheme: 'dark',
  capturedTheme: 'dark',
  ...over,
});

describe('техническая проверка демо', () => {
  it('исправный ролик проходит; факты из контейнера', () => {
    const r = demoPreflight(probe(), expect0());
    expect(r).toMatchObject({
      ok: true,
      problems: [],
      durationMs: 10_000,
      videoFrames: 300,
      expectedFrames: 300,
      width: 720,
      height: 1560,
      audioSeconds: 10,
    });
    expect(preflightIssues(r)).toEqual([]);
  });

  it('не MP4 — провал', () => {
    const r = demoPreflight(null, expect0());
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['файл не разбирается как MP4']);
  });

  it('нет видеодорожки, нет кадров, нулевая длительность', () => {
    expect(demoPreflight(probe({ video: null }), expect0()).problems).toContain(
      'нет видеодорожки',
    );
    expect(
      demoPreflight(
        probe({ video: { samples: 0 } }),
        expect0({ durationMs: null }),
      ).problems,
    ).toContain('в видеодорожке нет кадров');
    const zero = demoPreflight(
      probe({ durationSeconds: 0, video: { durationSeconds: 0 }, audio: null }),
      expect0({ durationMs: null, hasAudio: null }),
    );
    expect(zero.problems).toEqual(['нулевая длительность']);
  });

  it('длительность выше лимита — провал; ровно лимит — нет', () => {
    const sec = DEMO_MAX_DURATION_MS / 1000;
    const over = demoPreflight(
      probe({
        durationSeconds: sec + 1,
        video: { durationSeconds: sec + 1 },
        audio: null,
      }),
      expect0({ durationMs: null, hasAudio: null }),
    );
    expect(over.ok).toBe(false);
    expect(over.problems[0]).toMatch(/больше лимита/);
    const at = demoPreflight(
      probe({
        durationSeconds: sec,
        video: { durationSeconds: sec },
        audio: null,
      }),
      expect0({ durationMs: null, hasAudio: null }),
    );
    expect(at.ok).toBe(true);
    const custom = demoPreflight(probe(), expect0({ maxDurationMs: 9_000 }));
    expect(custom.ok).toBe(false);
  });

  it('холст не тот — провал; неизвестный холст не сверяется', () => {
    const r = demoPreflight(probe({ video: { width: 1080 } }), expect0());
    expect(r.problems).toEqual(['кадр 1080×1560 вместо 720×1560']);
    expect(
      demoPreflight(probe({ video: { width: 1080 } }), expect0({ width: null }))
        .ok,
    ).toBe(true);
  });

  it('кадров ± 1 — допуск; ± 2 — провал', () => {
    expect(
      demoPreflight(probe({ video: { samples: 301 } }), expect0()).ok,
    ).toBe(true);
    expect(
      demoPreflight(probe({ video: { samples: 299 } }), expect0()).ok,
    ).toBe(true);
    expect(
      demoPreflight(probe({ video: { samples: 302 } }), expect0()).problems,
    ).toEqual(['кадров 302 вместо 300']);
    expect(
      demoPreflight(probe({ video: { samples: 298 } }), expect0()).ok,
    ).toBe(false);
  });

  it('звук заказан и его нет / он короче картинки — провал; немое демо — нет', () => {
    expect(demoPreflight(probe({ audio: null }), expect0()).problems).toEqual([
      'нет звуковой дорожки, хотя озвучка заказана',
    ]);
    const short = demoPreflight(
      probe({ audio: { durationSeconds: 9.9 } }),
      expect0(),
    );
    expect(short.problems[0]).toMatch(/звук короче картинки на 100 мс/);
    expect(
      demoPreflight(probe({ audio: { durationSeconds: 9.95 } }), expect0()).ok,
    ).toBe(true);
    expect(
      demoPreflight(probe({ audio: null }), expect0({ hasAudio: false })).ok,
    ).toBe(true);
    expect(
      demoPreflight(probe({ audio: null }), expect0({ hasAudio: null })).ok,
    ).toBe(true);
  });

  it('тема съёмки не совпадает с заявленной — провал; неизвестная — не провал', () => {
    const r = demoPreflight(probe(), expect0({ capturedTheme: 'light' }));
    expect(r.problems).toEqual([
      'тема съёмки light не совпадает с заявленной dark',
    ]);
    expect(demoPreflight(probe(), expect0({ capturedTheme: null })).ok).toBe(
      true,
    );
    expect(
      demoPreflight(
        probe(),
        expect0({ declaredTheme: null, capturedTheme: 'light' }),
      ).ok,
    ).toBe(true);
  });

  it('замечания техпроверки — критические, на весь ролик', () => {
    const r = demoPreflight(probe({ video: { width: 1 } }), expect0());
    expect(preflightIssues(r)).toEqual([
      {
        category: 'technical',
        severity: 'critical',
        startMs: 0,
        endMs: 10_000,
        explanation: 'кадр 1×1560 вместо 720×1560',
        confidence: 1,
        source: 'preflight',
      },
    ]);
  });
});
