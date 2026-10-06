/**
 * Экран темпа обучалки (06.10.2026): пресеты и шаг ползунка — те же, что
 * у сервера (`backend/.../tutorial-runner/tutorial-tempo.ts`), а разбор
 * времени предпросмотра — та же сетка, что у сборки: следующий кадр
 * «начинается» там, где начинается переход к нему, и реплика звучит с
 * начала своего кадра.
 */
import assert from 'node:assert/strict';
import {
  captionAt,
  durationChangePercent,
  formatDuration,
  presetOf,
  previewAt,
  snapFactor,
  speechSchedule,
  TEMPO_PRESETS,
  type TempoPreview,
} from '../src/lib/tutorial-tempo';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

console.log('tutorial-tempo');

it('пресеты — решение владельца: ×1.5 / ×1 / ×0.4 паузы', () => {
  assert.deepEqual(TEMPO_PRESETS, { calm: 1.5, normal: 1, fast: 0.4 });
  assert.equal(presetOf(0.4), 'fast');
  assert.equal(presetOf(1), 'normal');
  assert.equal(presetOf(0.45), null);
});

it('ползунок — шаг 0.05 и диапазон 0…2, как у сервера', () => {
  assert.equal(snapFactor(0.43), 0.45);
  assert.equal(snapFactor(0.4000001), 0.4);
  assert.equal(snapFactor(-1), 0);
  assert.equal(snapFactor(7), 2);
  assert.equal(snapFactor(Number.NaN), 1);
});

it('длительность — м:сс', () => {
  assert.equal(formatDuration(65_400), '1:05');
  assert.equal(formatDuration(42_000), '0:42');
  assert.equal(formatDuration(null), '—');
  assert.equal(durationChangePercent(6_500, 10_000), -35);
  assert.equal(durationChangePercent(null, 10_000), null);
});

const preview: TempoPreview = {
  durationMs: 7_000,
  transitionSeconds: 0.3,
  motion: 'fade',
  frames: [
    {
      frameId: 'step-0',
      stepIndex: 0,
      imageUrl: 'a.png',
      start: 0,
      end: 2.5,
      speech: { url: 'a.mp3', seconds: 2.1 },
      caption: 'Первый',
      pointer: null,
    },
    {
      frameId: 'step-1',
      stepIndex: 1,
      imageUrl: 'b.png',
      start: 2.5,
      end: 4,
      speech: null,
      caption: null,
      pointer: null,
    },
    {
      frameId: 'step-3',
      stepIndex: 3,
      imageUrl: 'c.png',
      start: 4,
      end: 7,
      speech: { url: 'c.mp3', seconds: 2.4 },
      caption: 'Третий',
      pointer: null,
    },
  ],
};

it('реплики — в начале своего кадра, немые пропущены', () => {
  assert.deepEqual(speechSchedule(preview), [
    { url: 'a.mp3', at: 0, frameId: 'step-0' },
    { url: 'c.mp3', at: 4, frameId: 'step-3' },
  ]);
});

it('переход — первые 0.3 с нового кадра; подпись меняется сразу', () => {
  assert.deepEqual(previewAt(preview, 1), { index: 0, next: null, mix: 0 });
  const mid = previewAt(preview, 2.65);
  assert.equal(mid.index, 0);
  assert.equal(mid.next, 1);
  assert.ok(Math.abs(mid.mix - 0.5) < 1e-9);
  assert.deepEqual(previewAt(preview, 3), { index: 1, next: null, mix: 0 });
  assert.equal(captionAt(preview, 2.6), null);
  assert.equal(captionAt(preview, 4.1), 'Третий');
  // За концом ролика — последний кадр.
  assert.equal(previewAt(preview, 99).index, 2);
});

it('без переходов — смена кадра мгновенная', () => {
  const none = { ...preview, transitionSeconds: 0, motion: 'none' as const };
  assert.deepEqual(previewAt(none, 2.6), { index: 1, next: null, mix: 0 });
});

console.log(`\n${passed} passed`);
