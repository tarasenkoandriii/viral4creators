/**
 * Чистые правила захода 7 проверки качества демо: режим съёмки, таймкоды
 * шагов файла (исходник и версия темпа), контрольные кадры, разбор
 * вывода `blackdetect`/`freezedetect` и что из него — подозрение,
 * итоговый вердикт и блокировка публикации.
 */
import {
  buildTutorialManifest,
  ManifestFrame,
  TutorialTimelineManifest,
} from '../tutorial-runner/tutorial-manifest';
import { planTempo } from '../tutorial-runner/tutorial-tempo';
import {
  blocksPublication,
  controlFramesFor,
  deriveCaptureMode,
  effectiveVerdict,
  frameSignalsJob,
  MAX_CONTROL_FRAMES,
  parseFrameSignalsOutput,
  signalIssues,
  stepSpansMs,
  suspiciousSignals,
  verdictWithSignals,
} from './demo-quality-frames';

function frame(
  i: number,
  seconds: number,
  speech: number | null,
): ManifestFrame {
  return {
    frameId: `step-${i}`,
    stepIndex: i,
    image: {
      url: `https://blob/tutorial-video-sources/a1/frames/${i}.png`,
      pathname: `tutorial-video-sources/a1/frames/${i}.png`,
    },
    baseSeconds: seconds,
    speech:
      speech === null
        ? null
        : {
            url: `https://blob/v/${i}.mp3`,
            pathname: `v/${i}.mp3`,
            seconds: speech,
            text: `Реплика ${i}.`,
            provenance: {
              provider: 'resemble',
              voiceId: null,
              locale: 'ru',
              textSha: `s${i}`,
            },
          },
    caption: speech === null ? `Подпись ${i}` : null,
    readingSeconds: speech === null ? 2 : null,
    pointer: null,
  };
}

function manifest(
  frames: ManifestFrame[],
  over: Partial<TutorialTimelineManifest> = {},
): TutorialTimelineManifest {
  return {
    ...buildTutorialManifest({
      sourceAssetId: 'a1',
      owner: { kind: 'scenario', scenarioId: 's1', subjectKey: '2' },
      assetContentHash: 'h',
      locale: 'ru',
      theme: 'light',
      motion: 'none',
      captions: true,
      narration: 'per-frame',
      storage: 'sources',
      frames,
    }),
    ...over,
  };
}

describe('режим съёмки', () => {
  it('черновик клиента / витрина лендинга / TMA', () => {
    expect(
      deriveCaptureMode({ clientSiteDraftId: 'd1', subjectKey: 'client-site' }),
    ).toBe('client-site');
    // Черновик клиента сильнее ключа: ключ ему не принадлежит.
    expect(
      deriveCaptureMode({
        clientSiteDraftId: 'd1',
        subjectKey: 'site-tutorial-demo-1',
      }),
    ).toBe('client-site');
    expect(
      deriveCaptureMode({
        clientSiteDraftId: null,
        subjectKey: 'site-tutorial-demo-2',
      }),
    ).toBe('polygon');
    expect(
      deriveCaptureMode({ clientSiteDraftId: null, subjectKey: '8' }),
    ).toBe('tma');
    expect(
      deriveCaptureMode({
        clientSiteDraftId: null,
        subjectKey: 'greeting-brief',
      }),
    ).toBe('tma');
  });
});

describe('таймкоды шагов файла', () => {
  const m = manifest([frame(1, 5, null), frame(3, 6, 4), frame(4, 4, null)]);

  it('исходник — по baseSeconds', () => {
    expect(stepSpansMs(m, null)).toEqual([
      { stepIndex: 1, startMs: 0, endMs: 5000 },
      { stepIndex: 3, startMs: 5000, endMs: 11_000 },
      { stepIndex: 4, startMs: 11_000, endMs: 15_000 },
    ]);
    expect(stepSpansMs(m, 1)).toEqual(stepSpansMs(m, null));
  });

  it('версия темпа — по её плану, не по исходнику', () => {
    const fast = stepSpansMs(m, 0.4)!;
    const plan = planTempo(
      m.frames.map((f) => ({
        baseSeconds: f.baseSeconds,
        speech: f.speech ? { seconds: f.speech.seconds } : null,
        readingSeconds: f.caption ? f.readingSeconds : null,
      })),
      { factor: 0.4, motion: 'none' },
    )!;
    expect(fast.at(-1)!.endMs).toBe(plan.durationMs);
    expect(fast.at(-1)!.endMs).toBeLessThan(15_000);
    expect(fast.map((s) => s.stepIndex)).toEqual([1, 3, 4]);
  });

  it('без manifest — null, не угадываем', () => {
    expect(stepSpansMs(null, null)).toBeNull();
    expect(stepSpansMs(m, 7)).toBeNull();
  });
});

