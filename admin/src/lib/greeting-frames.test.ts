// Помощники страницы «Кадры лендинга поздравлений» (заход 8).
// Запуск (из admin/): npm test — или один файл: npx tsx src/lib/greeting-frames.test.ts
//  1. Платное — только с подтверждением и только руками: автоопрос не
//     нажимает платный шаг, текст подтверждения называет цену.
//  2. Файлы и команда обработки — под имена лендинга.
//  3. Запомненные съёмки: мусор отброшен.
//  4. Предупреждение про кадр 4.
import assert from 'node:assert/strict';
import {
  blobDownloadUrl,
  costText,
  expectedAction,
  frame4Warning,
  frameFileName,
  GREETING_FRAME_CARDS,
  GREETING_FRAME_LOCALES,
  missingCards,
  paidConfirmText,
  parseStoredFrames,
  processCommand,
  shouldAutoPoll,
  stageTone,
} from './greeting-frames';
import type { GreetingFixtureVideoState } from './types';

const state = (over: Partial<GreetingFixtureVideoState> = {}): GreetingFixtureVideoState => ({
  sessionId: 's1',
  stage: 'rendering',
  next: { action: 'poll', paid: false },
  rerender: null,
  lastRun: null,
  ...over,
});

// ── 1 ──
assert.equal(shouldAutoPoll(state()), true, 'идущий рендер — опрашиваем сами');
assert.equal(shouldAutoPoll(state({ next: { action: 'poll-post', paid: false } })), true);
assert.equal(shouldAutoPoll(state({ next: { action: 'render', paid: true } })), false, 'упал — платный повтор только руками');
assert.equal(shouldAutoPoll(state({ next: { action: 'script-and-render', paid: true } })), false);
assert.equal(shouldAutoPoll(state({ next: { action: 'none', paid: false } })), false, 'готово — опрашивать нечего');
// Даже «poll», помеченный платным, сам не жмётся: решает флаг сервера.
assert.equal(shouldAutoPoll(state({ next: { action: 'poll', paid: true } })), false);
assert.equal(shouldAutoPoll(null), false);
assert.equal(shouldAutoPoll(state({ next: undefined })), false);

assert.equal(paidConfirmText(state(), false), null, 'бесплатный опрос не спрашивает');
const first = paidConfirmText(state({ stage: 'missing', next: { action: 'script-and-render', paid: true } }), false);
assert.ok(first && /платно/.test(first) && /сценарий/.test(first), 'платный первый рендер — подтверждение с «платно»');
assert.ok(first && !/\$/.test(first), 'журнал не знает суммы — без числа');
const priced = paidConfirmText(
  state({
    stage: 'complete',
    next: { action: 'none', paid: false },
    rerender: { action: 'new-version-render', paid: true },
    lastRun: { sessionId: 's0', costMicroUsd: 2_140_000, unpriced: false, at: '2026-10-01T00:00:00Z' },
  }),
  true,
);
assert.ok(priced && priced.includes('~$2.14'), 'цена прошлого прогона в подтверждении');
assert.ok(priced && /новую версию/.test(priced));
assert.equal(paidConfirmText(state({ stage: 'complete', next: { action: 'none', paid: false } }), true), null, 'переснимать нечего — нечего и спрашивать');
assert.match(
  costText(state({ lastRun: { sessionId: 's0', costMicroUsd: 1_000_000, unpriced: true, at: 'x' } })),
  /~\$1\.00.*без ставки/,
);
assert.doesNotMatch(costText(state({ lastRun: { sessionId: 's0', costMicroUsd: 0, unpriced: false, at: 'x' } })), /\$/);

// Ожидаемый шаг для сервера — ровно прочитанный (и подтверждённый).
assert.equal(expectedAction(state(), false), 'poll');
assert.equal(
  expectedAction(state({ next: { action: 'none', paid: false }, rerender: { action: 'new-version-render', paid: true } }), true),
  'new-version-render',
  '«переснять» шлёт свой шаг, а не шаг кнопки «опросить»',
);
assert.equal(expectedAction(state({ rerender: null }), true), null, 'переснимать нечего — запроса нет');
assert.equal(expectedAction(null, false), null);

assert.equal(stageTone('complete'), 'ok');
assert.equal(stageTone('failed'), 'critical');
assert.equal(stageTone('missing'), 'critical');
assert.equal(stageTone('post-processing'), 'warning');

// ── 2 ──
assert.deepEqual([...GREETING_FRAME_LOCALES], ['ru', 'uk', 'en', 'de', 'es'], 'пять локалей лендинга');
assert.deepEqual(GREETING_FRAME_CARDS.map((c) => c.card), [1, 2, 3, 4]);
assert.equal(frameFileName('uk', 3), 'greet-shot-uk-3.png');
assert.equal(
  processCommand('de'),
  'node scripts/tutorial-frames-process.mjs --greeting de greet-shot-de-1.png greet-shot-de-2.png greet-shot-de-3.png greet-shot-de-4.png',
  'порядок файлов — порядок кадров: скрипт берёт их позиционно',
);
assert.deepEqual(missingCards({ '1': 'https://a', '3': 'https://c' }), [2, 4]);
assert.deepEqual(missingCards(undefined), [1, 2, 3, 4]);
assert.equal(blobDownloadUrl('https://x.blob/a.png'), 'https://x.blob/a.png?download=1');
assert.equal(blobDownloadUrl('https://x.blob/a.png?v=2'), 'https://x.blob/a.png?v=2&download=1');
assert.equal(blobDownloadUrl('not a url'), 'not a url');

// ── 3 ──
assert.deepEqual(parseStoredFrames(null), {});
assert.deepEqual(parseStoredFrames('{oops'), {});
assert.deepEqual(parseStoredFrames('[1,2]'), {});
assert.deepEqual(
  parseStoredFrames(
    JSON.stringify({
      ru: { at: '2026-10-07T10:00:00Z', cards: { '1': 'https://b/1.png', '2': 'javascript:alert(1)', '7': 'https://b/7.png' }, problems: ['кадр 2: x', 5] },
      fr: { at: '2026-10-07T10:00:00Z', cards: { '1': 'https://b/1.png' }, problems: [] },
      uk: { cards: { '1': 'https://b/1.png' } },
    }),
  ),
  { ru: { at: '2026-10-07T10:00:00Z', cards: { '1': 'https://b/1.png' }, problems: ['кадр 2: x'] } },
  'чужая локаль, не-https, номер вне 1–4 и запись без даты — отброшены',
);

// ── 4 ──
assert.equal(frame4Warning(state({ stage: 'complete' })), null);
assert.match(frame4Warning(state({ stage: 'post-processing' })) ?? '', /не готов/);
assert.match(frame4Warning(state({ stage: 'missing' })) ?? '', /не готов/);
assert.match(
  frame4Warning(
    state({
      stage: 'complete',
      video: {
        status: 'complete',
        postStatus: 'failed',
        postError: 'boom',
        error: null,
        downloadUrl: null,
        initiatedAt: null,
        completedAt: null,
        resolution: null,
      },
    }),
  ) ?? '',
  /без своей озвучки/,
);
assert.match(frame4Warning(null) ?? '', /неизвестно/);
assert.match(frame4Warning({ skipped: 'фикстурный вход не настроен' }) ?? '', /неизвестно/);

console.log('greeting-frames.test.ts: ok');
