import {
  buildTutorialManifest,
  ManifestFrame,
  manifestEditability,
  manifestSlides,
  parseTutorialManifest,
  tempoIdempotencyKey,
  tempoInputs,
  tempoPreview,
  TutorialTimelineManifest,
} from './tutorial-manifest';
import { planTempo } from './tutorial-tempo';
import { frameSpansSeconds } from './tutorial-video-assembly';

function frame(
  i: number,
  speech: number | null,
  url = `https://b/t/${i}.png`,
): ManifestFrame {
  return {
    frameId: `step-${i}`,
    stepIndex: i,
    image: { url, pathname: `t/${i}.png` },
    baseSeconds: speech === null ? 2 : speech + 0.6,
    speech:
      speech === null
        ? null
        : {
            url: `https://b/v/${i}.mp3`,
            pathname: `v/${i}.mp3`,
            seconds: speech,
            text: `R${i}`,
            provenance: {
              provider: 'resemble',
              voiceId: null,
              locale: 'ru',
              textSha: `s${i}`,
            },
          },
    caption: speech === null ? null : `R${i}`,
    readingSeconds: null,
    pointer: i === 1 ? { x: 0.25, y: 0.75 } : null,
  };
}

function make(
  frames: ManifestFrame[],
  over: Partial<TutorialTimelineManifest> = {},
) {
  return {
    ...buildTutorialManifest({
      sourceAssetId: 'a1',
      owner: { kind: 'scenario', scenarioId: 's1', subjectKey: '1' },
      assetContentHash: 'h',
      locale: 'ru',
      theme: 'light',
      motion: 'fade',
      captions: true,
      narration: 'per-frame',
      storage: 'sources',
      frames,
    }),
    ...over,
  };
}

describe('manifest', () => {
  const m = make([frame(0, 2.1), frame(1, null), frame(3, 1.2)]);

  it('переживает запись в JSON и разбор', () => {
    const back = parseTutorialManifest(JSON.parse(JSON.stringify(m)));
    expect(back).toEqual({ ...m, voiceSkipped: null });
    expect(back!.fps).toBe(30);
  });

  it('темп пары (заход 7): appliedTempo переживает разбор, мусор — отбрасывается, исходник и ключ не меняются', () => {
    const applied = {
      ...m,
      appliedTempo: { factor: 0.4, fromVersionId: 'v1' },
    };
    const back = parseTutorialManifest(JSON.parse(JSON.stringify(applied)));
    expect(back!.appliedTempo).toEqual({ factor: 0.4, fromVersionId: 'v1' });
    expect(back!.sourceHash).toBe(m.sourceHash);
    expect(tempoIdempotencyKey(back!, 0.4, 'fade')).toBe(
      tempoIdempotencyKey(m, 0.4, 'fade'),
    );
    for (const junk of [
      { factor: 'x', fromVersionId: 'v1' },
      { factor: 0.4 },
      'fast',
      null,
    ]) {
      const parsed = parseTutorialManifest({ ...m, appliedTempo: junk });
      expect(parsed).not.toBeNull();
      expect(parsed!.appliedTempo).toBeUndefined();
    }
  });

  it('чужой формат — null (non-editable), а не исключение', () => {
    expect(parseTutorialManifest(null)).toBeNull();
    expect(parseTutorialManifest({ ...m, manifestVersion: 2 })).toBeNull();
    expect(parseTutorialManifest({ ...m, motion: 'zoom' })).toBeNull();
    expect(parseTutorialManifest({ ...m, frames: [] })).toBeNull();
    expect(
      parseTutorialManifest({ ...m, frames: [frame(2, null), frame(1, null)] }),
    ).toBeNull();
    expect(
      parseTutorialManifest({
        ...m,
        frames: [{ ...frame(0, null), baseSeconds: 0 }],
      }),
    ).toBeNull();
  });

  it('отпечаток не зависит от ссылок: перенос исходников не плодит версии', () => {
    const moved = make([
      frame(0, 2.1, 'https://b/sources/0.png'),
      frame(1, null, 'https://b/sources/1.png'),
      frame(3, 1.2, 'https://b/sources/3.png'),
    ]);
    expect(moved.sourceHash).toBe(m.sourceHash);
    const edited = make([frame(0, 2.2), frame(1, null), frame(3, 1.2)]);
    expect(edited.sourceHash).not.toBe(m.sourceHash);
  });

  it('ключ идемпотентности: темп + переходы + подписи + исходник', () => {
    const k = tempoIdempotencyKey(m, 0.4, 'fade');
    expect(tempoIdempotencyKey(m, 0.4, 'fade')).toBe(k);
    expect(tempoIdempotencyKey(m, 0.45, 'fade')).not.toBe(k);
    expect(tempoIdempotencyKey(m, 0.4, 'none')).not.toBe(k);
    expect(
      tempoIdempotencyKey({ ...m, captions: false }, 0.4, 'fade'),
    ).not.toBe(k);
    expect(
      tempoIdempotencyKey({ ...m, sourceHash: 'x' }, 0.4, 'fade'),
    ).not.toBe(k);
  });

  it('недоступность — с причиной', () => {
    const done = { assemblyStatus: 'complete', blobUrl: 'u' };
    expect(manifestEditability(done, m)).toEqual({ editable: true });
    expect(manifestEditability(done, null)).toEqual({
      editable: false,
      reason: 'no-manifest',
    });
    expect(manifestEditability(done, { ...m, narration: 'whole' })).toEqual({
      editable: false,
      reason: 'whole-track',
    });
    expect(manifestEditability(done, { ...m, storage: 'transit' })).toEqual({
      editable: false,
      reason: 'sources-pending',
    });
    expect(
      manifestEditability({ assemblyStatus: 'pending', blobUrl: null }, m),
    ).toEqual({
      editable: false,
      reason: 'not-complete',
    });
  });

  it('кадры плана и предпросмотр — одна сетка, реплика с начала своего кадра', () => {
    const tempo = planTempo(tempoInputs(m), { factor: 0.4, motion: 'fade' })!;
    const slides = manifestSlides(m, tempo.seconds);
    expect(slides.map((s) => s.stepIndex)).toEqual([0, 1, 3]);
    expect(slides[0].audioUrl).toBe('https://b/v/0.mp3');
    expect(slides[1].audioUrl).toBeUndefined();
    expect(slides[1].pointer).toEqual({ x: 0.25, y: 0.75 });
    const preview = tempoPreview(m, tempo, 'fade');
    const spans = frameSpansSeconds(
      tempo.seconds.map((s) => ({ seconds: s })),
      'fade',
    );
    expect(preview.frames.map((f) => [f.start, f.end])).toEqual(
      spans.map((s) => [s.start, s.end]),
    );
    expect(preview.durationMs).toBe(tempo.durationMs);
    expect(preview.transitionSeconds).toBeCloseTo(0.3, 6);
    expect(preview.frames[2].caption).toBe('R3');
    expect(
      tempoPreview({ ...m, captions: false }, tempo, 'fade').frames[2].caption,
    ).toBeNull();
  });
});