describe('контрольные кадры', () => {
  it('снимок шага, подпись или реплика, таймкоды файла', () => {
    const m = manifest([frame(1, 5, null), frame(2, 6, 4)]);
    expect(controlFramesFor(m, null)).toEqual([
      {
        stepIndex: 1,
        startMs: 0,
        endMs: 5000,
        imageUrl: 'https://blob/tutorial-video-sources/a1/frames/1.png',
        caption: 'Подпись 1',
      },
      {
        stepIndex: 2,
        startMs: 5000,
        endMs: 11_000,
        imageUrl: 'https://blob/tutorial-video-sources/a1/frames/2.png',
        caption: 'Реплика 2.',
      },
    ]);
  });

  it('только постоянные исходники: транзит и кадры черновика — null', () => {
    const frames = [frame(1, 5, null)];
    expect(
      controlFramesFor(manifest(frames, { storage: 'transit' }), null),
    ).toBeNull();
    expect(
      controlFramesFor(manifest(frames, { storage: 'draft-frames' }), null),
    ).toBeNull();
    expect(controlFramesFor(null, null)).toBeNull();
  });

  it('больше потолка — равномерно, с первым и последним', () => {
    const many = Array.from({ length: 25 }, (_, i) => frame(i, 2, null));
    const picked = controlFramesFor(manifest(many), null)!;
    expect(picked).toHaveLength(MAX_CONTROL_FRAMES);
    expect(picked[0].stepIndex).toBe(0);
    expect(picked.at(-1)!.stepIndex).toBe(24);
    const idx = picked.map((p) => p.stepIndex);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(new Set(idx).size).toBe(idx.length);
  });
});

describe('чёрные и замершие кадры', () => {
  it('команда: оба детектора, вывод в файл-выход через плейсхолдер, без кодирования', () => {
    const job = frameSignalsJob('https://blob/tutorial-videos/a1.mp4');
    expect(job.inputs).toEqual({
      video: 'https://blob/tutorial-videos/a1.mp4',
    });
    expect(job.outputs).toEqual(['signals.txt']);
    const [cmd] = job.commands;
    expect(cmd).toContain('-i {{video}}');
    expect(cmd).toContain('blackdetect=');
    expect(cmd).toContain('freezedetect=');
    expect(cmd).toContain('metadata=mode=print:file={{signals.txt}}');
    expect(cmd).toContain('-f null -');
  });

  it('разбор: пары начала/конца, незакрытый — до конца ролика, мусор игнорируется', () => {
    const text = [
      'frame:0    pts:0       pts_time:0',
      'lavfi.black_start=0',
      'frame:30   pts:30      pts_time:1',
      'lavfi.black_end=1.2',
      'lavfi.freezedetect.freeze_start=2',
      'lavfi.freezedetect.freeze_duration=3',
      'lavfi.freezedetect.freeze_end=5',
      'lavfi.freezedetect.freeze_start=8.5',
      'lavfi.black_start=abc',
      'что-то ещё',
    ].join('\n');
    expect(parseFrameSignalsOutput(text, 10_000)).toEqual({
      black: [{ startMs: 0, endMs: 1200 }],
      freeze: [
        { startMs: 2000, endMs: 5000 },
        { startMs: 8500, endMs: 10_000 },
      ],
    });
    expect(parseFrameSignalsOutput('', 10_000)).toEqual({
      black: [],
      freeze: [],
    });
  });

  const spans = [
    { stepIndex: 0, startMs: 0, endMs: 4000 },
    { stepIndex: 1, startMs: 4000, endMs: 8000 },
    { stepIndex: 2, startMs: 8000, endMs: 12_000 },
  ];

  it('неподвижный слайд внутри шага — не подозрение; замер через границу шага — да', () => {
    const inside = suspiciousSignals(
      { black: [], freeze: [{ startMs: 300, endMs: 3900 }] },
      spans,
    );
    expect(inside).toEqual([]);
    const crossed = suspiciousSignals(
      { black: [], freeze: [{ startMs: 1000, endMs: 7000 }] },
      spans,
    );
    expect(crossed).toHaveLength(1);
    expect(crossed[0]).toMatchObject({ kind: 'freeze', startMs: 1000 });
    expect(crossed[0].explanation).toContain('4.0 с');
    // Граница задета краем (меньше запаса с одной стороны) — переход
    // кадра мог просто совпасть с порогом детектора.
    expect(
      suspiciousSignals(
        { black: [], freeze: [{ startMs: 3700, endMs: 7000 }] },
        spans,
      ),
    ).toEqual([]);
    expect(
      suspiciousSignals(
        { black: [], freeze: [{ startMs: 1000, endMs: 4300 }] },
        spans,
      ),
    ).toEqual([]);
  });

  it('без плана шагов — только очень длинный замер; чёрное — всегда', () => {
    expect(
      suspiciousSignals(
        { black: [], freeze: [{ startMs: 0, endMs: 9000 }] },
        null,
      ),
    ).toEqual([]);
    expect(
      suspiciousSignals(
        { black: [], freeze: [{ startMs: 0, endMs: 13_000 }] },
        null,
      ),
    ).toHaveLength(1);
    const black = suspiciousSignals(
      { black: [{ startMs: 11_000, endMs: 12_000 }], freeze: [] },
      spans,
    );
    expect(black).toEqual([
      expect.objectContaining({
        kind: 'black',
        startMs: 11_000,
        endMs: 12_000,
      }),
    ]);
  });

  it('замечания — major (то есть warn), вердикт — только до warn', () => {
    const issues = signalIssues([
      { kind: 'black', startMs: 0, endMs: 900, explanation: 'чёрный кадр' },
    ]);
    expect(issues).toEqual([
      expect.objectContaining({
        category: 'artifact',
        severity: 'major',
        source: 'server',
        startMs: 0,
        endMs: 900,
      }),
    ]);
    expect(verdictWithSignals('ok', 1)).toBe('warn');
    expect(verdictWithSignals('ok', 0)).toBe('ok');
    expect(verdictWithSignals('warn', 3)).toBe('warn');
    expect(verdictWithSignals('fail', 1)).toBe('fail');
    expect(verdictWithSignals(null, 1)).toBeNull();
  });
});

describe('итоговый вердикт и блокировка публикации', () => {
  it('оператор сильнее модели', () => {
    expect(effectiveVerdict({ verdict: 'fail', overrideVerdict: 'ok' })).toBe(
      'ok',
    );
    expect(effectiveVerdict({ verdict: 'ok', overrideVerdict: null })).toBe(
      'ok',
    );
    expect(effectiveVerdict({ verdict: 'ok', overrideVerdict: 'fail' })).toBe(
      'fail',
    );
    expect(effectiveVerdict({ verdict: 'странное' })).toBeNull();
  });

  it('блок — только завершённая с итоговым fail', () => {
    expect(blocksPublication({ status: 'complete', verdict: 'fail' })).toBe(
      true,
    );
    expect(
      blocksPublication({
        status: 'complete',
        verdict: 'fail',
        overrideVerdict: 'warn',
      }),
    ).toBe(false);
    expect(
      blocksPublication({
        status: 'complete',
        verdict: 'ok',
        overrideVerdict: 'fail',
      }),
    ).toBe(true);
    expect(blocksPublication({ status: 'complete', verdict: 'warn' })).toBe(
      false,
    );
    expect(blocksPublication({ status: 'error', verdict: 'fail' })).toBe(false);
    expect(blocksPublication(null)).toBe(false);
  });
});
